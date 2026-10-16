import { useCallback, useEffect, useMemo, useState } from "react";
import { readHistory, readBlame, isActionError, type ActionError, type BlameLine, type CommitInfo } from "../app/git";

/**
 * The history panel: the log, the graph, and blame.
 *
 * The graph is drawn from the parents each commit reports, one lane per distinct
 * branch tip, because that is the only thing the data actually supports. It is
 * not a reconstructed lane diagram — it is a picture of "these commits are
 * connected", and labelling it anything more precise would be a lie the picture
 * then has to keep.
 */

export interface HistoryPanelProps {
  repoId: string | null;
  onError: (error: ActionError) => void;
  onClose: () => void;
}

const GLYPHS = ["●", "●", "●", "●"] as const;

export function HistoryPanel({ repoId, onError, onClose }: HistoryPanelProps) {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [selected, setSelected] = useState<CommitInfo | null>(null);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const [blameBusy, setBlameBusy] = useState<string | null>(null);

  const refresh = useCallback(async (branch?: string) => {
    if (repoId === null) return;
    const list = await readHistory(repoId, branch);
    setCommits(list.commits);
    setFrom(list.from);
  }, [repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Which lane each commit sits in. A commit with one parent is in the lane of
   * its branch; a merge gets two, one per parent, which is what makes the fork
   * visible.
   */
  const lanesBySha = useMemo(() => {
    const order: string[] = [];
    for (const commit of commits ?? []) {
      for (const parent of commit.parents) {
        if (!order.includes(parent)) order.push(parent);
      }
    }
    const map = new Map<string, number>();
    for (const commit of commits ?? []) map.set(commit.sha, 0);
    order.forEach((sha, i) => map.set(sha, i % GLYPHS.length));
    return map;
  }, [commits]);

  const openBlame = useCallback(
    async (path: string) => {
      if (repoId === null) return;
      setBlameBusy(path);
      setBlamePath(path);
      try {
        const result = await readBlame(repoId, path);
        if (isActionError(result)) {
          onError(result);
          setBlame(null);
          return;
        }
        setBlame(result.lines);
      } catch {
        onError({
          ok: false,
          code: "transport",
          title: "Forgeline could not read that file's history.",
          explanation: "The server may still be running it. Try again in a moment.",
        });
        setBlame(null);
      } finally {
        setBlameBusy(null);
      }
    },
    [onError, repoId],
  );

  if (repoId === null) return null;

  return (
    <section className="panel history-panel">
      <div className="history-head">
        <span className="label">History</span>
        <select
          className="input history-from"
          value={from ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            setFrom(next.length > 0 ? next : null);
            void refresh(next.length > 0 ? next : undefined);
          }}
        >
          <option value="">Every branch</option>
          <option value="HEAD">Only this branch</option>
        </select>
        <button type="button" className="button" onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>

      {commits === null ? <p className="message muted">Reading the history.</p> : null}
      {commits !== null && commits.length === 0 ? (
        <p className="message muted">
          No commits yet. The first one makes a history.
        </p>
      ) : null}

      <ol className="history-list">
        {(commits ?? []).map((commit) => {
          const lane = lanesBySha.get(commit.sha) ?? 0;
          const glyph = GLYPHS[lane];
          return (
            <li key={commit.sha} className={commit === selected ? "history-row is-open" : "history-row"}>
              <button
                type="button"
                className="history-line"
                onClick={() => setSelected(commit === selected ? null : commit)}
              >
                <span className="history-glyph mono" title={`lane ${lane + 1}`} aria-hidden="true">
                  {glyph}
                </span>
                <span className="history-subject">{commit.subject}</span>
                {commit.refs.length > 0 ? (
                  <span className="history-refs mono">{commit.refs.join("  ")}</span>
                ) : null}
                <span className="history-meta mono">
                  {commit.short} · {commit.authorName}
                </span>
              </button>

              {commit === selected ? (
                <div className="history-detail">
                  <p className="mono history-dates">{new Date(commit.date).toLocaleString()}</p>
                  <dl className="history-fields">
                    <dt>Commit</dt>
                    <dd className="mono">{commit.sha}</dd>
                    <dt>Parents</dt>
                    <dd className="mono">
                      {commit.parents.length === 0 ? "none (this is the first)" : commit.parents.join("  ")}
                    </dd>
                    <dt>Author</dt>
                    <dd>
                      {commit.authorName} &lt;{commit.authorEmail}&gt;
                    </dd>
                    {commit.isMerge ? <dt>Kind</dt> : null}
                    {commit.isMerge ? <dd>a merge — two parents, two branches</dd> : null}
                  </dl>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="blame-block">
        <span className="label">Blame a file</span>
        <form
          className="blame-form"
          onSubmit={(event) => {
            event.preventDefault();
            const path = blamePath;
            if (path === null || path.trim().length === 0) return;
            void openBlame(path.trim());
          }}
        >
          <input
            className="input mono"
            value={blamePath ?? ""}
            placeholder="a file's path, e.g. src/index.ts"
            onChange={(event) => setBlamePath(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={blameBusy !== null}>
            {blameBusy === null ? "Show who changed each line" : "Reading"}
          </button>
        </form>

        {blame === null && blameBusy === null ? (
          <p className="message muted">
            Blame reads the last commit to touch each line of a file. It is the fastest way to answer
            &ldquo;who changed this, and when&rdquo; without reading the whole history.
          </p>
        ) : null}

        {blame !== null && blame.length === 0 ? (
          <p className="message muted">Nothing to blame in that file.</p>
        ) : null}

        {blame !== null && blame.length > 0 ? (
          <ul className="blame-list">
            {blame.map((line) => (
              <li key={line.line} className="blame-row">
                <span className="blame-line mono">{line.line}</span>
                <span className="blame-sha mono">{line.short}</span>
                <span className="blame-author">{line.authorName}</span>
                <span className="blame-date mono">{new Date(line.date).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
