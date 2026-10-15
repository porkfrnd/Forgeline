import { useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { Header } from "../components/Header";
import { Sidebar } from "../components/Sidebar";
import { useRepos } from "./useRepos";

const TABS = ["Changes", "History", "Branches", "Releases"] as const;

export function App() {
  const { theme, setTheme } = useTheme();
  const { repos, error } = useRepos();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Changes");
  const next = theme === "paper" ? "midnight" : "paper";
  return (
    <div className="shell">
      <Header repoCount={repos.length} />
      <div className="body">
        <Sidebar repos={repos} loadError={error} />
        <main className="main">
          <div className="tabbar" role="tablist" aria-label="Repository views">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "tab active" : "tab"}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
            <span className="spacer" />
            <button
              className="button"
              onClick={() => setTheme(next)}
              aria-label={`Switch to ${next} theme`}
            >
              Theme: {theme}
            </button>
          </div>
          <section className="panel" aria-live="polite">
            <p className="empty-title">{tab} view</p>
            <p className="empty-text">No repository is open yet. Choose a folder to begin.</p>
            <button className="button primary">Choose folders</button>
          </section>
        </main>
      </div>
    </div>
  );
}
