import { useCallback, useEffect, useState } from "react";
import {
  createBranch,
  deleteBranch,
  listBranches,
  renameBranch,
  switchBranch,
  trackBranch,
  type ActionError,
  type BranchInfo,
} from "../app/git";

/**
 * The branch panel: switch, create, rename, delete, and adopt a remote branch.
 *
 * `switch` rather than `git checkout`, and the interface names the reason: a
 * branch called `feature` and a file called `feature` are both legal, and
 * `git switch` is the form that asks instead of guessing.
 */

export interface BranchPanelProps {
  repoId: string | null;
  /** Re-read the repository after any action that changed the working tree. */
  onChanged: () => void;
  /** Failures are reported the same way everything else in the app reports. */
  onError: (error: ActionError) => void;
  /** A message the rest of the app can show. */
  onNote: (note: string) => void;
  onClose: () => void;
}

const NEW_NAME = /^[A-Za-z0-9._/-]+$/;

export function BranchPanel({ repoId, onChanged, onError, onNote, onClose }: BranchPanelProps) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [detached, setDetached] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState("");
  /** Renaming happens inline, in the same shape as creating, rather than through
   *  `window.prompt` — a native dialog would be the one control in the app that
   *  ignores every colour, radius, and focus rule in the theme. */
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const list = await listBranches(repoId);
    setBranches(list.branches);
    setDetached(list.detached);
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
          // A translator card, or a transport failure — both are shaped the
          // same way from here, which is why the report path is shared.
          onError(
            outcome as unknown as ActionError,
          );
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

  if (repoId === null || branches === null) return null;

  const local = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);
  /** Captured once so the callbacks below do not have to re-narrow `current`,
   *  which TypeScript will not carry into a closure on its own. */
  const current: BranchInfo | undefined = local.find((b) => b.current);
  const canCreate = NEW_NAME.test(newName.trim()) && !branches.some((b) => b.name === newName.trim());

  return (
    <section className="panel branch-panel" data-ticks>
      <span className="label">Branches</span>

      {detached ? (
        <p className="message muted">
          HEAD is on a commit rather than a branch, so commits here belong to no branch. Switch to
          one, or make a branch from where you are, before committing.
        </p>
      ) : null}

      <ul className="branch-list">
        {local.map((branch) => (
          <li
            key={branch.name}
            className={branch.current ? "branch-row is-current" : "branch-row"}
          >
            <button
              type="button"
              className="branch-name"
              disabled={branch.current || busy !== null}
              onClick={() =>
                void act(`Switched to ${branch.name}`, () => switchBranch(repoId, branch.name))
              }
            >
              {branch.name}
            </button>

            <span className="branch-counts mono">
              {branch.counts !== null && (branch.counts.ahead > 0 || branch.counts.behind > 0)
                ? `${branch.counts.ahead} ahead, ${branch.counts.behind} behind`
                : ""}
            </span>

            {branch.hasUnmergedWork ? (
              <span className="branch-flag" title="This branch has commits no other branch has.">
                unmerged
              </span>
            ) : null}

            {!branch.current && confirmDelete === branch.name ? (
              <span className="discard-confirm">
                <button
                  type="button"
                  className="button danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`Deleted ${branch.name}`, () => deleteBranch(repoId, branch.name, true))
                  }
                >
                  Delete anyway
                </button>
                <button type="button" className="button" onClick={() => setConfirmDelete(null)}>
                  Keep
                </button>
              </span>
            ) : !branch.current ? (
              <button
                type="button"
                className="branch-delete"
                title="Delete this branch"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(branch.name)}
              >
                Delete
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {remotes.length > 0 ? (
        <>
          <span className="label">On the remote</span>
          <ul className="branch-list">
            {remotes.map((branch) => (
              <li key={`${branch.name}`} className="branch-row">
                <span className="branch-name is-remote">{branch.name}</span>
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null || local.some((b) => b.name === branch.name)}
                  onClick={() => void act(`Started tracking ${branch.name}`, () => trackBranch(repoId, branch.name))}
                >
                  Get it here
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form
        className="branch-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate) return;
          const from = newFrom.trim().length > 0 ? newFrom.trim() : undefined;
          void act(`Created ${newName.trim()}`, () => createBranch(repoId, newName.trim(), from));
          setNewName("");
          setNewFrom("");
        }}
      >
        <label htmlFor="branch-name">New branch</label>
        <input
          id="branch-name"
          className="input mono"
          value={newName}
          placeholder="feature-name"
          onChange={(event) => setNewName(event.target.value)}
        />
        <input
          className="input mono"
          value={newFrom}
          placeholder="from (optional)"
          onChange={(event) => setNewFrom(event.target.value)}
        />
        <button type="submit" className="button primary" disabled={!canCreate || busy !== null}>
          Create
        </button>
      </form>

      {current != null && !detached && !renaming ? (
        <button type="button" className="button" onClick={() => { setRenaming(true); setRenameTo(current.name); }}>
          Rename {current.name}
        </button>
      ) : null}

      {current != null && !detached && renaming ? (
        <form
          className="branch-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const from = current;
            const next = renameTo.trim();
            if (from === undefined || next.length === 0 || next === from.name) return;
            setRenaming(false);
            void act(`Renamed to ${next}`, () => renameBranch(repoId, next));
          }}
        >
          <label htmlFor="branch-rename-to">Rename to</label>
          <input
            id="branch-rename-to"
            className="input mono"
            value={renameTo}
            onChange={(event) => setRenameTo(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={current != null && renameTo.trim() === current.name}>
            Rename
          </button>
          <button type="button" className="button" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
