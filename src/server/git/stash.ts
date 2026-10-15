import { runGit } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * Stash.
 *
 * `git stash` is a stack, which means it has to be listed in order — an index,
 * not a bag — and every action below is expressed against that index so that
 * "apply the older one" is a thing the interface can say and push.
 *
 * One choice runs through all of it: **a stash is never dropped without being
 * restored somewhere.** `apply` keeps the entry, `pop` removes it, and `drop` is
 * the only destructive one and is never called by a "save" path.
 */

export interface StashEntry {
  /** `refs/stash@{n}` — the full ref, which is what git takes back. */
  ref: string;
  /** The visible number, 0 being the most recent. */
  index: number;
  /** The message git records, which is either supplied or derived from the tip. */
  message: string;
  /** When it was made, as git reports it, in the user's own locale. */
  date: string;
  /** The short sha of the commit the stash was made on top of. */
  parent: string;
  /** git's own selector for this entry, e.g. `stash@{3}` — kept so ordering can
   *  be cross-checked against git rather than trusted from this list. */
  reflogSelector: string;
}

/** Every stash, newest first, which is the order `git stash list` already gives. */
export async function listStashes(repoPath: string): Promise<StashEntry[]> {
  const res = await runGit(
    ["-C", repoPath, "stash", "list", "--format=%H\t%gd\t%gs\t%ci"],
    { cwd: repoPath },
  );
  if (res.exitCode !== 0) return [];

  const lines = res.stdout.split("\n").filter((line) => line.length > 0);
  // The index is the position in this list, which is the order `git stash
  // list` already uses: newest first. Deriving it from the list rather than
  // parsing `stash@{n}` out of each message means the ref always agrees with
  // the position the user sees.
  return lines.map((line, i) => {
    const [parent, reflogSelector, message, date] = line.split("\t");
    return {
      ref: `refs/stash@{${i}}`,
      index: i,
      parent: parent.slice(0, 9),
      message: message ?? "",
      date: date ?? "",
      reflogSelector: reflogSelector ?? "",
    };
  });
}

export type StashResult =
  | (GitRun & { ok: true; output: string; created: string | null })
  | (GitRun & { ok: false; output: string; code: string });

/**
 * Save the working tree as a new stash.
 *
 * `push` is used rather than the bare `stash` command for one reason worth
 * more than the keystrokes: `git stash push -m "why"` takes a message, and an
 * unnamed stash is a stack of anonymous things by the time there are three of
 * them. The name is optional here, so the caller can leave the branch's own
 * message as the default.
 */
export async function saveStash(repoPath: string, message?: string): Promise<StashResult> {
  // The stack is counted before and after, and on purpose: see the comment
  // below. Two extra `git stash list` runs are the price of being told the
  // truth about a clean tree.
  const before = await listStashes(repoPath);
  const args = ["-C", repoPath, "stash", "push"];
  if (message !== undefined && message.trim().length > 0) args.push("-m", message.trim());
  const res = await runGit(args, { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);

  // **`git stash push` exits 0 on a clean tree.** It prints "No local changes to
  // save" and returns success, so a naive exit-code check reports a stash that
  // does not exist — and the user is told their work is safe when it was
  // already committed. The stack is counted, not trusted.
  const after = await listStashes(repoPath);
  if (after.length <= before.length) {
    return {
      ...res,
      ok: false,
      // The real git wording, so the translator can build a card from it
      // rather than a string invented here.
      output: "No local changes to save",
      code: "nothing-to-stash",
    };
  }
  return { ...res, ok: true, output: res.stdout.trim(), created: message ?? null };
}

/**
 * Put a stash back on the working tree and leave it in the stack.
 *
 * `apply` rather than `pop` for any undoable restore: after restoring, the
 * snapshot journal can still restore the working tree itself, and if the entry
 * is gone the user's only route back is the reflog.
 */
export async function applyStash(repoPath: string, ref?: string): Promise<StashResult> {
  const res = await runGit(
    ref === undefined ? ["-C", repoPath, "stash", "apply"] : ["-C", repoPath, "stash", "apply", ref],
    { cwd: repoPath },
  );
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), created: null };
}

/** Restore a stash and remove it from the stack in the same step. */
export async function popStash(repoPath: string, ref?: string): Promise<StashResult> {
  const res = await runGit(
    ref === undefined ? ["-C", repoPath, "stash", "pop"] : ["-C", repoPath, "stash", "pop", ref],
    { cwd: repoPath },
  );
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), created: null };
}

/** Remove a stash from the stack. The only destructive one. */
export async function dropStash(repoPath: string, ref: string): Promise<StashResult> {
  const res = await runGit(["-C", repoPath, "stash", "drop", ref], { cwd: repoPath });
  if (res.exitCode !== 0) return fail(res);
  return { ...res, ok: true, output: res.stdout.trim(), created: null };
}

/**
 * Whether there is anything to stash.
 *
 * `git status --porcelain` rather than `git diff --quiet`, because `--quiet`
 * only answers for *tracked* files and an untracked file is exactly the thing a
 * user means by "this isn't saved".
 */
export async function hasChanges(repoPath: string): Promise<boolean> {
  const res = await runGit(["-C", repoPath, "status", "--porcelain"], { cwd: repoPath });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

function fail(res: GitRun): StashResult {
  return { ...res, ok: false, output: `${res.stdout}\n${res.stderr}`.trim(), code: "git-error" };
}
