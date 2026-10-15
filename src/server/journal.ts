import { readJson, writeJson } from "./appdata.js";
import { readRefs } from "./git/git.js";

/** A git run outcome, as `runGit` reports it. */
export interface GitRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

/** A single journal entry, in the shape the spec's §4 recovery contract
 *  requires: what changed, when, which repo, what git ran, and the refs
 *  before and after so Undo can put them back. */
export interface JournalRefs {
  /** Full SHA of HEAD, or null in an empty repo with no commit yet. */
  head: string | null;
  /** Branch name, or `HEAD` for a detached checkout. */
  branch: string | null;
  /** True when a stash existed, so Undo knows it must not clobber one. */
  hasStash: boolean;
}

/** How to reverse an action, recorded at write time by the code that knows
 *  what it just did. Deriving this later from the command string would be
 *  guesswork: `journaled` already knows the paths, the patch, and the refs,
 *  so it writes the plan down rather than leaving a parser to reconstruct it.
 *
 *  A missing plan means undo is not offered for that entry, which is the
 *  honest default for an action whose recovery has not been proven. */
export type UndoPlan =
  | { kind: "reset-soft"; head: string }
  | { kind: "restore-snapshot"; snapshotRef: string }
  | { kind: "unstage-paths"; paths: string[] }
  | { kind: "stage-paths"; paths: string[] }
  | { kind: "apply-patch"; patch: string; reverse: boolean };

export interface JournalEntry {
  id: string;
  repoPath: string;
  /** ISO timestamp. */
  at: string;
  /** Plain English, shown in the Undo timeline verbatim. */
  description: string;
  /** The git command that produced this entry, for "explain, don't hide". */
  command: string | null;
  refs: { before: JournalRefs; after: JournalRefs };
  /** Whether this entry can be undone locally. Entries that reached a
   *  remote cannot, and the timeline says so rather than offering a button. */
  undoable: boolean;
  /** One sentence saying why it cannot be undone, when `undoable` is false. */
  notUndoableReason?: string;
  /** The plan `POST /api/journal/:id/undo` executes. */
  undo?: UndoPlan;
  /** The snapshot taken before a risky action, so the timeline can name what
   *  would restore it. Only set for entries whose plan is a snapshot restore. */
  snapshotRef?: string;
}

const JOURNAL_FILE = "journal.json";

/** Newest first. Capped so a very long session cannot grow without bound;
 *  the cap is far above anything a human will scroll. */
const MAX_ENTRIES = 2000;

/** Read the journal. A missing, empty, or corrupt file reads as an empty
 *  journal rather than an error, so a damaged app-data folder degrades
 *  rather than breaks the timeline. */
export async function readJournal(): Promise<JournalEntry[]> {
  const raw = await readJson<{ entries?: unknown }>(JOURNAL_FILE);
  if (!raw || !Array.isArray(raw.entries)) return [];
  return (raw.entries as unknown[]).filter(
    (e): e is JournalEntry =>
      typeof e === "object" && e !== null && typeof (e as JournalEntry).id === "string",
  );
}

/** Append one entry, newest first, capped at MAX_ENTRIES. Never throws:
 *  storage is best-effort and the caller has already finished its git work. */
export async function appendJournal(entry: JournalEntry): Promise<void> {
  const entries = await readJournal();
  const next = [entry, ...entries].slice(0, MAX_ENTRIES);
  await writeJson(JOURNAL_FILE, { entries: next });
}

/** Stable enough for an id: time plus a slice of randomness. Not a security
 *  boundary — it only has to be unique within one journal. */
export function makeJournalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Run a mutating git call and journal it.
 *
 *  Refs are read first, the action runs, refs are read again, and only a
 *  success is recorded — a failed `git add` that changed nothing has no
 *  business appearing in the user's Undo timeline. The action's own error is
 *  returned untouched so the caller still answers the HTTP request exactly
 *  as it would have without journaling.
 *
 *  `undoable` defaults to true because every action Forgeline currently
 *  performs has a local reverse. Milestone 4's later slices narrow that per
 *  action as recovery tests pass; a remote-reaching action passes false. */
export async function journaled(
  repoPath: string,
  description: string,
  run: () => Promise<GitRun>,
  opts: {
    undoable?: boolean;
    notUndoableReason?: string;
    undo?: UndoPlan;
    snapshotRef?: string;
  } = {},
): Promise<GitRun> {
  const before = await readRefs(repoPath);
  const result = await run();
  // Even a failed action may have partly applied, so the after-refs are read
  // either way — they are what the entry records, not the exit code.
  const after = await readRefs(repoPath);
  if (result.exitCode !== 0) return result;
  await appendJournal({
    id: makeJournalId(),
    repoPath,
    at: new Date().toISOString(),
    description,
    command: result.command,
    refs: { before, after },
    undoable: opts.undoable ?? true,
    ...(opts.notUndoableReason !== undefined
      ? { notUndoableReason: opts.notUndoableReason }
      : {}),
    ...(opts.undo !== undefined ? { undo: opts.undo } : {}),
    ...(opts.snapshotRef !== undefined ? { snapshotRef: opts.snapshotRef } : {}),
  });
  return result;
}

/** Build the git command that executes an undo plan. Exported so the undo
 *  endpoint and the tests share one definition of "the reverse of this". */
export function undoCommand(plan: UndoPlan): string[] | null {
  switch (plan.kind) {
    case "reset-soft":
      return ["reset", "--soft", plan.head];
    case "restore-snapshot":
      return ["read-tree", "--reset", "-u", plan.snapshotRef];
    case "unstage-paths":
      return paths(["restore", "--staged"], plan.paths);
    case "stage-paths":
      return paths(["add"], plan.paths);
    case "apply-patch":
      return plan.reverse
        ? ["apply", "--reverse", "--cached", "-"]
        : ["apply", "--cached", "-"];
  }
}

/** Append `--` before an argument list that carries user-supplied paths, so
 *  a path that happens to start with a dash cannot be read as an option. */
function paths(command: string[], list: string[]): string[] {
  return [...command, "--", ...list];
}
