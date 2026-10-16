import type { RepoSummary } from "../../../shared/types.js";

interface RepoRailProps {
  repos: RepoSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loadError: string | null;
  liveMode: "watching" | "polling" | "stopped";
}

/** Counters carry an arrow and a number, so colour never has to. */
function Counter({ label, value }: { label: string; value: number }) {
  if (value <= 0) return null;
  return (
    <span className="counter" title={`${value} ${label}`}>
      <span aria-hidden="true">{label === "behind" ? "↓" : "↑"}</span>
      <span className="mono">{value}</span>
      <span className="sr-only">
        {" "}
        {value} commit{value === 1 ? "" : "s"} {label}
      </span>
    </span>
  );
}

export function RepoRail({ repos, selectedId, onSelect, loadError, liveMode }: RepoRailProps) {
  return (
    <nav className="sidebar" aria-label="Repositories">
      <section className="rail-section">
        <p className="label">Repositories</p>
        {repos.length === 0 ? (
          <p className="message muted rail-empty">{loadError ?? "No folders scanned yet."}</p>
        ) : (
          <ul className="rail-list">
            {repos.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  className="row rail-row"
                  // aria-selected belongs to option/tab/row, not to a button;
                  // aria-current is the legal way to say "this is the one you are
                  // looking at" and screen readers announce it as such.
                  aria-current={repo.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(repo.id)}
                >
                  <span className="rail-name mono">{repo.name}</span>
                  <span className="spacer" />
                  <span className="rail-branch mono" title={`Branch: ${repo.branch}`}>
                    {repo.branch}
                  </span>
                  {repo.changedFiles > 0 ? (
                    <span className="counter" title={`${repo.changedFiles} changed`}>
                      <span className="mono">{repo.changedFiles}</span>
                      <span className="sr-only">
                        {" "}
                        changed file{repo.changedFiles === 1 ? "" : "s"}
                      </span>
                    </span>
                  ) : null}
                  <Counter label="ahead" value={repo.ahead} />
                  <Counter label="behind" value={repo.behind} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {liveMode === "polling" ? (
        <p className="live-note">
          <span className="watcher-dot" data-live="polling" aria-hidden="true" /> Live updates
          are polling.
        </p>
      ) : null}
    </nav>
  );
}
