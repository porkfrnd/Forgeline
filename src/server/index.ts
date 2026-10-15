import { readFile, stat, unlink } from "node:fs/promises";
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
import { runGit, readRefs, withPaths, type GitResult } from "./git/git.js";
import { translateError } from "./git/errors.js";
import {
  readChangedFiles,
  readFileDiff,
} from "./git/diff.js";
import { journaled, undoCommand } from "./journal.js";
import { takeSnapshot } from "./snapshots.js";
import { resolveRealpath, stillInside } from "./paths.js";
import { readJson, writeJson } from "./appdata.js";
import { readJournal } from "./journal.js";
import {
  readErrorHistory,
  recordErrorShown,
  recordFixChosen,
  recordFixOutcome,
} from "./errorHistory.js";

/** Largest repo file the preview route will serve (1 MiB). Milestone 3
 *  keeps a fuller contract with truncation + binary detection; for now the
 *  route proves registry.child + re-resolution over HTTP and nothing more. */
export const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;

/** One place that turns a failed git call into a response, so every route
 *  speaks the same language. `runGit` reports stdout and stderr separately
 *  but git sends some failures to stdout — a merge conflict and "nothing to
 *  commit" both do — so the translator is handed the combination of the two,
 *  which is what a person reading the terminal would have seen. */
function gitFailure(c: Context, res: GitResult) {
  const forge = translateError(`${res.stdout}\n${res.stderr}`, res.command);
  // 409 for conflict-shaped errors, 500 otherwise. The card is the same
  // either way; the status only tells a caller whether retrying could help.
  const status =
    forge.code === "merge-conflict" || forge.code === "merge-in-progress" ? 409 : 500;
  return c.json({ ...forge, ok: false }, status);
}

/** Names of git processes writing to this repository, found with `ps` so no
 *  shell is involved and the pattern is an argument rather than a string a
 *  shell parsing rule could twist. Returns an empty list when `ps` cannot
 *  tell us, which the card is allowed to do — "I could not check" is honest,
 *  "nothing is running" would not be. */
async function listGitProcesses(repoPath: string): Promise<string[]> {
  try {
    const { spawn } = await import("node:child_process");
    const ps = spawn("ps", ["-eo", "args"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const code: number = await new Promise((resolve) => ps.on("exit", (c) => resolve(c ?? 1)));
    if (code !== 0) return [];
    return out
      .split("\n")
      .filter((line) => {
        if (!/git(\.exe)?\b/.test(line)) return false;
        // Only real repository work, not the editor git opened, and not
        // Forgeline's own calls into this same repository.
        if (line.includes("forgeline")) return false;
        return line.includes(repoPath);
      })
      .map((line) => line.trim())
      .slice(0, 5);
  } catch {
    return [];
  }
}

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
        // Undo of a stage is an unstage of the same paths, and vice versa.
        {
          undo: staged
            ? { kind: "unstage-paths", paths }
            : { kind: "stage-paths", paths },
        },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
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
        // The patch is the undo, unchanged: applying it in the other
        // direction with --cached puts exactly this hunk back where it was.
        { undo: { kind: "apply-patch", patch, reverse: !staged } },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
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
    const beforeRefs = await readRefs(repo.path);
    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Committed: ${message.trim()}`,
        () =>
          runGit(["-C", repo.path, "commit", "-m", message.trim()], {
            cwd: repo.path,
          }),
        // Undo moves HEAD back but never a commit: `reset --soft` keeps the
        // tree and index exactly as the commit left them, so nothing the
        // user wrote is lost. Only offered when there is a HEAD to return to.
        beforeRefs.head !== null
          ? { undo: { kind: "reset-soft", head: beforeRefs.head } }
          : { undoable: false, notUndoableReason: "This was the first commit in an empty repository, so there is no earlier commit to return to." },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
    }
    return c.json({ ok: true });
  });

  // Discarding local changes: the first of the spec's "risky" actions, and
  // the reason snapshots exist. A snapshot is taken BEFORE anything is
  // thrown away, so the recovery contract is met by construction, and its
  // ref is returned in the response body so the confirmation preview and the
  // Undo timeline can point at exactly what would restore these files.
  app.post("/api/repos/:id/discard", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    let paths: unknown;
    try {
      const body = await c.req.json<{ paths?: unknown }>();
      paths = body.paths;
    } catch {
      paths = undefined;
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json(
        { code: "bad-request", title: "Pick at least one file to discard." },
        400,
      );
    }

    const snapshot = await queue.run(repo.path, () => takeSnapshot(repo.path));

    // Two kinds of change, because git cannot throw both away with one call:
    // a tracked path is restored with `checkout --force`, and a new path —
    // one that has never been committed — is dropped from the index and
    // deleted, because a checkout of a path with no committed version is a
    // no-op that would silently leave the file behind.
    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Discarded local changes in ${paths.join(", ")}`,
        async () => {
        // Per path, not per call: one `checkout --force` covering every path
        // fails outright when any single path is untracked, and would then
        // silently leave the tracked ones dirty.
        let last = { stdout: "", stderr: "", exitCode: 0, command: "" };
        for (const p of paths as string[]) {
          const inHead = await runGit(["-C", repo.path, "cat-file", "-e", `HEAD:${p}`], {
            cwd: repo.path,
          });
          if (inHead.exitCode === 0) {
            last = await runGit(withPaths(["checkout", "--force"], [p]), {
              cwd: repo.path,
            });
            if (last.exitCode !== 0) return last;
            continue;
          }
          const checked = registry.child(id, p);
          if (!checked.ok || !checked.path) {
            return {
              stdout: "",
              stderr: "Path is not inside this repository.",
              exitCode: 1,
              command: "",
            };
          }
          const resolvedRoot = await resolveRealpath(repo.path);
          const resolvedChild = await resolveRealpath(checked.path);
          if (!stillInside(resolvedRoot, resolvedChild)) {
            return {
              stdout: "",
              stderr: "Path resolves outside the repository.",
              exitCode: 1,
              command: "",
            };
          }
          await runGit(withPaths(["rm", "--cached", "--force", "--ignore-unmatch"], [p]), {
            cwd: repo.path,
          });
          try {
            await unlink(resolvedChild);
          } catch {
            // Already gone, which counts as success for a discard.
          }
          last = { stdout: "", stderr: "", exitCode: 0, command: `rm ${p}` };
        }
        return last;
        },
        {
          // The snapshot taken before anything was thrown away is the undo,
          // and the timeline names it so the user can see what comes back.
          undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref },
          snapshotRef: snapshot.ref,
        },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
    }
    return c.json({ ok: true, snapshotRef: snapshot.ref });
  });
  // The action journal, newest first, for the Undo timeline. Read-only here:
  // entries are written by `journaled` around each mutating call, and undo
  // itself is a new entry rather than an edit of an old one.
  app.get("/api/journal", async (c) => {
    return c.json({ entries: await readJournal() });
  });

  // Undo one journal entry. Takes a snapshot FIRST, always, because an undo
  // that goes wrong has to be recoverable too — and because undo is itself
  // journaled, it can be undone back. An entry with no plan says plainly that
  // it cannot be undone rather than running something random.
  app.post("/api/journal/:id/undo", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const entries = await readJournal();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return c.notFound();
    if (!entry.undoable || entry.undo === undefined) {
      return c.json(
        {
          code: "not-undoable",
          title:
            entry.notUndoableReason ??
            "No proven way to reverse this action yet, so Undo is not offered.",
        },
        400,
      );
    }
    const args = undoCommand(entry.undo);
    if (args === null) return c.notFound();

    const snapshot = await queue.run(entry.repoPath, () => takeSnapshot(entry.repoPath));
    const res = await queue.run(entry.repoPath, () =>
      journaled(
        entry.repoPath,
        // An em-dash rather than "Undid: ...", because the description it
        // wraps already starts with its own verb ("Committed: ..."), and
        // "Undid: Committed: Commit to undo" reads as a stutter in a timeline.
        `Undone — ${entry.description}`,
        async () => {
          if (entry.undo?.kind === "apply-patch") {
            return runGit(["-C", entry.repoPath, ...args], {
              cwd: entry.repoPath,
              stdin: entry.undo.patch,
            });
          }
          return runGit(["-C", entry.repoPath, ...args], { cwd: entry.repoPath });
        },
        { snapshotRef: snapshot.ref },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
    }
    return c.json({ ok: true, snapshotRef: snapshot.ref });
  });

  // Rescue mode: "reset to clean state, keep my work." One button. A snapshot
  // of the working tree, the current HEAD parked under a private backup ref so
  // no local commit is lost, then the repo is put back to match its remote.
  // The snapshot and the backup both appear in the timeline afterwards, so
  // anything can be brought back.
  app.post("/api/repos/:id/rescue", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();

    const snapshot = await queue.run(repo.path, () => takeSnapshot(repo.path));

    // Park HEAD under a private ref before touching anything, so local commits
    // survive even if the reset goes further than the user meant.
    const backupRef = `refs/forgeline/backup/${Date.now()}`;
    const head = await runGit(["-C", repo.path, "rev-parse", "HEAD"], { cwd: repo.path });
    if (head.exitCode === 0 && head.stdout.trim().length > 0) {
      await queue.run(repo.path, () =>
        runGit(["-C", repo.path, "update-ref", backupRef, head.stdout.trim()], {
          cwd: repo.path,
        }),
      );
    }

    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        "Rescue: reset to clean state, keeping work in a snapshot",
        () =>
          runGit(["-C", repo.path, "reset", "--hard"], {
            cwd: repo.path,
          }),
        {
          snapshotRef: snapshot.ref,
          undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref },
        },
      ),
    );
    if (res.exitCode !== 0) {
      return gitFailure(c, res);
    }
    return c.json({ ok: true, snapshotRef: snapshot.ref, backupRef });
  });

  // Live updates over SSE. Authenticated like every other /api/* route, and
  // the only route that stays open. On connect it states the live mode
  // ("watching" or the polling fallback) and pushes a full snapshot; after
  // that it pushes only the repos whose .git bookkeeping files changed, so a
  // `git checkout` is one small frame rather than a full reload.
  /* --------------------------------------------------------------- *
   * Error fixes (Milestone 5).
   *
   * Each fix below is a REAL action, because the spec's rule is that a fix
   * button must never be text only. A fix for a feature that isn't built yet
   * — pull, push, the conflict resolver, sign-in — has no endpoint here, so
   * the interface doesn't draw it. That is what keeps the slot rule true
   * while the catalogue stays complete.
   * --------------------------------------------------------------- */

  /** Record that a card was shown, so history can say which fix worked. */
  app.post("/api/errors", async (c) => {
    const body = await c.req.json<{
      repoPath?: unknown; code?: unknown; command?: unknown; offered?: unknown;
    }>().catch(() => null);
    if (body === null) return c.json({ code: "bad-request", title: "This endpoint expects JSON." }, 400);
    if (typeof body.code !== "string" || body.code.length === 0) {
      return c.json({ code: "bad-request", title: "A card needs the error code it shows." }, 400);
    }
    const record = await recordErrorShown({
      repoPath: typeof body.repoPath === "string" ? body.repoPath : null,
      code: body.code,
      command: typeof body.command === "string" ? body.command : "",
      offered: Array.isArray(body.offered)
        ? body.offered.filter((f): f is string => typeof f === "string")
        : [],
    });
    return c.json({ id: record.id });
  });

  /** Record the fix the user tried and whether it worked. Body:
   *  `{ fix: string, worked: boolean }`. */
  app.post("/api/errors/:id/outcome", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const body = await c.req.json<{ fix?: unknown; worked?: unknown }>();
    if (typeof body.fix !== "string" || typeof body.worked !== "boolean") {
      return c.json({ code: "bad-request", title: "Say which fix was tried and whether it worked." }, 400);
    }
    const record = await recordFixChosen(id, body.fix);
    if (record === null) return c.notFound();
    if (body.worked) await recordFixOutcome(id, "worked");
    return c.json({ ok: true });
  });

  /** The history itself, newest first, for a "these keep happening" list. */
  app.get("/api/errors", async (c) => {
    const history = await readErrorHistory();
    return c.json({ entries: [...history].reverse() });
  });

  /** Initialise a folder that has no git yet. */
  app.post("/api/repos/:id/init", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const res = await queue.run(repo.path, () =>
      journaled(repo.path, "Initialised a repository here", () =>
        runGit(["-C", repo.path, "init"], { cwd: repo.path }),
      ),
    );
    if (res.exitCode !== 0) return gitFailure(c, res);
    return c.json({ ok: true });
  });

  /** Set the identity git writes into every commit. */
  app.post("/api/repos/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown; email?: unknown }>();
    // Narrowed into locals before use: a `!` on a field typed `unknown` does
    // not narrow it, so the trimmed value has to come from a const.
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (name.length === 0 || !email.includes("@")) {
      return c.json(
        { code: "bad-request", title: "A name and an email address are both needed." },
        400,
      );
    }
    const res = await queue.run(repo.path, () =>
      journaled(repo.path, "Set this repository's name and email", async () => {
        const a = await runGit(["-C", repo.path, "config", "user.name", name], {
          cwd: repo.path,
        });
        if (a.exitCode !== 0) return a;
        return runGit(["-C", repo.path, "config", "user.email", email], {
          cwd: repo.path,
        });
      }),
    );
    if (res.exitCode !== 0) return gitFailure(c, res);
    return c.json({ ok: true });
  });

  /**
   * Abandon a merge in progress. A snapshot is taken first, always.
   *
   * The entry is deliberately NOT undoable. Restoring the snapshot puts back
   * the files and the index, but it does not put back MERGE_HEAD — the state
   * of "a merge is in progress" — so calling the undo "restore" would be a
   * lie that loses the merge. Instead the snapshot preserves everything, the
   * entry records the refs either side, and the card says plainly that the
   * merge itself is not put back.
   */
  app.post("/api/repos/:id/abort-merge", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const snapshot = await queue.run(repo.path, () => takeSnapshot(repo.path));
    const res = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        "Abandoned a merge in progress",
        () => runGit(["-C", repo.path, "merge", "--abort"], { cwd: repo.path }),
        {
          undoable: false,
          notUndoableReason:
            "Abandoning a merge cannot be undone here: restoring would bring back the files but not the merge itself. A snapshot was taken and the timeline names it.",
          snapshotRef: snapshot.ref,
        },
      ),
    );
    if (res.exitCode !== 0) return gitFailure(c, res);
    return c.json({ ok: true, snapshot: snapshot.ref });
  });

  /** Is there a git process running right now? Read-only, so it does not
   *  journal and it is safe to call before deciding to remove a lock. */
  app.get("/api/repos/:id/git-processes", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const running = await listGitProcesses(repo.path);
    return c.json(
      running.length === 0
        ? { running: [], title: "No git process is running in this repository." }
        : {
            running,
            title: `${running.length} git process${running.length === 1 ? "" : "es"} still running.`,
          },
    );
  });

  /** Remove a stale index.lock. Snapshots FIRST, always, because removing a
   *  lock that a live git still needs is exactly the corruption case this
   *  form of recovery has to survive. */
  app.post("/api/repos/:id/remove-lock", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ confirmed?: unknown }>();
    if (body.confirmed !== true) {
      return c.json(
        { code: "needs-confirmation", title: "Confirm before removing a git lock." },
        400,
      );
    }
    const snapshot = await queue.run(repo.path, () => takeSnapshot(repo.path));
    const res = await queue.run(repo.path, () =>
      journaled(repo.path, "Removed a stuck git lock", () =>
        runGit(["-C", repo.path, "update-index", "--refresh"], { cwd: repo.path }),
        // The snapshot holds the index exactly as it was.
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    const lock = join(repo.path, ".git", "index.lock");
    await unlink(lock).catch(() => undefined);
    if (res.exitCode !== 0) return gitFailure(c, res);
    return c.json({ ok: true, snapshot: snapshot.ref });
  });

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
