import { basename } from "node:path";
import type { RepoSummary } from "../shared/types.js";
import { repoStatusFields } from "./git/git.js";
import type { RepoEntry } from "./registry.js";
import type { RepoQueue } from "./queue.js";

/** Build one dashboard row for a registered repo. Never throws: when git
 *  fails the row reports `branch: "unknown"` with zero counts, so one broken
 *  repo cannot hide the rest of the list.
 *
 *  Pass `queue` to serialize this read against other git calls in the same
 *  repo. Reading status runs several git processes, and a `commit` or `add`
 *  landing mid-read would see a half-updated index. */
export async function summarizeRepo(
  entry: RepoEntry,
  name?: string,
  queue?: RepoQueue,
): Promise<RepoSummary> {
  const compute = async (): Promise<RepoSummary> => {
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
  };
  return queue ? queue.run(entry.path, compute) : compute();
}

/** Summarize a batch and sort by path so the dashboard order is stable
 *  regardless of registry insertion order. Different repos run concurrently;
 *  the queue only orders calls that touch the same repo. */
export async function summarizeRepos(
  entries: { entry: RepoEntry; name?: string }[],
  queue?: RepoQueue,
): Promise<RepoSummary[]> {
  const repos = await Promise.all(entries.map((e) => summarizeRepo(e.entry, e.name, queue)));
  repos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return repos;
}
