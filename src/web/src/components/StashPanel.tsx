import { useCallback, useEffect, useState } from "react";
import { dropStash, listStashes, restoreStash, saveStash, type ActionError, type StashInfo } from "../app/git";

/**
 * The stash panel.
 *
 * The whole stack is visible at once, because a stack with hidden entries is
 * the thing people lose work in. `Restore` leaves the entry on the stack and
 * `Restore and remove` takes it off, and the difference is stated in words on
 * both buttons rather than spelled `apply`/`pop`.
 */

export interface StashPanelProps {
  repoId: string | null;
  /** Whether the working tree currently has something to put aside. */
  hasChanges: boolean;
  onChanged: () => void;
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function StashPanel({ repoId, hasChanges, onChanged, onError, onNote, onClose }: StashPanelProps) {
  const [stashes, setStashes] = useState<StashInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    setStashes(await listStashes(repoId));
  }, [repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (label: string, call: () => Promise<unknown>) => {
      if (repoId === null) return;
      setBusy(label);
      try {
        const outcome = (await call()) as Record<string, unknown>;
        if (outcome.ok !== true) {
          onError(outcome as unknown as ActionError);
          return;
        }
        onNote(`${label} — done.`);
        await refresh();
        onChanged();
      } catch {
        onError({
          ok: false,
          code: "transport",
          title: "Forgeline could not finish that request.",
          explanation: "The server may still be running it. Try again in a moment.",
        });
      } finally {
        setBusy(null);
      }
    },
    [onChanged, onError, onNote, refresh, repoId],
  );

  if (repoId === null) return null;

  const canSave = message.trim().length === 0 || message.trim().length > 1;

  return (
    <section className="panel stash-panel">
      <span className="label">Stashes</span>

      <form
        className="stash-save"
        onSubmit={(event) => {
          event.preventDefault();
          if (!hasChanges) return;
          void act("Put the working tree aside", () =>
            saveStash(repoId, message.trim().length > 0 ? message.trim() : undefined),
          );
          setMessage("");
        }}
      >
        <input
          className="input mono"
          value={message}
          placeholder="a name for what this is (optional)"
          onChange={(event) => setMessage(event.target.value)}
        />
        <button type="submit" className="button primary" disabled={!hasChanges || !canSave || busy !== null}>
          Put it aside
        </button>
      </form>

      {!hasChanges ? (
        <p className="message muted">
          Everything here is committed, so there is nothing to put aside yet.
        </p>
      ) : null}

      {(stashes ?? []).length === 0 ? (
        <p className="message muted">No stashes. Putting work aside keeps this working tree clean without losing it.</p>
      ) : null}

      <ol className="stash-list">
        {(stashes ?? []).map((stash) => (
          <li key={stash.ref} className="stash-row">
            <div className="stash-head">
              <span className="stash-index mono">#{stash.index}</span>
              <span className="stash-message">{stash.message}</span>
            </div>
            <div className="stash-meta mono">
              <span>{stash.parent}</span>
              <span>{stash.date}</span>
            </div>
            <div className="stash-actions">
              <button
                type="button"
                className="button primary"
                disabled={busy !== null}
                onClick={() => void act("Restored the stash", () => restoreStash(repoId, stash.ref, false))}
              >
                Restore
              </button>
              <button
                type="button"
                className="button"
                disabled={busy !== null}
                onClick={() => void act("Restored the stash and took it off the stack", () => restoreStash(repoId, stash.ref, true))}
              >
                Restore and take it off the stack
              </button>
              {confirmDrop === stash.ref ? (
                <span className="discard-confirm">
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmDrop(null);
                      void act("Dropped the stash", () => dropStash(repoId, stash.ref));
                    }}
                  >
                    Drop it
                  </button>
                  <button type="button" className="button" onClick={() => setConfirmDrop(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="branch-delete"
                  title="Drop this stash"
                  disabled={busy !== null}
                  onClick={() => setConfirmDrop(stash.ref)}
                >
                  Drop
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
