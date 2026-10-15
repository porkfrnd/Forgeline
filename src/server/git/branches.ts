import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";
import type { AheadBehind } from "./git.js";

/**
 * Branches.
 *
 * A branch is the one thing in git a user creates and switches constantly, so
 * the operations here are deliberately short: list, create, switch, rename,
 * delete. Each one is journalled by the caller, and each reports whether the
 * working tree changed, because that is the part the user has to know about.
 *
 * `checkout` is `git switch` rather than `git checkout`. They behave
 * differently in a way that matters: `git checkout` will guess and happily
 * switch to a branch whose name matches a path, while `git switch` complains
 * instead of guessing. A manager that picked the wrong branch silently would be
 * worse than one that asked a question.
 */

export interface BranchEntry {
  /** The branch's own name, not a refname. */
  name: string;
  /** Whether this is the branch HEAD points at right now. */
  current: boolean;
  /** True for branches that live on a remote (`origin/…`) rather than locally. */
  remote: boolean;
  /** The upstream this branch tracks, if any. */
  upstream: string | null;
  /** Ahead/behind against the upstream. Null when there is nothing to compare. */
  counts: AheadBehind | null;
  /** True when the tip commit is not an ancestor of any other branch — the
   *  ordinary "this has work nothing else has" state. */
  hasUnmergedWork: boolean;
}

/** Every branch, local first in git's own order and remotes after. */
export async function listBranches(repoPath: string): Promise<BranchEntry[]> {
  const current = await currentBranch(repoPath);
  // `git branch -a` — the format string is chosen so nothing needs parsing
  // out of a human-readable column layout.
  const format = ["%(refname:short)", "%(upstream:short)", "%(upstream:trackshort)"].join("%09");
  const res = await runGit(["-C", repoPath, "for-each-ref", "--format=" + format, "refs/heads", "refs/remotes"], {
    cwd: repoPath,
  });
  if (res.exitCode !== 0) return [];

  const out: BranchEntry[] = [];
  const lines = res.stdout.split("\n").filter((line) => line.length > 0);
  // Resolving each upstream's ahead/behind is one process per branch, so it is
  // done in parallel rather than serially — 30 branches would otherwise be 30
  // round trips.
  const counts = await Promise.all(
    lines.map(async (line) => {
      const [name, upstream] = line.split("\t");
      if (upstream === undefined || upstream.length === 0) return null;
      return aheadBehindNamed(repoPath, name, upstream);
    }),
  );

  lines.forEach((line, i) => {
    const [name, upstream, trackshort] = line.split("\t");
    const isRemote = name.includes("/");
    const countsFor = counts[i];
    out.push({
      name: name.replace(/^origin\//, ""),
      current: !isRemote && name === current,
      remote: isRemote,
      upstream: upstream !== undefined && upstream.length > 0 ? upstream : null,
      counts: countsFor,
      // `>` means "you are ahead here"; `gone` means the upstream was deleted.
      hasUnmergedWork: trackshort !== undefined && (trackshort.startsWith(">") || trackshort === "gone"),
    });
  });
  return out;
}

/** Ahead/behind between a branch and its named upstream. */
async function aheadBehindNamed(repoPath: string, branch: string, upstream: string): Promise<AheadBehind | null> {
  const res = await runGit(
    ["-C", repoPath, "rev-list", "--left-right", "--count", `${upstream}...${branch}`],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS },
  );
  if (res.exitCode !== 0) return null;
  const m = res.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (m === null) return null;
  // Left is the upstream, so its count is "behind"; right is the branch, "ahead".
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

/**
 * The branch HEAD points at, or null when it is detached.
 *
 * Exported because "which branch am I on" is a question every switch, create,
 * rename, and delete has to be able to answer, and `symbolic-ref` is the only
 * honest way to get it: `git branch --show-current` prints an empty line when
 * detached, which looks like a branch with no name.
 */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const res = await runGit(["-C", repoPath, "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoPath });
  return res.exitCode === 0 && res.stdout.trim().length > 0 ? res.stdout.trim() : null;
}

export async function isDetached(repoPath: string): Promise<boolean> {
  return (await currentBranch(repoPath)) === null;
}

/**
 * A branch operation's result. It carries `GitRun`'s fields for the same reason
 * `RemoteResult` does: a switch or a delete can be journalled by `journaled()`
 * without an adapter that would have to invent a command string.
 */
export interface BranchOk extends GitRun {
  ok: true;
  output: string;
  changed: boolean;
  /** The branch that is current afterwards, which after a switch is the point. */
  nowOn: string | null;
}

export interface BranchError extends GitRun {
  ok: false;
  output: string;
  code: string;
}

export type BranchResult = BranchOk | BranchError;

/**
 * Create a branch and switch to it.
 *
 * `--create` on `git switch` creates and switches in one step, which is the
 * whole point of doing it: the alternative is two commands between which the
 * user would be on the old branch if one failed.
 */
export async function createBranch(repoPath: string, name: string, from?: string): Promise<BranchResult> {
  const args = ["-C", repoPath, "switch", "-c", name];
  if (from !== undefined) args.push(from);
  const res = await runGit(args, { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return {
    ...res,
    ok: true,
    output: res.stdout.trim(),
    changed: true,
    // Confirm what happened from git rather than assuming: the new branch is
    // now current by construction, but reading it back is cheaper to reason
    // about than a variable that happens to be right.
    nowOn: await currentBranch(repoPath),
  };
}

/** Switch to an existing branch. */
export async function switchBranch(repoPath: string, name: string): Promise<BranchResult> {
  // `--quiet` because git otherwise prints "Your branch is up to date" in a
  // hurry to be helpful, which is three messages per switch in the journal.
  const res = await runGit(["-C", repoPath, "switch", "--quiet", name], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), changed: true, nowOn: await currentBranch(repoPath) };
}

/**
 * Adopt a remote branch as a local one. This is what a user expects from
 * double-clicking `origin/feature` — "give me that here" — not a detached
 * checkout of a remote tip they cannot commit to.
 */
export async function trackRemoteBranch(repoPath: string, name: string): Promise<BranchResult> {
  const res = await runGit(["-C", repoPath, "switch", "--quiet", "-c", name, "--track", `origin/${name}`], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS,
  });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), changed: true, nowOn: await currentBranch(repoPath) };
}

/**
 * Delete a branch.
 *
 * `--force` is asked for explicitly and never assumed: an unmerged branch is a
 * branch with commits nothing else has, and deleting it silently would be
 * catastrophic rather than merely rude. `-D` is also what catches a branch with
 * work on it, and the card it produces is the honest explanation.
 */
export async function deleteBranch(repoPath: string, name: string): Promise<BranchResult> {
  const res = await runGit(["-C", repoPath, "branch", "-d", name], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), changed: true, nowOn: await currentBranch(repoPath) };
}

/** Delete a branch whether or not its work has landed. */
export async function forceDeleteBranch(repoPath: string, name: string): Promise<BranchResult> {
  const res = await runGit(["-C", repoPath, "branch", "-D", name], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), changed: true, nowOn: await currentBranch(repoPath) };
}

/** Rename the current branch. */
export async function renameBranch(repoPath: string, name: string): Promise<BranchResult> {
  const res = await runGit(["-C", repoPath, "branch", "-m", name], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), changed: true, nowOn: await currentBranch(repoPath) };
}

/** Whether a branch of this name already exists. */
export async function branchExists(repoPath: string, name: string): Promise<boolean> {
  const res = await runGit(["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: repoPath,
  });
  return res.exitCode === 0;
}

function fail(res: GitRun): BranchResult {
  return {
    ...res,
    ok: false,
    output: `${res.stdout}\n${res.stderr}`.trim(),
    code: "git-error",
  };
}

/** The ahead/behind of every local branch against its own upstream, in one
 *  pass. Used by the repository list, where 30 repositories each showing
 *  numbers is a lot of numbers to call "at a glance". */
export async function branchCounts(repoPath: string): Promise<Map<string, AheadBehind>> {
  const branches = await listBranches(repoPath);
  const out = new Map<string, AheadBehind>();
  for (const branch of branches) {
    if (branch.remote || branch.counts === null) continue;
    out.set(branch.name, branch.counts);
  }
  return out;
}
