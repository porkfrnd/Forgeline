import { useState } from "react";
import type { ChangeFile } from "../app/git.js";
import { stageFiles, unstageFiles } from "../app/git.js";

/** One changed file in the file list: its status letter, staged/unstaged
 *  flags, and buttons to stage or unstage the whole file. Clicking the row
 *  opens the file in the diff viewer. */
export function FileList({
  files,
  repoId,
  onSelect,
  onChange,
}: {
  files: ChangeFile[];
  repoId: string;
  onSelect: (path: string) => void;
  onChange?: () => void;
}) {
  const [staging, setStaging] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const stageFile = async (file: ChangeFile) => {
    setStaging((s) => new Set([...s, file.path]));
    try {
      const res = await stageFiles(repoId, [file.path]);
      if (!res.ok) {
        setMessage(`Could not stage ${file.path}: ${res.title}`);
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
        setMessage(`Could not unstage ${file.path}: ${res.title}`);
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
      <div className="panel" data-ticks>
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
    <section className="panel file-list" data-ticks>
      <p className="label">Changed files</p>
      <ul className="row-list">
        {files.map((file) => {
          const isStaged = file.staged && !file.unstaged;
          const isUnstaged = !file.staged && file.unstaged;
          const isBoth = file.staged && file.unstaged;
          const busy = staging.has(file.path);
          return (
            <li
              key={file.path}
              className="row file-row"
              onClick={() => onSelect(file.path)}
            >
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
              <span className="file-path">{file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}</span>
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
