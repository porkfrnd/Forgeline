# Setup

> Last updated: 2026-10-14
> Describes commit: 8d96914ded9e91bb1c5da09438a2fb7ff50fb260 (Milestone 1 Skeleton, first commit)

Everything needed to run and test Forgeline on a new machine.

## Required versions

- **Node.js:** 22 or newer (24 recommended). Developed and verified on v24.21.0. Check with `node --version`.
- **git:** 2.31 or newer (the app refuses to start on older git). Verified on 2.47.3. Check with `git --version`.
- **npm:** any recent version that supports `npm ci`. Verified on 11.19.0.

## Install

```
npm ci            # install exactly the versions in package-lock.json (never a fresh resolve)
```

If `esbuild`'s postinstall was blocked by npm's `allowScripts` policy (you may see a warning during install), run its installer once so the Vite build works:

```
node node_modules/esbuild/install.js
```

Playwright needs a browser for the end-to-end tests. Install it once:

```
npx playwright install chromium
```

## Run in development

```
npm run dev:web        # Vite dev server for the frontend only (no backend)
npm run build          # build frontend (dist/web) and server (dist/)
node dist/cli.js       # start Forgeline on an auto-assigned port and open the browser
node dist/cli.js 4700  # start on a specific port
node dist/cli.js --no-open   # start without opening the browser (used by tests)
```

To use the `forgeline` command directly during development:

```
npm link
forgeline --no-open
```

## Tests

```
npm run verify         # typecheck + lint + lint:copy + test + test:e2e (the gate)
npm run typecheck      # tsc for server/CLI/tests and for the web app
npm run lint           # eslint
npm run lint:copy      # banned-phrase scan of UI strings and README
npm test               # vitest unit tests (uses fixture repos, no network)
npm run test:e2e       # Playwright at 1440px and 800px (builds first, then runs the real CLI)
```

## Fixture repos

`scripts/make-fixture-repos.ts` builds throwaway git repos in a temp folder on every test run, using local bare repositories as remotes so no network or account is needed. It covers: clean, uncommitted changes, staged + unstaged in the same file, ahead of remote, behind remote, detached HEAD, an in-progress merge conflict, a repo with no remote, and a repo with a 6 MB file. Tests never touch the developer's real repos.

## Screenshots

```
npm run build
node scripts/capture-screenshots.mjs   # writes screenshots/milestone-1/*.png and reports console errors
```

## Running the tests without a GitHub account

All unit tests and all Milestone-1 end-to-end tests run fully offline against local fixture repos and the local server. No GitHub account, token, or network access is required. Sign-in and any live remote push/pull are not part of Milestone 1; when they arrive (Milestone 6) the GitHub device flow will be tested against a local mock, and any real-account verification will be listed as unconfirmed in `docs/status.md` until a user confirms it.
