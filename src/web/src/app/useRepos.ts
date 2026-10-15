import { useEffect, useState } from "react";
import type { RepoSummary } from "../../../shared/types.js";

/** Poll the dashboard list. Cheap by design: one request every few seconds
 *  plus a refresh whenever the window regains focus, and an interval that is
 *  cleared on unmount so a re-render never stacks up fetches. */
export function useRepos(pollMs = 3000): { repos: RepoSummary[]; error: string | null } {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/repos", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { repos?: unknown };
        if (alive) {
          setRepos(Array.isArray(body.repos) ? (body.repos as RepoSummary[]) : []);
          setError(null);
        }
      } catch {
        if (alive) setError("Could not load repositories.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [pollMs]);
  return { repos, error };
}
