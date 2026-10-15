# Status

> Last updated: 2026-10-15
> Describes commit: 51cfa31 (docs: record 698a921 hash in handoff files) plus uncommitted Milestone 2 slice-1 work

## What Forgeline is

A local-first visual git manager. An npm CLI (`forgeline`) starts a Hono server bound to `127.0.0.1` and opens a React + Vite interface in the browser. Everything except remote actions (fetch, pull, push, publish release) works offline. See `docs/spec.md` for the full build prompt.

## Milestone table

| # | Milestone | State |
| --- | --- | --- |
| 1 | Skeleton: CLI + port logic, server serves the React app, theme tokens, layout shell (Paper + Midnight) | done (this session) |
| 2 | Git core: `git.ts` wrapper, parsers, repo scanning, dashboard with live status | in progress (slice 1 done) |
| 3 | Commit flow: file list, hunk staging, diff viewer, commit, sanity check card | not started |
| 4 | Safety: action journal, snapshots, undo timeline, rescue mode, confirmation previews | not started |
| 5 | Error translator with the full starter catalogue | not started |
| 6 | Remote and sign-in: pull, push, GitHub device flow, lazy prompt | not started |
| 7 | Branches, stash, history graph, blame, conflict resolver | not started |
| 8 | Release manager | not started |
| 9 | Polish: remaining themes, display options, Simple mode, extras, CI, README, LICENSE | not started |

## Current milestone and slice

- Milestone 1 (Skeleton) is complete and verified.
- Milestone 2 slice 1 is **done and verified**: repo discovery (`scanRepos`), the `git.ts` read helpers (`currentBranch`, `aheadBehind`, `parseStatusChangedFiles`, `parseRevListCount`, `repoStatusFields`), `GET /api/repos` returning live status with pruning of vanished paths, `POST /api/repos/scan` registering what a picked root contains, and the dashboard Sidebar/Header driven by that data through `useRepos`.
- Next slice is Milestone 2, second slice: **live updates** — `chokidar` watching of `.git/HEAD`, `.git/index`, and `.git/refs` per repo with a 3s polling fallback, a per-repo single-writer queue, and pushing real changes over the existing authenticated `/api/events` SSE endpoint (today it only sends the initial comment and `retry`).

## Latest `verify` result

`npm run verify` is green on this machine (Node v24.21.0, git 2.47.3, Linux).

- typecheck: pass (`tsc -p tsconfig.json && tsc -p tsconfig.web.json`)
- lint: pass (`eslint .`)
- lint:copy: pass (`node scripts/lint-copy.js`)
- test: 43 passed (`vitest run`, 7 files: session, registry, paths, basic, git, scan, repo-summary)
- test:e2e: 36 passed (`playwright test`, desktop 1440px + narrow 800px; 18 tests x 2 widths)

Evidence: this session's `npm run verify` tail shows the 36 e2e checks passing (`36 passed (6.7s)`) and `npm test` shows `Tests 43 passed (43)`.

## Verified flows (Milestone 1)

Each item below was run, not assumed:

- `forgeline` with no port binds to `127.0.0.1` on an OS-assigned port and prints `Forgeline is running at http://localhost:<port>/?t=<token>`. Evidence: `/tmp/noport.log` (port 45527).
- `forgeline 4710` uses the given port. Evidence: `/tmp/free.log`.
- `forgeline 4710` when 4710 is taken prints `Port 4710 is in use. Try 4711, or run forgeline with no port.` and exits with code 1. Evidence: run in this session.
- Invalid port (`abc`, `80`) prints the error plus the usage line and exits 1. `--help` and `--version` work.
- Token exchange: `GET /?t=<token>` returns 303, sets `session=<opaque session id>; HttpOnly; SameSite=Strict; Path=/`, and redirects to `/` (token removed from the address bar). The bootstrap token is single-use, 256 bits, valid 5 minutes; sessions slide an idle window.
- `GET /api/health` without the cookie returns 401; with the cookie returns `{"ok":true}`.
- A request with a foreign `Host` header returns 403.
- The built SPA is served: `/` returns `index.html`; `/assets/*.css` returns the file with `Content-Type: text/css`.
- Ctrl+C prints `Forgeline stopped. Goodbye.` and exits 0.

## Known limitations / not started

- Fonts are not bundled yet. `--font-ui` / `--font-code` / `--font-message` currently fall back to system fonts. Bundling IBM Plex Sans, JetBrains Mono, and Source Serif 4 (weights 400/500/600, Latin subsets, with licences) is scheduled for Milestone 9 (Polish). Until then the three font roles are defined as tokens but render via fallback stacks.
- The dashboard shows empty states only when nothing has been scanned. Once repos are registered the Sidebar lists each repo's name plus `branch · changed · ↑ahead ↓behind` and the Header shows the repo count; `useRepos` refreshes every 3s and on window focus. Milestone 2 adds file watching.
- No `LICENSE` file yet. The spec says to ask the user which license to use rather than choosing silently; `package.json` currently declares `MIT` as a placeholder and this must be confirmed with the user before any publish (Milestone 9).
- The npm package name `forgeline` has not been checked for availability on the npm registry, and nothing has been published. Do not claim it is published.
- Sign-in (`@napi-rs/keyring`, GitHub device flow) is not implemented. It is Milestone 6.
- Only Linux has been run. macOS and Windows are untested.
- The SSE endpoint `/api/events` exists and is authenticated, but it only sends an initial comment and `retry`; it does not yet push real repo-status changes. That arrives with live updates in the next Milestone 2 slice.

## Verified flows (Milestone 2, slice 1)

Each item below was run, not assumed:

- `scanRepos` finds nested repos under a picked root, skips `node_modules` and dot-folders, never descends into a repo it already found, resolves + dedupes symlinked roots, sorts by path, and returns `[]` for a missing root (unit tests, `src/server/scan/scan.test.ts`). A picked root that is itself a repo scans as exactly that repo.
- `repoStatusFields` reads real fixtures: clean repo reports `main` / 0 changed; dirty reports `changedFiles > 0`; detached HEAD reports `HEAD...`; ahead and behind fixtures report their counts; a repo with no upstream reports 0/0.
- `repoStatusFields` never throws: a non-repo directory yields `branch: "unknown"` with zero counts, so one broken repo cannot hide the rest.
- `GET /api/repos` returns `id`, `name`, `path`, `branch`, `changedFiles`, `ahead`, `behind` per repo, sorted by path, and prunes entries whose path has vanished (e2e: register a real repo, assert `main` / 0 changed, delete it, assert it is gone from the next response).
- `POST /api/repos/scan` registers what a picked root contains, returns the same rows, and is idempotent — a second scan of the same root issues no new ids (e2e, plus `GET /api/repos` showing exactly one row per id). A body with no `roots` returns 400.

## Update 1 gaps (ordered by risk, 2026-10-15)

Each gap: what is missing, the file, the planned fix, the test that will prove it.

### Security (closed this run)

1. **Expired bootstrap token e2e — done.** `tests/e2e/basic.spec.ts` mints a token, ages it past the 5-minute TTL via `POST /api/__test__/expire-bootstrap`, and asserts the 401 "expired" notice. `src/server/session.ts` gained `expireBootstrapForTest`; the `/api/*` middleware exempts `/api/__test__/` paths so mint-then-expire works before any session exists. Prove: new Playwright test green at both widths.
2. **Repo-API traversal over HTTP — done.** `GET /api/repos/:id/file?path=` consumes `registry.child` (lexical check), then re-resolves with `resolveRealpath` + `stillInside` before `stat` (200 valid / 400 escape or leading `-` / 404 forged id or missing / 403 symlink swapped in after registration / 413 over 1 MiB). Test-only `POST /api/__test__/roots` + `POST /api/__test__/register-repo` (both `FORGELINE_E2E=1`-guarded) give the e2e suite real roots. Prove: three new Playwright tests green at both widths.
3. **Static-file traversal — done.** `serveStaticFile` is now resolve-then-compare (triple-decode, `\0` reject, normalize + prefix check, realpath re-check, `isFile`). Prove: extended traversal e2e (double-encoding, `%2f`, backslash variants) green plus full suite.
4. **"Not a sandbox" note — done.** `docs/architecture.md` Git execution rules carry the paragraph; `302`→`303` fixed in `docs/architecture.md` + `docs/decisions.md` (`docs/progress.md` keeps the historical entry verbatim). Prove: read-back.

### Recovery (Milestone 4, recorded now so it is not forgotten)

5. **Write-ahead journal, state token, snapshots, failure-injection tests: not started.** Planned fix: Milestone 4 implements the §4 contract verbatim against real fixtures. Prove: SIGKILL injection tests + Undo tests per action.

### Git contracts (Milestone 2/3, recorded now)

6. **`runGit` has no timeout or cancel; `--` before paths is not yet enforced at call sites.** File: `src/server/git/git.ts`, call sites in later milestones. Fix: add timeout (longer for network) + abort, and always pass `--` before paths from `registry.child` results. Prove: unit tests with a slow fake + hunk-fixture suite (CRLF, no-trailing-newline, rename, binary, mode, symlink, spaces/non-Latin names).
7. **Single-writer queue per repo not built.** File: new in Milestone 2/4. Prove: concurrency unit test.
8. **Commit messages must go via `git commit -F -` on stdin.** Fix: apply when the commit flow lands (Milestone 3). Prove: commit e2e.
9. **Scan results are not cached to app-data yet.** `scanRepos` runs on demand per `POST /api/repos/scan`; the spec's cache of scan results in the OS app-data folder is not written. Fix: next slice, alongside live updates. Prove: unit test that a cached scan skips a second disk walk.
10. **The dashboard has no "Choose folders" flow.** The Sidebar still renders a static "Choose folders" button that calls nothing; roots reach the server only through `POST /api/repos/scan` (currently exercised by the test helper). Fix: a real folder-picker surface that posts the picked roots. Prove: e2e that picking a root lists its repos.
11. **`repoStatusFields` runs git three times per repo per refresh** (`status`, `rev-parse --abbrev-ref`, `rev-list`). Fine for a handful of repos; the branch already arrives in the `status --porcelain=v2 --branch` header. Fix: parse the branch header and drop the extra `rev-parse`. Prove: `repoStatusFields` unit test unchanged, plus a spy test that only one git process spawns per repo.

### Everything else (Update 1 §§7-9, deferred to their milestones)

9. **`docs/status.md` still claims `--font-*` flags** in spirit? No — current flags story: the font-role tokens exist with fallback stacks; bundling lands Milestone 9. No fix now; the Known-limitations entry stands.
10. **Starter error catalogue (16 rules), conflict resolver, SSH help, release manager, themes/Simple mode/extras, CI matrix + packed-tarball smoke test:** deferred to Milestones 5-9 per the §3 core-first rule. Each will be recorded in the Deferred list only if its milestone ships it shallow — none has shipped yet, so no Deferred entries today.

## Deferred

None. Nothing has shipped in a shallow form.

- GitHub askpass username format (`x-access-token`) and GitLab (`oauth2`) are taken from the spec, not from a live push. Unconfirmed until Milestone 6 tests a real remote.
- Remote-only git messages (protected branch, GitHub file size limit, HTTP 401/403) are not yet captured as fixtures. They will be marked `source: docs` until seen in real output (Milestone 5).

## Exact next step

Milestone 2, slice 2: **live updates and the per-repo queue.** Add `chokidar` watching of `.git/HEAD`, `.git/index`, and `.git/refs` for each registered repo with a 3-second polling fallback (and a small note when polling is in effect), debounce the events, and push real repo-status changes over the existing authenticated `/api/events` SSE endpoint so the Sidebar refreshes without its own timer. Add a single-writer queue per repo so concurrent git calls in the same repo serialize. Prove: a unit test that two overlapping git calls in one repo never interleave, and an e2e test that a change to a repo's working tree reaches the dashboard through `/api/events` within the debounce window.

Slice 1 left over from the plan: the "Choose folders" surface in `src/web/src/components/Sidebar.tsx` still renders a static button (recorded as gap 10 above) — wire it to `POST /api/repos/scan` in the same slice.
