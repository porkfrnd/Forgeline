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

/** One path under `/api/repos/<id>/…`. Every repo-scoped call goes through
 *  here, so the encodeURIComponent never gets forgotten in a new one. */
function repoEndpoint(repoId: string, tail: string): string {
  return `/api/repos/${encodeURIComponent(repoId)}/${tail}`;
}

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noEol: boolean;
}

/** A remote, as `git remote -v` describes it. */
export interface RemoteInfo {
  name: string;
  fetch: string;
  push: string;
}

/** The remotes a repository has. Empty is a normal state — a local repository
 *  with no remote is a perfectly good thing to be. */
export async function listRemotes(repoId: string): Promise<RemoteInfo[]> {
  const res = await fetch(`${repoEndpoint(repoId, "remotes")}`);
  const parsed = (await res.json().catch(() => ({}))) as { remotes?: RemoteInfo[] };
  return parsed.remotes ?? [];
}

/** What a fetch, pull, or push reported. `output` never contains a credential:
 *  git does not print the askpass answer, so nothing to strip. */
export interface RemoteOutcome {
  ok: true;
  /** True when refs actually moved. */
  changed: boolean;
  output: string;
  snapshot?: string;
}

/** Discriminate a translator error from a success, so callers get the narrow
 *  type rather than a cast. */
export function isActionError(v: unknown): v is ActionError {
  return typeof v === "object" && v !== null && (v as ActionError).ok === false;
}

export async function fetchRepo(
  repoId: string,
  opts: { remote?: string } = {},
): Promise<RemoteOutcome | ActionError> {
  const outcome = await actionJson(repoEndpoint(repoId, "fetch"), opts);
  return outcome as RemoteOutcome | ActionError;
}

/** Pull: fetch and merge. Merging is chosen on the user's side, not git's. */
export async function pullRepo(
  repoId: string,
  opts: { remote?: string } = {},
): Promise<RemoteOutcome | ActionError> {
  const outcome = await actionJson(repoEndpoint(repoId, "pull"), opts);
  return outcome as RemoteOutcome | ActionError;
}

/** Push. `setUpstream` publishes a branch that has never been pushed. */
export async function pushRepo(
  repoId: string,
  opts: { remote?: string; setUpstream?: boolean } = {},
): Promise<RemoteOutcome | ActionError> {
  const outcome = await actionJson(repoEndpoint(repoId, "push"), opts);
  return outcome as RemoteOutcome | ActionError;
}

/** The sign-in state. `token` is deliberately absent: the server never sends
 *  one, and if a future response ever carried it, that would be a bug rather
 *  than a convenience. */
export interface AuthState {
  signedIn: boolean;
  user: { login: string; name: string | null; avatarUrl: string | null } | null;
  configured: boolean;
  reason: string | null;
  storeMode: "keychain" | "memory";
  storeNotice: string | null;
}

export async function readAuth(): Promise<AuthState> {
  const res = await fetch("/api/auth");
  const parsed = (await res.json().catch(() => ({}))) as Partial<AuthState>;
  return {
    signedIn: parsed.signedIn === true,
    user: parsed.user ?? null,
    configured: parsed.configured === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
    storeMode: parsed.storeMode ?? "memory",
    storeNotice: typeof parsed.storeNotice === "string" ? parsed.storeNotice : null,
  };
}

/** What the device flow asked GitHub for, which is all the interface needs to
 *  show the code and a button that opens GitHub. */
export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
}

export type DevicePollResult =
  | { state: "pending" }
  | { state: "slow-down"; intervalSeconds: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "authorized"; signedIn: boolean }
  /** The server will not answer further polls, so stop. Not a failure the user
   *  needs to be told about — the flow simply restarts. */
  | { state: "stopped" };

export async function startDeviceLogin(): Promise<
  { ok: true; start: DeviceLogin } | ActionError
> {
  const outcome = await actionJson("/api/auth/start", {});
  if (isActionError(outcome)) return outcome;
  return outcome as { ok: true; start: DeviceLogin };
}

export async function pollDeviceLogin(): Promise<DevicePollResult> {
  const res = await fetch("/api/auth/poll");
  const parsed = (await res.json().catch(() => ({}))) as Partial<DevicePollResult> & {
    state?: string;
  };
  // Only the five states the flow knows are passed on. Anything else — an
  // unauthenticated answer, a translator card — means the server has stopped
  // polling, and the interface stops with it rather than spinning.
  switch (parsed.state) {
    case "pending":
      return { state: "pending" };
    case "slow-down":
      return { state: "slow-down", intervalSeconds: parsed.intervalSeconds ?? 10 };
    case "expired":
      return { state: "expired" };
    case "denied":
      return { state: "denied" };
    case "authorized":
      return { state: "authorized", signedIn: true };
    default:
      return { state: "stopped" };
  }
}

/** Sign out. The server answers with who was signed out, because "you are no
 *  longer signed in as Ada" is more useful than a bare confirmation, and with
 *  a note about revoking the app on GitHub. */
export async function signOut(): Promise<{ ok: true; note?: string } | ActionError> {
  const outcome = await actionJson("/api/auth/signout", {});
  if (isActionError(outcome)) return outcome;
  return outcome as { ok: true; note?: string };
}

/** A branch, as the interface shows it. `name` never carries a `refs/heads/`
 *  prefix — the server strips it, because the alternative is a rail full of
 *  internals. */
export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  counts: { ahead: number; behind: number } | null;
  hasUnmergedWork: boolean;
}

export interface BranchList {
  branches: BranchInfo[];
  /** True when HEAD points at a commit rather than a branch, which is a state
   *  worth naming rather than showing an empty branch field. */
  detached: boolean;
}

export async function listBranches(repoId: string): Promise<BranchList> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/branches`);
  const parsed = (await res.json().catch(() => ({}))) as Partial<BranchList>;
  return { branches: parsed.branches ?? [], detached: parsed.detached === true };
}

/**
 * Any branch action. These all return the branch that is current afterwards,
 * which is what the interface has to re-render from.
 */
async function branchCall(
  repoId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; nowOn?: string | null } | ActionError> {
  const outcome = await actionJson(`/api/repos/${encodeURIComponent(repoId)}/branches/${action}`, body);
  return outcome as { ok: true; nowOn?: string | null } | ActionError;
}

export async function switchBranch(
  repoId: string,
  name: string,
): Promise<{ ok: true; nowOn?: string | null } | ActionError> {
  return branchCall(repoId, "switch", { name });
}

/** Turn `origin/thing` into a local branch that tracks it. */
export async function trackBranch(
  repoId: string,
  name: string,
): Promise<{ ok: true; nowOn?: string | null } | ActionError> {
  return branchCall(repoId, "track", { name });
}

export async function createBranch(
  repoId: string,
  name: string,
  from?: string,
): Promise<{ ok: true; nowOn?: string | null } | ActionError> {
  return branchCall(repoId, "create", from === undefined ? { name } : { name, from });
}

/** `force` is never defaulted to true: a branch with work nothing else has is
 *  not deleted by accident. */
export async function deleteBranch(
  repoId: string,
  name: string,
  force = false,
): Promise<{ ok: true } | ActionError> {
  return branchCall(repoId, "delete", { name, force }) as Promise<{ ok: true } | ActionError>;
}

export async function renameBranch(
  repoId: string,
  name: string,
): Promise<{ ok: true; nowOn?: string | null } | ActionError> {
  return branchCall(repoId, "rename", { name });
}
