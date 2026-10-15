import type { ForgeError } from "../../shared/types.js";

/**
 * The error translator.
 *
 * git's own output is written for people who already know git. "fatal:
 * refusing to merge unrelated histories" is precise and completely opaque to
 * everyone else, so this module turns it into a sentence a person can act on
 * plus buttons that do the acting.
 *
 * Three rules hold across every rule here:
 *
 *  1. **The caller passes everything git printed.** git sends some failures to
 *     stdout and others to stderr — a merge conflict, "nothing to commit", and
 *     a detached HEAD all arrive on stdout — so this takes the combined
 *     output. Patterns were verified by running real git and capturing what it
 *     actually said; several differ from what memory suggests.
 *  2. **Never hide an error.** Output matching no rule falls through to the
 *     generic card with the raw text and a copy button. Silence is never the
 *     fallback.
 *  3. **Never offer a fix that cannot run.** A rule declares the fixes its
 *     error warrants; whether a button is drawn for one is the interface's
 *     decision, because it knows which features exist. The catalogue is built
 *     in full now, and a fix for an unbuilt feature stays offered-but-undrawn
 *     rather than becoming a dead button.
 */

export interface ErrorRule {
  /** Tested against everything git printed, plus the argv that ran. */
  matches: (output: string, command: string) => boolean;
  /** Build the card body. The raw output is supplied by `translateError`, so
   *  a rule never has to remember to pass it through. */
  build: (context: BuildContext) => Omit<ForgeError, "raw">;
}

/** What a builder may look at to name the file, branch, or host involved,
 *  captured from the same output that failed so a card never has to guess. */
export interface BuildContext {
  /** Files named by a conflict, or an empty list. */
  conflictFiles: string[];
  /** The branch mentioned, when one was. */
  branch: string | null;
  /** The host git was trying to reach, when one was. */
  host: string | null;
}

/** Case-insensitive contains-all. git's wording is stable enough to rely on. */
const has = (output: string, ...needles: string[]) =>
  needles.every((n) => output.toLowerCase().includes(n.toLowerCase()));

/** Case-insensitive contains-any, for when git uses one of several phrasings. */
const anyHas = (output: string, ...needles: string[]) =>
  needles.some((n) => output.toLowerCase().includes(n.toLowerCase()));

/** Pull conflict files out of git's conflict lines. It names the file at the
 *  end of the line, once per file. */
function conflictFiles(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/CONFLICT \([^)]*\): (.+)$/);
    if (match?.[1] === undefined) continue;
    const tail = match[1].trim();

    // Two shapes, both from real git, and they need different handling:
    //
    //   CONFLICT (content): Merge conflict in f.txt
    //   CONFLICT (modify/delete): f.txt deleted in del and modified in HEAD.
    //     Version HEAD of f.txt left in tree.
    //
    // An earlier single pattern grabbed "everything after the last ' in '",
    // which read the second shape as `del and modified in HEAD.  Version HEAD
    // of f.txt left in tree.` — a filename nobody could use. So the shape is
    // chosen first, and the name is read from the right end of it.
    let name: string;
    if (tail.startsWith("Merge conflict in ")) {
      name = tail.slice("Merge conflict in ".length).trim();
    } else if (tail.startsWith("Rename/rename conflict")) {
      // "Rename/rename conflict in a.txt, renamed to b.txt" — the new name is
      // the one in the working tree, and the one the user has to resolve.
      const renamed = tail.match(/renamed to (.+)$/);
      name = renamed?.[1] !== undefined ? renamed[1].split(",")[0].trim() : tail;
    } else {
      // The name leads the line and may be followed by a sentence, so it is
      // the first token — and a trailing period belongs to the sentence.
      name = tail.split(/\s+/)[0] ?? "";
      name = name.replace(/\.$/, "");
    }
    if (name.length > 0) found.add(name);
  }
  return [...found];
}

/** The host from a URL git printed, port included. An earlier version
 *  trimmed to the first dot-label, which turned "127.0.0.1:8080" into
 *  "127" — a host that means nothing to anyone. */
function hostOf(output: string, command: string): string | null {
  const source = `${output}\n${command}`;
  const m = source.match(/https?:\/\/([^/\s'"]+)/);
  const ssh = source.match(/git@([^:\s'"]+):/);
  return m?.[1] ?? ssh?.[1] ?? null;
}

/** "branch 'name'" from phrasing like "no upstream configured for branch 'main'". */
function branchOf(output: string): string | null {
  const m = output.match(/branch ['"]([^'"]+)['"]/);
  return m?.[1] ?? null;
}

const contextFor = (output: string, command: string): BuildContext => ({
  conflictFiles: conflictFiles(output),
  branch: branchOf(output),
  host: hostOf(output, command),
});

/** The generic card. Every rule that matches nothing lands here, and this is
 *  the last line of defence against hiding anything. */
export const GENERIC_ERROR: ForgeError = {
  code: "git-error",
  title: "Git reported a problem.",
  explanation:
    "This is git's own output, unchanged. Forgeline has no plain-English card for this one yet, so it is shown exactly as it was printed.",
  fixes: [],
  raw: "",
};

export function translateError(output: string, command: string): ForgeError {
  const text = output.trim();
  const rule = RULES.find((r) => r.matches(text, command));
  if (rule === undefined) return { ...GENERIC_ERROR, raw: text };
  return { ...rule.build(contextFor(text, command)), raw: text };
}

/* ------------------------------------------------------------------ *
 * The catalogue. Ordered most-specific first, because a message can
 * contain several of these phrases and only one is the real cause. Every
 * pattern below quotes wording verified by running real git.
 * ------------------------------------------------------------------ */

const RULES: ErrorRule[] = [
  /* ---- conflicts and merges ---- */
  {
    matches: (output) => has(output, "CONFLICT (") || has(output, "Merge conflict in"),
    build: (ctx) => ({
      code: "merge-conflict",
      title:
        ctx.conflictFiles.length === 1
          ? `Two changes touched the same lines in ${ctx.conflictFiles[0]}.`
          : ctx.conflictFiles.length > 1
            ? "Two changes touched the same lines in several files."
            : "Two changes touched the same lines in one file.",
      explanation:
        ctx.conflictFiles.length > 0
          ? `The merge stopped at ${ctx.conflictFiles.join(", ")}. Both versions are still there, marked with conflict markers, and nothing has been lost. Work through them one at a time, or abandon the merge to get back to where you were.`
          : "The merge stopped where two changes overlapped. Both versions are still there, marked with conflict markers, and nothing has been lost.",
      fixes: [
        { id: "open-conflict-resolver", label: "Open the conflict resolver" },
        { id: "abort-merge", label: "Abort the merge" },
      ],
    }),
  },
  {
    // Verified wordings: "Merging is not possible because you have unmerged
    // files", "Committing is not possible because you have unmerged files",
    // "Exiting because of an unresolved conflict".
    matches: (output) =>
      has(output, "is not possible because you have unmerged files") ||
      has(output, "unresolved conflict") ||
      has(output, "not concluded your merge"),
    build: () => ({
      code: "merge-in-progress",
      title: "A merge is still in progress.",
      explanation:
        "An earlier merge stopped partway through, so this command can't run until you finish it or abandon it. The files from that merge are still on disk and nothing has been lost.",
      fixes: [
        { id: "open-conflict-resolver", label: "Fix the conflicts" },
        { id: "abort-merge", label: "Abort the merge" },
      ],
    }),
  },
  {
    matches: (output) => has(output, "refusing to merge", "unrelated histories"),
    build: () => ({
      code: "unrelated-histories",
      title: "These two histories don't share a starting point.",
      explanation:
        "The two branches have no commit in common, so git won't join them automatically. Allowing it makes one merge commit where they are stitched together. That is usually what you want when a repository was started twice by accident.",
      fixes: [{ id: "allow-unrelated-histories", label: "Explain, then allow with confirmation" }],
    }),
  },
  {
    // Verified: "! [rejected]  main -> main (fetch first)" plus "Updates were
    // rejected because the remote contains work that you do not have locally".
    matches: (output) =>
      has(output, "rejected", "fetch first") ||
      has(output, "non-fast-forward", "failed to push some refs") ||
      has(output, "remote contains work that you do not"),
    build: () => ({
      code: "push-rejected",
      title: "Someone else pushed changes you don't have yet.",
      explanation:
        "The remote has commits that aren't in your copy. Pull them in, sort out anything that overlaps, then push again.",
      fixes: [{ id: "pull-then-push", label: "Pull, then push" }],
    }),
  },
  {
    // Verified: "Not possible to fast-forward" comes from merge --ff-only
    // refusing a remote that has moved on.
    matches: (output) =>
      has(output, "not possible to fast-forward") || has(output, "cannot fast-forward"),
    build: () => ({
      code: "diverged",
      title: "Your branch and the remote have diverged.",
      explanation:
        "You have commits the remote doesn't, and it has commits you don't. Neither is newer, so git needs you to choose: merge the remote's work into yours, or replay yours on top of it.",
      fixes: [
        { id: "merge-remote", label: "Merge the remote into your branch" },
        { id: "rebase-remote", label: "Replay your commits on top" },
      ],
    }),
  },

  /* ---- working tree safety ---- */
  {
    // Verified: "error: Your local changes to the following files would be
    // overwritten by checkout:" followed by "Aborting".
    matches: (output) =>
      has(output, "local changes", "would be overwritten") ||
      has(output, "local changes to the following files would be overwritten"),
    build: () => ({
      code: "local-changes",
      title: "You have unsaved changes this action would overwrite.",
      explanation:
        "The command would replace files you have edited since the last commit, and git stops rather than deciding for you. Put the changes somewhere safe first — a stash keeps them, a commit makes them permanent.",
      fixes: [
        { id: "stash-and-continue", label: "Stash the changes and continue" },
        { id: "commit-first", label: "Commit them first" },
      ],
    }),
  },
  {
    // Verified: "HEAD detached at <sha>" arrives on stdout from git status.
    matches: (output) =>
      has(output, "detached head") || has(output, "head detached at") || has(output, "detached at"),
    build: () => ({
      code: "detached-head",
      title: "You're not on a branch.",
      explanation:
        "This computer is looking at a commit directly rather than at a branch, so new commits would belong to nowhere and could be lost. Create a branch here and the work continues on it.",
      fixes: [{ id: "create-branch", label: "Create a branch here" }],
    }),
  },
  {
    // Verified: "No local changes to save". git prints this on **stdout** and
    // exits 0, so a caller checking the exit code reports a stash that does not
    // exist — which is why src/server/git/stash.ts counts the stack instead of
    // trusting the status. It is not a failure, so there are no fixes: the work
    // is already committed and there is nothing for a card's buttons to act on.
    matches: (output) => has(output, "no local changes to save"),
    build: () => ({
      code: "nothing-to-stash",
      title: "There is nothing to put aside.",
      explanation:
        "Everything in this working tree is already committed, so there is nothing for a stash to hold. Make an edit and it becomes available.",
      fixes: [],
    }),
  },
  {
    // Verified: "On branch main nothing to commit, working tree clean" on stdout.
    matches: (output) =>
      has(output, "nothing to commit") && has(output, "working tree clean"),
    build: () => ({
      code: "nothing-to-commit",
      title: "There's nothing new to save.",
      explanation:
        "Every change you have made is already committed, so there is no commit to create. This is a normal state rather than a problem.",
      fixes: [],
    }),
  },
  {
    // Verified: "error: pathspec 'x' did not match any file(s) known to git",
    // and "fatal: ambiguous argument 'x': unknown revision or path not in the
    // working tree".
    matches: (output) =>
      anyHas(output, "did not match any file(s) known to git", "unknown revision or path not in the working tree", "ambiguous argument") ||
      anyHas(output, "pathspec", "did not match any file"),
    build: () => ({
      code: "pathspec",
      title: "Git couldn't find the thing you named.",
      explanation:
        "A path or a commit in this request doesn't exist in this repository. Check the spelling, and whether it is in the branch you currently have checked out.",
      fixes: [{ id: "retry", label: "Try again" }],
    }),
  },

  /* ---- repository state ---- */
  {
    // Verified: "fatal: not a git repository (or any of the parent
    // directories): .git"
    matches: (output) => has(output, "not a git repository"),
    build: () => ({
      code: "not-a-repo",
      title: "This folder isn't a git project yet.",
      explanation:
        "The folder exists but git has never been told to track it. Initialising here creates the hidden git store and starts recording changes from now on.",
      fixes: [{ id: "init-here", label: "Initialise here" }],
    }),
  },
  {
    // Verified: "fatal: Unable to create '.../.git/index.lock': File exists."
    matches: (output) =>
      has(output, "index.lock") &&
      (has(output, "exists") || has(output, "unable to create")),
    build: () => ({
      code: "index-lock",
      title: "Another git process is running, or one crashed.",
      explanation:
        "Git locks the repository while it writes, so two things can't change it at once. Usually the other process finished and left the lock behind. Look first — removing a live git's lock can corrupt a repository.",
      fixes: [
        { id: "check-running-git", label: "Look for a running git" },
        { id: "remove-lock", label: "Remove the lock" },
      ],
    }),
  },
  {
    // Verified: "fatal: no upstream configured for branch 'main'".
    matches: (output) => has(output, "no upstream configured") || has(output, "no upstream branch"),
    build: (ctx) => ({
      code: "no-upstream",
      title: `This branch isn't published anywhere${ctx.branch !== null ? ` (${ctx.branch})` : ""}.`,
      explanation:
        "It exists only on this computer, so there is nothing to push to yet. Publishing it once will create it on the remote.",
      fixes: [{ id: "push-set-upstream", label: "Publish this branch" }],
    }),
  },
  {
    // Verified: "fatal: No configured push destination."
    matches: (output) => has(output, "no configured push destination"),
    build: () => ({
      code: "no-remote",
      title: "This repository has no remote to push to.",
      explanation:
        "There's nowhere to send the work yet. Adding a remote — usually the address you copied when the project was created — points git at it.",
      fixes: [{ id: "add-remote", label: "Add a remote" }],
    }),
  },
  {
    // "Please tell me who you are" and "unable to auto-detect email address"
    // are git's two phrasings for a missing identity.
    matches: (output) =>
      anyHas(output, "please tell me who you are", "unable to auto-detect email", "empty ident"),
    build: () => ({
      code: "no-identity",
      title: "Git doesn't know your name and email yet.",
      explanation:
        "Every commit records who made it, and this computer has never been told. Setting them once makes commits work normally afterwards; git keeps them in this repository's own settings, not in Forgeline.",
      fixes: [{ id: "set-identity", label: "Set name and email" }],
    }),
  },
  {
    // Multi-user or container mounts report this.
    matches: (output) => has(output, "dubious ownership"),
    build: () => ({
      code: "dubious-ownership",
      title: "This repository belongs to a different user.",
      explanation:
        "Git refuses to touch a repository owned by someone else on this machine, because doing so is how a shared folder gets damaged. Tell git to trust this path and it will work normally.",
      fixes: [{ id: "mark-safe-directory", label: "Trust this folder" }],
    }),
  },
  {
    matches: (output) => has(output, "remote origin already exists") || has(output, "remote", "already exists"),
    build: () => ({
      code: "remote-exists",
      title: "This repository already has a remote called origin.",
      explanation:
        "A second one under the same name isn't allowed. Look at what it points at now, then replace it if it is wrong.",
      fixes: [
        { id: "show-remote", label: "Show the remote" },
        { id: "replace-remote", label: "Replace the remote" },
      ],
    }),
  },
  {
    // Verified: "remote: 403 Unauthorized" then "The requested URL returned
    // error: 403".
    //
    // Two wordings and nothing looser. The obvious-looking third pattern,
    // "some 403 appears after some http", is a trap: a port number is digits,
    // and `http://127.0.0.1:40387` really does contain "403". That turned a
    // transient 401 into a permissions explanation and cost an afternoon, so
    // the rule now matches what git actually prints and nothing else.
    matches: (output) =>
      has(output, "returned error: 403") || has(output, "remote: 403"),
    build: (ctx) => ({
      code: "remote-auth",
      title: "The remote refused you.",
      explanation: `The server answered Forbidden${ctx.host !== null ? ` on ${ctx.host}` : ""}. This is usually a permissions problem on the server rather than a wrong password — check that this repository exists and that your account can reach it.`,
      fixes: [
        { id: "open-sign-in", label: "Open sign-in" },
        { id: "retry", label: "Try again" },
      ],
    }),
  },
  {
    // Verified: "fatal: could not read Username for 'http://host:port':
    // terminal prompts disabled".
    matches: (output) =>
      has(output, "could not read username") || has(output, "terminal prompts disabled"),
    build: (ctx) => ({
      code: "remote-auth",
      title: "The remote needs you to sign in.",
      explanation: `Git was refused at the door${ctx.host !== null ? ` (${ctx.host})` : ""} before it could send anything. Signing in gives this computer a credential it can reuse.`,
      fixes: [
        { id: "open-sign-in", label: "Open sign-in" },
        { id: "retry", label: "Try again" },
      ],
    }),
  },
  {
    // "unable to access" alone proves nothing: git prints it for a host that
    // doesn't resolve exactly as it prints it for a host that refuses a
    // credential. So the wordings that mean a credential *specifically* are
    // matched here, and the arm-wavier wording is left for the network rule
    // below — which is the safer of the two to get wrong, since "can't reach
    // the remote" is true of a refused credential too, while "you aren't
    // authorised" is not true of a typo'd hostname.
    matches: (output) =>
      has(output, "authentication failed") ||
      has(output, "could not read username") ||
      has(output, "terminal prompts disabled"),
    build: (ctx) => ({
      code: "remote-auth",
      title: "The remote needs you to sign in.",
      explanation: `This computer isn't authorised on ${ctx.host ?? "the remote"}. Signing in tells the remote who you are; nothing has been sent yet.`,
      fixes: [
        { id: "open-sign-in", label: "Open sign-in" },
        { id: "retry", label: "Try again" },
      ],
    }),
  },
  {
    // SSH's own refusal. "could not read username" earlier covers the HTTP
    // prompt variant, so this only has to catch the key message.
    matches: (output) => has(output, "permission denied") && has(output, "publickey"),
    build: () => ({
      code: "ssh-key",
      title: "This computer isn't authorised over SSH.",
      explanation:
        "The remote accepted the connection but not the key this machine offered. Adding a key to your account, or switching the remote to HTTPS and signing in, will both work.",
      fixes: [
        { id: "setup-ssh-key", label: "Set up an SSH key" },
        { id: "switch-remote-https", label: "Switch the remote to HTTPS" },
      ],
    }),
  },
  {
    matches: (output) => has(output, "host key verification failed"),
    build: (ctx) => ({
      code: "host-key",
      title: `This computer has never seen ${ctx.host ?? "the server"} before.`,
      explanation:
        "SSH won't talk to a server it can't identify until you accept its fingerprint. Check the fingerprint is the one the service publishes, then accept it.",
      fixes: [{ id: "accept-host-key", label: "Check the server's fingerprint" }],
    }),
  },
  {
    // Verified: "Could not resolve host: no-such-host-anywhere.invalid".
    //
    // This sits before the credential rule on purpose. A hostname that doesn't
    // resolve and a host that refuses a credential both print "unable to
    // access", and only one of them is about an account. Getting this order
    // backwards told a user with a typo to set up sign-in.
    matches: (output) =>
      anyHas(
        output,
        "could not resolve host",
        "connection refused",
        "network is unreachable",
        "operation timed out",
        // git's own wording for a host it can't even reach the port on.
        "unable to access",
      ) &&
      // ...but only when nothing suggests the other side answered. A refusal
      // comes with a status code or a prompt, and those belong to the
      // credential rules above.
      !anyHas(output, "returned error:", "authentication failed", "terminal prompts disabled"),
    build: (ctx) => ({
      code: "remote-unreachable",
      title: `Can't reach the remote${ctx.host !== null ? ` (${ctx.host})` : ""}.`,
      explanation:
        "Forgeline couldn't get a response, so nothing was sent. Check your connection and that the remote address is correct, then try again.",
      fixes: [{ id: "retry", label: "Try again" }],
    }),
  },
  {
    matches: (output) =>
      has(output, "repository not found") || has(output, "remote: not found") || has(output, "requested url returned error: 404"),
    build: (ctx) => ({
      code: "remote-not-found",
      title: `The remote has no such repository${ctx.host !== null ? ` on ${ctx.host}` : ""}.`,
      explanation:
        "Git signed in successfully but the project isn't there — it may have been renamed, moved to private, or deleted.",
      fixes: [
        { id: "show-remote", label: "Show the remote address" },
        { id: "replace-remote", label: "Change the remote address" },
      ],
    }),
  },
  {
    matches: (output) => has(output, "protected branch"),
    build: (ctx) => ({
      code: "protected-branch",
      title: "That branch is protected on the remote.",
      explanation: `The server refuses direct pushes to ${ctx.branch ?? "this branch"}. Pushing to a new branch and opening a pull request is the same change with a review step.`,
      fixes: [{ id: "create-branch-and-pr", label: "Create a branch and open a pull request" }],
    }),
  },
  {
    matches: (output) => has(output, "exceeds github's file size limit") || has(output, "large file"),
    build: () => ({
      code: "file-too-large",
      title: "That file is too large for the remote.",
      explanation:
        "The remote rejects files over its size limit, and committing it again will fail the same way. Taking it out of the commit, and telling git to ignore it, keeps the repository committable.",
      fixes: [
        { id: "unstage-file", label: "Take the file out of the commit" },
        { id: "add-gitignore", label: "Add it to .gitignore" },
      ],
    }),
  },
];
