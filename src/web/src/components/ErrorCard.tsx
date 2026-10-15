import { useState } from "react";
import type { ActionError } from "../app/git.js";

/**
 * The plain-English error card.
 *
 * git's own output is written for people who already know git, so a failure
 * arrives as a card with a title, an explanation, and buttons that act. The
 * raw output is one click away and never removed.
 *
 * Two rules shape this component:
 *
 *  - **A fix button only appears when there is an action to run.** The server
 *    offers the full catalogue, including fixes for features that aren't built
 *    yet; this component draws only the ones `onFix` knows how to run. Drawing
 *    a button for a feature that doesn't exist is a dead control, and a dead
 *    control teaches people not to trust the working ones.
 *  - **No rule matches means the card still appears.** The generic card shows
 *    the raw output with a copy button, so an unknown error is never hidden.
 */
export function ErrorCard({
  error,
  /** The fix ids this build can actually run. Anything else is left out. */
  availableFixes,
  onFix,
  onDismiss,
}: {
  error: ActionError;
  availableFixes: string[];
  onFix: (fixId: string) => void;
  onDismiss?: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const drawable = (error.fixes ?? []).filter((f) => availableFixes.includes(f.id));

  const copyRaw = async () => {
    const text = error.raw ?? error.command ?? error.title;
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A browser without clipboard permission leaves the button doing
      // nothing rather than lying about a copy it did not make.
      setCopied(false);
    }
  };

  return (
    <div className="panel error-card" role="alert" data-ticks>
      <p className="label">What happened</p>
      <p className="error-title">{error.title}</p>
      {error.explanation !== undefined ? (
        <p className="message muted">{error.explanation}</p>
      ) : null}

      {drawable.length > 0 ? (
        <div className="error-fixes">
          {drawable.map((fix) => (
            <button
              key={fix.id}
              type="button"
              className="button primary"
              onClick={() => onFix(fix.id)}
            >
              {fix.label}
            </button>
          ))}
        </div>
      ) : (
        /* No fix here can run yet. Saying so beats drawing a button that
           would do nothing. */
        <p className="message muted">
          There is no one-click fix for this in Forgeline yet. The git output below
          shows exactly what to run.
        </p>
      )}

      <div className="error-actions">
        <button
          type="button"
          className="button link"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide details" : "Show details"}
        </button>
        <button type="button" className="button link" onClick={() => void copyRaw()}>
          {copied ? "Copied" : "Copy details"}
        </button>
        {onDismiss !== undefined ? (
          <button type="button" className="button" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>

      {showRaw ? (
        <pre className="error-raw mono" data-testid="error-raw">
          {error.raw !== undefined && error.raw.length > 0
            ? error.raw
            : error.command ?? error.title}
        </pre>
      ) : null}
    </div>
  );
}
