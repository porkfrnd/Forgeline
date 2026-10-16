import { useCallback, useEffect, useState } from "react";
import {
  isActionError,
  listSshKeys,
  type ActionError,
  type SshKeyInfo,
} from "../app/git";

/**
 * SSH key help.
 *
 * The failure that stops a beginner is not a wrong key, it is no key at all.
 * So this lists what exists, and when a private key has no public half it says
 * that in those words, because that is the one state where `git push` answers
 * "Permission denied (publickey)" and nothing explains it.
 *
 * The public half is the only key that is ever shown, copied, or returned. The
 * private one appears only as a fact: it exists, at this path.
 */

export interface SshPanelProps {
  onError: (error: ActionError) => void;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function SshPanel({ onError, onNote, onClose }: SshPanelProps) {
  const [keys, setKeys] = useState<SshKeyInfo[] | null>(null);
  const [dir, setDir] = useState<string>("");
  const [copied, setCopied] = useState<string | null>(null);
  const [providers, setProviders] = useState<Array<{ name: string; url: string }>>([]);

  const refresh = useCallback(async () => {
    const result = await listSshKeys();
    if (isActionError(result)) {
      onError(result);
      return;
    }
    setKeys(result.keys);
    setDir(result.dir);
    setProviders(result.providers);
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = useCallback(
    async (text: string, name: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(name);
        onNote(`Copied ${name}.`);
      } catch {
        // A clipboard that is refused — no permission, no secure context — gets
        // the text shown in a box to select instead, which still works.
        onNote("This browser would not let Forgeline copy it. The key is on the page to select.");
      }
    },
    [onNote],
  );

  return (
    <section className="panel ssh-panel" data-ticks>
      <span className="label">SSH keys</span>
      <p className="message">
        An SSH key is what lets git talk to GitHub, GitLab, or Bitbucket without a password. Forgeline
        reads the keys you already have and never creates one without asking.
      </p>

      {keys === null ? null : keys.length === 0 ? (
        <p className="message">
          There are no SSH keys in <span className="mono">{dir}</span> yet. That is the normal state of a
          new computer, and it is why the first push asks you to sign in instead.
        </p>
      ) : (
        <ul className="ssh-list">
          {keys.map((key) => (
            <li key={key.path} className="ssh-row">
              <span className="mono">{key.name}</span>
              <span className="message muted ssh-path">{key.path}</span>
              {key.publicKey === null ? (
                <span className="ssh-flag" data-kind="missing">
                  this private key has no public half — git will ask for one and not be able to find it
                </span>
              ) : (
                <>
                  <pre className="ssh-key mono">{key.publicKey.trim()}</pre>
                  <button type="button" className="button" onClick={() => void copy(key.publicKey ?? "", key.name)}>
                    {copied === key.name ? "Copied" : "Copy the public key"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="ssh-providers">
        <span className="label">Where a key goes</span>
        <ul className="ssh-provider-list">
          {providers.map((provider) => (
            <li key={provider.name}>
              <a href={provider.url} target="_blank" rel="noreferrer noopener">
                {provider.name} — add an SSH key
              </a>
            </li>
          ))}
        </ul>
        <p className="message muted">
          A private key is never shown, copied, or sent anywhere by this panel. Generating one without a
          password is offered rather than asked for here, so a passphrase typed into a web form never ends
          up in a shell history; you can add one afterwards with{" "}
          <span className="mono">ssh-keygen -p</span>.
        </p>
      </div>

      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
