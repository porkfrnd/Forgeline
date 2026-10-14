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
}

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
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...BASE_ENV, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err: Error) => {
      resolve({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127, command });
    });
    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1, command });
    });
  });
}

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
