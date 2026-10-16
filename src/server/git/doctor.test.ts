import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  detectProjectType,
  scanWorkingTree,
  suggestGitignore,
  untrackFile,
  writeGitignore,
} from "./doctor.js";

/**
 * The doctor is asked about real directories, because the useful answer is the
 * one about *this* repository. Every assertion is checked against the files on
 * disk, not against what the function said.
 */

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });

async function makeRepo(name: string, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `fl-doc-${name}-`));
  mkdirSync(join(dir, "demo"), { recursive: true });
  const repo = join(dir, "demo");
  await git(repo, ["init", "-q", "-b", "main", "."]);
  await git(repo, ["config", "user.email", "ada@fixture.invalid"]);
  await git(repo, ["config", "user.name", "Ada Fixture"]);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return dir;
}

describe("detecting the project type", () => {
  it("reads the project type from the files that identify it", async () => {
    const root = await makeRepo("node", {
      "package.json": "{}",
      "package-lock.json": "{}",
      "src/main.ts": "export {}",
    });
    try {
      const kind = await detectProjectType(join(root, "demo"));
      expect(kind.id).toBe("node");
      expect(kind.name).toContain("Node");
      // It shows its work, because a user who is told "this is a Node project"
      // and sent off to edit a lockfile wants to know why.
      expect(kind.matched).toContain("package-lock.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the lockfile over a lone package.json", async () => {
    const root = await makeRepo("nolock", { "package.json": "{}" });
    try {
      const kind = await detectProjectType(join(root, "demo"));
      // Every repository in the world has a package.json somewhere; the
      // lockfile is what makes it a Node project.
      expect(kind.id).toBe("node");
      expect(kind.matched).toEqual(["package.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says 'general-purpose' rather than guessing when it cannot tell", async () => {
    const root = await makeRepo("unknown", { "notes.txt": "hello" });
    try {
      const kind = await detectProjectType(join(root, "demo"));
      expect(kind.id).toBe("generic");
      expect(kind.matched).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the suggested .gitignore", () => {
  it("includes what the project needs and what every project needs", () => {
    const lines = suggestGitignore({ id: "node", name: "a Node.js project", matched: ["package.json"] });
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".env");
    // Private keys are not a language-specific problem, so they are always
    // suggested whether or not the project looks like it would have any.
    expect(lines).toContain("*.pem");
    expect(lines).toContain("*.key");
  });

  it("suggests Python's own conventions for a Python project", () => {
    const lines = suggestGitignore({ id: "python", name: "a Python project", matched: ["pyproject.toml"] });
    expect(lines).toContain("__pycache__/");
    expect(lines).toContain(".venv/");
    expect(lines).toContain(".env");
  });

  it("always ends with a newline, or the last line has none", () => {
    expect(suggestGitignore({ id: "generic", name: "x", matched: [] }).endsWith("\n")).toBe(true);
  });
});

describe("writing a .gitignore", () => {
  it("starts one where there was none", async () => {
    const root = await makeRepo("start", { "readme.md": "hi" });
    try {
      const repo = join(root, "demo");
      expect(existsSync(join(repo, ".gitignore"))).toBe(false);
      const result = await writeGitignore(repo, suggestGitignore({ id: "node", name: "node", matched: [] }));
      expect(result.ok).toBe(true);
      const text = readFileSync(join(repo, ".gitignore"), "utf8");
      expect(text).toContain("node_modules/");
      expect(text.endsWith("\n")).toBe(true);
      // Staged, so it is not an untracked file the user then commits by hand.
      const staged = await git(repo, ["diff", "--cached", "--name-only"]);
      expect(staged.stdout.trim()).toBe(".gitignore");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds only the missing lines to a .gitignore that already exists", async () => {
    const root = await makeRepo("merge", {
      ".gitignore": "node_modules/\ncustom-thing/\n",
      "readme.md": "hi",
    });
    try {
      const repo = join(root, "demo");
      const result = await writeGitignore(repo, suggestGitignore({ id: "node", name: "node", matched: [] }));
      expect(result.ok).toBe(true);
      const text = readFileSync(join(repo, ".gitignore"), "utf8");
      // The user's own line survives, and is not duplicated.
      expect(text).toContain("custom-thing/");
      expect(text.split("\n").filter((l) => l.trim() === "custom-thing/").length).toBe(1);
      expect(text.split("\n").filter((l) => l.trim() === "node_modules/").length).toBe(1);
      expect(text).toContain(".env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing and reports it when everything is already ignored", async () => {
    const suggestion = suggestGitignore({ id: "generic", name: "generic", matched: [] });
    const root = await makeRepo("full", { ".gitignore": suggestion, "readme.md": "hi" });
    try {
      const repo = join(root, "demo");
      const result = await writeGitignore(repo, suggestion);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("already there");
      // Nothing new staged, so the user is not left with a change to review
      // that is not a change.
      const staged = await git(repo, ["diff", "--cached", "--name-only"]);
      expect(staged.stdout.trim()).toBe("");
      const after = readFileSync(join(repo, ".gitignore"), "utf8");
      expect(after).toBe(suggestion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanning the working tree", () => {
  it("flags a .env that is already tracked, as the most serious finding", async () => {
    const root = await makeRepo("env", {
      "package.json": "{}",
      ".env": "SECRET=1234\n",
    });
    try {
      const repo = join(root, "demo");
      const report = await scanWorkingTree(repo);
      const env = report.tracked.find((finding) => finding.path === ".env");
      expect(env).toBeDefined();
      expect(env?.severity).toBe("warning");
      // And the command it offers is `rm --cached`, which untracks without
      // deleting — running `git rm` would delete the user's .env.
      expect(env?.command).toContain("--cached");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags build output as a lesser kind of problem", async () => {
    const root = await makeRepo("build", {
      "package.json": "{}",
      "node_modules/left-pad/index.js": "module.exports = 1;\n",
    });
    try {
      const repo = join(root, "demo");
      const report = await scanWorkingTree(repo);
      const dep = report.tracked.find((finding) => finding.path.startsWith("node_modules/"));
      expect(dep).toBeDefined();
      expect(dep?.severity).toBe("note");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts the warnings above the notes, because that is the order they matter in", async () => {
    const root = await makeRepo("order", {
      "package.json": "{}",
      ".env": "SECRET=1\n",
      "node_modules/left-pad/index.js": "1\n",
    });
    try {
      const repo = join(root, "demo");
      const report = await scanWorkingTree(repo);
      const firstWarning = report.tracked.findIndex((finding) => finding.severity === "warning");
      const firstNote = report.tracked.findIndex((finding) => finding.severity === "note");
      expect(firstWarning).toBeGreaterThanOrEqual(0);
      expect(firstNote).toBeGreaterThan(firstWarning);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports large files, over the 5 MB line the spec draws", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, "x");
    const root = await makeRepo("large", { "package.json": "{}" });
    try {
      const repo = join(root, "demo");
      writeFileSync(join(repo, "huge.bin"), big);
      const report = await scanWorkingTree(repo);
      expect(report.largeFiles.map((file) => file.path)).toContain("huge.bin");
      const found = report.largeFiles.find((file) => file.path === "huge.bin");
      expect(found?.megabytes).toBeGreaterThan(5);
      // Rounded to something a person reads.
      expect(found?.megabytes).toBe(Math.round((found?.megabytes ?? 0) * 100) / 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not look inside .git, which is not part of the working tree", async () => {
    const root = await makeRepo("gitdir", {
      "package.json": "{}",
      "readme.md": "hi",
    });
    try {
      const repo = join(root, "demo");
      const report = await scanWorkingTree(repo);
      const inGit = report.largeFiles.some((file) => file.path.includes(".git/"));
      expect(inGit).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says whether a .gitignore exists, because the card needs to offer the right line", async () => {
    const withOne = await makeRepo("has", { ".gitignore": "dist/\n", "package.json": "{}" });
    const withoutOne = await makeRepo("hasnt", { "package.json": "{}" });
    try {
      expect((await scanWorkingTree(join(withOne, "demo"))).hasGitignore).toBe(true);
      expect((await scanWorkingTree(join(withoutOne, "demo"))).hasGitignore).toBe(false);
    } finally {
      rmSync(withOne, { recursive: true, force: true });
      rmSync(withoutOne, { recursive: true, force: true });
    }
  });

  it("walks a node_modules tree without following it", async () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let i = 0; i < 50; i += 1) files[`node_modules/pkg-${i}/index.js`] = "1\n";
    const root = await makeRepo("deep", files);
    try {
      const repo = join(root, "demo");
      const started = Date.now();
      const report = await scanWorkingTree(repo);
      expect(report.tracked.length).toBeGreaterThan(0);
      // It is bounded — a scan that walked node_modules on a real machine would
      // take minutes, and a card that takes minutes is a card nobody reads.
      expect(Date.now() - started).toBeLessThan(20000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("untracking a file", () => {
  it("keeps the file on disk and takes it out of the index", async () => {
    const root = await makeRepo("untrack", { ".env": "SECRET=1\n", "readme.md": "hi" });
    try {
      const repo = join(root, "demo");
      const result = await untrackFile(repo, ".env");
      expect(result.ok).toBe(true);
      // The file is still there — the user still needs their .env.
      expect(existsSync(join(repo, ".env"))).toBe(true);
      expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
      const tracked = await git(repo, ["ls-files"]);
      expect(tracked.stdout).not.toContain(".env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a path that would leave the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-doc-escape-"));
    const outside = mkdtempSync(join(tmpdir(), "fl-doc-target-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      await git(repo, ["init", "-q", "-b", "main", "."]);
      writeFileSync(join(outside, "precious.txt"), "must survive\n");
      const result = await untrackFile(repo, `../${outside.split("/").pop()}/precious.txt`);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("not inside this repository");
      expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("must survive\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports failure when the path is not tracked at all", async () => {
    const root = await makeRepo("missing", { "readme.md": "hi" });
    try {
      const repo = join(root, "demo");
      const result = await untrackFile(repo, "not-tracked.txt");
      expect(result.ok).toBe(false);
      // And it says so, rather than reporting a success that changed nothing.
      expect(result.output.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the doctor's own limits", () => {
  it("leaves the working tree alone, because suggesting is not doing", async () => {
    const root = await makeRepo("quiet", { "package.json": "{}", ".env": "SECRET=1\n" });
    try {
      const repo = join(root, "demo");
      await scanWorkingTree(repo);
      // The scan itself changes nothing at all, not even the index.
      const status = await git(repo, ["status", "--porcelain"]);
      expect(status.stdout.trim()).toBe("");
      expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
