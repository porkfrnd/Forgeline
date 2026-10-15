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
import { createAuthProvider } from "./auth.js";
import { createTokenStore, memoryStore, type TokenStore } from "./tokenStore.js";
import {
  fetchRepo,
  listRemotes,
  pullRepo,
  pushRepo,
} from "./git/remote.js";
import {
  bumpVersion,
  listTags,
  localDate,
  nextVersion,
  planRelease,
  readVersion,
  renderChangelogSection,
  tagRelease,
  writeChangelog,
} from "./git/release.js";
import {
  abortOperation,
  continueOperation,
  keepBoth,
  readConflictSide,
  readConflicts,
  resolveConflict,
  writeResolvedFile,
} from "./git/conflicts.js";
import {
  blameFile,
  fileHistory,
  readCommit,
  readHistory,
} from "./git/history.js";
import {
  applyStash,
  dropStash,
  listStashes,
  popStash,
  saveStash,
} from "./git/stash.js";
import {
  branchExists,
  createBranch,
  currentBranch,
  deleteBranch,
  forceDeleteBranch,
  listBranches,
  renameBranch,
  switchBranch,
  trackRemoteBranch,
} from "./git/branches.js";
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
/** Codes that mean "the other end could not be reached or would not let us in".
 *  These are the repository's trouble with something outside it, not the
 *  repository's own state. */
const REMOTE_FAULT_CODES = new Set([
  "remote-unreachable",
  "remote-auth",
  "remote-not-found",
  "ssh-key",
  "host-key",
  "no-remote",
  "remote-exists",
]);

function gitFailure(c: Context, res: GitResult) {
  const forge = translateError(`${res.stdout}\n${res.stderr}`, res.command);
  // The card is identical either way; the status tells a caller what kind of
  // trouble it is. 409 for "the repository's own state does not permit this",
  // which is nearly every case — a lock held, a merge in progress, no upstream
  // yet, nothing to commit — and 502 when the fault is the far end, so a
  // client can tell "retrying the same thing may help" from "try again later".
  // 500 was never right: there is nothing broken inside Forgeline, and saying
  // so put a red "Internal Server Error" in the browser console next to a card
  // that had already explained the problem in plain English.
  const status = REMOTE_FAULT_CODES.has(forge.code) ? 502 : 409;
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

/** The notice shown when a token is being kept in memory. Short, and true: on
 *  a machine with no secret service this is the only safe place there is. */
const KEYCHAIN_UNAVAILABLE =
  "This machine has no OS keychain, so a sign-in is remembered only until Forgeline closes. It is never written to a file.";

export interface CreateAppOptions {
  auth?: AuthManager;
  /** Where sign-in tokens live. Supplied by `startServer` because the keychain
   *  probe is asynchronous and `createApp` is not. */
  tokenStore?: TokenStore;
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
   * Remotes (Milestone 6). Fetch, pull, push.
   *
   * None of these needs a Forgeline account: a remote that already works
   * through SSH keys on the machine, or a public HTTPS one, just works. An
   * authentication failure comes back as a translator card, and that card is
   * what offers sign-in — which is how sign-in stays lazy.
   * --------------------------------------------------------------- */

  /** What the repository's remotes point at. */
  app.get("/api/repos/:id/remotes", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    return c.json({ remotes: await listRemotes(repo.path) });
  });

  /**
   * Fetch. Journaled because it is an action the user took, and non-undoable
   * because it changes no local ref: it only downloads objects, so there is
   * literally nothing to restore.
   */
  app.post("/api/repos/:id/fetch", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ remote?: unknown }>().catch(() => ({}) as { remote?: unknown });
    const remote = typeof body.remote === "string" ? body.remote : undefined;
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        remote === undefined ? "Fetched from the remote" : `Fetched from ${remote}`,
        () => fetchRepo(repo.path, { remote, prune: true }),
        {
          undoable: false,
          notUndoableReason:
            "A fetch only downloads objects from the remote. It moves no commit and no branch, so there is nothing to undo.",
        },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, changed: result.changed, output: result.output });
  });

  /**
   * Pull. Journaled with a snapshot, because a pull can move the current
   * branch and can even create a merge commit — both of which a snapshot puts
   * back exactly.
   */
  app.post("/api/repos/:id/pull", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const snapshot = await queue.run(repo.path, () => takeSnapshot(repo.path));
    const body = await c.req.json<{ remote?: unknown }>().catch(() => ({}) as { remote?: unknown });
    const remote = typeof body.remote === "string" ? body.remote : undefined;
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        remote === undefined ? "Pulled from the remote" : `Pulled from ${remote}`,
        () => pullRepo(repo.path, { remote }),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, changed: result.changed, output: result.output, snapshot: snapshot.ref });
  });

  /**
   * Push. Journaled as irreversible, which is the recovery contract's own word
   * for it: once the commits are on the remote, withdrawing them would mean
   * rewriting history other people may already have.
   */
  app.post("/api/repos/:id/push", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ remote?: unknown; setUpstream?: unknown }>();
    const remote = typeof body.remote === "string" ? body.remote : undefined;
    const setUpstream = body.setUpstream === true;
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        setUpstream ? "Published this branch to the remote" : "Pushed to the remote",
        () => pushRepo(repo.path, { remote, setUpstream }),
        {
          undoable: false,
          notUndoableReason:
            "A push publishes commits to the remote. Taking them back would rewrite history that other people may already have, so Forgeline will not do it for you.",
        },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, changed: result.changed, output: result.output });
  });

  /* --------------------------------------------------------------- *
   * Sign-in (Milestone 6).
   *
   * The token never crosses this boundary. Every endpoint returns
   * `signedIn` and the account's name and avatar, and nothing else — a token
   * in a JSON response is a token in a devtools window. The one consumer that
   * needs it is git, which gets it through `GIT_ASKPASS` on the environment of
   * a single process.
   * --------------------------------------------------------------- */

  // The keychain probe is asynchronous, and `createApp` is not — so the store
  // is built by the caller that starts the server and handed in here. When
  // nothing is handed in (a direct `createApp` in a test, say), the fallback
  // is memory-only AND SAYS SO, which is the one thing this fallback must never
  // do quietly.
  const tokenStore: TokenStore = opts.tokenStore ?? memoryStore(KEYCHAIN_UNAVAILABLE);
  const authProvider = createAuthProvider(tokenStore);

  app.get("/api/auth", async (c) => {
    const user = await authProvider.currentUser();
    return c.json({
      signedIn: user !== null,
      user,
      // Whether sign-in is even possible, and why not if it isn't. A disabled
      // button with this reason is the honest answer to "no app registered".
      ...authProvider.capabilities(),
    });
  });

  app.post("/api/auth/start", async (c) => {
    const user = await authProvider.currentUser();
    if (user !== null) {
      return c.json({ signedIn: true, user }, 409);
    }
    try {
      const start = await authProvider.startLogin();
      return c.json({ ok: true, start });
    } catch (err) {
      // A missing client id is not a crash: it is the configured state, and
      // the message says exactly what to do about it.
      return c.json(
        {
          ok: false,
          code: "auth-unavailable",
          title: "Sign-in is not set up yet.",
          explanation: err instanceof Error ? err.message : String(err),
        },
        409,
      );
    }
  });

  app.get("/api/auth/poll", async (c) => {
    const polled = await authProvider.pollLogin();
    if (polled.state === "authorized") {
      const user = await authProvider.currentUser();
      return c.json({ state: "authorized", signedIn: true, user });
    }
    return c.json({ state: polled.state });
  });

  app.post("/api/auth/signout", async (c) => {
    const user = await authProvider.signOut();
    return c.json({
      ok: true,
      // Telling the user they can also revoke the app in GitHub's settings is
      // part of the spec: deleting a token here does not revoke it there.
      user,
      note: user === null
        ? null
        : "You are signed out of Forgeline. GitHub still lists this app under your authorised OAuth apps, where you can revoke it if you want to.",
    });
  });

  /* --------------------------------------------------------------- *
   * Releases (Milestone 8).
   *
   * Read-only planning is separate from acting, so the interface can state
   * exactly what a release will do before there is a button that does it. The
   * version number is read, never invented.
   * --------------------------------------------------------------- */

  /** What a release would do. This is read-only and always available. */
  app.get("/api/repos/:id/release/plan", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const plan = await planRelease(repo.path);
    const tags = await listTags(repo.path);
    return c.json({ plan, tags });
  });

  /**
   * Put the version in `package.json`, write the changelog, and tag the commit.
   *
   * Ordered deliberately: the version first, because `tagRelease` stamps the
   * commit it is run on and a changelog written *before* the version bump would
   * have to be amended in. Nothing is committed — the user commits, because
   * deciding the message is the one part of a release that should not be
   * automatic.
   */
  app.post("/api/repos/:id/release/plan", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ level?: unknown; tag?: unknown; changelog?: unknown }>();
    const level = body.level;
    if (level !== "patch" && level !== "minor" && level !== "major") {
      return c.json({ code: "bad-request", title: "Which size of release?" }, 400);
    }
    const tagReleaseIt = body.tag === true;
    const writeChangelogFile = body.changelog === true;
    const wantTagName = typeof body.tag === "string" && body.tag.length > 0 ? body.tag : undefined;

    const current = await readVersion(repo.path);
    if (current === null) {
      return c.json(
        {
          code: "no-version",
          title: "This repository has no version to release.",
          explanation:
            "There is no package.json here, so there is no version number to bump. Add one, or decide the release another way.",
        },
        409,
      );
    }
    const next = nextVersion(current, level);
    if (next === null) {
      return c.json(
        {
          code: "not-semver",
          title: `Can't work out the next version from ${current}.`,
          explanation:
            "This version is not in the three-number form a patch, minor, or major bump can be worked out from, so Forgeline is not going to guess what comes after it. Type the version you want into package.json and it can read it from there.",
        },
        409,
      );
    }

    const snapshot = await takeSnapshot(repo.path);
    const bumped = await queue.run(repo.path, () =>
      journaled(repo.path, `Bumped the version to ${next}`, () => bumpVersion(repo.path, current, next), {
        undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref },
      }),
    );
    if (!bumped.ok) return gitFailure(c, bumped);

    const written: string[] = ["package.json"];
    if (writeChangelogFile) {
      const plan = await planRelease(repo.path);
      const section = renderChangelogSection(
        next,
        plan.commitsSince.map((commit) => commit.subject),
        localDate(),
      );
      const logged = await queue.run(repo.path, () =>
        journaled(repo.path, `Wrote the ${next} changelog section`, () => writeChangelog(repo.path, "CHANGELOG.md", section), {
          undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref },
        }),
      );
      if (!logged.ok) return gitFailure(c, logged);
      written.push("CHANGELOG.md");
    }

    if (tagReleaseIt || wantTagName !== undefined) {
      const name = wantTagName ?? `v${next}`;
      // A tag is stamped on the commit it is made on, and it can be deleted —
      // but only from this machine, and only until it is pushed. The interface
      // says so rather than presenting a tag as one more undoable thing.
      const tagged = await queue.run(repo.path, () =>
        journaled(repo.path, `Tagged the release as ${name}`, () => tagRelease(repo.path, name, `Release ${next}`), {
          undoable: false,
          notUndoableReason:
            "A tag is a pointer to a commit, and deleting one is the whole of undoing it. It is not offered as an undo because deleting a tag that others have pulled removes it for them too.",
        }),
      );
      if (!tagged.ok) return gitFailure(c, tagged);
      written.push(name);
    }

    return c.json({ ok: true, version: next, wrote: written, snapshot: snapshot.ref });
  });

  /* --------------------------------------------------------------- *
   * Conflicts (Milestone 7).
   *
   * The one moment git stops and waits. Every resolver action takes a snapshot
   * of the working tree first, because "take theirs" is exactly the choice a
   * user regrets, and an undo that cannot restore the tree is not an undo.
   * --------------------------------------------------------------- */

  app.get("/api/repos/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const index = await readConflicts(repo.path);
    return c.json({ entries: index.entries, operation: index.operation });
  });

  /** One side of one conflicted file, as text, for the side-by-side view. */
  app.get("/api/repos/:id/conflicts/side", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const path = c.req.query("path");
    const sideParam = c.req.query("side");
    if (path === undefined || path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    const side = sideParam === "theirs" ? "theirs" : sideParam === "base" ? "base" : "ours";
    const result = await readConflictSide(repo.path, path, side);
    if (!result.ok) return gitFailure(c, { stdout: "", stderr: result.output, exitCode: 128, command: `git show :${side}:${path}` });
    return c.json({ ok: true, text: result.text });
  });

  /** Take one side of a conflict. */
  app.post("/api/repos/:id/conflicts/resolve", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ path?: unknown; choice?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    if (body.choice !== "ours" && body.choice !== "theirs") {
      return c.json({ code: "bad-request", title: "Which side?" }, 400);
    }
    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        body.choice === "ours"
          ? `Took our version of ${body.path}`
          : `Took their version of ${body.path}`,
        () => resolveConflict(repo.path, body.path as string, body.choice as "ours" | "theirs"),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, resolved: result.resolved, choice: result.choice, snapshot: snapshot.ref });
  });

  /** Keep both versions, markers and all, for a hand edit. */
  app.post("/api/repos/:id/conflicts/keep-both", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ path?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(repo.path, `Kept both versions of ${body.path}`, () =>
        keepBoth(repo.path, body.path as string),
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, snapshot: snapshot.ref });
  });

  /** Write a hand-edited resolution in full. */
  app.post("/api/repos/:id/conflicts/write", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ path?: unknown; content?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ code: "bad-request", title: "There was nothing to write." }, 400);
    }
    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Wrote my own resolution for ${body.path}`,
        () => writeResolvedFile(repo.path, body.path as string, body.content as string),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, snapshot: snapshot.ref });
  });

  /**
   * Finish the stopped operation. The editor is disabled through the
   * environment, because `merge --continue` opens one and a dialog this
   * interface cannot answer is a hang it caused itself.
   */
  app.post("/api/repos/:id/conflicts/continue", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ operation?: unknown }>().catch(() => ({}) as { operation?: unknown });
    const operation = typeof body.operation === "string" ? body.operation : "merge";
    const index = await readConflicts(repo.path);
    if (index.entries.length > 0) {
      // Refused here rather than by git, so the card can name the files.
      return c.json(
        {
          code: "unmerged-files",
          title: "Some conflicts are still unresolved.",
          explanation: `There is still an unresolved conflict in ${index.entries[0]?.path ?? "this repository"}, so this cannot finish yet.`,
        },
        409,
      );
    }
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        operation === "merge" ? "Finished the merge" : `Finished the ${operation}`,
        () => continueOperation(repo.path, operation),
        { undoable: false, notUndoableReason: "Finishing a merge creates a commit; that is a new commit, not a switch." },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, output: result.output });
  });

  /** Abandon the stopped operation and put the tree back. */
  app.post("/api/repos/:id/conflicts/abort", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ operation?: unknown }>().catch(() => ({}) as { operation?: unknown });
    const operation = typeof body.operation === "string" ? body.operation : "merge";
    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(repo.path, `Abandoned the ${operation}`, () =>
        abortOperation(repo.path, operation),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, snapshot: snapshot.ref });
  });

  /* --------------------------------------------------------------- *
   * History, blame, and the graph (Milestone 7).
   *
   * All three are read-only, so none of them journalled and none take a
   * snapshot. `readHistory` covers every branch, because a branch with no
   * commits of its own is a fact worth showing rather than hiding.
   * --------------------------------------------------------------- */

  app.get("/api/repos/:id/history", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const from = c.req.query("from");
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200;
    const commits = await readHistory(repo.path, from, limit);
    return c.json({ commits, from: from ?? null });
  });

  /** The commits that touched one file, including through a rename. */
  app.get("/api/repos/:id/history/file", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const path = c.req.query("path");
    if (path === undefined || path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    const result = await fileHistory(repo.path, path);
    if (!result.ok) return gitFailure(c, result);
    return c.json({ commits: result.commits, path });
  });

  app.get("/api/repos/:id/history/:sha", async (c) => {
    const id = c.req.param("id");
    const sha = c.req.param("sha");
    if (!id || sha === undefined) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const commit = await readCommit(repo.path, sha);
    if (commit === null) return c.notFound();
    return c.json({ commit });
  });

  /** Blame a file. The path is a query parameter rather than a URL segment
   *  because a filename can contain a slash, which a single segment would eat. */
  app.get("/api/repos/:id/blame", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const path = c.req.query("path");
    if (path === undefined || path.length === 0) {
      return c.json({ code: "bad-request", title: "Which file?" }, 400);
    }
    const blame = await blameFile(repo.path, path);
    // git refuses a path it doesn't have, with exit 128. That answer is passed
    // on rather than flattened into "this file has no history".
    if (!blame.ok && blame.failure !== undefined) {
      return gitFailure(c, {
        stdout: blame.failure.output,
        stderr: "",
        exitCode: 128,
        command: blame.failure.command,
      });
    }
    return c.json({ lines: blame.lines, path });
  });

  /* --------------------------------------------------------------- *
   * Stash (Milestone 7).
   *
   * Everything here is a working-tree change, so each action takes a snapshot
   * first — restoring is the common case for a stash, and an undo that left
   * the tree where the stash was cannot be offered.
   * --------------------------------------------------------------- */

  app.get("/api/repos/:id/stashes", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    return c.json({ stashes: await listStashes(repo.path) });
  });

  /**
   * Put the working tree aside as a new stash.
   *
   * Returns `ok: false` with `nothing-to-stash` when the tree is clean, because
   * `git stash push` exits 0 in that case and would otherwise report a stash
   * that does not exist.
   */
  app.post("/api/repos/:id/stashes/save", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ message?: unknown }>().catch(() => ({}) as { message?: unknown });
    const message = typeof body.message === "string" ? body.message : undefined;

    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        message === undefined ? "Put the working tree aside" : `Put the working tree aside: ${message}`,
        () => saveStash(repo.path, message),
        {
          // Stashing is its own kind of undoable: the tool remembers how to
          // restore, and the snapshot is the fallback if it doesn't.
          undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref },
          notUndoableReason: "A stash cannot be undone by turning it off, only by restoring it.",
        },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, created: result.created, snapshot: snapshot.ref });
  });

  /**
   * Put a stash back. The default is `apply`, which leaves the entry on the
   * stack: the snapshot journal can still undo the working-tree change, and the
   * stash stays available if the user wants it again.
   */
  app.post("/api/repos/:id/stashes/restore", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ ref?: unknown; pop?: unknown }>().catch(() => ({}) as {
      ref?: unknown;
      pop?: unknown;
    });
    const ref = typeof body.ref === "string" ? body.ref : undefined;
    const pop = body.pop === true;

    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        pop === true ? "Restored the stash and removed it" : "Restored the stash",
        () => (pop === true ? popStash(repo.path, ref) : applyStash(repo.path, ref)),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, removed: pop, snapshot: snapshot.ref });
  });

  /** Remove a stash from the stack, with a bare `refs/stash@{n}`. This is the
   *  only destructive stash action, and the interface asks first. */
  app.post("/api/repos/:id/stashes/drop", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ ref?: unknown }>();
    if (typeof body.ref !== "string" || body.ref.length === 0) {
      return c.json({ code: "bad-request", title: "Which stash?" }, 400);
    }
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        "Dropped a stash",
        () => dropStash(repo.path, body.ref as string),
        {
          // A dropped stash is gone from the stack; only the reflog has it
          // after, and this app will not go looking.
          undoable: false,
          notUndoableReason:
            "A dropped stash is gone. Git's reflog still holds it for a while, but Forgeline is not going to go rummaging in the reflog to put it back.",
        },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true });
  });

  /* --------------------------------------------------------------- *
   * Branches (Milestone 7).
   * --------------------------------------------------------------- */

  app.get("/api/repos/:id/branches", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const branches = await listBranches(repo.path);
    return c.json({
      branches,
      detached: (await currentBranch(repo.path)) === null,
    });
  });

  /**
   * Switch to a branch. A snapshot is taken first, because a switch changes the
   * working tree and that is exactly what undo restores.
   */
  app.post("/api/repos/:id/branches/switch", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ code: "bad-request", title: "Which branch?" }, 400);
    }
    const snapshot = await takeSnapshot(repo.path);
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Switched to ${body.name}`,
        () => switchBranch(repo.path, body.name as string),
        { undo: { kind: "restore-snapshot", snapshotRef: snapshot.ref } },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    // Deleting the local copy of a remote branch is a lossy action, so the
    // snapshot stays referenced even though restoring it puts the branch back.
    return c.json({ ok: true, nowOn: result.nowOn, snapshot: snapshot.ref });
  });

  /** Create a branch from the current HEAD (or a named starting point). */
  app.post("/api/repos/:id/branches/create", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown; from?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ code: "bad-request", title: "A name is needed for the branch." }, 400);
    }
    const from = typeof body.from === "string" ? body.from : undefined;
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        from === undefined ? `Created branch ${body.name}` : `Created branch ${body.name} from ${from}`,
        () => createBranch(repo.path, body.name as string, from),
        { undoable: false, notUndoableReason: "Deleting the branch this created would undo it." },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, nowOn: result.nowOn });
  });

  /** Turn `origin/thing` into a local branch that tracks it. */
  app.post("/api/repos/:id/branches/track", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ code: "bad-request", title: "Which branch?" }, 400);
    }
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Started tracking origin/${body.name} as a local branch`,
        () => trackRemoteBranch(repo.path, body.name as string),
        { undoable: false, notUndoableReason: "Deleting the local branch this created would undo it." },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, nowOn: result.nowOn });
  });

  /** Delete a branch. `force` is explicit: a branch with work nothing else has
   *  is not deleted by accident. */
  app.post("/api/repos/:id/branches/delete", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown; force?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ code: "bad-request", title: "Which branch?" }, 400);
    }
    const force = body.force === true;
    const result = await queue.run(repo.path, () =>
      journaled(
        repo.path,
        `Deleted branch ${body.name}`,
        () => (force ? forceDeleteBranch(repo.path, body.name as string) : deleteBranch(repo.path, body.name as string)),
        {
          // A deleted branch is gone: undoing it means restoring a ref, which a
          // snapshot cannot do. So the entry is honest about being unusable.
          undoable: false,
          notUndoableReason:
            "Deleting a branch is not something this app can undo — the branch's commits are only recoverable from the reflog after the fact, and Forgeline will not go rummaging in it.",
        },
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true });
  });

  app.post("/api/repos/:id/branches/rename", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    const body = await c.req.json<{ name?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ code: "bad-request", title: "A name is needed for the branch." }, 400);
    }
    const result = await queue.run(repo.path, () =>
      journaled(repo.path, `Renamed the current branch to ${body.name}`, () =>
        renameBranch(repo.path, body.name as string),
      ),
    );
    if (!result.ok) return gitFailure(c, result);
    return c.json({ ok: true, nowOn: result.nowOn });
  });

  app.get("/api/repos/:id/branches/:name/exists", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!id || name === undefined) return c.notFound();
    const repo = registry.get(id);
    if (!repo) return c.notFound();
    return c.json({ exists: await branchExists(repo.path, name) });
  });

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
  // The token store is built HERE rather than inside the app because probing
  // the keychain is asynchronous and `createApp` is not. On a machine with no
  // secret service this answers memory-only, and the interface is told.
  const tokenStore = await createTokenStore();
  const app = createApp(() => actualPort, { auth, tokenStore, registry, handles });
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
