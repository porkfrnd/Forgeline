import { useCallback, useEffect, useState } from "react";
import type { FileDiff } from "../app/git.js";
import {
  fetchDiff,
  hunkToPatch,
  stageHunk,
  unstageHunk,
} from "../app/git.js";

/** The diff for one file, with a per-hunk stage/unstage toggle. When
 *  `staged` is false it shows worktree vs the index and each hunk can be
 *  staged; when true it shows the index against HEAD and each hunk can be
 *  unstaged. */
export function DiffViewer({
  repoId,
  path,
  onBack,
}: {
  repoId: string;
  path: string;
  onBack: () => void;
}) {
  const [staged, setStaged] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staging, setStaging] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchDiff(repoId, path, staged);
      setDiff(d);
      setError(null);
    } catch {
      setError("Could not load the diff.");
    }
  }, [repoId, path, staged]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleHunk = async (hunkIndex: number) => {
    if (!diff) return;
    const hunk = diff.hunks[hunkIndex];
    const patch = hunkToPatch(path, hunk);
    setStaging((s) => new Set([...s, hunkIndex]));
    try {
      const res = staged
        ? await unstageHunk(repoId, path, patch)
        : await stageHunk(repoId, path, patch);
      if (!res.ok) {
        setMessage(
          staged
            ? `Could not unstage hunk: ${res.title}`
            : `Could not stage hunk: ${res.title}`,
        );
        return;
      }
      setMessage(null);
      void load();
    } finally {
      setStaging((s) => {
        const n = new Set(s);
        n.delete(hunkIndex);
        return n;
      });
    }
  };

  if (message) {
    return (
      <div className="panel">
        <p className="message">{message}</p>
        <button className="button" onClick={() => setMessage(null)}>
          Dismiss
        </button>
        <button className="button" onClick={onBack}>
          Back to files
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <p className="message">{error}</p>
        <button className="button" onClick={onBack}>
          Back to files
        </button>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="panel">
        <p className="message muted">Loading diff…</p>
      </div>
    );
  }

  if (diff.binary) {
    return (
      <div className="panel">
        <p className="label">{path}</p>
        <p className="message">Binary file — diff not shown.</p>
        <button className="button" onClick={onBack}>
          Back to files
        </button>
      </div>
    );
  }

  const verb = staged ? "Unstage" : "Stage";
  const otherView = staged ? "Show unstaged changes" : "Show staged changes";

  return (
    <section className="panel diff-viewer">
      <div className="diff-header">
        <button className="button" onClick={onBack}>
          ← Files
        </button>
        <p className="label">{path}</p>
        <button className="button" onClick={() => setStaged((s) => !s)}>
          {otherView}
        </button>
      </div>
      <p className="muted">
        {diff.hunks.length} hunk{diff.hunks.length === 1 ? "" : "s"} •
        {verb} individual hunks, or use the file list to stage the whole file.
      </p>
      <div className="diff">
        {diff.hunks.map((hunk, i) => (
          <div key={i} className="diff-hunk">
            <div className="diff-hunk-header">{hunk.header}</div>
            <div className="diff-lines">
              {hunk.lines.map((line, j) => {
                const prefix =
                  line.kind === "add"
                    ? "+"
                    : line.kind === "del"
                      ? "-"
                      : " ";
                const lineClass =
                  line.kind === "add"
                    ? "diff-line-add"
                    : line.kind === "del"
                      ? "diff-line-del"
                      : "diff-line-context";
                const oldNo = line.oldLine ?? "";
                const newNo = line.newLine ?? "";
                return (
                  <div
                    key={j}
                    className={`diff-line ${lineClass}`}
                  >
                    <span className="diff-line-num diff-old">{oldNo}</span>
                    <span className="diff-line-num diff-new">{newNo}</span>
                    <span className="diff-line-prefix">{prefix}</span>
                    <span className="diff-line-text">{line.text}</span>
                    {line.noEol && (
                      <span className="diff-line-marker">
                        \\ No newline at end of file
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              className="button stage-hunk-btn"
              disabled={staging.has(i)}
              onClick={() => void toggleHunk(i)}
            >
              {verb} hunk
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
