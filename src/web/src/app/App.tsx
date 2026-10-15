import { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { useTheme } from "../theme/ThemeProvider";
import { useRepos } from "./useRepos";
import { RepoRail } from "../components/RepoRail";
import { StatusBar } from "../components/StatusBar";
import { CommandPalette, type PaletteAction } from "../components/CommandPalette";
import { AppearancePanel } from "../components/AppearancePanel";

/**
 * The Workbench shell.
 *
 * Every region shown here has a working feature behind it. The slot rule
 * applies to the whole layout: Fetch, Pull, Push, Branch, Merge, and Stash do
 * not exist yet, so they are not drawn — not as disabled stubs, not as
 * placeholders. They appear when their features meet their exit criteria and
 * not before.
 */
export function App() {
  const { appearance, set } = useTheme();
  const { repos, error, liveMode } = useRepos();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const settingsRef = useRef<HTMLButtonElement>(null);

  // Keep a selection that still exists. A repo pruned after its path vanished
  // must not leave the worktable pointing at nothing.
  useEffect(() => {
    if (selectedId === null && repos.length > 0) {
      setSelectedId(repos[0].id);
      return;
    }
    if (selectedId !== null && !repos.some((r) => r.id === selectedId)) {
      setSelectedId(repos[0]?.id ?? null);
    }
  }, [repos, selectedId]);

  const selected = repos.find((r) => r.id === selectedId) ?? null;

  // The browser cannot hand the server an arbitrary filesystem path, so a
  // root is typed. Forgeline only ever scans what it is given.
  const [scanPath, setScanPath] = useState("");
  const [scanState, setScanState] = useState<"idle" | "scanning" | "failed">("idle");

  const runScan = async () => {
    const path = scanPath.trim();
    if (path.length === 0 || scanState === "scanning") return;
    setScanState("scanning");
    try {
      const res = await fetch("/api/repos/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ roots: [path] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      setScanPath("");
      setScanState("idle");
    } catch {
      setScanState("failed");
    }
  };

  const actions: PaletteAction[] = [
    {
      id: "appearance",
      label: "Appearance…",
      group: "View",
      run: () => setAppearanceOpen(true),
    },
    {
      id: "effects-off",
      label: "Effects: Off",
      group: "View",
      run: () => set({ effects: "off" }),
    },
    {
      id: "effects-full",
      label: "Effects: Full",
      group: "View",
      run: () => set({ effects: "full" }),
    },
    {
      id: "surface-solid",
      label: "Surface: Solid",
      group: "View",
      run: () => set({ surface: "solid" }),
    },
    {
      id: "surface-glass",
      label: "Surface: Glass",
      group: "View",
      run: () => set({ surface: "glass" }),
    },
    {
      id: "mode-dark",
      label: "Mode: Dark",
      group: "View",
      run: () => set({ mode: "dark" }),
    },
    {
      id: "mode-light",
      label: "Mode: Light",
      group: "View",
      run: () => set({ mode: "light" }),
    },
    {
      id: "scan-folder",
      label: "Scan a folder for repositories…",
      group: "Repositories",
      run: () => document.getElementById("scan-input")?.focus(),
    },
  ];

  return (
    <div className="shell">
      <RepoRail
        repos={repos}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loadError={error}
        liveMode={liveMode}
      />

      <header className="toolbar">
        <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
        <strong>Forgeline</strong>
        <span className="spacer" />
        <button
          type="button"
          className="button search-field"
          onClick={() => setAppearanceOpen(true)}
          aria-label="Search commits and files"
        >
          <span className="muted">Search commits and files</span>
          <kbd className="keycap">Ctrl K</kbd>
        </button>
        <button
          ref={settingsRef}
          type="button"
          className="button"
          aria-expanded={appearanceOpen}
          aria-label="Appearance"
          onClick={() => setAppearanceOpen((v) => !v)}
        >
          {appearance.density === "compact" ? "Compact" : "Cozy"}
        </button>
      </header>

      <main className="work">
        <section className="work-scan panel" data-ticks>
          <p className="label">Scan a folder</p>
          <div className="scan-row">
            <input
              id="scan-input"
              className="input mono"
              value={scanPath}
              placeholder="~/projects"
              aria-label="Folder to scan"
              onChange={(e) => setScanPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runScan();
              }}
            />
            <button type="button" className="button primary" onClick={() => void runScan()}>
              Scan
            </button>
          </div>
          <p className="message muted">
            {scanState === "failed"
              ? "That folder could not be scanned. Check the path and try again."
              : "Forgeline searches only the folders you give it, and never the whole disk."}
          </p>
        </section>

        <section className="panel worktable" data-ticks>
          {selected ? (
            <>
              <p className="label">{selected.name}</p>
              <p className="readout">{selected.changedFiles}</p>
              <p className="muted">changed file{selected.changedFiles === 1 ? "" : "s"}</p>
            </>
          ) : (
            <>
              <p className="message empty-title">No repository is open yet.</p>
              <p className="muted">
                {error ?? "Scan a folder above to bring your repositories onto the workbench."}
              </p>
            </>
          )}
        </section>
      </main>

      <StatusBar repo={selected} liveMode={liveMode} effects={appearance.effects} />

      <CommandPalette actions={actions} />
      {appearanceOpen ? (
        <AppearancePanel closeRef={settingsRef} onClose={() => setAppearanceOpen(false)} />
      ) : null}
    </div>
  );
}
