import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  parseStatusFiles,
  parseUnifiedDiff,
  readChangedFiles,
  readFileDiff,
  type FileDiff,
} from "./diff.js";

async function git(dir: string, args: string[]): Promise<void> {
  const res = await runGit(["-C", dir, ...args], { cwd: dir });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

/** A repo holding every file shape that has ever broken a diff viewer. */
async function makeHunkRepo(): Promise<{ dir: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "fl-hunks-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "ada@fixture.invalid"]);
  await git(repo, ["config", "user.name", "Ada Fixture"]);

  // CRLF line endings.
  writeFileSync(join(repo, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  // A file whose last line has no trailing newline.
  writeFileSync(join(repo, "no-eol.txt"), "alpha\nbeta");
  // A rename target.
  writeFileSync(join(repo, "old-name.txt"), "stays the same\n");
  // A binary blob.
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 250, 251, 252]));
  // A mode-change target.
  writeFileSync(join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
  // A symlink target.
  writeFileSync(join(repo, "link-source.txt"), "pointed at\n");
  mkdirSync(join(repo, "sub dir"), { recursive: true });
  writeFileSync(join(repo, "sub dir", "spaces and ünïcode.txt"), "unicode\n");

  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Base"]);
  return { dir: repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("parseStatusFiles", () => {
  it("reads staged, unstaged, and both-at-once from the XY columns", () => {
    const out =
      "# branch.head main\0" +
      "1 .M N... 100644 100644 100644 a b unstaged.txt\0" +
      "1 M. N... 100644 100644 100644 a b staged.txt\0" +
      "1 MM N... 100644 100644 100644 a b both.txt\0";
    const files = parseStatusFiles(out);
    expect(files.map((f) => f.path)).toEqual(["unstaged.txt", "staged.txt", "both.txt"]);
    expect(files[0]).toMatchObject({ staged: false, unstaged: true, letter: "M" });
    expect(files[1]).toMatchObject({ staged: true, unstaged: false, letter: "M" });
    expect(files[2]).toMatchObject({ staged: true, unstaged: true, letter: "M" });
  });

  it("reads a rename and its original path from consecutive records", () => {
    const out =
      "2 R. N... 100644 100644 100644 a b R100 new name.txt\0old name.txt\0";
    const [file] = parseStatusFiles(out);
    expect(file?.path).toBe("new name.txt");
    expect(file?.originalPath).toBe("old name.txt");
    expect(file?.letter).toBe("R");
    expect(file?.staged).toBe(true);
  });

  it("lists untracked paths as staged false, unstaged true", () => {
    const files = parseStatusFiles("? ünïcode é.txt\0");
    expect(files).toEqual([
      { path: "ünïcode é.txt", letter: "A", staged: false, unstaged: true, conflicted: false },
    ]);
  });

  it("marks unmerged paths as conflicted and skips ignored ones", () => {
    // Real format: four mode fields and three hashes before the path.
    const files = parseStatusFiles(
      "u UU N... 100644 100644 100644 100644 a b c merge.txt\0! ignored.txt\0",
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "merge.txt", letter: "U", conflicted: true });
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers removed and added lines on their own sides", () => {
    const unified =
      "@@ -1,3 +1,3 @@\n" +
      " one\n" +
      "-two\n" +
      "+TWO\n" +
      " three\n";
    const diff = parseUnifiedDiff(unified, "a.txt");
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    const lines = diff.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["context", 3, 3],
    ]);
  });

  it("records the no-trailing-newline marker on the line it qualifies", () => {
    const unified = "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    const diff = parseUnifiedDiff(unified, "b.txt");
    const lines = diff.hunks[0]?.lines ?? [];
    expect(lines.find((l) => l.kind === "del")?.noEol).toBe(true);
    expect(lines.find((l) => l.kind === "add")?.noEol).toBe(true);
  });

  it("reports a binary file as having no hunks", () => {
    const diff = parseUnifiedDiff("Binary files a/blob.bin and b/blob.bin differ\n", "blob.bin");
    expect(diff).toMatchObject({ binary: true, hunks: [] });
  });

  it("parses several hunks and a header with context after the @@", () => {
    const unified =
      "@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n" +
      "@@ -10,3 +10,3 @@ function name\n ten\n-eleven\n+ELEVEN\n twelve\n";
    const diff = parseUnifiedDiff(unified, "c.txt");
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[1]?.oldStart).toBe(10);
    expect(diff.hunks[1]?.header).toContain("function name");
  });
});

describe("live diff reads against real git", () => {
  it("sees a CRLF file, a missing trailing newline, and a rename", async () => {
    const fx = await makeHunkRepo();
    try {
      writeFileSync(join(fx.dir, "crlf.txt"), "one\r\nTWO\r\nthree\r\n");
      writeFileSync(join(fx.dir, "no-eol.txt"), "alpha\nBETA");
      await git(fx.dir, ["mv", "old-name.txt", "renamed.txt"]);

      const files = await readChangedFiles(fx.dir);
      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(["crlf.txt", "no-eol.txt", "renamed.txt"]);
      expect(files.find((f) => f.path === "renamed.txt")?.originalPath).toBe("old-name.txt");

      const crlf = await readFileDiff(fx.dir, "crlf.txt", false);
      expect(crlf.binary).toBe(false);
      const crlfText = (crlf.hunks[0]?.lines ?? []).map((l) => l.text).join("\n");
      expect(crlfText).toContain("TWO");

      const noEol = await readFileDiff(fx.dir, "no-eol.txt", false);
      expect(noEol.hunks[0]?.lines.some((l) => l.noEol)).toBe(true);
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("reports a binary file as binary rather than as mojibake", async () => {
    const fx = await makeHunkRepo();
    try {
      writeFileSync(join(fx.dir, "blob.bin"), Buffer.from([9, 8, 7, 6, 1]));
      const diff = await readFileDiff(fx.dir, "blob.bin", false);
      expect(diff.binary).toBe(true);
      expect(diff.hunks).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("sees a mode change and a new symlink", async () => {
    const fx = await makeHunkRepo();
    try {
      chmodSync(join(fx.dir, "script.sh"), 0o755);
      symlinkSync("link-source.txt", join(fx.dir, "link.txt"));
      const files = await readChangedFiles(fx.dir);
      const letters = new Map(files.map((f) => [f.path, f.letter]));
      // Git reports a mode-only change as an `M`, not a `T` — `T` is for a
      // change of file *type*. Assert that, so a future refactor does not
      // "fix" the mapping into something git never sends.
      expect(letters.get("script.sh")).toBe("M");
      expect(letters.get("link.txt")).toBe("A");

      // The mode change still has to be visible in the diff itself.
      const raw = await runGit(["-C", fx.dir, "diff", "--no-color"], { cwd: fx.dir });
      expect(raw.stdout).toMatch(/old mode 100644/);
      expect(raw.stdout).toMatch(/new mode 100755/);
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("diffs a path with spaces and non-Latin characters", async () => {
    const fx = await makeHunkRepo();
    try {
      const rel = join("sub dir", "spaces and ünïcode.txt");
      writeFileSync(join(fx.dir, rel), "unicode changed\n");
      const diff = await readFileDiff(fx.dir, rel, false);
      expect(diff.binary).toBe(false);
      const text = (diff.hunks[0]?.lines ?? []).map((l) => l.text).join("\n");
      expect(text).toContain("unicode changed");
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("keeps staged and unstaged hunks separate", async () => {
    const fx = await makeHunkRepo();
    try {
      writeFileSync(join(fx.dir, "no-eol.txt"), "alpha\nbeta\nstaged\n");
      await git(fx.dir, ["add", "no-eol.txt"]);
      writeFileSync(join(fx.dir, "no-eol.txt"), "alpha\nbeta\nstaged\nunstaged\n");

      const staged = await readFileDiff(fx.dir, "no-eol.txt", true);
      const unstaged = await readFileDiff(fx.dir, "no-eol.txt", false);
      const stagedText = JSON.stringify(staged);
      const unstagedText = JSON.stringify(unstaged);
      expect(stagedText).toContain("staged");
      expect(stagedText).not.toContain("unstaged");
      expect(unstagedText).toContain("unstaged");
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("returns no diff rather than throwing when the path is unknown", async () => {
    const fx = await makeHunkRepo();
    try {
      const diff: FileDiff = await readFileDiff(fx.dir, "does-not-exist.txt", false);
      expect(diff.hunks).toEqual([]);
      expect(diff.binary).toBe(false);
    } finally {
      fx.cleanup();
    }
  }, 60000);
});
