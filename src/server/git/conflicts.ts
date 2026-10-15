import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * Conflicts.
 *
 * A conflicted merge is the one moment in git where the tool stops and waits,
 * and it is the moment a beginner is most likely to be stranded — the state is
 * visible, the output is four hundred words of prose, and the way out is a
 * command nobody has heard of. This module turns that into a list of files with
 * two versions each and three answers: take mine, take theirs, or keep both.
 *
 * The rule underneath everything here: **never write a file that resolves a
 * conflict without saying what it wrote.** Every `resolve` returns the path it
 * changed and which side it chose, so the interface can show that in one
 * sentence rather than leaving the user to diff the result.
 */

export type ConflictKind =
  /** Both sides changed the same lines. */
  | "both-modified"
  /** One side changed it, the other deleted it. */
  | "delete-modify"
  /** Both renamed it, differently. */
  | "rename-rename"
  | "other";

export interface ConflictEntry {
  /** The path in the working tree, which is the one the user sees. */
  path: string;
  kind: ConflictKind;
  /** What git calls each side, so the buttons can be labelled honestly. */
  stages: { ours: string | null; theirs: string | null; base: string | null };
  /** True when the file currently on disk still contains conflict markers. */
  hasMarkers: boolean;
}

export interface ConflictIndex extends GitRun {
  ok: boolean;
  entries: ConflictEntry[];
  /** The operation that stopped: a merge, or a rebase, or a stash apply. */
  operation: string | null;
}

/** Which stopped operation is in progress, read from git's own state. */
async function stoppedOperation(repoPath: string): Promise<string | null> {
  const states: Array<[string, string]> = [
    // The merge marker is `MERGE_HEAD`, which is what `git rev-parse --verify`
    // resolves. Naming it "merge" — which `rev-parse` reads as a branch that
    // usually does not exist — made every in-progress merge look like nothing
    // was happening.
    ["merge", "MERGE_HEAD"],
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
    ["stash", "stash"],
  ];
  for (const [name, marker] of states) {
    const res = await runGit(["-C", repoPath, "rev-parse", "--verify", "--quiet", marker], { cwd: repoPath });
    if (res.exitCode === 0) return name === "stash" ? "stash apply" : name;
  }
  return null;
}

/** Every unmerged path, which is the one question that answers the rest. */
async function unmergedPaths(repoPath: string): Promise<string[]> {
  const res = await runGit(["-C", repoPath, "diff", "--name-only", "--diff-filter=U", "--no-renames"], {
    cwd: repoPath,
  });
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Read one conflict index entry: the three stages and what kind of conflict
 * git recorded.
 */
async function classify(repoPath: string, path: string): Promise<{ kind: ConflictKind; stages: ConflictEntry["stages"] }> {
  const res = await runGit(["-C", repoPath, "ls-files", "-u", "--", path], { cwd: repoPath });
  const stages: ConflictEntry["stages"] = { ours: null, theirs: null, base: null };

  // The line is `<mode> <sha> <stage>\t<path>`, so the stage number is the
  // third whitespace-separated field and never the first. An earlier version
  // looked for a line *starting* with "1 ", "2 ", or "3 ", which never matches
  // and made every conflict read as "other" — the kind was wrong but nothing
  // crashed, which is the sort of bug that survives review.
  const seen = new Set<number>();
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    const fields = line.split("\t")[0].trim().split(/\s+/);
    const sha = fields[1];
    const stage = Number(fields[2]);
    if (sha === undefined || !Number.isFinite(stage)) continue;
    seen.add(stage);
    if (stage === 1) stages.base = sha;
    else if (stage === 2) stages.ours = sha;
    else if (stage === 3) stages.theirs = sha;
  }

  // The kind comes from which stages exist, not from guessing at file contents:
  // "theirs deleted it" and "both changed it" look similar on disk and need
  // different words from the interface.
  const has = (n: number) => seen.has(n);
  if (has(2) && has(3)) return { kind: "both-modified", stages };
  if (has(2) || has(3)) return { kind: "delete-modify", stages };
  return { kind: "other", stages };

}

/**
 * Whether the file on disk still carries conflict markers.
 *
 * This reads the *working tree*, with `readFileSync`, rather than `git show :0:path`.
 * Stage 0 is what git would stage, and for an unresolved conflict there is no
 * stage 0 to show — so the earlier version of this returned `false` on exactly
 * the files that were the conflicted ones, which is the opposite of useful.
 */
async function hasMarkersOnDisk(repoPath: string, path: string): Promise<boolean> {
  try {
    const target = resolve(joinPath(repoPath, path));
    if (!target.startsWith(`${resolve(repoPath)}${sep}`)) return false;
    const text = readFileSync(target, "utf8");
    return text.includes("<<<<<<<") || text.includes(">>>>>>>");
  } catch {
    // No file on disk is itself an answer: the markers are not there.
    return false;
  }
}

/** The index: every conflicted path, classified. */
export async function readConflicts(repoPath: string): Promise<ConflictIndex> {
  const operation = await stoppedOperation(repoPath);
  const paths = await unmergedPaths(repoPath);
  const entries: ConflictEntry[] = [];
  for (const path of paths) {
    const { kind, stages } = await classify(repoPath, path);
    entries.push({ path, kind, stages, hasMarkers: await hasMarkersOnDisk(repoPath, path) });
  }
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    command: "git diff --name-only --diff-filter=U",
    entries,
    operation,
  };
}

/** One side of one conflicted file, as text. */
export async function readConflictSide(
  repoPath: string,
  path: string,
  side: "ours" | "theirs" | "base",
): Promise<{ ok: true; text: string } | { ok: false; output: string }> {
  const stage = side === "ours" ? 2 : side === "theirs" ? 3 : 1;
  const res = await runGit(["-C", repoPath, "show", `:${stage}:${path}`], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS,
  });
  if (res.exitCode !== 0) return { ok: false, output: res.stderr || "git could not read that side." };
  return { ok: true, text: res.stdout };
}

export type ResolveResult =
  | (GitRun & { ok: true; output: string; resolved: string | null; choice: string })
  | (GitRun & { ok: false; output: string; code: string });

/**
 * Take one side of a conflict by writing that side's content into the file and
 * staging the result.
 *
 * `git checkout --ours/--theirs` would do the write, but it stages too, and the
 * interface wants to say "I wrote this file" first. So the content is read and
 * written explicitly, which also means the words the interface uses about what
 * happened are literally true.
 */
export async function resolveConflict(
  repoPath: string,
  path: string,
  choice: "ours" | "theirs",
): Promise<ResolveResult> {
  const side = await readConflictSide(repoPath, path, choice);
  if (!side.ok) return fail(`could not read the ${choice} version of ${path}`);
  const written = writeFileSafe(repoPath, path, side.text);
  if (!written.ok) return fail(written.output);
  const add = await runGit(["-C", repoPath, "add", "--", path], { cwd: repoPath });
  if (add.exitCode !== 0) return fail(`${add.stdout}\n${add.stderr}`.trim());
  return {
    ...add,
    ok: true,
    output: add.stdout.trim(),
    resolved: path,
    choice,
  };
}

/** Keep both versions, side by side, with the markers left in. */
export async function keepBoth(repoPath: string, path: string): Promise<ResolveResult> {
  // The working tree already holds both versions, markers and all, because
  // that is what git left there — so this writes nothing and stages nothing.
  //
  // Staging it is the bug this shape avoids: `git add` on a conflicted file
  // moves it to stage 0, which makes git consider the conflict resolved, and
  // "keep both" would then be a lie the user has to unwind by hand.
  const probe = await runGit(["-C", repoPath, "status", "--porcelain", "--", path], { cwd: repoPath });
  if (probe.exitCode !== 0) return fail(`${probe.stdout}\n${probe.stderr}`.trim());
  return { ...probe, ok: true, output: "kept both, unresolved", resolved: path, choice: "both" };
}

/** Write a hand-edited file and stage it. */
export async function writeResolvedFile(
  repoPath: string,
  path: string,
  content: string,
): Promise<ResolveResult> {
  const written = writeFileSafe(repoPath, path, content);
  if (!written.ok) return fail(written.output);
  const add = await runGit(["-C", repoPath, "add", "--", path], { cwd: repoPath });
  if (add.exitCode !== 0) return fail(`${add.stdout}\n${add.stderr}`.trim());
  return { ...add, ok: true, output: "staged", resolved: path, choice: "hand-edited" };
}

/** Finish the stopped operation, now that nothing is unmerged. */
export async function continueOperation(repoPath: string, operation: string): Promise<ResolveResult> {
  // `merge --continue` opens an editor, which is exactly what this interface
  // must never do, so it goes through a temporary environment with the editor
  // disabled rather than being allowed to hang.
  const res = await runGit(["-C", repoPath, operation === "merge" ? "merge" : operation, "--continue"], {
    cwd: repoPath,
    env: { GIT_EDITOR: "true", EDITOR: "true", VISUAL: "true" },
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 3,
  });
  if (res.exitCode !== 0) return fail(`${res.stdout}\n${res.stderr}`.trim());
  return { ...res, ok: true, output: `${res.stdout}\n${res.stderr}`.trim(), resolved: null, choice: "continue" };
}

export async function abortOperation(repoPath: string, operation: string): Promise<ResolveResult> {
  const which = operation === "merge" ? "merge" : operation === "rebase" ? "rebase" : operation;
  const res = await runGit(["-C", repoPath, which, "--abort"], {
    cwd: repoPath,
    env: { GIT_EDITOR: "true", EDITOR: "true", VISUAL: "true" },
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 2,
  });
  if (res.exitCode !== 0) return fail(`${res.stdout}\n${res.stderr}`.trim());
  return { ...res, ok: true, output: `${res.stdout}\n${res.stderr}`.trim(), resolved: null, choice: "abort" };
}

/** Report a message rather than a GitRun, for the paths that never ran git. */
function fail(output: string): ResolveResult {
  return {
    ok: false,
    stdout: "",
    stderr: "",
    exitCode: 1,
    command: "git (resolve)",
    output,
    code: "git-error",
  };
}

/** Write one file inside a repository, refusing a path that escapes it. */
function writeFileSafe(
  repoPath: string,
  path: string,
  content: string,
): { ok: true } | { ok: false; output: string } {
  // A path from the interface is not a path to trust. `..` and a leading
  // separator are both ways out of the repository, and the string check an
  // earlier version used passed for `../elsewhere/x` because the *joined*
  // string still starts with the repository's name. So the joined path is
  // resolved before it is checked, which is the only way `..` cannot sneak
  // through.
  const target = resolve(joinPath(repoPath, path));
  if (target !== resolve(repoPath) && !target.startsWith(`${resolve(repoPath)}/`)) {
    return { ok: false, output: `That path is not inside this repository: ${path}` };
  }
  try {
    writeFileSync(target, content);
    return { ok: true };
  } catch (error) {
    return { ok: false, output: `Could not write ${path}: ${String(error)}` };
  }
}

/** Join a path against a repository, without normalising `..` away from it. */
function joinPath(repoPath: string, path: string): string {
  const root = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  return `${root}/${path}`;
}
