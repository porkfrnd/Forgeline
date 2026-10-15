import { basename } from "node:path";
import type { RepoSummary } from "../shared/types.js";
import { repoStatusFields } from "./git/git.js";
import type { RepoEntry } from "./registry.js";

/** Build one dashboard row for a registered repo. Never throws: when git
 *  fails the row reports `branch: "unknown"` with zero counts, so one broken
 *  repo cannot hide the rest of the list. */
export async function summarizeRepo(entry: RepoEntry, name?: string): Promise<RepoSummary> {
  const fields = await repoStatusFields(entry.path);
  return {
    id: entry.id,
    name: name ?? basename(entry.path),
    path: entry.path,
    branch: fields.branch,
    changedFiles: fields.changedFiles,
    ahead: fields.ahead,
    behind: fields.behind,
  };
}

/** Summarize a batch and sort by path so the dashboard order is stable
 *  regardless of registry insertion order. */
export async function summarizeRepos(
  entries: { entry: RepoEntry; name?: string }[],
): Promise<RepoSummary[]> {
  const repos = await Promise.all(entries.map((e) => summarizeRepo(e.entry, e.name)));
  repos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return repos;
}
