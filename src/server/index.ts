import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createAuth, parseCookie, type AuthManager } from "./session.js";
import { RepoRegistry, type RepoEntry } from "./registry.js";
import { scanRepos, pathExists } from "./scan/scan.js";
import { summarizeRepos } from "./repo-summary.js";
import { RepoQueue } from "./queue.js";
import { LiveWatcher, type LiveMode } from "./live/watcher.js";
import { runGit, withPaths } from "./git/git.js";
import {
  readChangedFiles,
  readFileDiff,
} from "./git/diff.js";
import { journaled } from "./journal.js";
import { resolveRealpath, stillInside } from "./paths.js";
import { readJson, writeJson } from "./appdata.js";
import { readJournal } from "./journal.js";

/** Largest repo file the preview route will serve (1 MiB). Milestone 3
 *  keeps a fuller contract with truncation + binary detection; for now the
 *  route proves registry.child + re-resolution over HTTP and nothing more. */
export const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;

export interface ServerHandle {
  app: Hono;
  server: ReturnType<typeof serve>;
  actualPort: number;
  token: string;
  auth: AuthManager;
  registry: RepoRegistry;
  queue: RepoQueue;
  live: LiveWatcher;
  /** Mint a fresh bootstrap URL (used when the terminal user presses Enter). */
  refreshUrl: () => string | null;
  /** Stop accepting connections and release every file watcher. */
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function webRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled layout: <pkg>/dist/server/index.js -> web build at <pkg>/dist/web
  return join(here, "..", "web");
}

async function serveStaticFile(root: string, pathname: string): Promise<Response | null> {
  // Resolve-then-compare: decode repeatedly (one pass is not enough — an
  // attacker can double-encode `%` itself), normalize, then demand the
  // result still sits inside the web root. Nothing is stripped or rewritten;
  // a path that leaves the root is rejected outright. Symlinks are resolved
  // with realpath before the final comparison so a linked file outside the
  // root cannot be served either. This is a guard, not a sandbox: a hostile
  // local user with write access to dist/web can already change what is
  // served (see docs/architecture.md).
  const resolvedRoot = await resolveRealpath(root);
  let decoded = pathname;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  if (decoded.includes("\0")) return null;
  const stripped = decoded.replace(/^[/\\]+/, "");
  const candidate = normalize(join(resolvedRoot, stripped));
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) return null;
  const full = await resolveRealpath(candidate);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) return null;
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    const body = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, { headers: { "Content-Type": type } });
  } catch {
    return null;
  }
}

/** Headers applied to every response so a hostile page cannot frame, sniff, or
 *  leak the referrer. The CSP allows only the app's own origin. */
function securityHeaders(): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

export interface CreateAppOptions {
  auth?: AuthManager;
  registry?: RepoRegistry;
  /** Injected by tests; a fresh one is created otherwise. */
  queue?: RepoQueue;
  /** Filled in by `createApp` so the caller can stop watching on shutdown. */
  handles?: ServerHandles;
}

/** The pieces `createApp` builds that outlive a request. Returned through
 *  `CreateAppOptions.handles` so `startServer` can close them cleanly. */
export interface ServerHandles {
  queue: RepoQueue;
  live: LiveWatcher;
}

export function createApp(getPort: () => number, opts: CreateAppOptions = {}): Hono {
  const auth = opts.auth ?? createAuth();
  const registry = opts.registry ?? new RepoRegistry();
  const queue = opts.queue ?? new RepoQueue();
  const app = new Hono();

  // Live updates: one watcher over every registered repo's `.git` bookkeeping
  // files, coalesced, pushing real rows over the authenticated SSE endpoint.
  // The DOM lib's WritableStreamDefaultController is not generic and carries
  // no `enqueue` in this config, so the writable side of an SSE stream is
  // typed structurally here rather than by name.
  type SseController = {
    enqueue: (chunk: Uint8Array) => void;
    close: () => void;
  };
  const streams = new Set<SseController>();
  const sseEncoder = new TextEncoder();
  const pushEvent = (name: string, data: unknown): void => {
    if (streams.size === 0) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      try {
        stream.enqueue(sseEncoder.encode(frame));
      } catch {
        // A client that vanished mid-write is dropped by the abort handler.
      }
    }
  };
  const live = new LiveWatcher(async (repoPaths) => {
    const rows = await summarizeRepos(
      repoPaths
        .map((path) => registry.list().find((entry) => entry.path === path))
        .filter((entry): entry is RepoEntry => entry !== undefined)
        .map((entry) => ({ entry })),
      queue,
    );
    if (rows.length > 0) pushEvent("repos", { repos: rows });
  });
  if (opts.handles) {
    opts.handles.queue = queue;
    opts.handles.live = live;
  }
  /** Keep the watcher pointed at whatever the registry currently holds. */
  const syncLive = (): void => {
    live.setRepos(registry.list().map((entry) => entry.path));
  };

  /** Persist the chosen scan roots to app-data, so a restart does not forget
   *  where the user keeps their repositories. Best-effort: a read-only home
   *  means the roots live in memory only for this session. */
  const persistRoots = (): void => {
    void writeJson("settings.json", { roots: registry.getRoots() });
  };

  app.use("*", async (c, next) => {
    const port = getPort();
    const host = c.req.header("host") ?? "";
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!okHosts.includes(host)) {
      return c.text("Forbidden: bad host", 403);
    }
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const okOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        if (!okOrigins.includes(origin)) {
          return c.text("Forbidden: bad origin", 403);
        }
      }
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return c.text("Content-Type must be application/json", 415);
      }
    }
    await next();
    for (const [k, v] of Object.entries(securityHeaders())) {
      if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    }
  });

  app.use("/api/*", async (c, next) => {
    const id = parseCookie(c.req.header("cookie"), "session");
    // The __test__ helpers are guarded by FORGELINE_E2E=1 at each route and
    // must work before any session exists (mint, then expire, then exchange).
    if (!c.req.path.startsWith("/api/__test__/") && (id === null || !auth.validateSession(id))) {
      return c.text("Unauthorized", 401);
    }
    await next();
  });

  // Git version, for the status bar. Cached for the life of the process: git
  // does not change underneath a running app, and this is asked for on every
  // dashboard load.
  let gitVersion: string | null = null;
  const readGitVersion = async (): Promise<string> => {
    if (gitVersion !== null) return gitVersion;
    const res = await runGit(["--version"], { cwd: process.cwd() });
    const m = res.stdout.match(/git version (\S+)/);
    gitVersion = m ? m[1] : "unknown";
    return gitVersion;
  };

  app.get("/api/health", async (c) => {
    return c.json({ ok: true, gitVersion: await readGitVersion(), liveMode: live.getMode() });
  });

  // Test-only helper: mint a fresh single-use bootstrap token so each e2e
  // test can exchange its own. Always 404 unless the server was started
  // with FORGELINE_E2E=1, which only the Playwright global setup does.
  app.get("/api/__test__/bootstrap", (c) => {
    if (process.env.FORGELINE_E2E !== "1") {
      return c.text("Not found", 404);
    }
    return c.json({ token: auth.forceBootstrap() });
  });

  // Test-only helper: set the registry roots for the e2e server so the
  // register-repo helper can prove inside-vs-outside-root checks over HTTP.
  // Guarded by FORGELINE_E2E=1 like the other __test__ helpers.
  app.post("/api/__test__/roots", async (c) => {
    if (process.env.FORGELINE_E2E !== "1") {
      return c.text("Not found", 404);
    }
    const body = await c.req.json<{ paths?: unknown }>();
    if (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string")) {
      return c.json({ code: "bad-request", title: "Missing paths." }, 400);
    }
    registry.setRoots(body.paths as string[]);
    persistRoots();
    return c.json({ ok: true });
  });

  // Test-only helper: register a repo path in the e2e server's registry so
  // traversal tests can exercise the file route against a real directory.
  // Guarded by FORGELINE_E2E=1 like the other __test__ helpers, and rejects
  // paths outside the configured roots via registry.register.
  app.post("/api/__test__/register-repo", async (c) => {
    if (process.env.FORGELINE_E2E !== "1") {
      return c.text("Not found", 404);
    }
    const body = await c.req.json<{ path?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Missing path." }, 400);
    }
    const entry = await registry.register(body.path);
    if (!entry) return c.notFound();
    return c.json({ id: entry.id });
  });
  // Test-only helper: age the current bootstrap token so the e2e
  // suite can prove the exchange rejects an expired token without waiting
  // five real minutes. Same FORGELINE_E2E=1 guard as the mint endpoint.
  // POST-only because the global middleware rejects non-GET/HEAD/OPTIONS
  // requests without a JSON content-type, and no real route may share it.
  app.post("/api/__test__/expire-bootstrap", async (c) => {
    if (process.env.FORGELINE_E2E !== "1") {
      return c.text("Not found", 404);
    }
    const body = await c.req.json<{ ageMs?: unknown }>();
    const ageMs = typeof body.ageMs === "number" && body.ageMs > 0 ? body.ageMs : 0;
    auth.expireBootstrapForTest(ageMs);
    return c.json({ ok: true });
  });

  // Repo identity: the browser only ever sees opaque IDs. An unknown ID -> 404.
  // Live status: every entry is enriched with branch/changed/ahead/behind.
  // Entries whose path vanished are pruned so deleted or moved repos do not
  // linger on the dashboard.
  app.get("/api/repos", async (c) => {
    const alive: RepoEntry[] = [];
    for (const entry of registry.list()) {
      if (!pathExists(entry.path)) {
        registry.remove(entry.id);
        continue;
      }
      alive.push(entry);
    }
    syncLive();
    return c.json({
      repos: await summarizeRepos(
        alive.map((entry) => ({ entry })),
        queue,
      ),
    });
  });

  // Scan picked root folders and register what is found. The browser sends
  // roots the user picked (never a whole-disk scan); each root becomes a
  // configured root first so the inside-root check agrees with the scan.
  app.post("/api/repos/scan", async (c) => {
    const body = await c.req.json<{ roots?: unknown; maxDepth?: unknown }>();
    if (!Array.isArray(body.roots) || !body.roots.every((p) => typeof p === "string")) {
      return c.json({ code: "bad-request", title: "Missing roots." }, 400);
    }
    const maxDepth =
      typeof body.maxDepth === "number" && body.maxDepth >= 0 && body.maxDepth <= 10
        ? Math.floor(body.maxDepth)
        : 4;
    const roots = (body.roots as string[]).slice(0, 20);
    const found = await scanRepos(roots, { maxDepth });
    registry.setRoots([...registry.getRoots(), ...roots]);
    persistRoots();
    const registered: { entry: RepoEntry; name?: string }[] = [];
    for (const repo of found) {
      const entry = await registry.register(repo.path);
      if (!entry) continue;
      registered.push({ entry, name: repo.name });
    }
    syncLive();
    return c.json({ repos: await summarizeRepos(registered, queue) });
  });

  // Milestone 2 will register scanned repos server-side. This endpoint exists
  // now so the write-path guards (Origin, Content-Type) have a route to
  // protect and the security tests can exercise them end to end.
  app.post("/api/repos", async (c) => {
    const body = await c.req.json<{ path?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Missing path." }, 400);
    }
    const entry = await registry.register(body.path);
    if (!entry) return c.notFound();
    syncLive();
    return c.json({ id: entry.id });
  });

  app.get("/api/repos/:id", (c) => {
    const repo = registry.get(c.req.param("id"));
    if (!repo) return c.notFound();
    return c.json({ id: repo.id });
  });

  // Milestone-3 preview: read one repo-relative file over HTTP so the
  // traversal contract (lexical check, then re-resolve and re-check before
  // use) is exercised end to end, not only in unit tests. The browser sends
  // an opaque repo id plus a repo-relative path; a forged id -> 404, an
  // escaping or option-like path -> 400, a symlink swapped in after the
  // first check -> 403, an oversize file -> 413, a missing file -> 404.
  app.get("/api/repos/:id/file", async (c) => {
    const checked = registry.child(c.req.param("id"), c.req.query("path") ?? "");
    if (!checked.repo) return c.notFound();
    if (!checked.ok || !checked.path) {
      return c.json(
        { code: "bad-path", title: "That path is not inside this repository." },
        400,
      );
    }
    const resolvedRoot = await resolveRealpath(checked.repo.path);
    const resolvedChild = await resolveRealpath(checked.path);
    if (!stillInside(resolvedRoot, resolvedChild)) {
      return c.text("Forbidden: path resolves outside the repository", 403);
    }
    try {
      const info = await stat(resolvedChild);
      if (!info.isFile()) return c.notFound();
      if (info.size > MAX_FILE_PREVIEW_BYTES) {
        return c.json(
          { code: "too-large", title: "That file is larger than 1 MiB." },
          413,
        );
      }
      const body = await readFile(resolvedChild);
      return new Response(body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch {
      return c.notFound();
    }
  });

  // List the changed files for a repo: staged and unstaged together, each
  // with its status letter and staged/unstaged flags. Used by the file list
  // in the workbench before a file is opened in the diff viewer.
  app.get("/api/repos/:id/changes", async (c) => {
    const repo = registry.get(c.req.param("id"));
    if (!repo) return c.notFound();
    const files = await readChangedFiles(repo.path);
    return c.json({ files });
  });

  // Diff for one file in one repo. `?staged=true` reads index against HEAD;
  // otherwise worktree against the index. The path is validated against the
  // registry like the file route.
  app.get("/api/repos/:id/diff", async (c) => {
    const repo = registry.get(c.req.param("id"));
    if (!repo) return c.notFound();
    const path = c.req.query("path") ?? "";
    const checked = registry.child(c.req.param("id"), path);
    if (!checked.repo || !checked.ok || !checked.path) {
      return c.json(
        { code: "bad-path", title: "That path is not inside this repository." },
        400,
      );
    }
    const staged = c.req.query("staged") === "true";
    const diff = await readFileDiff(repo.path, path, staged);
    return c.json(diff);
  });

  // Stage or unstage whole files. Body: `{ paths: string[] }`. Stage runs
  // `git add -- <paths>`; unstage runs `git restore --staged -- <paths>`.
  // Paths go behind `--` so a path beginning with `-` is never read as an
  // option, and every call is serialised per repo through the queue.
  async function stageUnstageFiles(c: Context, staged: boolean) {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ paths?: unknown }>();
    if (!Array.isArray(body.paths) || !body.paths.every((p: unknown) => typeof p === "string")) {
      return c.json({ code: "bad-request", title: "Missing paths." }, 400);
    }
    const paths = body.paths as string[];
    const before = staged ? ["add"] : ["restore", "--staged"];
    const args = withPaths(before, paths);
    const verb = staged ? "Staged" : "Unstaged";
    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `${verb} ${paths.length === 1 ? "1 file" : `${paths.length} files`}: ${paths.join(", ")}`,
        () => runGit(["-C", repo.path, ...args], { cwd: repo.path }),
      ),
    );
    if (res.exitCode !== 0) {
      return c.json(
        { code: "git-error", title: res.stderr.trim() || "git failed", command: res.command },
        500,
      );
    }
    return c.json({ ok: true });
  }

  app.post("/api/repos/:id/stage", async (c) => {
    return stageUnstageFiles(c, true);
  });

  app.post("/api/repos/:id/unstage", async (c) => {
    return stageUnstageFiles(c, false);
  });

  // Stage or unstage a single hunk. Body: `{ path: string, patch: string }`.
  // Stage runs `git apply --cached -` (patch piped to stdin, index only);
  // unstage runs `git apply --reverse --cached -`. The path is validated
  // against the registry like the file route so a forged ID or escaping
  // path is rejected before git ever runs.
  async function stageUnstageHunk(c: Context, staged: boolean) {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ path?: unknown; patch?: unknown }>();
    if (
      typeof body.path !== "string" ||
      body.path.length === 0 ||
      typeof body.patch !== "string"
    ) {
      return c.json({ code: "bad-request", title: "Missing path or patch." }, 400);
    }
    const path = body.path;
    const patch = body.patch;
    const checked = registry.child(id, path);
    if (!checked.repo || !checked.ok || !checked.path) {
      return c.json(
        { code: "bad-path", title: "That path is not inside this repository." },
        400,
      );
    }
    const args = staged ? ["apply", "--cached"] : ["apply", "--reverse", "--cached"];
    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `${staged ? "Staged" : "Unstaged"} a hunk in ${path}`,
        () =>
          runGit(["-C", repo.path, ...args, "-"], {
            cwd: repo.path,
            stdin: patch,
          }),
      ),
    );
    if (res.exitCode !== 0) {
      return c.json(
        { code: "git-error", title: res.stderr.trim() || "git failed", command: res.command },
        500,
      );
    }
    return c.json({ ok: true });
  }

  app.post("/api/repos/:id/stage-hunk", async (c) => {
    return stageUnstageHunk(c, true);
  });

  app.post("/api/repos/:id/unstage-hunk", async (c) => {
    return stageUnstageHunk(c, false);
  });

  // Commit the staged changes. Body: `{ message: string }`. Runs `git commit
  // -m <message>`; the author is whatever git is configured to use for the
  // repo (user.name/user.email), falling back to the system default. The
  // sanity-check card on the client shows what will be committed before this
  // is called.
  app.post("/api/repos/:id/commit", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ message?: unknown }>();
    const message = body.message;
    if (typeof message !== "string") {
      return c.json({ code: "bad-request", title: "Missing commit message." }, 400);
    }
    if (message.trim().length === 0) {
      return c.json({ code: "bad-request", title: "Missing commit message." }, 400);
    }
    const res = await queue.run(repo.path, () =>
      journaled(repo.path, `Committed: ${message.trim()}`, () =>
        runGit(["-C", repo.path, "commit", "-m", message.trim()], {
          cwd: repo.path,
        }),
      ),
    );
    if (res.exitCode !== 0) {
      return c.json(
        { code: "git-error", title: res.stderr.trim() || "git failed" },
        500,
      );
    }
    return c.json({ ok: true });
  });

  // The action journal, newest first, for the Undo timeline. Read-only here:
  // entries are written by `journaled` around each mutating call, and undo
  // itself is a new entry rather than an edit of an old one.
  app.get("/api/journal", async (c) => {
    return c.json({ entries: await readJournal() });
  });

  // Live updates over SSE. Authenticated like every other /api/* route, and
  // the only route that stays open. On connect it states the live mode
  // ("watching" or the polling fallback) and pushes a full snapshot; after
  // that it pushes only the repos whose .git bookkeeping files changed, so a
  // `git checkout` is one small frame rather than a full reload.
  app.get("/api/events", async (c) => {
    syncLive();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const mode: LiveMode = live.getMode();
        controller.enqueue(
          encoder.encode(`: connected\n\nretry: 3000\nevent: mode\ndata: ${JSON.stringify({ mode })}\n\n`),
        );
        streams.add(controller);
        let open = true;
        const stop = () => {
          if (!open) return;
          open = false;
          streams.delete(controller);
          try {
            controller.close();
          } catch {
            open = false;
          }
        };
        const signal = c.req.raw.signal;
        if (signal) {
          signal.addEventListener("abort", stop);
        }
        // The client has no way to tell us it hung up other than closing, so
        // drop the controller on cancel too.
        void summarizeRepos(registry.list().map((entry) => ({ entry })), queue).then((rows) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`event: repos\ndata: ${JSON.stringify({ repos: rows })}\n\n`));
          } catch {
            stop();
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const t = url.searchParams.get("t");
    if (t !== null) {
      // Single-use bootstrap exchange: sets the session cookie and answers 303
      // so the token never lingers in the address bar. A used or expired token
      // is rejected; the page then shows the plain "expired" notice.
      const sessionId = auth.consumeBootstrap(t);
      if (sessionId !== null) {
        url.searchParams.delete("t");
        const target = url.pathname + (url.search ? url.search : "");
        c.header("Cache-Control", "no-store");
        c.header("Set-Cookie", `session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
        return c.redirect(target || "/", 303);
      }
      return c.text("This link has expired. Press Enter in the Forgeline terminal for a new one.", 401);
    }
    const root = webRoot();
    const direct = await serveStaticFile(root, url.pathname);
    if (direct) return direct;
    if (!url.pathname.startsWith("/assets/")) {
      const index = await serveStaticFile(root, "/index.html");
      if (index) return index;
    }
    return c.text("Not found", 404);
  });

  return app;
}

export interface StartOptions {
  port: number;
  hostname: string;
  token?: string;
  roots?: string[];
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const auth = createAuth();
  const token = auth.currentBootstrapToken();
  const registry = new RepoRegistry();
  registry.setRoots(opts.roots ?? []);
  // A restart forgets nothing the user told us: the roots we scanned last
  // time are read back from app-data before the first request is served.
  if (opts.roots === undefined) {
    const settings = await readJson<{ roots?: unknown }>("settings.json");
    if (settings && Array.isArray(settings.roots)) {
      const saved = settings.roots.filter((r): r is string => typeof r === "string");
      if (saved.length > 0) registry.setRoots(saved);
    }
  }
  let actualPort = opts.port;
  const handles: ServerHandles = { queue: new RepoQueue(), live: new LiveWatcher(() => {}) };
  const app = createApp(() => actualPort, { auth, registry, handles });
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.hostname });
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.on("error", onError);
    server.on("listening", onListening);
  });
  const addr = server.address();
  if (addr && typeof addr === "object" && typeof (addr as AddressInfo).port === "number") {
    actualPort = (addr as AddressInfo).port;
  }
  const refreshUrl = (): string | null => {
    const fresh = auth.refreshBootstrap();
    if (fresh === null) return null;
    return `http://localhost:${actualPort}/?t=${fresh}`;
  };
  const close = async (): Promise<void> => {
    await handles.live.stop();
    await new Promise<void>((resolve) => {
      const srv = server as unknown as {
        closeAllConnections?: () => void;
        close: (cb: () => void) => void;
      };
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    });
  };
  return { app, server, actualPort, token, auth, registry, queue: handles.queue, live: handles.live, refreshUrl, close };
}

export { resolveRealpath, stillInside };
