import { runGit, GIT_TIMEOUTS } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * History.
 *
 * `git log` is the one command whose output is *most* designed to be read and
 * *least* parseable, so this uses `--format` with a delimiter that cannot appear
 * in a commit message: the ASCII unit separator. Every field comes back in a
 * known position, which means a message containing "`" or a newline cannot shift
 * a column the way it would in a default log.
 */

const UNIT = "\u001f";

export interface CommitEntry {
  /** The full sha. Everything here refers to commits by this. */
  sha: string;
  /** The short sha, which is what a human types. */
  short: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, which the interface formats — not "3 days ago", because that
   *  number changes between when it was computed and when it was looked at. */
  date: string;
  /** The refs pointing here, already stripped of `refs/` and `HEAD ->`. */
  refs: string[];
  parents: string[];
  /** True when this is a merge — that is, when there is more than one parent. */
  isMerge: boolean;
}

export interface HistoryEntry extends CommitEntry {
  /** The zero-based row this commit occupies in the list, independent of sha. */
  row: number;
  /** How many further ancestors each parent column reaches, for drawing lanes.
   *  Not filled in by `readHistory` itself; `laneInfo` computes it. */
  lanes: number[] | null;
}

export interface ReadHistoryParams {
  repoPath: string;
  /** A starting ref: a branch, a sha, or `HEAD`. Defaults to all branches. */
  from?: string;
  limit?: number;
}

/** Read the log of every branch, newest first. */
export async function readHistory(repoPath: string, from?: string, limit = 200): Promise<HistoryEntry[]> {
  const format = [
    "%H", "%h", "%s", "%an", "%ae", "%aI", "%D", "%P",
  ].join(UNIT);
  const args = ["-C", repoPath, "log"];
  if (from !== undefined) {
    args.push(from);
  } else {
    // All branches, so the graph shows a branch that has no commits of its own
    // as the empty thing it is rather than hiding it.
    args.push("--all", "--date-order");
  }
  args.push(`--format=${UNIT}${format}`, `-n`, String(limit));

  const res = await runGit(args, { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 3 });
  if (res.exitCode !== 0) return [];

  // `--format` (not `--pretty`) prints one record per line with no leading
  // blank line and no trailing newline, and the format string starts with the
  // unit separator, so each record *is* one line prefixed by it. The subject is
  // the only field that can contain a newline, so a record is re-assembled
  // from the wrapped lines until the next record's separator appears.
  const out: HistoryEntry[] = [];
  const lines = res.stdout.split("\n");
  let row = 0;
  let pending: string | null = null;
  for (const line of lines) {
    if (line.startsWith(UNIT)) {
      if (pending !== null) {
        const entry = parseRecord(pending.slice(1));
        if (entry !== null) out.push({ ...entry, row, lanes: null });
        row += 1;
      }
      pending = line;
      continue;
    }
    // A continuation of the previous record's subject, kept rather than
    // dropped — a wrapped subject is still the subject.
    if (pending !== null) pending += `\n${line}`;
  }
  if (pending !== null) {
    const entry = parseRecord(pending.slice(1));
    if (entry !== null) out.push({ ...entry, row, lanes: null });
  }
  return out;
}

export function parseRecord(record: string): CommitEntry | null {
  const parts = record.split(UNIT);
  if (parts.length < 8) return null;
  const [sha, short, subject, authorName, authorEmail, date, refNames, parents] = parts;
  if (sha === undefined || sha.length === 0) return null;

  const refs: string[] = [];
  for (const token of (refNames ?? "").split(", ").map((t) => t.trim())) {
    if (token.length === 0) continue;
    // `HEAD -> main, origin/main` must not leave a bare "HEAD" in the list:
    // the user wants where the branch points, and the arrow is decoration.
    const cleaned = token.replace(/^HEAD ->\s*/, "").replace(/^HEAD$/, "").trim();
    if (cleaned.length > 0 && !refs.includes(cleaned)) refs.push(cleaned);
  }

  return {
    sha,
    short: short ?? "",
    subject: subject ?? "",
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    date: date ?? "",
    refs,
    parents: (parents ?? "").split(" ").filter((p) => p.length > 0),
    isMerge: (parents ?? "").split(" ").filter((p) => p.length > 0).length > 1,
  };
}

/** One commit, for the blame header and the detail line. */
export async function readCommit(repoPath: string, sha: string): Promise<CommitEntry | null> {
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%D", "%P", "%b"].join(UNIT);
  const res = await runGit(["-C", repoPath, "show", "-s", `--format=${format}`, sha], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS,
  });
  if (res.exitCode !== 0) return null;
  // The body follows the record after a blank line, so it is split off rather
  // than left in the subject.
  const [first] = res.stdout.split("\n\n");
  const entry = parseRecord((first ?? "").replace(/^\n/, ""));
  if (entry === null) return null;
  return entry;
}

/** The author and message of the commit that changed a line last. */
export interface BlameEntry {
  line: number;
  sha: string;
  short: string;
  authorName: string;
  date: string;
  subject: string;
}

/**
 * Blame a file, one entry per line.
 *
 * `git blame --porcelain` rather than the default human format, because the
 * default wraps, quotes, and abbreviates in ways that change with terminal
 * width, while porcelain has a stable grammar: a header line per line, then the
 * content.
 */
export interface BlameResult {
  ok: boolean;
  lines: BlameEntry[];
  /** Present when git refused, so the translator can build a real card rather
   *  than an empty list that looks like "no history". */
  failure?: { output: string; command: string };
}

export async function blameFile(repoPath: string, path: string): Promise<BlameResult> {
  const res = await runGit(["-C", repoPath, "blame", "--porcelain", "--", path], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 5,
  });
  if (res.exitCode !== 0) {
    // `fatal: no such path 'x' in HEAD` exits 128. Returning an empty list here
    // would tell the user "this file has no history", which is a different
    // statement from "there is no such file", and the second is the one that
    // is true. The failure is passed through instead of being flattened into
    // a success with nothing in it.
    return {
      ok: false,
      lines: [],
      failure: { output: `${res.stdout}\n${res.stderr}`.trim(), command: res.command },
    };
  }

  const meta = new Map<string, { author: string; authorTime: string; subject: string }>();
  const out: BlameEntry[] = [];
  let lineNumber = 0;
  let current: BlameEntry | null = null;

  for (const raw of res.stdout.split("\n")) {
    const header = raw.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?/);
    if (header !== null) {
      const rawSha = header[1] ?? "";
      const known = meta.get(rawSha);
      lineNumber += 1;
      current = {
        line: Number(header[3] ?? lineNumber),
        sha: rawSha,
        short: rawSha.slice(0, 9),
        authorName: known?.author ?? "",
        date: known?.authorTime ?? "",
        subject: known?.subject ?? "",
      };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    const author = raw.match(/^author (.+)$/);
    if (author !== null) {
      current.authorName = author[1] ?? "";
      continue;
    }
    const authorTime = raw.match(/^author-time (\d+)$/);
    if (authorTime !== null) {
      // Unix seconds are turned into a date here rather than in the interface,
      // because the interface already knows how to format one.
      current.date = new Date(Number(authorTime[1]) * 1000).toISOString();
      continue;
    }
    const summary = raw.match(/^summary (.+)$/);
    if (summary !== null) {
      current.subject = summary[1] ?? "";
      meta.set(current.sha, { author: current.authorName, authorTime: current.date, subject: summary[1] ?? "" });
      // The content line follows the header and carries the text prefixed by a
      // tab; it is skipped because the interface shows the file itself.
      continue;
    }
  }
  return { ok: true, lines: out };
}

/** The lane layout for drawing a graph. */
export interface LaneState {
  /** Which lane each row's commits occupy, one per parent. */
  row: number;
  sha: string;
  /** The lane column this commit's first parent continues in. */
  lane: number;
  /** One entry per commit shown, so the renderer can draw lines per row. */
  total: number;
}

export type FileHistoryResult =
  | (GitRun & { ok: true; commits: CommitEntry[] })
  | (GitRun & { ok: false; output: string; code: string });

/** Every commit that touched a file, newest first. */
export async function fileHistory(repoPath: string, path: string, limit = 100): Promise<FileHistoryResult> {
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%D", "%P"].join(UNIT);
  const res = await runGit(
    ["-C", repoPath, "log", "-n", String(limit), `--format=${UNIT}${format}`, "--follow", "--", path],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.IMPATIENCE_MS * 2 },
  );
  if (res.exitCode !== 0) return fail(res);
  // Same re-assembly as `readHistory`: one line per record, prefixed by the
  // separator, with a wrapped subject continued on the lines that follow.
  const commits: CommitEntry[] = [];
  let pending: string | null = null;
  const flush = (pendingRecord: string | null): void => {
    if (pendingRecord === null) return;
    const entry = parseRecord(pendingRecord.slice(1));
    if (entry !== null) commits.push(entry);
  };
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith(UNIT)) {
      flush(pending);
      pending = line;
      continue;
    }
    if (pending !== null) pending += `\n${line}`;
  }
  flush(pending);
  return { ...res, ok: true, commits };
}

function fail(res: GitRun): FileHistoryResult {
  return { ...res, ok: false, output: `${res.stdout}\n${res.stderr}`.trim(), code: "git-error" };
}
