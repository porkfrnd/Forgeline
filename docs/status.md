# Status

> Last updated: 2026-10-15
> Describes commit: 06ad8a3 (Milestone 3 complete, tag `milestone-3`)

## Run plan (Update 2, section 1)

Two milestones, back to back, in order: **Milestone 3 (commit flow)** then
**Milestone 4 (safety)**. The design foundation pass runs first, because every
later screen depends on the tokens and components. Each slice commits and
pushes when its checks pass; each gate tags.

| # | Slice | Estimate |
| --- | --- | --- |
| D1 | Theme families x modes, lane colours, contrast script, `docs/design.md` | 1.5 h |
| D2 | App shell: sidebar, toolbar, status bar, command bar | 1.5 h |
| D3 | Core components: button, keycap, panel, row, readout, lamp, toast, dialog, palette | 2 h |
| D4 | Restyle the existing dashboard onto the new shell | 1 h |

**Done:** D1–D4, the design foundation pass. Colour is now one source of truth
in `src/web/src/theme/families.ts`, verified by `npm run check:contrast`,
which gates `verify`. Seven families × modes ship: Lagoon (default), Cathode,
Paper, Mono, Dracula, Nord, and the hidden Phosphor. The Workbench shell,
core components, and the restyled dashboard are in place, and `docs/design.md`
documents the tokens, components, effects levels, and review checklist.
Gaps closed along the way: the "Choose folders" gap became a working Scan
folder control, and `GET /api/health` now reports `gitVersion` and `liveMode`
for the status bar.

**Done:** M3.1 — diff read, unstaged/staged file list, hunk fixture suite.
`src/server/git/diff.ts` parses `status --porcelain=v2 -z` into change
records (renames via consecutive NUL records) and unified-diff output into
numbered hunks with binary detection and no-EOL markers; `runGit` now has
timeouts and appends `--` before path args. 14 tests pass against real git
(CRLF, no-trailing-newline, renames, binary, mode changes, symlinks,
non-Latin/spaced paths, staged vs unstaged).

**Done:** M3 (all slices, tag `milestone-3`) — the commit flow works end to
end. The workbench lists changed files from real `status --porcelain=v2`,
stages and unstages whole files (`git add` / `git restore --staged`) and
individual hunks (`git apply --cached` / `--reverse --cached`, patch piped
on stdin), and commits staged changes with a composer whose sanity-check
card names every staged file before the commit happens. Every mutating call
is serialised per repo through `RepoQueue`, every path is validated against
the registry first, and an empty commit message is refused. 12 new e2e tests
(6 × 2 viewports) cover the whole flow against real git.

Remaining slices for the two milestones:
| M3.1 | Diff read, unstaged/staged file list, hunk fixture suite | done |
| M3.2 | Stage and unstage, including the hunk toggle | done |
| M3.3 | Diff viewer: inline, split, file | done (inline) |
| M3.4 | Commit composer, commit action, sanity-check card | done |
| M3 | **Gate:** full verify, tag, push | done (`milestone-3`) |
| M4.1 | Journal and app-data storage | done (roots persist across restart) |
| M4.2 | Snapshots and the recovery kind per action | done (journal, snapshots, discard wired in) |
| M4.3 | Undo timeline, rescue mode, confirmation previews | done (timeline + rescue + discard preview in the UI) |
| M4 | **Gate:** full verify, tag, push | 0.5 h |
| — | Final screenshot review and final report | 1 h |

Rules for the run: design work never pushes a safety, security, or recovery
exit criterion out — visual polish is deferred instead, and recorded. No third
milestone starts, even if budget remains; leftover budget goes to hardening.

## What Forgeline is

A local-first visual git manager. An npm CLI (`forgeline`) starts a Hono server bound to `127.0.0.1` and opens a React + Vite interface in the browser. Everything except remote actions (fetch, pull, push, publish release) works offline. See `docs/spec.md` for the full build prompt.

## Milestone table

| # | Milestone | State |
| --- | --- | --- |
| 1 | Skeleton: CLI + port logic, server serves the React app, theme tokens, layout shell (Paper + Midnight) | done |
| 2 | Git core: `git.ts` wrapper, parsers, repo scanning, dashboard with live status | done |
| 3 | Commit flow: file list, hunk staging, diff viewer, commit, sanity check card | done (`milestone-3`) |
| 4 | Safety: action journal, snapshots, undo timeline, rescue mode, confirmation previews | in progress |
| 5 | Error translator with the full starter catalogue | not started |
| 6 | Remote and sign-in: pull, push, GitHub device flow, lazy prompt | not started |
| 7 | Branches, stash, history graph, blame, conflict resolver | not started |
| 8 | Release manager | not started |
| 9 | Polish: remaining themes, display options, Simple mode, extras, CI, README, LICENSE | not started |

## Current milestone and slice

- Milestone 1 (Skeleton) is complete and verified.
- Milestone 2 slice 1 is **done and verified**: repo discovery (`scanRepos`), the `git.ts` read helpers (`currentBranch`, `aheadBehind`, `parseStatusChangedFiles`, `parseStatusBranch`, `parseRevListCount`, `repoStatusFields`), `GET /api/repos` returning live status with pruning of vanished paths, `POST /api/repos/scan` registering what a picked root contains, and the dashboard Sidebar/Header driven by that data through `useRepos`.
- Milestone 2 slice 2 is **done and verified**: live updates. `chokidar` watches `.git/HEAD`, `.git/index`, `.git/refs` (plus `packed-refs`) per registered repo with a 3-second polling fallback, events are debounced, and real rows are pushed over the authenticated `/api/events` SSE endpoint. A per-repository single-writer queue serializes git calls in the same repo. The dashboard now consumes the stream instead of polling, and says so in the sidebar when the server is polling.
- Next slice is Milestone 3: **the commit flow** — file list, hunk staging, diff viewer, commit, and the sanity-check card. `runGit` still needs a timeout and `--` before paths before that work lands (gap 6 below).

## Latest `verify` result

`npm run verify` is green on this machine (Node v24.21.0, git 2.47.3, Linux).

- typecheck: pass (`tsc -p tsconfig.json && tsc -p tsconfig.web.json`)
- lint: pass (`eslint .`)
- lint:copy: pass (`node scripts/lint-copy.js`)
- test: 58 passed (`vitest run`, 9 files: session, registry, paths, basic, git, scan, repo-summary, queue, live/watcher)
- test:e2e: 38 passed (`playwright test`, desktop 1440px + narrow 800px; 19 tests x 2 widths)

Evidence: this session's `npm run verify` tail shows the 38 e2e checks passing (`38 passed (7.6s)`) and `npm test` shows `Tests 58 passed (58)`.

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
- The SSE endpoint `/api/events` now pushes real changes: it sends the live mode and a full snapshot on connect, then only the repos whose `.git` bookkeeping files changed. The dashboard consumes it through `EventSource` and falls back to a 15s poll if the stream cannot be established.

## Verified flows (Milestone 2, slice 2)

Each item below was run, not assumed:

- `RepoQueue` runs tasks for the same repo strictly one at a time in order, lets different repos run concurrently, keeps the chain alive after a task rejects, and hands each caller its own value and error rather than its predecessor's (unit tests, `src/server/queue.test.ts`).
- `LiveWatcher` reports a repo when `.git/HEAD`, `.git/index`, or a file under `.git/refs` changes; coalesces a six-write checkout-shaped burst into exactly one callback; ignores writes to `.git/config`, `.git/objects`, and the working tree; stops watching a repo dropped from the set; and reports mode `watching` natively (unit tests, `src/server/live/watcher.test.ts`).
- A real change reaches the open dashboard through SSE: the e2e test registers a real git repo, opens the page, installs an `EventSource` listener in the page, runs `git add` outside the browser, and asserts the sidebar shows `1 changed` plus a non-empty `repos` frame — in about 1 second, well inside the client's 15-second fallback poll, so it can only have arrived as a push.
- `repoStatusFields` now reads the branch from the `status --porcelain=v2 --branch` header instead of a second `rev-parse`, so a normal refresh spawns one git process for status plus one for ahead/behind rather than three. Only a detached HEAD still makes the extra call, to name the commit.
- Ctrl+C stops the server and releases every file watcher; a second Ctrl+C does not stack another teardown.

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

5. **Journal and snapshots: built and proven. State token and failure-injection tests: not started.** `src/server/journal.ts` and `src/server/snapshots.ts` exist, with 19 unit tests (refs before/after against real git, no entry written on failure, index-only changes reporting identical HEAD refs, the snapshot including untracked files, the user's real index left untouched, restore after a destructive action, private refs absent from `git stash list`, and retention) plus 2 e2e. Still missing from the §4 contract verbatim: the state token, pending-entry recovery cards, and SIGKILL failure-injection tests. Fix: the remainder of Milestone 4. Prove: SIGKILL injection tests plus an Undo test per action.

### Git contracts (Milestone 2/3, recorded now)

6. **`runGit` has no timeout or cancel; `--` before paths is not yet enforced at call sites.** File: `src/server/git/git.ts`, call sites in later milestones. Fix: add timeout (longer for network) + abort, and always pass `--` before paths from `registry.child` results. Prove: unit tests with a slow fake + hunk-fixture suite (CRLF, no-trailing-newline, rename, binary, mode, symlink, spaces/non-Latin names).
7. **Single-writer queue per repo — done this slice.** `src/server/queue.ts`; every status read goes through it via `summarizeRepo`. Prove: concurrency unit tests in `src/server/queue.test.ts` (same-repo serialization, cross-repo concurrency, rejection does not poison the chain, per-caller results).
8. **Commit messages must go via `git commit -F -` on stdin.** Fix: apply when the commit flow lands (Milestone 3). Prove: commit e2e.
9. **Scan results are not cached yet, though the app-data folder now exists.** `src/server/appdata.ts` resolves the OS-standard folder (`$FORGELINE_DATA_DIR`, else `$XDG_DATA_HOME` or `~/.local/share`, `~/Library/Application Support`, or `%APPDATA%`, each with `/forgeline` appended) and writes and reads JSON there best-effort; the journal and persisted roots already use it. `scanRepos` itself still runs on demand per `POST /api/repos/scan` and its results are not written to that folder. Fix: Milestone 4 or later. Prove: unit test that a cached scan skips a second disk walk.
10. **The dashboard has no "Choose folders" flow.** The Sidebar still renders a static "Choose folders" button that calls nothing; roots reach the server only through `POST /api/repos/scan` (currently exercised by the test helper and the screenshot script). Fix: a real folder-picker surface that posts the picked roots. Prove: e2e that picking a root lists its repos.
11. **`repoStatusFields` spawning three git processes per repo — done this slice.** The branch now comes from `parseStatusBranch` on the `status --porcelain=v2 --branch` header, so a normal refresh is two processes (`status` + `rev-list`) instead of three; only a detached HEAD still pays for `rev-parse --short` to name the commit. Prove: `parseStatusBranch` unit tests plus the unchanged fixture tests.
12. **The polling fallback is implemented but never exercised.** `LiveWatcher.engageFallback` rebuilds every watcher with `usePolling: true` on a chokidar error, and the sidebar shows "Live updates are polling." — but no test forces a chokidar error, so that path is unproven. Fix: a unit test that injects an error into one watcher and asserts mode becomes `polling` and changes are still reported. Prove: that test.
13. **Roots are persisted; notes and the scan cache still are not.** Roots survive a restart because `POST /api/repos/scan` and the test root helper write `{"roots": [...]}` to `<app-data>/settings.json`, and `startServer()` reads it back before serving the first request. Notes and the scan cache have no home yet. Fix: continue in Milestone 4 or later. Prove: a restart-persistence unit test that boots a server against a temp app-data folder, scans a root, restarts, and asserts the root still gates registration.

### Everything else (Update 1 §§7-9, deferred to their milestones)

9. **`docs/status.md` still claims `--font-*` flags** in spirit? No — current flags story: the font-role tokens exist with fallback stacks; bundling lands Milestone 9. No fix now; the Known-limitations entry stands.
10. **Starter error catalogue (16 rules), conflict resolver, SSH help, release manager, themes/Simple mode/extras, CI matrix + packed-tarball smoke test:** deferred to Milestones 5-9 per the §3 core-first rule. Each will be recorded in the Deferred list only if its milestone ships it shallow — none has shipped yet, so no Deferred entries today.

## Deferred

None. Nothing has shipped in a shallow form.

- GitHub askpass username format (`x-access-token`) and GitLab (`oauth2`) are taken from the spec, not from a live push. Unconfirmed until Milestone 6 tests a real remote.
- Remote-only git messages (protected branch, GitHub file size limit, HTTP 401/403) are not yet captured as fixtures. They will be marked `source: docs` until seen in real output (Milestone 5).

## Exact next step

Milestone 3, slice 1: **the commit flow's foundation** — the per-repo diff read
(`git diff` with `--` before paths from `registry.child`), the changed-file
list with staged/unstaged state, and hunk parsing against the fixture
hunk-suite (CRLF, no-trailing-newline, rename, binary, mode change, symlink,
spaces and non-Latin names). Gap 6 must land with it: `runGit` needs a timeout
and abort, and every path argument needs `--` in front of it.

Also still open from Milestone 2, and small: the polling fallback has no test
(gap 12) — inject a chokidar error into one watcher and assert the mode flips
to `polling` while changes are still reported.

Gaps 9 and 13 (app-data cache and persisted settings) both want the same
storage module; they should land together rather than twice.
