/** Client for the Milestone 3 stage/unstage endpoints. Every call sends an
 *  opaque repo ID (never a raw path) and lets the server validate the path
 *  against the registry before git runs. */
/** A failed action as the server reports it. The error translator fills in
 *  the whole card, so a failure is not just a title — it carries the plain
 *  English, the fix buttons it warrants, and the raw output behind a toggle. */
export interface ErrorFix {
  id: string;
  label: string;
}

export interface ActionError {
  ok: false;
  code: string;
  title: string;
  explanation?: string;
  fixes?: ErrorFix[];
  raw?: string;
  command?: string;
}

export type StageResult = { ok: true } | ActionError;

/** Pull the card out of a failure response. The server always sends one, but
 *  a network error or an unexpected shape must not crash the interface, so
 *  every field falls back. */
function readError(res: Response, parsed: Record<string, unknown>): ActionError {
  const fixes = Array.isArray(parsed.fixes)
    ? parsed.fixes
        .filter(
          (f): f is { id: string; label: string } =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as ErrorFix).id === "string" &&
            typeof (f as ErrorFix).label === "string",
        )
        .map((f) => ({ id: f.id, label: f.label }))
    : [];
  return {
    ok: false,
    code: typeof parsed.code === "string" ? parsed.code : `http-${res.status}`,
    title: typeof parsed.title === "string" ? parsed.title : `HTTP ${res.status}`,
    ...(typeof parsed.explanation === "string" && parsed.explanation.length > 0
      ? { explanation: parsed.explanation }
      : {}),
    ...(fixes.length > 0 ? { fixes } : {}),
    ...(typeof parsed.raw === "string" && parsed.raw.length > 0 ? { raw: parsed.raw } : {}),
    ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
  };
}

/** Shared transport for the action endpoints. */
async function actionJson(path: string, body: unknown): Promise<StageResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return readError(res, parsed);
  return { ok: true };
}

/** Stage whole files: `git add -- <paths>`. */
export async function stageFiles(
  repoId: string,
  paths: string[],
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/stage`, { paths });
}

/** Unstage whole files: `git restore --staged -- <paths>`. */
export async function unstageFiles(
  repoId: string,
  paths: string[],
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/unstage`, { paths });
}

/** Stage a single hunk: `git apply --cached -` with the patch on stdin. */
export async function stageHunk(
  repoId: string,
  path: string,
  patch: string,
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/stage-hunk`, {
    path,
    patch,
  });
}

/** Unstage a single hunk: `git apply --reverse --cached -` with the patch on stdin. */
export async function unstageHunk(
  repoId: string,
  path: string,
  patch: string,
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/unstage-hunk`, {
    path,
    patch,
  });
}

/** Commit the staged changes: `git commit -m <message>`. */
export async function commit(
  repoId: string,
  message: string,
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/commit`, {
    message,
  });
}

/** Discard local changes in the given files. The server snapshots BEFORE it
 *  throws anything away, and returns the ref so the caller can say exactly
 *  what would come back. */
export type DiscardResult = StageResult & { snapshotRef?: string };

export async function discardFiles(
  repoId: string,
  paths: string[],
): Promise<DiscardResult> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const parsed = (await res
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return readError(res, parsed);
  return {
    ok: true,
    ...(typeof parsed.snapshotRef === "string" ? { snapshotRef: parsed.snapshotRef } : {}),
  };
}

/** Rescue mode: snapshot, park HEAD under a private backup ref, reset hard. */
export type RescueResult = StageResult & { snapshotRef?: string; backupRef?: string };

export async function rescueRepo(repoId: string): Promise<RescueResult> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/rescue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const parsed = (await res
    .json()
    .catch(() => ({}))) as {
    code?: string;
    title?: string;
    snapshotRef?: string;
    backupRef?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      code: parsed.code ?? `http-${res.status}`,
      title: parsed.title ?? `HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    snapshotRef: parsed.snapshotRef,
    backupRef: parsed.backupRef,
  };
}

/** One journal entry, in the Undo timeline. */
export interface JournalEntry {
  id: string;
  repoPath: string;
  at: string;
  description: string;
  command: string | null;
  refs: {
    before: { head: string | null; branch: string | null; hasStash: boolean };
    after: { head: string | null; branch: string | null; hasStash: boolean };
  };
  undoable: boolean;
  notUndoableReason?: string;
  snapshotRef?: string;
}

/** The journal, newest first. */
export async function fetchJournal(): Promise<JournalEntry[]> {
  const res = await fetch("/api/journal", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: unknown };
  if (!Array.isArray(body.entries)) return [];
  return body.entries as JournalEntry[];
}

/** Undo one journal entry. The server snapshots first and journals the undo. */
export async function undoEntry(id: string): Promise<StageResult> {
  const res = await fetch(`/api/journal/${encodeURIComponent(id)}/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as {
      code?: string;
      title?: string;
    };
    return {
      ok: false,
      code: parsed.code ?? `http-${res.status}`,
      title: parsed.title ?? `HTTP ${res.status}`,
    };
  }
  return { ok: true };
}

/** Changed-file records for a repo, staged and unstaged together. */
/** ---- error fixes (Milestone 5). Every one is a real action; a fix whose
 *  feature does not exist has no client call, so the card cannot offer it. ---- */

/** Initialise a folder that has no git yet. */
export async function initRepo(repoId: string): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/init`, {});
}

/** Set the identity git writes into every commit. */
export async function setIdentity(
  repoId: string,
  name: string,
  email: string,
): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/identity`, { name, email });
}

/** Abandon a merge in progress. Takes a snapshot server-side, always. */
export async function abortMerge(repoId: string): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/abort-merge`, {});
}

/** Remove a stale index.lock. Refuses without confirmation, so the caller
 *  has to have asked the user first. */
export async function removeLock(repoId: string): Promise<StageResult> {
  return actionJson(`/api/repos/${encodeURIComponent(repoId)}/remove-lock`, {
    confirmed: true,
  });
}

/** Whether a git process is still writing to this repository. Read-only, so
 *  it is safe to call before deciding a lock is stale. */
export async function checkGitProcesses(
  repoId: string,
): Promise<{ running: string[]; title: string }> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/git-processes`);
  return (await res.json()) as { running: string[]; title: string };
}

/** Record that a card was shown and which fixes it offered. */
export async function recordErrorShown(
  repoId: string | null,
  error: ActionError,
): Promise<string | null> {
  try {
    const res = await fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoPath: repoId,
        code: error.code,
        command: error.command ?? "",
        offered: (error.fixes ?? []).map((f) => f.id),
      }),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { id?: string };
    return parsed.id ?? null;
  } catch {
    // A failed history write must never make an already-failed action worse.
    return null;
  }
}

/** Record which fix was tried and whether it worked. */
export async function recordFixOutcome(
  errorId: string | null,
  fixId: string,
  worked: boolean,
): Promise<void> {
  if (errorId === null) return;
  try {
    await fetch(`/api/errors/${encodeURIComponent(errorId)}/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fix: fixId, worked }),
    });
  } catch {
    // Same rule: history is a nicety, never a source of failure.
  }
}

export interface ChangeFile {
  path: string;
  originalPath?: string;
  letter: "M" | "A" | "D" | "R" | "C" | "T" | "U";
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

/** Fetch the changed files for a repo. */
export async function fetchChanges(repoId: string): Promise<ChangeFile[]> {
  const res = await fetch(
    `/api/repos/${encodeURIComponent(repoId)}/changes`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) return [];
  return body.files as ChangeFile[];
}

/** Diff for one file: worktree vs index by default, index vs HEAD when staged. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  binary: boolean;
  conflicted: boolean;
}

export async function fetchDiff(
  repoId: string,
  path: string,
  staged: boolean,
): Promise<FileDiff> {
  const res = await fetch(
    `/api/repos/${encodeURIComponent(repoId)}/diff?path=${encodeURIComponent(path)}&staged=${staged}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FileDiff;
}

/** Turn a parsed diff hunk back into a minimal unified-diff patch that
 *  `git apply --cached` (or --reverse --cached) can consume. Context lines
 *  are included so git can locate the hunk in the index; the no-EOL marker
 *  follows the line it qualifies. */
export function hunkToPatch(
  path: string,
  hunk: { header: string; lines: DiffLine[] },
): string {
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push(`--- a/${path}`);
  out.push(`+++ b/${path}`);
  out.push(hunk.header);
  for (const line of hunk.lines) {
    const prefix =
      line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    out.push(`${prefix}${line.text}`);
    if (line.noEol) out.push("\\ No newline at end of file");
  }
  return out.join("\n") + "\n";
}

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noEol: boolean;
}
