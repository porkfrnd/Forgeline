import { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { useTheme } from "../theme/ThemeProvider";
import { useRepos } from "./useRepos";
import { fetchChanges, type ChangeFile } from "./git.js";
import { RepoRail } from "../components/RepoRail";
import { StatusBar } from "../components/StatusBar";
import { CommandPalette, type PaletteAction } from "../components/CommandPalette";
import { AppearancePanel } from "../components/AppearancePanel";
import { FileList } from "../components/FileList";
import { DiffViewer } from "../components/DiffViewer";
import { CommitComposer } from "../components/CommitComposer";
import { UndoTimeline } from "../components/UndoTimeline";
import { ErrorCard } from "../components/ErrorCard";
import { RemoteBar } from "../components/RemoteBar";
import { History } from "lucide-react";
import {
  abortMerge,
  checkGitProcesses,
  initRepo,
  recordErrorShown,
  recordFixOutcome,
  removeLock,
  pushRepo,
  setIdentity,
  type ActionError,
} from "./git.js";

/**
 * The Workbench shell.
 *
 * Every region shown here has a working feature behind it. The slot rule
 * applies to the whole layout: Branch, Merge, and Stash do not exist yet, so
 * they are not drawn — not as disabled stubs, not as placeholders. They appear
 * when their features meet their exit criteria and
 * not before.
 */
export function App() {
  const { appearance, set } = useTheme();
  const { repos, error, liveMode } = useRepos();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  /* A failed action surfaces as a plain-English card rather than as raw git
     text. `errorId` is its history id, so the fix that gets tried can be
     recorded against the error that offered it. */
  const [activeError, setActiveError] = useState<ActionError | null>(null);
  const [activeErrorId, setActiveErrorId] = useState<string | null>(null);
  const [fixRunning, setFixRunning] = useState(false);
  /** The identity form, shown only when a "set name and email" fix is used. */
  const [identityPrompt, setIdentityPrompt] = useState(false);
  /** What the running-git check found, so the remove-lock fix can say why. */
  const [gitCheck, setGitCheck] = useState<{ running: string[]; title: string } | null>(null);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const settingsRef = useRef<HTMLButtonElement>(null);
  const journalRef = useRef<HTMLButtonElement>(null);

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

  // Changed files for the selected repo, fetched from the server. Cleared
  // whenever the selection changes so a stale file list never shows for a
  // different repo.
  const [files, setFiles] = useState<ChangeFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    setSelectedFile(null);
    setFiles([]);
    if (selectedId === null) return;
    void fetchChanges(selectedId).then(setFiles, () => setFiles([]));
  }, [selectedId]);

  /** Show the card for a failed action and record it in history. */
  const reportError = (error: ActionError): void => {
    setActiveError(error);
    void recordErrorShown(selectedId, error).then(setActiveErrorId, () => setActiveErrorId(null));
  };

  const dismissError = (): void => {
    setActiveError(null);
    setActiveErrorId(null);
  };

  /** Run the fix a button stood for, and record whether it worked. */
  const runFix = async (fixId: string): Promise<void> => {
    if (selectedId === null) return;
    setFixRunning(true);
    try {
      // `commit-first` is not a git action: it opens the composer, which is
      // the thing that fix actually needs.
      if (fixId === "commit-first") {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>(".commit-composer textarea")?.focus();
        });
        void recordFixOutcome(activeErrorId, fixId, true);
        dismissError();
        return;
      }

      // Looking for a running git is informational: it answers whether the
      // lock is really stale before the user decides to remove it.
      if (fixId === "check-running-git") {
        setGitCheck(await checkGitProcesses(selectedId));
        return;
      }
      if (fixId === "set-identity") {
        setIdentityPrompt(true);
        return;
      }

      // Publishing a branch is the only fix here that talks to a remote, so it
      // is also the only one that can fail for a reason Forgeline cannot
      // repair — an unreachable host, a refused credential — and those come
      // back as a new card rather than a success.
      const call =
        fixId === "init-here" ? initRepo(selectedId)
        : fixId === "abort-merge" ? abortMerge(selectedId)
        : fixId === "remove-lock" ? removeLock(selectedId)
        : fixId === "push-set-upstream" ? pushRepo(selectedId, { setUpstream: true })
        : null;

      if (call === null) {
        // A fix with no action yet. Reported rather than silently ignored,
        // because a button that does nothing is worse than no button.
        reportError({
          ok: false,
          code: "fix-unavailable",
          title: "That fix isn't available in Forgeline yet.",
          explanation:
            "This repair has to be run from the command line for now. The git output below shows exactly what to run.",
          raw: activeError?.raw ?? activeError?.command,
        });
        return;
      }

      const result = await call;
      if (result.ok) {
        void recordFixOutcome(activeErrorId, fixId, true);
        dismissError();
        await refreshChanges();
        return;
      }
      // The fix itself failed. The history records that, which is the whole
      // point of keeping one: a remedy that doesn't work should stop being
      // offered first.
      void recordFixOutcome(activeErrorId, fixId, false);
      reportError(result);
    } finally {
      setFixRunning(false);
    }
  };

  /** Submit the identity form: sets it, then records the fix as working. */
  const submitIdentity = async (): Promise<void> => {
    if (selectedId === null || identityName.trim().length === 0) return;
    setFixRunning(true);
    try {
      const result = await setIdentity(selectedId, identityName.trim(), identityEmail.trim());
      if (result.ok) {
        void recordFixOutcome(activeErrorId, "set-identity", true);
        dismissError();
        setIdentityPrompt(false);
        setIdentityName("");
        setIdentityEmail("");
        await refreshChanges();
        return;
      }
      void recordFixOutcome(activeErrorId, "set-identity", false);
      reportError(result);
    } finally {
      setFixRunning(false);
    }
  };

  /**
   * Fixes this build can really run. Everything else the server offers is left
   * undrawn, which is what keeps every button a working feature.
   */
  const AVAILABLE_FIXES = [
    "init-here",
    "push-set-upstream",
    "commit-first",
    "abort-merge",
    "remove-lock",
    "check-running-git",
    "set-identity",
  ];

  const refreshChanges = async (): Promise<void> => {
    if (selectedId === null) return;
    try {
      setFiles(await fetchChanges(selectedId));
    } catch {
      setFiles([]);
    }
  };

  const stagedFiles = files.filter((f) => f.staged);

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
    {
      id: "undo-timeline",
      label: "Undo timeline…",
      group: "Safety",
      run: () => setJournalOpen(true),
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
        <button
          ref={journalRef}
          type="button"
          className="button"
          aria-expanded={journalOpen}
          aria-label="Undo timeline"
          onClick={() => setJournalOpen((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} aria-hidden="true" />
          History
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

        {activeError !== null ? (
          <section className="work-error">
            <ErrorCard
              error={activeError}
              availableFixes={AVAILABLE_FIXES}
              onFix={(fixId) => void runFix(fixId)}
              onDismiss={dismissError}
            />

            {identityPrompt ? (
              <form
                className="panel identity-form"
                data-ticks
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitIdentity();
                }}
              >
                <p className="label">Your name and email</p>
                <p className="message muted">
                  Git writes these into every commit you make. They stay in this
                  repository's own settings, not in Forgeline.
                </p>
                <input
                  className="input"
                  value={identityName}
                  placeholder="Ada Lovelace"
                  aria-label="Your name"
                  onChange={(e) => setIdentityName(e.target.value)}
                />
                <input
                  className="input mono"
                  value={identityEmail}
                  placeholder="ada@example.com"
                  aria-label="Your email"
                  onChange={(e) => setIdentityEmail(e.target.value)}
                />
                <div className="error-fixes">
                  <button
                    type="submit"
                    className="button primary"
                    disabled={fixRunning || identityName.trim().length === 0}
                  >
                    {fixRunning ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setIdentityPrompt(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {gitCheck !== null ? (
              <p className="message muted work-gitcheck">
                {gitCheck.title}
                {gitCheck.running.length > 0
                  ? " Wait for it to finish, or close it before removing the lock."
                  : " The lock is safe to remove."}
              </p>
            ) : null}
          </section>
        ) : null}

        {selected !== null ? (
          <RemoteBar
            repoId={selectedId}
            ahead={selected.ahead}
            behind={selected.behind}
            onChanged={() => void refreshChanges()}
            onError={reportError}
          />
        ) : null}

        <section className="panel worktable" data-ticks>
          {selectedId === null ? (
            <>
              <p className="message empty-title">No repository is open yet.</p>
              <p className="muted">
                {error ?? "Scan a folder above to bring your repositories onto the workbench."}
              </p>
            </>
          ) : selectedFile === null ? (
            <FileList
              files={files}
              repoId={selectedId!}
              onSelect={setSelectedFile}
              onChange={refreshChanges}
              onError={reportError}
            />
          ) : (
            <DiffViewer
              repoId={selectedId!}
              path={selectedFile!}
              onBack={() => setSelectedFile(null)}
            />
          )}
          {stagedFiles.length > 0 && (
            <CommitComposer
              repoId={selectedId!}
              stagedFiles={stagedFiles}
              onCommitted={refreshChanges}
              onError={reportError}
            />
          )}
        </section>
      </main>

      <StatusBar repo={selected} liveMode={liveMode} effects={appearance.effects} />

      <CommandPalette actions={actions} />
      {appearanceOpen ? (
        <AppearancePanel closeRef={settingsRef} onClose={() => setAppearanceOpen(false)} />
      ) : null}
      {journalOpen ? (
        <UndoTimeline
          repoPath={selected?.path ?? null}
          onChanged={refreshChanges}
          closeRef={journalRef}
          onClose={() => setJournalOpen(false)}
        />
      ) : null}
    </div>
  );
}
