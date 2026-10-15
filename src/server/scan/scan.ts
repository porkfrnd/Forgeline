import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveRealpath } from "../paths.js";

/** One repo found by scanning a picked root folder. */
export interface ScannedRepo {
  /** Display name (the repo directory name). */
  name: string;
  /** Fully-resolved absolute path to the repo root. */
  path: string;
}

/** Options for {@link scanRepos}. */
export interface ScanOptions {
  /** How many directory levels below each root to search. Defaults to 4. */
  maxDepth?: number;
}

/** Directory names never descended into (exact, case-sensitive matches). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Dot-folders other than `.git` itself are never descended into. */
function isSkippedDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return name.startsWith(".");
}

/** True when `dir` looks like a git working tree (has a `.git` entry). */
function isRepoRoot(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function walk(current: string, depth: number, maxDepth: number, out: ScannedRepo[]): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const name of entries) {
    if (isSkippedDir(name)) continue;
    const full = join(current, name);
    let st;
    try {
      // lstat (not stat) so symlinked directories are skipped below instead
      // of being followed into.
      st = lstatSync(full);
    } catch {
      continue;
    }
    // Never follow symlinked directories: they could loop the walk or
    // escape the picked root. Real repos behind a symlinked path are still
    // found when the user picks the resolved folder itself.
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (isRepoRoot(full)) {
      out.push({ name: basename(full), path: full });
      // A repo's own subfolders (submodules aside, Milestone 7+) are not
      // separate dashboard entries, so do not descend further.
      continue;
    }
    if (depth < maxDepth) walk(full, depth + 1, maxDepth, out);
  }
}

/** Scan picked root folders for git repos (bounded depth, no recursion into
 *  `node_modules`, dot-folders, or symlinked directories). Returns one entry
 *  per repo, sorted by path. Never throws: unreadable roots scan as empty. */
export async function scanRepos(rootFolders: string[], opts: ScanOptions = {}): Promise<ScannedRepo[]> {
  const maxDepth = opts.maxDepth ?? 4;
  const found: ScannedRepo[] = [];
  const seen = new Set<string>();
  for (const root of rootFolders) {
    let resolved: string;
    try {
      resolved = await resolveRealpath(resolve(root));
    } catch {
      continue;
    }
    let st;
    try {
      st = statSync(resolved);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // A picked root that is itself a repo scans as exactly that repo.
    if (isRepoRoot(resolved)) {
      if (!seen.has(resolved)) {
        seen.add(resolved);
        found.push({ name: basename(resolved), path: resolved });
      }
      continue;
    }
    const nested: ScannedRepo[] = [];
    walk(resolved, 0, maxDepth, nested);
    for (const repo of nested) {
      const real = await resolveRealpath(repo.path);
      if (!seen.has(real)) {
        seen.add(real);
        found.push({ name: basename(real), path: real });
      }
    }
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** True when `p` exists on disk (used by the repos route to drop repos that
 *  were deleted or moved since the last scan). */
export function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
