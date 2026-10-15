import { GitBranch } from "lucide-react";

interface HeaderProps {
  repoCount: number;
}

export function Header({ repoCount }: HeaderProps) {
  const label = `${repoCount} ${repoCount === 1 ? "repo" : "repos"}`;
  return (
    <header className="header">
      <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
      <strong>Forgeline</strong>
      <span className="count">{label}</span>
      <span className="spacer" />
      <span aria-label="account">Not signed in</span>
    </header>
  );
}
