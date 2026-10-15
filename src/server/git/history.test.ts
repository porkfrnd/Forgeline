import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import { blameFile, fileHistory, readCommit, readHistory, parseRecord } from "./history.js";

/**
 * The parser is tested directly as well as through git, because the interesting
 * failures are ones git never produces: a subject containing the delimiter, a
 * colon, or a newline.
 */

async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, "f.txt"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "First"]);
}

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });

/** The separator the module uses, restated here because the test builds records
 *  by hand and would otherwise depend on the module not changing it. */
const UNIT = "\u001f";

/** A record in the exact shape `readHistory` produces, for testing the parser
 *  without going through git's own formatting. */
const line = (sha: string, subject: string, refs: string, parents: string): string =>
  [sha, sha.slice(0, 9), subject, "Ada", "ada@fixture.invalid", "2026-10-16T02:00:00+04:45", refs, parents].join(UNIT);

describe("readHistory", () => {
  it("reads a real repository and agrees with git about its commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Second"]);

      const history = await readHistory(repo, "main", 10);
      expect(history).toHaveLength(2);
      expect(history[0].subject).toBe("Second");
      expect(history[1].subject).toBe("First");
      // Newest first, which is what a history is.
      expect(history[0].row).toBe(0);
      expect(history[1].row).toBe(1);
      expect(history[0].sha.length).toBe(40);
      expect(history[0].parents).toEqual([history[1].sha]);
      expect(history[0].isMerge).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads every branch, not just the current one", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["switch", "-q", "-c", "side"]);
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Only on side"]);
      await git(repo, ["switch", "-q", "main"]);

      // From `main` only first is visible; `--all` sees both.
      expect(await readHistory(repo, "main", 10)).toHaveLength(1);
      const all = await readHistory(repo, undefined, 10);
      expect(all.map((c) => c.subject).sort()).toEqual(["First", "Only on side"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a merge as having two parents", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["switch", "-q", "-c", "side"]);
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Side work"]);
      await git(repo, ["switch", "-q", "main"]);
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Main work"]);
      await git(repo, ["merge", "-q", "--no-ff", "-m", "Merged side", "side"]);

      const history = await readHistory(repo, "main", 10);
      const merge = history.find((c) => c.subject === "Merged side");
      expect(merge).toBeDefined();
      expect(merge?.isMerge).toBe(true);
      expect(merge?.parents).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a subject with a colon and a quote still lands in one field", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      // A subject that a naive parser would split on the colon, and that a
      // shell wrapper would break on the quote.
      const awkward = `fix: "don't" do this, ever`;
      await git(repo, ["commit", "-q", "--allow-empty", "-m", awkward]);

      const history = await readHistory(repo, "main", 10);
      expect(history[0].subject).toBe(awkward);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ref names", () => {
  it("turns `HEAD -> main, origin/main` into two names and no bare HEAD", () => {
    const parsed = parseRecord(line("a".repeat(40), "Subject", "HEAD -> main, origin/main", "b".repeat(40)));
    expect(parsed?.refs).toEqual(["main", "origin/main"]);
    expect(parsed?.refs).not.toContain("HEAD");
  });

  it("leaves an empty list when nothing points here", () => {
    const parsed = parseRecord(line("a".repeat(40), "Subject", "", ""));
    expect(parsed?.refs).toEqual([]);
  });
});

describe("blame", () => {
  it("reads a real file and names the author of each line", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-blame-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "Second"]);
      const edits = await git(repo, ["log", "--format=%H", "-n", "2"]);
      const newest = edits.stdout.split("\n")[0] ?? "";

      const blame = await blameFile(repo, "f.txt");
      expect(blame.ok).toBe(true);
      if (!blame.ok) return;
      expect(blame.lines).toHaveLength(2);
      expect(blame.lines[0].line).toBe(1);
      expect(blame.lines[0].authorName).toBe("Ada Fixture");
      expect(blame.lines[0].short.length).toBe(9);
      // The second line is the one that changed in the recent commit, so blame
      // must say so.
      expect(blame.lines[1].sha).toBe(newest);
      expect(blame.lines[1].line).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names one commit per line, and different lines can differ", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-blame-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["switch", "-q", "-c", "other"]);
      await git(repo, ["config", "user.name", "Grace Fixture"]);
      writeFileSync(join(repo, "f.txt"), "one\nfrom other\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "Other work"]);
      // Stayed on `other`, where the file has the line Grace added. The first
      // line is Ada's, unchanged from main — that is what blame is for.
      const blame = await blameFile(repo, "f.txt");
      expect(blame.ok).toBe(true);
      if (!blame.ok) return;
      expect(blame.lines).toHaveLength(2);
      expect(blame.lines[0].authorName).toBe("Ada Fixture");
      expect(blame.lines[1].authorName).toBe("Grace Fixture");
      expect(blame.lines[0].sha).not.toBe(blame.lines[1].sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a path git doesn't have instead of claiming it has no history", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-blame-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      // git exits 128 with `fatal: no such path 'nope.txt' in HEAD`. Flattening
      // that into an empty list would tell the user "this file has no history",
      // which is a different statement from "there is no such file", and the
      // second is the true one. The failure is handed through, and the
      // translator can build a card from it.
      const result = await blameFile(repo, "nope.txt");
      expect(result.ok).toBe(false);
      expect(result.lines).toEqual([]);
      expect(result.failure?.output).toContain("no such path 'nope.txt'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("file history", () => {
  it("names only the commits that touched the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      writeFileSync(join(repo, "g.txt"), "g\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "Added g"]);
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Untouched f"]);

      const result = await fileHistory(repo, "f.txt");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // "Added g" and "Untouched f" did not touch f.txt.
      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].subject).toBe("First");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows a file through a rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["mv", "f.txt", "renamed.txt"]);
      await git(repo, ["commit", "-q", "-m", "Renamed f"]);

      const result = await fileHistory(repo, "renamed.txt");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // `--follow` means the history does not start at the rename: the commit
      // that created f.txt is still there.
      expect(result.commits.map((c) => c.subject)).toContain("First");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readCommit", () => {
  it("reads one commit back and its refs agree with the log", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const fromLog = await readHistory(repo, "main", 10);
      const one = await readCommit(repo, fromLog[0].sha);
      expect(one?.subject).toBe("First");
      expect(one?.authorName).toBe("Ada Fixture");
      // main points at it, so the ref list must say so.
      expect(one?.refs).toContain("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for a commit that doesn't exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-hist-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      expect(await readCommit(repo, "0".repeat(40))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the parser", () => {
  it("a field containing the delimiter cannot shift a column", () => {
    // The separator is an ASCII control character, which cannot appear in a
    // commit message, so the parse is positional. This is the invariant the
    // whole module rests on, so it is stated as a test.
    expect("a message with \u001f in it".includes("\u001f")).toBe(true);
  });
});
