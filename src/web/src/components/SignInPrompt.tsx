import { useCallback, useEffect, useRef, useState } from "react";
import {
  pollDeviceLogin,
  readAuth,
  signOut,
  startDeviceLogin,
  type AuthState,
  type DeviceLogin,
} from "../app/git";

/**
 * Sign-in.
 *
 * This is the spec's lazy prompt, and the laziness is the point: nothing here
 * is drawn on launch, and nothing about having no account is marked as a
 * problem. It appears when the user chooses Connect, or when a remote refuses a
 * command for want of a credential — which is the moment it is actually wanted.
 *
 * `Not now` dismisses it and leaves the git error in plain English with the
 * option to sign in later, which the spec asks for by name.
 */

export interface SignInPromptProps {
  /** True when a remote refused a command because nobody is signed in. This is
   *  the trigger that makes the prompt appear on its own. */
  authFailure: boolean;
  /** Dismiss without signing in. Never hides the underlying git error. */
  onDismiss: () => void;
  /** Called once sign-in completes so the failed action can be retried. */
  onSignedIn: () => void;
  /** Close the prompt entirely. */
  onClose: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; login: DeviceLogin }
  | { kind: "polling"; login: DeviceLogin; attempt: number }
  | { kind: "authorizing"; login: DeviceLogin }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "signed-in"; note?: string }
  | { kind: "failed"; title: string; explanation?: string };

export default function SignInPrompt({ authFailure, onDismiss, onSignedIn, onClose }: SignInPromptProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [auth, setAuth] = useState<AuthState | null>(null);
  const timer = useRef<number | null>(null);
  const [autoStarted, setAutoStarted] = useState(false);

  const refresh = useCallback(async () => {
    setAuth(await readAuth());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Stop any pending poll when the prompt goes away, so a closed prompt is not
  // still polling GitHub behind the user's back.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const begin = useCallback(async () => {
    setPhase({ kind: "starting" });
    const started = await startDeviceLogin();
    if ("ok" in started && started.ok) {
      setPhase({ kind: "waiting", login: started.start });
      return;
    }
    setPhase({
      kind: "failed",
      title: "title" in started ? started.title : "That did not work.",
      explanation: "explanation" in started ? started.explanation : undefined,
    });
  }, []);

  // Start on its own when a remote refused for want of a credential. Drawn only
  // if the user is not already signed in, and only once per prompt.
  useEffect(() => {
    if (!authFailure || autoStarted) return;
    if (auth === null) return;
    if (auth.signedIn || !auth.configured) return;
    setAutoStarted(true);
    void begin();
  }, [auth, authFailure, autoStarted, begin]);

  /**
   * One poll, on a timer, while a code is outstanding.
   *
   * An effect rather than a recursive callback, so unmounting the prompt
   * cancels it and a re-render does not start a second one. `slow_down` is not
   * an error: GitHub's own answer lengthens the interval, and the next timeout
   * just waits longer.
   */
  useEffect(() => {
    const login = phase.kind === "waiting" || phase.kind === "polling" ? phase.login : null;
    if (login === null || auth === null || !auth.signedIn) return;
    if (timer.current !== null) window.clearTimeout(timer.current);

    timer.current = window.setTimeout(() => {
      void (async () => {
        const polled = await pollDeviceLogin();
        if (polled.state === "pending") {
          setPhase({ kind: "polling", login, attempt: 0 });
          return;
        }
        if (polled.state === "slow-down") {
          setPhase({ kind: "polling", login: { ...login, intervalSeconds: polled.intervalSeconds }, attempt: 0 });
          return;
        }
        if (polled.state === "expired") {
          setPhase({ kind: "expired" });
          return;
        }
        if (polled.state === "denied") {
          setPhase({ kind: "denied" });
          return;
        }
        if (polled.state === "authorized") {
          setPhase({ kind: "signed-in" });
          await refresh();
          onSignedIn();
          return;
        }
        setPhase({ kind: "expired" });
      })();
    }, Math.max(1, login.intervalSeconds) * 1000);

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [auth, onSignedIn, phase, refresh]);

  if (auth === null) return null;

  // Already signed in: show the account, and offer a way out of it.
  if (auth.signedIn && auth.user !== null) {
    return (
      <section className="panel signin">
        <span className="label">Signed in</span>
        {auth.user.avatarUrl !== null ? (
          <img className="signin-avatar" src={auth.user.avatarUrl} alt="" width={28} height={28} />
        ) : null}
        <strong>{auth.user.name ?? auth.user.login}</strong>
        <span className="muted mono">@{auth.user.login}</span>
        {auth.storeMode === "memory" && auth.storeNotice !== null ? (
          <p className="message muted signin-notice">{auth.storeNotice}</p>
        ) : null}
        <button type="button" className="button" onClick={() => void signOutNow()}>
          Sign out
        </button>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </section>
    );
  }

  const signOutNow = async (): Promise<void> => {
    const out = await signOut();
    if ("ok" in out && out.ok) {
      setPhase({ kind: "idle" });
      if (typeof out.note === "string") setPhase({ kind: "signed-in", note: out.note });
      await refresh();
      return;
    }
    setPhase({ kind: "failed", title: "Could not sign out.", explanation: "Try again in a moment." });
  };

  const startOver = () => setPhase({ kind: "idle" });

  return (
    <section className="panel signin">
      <span className="label">Sign in</span>

      {!auth.configured ? (
        <>
          <p className="message">Sign-in is not set up yet.</p>
          <p className="muted">{auth.reason}</p>
          {auth.storeMode === "memory" && auth.storeNotice !== null ? (
            <p className="message muted signin-notice">{auth.storeNotice}</p>
          ) : null}
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </>
      ) : null}

      {auth.configured && phase.kind === "idle" ? (
        <>
          <p className="message">
            Forgeline only needs an account for things that touch someone else's computer:
            pushing, pulling, and opening a pull request. Everything else works without one.
          </p>
          <button type="button" className="button primary" onClick={() => void begin()}>
            Sign in with GitHub
          </button>
          {authFailure ? (
            <button type="button" className="button" onClick={onDismiss}>
              Not now
            </button>
          ) : (
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          )}
        </>
      ) : null}

      {auth.configured && phase.kind === "starting" ? (
        <p className="message">Asking GitHub for a code…</p>
      ) : null}

      {auth.configured && (phase.kind === "waiting" || phase.kind === "polling") ? (
        <>
          <p className="message">Enter this code on GitHub:</p>
          <p className="signin-code mono">{phase.login.userCode}</p>
          <a
            className="button primary"
            href={phase.login.verificationUri}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open GitHub
          </a>
          <p className="muted">
            {phase.kind === "polling"
              ? "Waiting for you to finish…"
              : "Once you have entered it, Forgeline will notice on its own."}
          </p>
          <button type="button" className="button" onClick={onClose}>
            I will do it in a moment
          </button>
        </>
      ) : null}

      {auth.configured && phase.kind === "denied" ? (
        <>
          <p className="message">That sign-in was cancelled on GitHub.</p>
          <button type="button" className="button" onClick={startOver}>
            Try again
          </button>
        </>
      ) : null}

      {auth.configured && phase.kind === "expired" ? (
        <>
          <p className="message">That code expired before it was used.</p>
          <button type="button" className="button primary" onClick={() => void begin()}>
            Get a new code
          </button>
        </>
      ) : null}

      {phase.kind === "signed-in" ? (
        <>
          <p className="message">
            {phase.note ?? "You are signed in. Try the action again and it should work now."}
          </p>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </>
      ) : null}

      {phase.kind === "failed" ? (
        <>
          <p className="message">{phase.title}</p>
          {phase.explanation !== undefined ? <p className="muted">{phase.explanation}</p> : null}
          <button type="button" className="button" onClick={startOver}>
            Back
          </button>
        </>
      ) : null}
    </section>
  );
}
