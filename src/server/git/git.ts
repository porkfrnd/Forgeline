import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

export interface RunGitOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Kill the process after this long. Defaults to PATIENCE_MS; network
   *  operations pass a longer IMPATIENCE_MS. */
  timeoutMs?: number;
}

/** Long enough for a big local repo, short enough that a hung `status` never
 *  wedges the dashboard. Local git has no business taking longer. */
const PATIENCE_MS = 15_000;
/** Fetch and push talk to another machine. Give them room. */
const IMPATIENCE_MS = 120_000;

export const GIT_TIMEOUTS = { PATIENCE_MS, IMPATIENCE_MS };

const BASE_ENV: Record<string, string> = {
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
};

export function runGit(
  args: string[],
  opts: RunGitOptions,
): Promise<GitResult> {
  const command = `git ${args.join(" ")}`;
  const timeoutMs = opts.timeoutMs ?? PATIENCE_MS;
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...BASE_ENV, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Git reports this itself rather than letting it look like a crash.
      stderr += `${stderr.length > 0 ? "\n" : ""}git timed out after ${timeoutMs}ms`;
      child.kill("SIGKILL");
      finish({ stdout, stderr, exitCode: 124, command });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err: Error) => {
      finish({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127, command });
    });
    child.on("close", (code: number | null) => {
      finish({ stdout, stderr, exitCode: code ?? 1, command });
    });
  });
}

/** `--` before path arguments, so a path beginning with `-` can never be
 *  read as an option. Every call that passes a path builds its args through
 *  here rather than concatenating. */
export function withPaths(before: string[], paths: string[]): string[] {
  if (paths.length === 0) return before;
  return [...before, "--", ...paths];
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface RepoStatusFields {
  branch: string;
  changedFiles: number;
  ahead: number;
  behind: number;
}

const OPTIONAL_LOCKS_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
};

export function parseGitVersion(output: string): { major: number; minor: number } | null {
  const m = output.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function meetsMinVersion(
  v: { major: number; minor: number } | null,
  minMajor: number,
  minMinor: number,
): boolean {
  if (!v) return false;
  if (v.major !== minMajor) return v.major > minMajor;
  return v.minor >= minMinor;
}

/** Current branch name for a repo. A detached HEAD reports as `HEAD`
 *  (the dashboard shows the short sha alongside it when available). */
export async function currentBranch(repoPath: string): Promise<string> {
  const res = await runGit([...gitInDirArgs(repoPath), "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    env: OPTIONAL_LOCKS_ENV,
  });
  if (res.exitCode !== 0) return "unknown";
  const branch = res.stdout.trim();
  if (branch.length === 0) return "unknown";
  if (branch !== "HEAD") return branch;
  const sha = await runGit([...gitInDirArgs(repoPath), "rev-parse", "--short", "HEAD"], {
    cwd: repoPath,
    env: OPTIONAL_LOCKS_ENV,
  });
  return sha.exitCode === 0 && sha.stdout.trim().length > 0
    ? `HEAD (${sha.stdout.trim()})`
    : "HEAD";
}

/** Count changed paths from NUL-separated `status --porcelain=v2 --branch`
 *  output. Branch header lines (`# ...`) are not changes, so they are
 *  skipped; every other record is one changed path. */
export function parseStatusChangedFiles(porcelainV2Z: string): number {
  let changed = 0;
  for (const record of porcelainV2Z.split("\0")) {
    if (record.length === 0) continue;
    if (record.startsWith("#")) continue;
    changed += 1;
  }
  return changed;
}

/** Parse the branch name out of a `status --porcelain=v2 --branch` header
 *  (`# branch.head <name>`). Returns `null` when the header is absent, and
 *  the literal `"HEAD"` for a detached HEAD. The dashboard shows the short
 *  sha alongside that, which is the only case still needing a second git
 *  call — the normal case costs one process per refresh, not two. */
export function parseStatusBranch(porcelainV2Z: string): string | null {
  const prefix = "# branch.head ";
  for (const record of porcelainV2Z.split("\0")) {
    if (!record.startsWith(prefix)) continue;
    const head = record.slice(prefix.length).trim();
    if (head.length === 0) return null;
    return head === "(detached)" ? "HEAD" : head;
  }
  return null;
}

/** Parse `rev-list --left-right --count A...B` output (`"<ahead>\t<behind>"`). */
export function parseRevListCount(output: string): AheadBehind {
  const parts = output.trim().split(/\s+/);
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  return {
    ahead: Number.isInteger(ahead) && ahead >= 0 ? ahead : 0,
    behind: Number.isInteger(behind) && behind >= 0 ? behind : 0,
  };
}

/** Ahead/behind counts against the upstream. Repos without an upstream
 *  report 0/0; the dashboard shows "no upstream" from the ahead/behind
 *  being zero only when there is truly no upstream configured. */
export async function aheadBehind(repoPath: string): Promise<AheadBehind> {
  const upstream = await runGit(
    [...gitInDirArgs(repoPath), "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: repoPath, env: OPTIONAL_LOCKS_ENV },
  );
  if (upstream.exitCode !== 0) return { ahead: 0, behind: 0 };
  const counts = await runGit(
    [...gitInDirArgs(repoPath), "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    { cwd: repoPath, env: OPTIONAL_LOCKS_ENV },
  );
  if (counts.exitCode !== 0) return { ahead: 0, behind: 0 };
  return parseRevListCount(counts.stdout);
}

/** Live dashboard fields for one repo. Never throws: when git fails the
 *  repo reports `branch: "unknown"` with zero counts (the route still
 *  answers 200 so one broken repo cannot hide the rest). */
export async function repoStatusFields(repoPath: string): Promise<RepoStatusFields> {
  const status = await runGit(
    [...gitInDirArgs(repoPath), "status", "--porcelain=v2", "-z", "--branch"],
    { cwd: repoPath, env: OPTIONAL_LOCKS_ENV },
  );
  if (status.exitCode !== 0) {
    return { branch: "unknown", changedFiles: 0, ahead: 0, behind: 0 };
  }
  // The branch name is already in the status header, so the normal case is
  // one git process for the branch plus one for ahead/behind. Only a
  // detached HEAD needs the extra `rev-parse --short` to name the commit.
  let branch = parseStatusBranch(status.stdout) ?? "unknown";
  if (branch === "HEAD") {
    const sha = await runGit([...gitInDirArgs(repoPath), "rev-parse", "--short", "HEAD"], {
      cwd: repoPath,
      env: OPTIONAL_LOCKS_ENV,
    });
    const short = sha.stdout.trim();
    if (sha.exitCode === 0 && short.length > 0) branch = `HEAD (${short})`;
  }
  const counts = await aheadBehind(repoPath);
  return {
    branch,
    changedFiles: parseStatusChangedFiles(status.stdout),
    ahead: counts.ahead,
    behind: counts.behind,
  };
}

/** Keep the repo directory as its own argv element (never a shell string). */
function gitInDirArgs(dir: string): string[] {
  return ["-C", dir];
}
