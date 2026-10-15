import type { RepoSummary } from "../../../shared/types.js";

interface SidebarProps {
  repos: RepoSummary[];
  loadError: string | null;
}

function statusLine(repo: RepoSummary): string {
  const bits: string[] = [repo.branch];
  if (repo.changedFiles > 0) {
    bits.push(`${repo.changedFiles} changed`);
  }
  if (repo.ahead > 0 || repo.behind > 0) {
    bits.push(`↑${repo.ahead} ↓${repo.behind}`);
  }
  return bits.join(" · ");
}

export function Sidebar({ repos, loadError }: SidebarProps) {
  if (repos.length === 0) {
    return (
      <aside className="sidebar" aria-label="Repositories">
        <p className="empty-title">Repositories</p>
        <p className="empty-text">{loadError ?? "No folders scanned yet."}</p>
        <button className="button">Choose folders</button>
      </aside>
    );
  }
  return (
    <aside className="sidebar" aria-label="Repositories">
      <p className="empty-title">Repositories</p>
      <ul className="repo-list">
        {repos.map((repo) => (
          <li key={repo.id} className="repo-item">
            <span className="repo-name">{repo.name}</span>
            <span className="repo-status">{statusLine(repo)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
