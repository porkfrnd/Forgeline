import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  abortOperation,
  continueOperation,
  keepBoth,
  readConflictSide,
  readConflicts,
  resolveConflict,
  writeResolvedFile,
} from "./conflicts.js";

/**
 * Every test here drives a *real* merge into a *real* conflict, because the
 * interesting class of bug is one where the module reports a state git never
 * entered. A fixture never tells you that.
 */

async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, "f.txt"), "line\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "Base"]);
}

/** Two branches that both changed the same line, in a real conflict. */
async function makeConflict(dir: string) {
  await git(dir, ["switch", "-q", "-c", "theirs"]);
  await git(dir, ["config", "user.name", "Grace Fixture"]);
  writeFileSync(join(dir, "f.txt"), "theirs change\n");
  await git(dir, ["commit", "-q", "-am", "Theirs"]);
  await git(dir, ["switch", "-q", "main"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, "f.txt"), "ours change\n");
  await git(dir, ["commit", "-q", "-am", "Ours"]);
  const merge = await git(dir, ["merge", "theirs"]);
  return merge;
}

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("reading a conflict", () => {
  it("finds the conflicted file after a merge that really stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const merge = await makeConflict(repo);
      // A merge into a conflict prints its words on **stdout**, which is the
      // first thing a naive caller gets wrong here.
      expect(merge.stdout).toContain("CONFLICT");

      const index = await readConflicts(repo);
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0].path).toBe("f.txt");
      // Kind comes from the index, not from guessing at file contents.
      expect(index.entries[0].kind).toBe("both-modified");
      expect(index.entries[0].hasMarkers).toBe(true);
      expect(index.operation).toBe("merge");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports nothing unmerged when the repository is clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const index = await readConflicts(repo);
      expect(index.entries).toEqual([]);
      // A clean repository is not an error, and it is not a merge either.
      expect(index.operation).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads both sides of a conflict as they really are", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      const ours = await readConflictSide(repo, "f.txt", "ours");
      const theirs = await readConflictSide(repo, "f.txt", "theirs");
      expect(ours.ok && ours.text).toBe("ours change\n");
      expect(theirs.ok && theirs.text).toBe("theirs change\n");
      // And the shared parent, so "where they split" can be said.
      const base = await readConflictSide(repo, "f.txt", "base");
      expect(base.ok && base.text).toBe("line\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolving", () => {
  it("taking ours writes our version and stages the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      const done = await resolveConflict(repo, "f.txt", "ours");
      expect(done.ok).toBe(true);
      // On disk, not just in the answer.
      expect(read(repo, "f.txt")).toBe("ours change\n");
      // And gone from the unmerged list, which is the question that matters.
      expect((await readConflicts(repo)).entries).toEqual([]);
      // Not asserting a specific `M `/`A ` porcelain code here: this side's
      // content happens to be identical to what is already committed, so the
      // path is arranged and there is nothing to stage — which is still a
      // resolution. What must be true is that it is no longer `UU`.
      const status = await git(repo, ["status", "--porcelain"]);
      expect(status.stdout).not.toContain("UU");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("taking theirs writes their version and stages the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      const done = await resolveConflict(repo, "f.txt", "theirs");
      expect(done.ok).toBe(true);
      expect(read(repo, "f.txt")).toBe("theirs change\n");
      expect((await readConflicts(repo)).entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeping both leaves both versions and every marker in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      const done = await keepBoth(repo, "f.txt");
      expect(done.ok).toBe(true);
      // Nothing is resolved by this: both sides and the markers are all still
      // there, because "keep both" means the user edits it by hand next.
      const onDisk = read(repo, "f.txt");
      expect(onDisk).toContain("<<<<<<<");
      expect(onDisk).toContain("ours change");
      expect(onDisk).toContain("theirs change");
      expect((await readConflicts(repo)).entries).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a hand-edited file is written verbatim, markers and all or not", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      // The user types the answer in a text box; it lands byte for byte.
      const done = await writeResolvedFile(repo, "f.txt", "a third thing I typed myself\n");
      expect(done.ok).toBe(true);
      expect(read(repo, "f.txt")).toBe("a third thing I typed myself\n");
      expect((await readConflicts(repo)).entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a path that would leave the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    const outside = mkdtempSync(join(tmpdir(), "fl-conflict-outside-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);
      writeFileSync(join(outside, "precious.txt"), "must survive\n");

      // A path that escapes the repository must not be written. The interface
      // supplies paths from its own listing, but they are checked anyway,
      // because a resolved conflict that overwrote something outside the
      // repository would be the worst outcome of this feature.
      const done = await writeResolvedFile(repo, "../fl-conflict-outside-secret/precious.txt", "overwritten\n");
      expect(done.ok).toBe(false);
      expect(done.output).toContain("not inside this repository");
      expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("must survive\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("finishing and abandoning", () => {
  it("continuing the merge records a commit once nothing is unmerged", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);
      await resolveConflict(repo, "f.txt", "ours");

      const finished = await continueOperation(repo, "merge");
      expect(finished.ok).toBe(true);
      // The merge is over: git has a merge commit and no unfinished business.
      expect((await readConflicts(repo)).operation).toBeNull();
      const log = await git(repo, ["log", "--oneline", "-n", "1"]);
      expect(log.stdout.trim()).toMatch(/Merged|Merge/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborting the merge puts the tree back exactly where it was", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);
      const before = await git(repo, ["rev-parse", "HEAD"]);

      const aborted = await abortOperation(repo, "merge");
      expect(aborted.ok).toBe(true);
      // The file is back to the pre-merge content, byte for byte, and the
      // branch that was being merged in is still there to try again.
      expect(read(repo, "f.txt")).toBe("ours change\n");
      const after = await git(repo, ["rev-parse", "HEAD"]);
      expect(after.stdout.trim()).toBe(before.stdout.trim());
      const branch = await git(repo, ["rev-parse", "--verify", "theirs"]);
      expect(branch.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continuing while conflicts remain is refused, not papered over", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-conflict-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await makeConflict(repo);

      // Still conflicted. git refuses, and so does this.
      const finished = await continueOperation(repo, "merge");
      expect(finished.ok).toBe(false);
      expect(finished.output).toContain("unmerged");
      // Still a merge, still in progress, nothing quietly changed.
      expect((await readConflicts(repo)).operation).toBe("merge");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
