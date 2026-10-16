import { useCallback, useEffect, useState } from "react";
import { isActionError, readNote, writeNote, type ActionError } from "../app/git";

/**
 * A per-repository note.
 *
 * Stored in the app's data folder and never inside the repository, because a
 * file written into the user's working tree shows up in their next `git status`
 * and gets committed by accident. The key is the repository path, so the same
 * folder always has the same note.
 */

export interface NotePanelProps {
  repoId: string | null;
  onError: (error: ActionError) => void;
  onClose: () => void;
}

export function NotePanel({ repoId, onError, onClose }: NotePanelProps) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (repoId === null) return;
    let live = true;
    void readNote(repoId).then(
      (result) => {
        if (!live) return;
        if (isActionError(result)) onError(result);
        else setText(result.text);
      },
      () => {
        if (live) setText("");
      },
    );
    // A repository switch reloads the note, so the note following the repo is
    // a rule and not a race.
    return () => {
      live = false;
    };
  }, [onError, repoId]);

  const save = useCallback(async () => {
    if (repoId === null || text === null) return;
    setBusy(true);
    try {
      const outcome = await writeNote(repoId, text);
      if (isActionError(outcome)) {
        onError(outcome);
        return;
      }
      setSaved(true);
      // The confirmation is removed by a re-render rather than a timer, so a
      // user who types again is not left reading "Saved" over unsaved text.
      setTimeout(() => setSaved(false), 2000);
    } catch {
      onError({
        ok: false,
        code: "transport",
        title: "Forgeline could not save the note.",
        explanation: "The note is still in the box, so nothing was lost.",
      });
    } finally {
      setBusy(false);
    }
  }, [onError, repoId, text]);

  if (repoId === null) return null;

  return (
    <section className="panel note-panel">
      <span className="label">A note about this repository</span>
      <p className="message muted">
        Kept on this computer, in Forgeline's own folder — never inside the repository, so it never shows
        up in a <span className="mono">git status</span> and never gets committed by accident.
      </p>
      <form
        className="note-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor="note-text" className="note-label">
          What is worth remembering about this one?
        </label>
        <textarea
          id="note-text"
          className="input note-text"
          rows={6}
          value={text ?? ""}
          placeholder="For example: where the deploy key lives, or why the CI is off."
          onChange={(event) => setText(event.target.value)}
        />
        <div className="note-actions">
          <button type="submit" className="button primary" disabled={text === null || busy}>
            {saved ? "Saved" : "Save the note"}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}
