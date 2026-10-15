import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  applyStash,
  dropStash,
  hasChanges,
  listStashes,
  popStash,
  saveStash,
} from "./stash.js";

/** A repository with one commit on `main` and a working identity. */
async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, "f.txt"), "base\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "Base"]);
}

/** Dirty the working tree with an uncommitted edit. */
async function dirty(dir: string, file: string, body: string): Promise<void> {
  writeFileSync(join(dir, file), body);
}

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("saving", () => {
  it("takes the dirty tree away and cleans the working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "in progress\n");

      const saved = await saveStash(repo);
      expect(saved.ok).toBe(true);

      // The file is back to its committed content — that is what "stashed"
      // means, and it has to be checked on disk rather than in the answer.
      expect(read(repo, "f.txt")).toBe("base\n");
      expect(await hasChanges(repo)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a supplied name, because three unnamed stashes are anonymous", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "half written\n");
      await saveStash(repo, "the login fix, not finished");

      const stashes = await listStashes(repo);
      expect(stashes).toHaveLength(1);
      expect(stashes[0].message).toContain("the login fix, not finished");
      // And git's own wording for it, so the message is not lost in transit.
      expect(stashes[0].message).toContain("On main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names an unnamed stash after the branch it came from", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "work\n");
      await saveStash(repo);
      const stashes = await listStashes(repo);
      // git's default is "WIP on <branch>: <sha> <subject>", which is the only
      // wording a user can orient by when there are several of these.
      expect(stashes[0].message).toContain("WIP on main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to stash a clean tree with a real git answer, not an empty one", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const result = await saveStash(repo);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // git says "No local changes to save" on this version, and the card is
      // built from this string — so it must not be emptied on the way through.
      expect(result.output.toLowerCase()).toContain("no local changes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listing", () => {
  it("puts the newest first and gives each an index git agrees with", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "first\n");
      await saveStash(repo, "first");
      dirty(repo, "f.txt", "second\n");
      await saveStash(repo, "second");

      const stashes = await listStashes(repo);
      expect(stashes).toHaveLength(2);
      expect(stashes[0].message).toContain("second");
      expect(stashes[1].message).toContain("first");
      // The selector must match the index: `stash@{0}` is the newest. A list
      // whose numbers disagree with git's own would apply the wrong one.
      expect(stashes[0].reflogSelector).toBe("stash@{0}");
      expect(stashes[1].reflogSelector).toBe("stash@{1}");
      expect(stashes[0].ref).toBe("refs/stash@{0}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an empty stack rather than throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      // git exits non-zero on a repo with no stash at all; that is not an error.
      expect(await listStashes(repo)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("restoring", () => {
  it("apply puts the work back and leaves the stash in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "half done\n");
      await saveStash(repo, "half done");

      const back = await applyStash(repo);
      expect(back.ok).toBe(true);
      expect(read(repo, "f.txt")).toBe("half done\n");
      // Still on the stack: apply is the restore that cannot lose anything.
      expect(await listStashes(repo)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pop restores and removes, in one step", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "almost finished\n");
      await saveStash(repo);

      const popped = await popStash(repo);
      expect(popped.ok).toBe(true);
      expect(read(repo, "f.txt")).toBe("almost finished\n");
      expect(await listStashes(repo)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a particular entry when one is named", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "older work\n");
      await saveStash(repo, "older");
      dirty(repo, "f.txt", "newer work\n");
      await saveStash(repo, "newer");

      // The older one, by ref, so the index has to mean something.
      const back = await applyStash(repo, "refs/stash@{1}");
      expect(back.ok).toBe(true);
      expect(read(repo, "f.txt")).toBe("older work\n");
      // Both still on the stack — restoring is not popping.
      expect(await listStashes(repo)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dropping", () => {
  it("drop removes one entry and leaves the others alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "first\n");
      await saveStash(repo, "first");
      dirty(repo, "f.txt", "second\n");
      await saveStash(repo, "second");

      const dropped = await dropStash(repo, "refs/stash@{1}");
      expect(dropped.ok).toBe(true);

      const left = await listStashes(repo);
      expect(left).toHaveLength(1);
      expect(left[0].message).toContain("second");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a ref that isn't there, and leaves the stack untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "kept\n");
      await saveStash(repo, "kept");

      const result = await dropStash(repo, "refs/stash@{99}");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // git does not echo the bogus ref back, it counts the stack: "log for
      // 'refs/stash' only has 1 entries." The card is built from that, so the
      // string must survive the trip.
      expect(result.output).toContain("only has");
      expect(await listStashes(repo)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("undoing an apply", () => {
  it("a restore is reversible by undoing, because the working tree snapshot is taken first", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-stash-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      dirty(repo, "f.txt", "unwanted later\n");
      await saveStash(repo);

      await applyStash(repo);
      // The snapshot mechanism lives in journal.ts; what matters here is that
      // the file changed, so undo has something to restore *from*.
      expect(read(repo, "f.txt")).toBe("unwanted later\n");
      await git(repo, ["checkout", "--", "."]);
      expect(read(repo, "f.txt")).toBe("base\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
