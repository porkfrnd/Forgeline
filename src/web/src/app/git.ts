/** Client for the Milestone 3 stage/unstage endpoints. Every call sends an
 *  opaque repo ID (never a raw path) and lets the server validate the path
 *  against the registry before git runs. */
export type StageResult =
  | { ok: true }
  | { ok: false; code: string; title: string; command?: string };

async function stageJson(path: string, body: unknown): Promise<StageResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as {
      code?: string;
      title?: string;
      command?: string;
    };
    return {
      ok: false,
      code: parsed.code ?? `http-${res.status}`,
      title: parsed.title ?? `HTTP ${res.status}`,
      command: parsed.command,
    };
  }
  return { ok: true };
}

/** Stage whole files: `git add -- <paths>`. */
export async function stageFiles(
  repoId: string,
  paths: string[],
): Promise<StageResult> {
  return stageJson(`/api/repos/${encodeURIComponent(repoId)}/stage`, { paths });
}

/** Unstage whole files: `git restore --staged -- <paths>`. */
export async function unstageFiles(
  repoId: string,
  paths: string[],
): Promise<StageResult> {
  return stageJson(`/api/repos/${encodeURIComponent(repoId)}/unstage`, { paths });
}

/** Stage a single hunk: `git apply --cached -` with the patch on stdin. */
export async function stageHunk(
  repoId: string,
  path: string,
  patch: string,
): Promise<StageResult> {
  return stageJson(`/api/repos/${encodeURIComponent(repoId)}/stage-hunk`, {
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
  return stageJson(`/api/repos/${encodeURIComponent(repoId)}/unstage-hunk`, {
    path,
    patch,
  });
}

/** Changed-file records for a repo, staged and unstaged together. */
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
