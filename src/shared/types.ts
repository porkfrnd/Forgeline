export interface RepoStatus {
  name: string;
  path: string;
  branch: string;
  changedFiles: number;
  ahead: number;
  behind: number;
}

/** What the dashboard list endpoints return: a RepoStatus plus the opaque,
 *  server-issued id the browser uses for every later request. */
export interface RepoSummary extends RepoStatus {
  id: string;
}

export interface Change {
  file: string;
  staged: boolean;
  hunks: number;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** One fix button on an error card. `id` is the stable identifier the
 *  interface maps to a real action; `label` is the plain-English text the
 *  user reads. A rule may declare fixes for features that don't exist yet —
 *  whether a button is drawn is the interface's decision, because it knows
 *  what exists. Declaring them all keeps the catalogue complete. */
export interface ErrorFix {
  id: string;
  label: string;
}

export interface ForgeError {
  code: string;
  title: string;
  explanation: string;
  fixes: ErrorFix[];
  raw: string;
}

export interface Snapshot {
  id: string;
  repoPath: string;
  createdAt: string;
  ref: string;
}
