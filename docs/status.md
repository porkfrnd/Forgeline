# Status

> Last updated: 2026-10-14
> Describes commit: (none yet — this file is created before the first commit; after committing, the hash will be recorded in `docs/progress.md`)

## What Forgeline is

A local-first visual git manager. An npm CLI (`forgeline`) starts a Hono server bound to `127.0.0.1` and opens a React + Vite interface in the browser. Everything except remote actions (fetch, pull, push, publish release) works offline. See `docs/spec.md` for the full build prompt.

## Milestone table

| # | Milestone | State |
| --- | --- | --- |
| 1 | Skeleton: CLI + port logic, server serves the React app, theme tokens, layout shell (Paper + Midnight) | done (this session) |
| 2 | Git core: `git.ts` wrapper, parsers, repo scanning, dashboard with live status | not started |
| 3 | Commit flow: file list, hunk staging, diff viewer, commit, sanity check card | not started |
| 4 | Safety: action journal, snapshots, undo timeline, rescue mode, confirmation previews | not started |
| 5 | Error translator with the full starter catalogue | not started |
| 6 | Remote and sign-in: pull, push, GitHub device flow, lazy prompt | not started |
| 7 | Branches, stash, history graph, blame, conflict resolver | not started |
| 8 | Release manager | not started |
| 9 | Polish: remaining themes, display options, Simple mode, extras, CI, README, LICENSE | not started |

## Current milestone and slice

- Milestone 1 (Skeleton) is complete and verified.
- Next slice is Milestone 2, first slice: **repo discovery and the `git.ts` read helpers**, i.e. implement scanning of the configured root folders and `getStatus`/`getBranch`/`getAheadBehind` in `src/server/git/`, then wire the dashboard to real data.

## Latest `verify` result

`npm run verify` is green on this machine (Node v24.21.0, git 2.47.3, Linux).

- typecheck: pass (`tsc -p tsconfig.json && tsc -p tsconfig.web.json`)
- lint: pass (`eslint .`)
- lint:copy: pass (`node scripts/lint-copy.js`)
- test: 5 passed (`vitest run`, `src/basic.test.ts`)
- test:e2e: 10 passed (`playwright test`, desktop 1440px + narrow 800px)

Evidence: `/tmp/verify.log` from the run that produced this state; Playwright list output shows `10 passed (5.9s)`; vitest shows `Tests 5 passed (5)`.

## Verified flows (Milestone 1)

Each item below was run, not assumed:

- `forgeline` with no port binds to `127.0.0.1` on an OS-assigned port and prints `Forgeline is running at http://localhost:<port>/?t=<token>`. Evidence: `/tmp/noport.log` (port 45527).
- `forgeline 4710` uses the given port. Evidence: `/tmp/free.log`.
- `forgeline 4710` when 4710 is taken prints `Port 4710 is in use. Try 4711, or run forgeline with no port.` and exits with code 1. Evidence: run in this session.
- Invalid port (`abc`, `80`) prints the error plus the usage line and exits 1. `--help` and `--version` work.
- Token exchange: `GET /?t=<token>` returns 302, sets `session=<token>; HttpOnly; SameSite=Strict; Path=/`, and redirects to `/` (token removed from the address bar).
- `GET /api/health` without the cookie returns 401; with the cookie returns `{"ok":true}`.
- A request with a foreign `Host` header returns 403.
- The built SPA is served: `/` returns `index.html`; `/assets/*.css` returns the file with `Content-Type: text/css`.
- Ctrl+C prints `Forgeline stopped. Goodbye.` and exits 0.

## Known limitations / not started

- Fonts are not bundled yet. `--font-ui` / `--font-code` / `--font-message` currently fall back to system fonts. Bundling IBM Plex Sans, JetBrains Mono, and Source Serif 4 (weights 400/500/600, Latin subsets, with licences) is scheduled for Milestone 9 (Polish). Until then the three font roles are defined as tokens but render via fallback stacks.
- The dashboard shows empty states only. No repos are listed and no git status is read yet. That is Milestone 2.
- No `LICENSE` file yet. The spec says to ask the user which license to use rather than choosing silently; `package.json` currently declares `MIT` as a placeholder and this must be confirmed with the user before any publish (Milestone 9).
- The npm package name `forgeline` has not been checked for availability on the npm registry, and nothing has been published. Do not claim it is published.
- Sign-in (`@napi-rs/keyring`, GitHub device flow) is not implemented. It is Milestone 6.
- Only Linux has been run. macOS and Windows are untested.
- The SSE endpoint `/api/events` exists and is authenticated, but it only sends an initial comment and `retry`; it does not yet push real repo-status changes. That arrives with live updates in Milestone 2.

## Unconfirmed items (per grounding rules)

- GitHub askpass username format (`x-access-token`) and GitLab (`oauth2`) are taken from the spec, not from a live push. Unconfirmed until Milestone 6 tests a real remote.
- Remote-only git messages (protected branch, GitHub file size limit, HTTP 401/403) are not yet captured as fixtures. They will be marked `source: docs` until seen in real output (Milestone 5).

## Exact next step

Milestone 2, slice 1: implement `scanRepos(rootFolders, opts)` in `src/server/scan/` (bounded depth, skip `node_modules` and dot-folders, cache results) and the read helpers in `src/server/git/git.ts` (`status`, `currentBranch`, `aheadBehind`), add `src/server/routes/repos.ts` exposing `GET /api/repos`, and drive the dashboard Sidebar from it. Write unit tests in `src/server/git/git.test.ts` and `src/server/scan/scan.test.ts` against the fixture repos.
