import { GitBranch } from "lucide-react";

export function Header() {
  return (
    <header className="header">
      <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
      <strong>Forgeline</strong>
      <span className="count">0 repos</span>
      <span className="spacer" />
      <span aria-label="account">Not signed in</span>
    </header>
  );
}
