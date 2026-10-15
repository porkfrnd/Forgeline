import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  snapshotRef,
  takeSnapshot,
} from "./snapshots.js";
import { runGit } from "./git/git.js";

/** Run git and return trimmed stdout. Git always terminates with a newline,
 *  so a raw stdout compared against a trimmed tree SHA would never match —
 *  which is exactly the kind of off-by-one-newline a test should not have. */
async function git(dir: string, args: string[]): Promise<string> {
  const res = await runGit(["-C", dir, ...args], { cwd: dir });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A repo with one commit, plus one staged and one untracked file, which is
 *  the shape a snapshot has to capture. */
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "fl-snap-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "ada@fixture.invalid"]);
  await git(repo, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "Base"]);
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  await git(repo, ["add", "staged.txt"]);
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  return repo;
}

describe("takeSnapshot", () => {
  it("captures the working tree including untracked, and the real index", async () => {
    const repo = await makeRepo();
    try {
      const snap = await takeSnapshot(repo);

      expect(snap.worktreeTree).toMatch(/^[0-9a-f]{40}$/);
      expect(snap.indexTree).toMatch(/^[0-9a-f]{40}$/);
      expect(snap.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
      expect(snap.branch).toBe("main");

      // The private ref exists and does NOT show up in `git stash list`.
      const stash = await git(repo, ["stash", "list"]);
      expect(stash).toBe("");
      const refs = await git(repo, ["for-each-ref", "refs/forgeline/"]);
      expect(refs).toContain("refs/forgeline/snapshots/");

      // The worktree tree contains the untracked file, which is the whole
      // point of `git add -A` against a temporary index.
      const files = await git(repo, ["ls-tree", "-r", "--name-only", snap.worktreeTree!]);
      expect(files.split("\n")).toContain("untracked.txt");
      expect(files.split("\n")).toContain("a.txt");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("leaves the user's real index untouched", async () => {
    const repo = await makeRepo();
    try {
      const before = await git(repo, ["write-tree"]);
      await takeSnapshot(repo);
      const after = await git(repo, ["write-tree"]);
      expect(after).toBe(before);
      // And the untracked file is still untracked afterwards, i.e. snapshotting
      // did not quietly stage it for the user.
      const status = await git(repo, ["status", "--porcelain"]);
      expect(status).toContain("?? untracked.txt");
      expect(status).toContain("A  staged.txt");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("restores a discarded change, including a file that was never tracked", async () => {
    const repo = await makeRepo();
    try {
      const snap = await takeSnapshot(repo);

      // The risky action: throw everything away.
      rmSync(join(repo, "a.txt"));
      rmSync(join(repo, "staged.txt"));
      rmSync(join(repo, "untracked.txt"));
      writeFileSync(join(repo, "a.txt"), "replaced by the destructive action\n");

      expect(await restoreSnapshot(repo, snap.ref)).toBe(true);

      expect(existsSync(join(repo, "a.txt"))).toBe(true);
      expect(existsSync(join(repo, "staged.txt"))).toBe(true);
      expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("untracked\n");

      // The real index is back to the snapshot's, so staged.txt is staged again
      // — the staged/unstaged distinction is preserved, not flattened.
      const index = await git(repo, ["write-tree"]);
      expect(index).toBe(snap.indexTree);
      const status = await git(repo, ["status", "--porcelain"]);
      expect(status).toContain("A  staged.txt");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("refuses to restore a ref that is not a Forgeline snapshot", async () => {
    const repo = await makeRepo();
    try {
      const head = await git(repo, ["rev-parse", "HEAD"]);
      // A full SHA and an arbitrary branch name must both be rejected, so an
      // untrusted ref string cannot decide which tree gets read.
      expect(await restoreSnapshot(repo, `refs/heads/${head}`)).toBe(false);
      expect(await restoreSnapshot(repo, "--foo")).toBe(false);
      expect(await restoreSnapshot(repo, "refs/forgeline/snapshots/notanumber")).toBe(false);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);
});

describe("listSnapshots", () => {
  it("returns newest first", async () => {
    const repo = await makeRepo();
    try {
      const older = await takeSnapshot(repo);
      await new Promise((r) => setTimeout(r, 5));
      const newer = await takeSnapshot(repo);
      const list = await listSnapshots(repo);
      const refs = list.map((s) => s.ref);
      expect(refs).toContain(older.ref);
      expect(refs).toContain(newer.ref);
      expect(refs.indexOf(newer.ref)).toBeLessThan(refs.indexOf(older.ref));
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);
});

describe("pruneSnapshots", () => {
  it("keeps the latest 50 regardless of age, and deletes only old ones beyond that", async () => {
    const repo = await makeRepo();
    try {
      const now = new Date("2026-10-15T00:00:00.000Z");
      const young = now.getTime();
      const ancient = young - 1000 * 24 * 60 * 60 * 1000;

      // 51 ancient snapshots plus one young one. The ancient 51 must all be
      // deleted (they are past 30 days AND more than 50 of them), and the
      // young one must stay even though it is not among the newest 50.
      for (let i = 0; i < 51; i += 1) {
        await git(repo, ["update-ref", `refs/forgeline/snapshots/${ancient + i}`, "HEAD"]);
      }
      await git(repo, ["update-ref", `refs/forgeline/snapshots/${young}`, "HEAD"]);

      const { removed, kept } = await pruneSnapshots(repo, now);
      // 52 refs total, newest 50 kept, so exactly the 2 oldest ancient ones go.
      expect(removed).toHaveLength(2);
      expect(kept).toHaveLength(50);
      expect(kept).toContain(`refs/forgeline/snapshots/${young}`);

      const after = await listSnapshots(repo);
      expect(after).toHaveLength(50);
      // And the two removed really were the oldest, not an arbitrary pair.
      expect(removed.sort()).toEqual([
        `refs/forgeline/snapshots/${ancient}`,
        `refs/forgeline/snapshots/${ancient + 1}`,
      ]);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("keeps an old snapshot while it is inside the newest 50", async () => {
    const repo = await makeRepo();
    try {
      const now = new Date();
      const old = now.getTime() - 40 * 24 * 60 * 60 * 1000;
      await git(repo, ["update-ref", `refs/forgeline/snapshots/${old}`, "HEAD"]);
      const { removed } = await pruneSnapshots(repo, now);
      // One snapshot only, so it is among the latest 50 and survives.
      expect(removed).toHaveLength(0);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("uses the ref shape snapshotRef produces", () => {
    // Computed from the date rather than hardcoded, so the assertion states
    // the shape and the origin instead of a number nobody can check.
    const at = new Date("2026-10-15T12:00:00.000Z");
    const ref = snapshotRef(at);
    expect(ref).toBe(`refs/forgeline/snapshots/${at.getTime()}`);
    expect(/^refs\/forgeline\/snapshots\/\d+$/.test(ref)).toBe(true);
  });
});
