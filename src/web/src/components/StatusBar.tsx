import { useEffect, useState } from "react";
import type { RepoSummary } from "../../../shared/types.js";

interface StatusBarProps {
  repo: RepoSummary | null;
  liveMode: "watching" | "polling" | "stopped";
  effects: "full" | "reduced" | "off";
}

/** Git version, read once. The server caches it, so this is one request for
 *  the life of the page. */
function useGitVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    void fetch("/api/health", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (alive && body && typeof body.gitVersion === "string") setVersion(body.gitVersion);
      })
      .catch(() => {
        // A missing version is a blank in the status bar, not an error card.
      });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

export function StatusBar({ repo, liveMode, effects }: StatusBarProps) {
  const gitVersion = useGitVersion();
  return (
    <footer className="statusbar" aria-label="Status">
      <span className="status-item">
        <span className="label">Branch</span>
        <span className="mono">{repo ? repo.branch : "—"}</span>
      </span>
      {repo ? (
        <>
          <span className="status-item">
            <span className="label">Ahead</span>
            <span className="mono">↑{repo.ahead}</span>
          </span>
          <span className="status-item">
            <span className="label">Behind</span>
            <span className="mono">↓{repo.behind}</span>
          </span>
          <span className="status-item">
            <span className="label">Changed</span>
            <span className="mono">{repo.changedFiles}</span>
          </span>
        </>
      ) : null}
      <span className="spacer" />
      <span className="status-item" title="How live updates arrive">
        <span
          className="watcher-dot"
          data-live={liveMode === "polling" ? "polling" : String(liveMode === "watching")}
          aria-hidden="true"
        />
        <span className="mono">{liveMode}</span>
      </span>
      {gitVersion ? (
        <span className="status-item">
          <span className="label">git</span>
          <span className="mono">{gitVersion}</span>
        </span>
      ) : null}
      <span className="status-item">
        <span className="label">Effects</span>
        <span className="mono">{effects}</span>
      </span>
    </footer>
  );
}
