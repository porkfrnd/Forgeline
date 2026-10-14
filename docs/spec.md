# Forgeline — Full Build Prompt

> Last updated: 2026-10-14
> Commit: (none yet — first commit)
>
> This file is a verbatim copy of the original build prompt. It is the source of truth for what to build, except where `docs/decisions.md` records a change. Never edit this file; record any change in `docs/decisions.md` with the reason.

---

# Forgeline — Full Build Prompt

## Brief

Build **Forgeline**, a local web app that gives people a calm, visual way to manage every git repository on their computer. It installs as an npm package, starts from the terminal, and opens a polished React interface on localhost.

It is for three groups: beginners who are afraid of git, developers who want a faster visual layer over it, and non-developers who only need to save and share files.

Non-negotiable principles:

- **Local first.** Everything except the actions that contact a remote (fetch, pull, push, and publishing a release) works with no internet. No account is needed unless a remote asks for one.
- **Wrap the git CLI.** Never reimplement git. Run the real git and parse its stable output.
- **Never lose the user's work.** Uncommitted work is never discarded without a snapshot first. Undo is offered only where its recovery is proven by tests. Every other action says plainly that it cannot be undone, and why.
- **Explain, don't hide.** Every action can show the real git command behind it. Every error shows plain English first, with the raw output behind a toggle.
- **Looks hand-designed.** The interface must not look generated: restrained, consistent, and calm.

Build in the milestone order given in the last section, and make each milestone run end to end before starting the next.

## Tech stack and packaging

Use TypeScript everywhere and ship as a standard npm package that runs on Node 22 or newer. Node 22 is in maintenance support until 30 April 2027, and Node 24 is the current Active LTS and the recommended version. Node 20 reached end of life on 30 April 2026, so it is not supported.

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 22+ (Node 24 recommended) | Set `engines` to `>=22` in `package.json` |
| Backend | Hono with `@hono/node-server` | Small, fast, typed routes |
| Frontend | React + Vite + TypeScript | Built to static files and served by the backend |
| Git | Node `child_process` (`spawn` with argument arrays), no git library | Always behind one wrapper module |
| CLI | `commander` | Parses the optional port argument |
| Browser launch | `open` | Opens the dashboard after the server starts |
| Styling | CSS variables plus CSS modules or plain CSS | No heavy UI kit; see the design section |
| Secrets | A maintained OS keychain library, for example `@napi-rs/keyring` | Only used when the user signs in. Check the last release date and Windows, macOS, and Linux support before adopting it |

Packaging rules:

- Add a `bin` entry named `forgeline` so `npm install -g forgeline` and `npx forgeline` both work.
- Build the React app and the server in the `prepack` script, not `prepublishOnly`, because `prepack` also runs for `npm pack`, so the packed tarball can be tested before publishing. Ship the built files inside the package. Users must never need a build step.
- Compile the server to plain JavaScript in `dist/`.
- On startup, check `git --version`. Require git 2.31 or newer. If git is missing or older, print a short friendly message with install links and exit.
- Check that the name `forgeline` is free on npm before publishing. If it is taken, use a scoped name such as `@<user>/forgeline` and keep the `forgeline` command. Never claim the package is published until it is.
- Commit `package-lock.json`.
- Keep dependencies lean. Prefer small, well-maintained packages.

## CLI behavior

The user starts the app with `forgeline` and an optional port, and the app always tells them where it is running.

```
forgeline          # picks a free port automatically
forgeline 4700     # tries port 4700
```

Rules:

1. **No port given:** bind the server to port `0` so the operating system assigns a free port, then read the actual port from the server and use it.
2. **Port given and free:** use it.
3. **Port given but taken:** do not silently switch. Print a clear message, such as "Port 4700 is in use. Try 4701, or run forgeline with no port." Then exit with a non-zero code.
4. **Invalid port** (not a number, or outside 1024 to 65535): print a short error and the usage line, then exit.
5. **Bind to `127.0.0.1` only**, never `0.0.0.0`, so nothing else on the network can reach the app.
6. **After the server starts,** print a clean, short banner with the full URL, including the one-time session token, for example `Forgeline is running at http://localhost:52817/?t=<token>`, then open that URL in the default browser. The page removes the token from the address bar once it has set the session cookie. Add a `--no-open` flag to skip opening the browser; the printed URL still works.
7. **Shut down cleanly** on Ctrl+C: finish any running git command, close the server, and print a one-line goodbye.
8. Add `--help` and `--version` flags.

## Project structure

Use one package with three areas: the server, the web app, and types shared by both.

```
forgeline/
  package.json
  tsconfig.json
  src/
    cli.ts                  entry: parse args, start server, print banner, open browser
    server/
      index.ts              Hono app, static file serving, route registration
      routes/               repos, status, commits, branches, stash, undo, auth, releases
      git/
        git.ts              the ONLY module that runs git commands
        parse.ts            parsers for status, log, and diff output
        errors.ts           error pattern catalogue and translator
        journal.ts          action journal and automatic snapshots
      scan/                 repo discovery and filesystem watching
      auth/                 provider interface, github.ts, gitlab.ts, keychain.ts
      releases/             version bump, changelog, tagging
    web/
      main.tsx
      app/                  layout, routing, command palette
      features/            dashboard, changes, history, branches, conflicts, releases, settings
      components/          buttons, diff view, commit graph, dialogs, toasts
      themes/               token files, one per theme
    shared/
      types.ts              RepoStatus, Change, Hunk, Commit, ForgeError, Snapshot
```

Rules for the server:

- **One git module.** Every git command goes through `git.ts`. It returns a typed result with stdout, stderr, exit code, and the exact command string. It never throws raw errors.
- **Stable output only.** Use `git status --porcelain=v2 -z` and similar machine formats with NUL separators. Never parse text meant for humans.
- **Fixed environment for every git call.** Set `LC_ALL=C` so messages are in English and the error patterns match, `GIT_TERMINAL_PROMPT=0` so git never waits for a password that nobody can type, and `GIT_EDITOR=true` so git never opens an editor. Add `GIT_OPTIONAL_LOCKS=0` to background status calls so they never block the user's own git commands.
- **One write at a time per repo.** Queue commands that change a repo, so two of them never run together and cause an `index.lock` error. Read-only calls may run in parallel.
- **Journal every change.** Each action that changes a repo writes a journal entry with the refs before and after, so Undo can reverse it.
- **Typed errors.** When git fails, routes return `{ code, title, explanation, fixes, raw }`, never a bare string.
- **JSON over REST** under `/api`, plus a Server-Sent Events stream at `/api/events` that pushes live repo status changes to the UI.

Repo discovery: on first run, show a one-step setup page where the user picks the folders to scan, with suggestions such as `~/code`, `~/projects`, and `~/Documents`. Never scan the whole disk unasked. Scan the chosen folders to a limited depth, skip `node_modules` and hidden folders, and cache the results. Store settings, the journal, notes, and the cache in the operating system's standard app-data folder, never inside a repo.

Keep live updates cheap. Watch each repo's `.git/HEAD`, `.git/index`, and `.git/refs`, refresh the open repo's working tree every few seconds, and refresh other repos when the window gains focus. Debounce events. Use a file-watching library such as `chokidar`, because Node's built-in recursive watching is not available on every platform. If native watching fails, for example on network drives, fall back to polling every 3 seconds and show a small note saying live updates are polling.

## Features

### Repo dashboard

- List every repo found, as cards or rows (user toggle).
- Per repo: name, path, current branch, changed file count, unpushed commits, and commits behind the remote.
- **Health score** from 0 to 100, based on last commit age, unpushed work, stale branches, and a missing README or `.gitignore`. Show a one-line reason, and document the exact formula in `docs/architecture.md`.
- **Forgotten work banner** for repos whose oldest uncommitted change, by file modification time, is more than 7 days old.
- Search, filter, sort by status or last activity, and pin favourites.
- **Sync all:** fetch every repo, pull only the clean ones, skip dirty ones, and report what happened.

### Commit flow

- A **summary** field (the header) with a 72-character guide and counter, and a **description** field for the body.
- A file list with checkboxes. Expanding a file allows staging by hunk, then by single line. Build a patch from the selected hunks or lines and apply it with `git apply --cached --recount`.
- Staged and unstaged changes are clearly separated.
- **Message helper:** optional templates (including Conventional Commits) and three suggested summaries drawn from the diff using simple local rules. No external service is required.
- The sanity check card (see the safety section) runs before every commit.
- Commit with the user's normal git config and hooks. If a hook rejects the commit, show the hook's output in the error card.

### Diff viewer

- Inline and side-by-side modes, syntax highlighting, and word-level change highlighting.
- Keyboard shortcuts for next and previous change and next and previous file.

### Branches, stash, and history

- Create, switch, rename, and delete branches, and show which are already merged.
- Stash list with apply, pop, and drop. Offer an automatic stash when pulling with local changes.
- History with a commit graph, search by message, author, or file, and a blame view.
- **Time machine:** a slider that shows how a single file looked at any commit.
- **Conflict resolver:** a three-pane view with yours, theirs, and the result. Buttons accept yours, accept theirs, or accept both, and the result is editable. A file is marked resolved when no conflict markers remain.

### Remote actions

- Fetch, pull, and push with progress and an ahead and behind indicator.
- These are the only actions that may ask the user to sign in (see the sign-in section).

### Simple mode

- A toggle that reduces the app to two buttons: **Save** (commit everything with a message) and **Send** (push). It hides branches, staging, and the graph, and uses plain wording. The sanity check still runs before Save.

### Extras

- Command palette on Ctrl or Cmd plus K, with keyboard shortcuts throughout.
- **Gitignore doctor:** detect the project type, suggest a `.gitignore`, and flag large files or secrets that are already tracked.
- Per-repo sticky notes, stored locally and never inside the repo.
- **Teach me** toggle: show the exact git command behind every action.
- **SSH key help:** list existing SSH keys, generate an `ed25519` key with `ssh-keygen`, show the public key with a copy button, and link to the provider's SSH key settings page.

## Safety and recovery

The user must be able to undo anything Forgeline does, and must never lose uncommitted work.

**Action journal.** Every action that changes a repo writes an entry: repo path, timestamp, a plain-English description, the git command, and the refs before and after (HEAD, current branch, stash). Store the journal in the app's data folder, never inside the repo.

**Undo timeline.** A panel lists journal entries, newest first. Each has an Undo button that restores the refs to their earlier state. Undo appears only for operations that meet the recovery rules in the implementation integrity contract. Undo itself is journaled, so it can also be undone, and a snapshot is taken before every Undo runs. Entries for actions that reached a remote (push, publishing a release) cannot be undone locally. Mark them as such, explain why in one sentence, and offer the safe alternative, such as creating a revert commit.

**Automatic snapshots.** Before any risky action, save a snapshot of the working tree and index, including untracked files. Risky actions are: merge, rebase, reset, discard changes, checkout with local changes, pull with local changes, delete branch, and drop stash. Build the snapshot from a temporary index (`GIT_INDEX_FILE`, `git add -A`, `git write-tree`, `git commit-tree`) and store it under a private ref such as `refs/forgeline/snapshots/<timestamp>`, so it never appears in the user's normal stash list. Ignored files are not included. Also record the real index with `git write-tree` when it has no conflicts, so the staged state can be restored. Delete a snapshot only when it is older than 30 days and not among the latest 50.

**Sanity check card.** Before each commit, run these checks and show any that fail:

- Likely secrets: `.env` files and common key patterns. This one requires explicit confirmation to continue.
- Large files over 5 MB.
- `node_modules` or build output staged.
- Committing directly to `main` or `master`, with a one-click option to create a branch.
- Vague messages such as "fix", "update", or "stuff".
- No `.gitignore` in the repo.
- Branch is behind its remote, with a suggestion to pull first.

**Rescue mode.** Detect detached HEAD and any merge, rebase, or cherry-pick in progress. Show a banner that explains the situation in plain English and offers one or two clear buttons, such as "Create a branch here", "Continue", or "Abort and go back".

**Reset to clean state, keep my work.** One button that takes a snapshot, saves the current HEAD under a backup ref such as `refs/forgeline/backup/<timestamp>` so local commits are not lost, then resets the repo to match its remote and shows the snapshot in the timeline so the work can be restored.

**Confirmation previews.** Before any destructive or history-changing action, show a card that says in plain words what will happen, which files or commits are affected, and (when Teach me is on) the exact command. Force push requires typing the branch name to confirm.

## Error translator

When a git command fails, show a plain-English card with buttons that fix the problem. The raw output stays one click away.

How it works:

- In `errors.ts`, keep a list of rules. Each rule has a pattern tested against stderr and the command, and a builder that returns `{ code, title, explanation, fixes, raw }`.
- The card shows the title, a one or two sentence explanation, and one button per fix. A **Show details** toggle reveals the raw git output, and a **Copy details** button copies it.
- Every fix button must run a real app action (pull, create branch, open sign-in, and so on). Never show a fix as text only.
- Unknown errors fall back to a generic card with the raw output and the copy button. Never hide an error that no rule matches.
- Keep a local history of errors the user hit and which fix worked.

Starter catalogue (build all of these):

| Raw git output contains | What the user sees | Fix buttons |
| --- | --- | --- |
| `rejected` with `fetch first` or `non-fast-forward` | Someone else pushed changes you don't have yet. | Pull, then push |
| `Permission denied (publickey)` | This computer isn't authorized with the remote over SSH. | Set up an SSH key, or switch the remote to HTTPS |
| `Authentication failed`, `could not read Username`, HTTP 401 or 403 | The remote needs you to sign in. | Open sign-in |
| `CONFLICT (content): Merge conflict in <file>` | Two changes touched the same lines in that file. | Open conflict resolver, abort merge |
| `not a git repository` | This folder isn't a git project yet. | Initialize here |
| `detached HEAD` | You're not on a branch, so new commits could be lost. | Create a branch here |
| `local changes ... would be overwritten` | You have unsaved changes this action would overwrite. | Stash and continue, commit first |
| `refusing to merge unrelated histories` | These two histories don't share a starting point. | Explain, allow with confirmation |
| `protected branch` | This branch is protected on the remote. | Create a branch and open a pull request |
| `Could not resolve host` | Can't reach the remote. Check your connection. | Retry |
| `remote origin already exists` | This repo already has a remote called origin. | Show remote, replace remote |
| `Please tell me who you are`, `unable to auto-detect email` | Git doesn't know your name and email yet. | Set name and email |
| `index.lock` exists | Another git process is running, or one crashed. | Check for running git, remove lock after confirmation |
| `exceeds GitHub's file size limit` | This file is too large for GitHub. | Unstage the file, add it to `.gitignore` |
| `Not possible to fast-forward` | Your branch and the remote have diverged. | Merge, rebase |
| `nothing to commit` | There's nothing new to save. | None |

## Optional sign-in

Sign-in is lazy: Forgeline never asks for an account until the user does something that needs one, and every local feature works without it.

When to ask:

- On launch, go straight to the dashboard. Having no token is a normal state, with no warning badge.
- Show the sign-in prompt only when the user clicks Fetch, Pull, Push, Sync all, Create pull request, or Publish release, chooses Connect in settings, or when a remote rejects a command with an authentication error.
- Make the prompt skippable. **Not now** dismisses it and shows the git error in plain English, with the option to sign in later.
- If the remote already works through SSH keys on the machine, or is public HTTPS, run push and pull without any Forgeline sign-in.

GitHub sign-in uses the OAuth Device Flow, so no callback server or client secret is needed.

1. One-time setup, done by the user: register an OAuth App on GitHub, tick **Enable Device Flow**, and put its Client ID in a config constant (`GITHUB_CLIENT_ID`). Never invent a Client ID. Until a real one is set, the Sign in button is disabled with a plain message saying why, and the flow is tested against a local mock of the GitHub endpoints.
2. The user clicks **Sign in with GitHub**. The backend requests a device code from `https://github.com/login/device/code` with the `repo` scope, and the UI explains why that scope is needed.
3. Show the returned code and a button that opens `https://github.com/login/device`.
4. Send every GitHub request with the header `Accept: application/json`. The backend polls `https://github.com/login/oauth/access_token` at the returned interval, using the grant type `urn:ietf:params:oauth:grant-type:device_code`. Treat `authorization_pending` (keep polling), `slow_down` (lengthen the interval), `expired_token` (restart), and `access_denied` (show a friendly message) as normal states, not crashes.
5. Store the token in the OS keychain. Fetch the user's name and avatar from `https://api.github.com/user` and show them in the header.
6. **Sign out** deletes the token from the keychain and tells the user they can also revoke the app in their GitHub settings.

Using the token: give it to git through an askpass helper, never through command-line arguments, the remote URL, or `.git/config`. Set `GIT_ASKPASS` to a small script that Forgeline ships, and set `FORGELINE_TOKEN` to the token for that one git command only. The script prints the token when git asks for a password. Usernames differ by host: GitHub accepts `x-access-token`, and GitLab OAuth tokens need `oauth2`. Both are unconfirmed until a live push and pull succeed against a real remote on each host. The GitHub documentation checked for this spec does not state the format. Record each result in `docs/status.md`, and if a live test fails, stop and report it instead of trying other formats. Never log the environment. If no OS keychain is available, for example on a Linux machine without a secret service, keep the token in memory for the current run only, tell the user, and never fall back to a plain file. Git 2.31 or newer is required for the environment settings the app uses.

Provider design: define an `AuthProvider` interface (start login, poll login, get user, get token, sign out, create pull request, create release, list repos). Implement GitHub fully. Implement GitLab with the same device flow, using the device authorization grant (RFC 8628), which GitLab supports from version 17.9. Each provider takes a configurable base URL, so self-hosted instances work. For a self-hosted GitLab older than 17.9, offer a personal access token pasted once, stored the same way as an OAuth token. Store tokens per provider and username so multiple accounts are possible.

## Release manager

The release manager turns "ship a version" into one guided flow: check readiness, bump the version, write the changelog, tag, and publish. Show a preview card of every step before anything runs, and journal each step so it can be undone until it is pushed.

1. **Readiness checklist.** Show every check and explain failures: working tree is clean, on the release branch (default `main`), up to date with the remote, no merge in progress, and a version file was found. Optionally run a test command the user types in settings. It comes only from settings, never from files inside the repo. Warn, without blocking, about `TODO` or `FIXME` in changed files.
2. **Version bump.** Detect `package.json`, `pyproject.toml`, `Cargo.toml`, or a plain `VERSION` file. Offer patch, minor, major, or a custom version, and show old to new. For `package.json`, also update `package-lock.json` when it exists. When commits follow Conventional Commits, suggest the bump: breaking change means major, `feat` means minor, `fix` means patch.
3. **Changelog.** Collect commits since the last tag and group them into Features, Fixes, and Other using Conventional Commit prefixes, with simple keyword rules as a fallback. Show an editable preview. Offer to prepend the result to `CHANGELOG.md`, and reuse it as the release notes.
4. **Commit and tag.** Commit the version change with the message `Release vX.Y.Z` and create an annotated tag `vX.Y.Z`.
5. **Publish.** Push the commit and tag. If the user is signed in to GitHub, create a release with the notes, with toggles for draft and pre-release. If not, ask for sign-in at this point, or let the user stop after the local tag.
6. **Release history.** List past tags with date, notes, and a link to compare against the previous release.

## Themes and visual design

Every color, radius, spacing step, shadow, and font is a CSS variable (a design token), and a theme is just a small file that sets those tokens. Switching themes applies instantly and the choice is remembered. Adding a new theme should take minutes.

Ship these presets, inspired by familiar tools but never copying their logos or trademarks:

| Theme | Look |
| --- | --- |
| Paper | Light, clean, white surfaces, thin gray borders, blue accent (GitHub-like) |
| Midnight | Dark counterpart of Paper |
| Mono | Pure black and white, high contrast, hairline borders, sharp type (Vercel-like) |
| Dracula | Familiar dark purple palette |
| Nord | Calm blue-gray palette |
| Auto | Follows the operating system's light or dark setting |

Adjust a preset's colors wherever needed so it meets WCAG AA contrast, even if that moves it slightly away from the original palette.

Also offer a custom accent color picker that works with every theme.

User options in settings, each changing what they see:

- **Density:** compact or cozy.
- **Layout:** sidebar or top tabs.
- **Repo list:** cards or rows.
- **Panels:** show or hide the commit graph, the diff panel, and the command preview.
- **Text size**, **reduced motion**, and **Simple mode**.

Craft rules so the app does not look generated:

- Three font roles, each a CSS variable token that a theme can change:
  - `--font-ui`: interface text, labels, buttons, menus, and the commit summary field. Use IBM Plex Sans.
  - `--font-code`: anything that is code or a value: diffs, file paths, commit hashes, branch names, and the Teach me command. Use JetBrains Mono. Raw git output inside Show details also uses this font, at a smaller size.
  - `--font-message`: the titles and explanations in success, warning, and error cards, so the app's voice stands apart from its chrome. Use Source Serif 4. Buttons inside those cards stay in `--font-ui`.
- Use tabular figures for counts and status numbers, so columns line up.
- **Bundle all three fonts** in weights 400, 500, and 600 only, as Latin subsets, with their licence files, along with the icons, so the app works offline. End each font token with a system fallback stack so filenames in other scripts still render.
- A fixed spacing scale (4 px steps) and only two corner radii used consistently.
- One accent color. Use status colors only for status: green for clean, amber for changes, red for conflicts, blue for ahead and behind.
- No gradients, glassmorphism, 3D spheres, glowing isometric shapes, neon grid lines, or purple-and-cyan palettes. The Midnight theme is a calm dark gray, not a neon void.
- No decorative illustrations, AI-generated stock art, robots, or floating mockup windows. Show the app's real screens or plain text.
- No emoji as icons. Use one icon set (Lucide).
- Prefer 1 px borders to shadows. Use shadows only for menus and dialogs.
- Favor text-forward lists and tables over oversized cards. Keep density high where the user scans.
- Every empty state has one sentence and one action. Use static skeleton placeholders with no shimmer, and transitions of about 120 to 180 ms.
- Visible focus rings, full keyboard access, and WCAG AA contrast in every theme.
- Layout: a left sidebar with the repo list, tabs for Changes, History, Branches, and Releases, a diff panel beside the file list, and a header showing repo name, branch, sync status, and a quiet account chip.
- Microcopy is calm and plain: no exclamation marks, and no git jargon without a short explanation.

## Anti-slop rules

Forgeline must feel intentional, useful, fast, and honest. These rules cover the app's interface, its copy, its README, and its npm page, on every screen and every release.

Visual and motion:

- No scroll-triggered or entrance animations. Text never slides, bounces, or fades in on load. Motion is only for state changes (a button pressed, a panel opened), lasts 120 to 180 ms, and is turned off entirely under reduced motion.
- No looping or pulsing decoration. A spinner appears only while a git command is running, and it names the command.
- No popups or modals on launch, no nudges, and no tips banners that return after being dismissed. Dismissed things stay dismissed. The one-time folder setup on first run is a full page, not a popup.

Copy:

- Headings and labels say what the thing does: "Commit 3 files", not "Supercharge your workflow".
- Errors and successes say what happened and what to do, in one or two sentences, with no filler.
- Banned in the interface, README, and npm page: "revolutionize", "unlock", "empower", "seamless", "delve", "tapestry", "in today's fast-paced", "next-gen", "synergy", "leverage", "game-changing", "effortless", and "AI-powered". Add a phrase to this list whenever it shows up in generated copy.
- No testimonials, invented user counts, "trusted by" lines, or star badges with made-up numbers. Any number shown must be computed by the app.

Behavior:

- No AI chat assistant, no help bot that opens on its own, no email gate, no upsell, no countdowns, and no fake urgency.
- No telemetry. The only network calls are the ones the user triggers.
- Explanations for errors and the Teach me feature come from the rule catalogue. They are never generated filler.

Litmus test, applied to every screen at every milestone review: strip away colors, motion, and hype words. If the screen still shows the state the user needs, with a clear next action, it passes. If not, fix it before moving on.

## Implementation integrity contract

A feature is complete only when its real user flow works end to end, its failure paths are handled, and its acceptance tests pass.

- Prefer a smaller set of complete, dependable features over a larger set of superficial implementations.
- Never replace a real feature with a placeholder, a hardcoded result, or a success message that is not backed by actual execution. Mocks are allowed only inside tests, and they must be labelled as mocks in the test name and in `docs/status.md`. The shipped feature always calls the real thing.
- Do not offer Undo for an operation until its recovery has been tested against real repositories, including interrupted operations (for example, a kill during a merge or a stash apply) and pre-existing user changes (staged, unstaged, and untracked files that were present before the action). Operations without passing recovery tests show a clear "Cannot be undone" label instead.
- Give every destructive action an explicit recovery contract, one of three kinds: exact undo, a compensating action (such as a revert commit), or irreversible, with a plain-English explanation of why. Record which kind each action uses in `docs/architecture.md`.
- Keep `main` buildable and verified. Intentionally incomplete work lives only on a documented `wip/` branch.
- At every milestone boundary, report the actual verification output, the implemented flows, the known limitations, and the precise next step, in `docs/status.md`.
- When a requirement cannot be implemented safely or verified, stop expanding its scope, document the evidence in `docs/status.md`, and ask for direction. Never silently weaken the requirement to make it pass.

## Build and verify loop

Do not move on from any step until the current one passes. Work in short loops: build a small slice, test it, look at it, fix what you find, and repeat. Never write a large amount of code before testing any of it.

Setup, once, before milestone 1:

- Add `vitest` for unit tests, `playwright` for browser tests, and npm scripts: `typecheck`, `lint`, `lint:copy`, `test`, `test:e2e`, and `verify` (which runs all of them in order).
- `lint:copy` scans the user-facing interface strings and the README for every phrase listed in `scripts/banned-phrases.txt` (copy the banned list from the anti-slop rules into that file) and fails if any appear. It skips `docs/`, the banned list itself, and git's own raw output.
- Create `scripts/make-fixture-repos.ts`. It builds throwaway git repos in a temp folder on every test run, covering: clean, uncommitted changes, staged and unstaged changes in the same file, ahead of remote, behind remote, detached HEAD, an in-progress merge conflict, a repo with no remote, and a repo with a 6 MB file. Use local bare repositories in the same temp folder as the remotes, so no network or account is needed. Tests use these fixtures, never the developer's real repos.
- Create the handoff documents described in the handoff documentation section, starting with `AGENTS.md`, `docs/status.md`, and `docs/progress.md`.
- Create `screenshots/milestone-N/` for captured images.
- Start in an empty folder named `forgeline`. Run `git init`, work on `main`, and commit only when `verify` is green.

The loop, run for every slice of work:

1. **Plan the slice.** Write the checklist of what this slice must do, in `docs/progress.md`. Keep it to one feature or one fix.
2. **Work.** Write the code for that slice only.
3. **Static check.** Run `typecheck`, `lint`, and `lint:copy`. Fix every error before continuing.
4. **Unit test.** Write tests for the logic in this slice, especially `git.ts`, `parse.ts`, `errors.ts`, and `journal.ts`. Run them against the fixture repos. Each test checks the real git result, not a mock.
5. **Run the app.** Build, then start the CLI with `forgeline <port> --no-open` (use `npm link` so the `forgeline` command works locally) and confirm the banner prints the right URL, including the token. Check the port rules: no port, a free port, a taken port, and an invalid port.
6. **API check.** Call every endpoint this slice touches with `curl` or a test client. Confirm status codes and JSON shape. Confirm requests without the session token are rejected.
7. **Browser test.** Use Playwright to click through the real flow the user would take. Assert on visible text and state, not on internal code. Run it at a 1440 px desktop width and at a narrow 800 px window.
8. **Screenshot.** Save a screenshot of every screen the slice changed, in each theme the slice touches, into `screenshots/milestone-N/`.
9. **Look at the screenshots.** Open each image and check it against the design rules: spacing on the 4 px scale, one accent color, no clipped or overlapping text, no empty layout gaps, readable contrast, and focus rings visible. Write down every problem you see. If your tool cannot view images, say so in `docs/progress.md`, use DOM and computed-style checks for overlap, clipping, and contrast instead, and mark the screenshot review as pending for the human. Never claim to have reviewed an image you did not see.
10. **Check for errors.** Collect browser console errors, uncaught exceptions, and failed network requests during the Playwright run. Also check the server log. The target is zero. Any error that is expected must be listed in `docs/progress.md` with a reason.
11. **Fix and repeat.** For every failure from steps 3 to 10, fix the cause, then run the loop again from step 3. Do not patch a test to make it pass. If a fix would change expected behavior, record the change and the reason in `docs/decisions.md` first.
12. **Record and commit.** When everything passes, add the entry to `docs/progress.md`, update `docs/status.md` with the new next step, and commit with a message describing the slice. Then start the next slice.

Stop rules:

- If the same step fails three times in a row, stop. Write what you tried and what you think the cause is in `docs/progress.md`, then ask for direction.
- Never mark a milestone done with a failing test, an unreviewed screenshot, or an unexplained console error.

Regression rule: at the end of each milestone, run the full `verify` script and the Playwright suite for every earlier milestone. A fix for the current milestone must not break an earlier one.

Milestone done means: the milestone's acceptance items below pass, all screenshots have been reviewed, `verify` is green, and `docs/progress.md` has a final entry for it.

## Grounding rules

Documentation alone does not stop an AI from making things up. These rules make every claim checkable.

- **Verify before you claim.** Never write "works", "passes", or "done" without running the command and recording its output in `docs/progress.md`.
- **Trust the running code and the tests over any document,** including this prompt and the handoff files. When a document and the code disagree, check the code, correct the document, and log the correction in `docs/progress.md`.
- **Don't guess library APIs.** Before calling a function from a dependency, read its type definitions in `node_modules` or its current documentation. Pin exact versions in `package.json`. The typecheck must catch wrong calls.
- **Don't guess git behavior.** Run the real git command in a fixture repo and copy its actual output into a test. Error patterns in the translator come from real git output, never from memory. Messages that only a remote can produce (protected branch, file size limit, HTTP 401 or 403) cannot be made locally. Take their wording from the provider's documentation, save it as a fixture marked `source: docs`, and list those rules as unconfirmed in `docs/status.md` until they are seen in real output.
- **Say "unknown" instead of guessing.** If a fact, path, version, or behavior is not confirmed, write it as unconfirmed in `docs/status.md`, along with what would confirm it.
- **Cite evidence.** Every status entry names the command, test, or screenshot file that proves it.
- **No invented data.** Test repos, names, and numbers in the interface come from the fixtures or from real computation. Never show placeholder data as if it were real.
- **Re-check before resuming.** At the start of each session, run `verify` and compare the result with `docs/status.md`. If they differ, trust the run and correct the document.

## Handoff documentation

The project must be resumable by any person or any AI tool, with no memory of this conversation. Keep these files in the repo, and keep them current.

Every session starts by reading `AGENTS.md`, then `docs/status.md`, then `docs/decisions.md`, then `docs/spec.md`. Do not write code until all four are read. On the very first session none of these files exist yet: create them, and copy this prompt into `docs/spec.md`.

Files:

- `AGENTS.md` (repo root): the entry point for any AI coding tool. It states what the project is in three sentences, the reading order, the commands (install, dev, verify, test:e2e), and the rules from this prompt that apply every session. Also create `CLAUDE.md` containing one line that points to `AGENTS.md`, so Claude Code reads the same rules.
- `docs/spec.md`: a copy of this build prompt, unchanged. It is the source of truth for what to build, except where `docs/decisions.md` records a change. Never edit the spec itself. Record any change in `docs/decisions.md` with the reason.
- `docs/status.md`: where things stand right now. A milestone table with each milestone marked not started, in progress, or done. The current milestone and slice. The latest `verify` result and test count. Known broken things. The exact next step, written as a concrete action, such as "Implement `parseStatus` for renamed files and add a fixture for it."
- `docs/progress.md`: an append-only log. One dated entry per loop run: the slice, which steps passed or failed, the errors seen and how each was fixed, and the screenshot folder. Never rewrite old entries.
- `docs/decisions.md`: each decision with its date, the choice, the alternatives rejected, and the reason. Include the stack, the font roles, the port rules, the sign-in method, and any change to the spec.
- `docs/architecture.md`: how the code fits together. The module map, how a request flows from the interface to git and back, where the journal and snapshots are stored, and where to add a new error rule or a new theme.
- `docs/setup.md`: everything needed on a new machine. Node and git versions, install and run commands, how to generate the fixture repos, and how to run the tests with and without a GitHub account.
- `screenshots/`: the latest screenshots per milestone, with a short note beside each saying what it shows.

Rules for these files:

- Write for a reader who has no memory of this conversation. Name files, functions, and commands exactly. Never write "the thing we discussed".
- Each file starts with a "Last updated" date, read from the system clock and never guessed, and the hash of the last code commit it describes.
- Never put tokens, keychain contents, personal repo paths, or account names in these files.
- A slice is not finished until `docs/status.md` and `docs/progress.md` are updated and committed.
- If you stop for any reason, update `docs/status.md` first, with what you were doing and the exact state of the code, even if a change is half finished.
- Mark unfinished work as unfinished. Never describe it as done.

## Recovery and fallback

A session can end at any point. These rules keep the work safe and let a new session resume from whatever state the repo is in.

Before stopping, for any reason:

- **Never leave work only in the chat.** If the code is half-written, commit it to a branch named `wip/<milestone>-<slice>` with the message `WIP: <what is unfinished>`, then record that branch in `docs/status.md`. Do not commit broken code to `main`.
- **Never discard uncommitted changes to get unstuck.** Save them first as a WIP commit, and say so in `docs/status.md`.
- **Update `docs/status.md`** with the exact state: which files were changing, which tests fail, and the next command to run.

When a new session starts and the notes don't match the repo, follow this order:

1. **Read the repo, not the notes.** Run `git status`, `git log --oneline -15`, and `git branch --list 'wip/*'`. Note any uncommitted changes and any WIP branches.
2. **Read the last log entry** in `docs/progress.md` and compare it with the git history.
3. **Restore the environment** by following `docs/setup.md`. Install from the lockfile with `npm ci`, never from a fresh resolve, so versions match the last run.
4. **Run `verify`.** Treat its output as the truth about the current state.
5. **Reconcile.** Where the notes disagree with the code or the test results, correct `docs/status.md` to match what was verified, and log the correction in `docs/progress.md`.
6. **Resume** from the next step, or from the WIP branch if one exists. Finish or delete the WIP work deliberately. Never merge it blindly.

If the state is still unclear after these steps, write what was checked and what is unknown in `docs/status.md`, then ask for direction. Do not guess which parts of the work were finished.

## Security, build order, and acceptance

Security rules. Forgeline runs git on the user's machine, so a local web page must not be able to abuse it.

- Bind to `127.0.0.1` only.
- Generate a random session token at startup. Put it in the URL that the CLI prints and opens. When the page loads, exchange it for an `HttpOnly`, `SameSite=Strict` cookie and remove it from the address bar. Reject any API call without the cookie.
- Check the `Host` header on every request, and the `Origin` header on every request that changes something. Accept only `localhost` and `127.0.0.1` on the app's own port. This blocks other websites and DNS rebinding from reaching the local API. Require `Content-Type: application/json` on every request that changes something.
- Run git with argument arrays, never shell strings. Resolve symlinks, then check that every repo path exists and sits inside the user's configured root folders.
- Never log tokens. Keep tokens only in the OS keychain.
- No telemetry. The only network calls are the ones the user triggers: fetch, pull, push, sign-in, and release publishing.
- Secret scan results never leave the machine.

Build order. Finish and run each milestone before starting the next.

1. **Skeleton:** CLI and port logic, server that serves the React app, theme tokens, layout shell with the Paper and Midnight themes.
2. **Git core:** the `git.ts` wrapper, parsers, repo scanning, and the dashboard with live status.
3. **Commit flow:** file list, hunk staging, diff viewer, commit, and the sanity check card.
4. **Safety:** action journal, snapshots, undo timeline, rescue mode, and confirmation previews.
5. **Error translator** with the full starter catalogue.
6. **Remote and sign-in:** pull, push, GitHub device flow, and the lazy prompt.
7. **Branches, stash, history graph, blame, and the conflict resolver.**
8. **Release manager.**
9. **Polish:** remaining themes, display options, Simple mode, extras, a CI workflow that runs `verify` on Linux, macOS, and Windows, a README with install and usage, and a `LICENSE` file (ask the user which license to use; do not choose one silently).

Acceptance criteria. The build is done when all of these are true:

- `forgeline` with no port starts on a free port and prints the URL with its session token. `forgeline 4700` uses that port. A taken port prints a clear message and exits with a non-zero code.
- The dashboard lists every repo under the chosen folders with correct changed, ahead, and behind counts, and updates without a page refresh.
- Committing selected hunks produces a commit containing exactly those hunks.
- Every change the app makes appears in the timeline, each labelled with its recovery kind. Undo restores the previous state, including untracked files after a discard, and the tests for that include an interrupted operation and pre-existing user changes.
- All 16 starter errors are translated, and unknown errors show the raw output.
- With no account signed in, every local feature works, and clicking Push shows the skippable sign-in prompt.
- GitHub sign-in completes through the device flow against the local mock, and the token is stored in the keychain (or in memory only, when no keychain exists), never in a plain file. A live sign-in with a real Client ID, and a live push and pull to a real GitHub remote, are confirmed by the user and listed as unconfirmed until then.
- GitLab sign-in is confirmed against a GitLab 17.9 or newer instance, or the personal access token path is confirmed on an older one, with both results recorded in `docs/status.md`.
- The release flow produces a version commit and a tag, and a GitHub release when signed in.
- Switching theme changes the whole interface instantly with no layout shift, and every theme meets WCAG AA contrast.
- The code makes no assumptions about one operating system (paths, shells, line endings, keychain). The CI workflow passes on Linux, macOS, and Windows. Any operating system that has not been run is listed as untested in `docs/status.md`.
- The interface, README, and npm page contain no banned phrases and no entrance animations, and every screenshot passes the litmus test.
- Each of the three font roles renders in its own font in every theme, and the bundled fonts load with no network connection.
