import { useCallback, useEffect, useState } from "react";
import {
  isActionError,
  readDoctor,
  untrackFile,
  writeGitignoreNow,
  type ActionError,
  type DoctorReport,
} from "../app/git";

/**
 * The gitignore doctor.
 *
 * Three questions it answers: what is this project, what should be ignored, and
 * what is already tracked that should not be. All three are asked of the working
 * tree, because the useful answer is the one about *this* directory.
 *
 * Everything it suggests is a string the user reads and then decides about. The
 * two actions it does offer each state what they leave alone — writing the
 * .gitignore never rewrites it, and untracking never deletes the file.
 */

export interface DoctorPanelProps {
  repoId: string | null;
  onChanged: () => void;
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function DoctorPanel({ repoId, onChanged, onError, onNote, onClose }: DoctorPanelProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const result = await readDoctor(repoId);
    if (isActionError(result)) {
      onError(result);
      return;
    }
    setReport(result.report);
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

  if (repoId === null || report === null) return null;

  const findable = report.tracked.length;

  return (
    <section className="panel doctor-panel">
      <span className="label">Gitignore doctor</span>

      <p className="message">
        This looks like {report.kind.name}.
        {report.kind.matched.length > 0 ? (
          <>
            {" "}
            Called that because it has <span className="mono">{report.kind.matched.join(", ")}</span>.
          </>
        ) : null}
      </p>

      {/* The .gitignore action is offered whether or not one exists, and that
          matters: a repository that already has a .gitignore is exactly the one
          where the lines worth adding are missing. Hiding the button while the
          file existed left the most common case with no way in — a design bug,
          not a missing feature. */}
      <div className="doctor-card doctor-card-note">
        <p className="message">
          {report.hasGitignore ? (
            <>
              There is a <span className="mono">.gitignore</span> here. It can still be missing the lines a{" "}
              {report.kind.id === "generic" ? "project" : "this project"} needs, though.
            </>
          ) : (
            <>
              There is no <span className="mono">.gitignore</span> here, so anything the project leaves
              lying around — build output, <span className="mono">node_modules</span>, a stray{" "}
              <span className="mono">.env</span> — would all end up in git.
            </>
          )}
        </p>
        <button
          type="button"
          className="button primary"
          disabled={busy !== null}
          onClick={() =>
            void act(report.hasGitignore ? "Added the missing lines" : "Wrote a .gitignore", () =>
              writeGitignoreNow(repoId),
            )
          }
        >
          {report.hasGitignore
            ? "Add the lines that are missing"
            : `Write the one for ${report.kind.id === "generic" ? "most projects" : "this project"}`}
        </button>
        <p className="message muted">
          This adds only the lines that are missing. Anything already in your <span className="mono">.gitignore</span>{" "}
          is left exactly as it is, in the order you put it, and it says so when there is nothing to add.
        </p>
      </div>

      {findable === 0 && report.largeFiles.length === 0 ? (
        <p className="message">
          Nothing concerning found. Nothing secret-looking is tracked and no file over 5 MB is in the
          repository.
        </p>
      ) : null}

      {findable > 0 ? (
        <>
          <span className="label">
            {findable === 1 ? "1 tracked file to look at" : `${findable} tracked files to look at`}
          </span>
          <ol className="doctor-list">
            {report.tracked.map((finding) => (
              <li key={finding.path} className="doctor-row" data-severity={finding.severity}>
                <div className="doctor-head">
                  <span className="mono">{finding.path}</span>
                  <span className="doctor-severity">{finding.severity === "warning" ? "looks like a secret" : "build output"}</span>
                </div>
                <p className="doctor-reason">{finding.reason}</p>
                <div className="doctor-actions">
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`Stopped tracking ${finding.path}`, () => untrackFile(repoId, finding.path))
                    }
                  >
                    Stop tracking it, keep the file
                  </button>
                  <span className="message muted doctor-command">
                    runs <span className="mono">{finding.command}</span> — the file stays on your disk
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {report.largeFiles.length > 0 ? (
        <>
          <span className="label">
            {report.largeFiles.length === 1 ? "1 file over 5 MB" : `${report.largeFiles.length} files over 5 MB`}
          </span>
          <ul className="doctor-large">
            {report.largeFiles.map((file) => (
              <li key={file.path}>
                <span className="mono">{file.path}</span> — {file.megabytes} MB
              </li>
            ))}
          </ul>
          <p className="message muted">
            A copy of this file is kept for every clone, so a large file makes every download of this
            repository bigger. Git LFS is the usual answer, and it is not offered here because setting it
            up changes how the repository works.
          </p>
        </>
      ) : null}

      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
