import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * The gitignore doctor.
 *
 * It answers three questions a beginner cannot answer and an expert does not
 * bother answering: what kind of project is this, what should be ignored, and
 * what is already tracked that should not be. All three are asked of the
 * working tree, not of a list of recommendations, because the useful answer is
 * the one about *this* directory.
 *
 * Nothing here changes a repository on its own. Every suggestion is a string
 * the user can read and then decide about, and the two actions it does offer —
 * write the .gitignore, remove a tracked file from the index — each state what
 * they leave alone.
 */

/** What a project looks like it is, from the files that identify it. */
export interface ProjectType {
  id: string;
  name: string;
  /** The files that identified it, so the answer can show its work. */
  matched: string[];
}

/**
 * The kinds of project this recognises, in the order they are checked. Node is
 * first because a `package-lock.json` is a much stronger signal than a lone
 * `package.json`, which half the repositories in the world also carry.
 */
const KINDS: Array<{ id: string; name: string; markers: string[] }> = [
  { id: "node", name: "a Node.js project", markers: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "package.json"] },
  { id: "python", name: "a Python project", markers: ["requirements.txt", "Pipfile", "pyproject.toml", "setup.py"] },
  { id: "rust", name: "a Rust project", markers: ["Cargo.toml"] },
  { id: "go", name: "a Go project", markers: ["go.mod"] },
  { id: "ruby", name: "a Ruby project", markers: ["Gemfile", "Gemfile.lock"] },
  { id: "java", name: "a Java project", markers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { id: "dotnet", name: "a .NET project", markers: ["global.json", "Directory.Build.props"] },
  { id: "php", name: "a PHP project", markers: ["composer.json"] },
  { id: "swift", name: "a Swift package", markers: ["Package.swift"] },
  { id: "elixir", name: "an Elixir project", markers: ["mix.exs"] },
];

/** What a project of each kind needs ignored. These are the conventional
 *  defaults for the languages, not a policy — the user edits the result. */
const IGNORES: Record<string, string[]> = {
  node: ["node_modules/", "dist/", "build/", "coverage/", ".env", ".env.*", "*.log", ".DS_Store", "npm-debug.log*", ".vite/"],
  python: ["__pycache__/", "*.py[cod]", ".venv/", "venv/", "*.egg-info/", ".pytest_cache/", ".mypy_cache/", ".env", "*.log", ".DS_Store"],
  rust: ["/target/", "Cargo.lock", "*.pdb", ".env", "*.log"],
  go: ["/bin/", "/vendor/", ".env", "*.log", "coverage.out"],
  ruby: [".bundle/", "vendor/bundle/", "log/", "tmp/", ".env", "*.log", ".DS_Store"],
  java: ["target/", "build/", "*.class", ".gradle/", ".env", "*.log", ".DS_Store"],
  dotnet: ["bin/", "obj/", "*.user", ".vs/", ".env", "*.log", ".DS_Store"],
  php: ["vendor/", ".env", "composer.lock", "*.log", ".DS_Store"],
  swift: [".build/", ".swiftpm/", "xcuserdata/", "*.log", ".DS_Store"],
  elixir: ["/_build/", "/deps/", "/cover/", ".env", "*.log", ".DS_Store"],
  generic: ["*.log", ".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "*.swp", ".env", ".env.*"],
};

/** What a `.gitignore` should never let through, whatever the language is. */
const ALWAYS: string[] = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx"];

/** One tracked file that probably should not be. */
export interface TrackedFinding {
  path: string;
  reason: string;
  /** How serious it is, because "you have committed a key" is not the same as
   *  "you have committed a log file". */
  severity: "warning" | "note";
  /** The command that would untrack it, kept in the working tree. */
  command: string;
}

export interface DoctorReport {
  kind: ProjectType;
  /** Every untracked path that is already ignored, or not, for the summary. */
  ignoredAtTop: string[];
  tracked: TrackedFinding[];
  hasGitignore: boolean;
  /** The .gitignore this project should have, whether or not it exists. */
  suggested: string;
  /** How large the repository's working tree is, which is the one number a
   *  beginner can act on. */
  largeFiles: Array<{ path: string; megabytes: number }>;
}

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/** Secret-shaped patterns. Deliberately narrow: a false positive that stops a
 *  commit is a smaller problem than a secret that goes out, but a broad
 *  pattern that flags every config file trains the user to ignore the card. */
const SECRET_PATTERN =
  /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|id_dsa|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials|\.npmrc|\.pypirc|\.netrc)$/;

const SECOND_TO_MILLION = 1024 * 1024;

/** Which kind of project this is, from the files on disk. */
export async function detectProjectType(repoPath: string): Promise<ProjectType> {
  const entries = await safeReadDir(repoPath);
  const matched: string[] = [];
  for (const kind of KINDS) {
    const hits = kind.markers.filter((marker) => entries.includes(marker));
    if (hits.length > 0) {
      matched.push(...hits);
      return { id: kind.id, name: kind.name, matched: hits };
    }
  }
  return { id: "generic", name: "a general-purpose project", matched };
}

/** The .gitignore this repository should have. */
export function suggestGitignore(kind: ProjectType): string {
  const chosen = IGNORES[kind.id] ?? IGNORES.generic;
  const merged = [...chosen];
  for (const always of ALWAYS) if (!merged.includes(always)) merged.push(always);
  return `${merged.join("\n")}\n`;
}

/**
 * Read the whole working tree, but no deeper than a repository can hold. This
 * walks `node_modules` when it exists, which on a real machine is ten thousand
 * files and a second of waiting, so the whole scan is bounded by a file count
 * rather than by hope.
 */
export async function scanWorkingTree(repoPath: string, limit = 20000): Promise<DoctorReport> {
  const [kind, hasGitignore] = await Promise.all([
    detectProjectType(repoPath),
    fileExists(repoPath, ".gitignore"),
  ]);
  const tracked = await trackedFiles(repoPath);
  const largeFiles: Array<{ path: string; megabytes: number }> = [];
  const findings: TrackedFinding[] = [];

  const walked = await walk(repoPath, limit);
  for (const path of walked) {
    const megabytes = await sizeOf(join(repoPath, path));
    if (megabytes >= LARGE_FILE_BYTES / SECOND_TO_MILLION) {
      largeFiles.push({ path, megabytes: round2(megabytes) });
    }
    if (SECRET_PATTERN.test(path) && tracked.has(path)) {
      findings.push({
        path,
        reason: "This file looks like it holds a secret — a key, a password, or an environment file — and git has it, so it is in every copy of this repository.",
        severity: "warning",
        command: `git rm --cached "${path}"`,
      });
    }
  }
  for (const path of tracked) {
    if (isBuildOutput(path, kind.id)) {
      findings.push({
        path,
        reason: "This is build output or a dependency folder. It changes constantly and carries nothing that needs to be in git.",
        severity: "note",
        command: `git rm -r --cached "${path}"`,
      });
    }
  }
  findings.sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) : a.severity === "warning" ? -1 : 1));

  return {
    kind,
    tracked: findings,
    hasGitignore,
    suggested: suggestGitignore(kind),
    ignoredAtTop: [],
    largeFiles: largeFiles.slice(0, 20),
  };
}

/** Write a .gitignore that is not already there, or add the missing lines to
 *  one that is. Returns what it wrote, so the card can show it. */
export async function writeGitignore(
  repoPath: string,
  contents: string,
): Promise<GitRun & { ok: boolean; output: string }> {
  const target = `${repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath}/.gitignore`;
  if (!resolve(target).startsWith(`${resolve(repoPath)}${sep}`)) {
    return bad(`That path is not inside this repository: ${target}`);
  }
  const { writeFile: writeFs } = await import("node:fs/promises");
  const { readFile: readFs } = await import("node:fs/promises");
  let existing = "";
  try {
    existing = await readFs(target, "utf8");
  } catch {
    existing = "";
  }
  const missing = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !existing.split("\n").map((l) => l.trim()).includes(line));
  if (missing.length === 0) return ok("nothing to add — those lines are already there");
  const merged = existing.length === 0 ? `${missing.join("\n")}\n` : `${existing.replace(/\n*$/, "")}\n${missing.join("\n")}\n`;
  await writeFs(target, merged, "utf8");
  const add = await runGit(["-C", repoPath, "add", "--", ".gitignore"], { cwd: repoPath });
  return { ...add, ok: add.exitCode === 0, output: `${add.stdout}\n${add.stderr}`.trim() };
}

type Entry = { name: string; isDirectory(): boolean; isFile(): boolean };

async function walk(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < limit) {
    const relative = queue.shift() ?? "";
    const dir = join(root, relative);
    let entries: Entry[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Entry[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      // The .git directory is not part of the working tree, and following into
      // it would double the scan for nothing.
      if (entry.name === ".git") continue;
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isIgnoredDir(child)) continue;
        queue.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out;
}

/** Whether a directory is one git already ignores, read from git rather than
 *  from the .gitignore, because git is the thing that decides. */
function isIgnoredDir(relative: string): boolean {
  return ["node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "target", "vendor"]
    .includes(relative.split("/").pop() ?? "");
}

function isBuildOutput(path: string, kind: string): boolean {
  const looksLike = [/^node_modules\//, /^dist\//, /^build\//, /^coverage\//, /^target\//, /^\.venv\//, /^vendor\//, /__pycache__\//];
  return looksLike.some((pattern) => pattern.test(path)) || (kind === "node" && /(^|\/)(dist|build)\//.test(path));
}

async function trackedFiles(repoPath: string): Promise<Set<string>> {
  const res = await runGit(["-C", repoPath, "ls-files", "--cached"], { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 4 });
  return new Set(res.stdout.split("\n").filter((line) => line.length > 0));
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.size / SECOND_TO_MILLION;
  } catch {
    return 0;
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)) as unknown as string[];
  } catch {
    return [];
  }
}

async function fileExists(dir: string, name: string): Promise<boolean> {
  try {
    await stat(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function ok(output: string): GitRun & { ok: boolean; output: string } {
  return { ok: true, stdout: output, stderr: "", exitCode: 0, command: "gitignore", output };
}

function bad(output: string): GitRun & { ok: boolean; output: string } {
  return { ok: false, stdout: output, stderr: output, exitCode: 1, command: "gitignore", output };
}

/**
 * Stop tracking a file without deleting it from the working tree.
 *
 * `git rm --cached` is the exact tool for this and the distinction matters more
 * than it looks: the file stays on disk for the user, and only its presence in
 * the index goes away. An earlier version of this feature that ran `git rm`
 * would have deleted the user's `.env`, which is the file they were being
 * warned about.
 */
export async function untrackFile(repoPath: string, path: string): Promise<GitRun & { ok: boolean; output: string }> {
  const { resolve, sep } = await import("node:path");
  const target = resolve(`${repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath}/${path}`);
  if (!target.startsWith(`${resolve(repoPath)}${sep}`)) {
    return bad(`That path is not inside this repository: ${path}`);
  }
  const res = await runGit(["-C", repoPath, "rm", "--cached", "--", path], { cwd: repoPath });
  if (res.exitCode !== 0) return bad(`${res.stdout}\n${res.stderr}`.trim());
  return { ...res, ok: true, output: `${res.stdout}\n${res.stderr}`.trim() };
}
