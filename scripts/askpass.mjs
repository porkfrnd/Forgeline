#!/usr/bin/env node
/**
 * git-askpass helper.
 *
 * git asks for a credential by running this script with a prompt on argv and
 * reading the answer from stdout. It is the ONE place a token is ever handed to
 * git, and the spec is emphatic about why it has to be here and nowhere else:
 * a token in a command line shows up in `ps`, in a remote URL it lands in
 * `.git/config` on disk, and in a log either way. Through askpass it exists
 * only as an environment variable on a single short-lived process.
 *
 * Two prompts matter over HTTPS. git asks for the username, then the password.
 * GitHub accepts `x-access-token` as the username and an OAuth token as the
 * password, so the answer to the first is a fixed string and the answer to the
 * second comes from `FORGELINE_TOKEN`.
 *
 * This script prints, and never logs. Nothing about the token is written to
 * stderr on the success path, because stderr is the one stream Forgeline shows
 * the user verbatim.
 */

const FORGELINE_TOKEN = "FORGELINE_TOKEN";

/** What to echo back. `null` means "I do not know", which must fail loudly
 *  rather than echo something plausible. */
function answer(prompt) {
  const text = prompt.trim();
  if (/^username/i.test(text)) return process.env.GIT_ASKPASS_USERNAME ?? "x-access-token";
  if (/^password/i.test(text)) {
    const token = process.env[FORGELINE_TOKEN];
    return typeof token === "string" && token.length > 0 ? token : null;
  }
  // An unlabelled prompt is git asking for a password; treat it as one.
  const token = process.env[FORGELINE_TOKEN];
  return typeof token === "string" && token.length > 0 ? token : null;
}

const prompt = process.argv.slice(2).join(" ");
const value = answer(prompt);

if (value === null) {
  // Two lines, and neither is the prompt: it may already contain the host.
  process.stderr.write("forgeline-askpass: Forgeline has no token for this prompt\n");
  process.exit(1);
}

process.stdout.write(`${value}\n`);
