import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveWatcher } from "./watcher.js";

const roots: string[] = [];

function makeRepo(name: string): { repoPath: string; gitDir: string } {
  const root = mkdtempSync(join(tmpdir(), "fl-watch-"));
  roots.push(root);
  const repoPath = join(root, name);
  const gitDir = join(repoPath, ".git");
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "remotes"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "refs", "heads", "main"), "a".repeat(40) + "\n");
  return { repoPath, gitDir };
}

/** Wait for `predicate` with a hard ceiling, so a broken watcher fails the
 *  test instead of hanging it. */
async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms}ms`);
}

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LiveWatcher", () => {
  it("reports the repo when .git/HEAD changes", async () => {
    const { repoPath, gitDir } = makeRepo("demo");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 50 });
    try {
      watcher.setRepos([repoPath]);
      await watcher.ready();
      expect(watcher.getMode()).toBe("watching");

      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/other\n");
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual([repoPath]);
    } finally {
      await watcher.stop();
    }
    expect(watcher.getMode()).toBe("stopped");
  });

  it("coalesces a burst of ref writes into one callback", async () => {
    const { repoPath, gitDir } = makeRepo("demo");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 250 });
    try {
      watcher.setRepos([repoPath]);
      await watcher.ready();
      // A checkout-shaped burst: HEAD plus several refs in quick succession.
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/branch-${i}\n`);
        writeFileSync(join(gitDir, "refs", "heads", `branch-${i}`), `${i}`.repeat(40) + "\n");
        await new Promise((r) => setTimeout(r, 10));
      }
      await until(() => seen.length > 0);
      // Let anything the debounce would still fire slip through.
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([repoPath]);
    } finally {
      await watcher.stop();
    }
  });

  it("ignores writes to a repo that is not being watched", async () => {
    const watched = makeRepo("watched");
    const ignored = makeRepo("ignored");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 50 });
    try {
      watcher.setRepos([watched.repoPath]);
      await watcher.ready();
      writeFileSync(join(ignored.gitDir, "HEAD"), "ref: refs/heads/nope\n");
      await new Promise((r) => setTimeout(r, 600));
      expect(seen).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });

  it("stops watching a repo removed from the set and starts a new one", async () => {
    const first = makeRepo("first");
    const second = makeRepo("second");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 50 });
    try {
      watcher.setRepos([first.repoPath]);
      await watcher.ready();
      watcher.setRepos([second.repoPath]);
      await watcher.ready();
      expect(watcher.watchedPaths()).toEqual([second.repoPath]);

      // The dropped repo must go quiet.
      writeFileSync(join(first.gitDir, "HEAD"), "ref: refs/heads/gone\n");
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toHaveLength(0);

      writeFileSync(join(second.gitDir, "HEAD"), "ref: refs/heads/live\n");
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual([second.repoPath]);
    } finally {
      await watcher.stop();
    }
  });

  it("ignores writes to .git files that do not mean a change", async () => {
    const { repoPath, gitDir } = makeRepo("demo");
    // Realistic noise: git touches config and objects constantly.
    mkdirSync(join(gitDir, "objects", "ab"), { recursive: true });
    writeFileSync(join(gitDir, "config"), "[core]\n");
    writeFileSync(join(gitDir, "objects", "ab", "cdef"), "object\n");
    writeFileSync(join(repoPath, "work.txt"), "working tree file\n");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 50 });
    try {
      watcher.setRepos([repoPath]);
      await watcher.ready();
      writeFileSync(join(gitDir, "config"), "[core]\n\tbare = false\n");
      writeFileSync(join(gitDir, "objects", "ab", "cdef"), "object changed\n");
      writeFileSync(join(repoPath, "work.txt"), "edited\n");
      await new Promise((r) => setTimeout(r, 900));
      expect(seen).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });

  it("watches .git/refs and .git/index too, not just HEAD", async () => {
    const { repoPath, gitDir } = makeRepo("demo");
    const seen: string[][] = [];
    const watcher = new LiveWatcher((paths) => seen.push(paths), { debounceMs: 50 });
    try {
      watcher.setRepos([repoPath]);
      await watcher.ready();
      // A commit: the ref moves and the index is rewritten.
      writeFileSync(join(gitDir, "refs", "heads", "main"), "b".repeat(40) + "\n");
      writeFileSync(join(gitDir, "index"), "binary-ish index blob");
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual([repoPath]);
    } finally {
      await watcher.stop();
    }
  });
});
