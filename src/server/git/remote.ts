import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";
import type { AheadBehind } from "./git.js";

/**
 * Fetch, pull, and push — every operation here talks to a remote, so it gets
 * the long timeout rather than the 15-second local one.
 *
 * Two rules hold throughout:
 *
 *  - **Nothing goes in a URL or an argument.** A remote URL can end up in a
 *    shell history, a CI log, a process listing, or `.git/config` where a
 *    token would be visible to anything that can read the file. Credentials
 *    travel through `GIT_ASKPASS` only, which the caller sets.
 *  - **The result is what git actually did, not what we hoped.** `fetch` and
 *    `pull` report whether anything changed and what the state is now, so the
 *    workbench can say "3 commits arrived" rather than "ok".
 */

export interface RemoteEntry {
  name: string;
  /** Fetch URL. */
  fetch: string;
  /** Push URL, which git allows to differ from the fetch one. */
  push: string;
}

/** The remotes a repository has, in git's own order. */
export async function listRemotes(repoPath: string): Promise<RemoteEntry[]> {
  const res = await runGit(["-C", repoPath, "remote", "-v"], { cwd: repoPath });
  if (res.exitCode !== 0) return [];
  const out: RemoteEntry[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m === null) continue;
    const [, name, url, kind] = m;
    const existing = out.find((r) => r.name === name);
    if (existing === undefined) {
      out.push({
        name,
        fetch: kind === "fetch" ? url : "",
        push: kind === "push" ? url : "",
      });
      continue;
    }
    if (kind === "fetch") existing.fetch = url;
    else existing.push = url;
  }
  return out;
}

/** Whether a repository has any remote at all, which decides whether the
 *  fetch and pull actions have anything to talk to. */
export async function hasRemote(repoPath: string): Promise<boolean> {
  return (await listRemotes(repoPath)).length > 0;
}

/**
 * A remote outcome. It carries `GitRun`'s fields so a result can be handed
 * straight to `journaled`, which is what lets fetch, pull, and push be
 * journalled without an adapter that would have to invent a command string.
 * `output` is both streams combined and trimmed, which is what the error
 * translator wants and what a card shows.
 */
export interface RemoteOk extends GitRun {
  ok: true;
  /** Both streams, trimmed. Never contains a credential. */
  output: string;
  /** True when the operation materially changed a ref. */
  changed: boolean;
}

export interface RemoteError extends GitRun {
  ok: false;
  output: string;
  code: string;
}

export type RemoteResult = RemoteOk | RemoteError;

/** A fingerprint of every branch and remote-tracking ref.
 *
 *  `git fetch` against a local bare remote prints NOTHING even when refs
 *  moved, and `git push` prints "Everything up-to-date" for a no-op while
 *  "Already up to date." is printed for a pull that also did nothing — so
 *  "did anything change" cannot be read out of git's chatter at all. It has to
 *  be observed.
 *
 *  Both kinds of ref are fingerprinted: a fetch moves remote-tracking refs, a
 *  push moves them too (git updates origin/main on a successful push), and a
 *  pull additionally moves the local branch. */
async function refFingerprint(repoPath: string): Promise<string> {
  const res = await runGit(
    ["-C", repoPath, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"],
    { cwd: repoPath },
  );
  if (res.exitCode !== 0) return "";
  return res.stdout.trim().split("\n").sort().join("|");
}

/** Wrap a network operation: compare the remote refs either side of it, which
 *  is the only honest answer to "did this do anything". */
async function observe(repoPath: string, run: () => Promise<GitRun>): Promise<RemoteResult> {
  const before = await refFingerprint(repoPath);
  const res = await run();
  const output = `${res.stdout}\n${res.stderr}`.trim();
  if (res.exitCode !== 0) {
    return { ...res, ok: false, output, code: "remote-error" };
  }
  const after = await refFingerprint(repoPath);
  // Deliberately NOT trusting stdout: "Already up to date." is four words of
  // failure to be concise, and "Everything up-to-date" is three of them.
  return { ...res, ok: true, output, changed: before !== after };
}

/** Download refs and objects without touching the working tree. */
export async function fetchRepo(
  repoPath: string,
  opts: { remote?: string; prune?: boolean } = {},
): Promise<RemoteResult> {
  const args = ["-C", repoPath, "fetch"];
  if (opts.prune === true) args.push("--prune");
  if (opts.remote !== undefined) args.push(opts.remote);
  return observe(repoPath, () =>
    runGit(args, { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS }),
  );
}

/**
 * Fetch and integrate, merging.
 *
 * `--no-rebase` is deliberate, and required: git 2.34 and newer REFUSES a pull
 * when the two sides have diverged and no reconciliation mode has been chosen,
 * printing "You have divergent branches and need to specify how to reconcile
 * them" instead of doing anything. Merging is also the right default here —
 * the user pressed "Pull", not "Rebase" — and a merge leaves the same commits
 * visible where they were. A conflict stops the merge, which is exactly what
 * the caller needs to be shown.
 */
export async function pullRepo(
  repoPath: string,
  opts: { remote?: string } = {},
): Promise<RemoteResult> {
  const args = ["-C", repoPath, "pull", "--no-rebase", "--no-edit"];
  if (opts.remote !== undefined) args.push(opts.remote);
  return observe(repoPath, () =>
    runGit(args, { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS }),
  );
}

/**
 * Push the current branch. `setUpstream` publishes a branch that has never been
 * pushed, which is the only way a local-only branch gets to a remote at all.
 */
export async function pushRepo(
  repoPath: string,
  opts: { remote?: string; setUpstream?: boolean } = {},
): Promise<RemoteResult> {
  const args = ["-C", repoPath, "push"];
  if (opts.setUpstream === true) {
    // "--set-upstream" alone is refused: git wants to know WHICH remote to
    // publish to, and answering "origin HEAD" also avoids naming the branch.
    args.push("--set-upstream", "origin", "HEAD");
  } else if (opts.remote !== undefined) {
    args.push(opts.remote);
  }
  // No remote argument: git picks the default, which is how a repository with
  // no remote produces the honest "No configured push destination" rather
  // than a misleading one about 'origin'.
  return observe(repoPath, () =>
    runGit(args, { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS }),
  );
}

/** The current branch's position against its upstream, or null when there is
 *  no upstream to be ahead of or behind. */
export async function upstreamPosition(repoPath: string): Promise<AheadBehind | null> {
  const res = await runGit(["-C", repoPath, "rev-list", "--left-right", "--count", "@{u}...HEAD"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS,
  });
  if (res.exitCode !== 0) return null;
  const m = res.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (m === null) return null;
  return { ahead: Number(m[2]), behind: Number(m[1]) };
}
