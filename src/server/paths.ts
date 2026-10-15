import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface PathCheck {
  ok: boolean;
  /** Present when ok is false. */
  reason?: string;
  /** The resolved absolute path when ok is true. */
  path?: string;
}

/** True when `child` is the same as, or nested inside, `root`. Both must be
 *  absolute and already normalized. */
export function isInside(root: string, child: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return child === root || child.startsWith(r);
}

/** Resolve symlinks for a path that must already exist. Returns the real path,
 *  or the input on failure so callers can still compare. */
export async function resolveRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** Validate a repo-relative path supplied by the browser.
 *  - rejects absolute paths and Windows drive/UNC forms
 *  - rejects any path that escapes the repo root after normalization
 *  - rejects paths that would be read by git as an option (leading "-")
 *  The returned path is normalized but NOT yet symlink-resolved; call
 *  `resolveRealpath` immediately before the git call. */
export function safeRepoChildPath(repoRoot: string, rel: string): PathCheck {
  if (rel.length === 0) return { ok: false, reason: "empty path" };
  if (rel.startsWith("-")) return { ok: false, reason: "path may not start with '-'" };
  if (isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) {
    return { ok: false, reason: "path must be relative to the repo" };
  }
  const normalized = normalize(rel);
  if (normalized.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "path may not contain '..'" };
  }
  const full = resolve(repoRoot, normalized);
  if (!isInside(repoRoot, full)) {
    return { ok: false, reason: "path escapes the repository root" };
  }
  return { ok: true, path: full };
}

/** Confirm a fully-resolved path still sits inside a resolved root. Used right
 *  before a git call to catch a symlink swapped in after the first check. */
export function stillInside(resolvedRoot: string, resolvedChild: string): boolean {
  return isInside(resolvedRoot, resolvedChild);
}

/** Build the argument array for `git -C <dir>` plus extra args, keeping the
 *  directory as its own array element (never a shell string). */
export function gitInDir(dir: string, args: string[]): string[] {
  return ["-C", dir, ...args];
}

export { join };
