import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
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
} from "./branches.js";

/** A repository with a commit on `main` and a working identity. */
async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, "f.txt"), "base\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "Base"]);
}

/** A bare remote with a branch on it, plus one clone that tracks it. */
async function makeWithRemote() {
  const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
  const remote = join(root, "remote.git");
  mkdirSync(remote, { recursive: true });
  await git(remote, ["init", "-q", "--bare", "-b", "main", "."]);

  // A bare repository needs a working tree, so the seed is made in a clone.
  const seedDir = join(root, "seed");
  const clone = await runGit(["clone", "-q", remote, seedDir], { cwd: root });
  if (clone.exitCode !== 0) throw new Error("seed clone failed");
  await git(seedDir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(seedDir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(seedDir, "seed.txt"), "seed\n");
  await git(seedDir, ["add", "-A"]);
  await git(seedDir, ["commit", "-q", "-m", "Seed"]);
  await git(seedDir, ["push", "-q", "-u", "origin", "main"]);
  rmSync(seedDir, { recursive: true, force: true });

  const dir = join(root, "clone");
  const ours = await runGit(["clone", "-q", remote, dir], { cwd: root });
  if (ours.exitCode !== 0) throw new Error("clone failed");
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  return { root, remote, dir };
}

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });

/** Make a commit so a branch has work the remote does not. */
async function commitInto(dir: string, file: string, body: string, message: string) {
  writeFileSync(join(dir, file), body);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
}

describe("listing branches", () => {
  it("reports the current branch and nothing else in a fresh repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const branches = await listBranches(repo);
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({ name: "main", current: true, remote: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks only one branch as current, and keeps the name not the refname", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["branch", "feature"]);
      await git(repo, ["switch", "-q", "feature"]);

      const branches = await listBranches(repo);
      expect(branches.filter((b) => b.current)).toHaveLength(1);
      expect(await currentBranch(repo)).toBe("feature");
      // Names must not carry a `refs/heads/` prefix, which is what the
      // interface would otherwise show. The order is git's own alphabetical
      // one, so it is sorted here rather than assumed.
      expect(branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows a remote branch as remote, and counts its divergence", async () => {
    const { root, dir } = await makeWithRemote();
    try {
      // A second clone pushes, so this one is behind origin/main.
      const other = join(root, "other");
      await runGit(["clone", "-q", join(root, "remote.git"), other], { cwd: root });
      await git(other, ["config", "user.email", "ada@fixture.invalid"]);
      await git(other, ["config", "user.name", "Ada Fixture"]);
      await commitInto(other, "theirs.txt", "theirs\n", "theirs");
      await git(other, ["push", "-q", "origin", "main"]);
      await git(dir, ["fetch", "-q"]);

      const branches = await listBranches(dir);
      // A remote branch is flagged as remote, and has no upstream of its own —
      // `origin/main` is not tracking anything, so its counts are null. The
      // divergence that matters to the user is the LOCAL main being behind.
      const originMain = branches.find((b) => b.remote && b.name === "main");
      expect(originMain).toBeDefined();
      expect(originMain?.remote).toBe(true);
      expect(originMain?.counts).toBeNull();
      const localMain = branches.find((b) => !b.remote && b.name === "main");
      expect(localMain?.counts).toEqual({ ahead: 0, behind: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("creating and switching", () => {
  it("creates a branch and moves onto it in one step", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const res = await createBranch(repo, "feature");
      expect(res.ok).toBe(true);
      expect(await currentBranch(repo)).toBe("feature");
      // Git confirms it, not just Forgeline's own return value.
      const sha = await git(repo, ["rev-parse", "refs/heads/feature"]);
      expect(sha.stdout.trim()).toEqual(await git(repo, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate name instead of silently overwriting", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await createBranch(repo, "feature");
      await switchBranch(repo, "main");
      const again = await createBranch(repo, "feature");
      expect(again.ok).toBe(false);
      // Still on main: the failed create must not move the user anywhere.
      expect(await currentBranch(repo)).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates from a starting point when one is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await commitInto(repo, "b.txt", "b\n", "second");
      // Resolve the starting point BEFORE switching, because afterwards HEAD
      // has moved and `HEAD~1` no longer means the same commit.
      const base = await git(repo, ["rev-parse", "HEAD~1"]);
      const res = await createBranch(repo, "from-here", "HEAD~1");
      expect(res.ok).toBe(true);
      const branch = await git(repo, ["rev-parse", "refs/heads/from-here"]);
      expect(branch.stdout.trim()).toBe(base.stdout.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("switches to a branch that exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["branch", "feature"]);
      const res = await switchBranch(repo, "feature");
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("switch failed");
      expect(res.nowOn).toBe("feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts a remote branch as a local one rather than detaching", async () => {
    const { root, remote, dir } = await makeWithRemote();
    try {
      // Push a new branch from a second clone so origin/feature exists.
      const other = join(root, "other");
      await runGit(["clone", "-q", remote, other], { cwd: root });
      await git(other, ["config", "user.email", "ada@fixture.invalid"]);
      await git(other, ["config", "user.name", "Ada Fixture"]);
      await git(other, ["switch", "-q", "-c", "feature"]);
      await commitInto(other, "f.txt", "feature\n", "feature work");
      await git(other, ["push", "-q", "-u", "origin", "feature"]);
      await git(dir, ["fetch", "-q"]);

      const res = await trackRemoteBranch(dir, "feature");
      expect(res.ok).toBe(true);
      // On a LOCAL branch that tracks origin/feature, so commits are possible —
      // which a detached checkout of the remote tip would not be.
      expect(await currentBranch(dir)).toBe("feature");
      const tracked = await git(dir, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]);
      expect(tracked.stdout.trim()).toBe("origin/feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("deleting branches", () => {
  it("deletes a branch whose work has landed", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await createBranch(repo, "feature");
      await switchBranch(repo, "main");
      const res = await deleteBranch(repo, "feature");
      expect(res.ok).toBe(true);
      expect(await branchExists(repo, "feature")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete a branch that has work nothing else has", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await createBranch(repo, "feature");
      await commitInto(repo, "only-here.txt", "only\n", "work nobody else has");
      await switchBranch(repo, "main");

      const soft = await deleteBranch(repo, "feature");
      expect(soft.ok).toBe(false);
      if (soft.ok) return;
      // The output the translator and the card are built from.
      expect(soft.output).toContain("not fully merged");
      expect(await branchExists(repo, "feature")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes the same branch when force is asked for", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await createBranch(repo, "feature");
      await commitInto(repo, "only-here.txt", "only\n", "unmerged work");
      await switchBranch(repo, "main");

      expect((await deleteBranch(repo, "feature")).ok).toBe(false);
      const hard = await forceDeleteBranch(repo, "feature");
      expect(hard.ok).toBe(true);
      expect(await branchExists(repo, "feature")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renaming", () => {
  it("renames the current branch and reports the new name", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await createBranch(repo, "old-name");
      const res = await renameBranch(repo, "new-name");
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("rename failed");
      expect(res.nowOn).toBe("new-name");
      expect(await branchExists(repo, "old-name")).toBe(false);
      expect(await branchExists(repo, "new-name")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a name that collides with another branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-branch-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["branch", "taken"]);
      await createBranch(repo, "feature");
      const res = await renameBranch(repo, "taken");
      expect(res.ok).toBe(false);
      expect(await currentBranch(repo)).toBe("feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
