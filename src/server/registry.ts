import { randomBytes } from "node:crypto";
import { resolveRealpath, safeRepoChildPath, isInside, type PathCheck } from "./paths.js";

export interface RepoEntry {
  id: string;
  /** Absolute, symlink-resolved path the server itself discovered. */
  path: string;
}

/** Maps opaque, server-issued repo IDs to paths the server discovered inside a
 *  configured root. The browser never sends a raw path; it sends an ID. A forged
 *  or unknown ID resolves to nothing. */
export class RepoRegistry {
  private roots: string[] = [];
  private byId = new Map<string, RepoEntry>();
  private byPath = new Map<string, RepoEntry>();

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => r);
  }

  getRoots(): string[] {
    return [...this.roots];
  }

  /** Register a repo path. Returns the entry, or null if the resolved path is
   *  not inside any configured root. Roots are resolved on every call (the
   *  list is tiny) so a root that is itself a symlink still compares
   *  correctly. Idempotent by path. */
  async register(path: string): Promise<RepoEntry | null> {
    const resolved = await resolveRealpath(path);
    const roots = await Promise.all(this.roots.map((r) => resolveRealpath(r)));
    if (!roots.some((root) => isInside(root, resolved))) {
      return null;
    }
    const existing = this.byPath.get(resolved);
    if (existing) return existing;
    const entry: RepoEntry = { id: randomBytes(16).toString("base64url"), path: resolved };
    this.byId.set(entry.id, entry);
    this.byPath.set(resolved, entry);
    return entry;
  }

  /** Look up a repo by its opaque ID. Unknown IDs return undefined (-> 404). */
  get(id: string): RepoEntry | undefined {
    return this.byId.get(id);
  }

  list(): RepoEntry[] {
    return [...this.byId.values()];
  }

  /** Drop an entry whose path vanished (used to prune deleted/moved repos). */
  remove(id: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.byId.delete(id);
    if (this.byPath.get(entry.path)?.id === id) {
      this.byPath.delete(entry.path);
    }
  }

  /** Resolve a repo-relative path for a known repo ID. Returns a PathCheck whose
   *  `path` is normalized but not yet symlink-resolved. */
  child(id: string, rel: string): PathCheck & { repo?: RepoEntry } {
    const repo = this.byId.get(id);
    if (!repo) return { ok: false, reason: "unknown repository" };
    const check = safeRepoChildPath(repo.path, rel);
    return { ...check, repo };
  }
}
