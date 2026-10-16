import { useState } from "react";
import type { ChangeFile } from "../app/git.js";
import { stageFiles, unstageFiles, discardFiles } from "../app/git.js";
import type { ActionError } from "../app/git.js";

/** One changed file in the file list: its status letter, staged/unstaged
 *  flags, and buttons to stage or unstage the whole file. Clicking the row
 *  opens the file in the diff viewer. */
export function FileList({
  files,
  repoId,
  onSelect,
  onChange,
  onError,
}: {
  files: ChangeFile[];
  repoId: string;
  onSelect: (path: string) => void;
  onChange?: () => void;
  /** A failed action becomes a plain-English card owned by the workbench,
   *  which can offer the fixes the server described. */
  onError?: (error: ActionError) => void;
}) {
  const [staging, setStaging] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);

  const stageFile = async (file: ChangeFile) => {
    setStaging((s) => new Set([...s, file.path]));
    try {
      const res = await stageFiles(repoId, [file.path]);
      if (!res.ok) {
        // The card carries the whole error, fixes included, so the failure is
        // handed up rather than reduced to one sentence the user can't act on.
        onError?.(res);
        return;
      }
      setMessage(null);
      void onChange?.();
    } finally {
      setStaging((s) => {
        const n = new Set(s);
        n.delete(file.path);
        return n;
      });
    }
  };

  const unstageFile = async (file: ChangeFile) => {
    setStaging((s) => new Set([...s, file.path]));
    try {
      const res = await unstageFiles(repoId, [file.path]);
      if (!res.ok) {
        // The card carries the whole error, fixes included, so the failure is
        // handed up rather than reduced to one sentence the user can't act on.
        onError?.(res);
        return;
      }
      setMessage(null);
      void onChange?.();
    } finally {
      setStaging((s) => {
        const n = new Set(s);
        n.delete(file.path);
        return n;
      });
    }
  };

  const discardFile = async (file: ChangeFile) => {
    setDiscarding(file.path);
    setConfirming(null);
    try {
      const res = await discardFiles(repoId, [file.path]);
      if (!res.ok) {
        // The card carries the whole error, fixes included, so the failure is
        // handed up rather than reduced to one sentence the user can't act on.
        onError?.(res);
        return;
      }
      setMessage(null);
      void onChange?.();
    } finally {
      setDiscarding(null);
    }
  };

  const letterLabel: Record<ChangeFile["letter"], string> = {
    M: "Modified",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
    U: "Conflicted",
  };

  if (message) {
    return (
      <div className="panel">
        <p className="message">{message}</p>
        <button
          className="button"
          onClick={() => setMessage(null)}
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <section className="panel file-list">
      <p className="label">Changed files</p>
      <ul className="row-list">
        {files.map((file) => {
          const isStaged = file.staged && !file.unstaged;
          const isUnstaged = !file.staged && file.unstaged;
          const isBoth = file.staged && file.unstaged;
          const busy = staging.has(file.path);
          return (
            <li key={file.path} className="row file-row">
              <span className="file-letter">{file.letter}</span>
              <span className="file-status">
                {isStaged
                  ? "staged"
                  : isUnstaged
                    ? "unstaged"
                    : isBoth
                      ? "staged + unstaged"
                      : "untracked"}
              </span>
              {/* The path, not the row, is what opens the diff. A row-level
                  handler would fire when a button inside it is clicked, which
                  is how "Stage" used to also open the diff viewer. */}
              <button
                type="button"
                className="file-path-button"
                onClick={() => onSelect(file.path)}
              >
                {file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
              </button>
              <div className="file-actions">
                {(!isStaged || isBoth) && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void stageFile(file)}
                  >
                    Stage
                  </button>
                )}
                {(isStaged || isBoth) && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void unstageFile(file)}
                  >
                    Unstage
                  </button>
                )}
              </div>
              {confirming === file.path ? (
                <div className="discard-confirm">
                  <p className="discard-warning">
                    Throw away every change in <span className="mono">{file.path}</span>? A
                    snapshot is saved first, and the Undo timeline will name it.
                  </p>
                  <button
                    type="button"
                    className="button primary"
                    disabled={discarding === file.path}
                    onClick={() => void discardFile(file)}
                  >
                    {discarding === file.path ? "Discarding…" : "Discard changes"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="button discard-button"
                  onClick={() => setConfirming(file.path)}
                >
                  Discard
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted">
        {files.length === 0
          ? "No changed files."
          : `Click a file to open its diff. ${letterLabel[files[0].letter]} files show their status letter.`}
      </p>
    </section>
  );
}
