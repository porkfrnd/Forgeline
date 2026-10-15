import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git/git.js";

/** A snapshot of a repository's working tree and index, taken before a risky
 *  action runs.
 *
 *  The spec's mechanism, followed exactly: a *temporary* index, so the
 *  user's real index is never touched while the snapshot is built. Starting
 *  the temp index from HEAD and then adding the whole worktree makes the
 *  written tree a faithful picture of the working tree at that instant,
 *  including untracked files. Ignored files are excluded because that is
 *  what `git add -A` means by default.
 *
 *  Two refs are written: `refs/forgeline/snapshots/<timestamp>` for the
 *  working tree and `refs/forgeline/snapshots/<timestamp>.index` for the
 *  real index, so a restore can put back both the files and the staged
 *  state rather than flattening the user's distinction between them.
 *
 *  They are private refs, so they never appear in the user's normal stash
 *  list — a snapshot that shows up in `git stash list` is a bug, not a
 *  feature. */
export interface Snapshot {
  /** The private ref the snapshot lives under. */
  ref: string;
  /** The snapshot commit, or null when git refused to create one. */
  commit: string | null;
  /** Tree of the working tree including untracked files. */
  worktreeTree: string | null;
  /** Tree of the real index, so the staged state can be put back. Null when
   *  the index was mid-merge, because writing-tree fails on a conflicted
   *  index and a half snapshot would be worse than none. */
  indexTree: string | null;
  branch: string | null;
  head: string | null;
}

/** Snapshot the working tree and index of a repo. Never throws: a repo with
 *  no commits yet has no HEAD to start from, and that is reported as nulls
 *  rather than an error, because "nothing to lose yet" is a real state. */
export async function takeSnapshot(repoPath: string): Promise<Snapshot> {
  const ref = snapshotRef();
  const before = await readHead(repoPath);
  const tempIndex = join(mkdtempSync(join(tmpdir(), "fl-snap-")), "index");

  // 1. A temporary index starting from HEAD, so the written tree is complete
  //    even when the real index is empty or mid-conflict.
  let worktreeTree: string | null = null;
  const readTree = await runGit(
    ["-C", repoPath, "read-tree", "HEAD"],
    { cwd: repoPath, env: { GIT_INDEX_FILE: tempIndex } },
  );
  if (readTree.exitCode === 0) {
    const add = await runGit(["add", "-A"], {
      cwd: repoPath,
      env: { GIT_INDEX_FILE: tempIndex },
    });
    if (add.exitCode === 0) {
      const write = await runGit(["write-tree"], {
        cwd: repoPath,
        env: { GIT_INDEX_FILE: tempIndex },
      });
      if (write.exitCode === 0) worktreeTree = write.stdout.trim();
    }
  }

  // 2. The real index, when it has no conflicts, so the staged state can be
  //    restored exactly rather than only approximately.
  const realIndex = await runGit(["write-tree"], { cwd: repoPath });
  const indexTree = realIndex.exitCode === 0 ? realIndex.stdout.trim() : null;

  // 3. A commit pointing at the working tree, then the private ref.
  let commit: string | null = null;
  if (worktreeTree !== null) {
    const tree = await runGit(
      ["-C", repoPath, "commit-tree", worktreeTree, "-m", "Forgeline snapshot"],
      { cwd: repoPath },
    );
    if (tree.exitCode === 0) commit = tree.stdout.trim();
  }

  rmSync(join(tempIndex, ".."), { recursive: true, force: true });

  if (commit !== null) {
    await runGit(["update-ref", ref, commit], { cwd: repoPath });
  }
  // The real index gets its own private ref. Reading the worktree tree back
  // would give the *files* but would quietly stage anything that was
  // untracked when the snapshot was taken, so the staged state is recorded
  // separately and restored after the worktree, without touching files.
  if (indexTree !== null) {
    await runGit(["update-ref", `${ref}.index`, indexTree], { cwd: repoPath });
  }

  return {
    ref,
    commit,
    worktreeTree,
    indexTree,
    branch: before.branch,
    head: before.head,
  };
}

/** Every snapshot ref in a repo, newest first. */
export async function listSnapshots(repoPath: string): Promise<Snapshot[]> {
  const res = await runGit(
    [
      "-C",
      repoPath,
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/forgeline/snapshots/",
    ],
    { cwd: repoPath },
  );
  if (res.exitCode !== 0) return [];
  const out: Snapshot[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [ref, commit] = line.split("\0");
    if (ref === undefined || commit === undefined) continue;
    out.push({
      ref,
      commit,
      worktreeTree: null,
      indexTree: null,
      branch: null,
      head: null,
    });
  }
  // for-each-ref is oldest first; the timeline wants newest first.
  return out.reverse();
}

/** Restore a snapshot into the current repo.
 *
 *  Two trees, restored in a deliberate order. First the working-tree tree,
 *  with `-u` so the files themselves come back — that is what the user
 *  actually lost. Then the index tree, without `-u`, so what was *staged*
 *  before the action is staged again rather than everything looking staged.
 *
 *  Reading only the worktree tree would restore every file but flatten the
 *  staged/unstaged distinction the user had set up, which for a snapshot
 *  named "before my risky action" is a silent change to their state. */
export async function restoreSnapshot(repoPath: string, ref: string): Promise<boolean> {
  const valid = /^refs\/forgeline\/snapshots\/\d+(\.index)?$/.test(ref);
  if (!valid) return false;
  const isIndex = ref.endsWith(".index");
  const base = isIndex ? ref.slice(0, -".index".length) : ref;

  const worktree = await runGit(["read-tree", "--reset", "-u", base], { cwd: repoPath });
  if (worktree.exitCode !== 0) return false;

  // The index ref is best-effort: a snapshot taken mid-merge has none, and
  // the files are still restored, so a missing one must not fail the restore.
  const index = await runGit(["read-tree", `${base}.index`], { cwd: repoPath });
  return index.exitCode === 0 || worktree.exitCode === 0;
}

/** Retention, exactly as the spec defines it: a snapshot is deleted only when
 *  it is older than 30 days AND it is not among the latest 50. Both conditions
 *  must hold, so a burst of 100 snapshots today keeps the newest 50 no matter
 *  how young they are. */
export async function pruneSnapshots(
  repoPath: string,
  now: Date = new Date(),
): Promise<{ removed: string[]; kept: string[] }> {
  const refs = await listSnapshots(repoPath);
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [i, snap] of refs.entries()) {
    const stamp = Number((snap.ref.split("/").pop() ?? "").match(/^(\d+)$/)?.[1] ?? "0");
    const isLatest50 = i < 50;
    const isOlderThan30Days = stamp > 0 && stamp < cutoff;
    if (isOlderThan30Days && !isLatest50) {
      await runGit(["update-ref", "-d", snap.ref], { cwd: repoPath });
      removed.push(snap.ref);
    } else {
      kept.push(snap.ref);
    }
  }
  return { removed, kept };
}

/** Build a private snapshot ref name from a timestamp. */
export function snapshotRef(at: Date = new Date()): string {
  return `refs/forgeline/snapshots/${at.getTime()}`;
}

async function readHead(repoPath: string): Promise<{ head: string | null; branch: string | null }> {
  const head = await runGit(["-C", repoPath, "rev-parse", "HEAD"], { cwd: repoPath });
  const branch = await runGit(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
  });
  return {
    head: head.exitCode === 0 && head.stdout.trim().length > 0 ? head.stdout.trim() : null,
    branch: branch.exitCode === 0 && branch.stdout.trim().length > 0 ? branch.stdout.trim() : null,
  };
}
