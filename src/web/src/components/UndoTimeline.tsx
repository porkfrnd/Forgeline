import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { fetchJournal, undoEntry, type JournalEntry } from "../app/git.js";

/**
 * The Undo timeline.
 *
 * Newest first, one row per journaled action, with the plain-English
 * description, when it happened, and the exact git command behind a toggle.
 *
 * The slot rule applies here too, and it is the reason this looks the way it
 * does: an Undo button is drawn only for an entry whose recovery has been
 * proven. An entry that reached a remote, or one with no written undo plan, is
 * labelled "Cannot be undone" with the reason in one sentence — it is not
 * disabled, not greyed out with a tooltip, and not stubbed, all of which would
 * imply a button that might one day work.
 */
export function UndoTimeline({
  repoPath,
  onChanged,
  closeRef,
  onClose,
}: {
  /** The selected repo's FILESYSTEM PATH, which is what a journal entry
   *  records. The opaque registry ID is deliberately not accepted here: the
   *  journal is keyed by path because a path is what git and the user both
   *  recognise, and comparing an id against a path would silently match
   *  nothing and show an empty timeline. */
  repoPath: string | null;
  onChanged?: () => void;
  closeRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCommand, setShowCommand] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setEntries(await fetchJournal());
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Close on Escape, and return focus to the button that opened this panel —
  // the same contract the appearance panel keeps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      onClose();
      closeRef?.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeRef]);

  const runUndo = async (entry: JournalEntry): Promise<void> => {
    setPending(entry.id);
    setConfirming(null);
    try {
      const res = await undoEntry(entry.id);
      if (!res.ok) {
        setMessage(res.title);
        return;
      }
      setMessage(null);
      await load();
      void onChanged?.();
    } finally {
      setPending(null);
    }
  };

  const shown = repoPath ? entries.filter((e) => e.repoPath === repoPath) : entries;

  return (
    <div
      className="panel journal"
      role="dialog"
      aria-modal="false"
      aria-label="Undo timeline"
    >
      <div className="journal-head">
        <p className="label">
          <History size={14} strokeWidth={1.5} aria-hidden="true" /> Undo timeline
        </p>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>

      {message !== null && (
        <p className="message">{message}</p>
      )}

      {loading ? (
        <p className="muted">Reading the journal…</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          Nothing has happened yet. Every action that changes a repo is recorded
          here, newest first.
        </p>
      ) : (
        <ul className="row-list">
          {shown.map((entry) => {
            const when = new Date(entry.at);
            const time = Number.isNaN(when.getTime())
              ? entry.at
              : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const busy = pending === entry.id;
            const isConfirming = confirming === entry.id;
            const movedHead =
              entry.refs.before.head !== null &&
              entry.refs.after.head !== null &&
              entry.refs.before.head !== entry.refs.after.head;
            return (
              <li key={entry.id} className="row journal-row">
                <div className="journal-main">
                  <p className="journal-description">{entry.description}</p>
                  <p className="muted journal-meta">
                    <span>{time}</span>
                    {movedHead ? (
                      <span>
                        HEAD moved{" "}
                        <span className="mono">{entry.refs.before.head?.slice(0, 7)}</span> →{" "}
                        <span className="mono">{entry.refs.after.head?.slice(0, 7)}</span>
                      </span>
                    ) : (
                      <span>no ref change</span>
                    )}
                    {entry.snapshotRef ? (
                      <span>
                        snapshot saved: <span className="mono">{entry.snapshotRef.replace("refs/forgeline/", "")}</span>
                      </span>
                    ) : null}
                  </p>
                  {showCommand === entry.id && entry.command ? (
                    <p className="journal-command mono">{entry.command}</p>
                  ) : null}
                  {entry.undoable ? (
                    <button
                      type="button"
                      className="button link"
                      aria-expanded={showCommand === entry.id}
                      onClick={() =>
                        setShowCommand((v) => (v === entry.id ? null : entry.id))
                      }
                    >
                      {showCommand === entry.id ? "Hide command" : "Show command"}
                    </button>
                  ) : (
                    <p className="journal-note">
                      Cannot be undone.{" "}
                      {entry.notUndoableReason ??
                        "This action reached a remote, so undoing it here would not undo it there."}
                    </p>
                  )}
                </div>
                <div className="journal-actions">
                  {entry.undoable ? (
                    isConfirming ? (
                      <>
                        <p className="journal-confirm">
                          Undo this? A snapshot is taken first, so this can itself
                          be undone.
                        </p>
                        <button
                          type="button"
                          className="button primary"
                          disabled={busy}
                          onClick={() => void runUndo(entry)}
                        >
                          {busy ? "Undoing…" : "Undo it"}
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => setConfirming(entry.id)}
                      >
                        <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
                        {busy ? "Undoing…" : "Undo"}
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
