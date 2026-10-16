import { useCallback, useEffect, useState } from "react";
import {
  abortOperation,
  continueMerge,
  isActionError,
  keepBoth,
  readConflictSide,
  readConflicts,
  resolveConflict,
  writeResolvedFile,
  type ActionError,
  type ConflictEntry,
} from "../app/git";

/**
 * The conflict resolver.
 *
 * Three answers per file — ours, theirs, or both — and the difference is stated
 * in words rather than left to o/m and t/m. `keepBoth` stages nothing, because
 * staging a conflicted path is what makes git consider the conflict resolved,
 * and a button that says "keep both" and then hides the conflict would be the
 * worst thing this panel could do.
 */

export interface ConflictResolverProps {
  repoId: string | null;
  onChanged: () => void;
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function ConflictResolver({ repoId, onChanged, onError, onNote, onClose }: ConflictResolverProps) {
  const [entries, setEntries] = useState<ConflictEntry[] | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sides, setSides] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const index = await readConflicts(repoId);
    setEntries(index.entries);
    setOperation(index.operation);
    // The resolver closes itself when there is nothing left to resolve, so the
    // interface is never a panel about nothing.
    if (index.entries.length === 0) onClose();
  }, [onClose, repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openEntry = useCallback(
    async (entry: ConflictEntry) => {
      if (repoId === null) return;
      setOpen(open === entry.path ? null : entry.path);
      setDraft(null);
      if (open === entry.path) return;
      const wanted: Array<"ours" | "theirs" | "base"> = ["ours", "theirs", "base"];
      for (const side of wanted) {
        const result = await readConflictSide(repoId, entry.path, side);
        // A delete/modify conflict has one side missing, and that is an answer
        // rather than a failure — so an empty string is stored and the panel
        // explains that the side was deleted.
        if (isActionError(result)) setSides((prev) => ({ ...prev, [side]: "" }));
        else setSides((prev) => ({ ...prev, [side]: result.text }));
      }
    },
    [open, repoId],
  );

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
  if (entries === null) return null;

  const op = operation ?? "merge";
  const count = entries.length;

  return (
    <section className="panel conflict-resolver" data-operation={op}>
      <span className="label">Conflicts</span>
      <p className="message conflict-lead">
        {count === 1
          ? `The ${op} stopped at 1 file that the same lines were changed in on two sides. Both versions are still there — nothing has been lost, and you choose what the file should say.`
          : `The ${op} stopped at ${count} files that the same lines were changed in on two sides. Both versions are still there — nothing has been lost, and you choose what each file should say.`}
      </p>

      <ol className="conflict-list">
        {entries.map((entry) => {
          const isOpen = open === entry.path;
          return (
            <li key={entry.path} className="conflict-row">
              <button type="button" className="conflict-name" onClick={() => void openEntry(entry)}>
                {entry.path}
              </button>
              <span className="conflict-kind">
                {entry.kind === "delete-modify"
                  ? "one side deleted it, the other changed it"
                  : entry.kind === "both-modified"
                    ? "both sides changed the same lines"
                    : "needs a look"}
              </span>

              {isOpen ? (
                <div className="conflict-detail">
                  <div className="conflict-sides">
                    {(["ours", "theirs", "base"] as const).map((side) => (
                      <div key={side} className="conflict-side">
                        <span className="conflict-side-label">
                          {side === "ours" ? "This side" : side === "theirs" ? "The other side" : "Where they split"}
                        </span>
                        <pre className="conflict-pre mono">
                          {(sides[side] ?? "").trim().length > 0
                            ? sides[side]
                            : side === "base"
                              ? "(no common earlier version — this file is new on both sides)"
                              : "(that side deleted this file)"}
                        </pre>
                      </div>
                    ))}
                  </div>

                  <div className="conflict-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy !== null}
                      onClick={() => void act(`Took this side of ${entry.path}`, () => resolveConflict(repoId, entry.path, "ours"))}
                    >
                      Take this side
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy !== null}
                      onClick={() => void act(`Took the other side of ${entry.path}`, () => resolveConflict(repoId, entry.path, "theirs"))}
                    >
                      Take the other side
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy !== null}
                      onClick={() => void act(`Kept both versions of ${entry.path}`, () => keepBoth(repoId, entry.path))}
                    >
                      Keep both, I'll edit it myself
                    </button>
                  </div>

                  <form
                    className="conflict-write"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (draft === null) return;
                      void act(`Wrote my own resolution for ${entry.path}`, () =>
                        writeResolvedFile(repoId, entry.path, draft),
                      );
                    }}
                  >
                    <label htmlFor={`conflict-draft-${entry.path}`}>Or type the resolution yourself:</label>
                    <textarea
                      id={`conflict-draft-${entry.path}`}
                      className="input mono conflict-textarea"
                      rows={6}
                      value={draft ?? ""}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <button type="submit" className="button primary" disabled={draft === null || busy !== null}>
                      Save this as the resolution
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="conflict-footer">
        <button
          type="button"
          className="button primary"
          disabled={busy !== null || count > 0}
          onClick={() => void act(`Finished the ${op}`, () => continueMerge(repoId, op))}
        >
          {count > 0 ? `${count} left to decide` : `Finish the ${op}`}
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy !== null}
          onClick={() => void act(`Abandoned the ${op}`, () => abortOperation(repoId, op))}
        >
          Abandon it and get back to before
        </button>
        <button type="button" className="button" onClick={onClose}>
          Leave it unresolved for now
        </button>
      </div>
    </section>
  );
}
