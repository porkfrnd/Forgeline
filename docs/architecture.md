# Architecture

> Last updated: 2026-10-15
> Describes commit: 9dcbfa8 (README refresh) plus the journal, app-data, and snapshot work that followed Milestone 3

How the code fits together today, and where things will live as milestones land. Sections that describe not-yet-built modules say so explicitly.

## Module map

```
forgeline/
  package.json              bin: forgeline -> dist/cli.js ; engines node >=22
  tsconfig.json             NodeNext config for server/CLI/tests typecheck (noEmit)
  tsconfig.build.json       emits src/cli.ts + src/server + src/shared to dist/
  tsconfig.web.json         Bundler + JSX config for src/web typecheck (noEmit)
  vite.config.ts            builds src/web -> dist/web
  scripts/
    make-fixture-repos.ts   builds throwaway git repos in a temp dir (real git, local bare remotes)
    lint-copy.js            scans UI strings + README for banned phrases (docs/ + the list are skipped)
    capture-screenshots.mjs starts the built CLI, drives Chromium, writes screenshots, reports console errors
    capture-screenshots-m2.mjs builds three throwaway repos, scans them through the real API, and screenshots the populated dashboard
  src/
    cli.ts                  parse args (commander), check git >= 2.31, start server, print banner, open browser, SIGINT shutdown
    server/
      index.ts              createApp(...): security middleware, /api/* auth, health, SSE, static serving + SPA fallback; startServer() binds 127.0.0.1 and resolves bind errors
      git/
        git.ts              the ONLY module that runs git. runGit(args,{cwd,env}) -> {stdout,stderr,exitCode,command}. LC_ALL=C, GIT_TERMINAL_PROMPT=0, GIT_EDITOR=true. spawn arg arrays only. readRefs() reads HEAD/branch/stash for a journal entry.
        diff.ts             changed-file records, unified-diff parsing, readChangedFiles, readFileDiff
      queue.ts              per-repo single-writer queue. Every status read for a repo goes through it; different repos stay concurrent.
      repo-summary.ts       summarizeRepo/summarizeRepos: one dashboard row per repo, shared by GET /api/repos and POST /api/repos/scan. Never throws.
      registry.ts           opaque repo id -> discovered path, plus the inside-root check
      paths.ts              isInside, resolveRealpath, safeRepoChildPath, stillInside
      appdata.ts            resolves the OS app-data folder and is the only module that writes JSON there
      journal.ts            the action journal; journaled() wraps every mutating call
      snapshots.ts          private snapshot refs and their restore
      scan/                 scan.ts: bounded repo discovery. pathExists() prunes vanished repos.
      live/
        watcher.ts          LiveWatcher: chokidar over .git/HEAD, .git/index, refs + packed-refs; debounced; 3s polling fallback
      routes/               (later milestones) status, commits, branches, stash, undo, auth, releases
      auth/                  (Milestone 6) provider interface, github, gitlab, keychain
      releases/              (Milestone 8) version bump, changelog, tagging
    web/
      main.tsx              React entry; mounts <ThemeProvider><App/></ThemeProvider>
      src/app/App.tsx       the Workbench shell: repo rail, toolbar, scan/file list/diff area, status bar
      src/app/git.ts        the browser's API client for every repo action
      src/app/useRepos.ts   dashboard list driven by EventSource over /api/events, with a slow poll fallback
      src/components/       RepoRail, StatusBar, CommandPalette, AppearancePanel, FileList, DiffViewer, CommitComposer
      src/theme/            ThemeProvider (7 families, dark/light, glass/solid, effects), families.ts, tokens.css
    shared/types.ts         RepoStatus, RepoSummary, Change, Commit, ForgeError, Snapshot (shared shapes)
  tests/e2e/                Playwright specs + global setup/teardown that run the real built CLI
```

## Request flow (interface -> git -> back)

1. The React app calls `fetch('/api/...')`; the browser attaches the `session` cookie.
2. `src/server/index.ts` middleware rejects any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. Changing methods additionally require an allowed `Origin` and `Content-Type: application/json`.
3. `requireAuth` on `/api/*` rejects requests without the `session` cookie (401).
4. A route module calls into `src/server/git/git.ts` (the only place that spawns git), which returns `{stdout, stderr, exitCode, command}` and never throws. Parsers (Milestone 2) turn stable, machine-readable git output into typed data. On failure, routes return a `ForgeError` (`{code,title,explanation,fixes,raw}`) rather than a bare string.
5. Live updates flow back over the SSE stream at `/api/events`. On connect it sends `event: mode` (`watching`, or `polling` when the fallback has engaged) and a full `event: repos` snapshot; after that it pushes only the repos whose watched `.git` files changed, debounced by `LiveWatcher`. The browser consumes it with `EventSource` in `useRepos`, and falls back to a 15-second poll only if the stream cannot be established.

Static serving: `GET *` first handles the `?t=` token exchange (303 + Set-Cookie, token stripped). Otherwise it serves the matching file from `dist/web`, then falls back to `index.html` for client-side routes (except missing `/assets/*`, which 404). The web root is resolved relative to the compiled server: `join(dirname(index.js), "..", "web")`.

## Git execution rules (from the spec, applied in git.ts)

- One module runs git; `spawn` with argument arrays only; no shell strings.
- Fixed env on every call: `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`. Background status calls also set `GIT_OPTIONAL_LOCKS=0` (Milestone 2).
- One write at a time per repo via `RepoQueue` (`src/server/queue.ts`). Every status read for a repo goes through it; reads in different repos still run in parallel. A rejected task does not poison the chain, and each caller sees its own result.
- Reads stay cheap: `GIT_OPTIONAL_LOCKS=0` keeps a `status` from writing the index, so the watcher never sees its own reads. The branch name comes from the `status --porcelain=v2 --branch` header (`parseStatusBranch`), so a normal refresh is `status` plus `rev-list`, not three processes.
- `LiveWatcher` watches `.git` once with `depth: 3` and an `ignored` predicate admitting only `HEAD`, `index`, `packed-refs`, and the `refs` subtree. Do **not** pass `[.git/HEAD, .git/index, .git/refs]` as separate targets: chokidar computes a common base for the path set and applies `depth` from there, which spends the budget walking back into `.git` and silently never reports changes inside `refs/`.
- Check-then-resolve is not a sandbox. The browser never sends raw paths — only opaque repo IDs plus repo-relative strings validated by `safeRepoChildPath` (rejects `..`, absolute paths, and leading `-`), then re-resolved with `resolveRealpath` and re-checked with `stillInside` immediately before git runs. This guards against a mistaken click, a crafted link, or an adversarial filename being turned into an out-of-root or option-shaped git argument — not against a hostile local user, who can already read the files, swap a symlink between the two checks, or run git directly. Rejections answer 400/403 with a plain explanation.

## Journal and snapshots (Milestone 4)

**Location.** The OS app-data folder, never inside a repo: `$FORGELINE_DATA_DIR` if set, else `$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, each with `/forgeline` appended. `src/server/appdata.ts` owns that resolution plus a best-effort JSON store (atomic write via a temp file and rename). A missing or corrupt file reads as absent, and a failed write is swallowed so a read-only home degrades to memory-only rather than stopping the app. The same folder holds persisted settings (gap 13) and, later, the scan cache (gap 9), so they land together.

**Journal.** `src/server/journal.ts`. One entry per repo-changing action: repo path, ISO timestamp, a plain-English description, the exact git command, and refs before and after (HEAD, branch, stash presence). Entries are stored newest-first under a cap. `journaled()` is the only way a mutating action records itself: it reads refs, runs the action, reads refs again, and writes an entry only when the action succeeded — a failed `git add` has no business in an Undo timeline. Undoing is itself journaled as a new entry.

**Snapshots.** `src/server/snapshots.ts`. Built from a temporary index so the user's real index is never touched while building: `GIT_INDEX_FILE=<tmp> git read-tree HEAD`, `git add -A`, `git write-tree`, `git commit-tree`. Ignored files are excluded, which is what `git add -A` means by default.

Two private refs are written, and the second is not in the spec but follows from it. The spec asks for the real index to be recorded "so the staged state can be restored", and reading the worktree tree alone would restore every file but flatten the user's staged/unstaged distinction. So:

- `refs/forgeline/snapshots/<timestamp>` — the working tree, including untracked files (`git read-tree --reset -u`)
- `refs/forgeline/snapshots/<timestamp>.index` — the real index (`git read-tree`, no `-u`, so files are untouched)

Both are private refs, so neither appears in `git stash list`; a snapshot visible in a stash list is a bug. Retention is exactly as the spec defines it: delete only when older than 30 days AND outside the latest 50.

**Recovery contracts, per action.** Every destructive action is one of three kinds, recorded here:

| Action | Kind | Why |
| --- | --- | --- |
| Stage / unstage (file or hunk) | exact undo | The reverse command returns the index and worktree to the recorded state. |
| Commit | exact undo | `git reset --soft` to the recorded HEAD restores the tree, index, and HEAD; the commit object remains reachable. Recovery is proven for the no-remote case only. |
| Discard local changes | exact undo | A snapshot is taken first, unconditionally, and its ref is returned in the response body so the timeline can restore the exact tree and staged state. |
| Push / publish release (not built) | irreversible | It reached a remote, so it cannot be undone from here. The timeline will say so in one sentence and offer a compensating revert commit. |
| Merge / rebase / reset (not built) | compensating or irreversible | To be classified once built, against real fixture repos. |

**Undo plans.** Every entry carries an `UndoPlan` written by `journaled` at the moment the action ran — the paths, the patch, the head to return to — because the code that just ran `git add` already knows what the reverse is, and parsing it back out of a command string later would be guesswork. `undoCommand()` is the single mapping from a plan to its git, shared by `POST /api/journal/:id/undo` and the tests. An entry with no plan, or one marked `undoable: false`, answers with the reason in one sentence instead of executing something random, so a missing recovery never becomes a wrong recovery.

**No Undo is offered anywhere until its recovery test passes**; until then the entry is labelled "Cannot be undone" with the reason. Push and release entries are marked non-undoable at write time via `journaled`'s `undoable: false` option.

**Rescue mode.** `POST /api/repos/:id/rescue` is the spec's "reset to clean state, keep my work" button. A snapshot is taken, HEAD is parked under `refs/forgeline/backup/<ts>` so no local commit is lost, then `reset --hard` runs, then the whole thing is journaled with the snapshot as its own undo. Both the snapshot and the backup therefore appear in the timeline, and neither appears in `git stash list`.

## Health score formula (Milestone 2)

Not implemented yet. When built, the exact 0-100 formula (inputs: last commit age, unpushed work, stale branches, missing README/`.gitignore`) will be written here, word for word, with the weights and thresholds, so it can be tested.

## Where to add things

- **A new error rule:** add an entry to the rules array in `src/server/git/errors.ts` (Milestone 5). Each rule is `{ pattern: (stderr, command) => boolean, build: (raw) => ForgeError }`. The pattern must come from real git output captured in a fixture; remote-only messages are marked `source: docs` until seen live.
- **A new theme:** add a `[data-theme="<name>"]` block in `src/web/src/theme/tokens.css` (or a file under `src/web/themes/`) that sets the same token names, and add the name to `ThemeName` in `src/web/src/theme/ThemeProvider.tsx`. Adjust colors to meet WCAG AA.
- **A new API route:** add a handler in a module under `src/server/routes/` and register it in `src/server/index.ts`. Go through `git.ts` for any git call, through `RepoQueue` for anything touching a repo, and return `ForgeError` on failure. If the route changes which repos exist, call `syncLive()` so the watcher follows.
