import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * Releases.
 *
 * A release is a version number, a tag, and a section of changelog, and the
 * thing that makes it frightening is that the version number is written by hand
 * in three places and the tag is only one of them. This module does the parts
 * that are mechanically checkable, and marks, `git tag` in particular, as the
 * one step that cannot be undone once it leaves this machine.
 *
 * Two rules run through all of it:
 *
 *  1. **Never invent a version number.** It is read from `package.json` and the
 *     gap between the current tag and it is computed, not guessed. A release
 *     tool that decided the version for you would be deciding it wrong.
 *  2. **Every action returns what it actually wrote.** The file contents come
 *     back, so the interface can show the line it changed and not merely a
 *     success marker.
 */

export type BumpLevel = "patch" | "minor" | "major" | "none";

/** The current version, read from `package.json` on disk. */
export async function readVersion(repoPath: string): Promise<string | null> {
  const res = await runGit(["-C", repoPath, "show", "HEAD:package.json"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS,
  });
  if (res.exitCode !== 0) return null;
  const match = res.stdout.match(/"version"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

/** Every tag, newest first, with the commit each one sits on. */
export async function listTags(repoPath: string): Promise<Array<{ name: string; sha: string; subject: string }>> {
  const res = await runGit(["-C", repoPath, "tag", "--list", "--sort=-creatordate"], { cwd: repoPath });
  if (res.exitCode !== 0) return [];
  const out: Array<{ name: string; sha: string; subject: string }> = [];
  for (const name of res.stdout.split("\n").filter((line) => line.length > 0)) {
    const sha = await runGit(["-C", repoPath, "rev-parse", `${name}^{commit}`], { cwd: repoPath });
    const subject = await runGit(["-C", repoPath, "log", "-1", "--format=%s", name], { cwd: repoPath });
    out.push({
      name,
      sha: sha.stdout.trim(),
      subject: subject.stdout.trim(),
    });
  }
  return out;
}

/** A semVER-ish next version, or null when the current one is not semVER. */
export function nextVersion(current: string, level: Exclude<BumpLevel, "none">): string | null {
  const match = current.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** What a release would do, so the interface can state it before pressing go. */
export interface ReleasePlan {
  currentVersion: string | null;
  /** The tag of the most recent release git knows about. */
  latestTag: string | null;
  /** The commits since that tag, newest first. */
  commitsSince: Array<{ sha: string; short: string; subject: string }>;
  /** What `git describe` says we are, which is what a README badge reads. */
  describe: string;
  /** True when there is anything to release at all. */
  hasChanges: boolean;
}

export async function planRelease(repoPath: string): Promise<ReleasePlan> {
  const [currentVersion, tags] = await Promise.all([readVersion(repoPath), listTags(repoPath)]);
  const latestTag = tags[0]?.name ?? null;
  const range = latestTag === null ? "" : `${latestTag}..HEAD`;
  const log = await runGit(
    ["-C", repoPath, "log", ...[range.length > 0 ? range : "HEAD"], "--format=%H%x09%h%x09%s", "--no-merges"],
    { cwd: repoPath },
  );
  const commitsSince = log.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, short, subject] = line.split("\t");
      return { sha: sha ?? "", short: short ?? "", subject: subject ?? "" };
    });
  const describe = await runGit(["-C", repoPath, "describe", "--tags", "--always"], { cwd: repoPath });
  return {
    currentVersion,
    latestTag,
    commitsSince,
    describe: describe.stdout.trim(),
    hasChanges: commitsSince.length > 0,
  };
}

/** A line of CHANGELOG text, in "Keep a Changelog" order, newest first. */
export function renderChangelogSection(version: string, subjects: string[], date: string): string {
  const added = subjects.filter((s) => /^feat/.test(s));
  const fixed = subjects.filter((s) => /^fix/.test(s));
  const other = subjects.filter((s) => !/^feat|^fix/.test(s));
  const lines = [`## [${version}] - ${date}`];
  if (added.length > 0) {
    lines.push("", "### Added");
    lines.push(...added.map((s) => `- ${s.replace(/^feat(\([^)]*\))?:\s*/, "")}`));
  }
  if (fixed.length > 0) {
    lines.push("", "### Fixed");
    lines.push(...fixed.map((s) => `- ${s.replace(/^fix(\([^)]*\))?:\s*/, "")}`));
  }
  if (other.length > 0) {
    lines.push("", "### Changed");
    lines.push(...other.map((s) => `- ${s.replace(/^[a-z]+(\([^)]*\))?:\s*/, "")}`));
  }
  return `${lines.join("\n")}\n`;
}

export type ReleaseResult =
  | (GitRun & { ok: true; output: string; detail: string })
  | (GitRun & { ok: false; output: string; code: string });

/** Write a new version into `package.json`, committing nothing. */
export async function bumpVersion(repoPath: string, from: string, to: string): Promise<ReleaseResult> {
  const current = await readVersion(repoPath);
  if (current === null) return fail({
    stdout: "There is no package.json in this repository, so there is no version to bump.",
    stderr: "",
    exitCode: 1,
    command: "git show HEAD:package.json",
  } as GitRun);
  // The version the caller *read* must be the version that is actually there.
  // An earlier version of this only checked that some version was found, so a
  // caller passing a number it had made up — or read from a stale response —
  // would silently overwrite whatever was really in the file.
  if (current !== from) {
    return fail({
      stdout: `package.json says the version is ${current}, not ${from}, so this is refusing to write anything. Read the version again and try.`,
      stderr: "",
      exitCode: 1,
      command: "git show HEAD:package.json",
    } as GitRun);
  }
  const read = await runGit(["-C", repoPath, "show", "HEAD:package.json"], { cwd: repoPath });
  const next = read.stdout.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${to}"`);
  if (next === read.stdout) {
    return fail({
      ...read,
      stdout: `Could not find version "${from}" in package.json.`,
    } as GitRun);
  }
  const write = await writeTracked(repoPath, "package.json", next);
  if (!write.ok) return fail(write);
  return { ...write, ok: true, output: write.stdout.trim(), detail: `version ${from} → ${to}` };
}

/** Add a tag on the current commit. `git tag` is the one step that cannot be
 *  undone after a push, so it refuses a tag that already exists. */
export async function tagRelease(repoPath: string, tag: string, message: string): Promise<ReleaseResult> {
  const existing = await runGit(["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
    cwd: repoPath,
  });
  if (existing.exitCode === 0) {
    return fail({
      ...existing,
      stdout: `There is already a tag called ${tag}.`,
    } as GitRun);
  }
  const res = await runGit(["-C", repoPath, "tag", "-a", tag, "-m", message], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), detail: `tagged ${tag}` };
}

/** Write a changelog file, newest first, above what was there. */
export async function writeChangelog(
  repoPath: string,
  path: string,
  section: string,
): Promise<ReleaseResult> {
  const existing = await runGit(["-C", repoPath, "show", `HEAD:${path}`], { cwd: repoPath });
  // A missing changelog is not an error: the first release starts one.
  const body = existing.exitCode === 0 ? existing.stdout : "# Changelog\n";

  // Newest first, which is the whole point of a changelog. The section goes
  // *below the title and above the previous entries* — appending it (which is
  // what this did first) put 1.1.0 under 1.0.0, which reads backwards.
  const heading = body.match(/^#\s+.*$/m);
  const updated =
    heading === null
      ? `${section}\n${body.trimStart()}`
      : `${body.slice(0, heading.index ?? 0)}${heading[0]}\n\n${section}\n${body
          .slice((heading.index ?? 0) + heading[0].length)
          .trimStart()}`;
  const write = await writeTracked(repoPath, path, updated);
  if (!write.ok) return fail(write);
  return { ...write, ok: true, output: write.stdout.trim(), detail: `updated ${path}` };
}

/** The version currently written in `package.json` — unused, kept for the shape. */
export const VERSION_FILE = "package.json";

/**
 * Today's date, as the user sees it. `toISOString` is UTC, which on a machine
 * west of Greenwich labels a release with yesterday's date and on one east of
 * it with today's — either way it disagrees with every commit timestamp the
 * user just looked at.
 */
export function localDate(now: Date = new Date()): string {
  const padding = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${padding(now.getMonth() + 1)}-${padding(now.getDate())}`;
}

/** Write a file inside a repository, refusing a path that escapes it. */
async function writeTracked(
  repoPath: string,
  path: string,
  content: string,
): Promise<GitRun & { ok: boolean; output: string }> {
  const { resolve, sep } = await import("node:path");
  const { writeFile: writeFs } = await import("node:fs/promises");
  const target = resolve(`${repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath}/${path}`);
  if (!target.startsWith(`${resolve(repoPath)}${sep}`)) {
    return {
      ok: false,
      stdout: "",
      stderr: `That path is not inside this repository: ${path}`,
      exitCode: 1,
      command: `write ${path}`,
      output: `That path is not inside this repository: ${path}`,
    };
  }
  await writeFs(target, content, "utf8");
  const add = await runGit(["-C", repoPath, "add", "--", path], { cwd: repoPath });
  return { ...add, ok: add.exitCode === 0, output: add.stdout.trim() };
}

function fail(res: GitRun): ReleaseResult {
  return { ...res, ok: false, output: `${res.stdout}\n${res.stderr}`.trim(), code: "git-error" };
}
