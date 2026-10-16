import { useCallback, useState } from "react";
import { commitAll, isActionError, type ActionError } from "../app/git";

/**
 * Simple mode.
 *
 * One button and a box to type in: **Save**. Everything else the interface can
 * do is still available, it is just not in the way. The wording
 * is the wording a person who has never used git would use — "your changes are
 * saved on this computer" is true and specific, and "staged and committed" is
 * neither.
 *
 * The sanity check still runs before Save. Simplifying an interface never means
 * skipping the card that stops someone committing a secret.
 */

export interface SimpleBarProps {
  repoId: string | null;
  /** How many files would be saved, so the button can say what it will do. */
  changeCount: number;
  onSaved: () => void;
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
}

export function SimpleBar({ repoId, changeCount, onSaved, onError, onNote }: SimpleBarProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    if (repoId === null) return;
    setBusy(true);
    try {
      const outcome = await commitAll(repoId, message);
      if (isActionError(outcome)) {
        // The sanity check comes back as an error the same way a bad message
        // does, and the card it produces is the card the full interface shows.
        onError(outcome);
        return;
      }
      onNote("Your changes are saved on this computer.");
      setMessage("");
      onSaved();
    } catch {
      onError({
        ok: false,
        code: "transport",
        title: "Forgeline could not save.",
        explanation: "The message is still in the box, so nothing was lost.",
      });
    } finally {
      setBusy(false);
    }
  }, [message, onError, onNote, onSaved, repoId]);

  if (repoId === null) return null;

  const nothing = changeCount === 0;

  return (
    <section className="panel simple-bar">
      <p className="message">
        {nothing
          ? "Nothing has changed in this repository, so there is nothing to save."
          : changeCount === 1
            ? "1 file has changed. Saving puts a copy of all your changes on this computer that you can go back to."
            : `${changeCount} files have changed. Saving puts a copy of all your changes on this computer that you can go back to.`}
      </p>

      <form
        className="simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor="simple-message" className="simple-label">
          What changed? (a few words is plenty)
        </label>
        <input
          id="simple-message"
          className="input simple-input"
          type="text"
          value={message}
          placeholder="fixed the login page"
          onChange={(event) => setMessage(event.target.value)}
          disabled={nothing || busy}
        />
        <div className="simple-actions">
          <button type="submit" className="button primary" disabled={nothing || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      <p className="message muted simple-send">
        When you are ready to put a copy somewhere else — GitHub, GitLab, or Bitbucket — press the{" "}
        <strong>Simple: on</strong> button to bring the full view back, and <strong>Send</strong> is there.
        It is the same push either way; it just asks first whether that is where the changes should go.
      </p>
    </section>
  );
}
