import { useCallback, useEffect, useState } from "react";
import type { RepoSummary } from "../../../shared/types.js";

/** How live updates are arriving: native file events, the server's 3s
 *  polling fallback (surfaced as a note), or no stream at all. */
export type LiveMode = "watching" | "polling" | "stopped";

interface ReposEvent {
  repos?: RepoSummary[];
}

/** Merge pushed rows into the current list, keeping the server's path sort.
 *  A push only carries the repos that changed, so rows we already hold for
 *  other repos must survive. */
function mergeRepos(current: RepoSummary[], incoming: RepoSummary[]): RepoSummary[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Drive the dashboard list from the SSE stream: one full snapshot on
 *  connect, then only the repos that changed. Falls back to a slow poll if
 *  the stream cannot be established, so a proxy or a closed port still shows
 *  a live-ish list rather than a frozen one. */
export function useRepos(fallbackPollMs = 15000): {
  repos: RepoSummary[];
  error: string | null;
  liveMode: LiveMode;
  refresh: () => void;
} {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState<LiveMode>("stopped");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/repos", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ReposEvent;
      setRepos(Array.isArray(body.repos) ? body.repos : []);
      setError(null);
    } catch {
      setError("Could not load repositories.");
    }
  }, []);

  useEffect(() => {
    void load();
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const startFallbackPoll = () => {
      if (timer !== null) return;
      timer = setInterval(() => void load(), fallbackPollMs);
    };

    try {
      source = new EventSource("/api/events");
    } catch {
      startFallbackPoll();
    }

    if (source) {
      source.addEventListener("mode", (event) => {
        const data = (event as MessageEvent<string>).data;
        try {
          const parsed = JSON.parse(data) as { mode?: LiveMode };
          if (parsed.mode) setLiveMode(parsed.mode);
        } catch {
          // A malformed frame is ignored; the next one supersedes it.
        }
      });
      source.addEventListener("repos", (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent<string>).data) as ReposEvent;
          const rows = parsed.repos;
          if (Array.isArray(rows)) setRepos((cur) => mergeRepos(cur, rows));
          setError(null);
        } catch {
          // Ignore a truncated frame; the watcher will push again.
        }
      });
      source.onopen = () => {
        setLiveMode((m) => (m === "stopped" ? "watching" : m));
      };
      source.onerror = () => {
        // The browser retries on its own (the server sends `retry: 3000`);
        // only a dead stream needs the poll to take over.
        startFallbackPoll();
      };
      // Window focus is still a refresh trigger for repos the watcher may
      // have missed while the tab was hidden.
      const onFocus = () => void load();
      window.addEventListener("focus", onFocus);
      return () => {
        source?.close();
        if (timer !== null) clearInterval(timer);
        window.removeEventListener("focus", onFocus);
      };
    }

    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }, [load, fallbackPollMs]);

  return { repos, error, liveMode, refresh: load };
}
