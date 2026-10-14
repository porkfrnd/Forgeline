# Architecture

> Last updated: 2026-10-14
> Describes commit: 8d96914ded9e91bb1c5da09438a2fb7ff50fb260 (Milestone 1 Skeleton, first commit)

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
  src/
    cli.ts                  parse args (commander), check git >= 2.31, start server, print banner, open browser, SIGINT shutdown
    server/
      index.ts              createApp(token, getPort): security middleware, /api/* auth, health, SSE, static serving + SPA fallback; startServer() binds 127.0.0.1 and resolves bind errors
      git/
        git.ts              the ONLY module that runs git. runGit(args,{cwd,env}) -> {stdout,stderr,exitCode,command}. LC_ALL=C, GIT_TERMINAL_PROMPT=0, GIT_EDITOR=true. spawn arg arrays only.
      routes/               (Milestone 2+) repos, status, commits, branches, stash, undo, auth, releases
      scan/                  (Milestone 2) repo discovery + watching
      auth/                  (Milestone 6) provider interface, github, gitlab, keychain
      releases/              (Milestone 8) version bump, changelog, tagging
    web/
      main.tsx              React entry; mounts <ThemeProvider><App/></ThemeProvider>
      src/app/App.tsx       layout shell: header, sidebar, tab bar (Changes/History/Branches/Releases), theme toggle
      src/components/       Header, Sidebar (more in later milestones)
      src/theme/            ThemeProvider (paper/midnight), tokens.css (design tokens + base styles)
    shared/types.ts         RepoStatus, Change, Commit, ForgeError, Snapshot (shared shapes)
  tests/e2e/                Playwright specs + global setup/teardown that run the real built CLI
```

## Request flow (interface -> git -> back)

1. The React app calls `fetch('/api/...')`; the browser attaches the `session` cookie.
2. `src/server/index.ts` middleware rejects any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. Changing methods additionally require an allowed `Origin` and `Content-Type: application/json`.
3. `requireAuth` on `/api/*` rejects requests without the `session` cookie (401).
4. A route module calls into `src/server/git/git.ts` (the only place that spawns git), which returns `{stdout, stderr, exitCode, command}` and never throws. Parsers (Milestone 2) turn stable, machine-readable git output into typed data. On failure, routes return a `ForgeError` (`{code,title,explanation,fixes,raw}`) rather than a bare string.
5. Live updates flow back over the SSE stream at `/api/events`. Today it is authenticated and emits an initial comment; real repo-status events arrive in Milestone 2.

Static serving: `GET *` first handles the `?t=` token exchange (302 + Set-Cookie, token stripped). Otherwise it serves the matching file from `dist/web`, then falls back to `index.html` for client-side routes (except missing `/assets/*`, which 404). The web root is resolved relative to the compiled server: `join(dirname(index.js), "..", "web")`.

## Git execution rules (from the spec, applied in git.ts)

- One module runs git; `spawn` with argument arrays only; no shell strings.
- Fixed env on every call: `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`. Background status calls also set `GIT_OPTIONAL_LOCKS=0` (Milestone 2).
- One write at a time per repo via a per-repo queue (Milestone 2/4). Reads may run in parallel.

## Journal and snapshots (Milestone 4)

- Location: the OS app-data folder for Forgeline, never inside a repo. The exact path is chosen in Milestone 2 when settings storage is added (candidates: `~/.config/forgeline`, `~/Library/Application Support/forgeline`, `%APPDATA%/forgeline`).
- Journal: one entry per repo-changing action (repo path, timestamp, plain-English description, git command, refs before/after).
- Snapshots: built from a temp index (`GIT_INDEX_FILE`, `git add -A`, `git write-tree`, `git commit-tree`), stored under `refs/forgeline/snapshots/<timestamp>`; the real index is also recorded with `git write-tree` when conflict-free. Prune only when older than 30 days and outside the latest 50. Recovery contracts (exact undo / compensating / irreversible) will be listed per action here.

## Health score formula (Milestone 2)

Not implemented yet. When built, the exact 0-100 formula (inputs: last commit age, unpushed work, stale branches, missing README/`.gitignore`) will be written here, word for word, with the weights and thresholds, so it can be tested.

## Where to add things

- **A new error rule:** add an entry to the rules array in `src/server/git/errors.ts` (Milestone 5). Each rule is `{ pattern: (stderr, command) => boolean, build: (raw) => ForgeError }`. The pattern must come from real git output captured in a fixture; remote-only messages are marked `source: docs` until seen live.
- **A new theme:** add a `[data-theme="<name>"]` block in `src/web/src/theme/tokens.css` (or a file under `src/web/themes/`) that sets the same token names, and add the name to `ThemeName` in `src/web/src/theme/ThemeProvider.tsx`. Adjust colors to meet WCAG AA.
- **A new API route:** add a handler in a module under `src/server/routes/` and register it in `src/server/index.ts`. Go through `git.ts` for any git call; return `ForgeError` on failure.
