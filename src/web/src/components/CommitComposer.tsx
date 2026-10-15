import { useState } from "react";
import type { ChangeFile } from "../app/git.js";
import { commit } from "../app/git.js";

/** The sanity-check card and commit form. Shows which staged files will be
 *  committed, a message textarea, and the Commit button. Only appears when
 *  there is at least one staged file. */
export function CommitComposer({
  repoId,
  stagedFiles,
  onCommitted,
}: {
  repoId: string;
  stagedFiles: ChangeFile[];
  onCommitted: () => void;
}) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCommit = async () => {
    if (!message.trim()) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await commit(repoId, message.trim());
      if (!res.ok) {
        setError(`Commit failed: ${res.title}`);
        return;
      }
      setMessage("");
      onCommitted();
    } finally {
      setCommitting(false);
    }
  };

  return (
    <section className="panel commit-composer" data-ticks>
      <div className="commit-header">
        <p className="label">Commit</p>
        <p className="muted">
          {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} staged
        </p>
      </div>
      <ul className="row-list commit-file-list">
        {stagedFiles.map((file) => (
          <li key={file.path} className="row commit-file-row">
            <span className="file-letter">{file.letter}</span>
            <span className="file-path">
              {file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
            </span>
          </li>
        ))}
      </ul>
      <textarea
        className="input mono"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Describe this commit…"
        rows={4}
        aria-label="Commit message"
      />
      <p className="muted">{message.length} characters</p>
      {error && <p className="message">{error}</p>}
      <button
        className="button primary"
        disabled={committing || message.trim().length === 0}
        onClick={handleCommit}
      >
        {committing ? "Committing…" : "Commit staged changes"}
      </button>
    </section>
  );
}
