import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Inbox, KeyRound, Stethoscope, StickyNote, Tag, ToggleLeft } from "lucide-react";
import { useTheme } from "../theme/ThemeProvider";
import { useRepos } from "./useRepos";
import { fetchChanges, listStashes, readConflicts, type ChangeFile } from "./git.js";
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
import SignInPrompt from "../components/SignInPrompt";
import { BranchPanel } from "../components/BranchPanel";
import { StashPanel } from "../components/StashPanel";
import { HistoryPanel } from "../components/HistoryPanel";
import { ConflictResolver } from "../components/ConflictResolver";
import { ReleasePanel } from "../components/ReleasePanel";
import { DoctorPanel } from "../components/DoctorPanel";
import { SshPanel } from "../components/SshPanel";
import { NotePanel } from "../components/NotePanel";
import { loadSimpleMode, saveSimpleMode } from "../app/simpleMode";
import { SimpleBar } from "../components/SimpleBar";
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
  // Sign-in is lazy in the strict sense: nothing about it is drawn until a
  // remote actually refuses a command for want of a credential. `authFailure`
  // is what makes the prompt open by itself, and not being signed in is still
  // a perfectly normal state to launch in, with no badge saying otherwise.
  const [signIn, setSignIn] = useState<{ authFailure: boolean } | null>(null);
  // The branch panel, opened from the branch indicator. It is the only control
  // that draws something other than the workbench, so it is state on its own.
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);
  const [stashPanelOpen, setStashPanelOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  /**
   * The conflict resolver draws itself when git stops with conflicts, which is
   * the one state in git that does not resolve on its own. It is state rather
   * than derived from a list so it can stay open across a refresh of that list.
   */
  const [conflictOpen, setConflictOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  /**
   * Panels that are opened deliberately, rather than appearing on their own.
   * The conflict resolver is not in this group: it appears because git stopped,
   * which is the one state that does not go away by itself.
   */
  const [doctorOpen, setDoctorOpen] = useState(false);
  /**
   * Simple mode: Save and Send, and nothing else in the way.
   *
   * It is a preference, kept on this computer like every other display choice,
   * rather than a guess about who the user is. Nothing the full interface can
   * do becomes unreachable — it is all still one button away, so "simple" here
   * means quieter rather than smaller.
   */
  const [simpleMode, setSimpleMode] = useState(loadSimpleMode);

  /** Turn Simple mode on or off. A reload is the honest way to switch a mode
   *  that changes which screens are on screen, rather than a re-render that
   *  briefly puts two different interfaces on the page at once. */
  const toggleSimple = useCallback(() => {
    saveSimpleMode(!loadSimpleMode());
    setSimpleMode(!loadSimpleMode());
  }, []);
  const [sshOpen, setSshOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  /** A one-line note shown by a panel that wants to confirm what it just did. */
  const [note, setNote] = useState<string | null>(null);
  /** How many stashes there are, for a number on the toolbar. Zero draws no
   *  badge at all — an empty badge would be a decoration that says nothing. */
  const [stashCount, setStashCount] = useState(0);
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
    if (selectedId === null) {
      setStashCount(0);
      return;
    }
    // The stash count is read here because a stash surviving while the tree is
    // clean is exactly the case worth putting a number next to — the work is
    // safe somewhere other than the working tree.
    void listStashes(selectedId).then(
      (stashes) => setStashCount(stashes.length),
      () => setStashCount(0),
    );
    void fetchChanges(selectedId).then(setFiles, () => setFiles([]));
    // A stopped merge is the one state that will not go away by itself, so the
    // resolver appears on its own rather than waiting to be found.
    void readConflicts(selectedId).then(
      (index) => setConflictOpen(index.entries.length > 0),
      () => setConflictOpen(false),
    );
  }, [selectedId]);

  /** Show the card for a failed action and record it in history. */
  const reportError = (error: ActionError): void => {
    setActiveError(error);
    // A remote refusing for want of a credential is the one moment sign-in is
    // actually wanted, so the prompt opens by itself rather than waiting to be
    // asked for. Launching without an account stays a perfectly normal state.
    if (AUTH_FAILURE_CODES.has(error.code)) setSignIn({ authFailure: true });
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
  /** Codes that mean the remote would not let us in. These are the ones that
   *  make the sign-in prompt appear on its own; every other failure gets a card
   *  and no account question, because an account would not have helped. They
   *  must be codes the translator actually emits — a code listed here that git
   *  never produces is a prompt that never appears. */
  const AUTH_FAILURE_CODES = new Set(["remote-auth", "ssh-key", "host-key"]);

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
        <button
          type="button"
          className="button brand-branch"
          aria-expanded={branchPanelOpen}
          onClick={() => setBranchPanelOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to switch branches" : "Branches"}
        >
          <strong>Forgeline</strong>
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="button toolbar-history"
          aria-expanded={historyPanelOpen}
          onClick={() => setHistoryPanelOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to see its history" : "History"}
        >
          <History size={15} strokeWidth={1.5} aria-hidden="true" />
          History
        </button>
        <button
          type="button"
          className="button toolbar-simple"
          aria-pressed={simpleMode}
          onClick={toggleSimple}
          title={
            simpleMode
              ? "Turn Simple mode off to see branches, staging, and the graph again."
              : "Two buttons — Save and Send — and plain wording. Nothing becomes unreachable."
          }
        >
          <ToggleLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {simpleMode ? "Simple: on" : "Simple: off"}
        </button>
        <button
          type="button"
          className="button toolbar-doctor"
          aria-expanded={doctorOpen}
          onClick={() => setDoctorOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to check it" : "Gitignore doctor"}
        >
          <Stethoscope size={15} strokeWidth={1.5} aria-hidden="true" />
          Check
        </button>
        <button
          type="button"
          className="button toolbar-ssh"
          aria-expanded={sshOpen}
          onClick={() => setSshOpen((v) => !v)}
          title="SSH keys"
        >
          <KeyRound size={15} strokeWidth={1.5} aria-hidden="true" />
          Keys
        </button>
        <button
          type="button"
          className="button toolbar-note"
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to note it" : "A note about this repository"}
        >
          <StickyNote size={15} strokeWidth={1.5} aria-hidden="true" />
          Note
        </button>
        <button
          type="button"
          className="button toolbar-release"
          aria-expanded={releaseOpen}
          onClick={() => setReleaseOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to release it" : "Releases"}
        >
          <Tag size={15} strokeWidth={1.5} aria-hidden="true" />
          Release
        </button>
        <button
          type="button"
          className="button toolbar-stash"
          aria-expanded={stashPanelOpen}
          onClick={() => setStashPanelOpen((v) => !v)}
          disabled={selectedId === null}
          title={selectedId === null ? "Open a repository to use stashes" : "Stashes"}
        >
          <Inbox size={15} strokeWidth={1.5} aria-hidden="true" />
          Stashes
          {stashCount > 0 ? <span className="badge-with mono">{stashCount}</span> : null}
        </button>
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

        {signIn !== null ? (
          <SignInPrompt
            authFailure={signIn.authFailure}
            onDismiss={() => {
              setSignIn(null);
              // "Not now" dismisses the prompt, never the git error: the card
              // stays on screen with the option to sign in later.
            }}
            onSignedIn={() => setSignIn({ authFailure: false })}
            onClose={() => setSignIn(null)}
          />
        ) : null}

        {releaseOpen && selectedId !== null ? (
          <ReleasePanel
            repoId={selectedId}
            onChanged={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
            onClose={() => setReleaseOpen(false)}
          />
        ) : null}

        {stashPanelOpen && selectedId !== null ? (
          <StashPanel
            repoId={selectedId}
            hasChanges={files.length > 0}
            onChanged={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
            onClose={() => setStashPanelOpen(false)}
          />
        ) : null}

        {historyPanelOpen && selectedId !== null ? (
          <HistoryPanel repoId={selectedId} onError={reportError} onClose={() => setHistoryPanelOpen(false)} />
        ) : null}

        {conflictOpen && selectedId !== null ? (
          <ConflictResolver
            repoId={selectedId}
            onChanged={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
            onClose={() => setConflictOpen(false)}
          />
        ) : null}

        {doctorOpen && selectedId !== null ? (
          <DoctorPanel
            repoId={selectedId}
            onChanged={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
            onClose={() => setDoctorOpen(false)}
          />
        ) : null}

        {sshOpen ? (
          <SshPanel onError={reportError} onNote={setNote} onClose={() => setSshOpen(false)} />
        ) : null}

        {noteOpen && selectedId !== null ? (
          <NotePanel repoId={selectedId} onError={reportError} onClose={() => setNoteOpen(false)} />
        ) : null}

        {branchPanelOpen && selectedId !== null ? (
          <BranchPanel
            repoId={selectedId}
            onChanged={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
            onClose={() => { setBranchPanelOpen(false); setNote(null); }}
          />
        ) : null}

        {note !== null ? <p className="message muted work-note">{note}</p> : null}

        {simpleMode && selectedId !== null ? (
          <SimpleBar
            repoId={selectedId}
            changeCount={files.length}
            onSaved={() => void refreshChanges()}
            onError={reportError}
            onNote={setNote}
          />
        ) : null}

        {!simpleMode ? (
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
        ) : null}
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
