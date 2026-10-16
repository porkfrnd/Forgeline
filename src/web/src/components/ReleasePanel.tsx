import { useCallback, useEffect, useState } from "react";
import { isActionError, makeRelease, readReleasePlan, type ActionError, type ReleasePlanInfo } from "../app/git";

/**
 * The release manager.
 *
 * It states the plan before it acts, because a release is the one action whose
 * consequences are easiest to describe in advance: this is the version now, this
 * is what it becomes, and these are the commits it contains. Nothing here
 * commits, and the panel says so — deciding the message is the one part of a
 * release that should not be automatic.
 */

export interface ReleasePanelProps {
  repoId: string | null;
  onChanged: () => void;
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function ReleasePanel({ repoId, onChanged, onError, onNote, onClose }: ReleasePanelProps) {
  const [plan, setPlan] = useState<ReleasePlanInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [level, setLevel] = useState<"patch" | "minor" | "major">("patch");
  const [changelog, setChangelog] = useState(true);
  const [tag, setTag] = useState(true);
  // Committing is the default, so this starts on and the off case is the one
  // the user asks for. "Everything written, nothing committed" is a release
  // that failed in a way a person has to notice, so it is not the design.
  const [commit, setCommit] = useState(true);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const result = await readReleasePlan(repoId);
    if (isActionError(result)) {
      onError(result);
      return;
    }
    setPlan(result.plan);
  }, [onError, repoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (label: string, call: () => Promise<unknown>) => {
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
    [onChanged, onError, onNote, refresh],
  );

  if (repoId === null || plan === null) return null;

  const nextVersion = bumpTo(plan.currentVersion, level);
  const tagName = `v${nextVersion}`;
  const releaseable = plan.hasChanges && nextVersion !== null;

  return (
    <section className="panel release-panel">
      <span className="label">Releases</span>

      {plan.currentVersion === null ? (
        <p className="message muted">
          There is no package.json here, so there is no version number to bump. Add one and this has
          something to release.
        </p>
      ) : null}

      {plan.currentVersion !== null && nextVersion === null ? (
        <p className="message muted">
          This version ({plan.currentVersion}) is not in the three-number form a bump can be worked out
          from, so Forgeline is not going to guess what comes after it. Type the version you want into
          package.json and it can read it from there.
        </p>
      ) : null}

      {plan.currentVersion !== null && nextVersion !== null ? (
        <>
          <dl className="release-plan">
            <dt>Now</dt>
            <dd className="mono">{plan.currentVersion}</dd>
            <dt>After this</dt>
            <dd className="mono">{nextVersion}</dd>
            <dt>Since the last tag</dt>
            <dd className="mono">{plan.latestTag ?? "no tags yet"}</dd>
            <dt>Commits that would go in</dt>
            <dd className="mono">{plan.commitsSince.length}</dd>
            <dt>git describe</dt>
            <dd className="mono">{plan.describe}</dd>
          </dl>

          <fieldset className="release-choice">
            <legend>How big a release?</legend>
            {(["patch", "minor", "major"] as const).map((option) => (
              <label key={option} className="release-option">
                <input
                  type="radio"
                  name="release-level"
                  value={option}
                  checked={level === option}
                  onChange={() => setLevel(option)}
                />
                <span>
                  {option === "patch"
                    ? "patch — fixes only, 1.2.3 → 1.2.4"
                    : option === "minor"
                      ? "minor — something new, 1.2.3 → 1.3.0"
                      : "major — something changed the way it is used, 1.2.3 → 2.0.0"}
                </span>
              </label>
            ))}
          </fieldset>

          <label className="release-check">
            <input type="checkbox" checked={changelog} onChange={(event) => setChangelog(event.target.checked)} />
            <span>
              Write the <span className="mono">CHANGELOG.md</span> entry for these {plan.commitsSince.length}{" "}
              commits
            </span>
          </label>

          <label className="release-check">
            <input
              type="checkbox"
              checked={commit && tag}
              disabled={!commit}
              onChange={(event) => setTag(event.target.checked)}
            />
            <span>
              Tag the release commit as <span className="mono">{tagName}</span>
              {!commit ? <span className="display-hint"> a tag has to name the release, so this needs the commit</span> : null}
            </span>
          </label>

          {tag ? (
            <p className="message muted release-warn">
              A tag is a pointer to a commit. Deleting one is the whole of undoing it, and a tag others
              have already pulled disappears for them too — so it is offered here rather than as an undo.
            </p>
          ) : null}

          <label className="release-check">
            <input type="checkbox" checked={commit} onChange={(event) => setCommit(event.target.checked)} />
            <span>
              Commit it as <span className="mono">release: v{nextVersion}</span>
            </span>
          </label>
          {!commit ? (
            <p className="message muted release-warn">
              Unticking this leaves the version and the changelog written but nothing committed, so the
              tag — if you asked for one — lands on a commit that is not the release. That is a release
              that failed in a way you have to notice, so it is offered rather than hidden.
            </p>
          ) : null}

          {plan.commitsSince.length > 0 ? (
            <div className="release-commits">
              <span className="label">Commits this release contains</span>
              <ol className="release-commit-list">
                {plan.commitsSince.slice(0, 40).map((commit) => (
                  <li key={commit.sha} className="release-commit">
                    <span className="mono">{commit.short}</span>
                    <span>{commit.subject}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="message muted">
              Nothing has been committed since the last tag, so there is no release to make yet.
            </p>
          )}

          <button
            type="button"
            className="button primary"
            disabled={!releaseable || busy !== null}
            onClick={() =>
              void act(`Made the ${nextVersion} release`, () =>
              makeRelease(repoId, level, { changelog, tag, commit }),
            )
            }
          >
            {releaseable ? `Make the ${nextVersion} release` : "Nothing to release"}
          </button>

          <p className="message muted">
            This writes the version, the changelog, the tag, and the commit — and then pushes nothing.
            A release only leaves this computer when you push it.
          </p>
        </>
      ) : null}

      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

/** The three-number bump, restated on the client so the buttons can say what
 *  they mean before anything is sent. The server re-reads the version and
 *  refuses to write if it has changed in the meantime, so this is a label
 *  rather than a decision. */
function bumpTo(current: string | null, level: "patch" | "minor" | "major"): string | null {
  if (current === null) return null;
  const match = current.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
