import { readJson, writeJson } from "./appdata.js";

/**
 * A local record of the errors a user actually hit, and which fix they chose.
 *
 * This is not analytics and nothing here leaves the machine. It exists so the
 * interface can show "this has failed three times and switching to HTTPS
 * worked once" instead of offering the same three buttons every time, and so
 * a developer can look at their own history when git misbehaves.
 *
 * Discipline matches the journal and snapshots: reads never throw, so a
 * missing or corrupt file is simply an empty history, and writes are
 * best-effort because a read-only home folder must degrade to memory rather
 * than break an action that already succeeded.
 */

export const MAX_HISTORY_ENTRIES = 500;

/** What the translator produced, plus the command that produced it. */
export interface ErrorRecord {
  id: string;
  at: string;
  repoPath: string | null;
  /** The `ForgeError.code` the rule matched, or `git-error` when none did. */
  code: string;
  /** The exact argv, so the record is reproducible. */
  command: string;
  /** The fix ids offered, in the order the card showed them. */
  offered: string[];
  /** The fix the user picked, or null if they dismissed the card. */
  chosen: string | null;
  /** Whether the chosen fix's action then succeeded. Unknown until it runs. */
  outcome: "pending" | "worked" | "failed" | "dismissed";
}

const FILE = "error-history.json";

interface ErrorHistoryFile {
  version: 1;
  entries: ErrorRecord[];
}

export async function readErrorHistory(): Promise<ErrorRecord[]> {
  const parsed = await readJson<ErrorHistoryFile>(FILE);
  if (parsed === undefined || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
  return parsed.entries;
}

async function writeHistory(entries: ErrorRecord[]): Promise<void> {
  await writeJson(FILE, { version: 1, entries: entries.slice(-MAX_HISTORY_ENTRIES) });
}

let counter = 0;
function makeId(at: Date): string {
  counter += 1;
  return `err-${at.getTime().toString(36)}-${counter.toString(36)}`;
}

/** Record that an error card was shown. Returns the record so the caller can
 *  later say which fix was chosen and whether it worked. */
export async function recordErrorShown(entry: {
  repoPath: string | null;
  code: string;
  command: string;
  offered: string[];
}): Promise<ErrorRecord> {
  const at = new Date();
  const record: ErrorRecord = {
    id: makeId(at),
    at: at.toISOString(),
    repoPath: entry.repoPath,
    code: entry.code,
    command: entry.command,
    offered: entry.offered,
    chosen: null,
    outcome: "pending",
  };
  const entries = await readErrorHistory();
  entries.push(record);
  await writeHistory(entries);
  return record;
}

/** Attach the fix the user chose to a record. */
export async function recordFixChosen(id: string, fixId: string): Promise<ErrorRecord | null> {
  const entries = await readErrorHistory();
  const found = entries.find((e) => e.id === id);
  if (found === undefined) return null;
  found.chosen = fixId;
  found.outcome = "pending";
  await writeHistory(entries);
  return found;
}

/** Attach whether the chosen fix worked, which is the only part of this
 *  history that can tell a person which button to trust. */
export async function recordFixOutcome(id: string, outcome: "worked" | "failed"): Promise<ErrorRecord | null> {
  const entries = await readErrorHistory();
  const found = entries.find((e) => e.id === id);
  if (found === undefined) return null;
  if (found.outcome === "dismissed") return found;
  found.outcome = outcome;
  await writeHistory(entries);
  return found;
}

/** The user closed the card without trying anything. */
export async function recordFixDismissed(id: string): Promise<ErrorRecord | null> {
  const entries = await readErrorHistory();
  const found = entries.find((e) => e.id === id);
  if (found === undefined) return null;
  found.outcome = "dismissed";
  found.chosen ??= null;
  await writeHistory(entries);
  return found;
}

/** How often each fix has been tried for a given error code, and how often it
 *  worked. This is what makes a card able to put the reliably-working button
 *  first. */
export async function fixScorecard(code: string): Promise<Array<{ fixId: string; tried: number; worked: number }>> {
  const tried = new Map<string, { tried: number; worked: number }>();
  for (const entry of await readErrorHistory()) {
    if (entry.code !== code || entry.chosen === null) continue;
    const seen = tried.get(entry.chosen) ?? { tried: 0, worked: 0 };
    seen.tried += 1;
    if (entry.outcome === "worked") seen.worked += 1;
    tried.set(entry.chosen, seen);
  }
  return [...tried.entries()].map(([fixId, s]) => ({ fixId, ...s }));
}
