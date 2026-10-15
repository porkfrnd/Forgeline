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

export interface ForgeError {
  code: string;
  title: string;
  explanation: string;
  fixes: string[];
  raw: string;
}

export interface Snapshot {
  id: string;
  repoPath: string;
  createdAt: string;
  ref: string;
}
