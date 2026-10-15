import { useCallback, useEffect, useState } from "react";
import type { ActionError } from "../app/git";

/**
 * Fetch, pull, push — the three buttons that talk to a remote.
 *
 * Two things this component deliberately does NOT do. It never asks the user
 * to sign in first: a remote that already works through SSH keys on the
 * machine, or a public HTTPS one, just works, and asking for an account before
 * trying is the behaviour the spec calls lazy-sign-in out for. And it hides
 * itself entirely when the repository has no remote, because a button that
 * cannot possibly do anything is a slot rule violation however honest its
 * disabled tooltip would be.
 */

export interface RemoteBarProps {
  /** The opaque registry id the API keys on. It is NOT the filesystem path —
   *  passing a path here silently returns a 404, which is exactly the bug that
   *  made the undo timeline look permanently empty once already. */
  repoId: string | null;
  ahead: number;
  behind: number;
  /** Called after an operation so the status can be re-read. */
  onChanged: () => void;
  /** A failure is reported the same way every other failure in the app is,
   *  through the same ActionError shape the rest of the workbench speaks. */
  onError: (error: ActionError) => void;
}

type Busy = "fetch" | "pull" | "push" | null;

export function RemoteBar({ repoId, ahead, behind, onChanged, onError }: RemoteBarProps) {
  const [remotes, setRemotes] = useState<{ name: string }[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const list = await api<{ remotes?: { name: string }[] }>(repoId, "remotes");
    setRemotes(list.remotes ?? []);
  }, [repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: "fetch" | "pull" | "push", remote?: string) => {
      if (repoId === null) return;
      setBusy(action);
      setNote(null);
      try {
        const outcome = await api<Record<string, unknown>>(repoId, action, { remote }, "POST");
        if (outcome.ok !== true) {
          onError({
            ok: false,
            code: String(outcome.code ?? "git-error"),
            title: String(outcome.title ?? "That did not work."),
            explanation:
              typeof outcome.explanation === "string" ? outcome.explanation : undefined,
            fixes: Array.isArray(outcome.fixes) ? outcome.fixes : undefined,
            raw: typeof outcome.raw === "string" ? outcome.raw : undefined,
            command: typeof outcome.command === "string" ? outcome.command : undefined,
          });
          return;
        }
        const changed = outcome.changed === true;
        setNote(readOutcome(action, changed));
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
    [onChanged, onError, repoId],
  );

  // No remote means nothing here can act. A local-only repository is a real
  // and useful thing to be, so the bar is absent rather than disabled.
  if (repoId === null) return null;
  if (remotes === null) return null;
  if (remotes.length === 0) return null;

  return (
    <section className="work-remote panel" data-ticks>
      <span className="label">Remote</span>
      <button
        type="button"
        className="button"
        disabled={busy !== null}
        onClick={() => void run("fetch")}
        title="Download from the remote without touching your files"
      >
        {busy === "fetch" ? "Fetching…" : "Fetch"}
      </button>
      <button
        type="button"
        className="button"
        disabled={busy !== null}
        onClick={() => void run("pull")}
        title="Download and merge into this branch"
      >
        {busy === "pull" ? "Pulling…" : "Pull"}
      </button>
      <button
        type="button"
        className="button"
        disabled={busy !== null}
        onClick={() => void run("push")}
        title="Publish this branch's commits"
      >
        {busy === "push" ? "Pushing…" : "Push"}
      </button>
      <span className="remote-counts mono">
        {ahead > 0 ? `${ahead} ahead` : ""}
        {ahead > 0 && behind > 0 ? ", " : ""}
        {behind > 0 ? `${behind} behind` : ""}
        {ahead === 0 && behind === 0 ? "level with the remote" : ""}
      </span>
      {note !== null ? <span className="message muted">{note}</span> : null}
    </section>
  );
}

/** One line saying what actually happened. Git is chatty and vague about
 *  it by turn, so this is written from whether anything moved rather than
 *  from parsing its output. */
function readOutcome(action: string, changed: boolean): string {
  const nouns: Record<string, [string, string]> = {
    fetch: ["Nothing new was waiting on the remote.", "Fetched without touching your files."],
    pull: ["Already up to date.", "Brought the remote's work into this branch."],
    push: ["Nothing new to publish.", "Published this branch's commits."],
  };
  const pair = nouns[action] ?? ["Nothing changed.", "Done."];
  return changed ? pair[1] : pair[0];
}

/** A repo-scoped API call. Thin on purpose: there is no transport wrapper to
 *  disagree with the top-level app's own fetch conventions. */
async function api<T>(
  repoId: string,
  tail: string,
  body?: Record<string, unknown>,
  method: "GET" | "POST" = "GET",
): Promise<T> {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/${tail}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json().catch(() => ({}))) as T;
}
