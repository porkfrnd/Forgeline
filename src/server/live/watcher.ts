import { watch, type FSWatcher } from "chokidar";
import { join, relative, sep } from "node:path";

/** How live updates behave. `watching` is native file events; `polling` is
 *  the 3-second fallback used when native watching fails (network drives are
 *  the usual reason), which the interface surfaces as a small note so the
 *  user knows why updates feel slower. */
export type LiveMode = "watching" | "polling" | "stopped";

export interface LiveWatcherOptions {
  /** Coalescing window: one event fires after the repo has been quiet this
   *  long, so a `git checkout` touching a dozen refs is one refresh. */
  debounceMs?: number;
  /** Polling interval used once the fallback engages. */
  pollMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_POLL_MS = 3000;

/** Watches the files that actually mean "this repo changed" — `.git/HEAD`
 *  (branch switch), `.git/index` (staging), and `.git/refs` (commits,
 *  fast-forwards) — for each registered repo, and reports the repos that
 *  changed after a short debounce.
 *
 *  Reads are deliberately absent: `GIT_OPTIONAL_LOCKS=0` already keeps a
 *  `status` from writing the index, so the watcher only ever sees real
 *  change. Watching these three paths instead of the whole working tree is
 *  what makes it cheap enough to leave on. */
export class LiveWatcher {
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly onChanges: (repoPaths: string[]) => void;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingPaths = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mode: LiveMode = "stopped";
  private fallbackEngaged = false;
  private readonly readyPaths = new Set<string>();
  private readyWaiters: (() => void)[] = [];

  constructor(onChanges: (repoPaths: string[]) => void, opts: LiveWatcherOptions = {}) {
    this.onChanges = onChanges;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  getMode(): LiveMode {
    return this.mode;
  }

  /** Resolves once every current watcher has finished its initial scan, so a
   *  caller (or a test) can write to a repo knowing the change will be seen
   *  rather than mistaken for the initial state. Resolves immediately when
   *  nothing is being watched. */
  ready(): Promise<void> {
    if (this.watchers.size === 0) return Promise.resolve();
    for (const path of this.watchers.keys()) {
      if (!this.readyPaths.has(path)) {
        return new Promise<void>((resolve) => this.readyWaiters.push(resolve));
      }
    }
    return Promise.resolve();
  }

  /** Point the watcher at exactly these repo paths, adding and removing
   *  watchers as the set changes. Safe to call on every refresh: unchanged
   *  repos keep their existing watcher. */
  setRepos(repoPaths: string[]): void {
    const wanted = new Set(repoPaths);
    for (const [path, watcher] of this.watchers) {
      if (!wanted.has(path)) {
        void watcher.close();
        this.watchers.delete(path);
        this.readyPaths.delete(path);
      }
    }
    for (const path of wanted) {
      if (!this.watchers.has(path)) this.watchers.set(path, this.createWatcher(path));
    }
    this.mode = this.watchers.size === 0 ? "stopped" : this.fallbackEngaged ? "polling" : "watching";
  }

  watchedPaths(): string[] {
    return [...this.watchers.keys()];
  }

  /** Close every watcher and drop anything still debouncing. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingPaths.clear();
    this.readyPaths.clear();
    this.readyWaiters = [];
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
    this.mode = "stopped";
  }

  private createWatcher(repoPath: string): FSWatcher {
    const gitDir = join(repoPath, ".git");
    // One target — the `.git` directory — with an `ignored` filter that admits
    // only the three things that mean "this repo changed".
    //
    // Passing `[.git/HEAD, .git/index, .git/refs]` as separate targets looks
    // tidier but is broken in practice: chokidar computes a common base for
    // the path set and applies `depth` from there, so the depth budget is
    // spent walking back down into `.git` and changes inside `refs/` are
    // never reported. Watching `.git` once and filtering keeps the depth
    // budget where it belongs.
    const wanted = new Set(["HEAD", "index", "packed-refs"]);
    const isWatchedPath = (p: string): boolean => {
      // The target root itself must be admitted or chokidar watches nothing.
      if (p === gitDir) return true;
      const rel = relative(gitDir, p);
      if (rel.length === 0 || rel.startsWith("..")) return false;
      return wanted.has(rel) || rel === "refs" || rel.startsWith(`refs${sep}`);
    };
    const watcher = watch(gitDir, {
      ignoreInitial: true,
      followSymlinks: false,
      // Native watching can fail outright on network filesystems; when it
      // does, this watcher — and every future one — falls back to polling.
      usePolling: this.fallbackEngaged,
      interval: this.pollMs,
      // .git is depth 0, HEAD/index/refs depth 1, refs/heads depth 2,
      // refs/heads/<branch> depth 3. Bounded: never the working tree.
      depth: 3,
      ignored: (p: string) => !isWatchedPath(p),
    });
    const note = (): void => this.noteChange(repoPath);
    watcher.on("add", note);
    watcher.on("change", note);
    watcher.on("unlink", note);
    watcher.on("ready", () => {
      this.readyPaths.add(repoPath);
      this.resolveReadyIfSettled();
    });
    watcher.on("error", () => this.engageFallback());
    return watcher;
  }

  private resolveReadyIfSettled(): void {
    if (this.watchers.size === 0) return;
    for (const path of this.watchers.keys()) {
      if (!this.readyPaths.has(path)) return;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Native watching failed. Rebuild every watcher in polling mode and keep
   *  new ones polling too, so the dashboard stays live instead of silently
   *  going quiet. */
  private engageFallback(): void {
    if (this.fallbackEngaged) return;
    this.fallbackEngaged = true;
    const paths = [...this.watchers.keys()];
    for (const watcher of this.watchers.values()) void watcher.close();
    this.watchers.clear();
    // The rebuilt watchers have to finish their own initial scan before
    // `ready()` may resolve again.
    this.readyPaths.clear();
    for (const path of paths) this.watchers.set(path, this.createWatcher(path));
    this.mode = this.watchers.size === 0 ? "stopped" : "polling";
  }

  private noteChange(repoPath: string): void {
    this.pendingPaths.add(repoPath);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    if (this.pendingPaths.size === 0) return;
    const changed = [...this.pendingPaths].sort();
    this.pendingPaths.clear();
    this.onChanges(changed);
  }
}
