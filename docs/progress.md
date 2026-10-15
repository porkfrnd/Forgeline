# Progress log (append-only)

One dated entry per loop run. Never rewrite old entries. Newest entries go at the bottom.

---

## 2026-10-14 — Milestone 1 (Skeleton): bring the repo from scaffolding to a verified, committable state

**Slice:** Milestone 1 tooling + CLI/server correctness + handoff docs + first commit.

**Context:** The repo started with Milestone-1 scaffolding (CLI, Hono server, React shell, fixture script, lint:copy) but had no `package.json`, no tsconfig/vite/vitest/playwright/eslint configs, no lockfile, an empty `docs/`, and no commits. Two real bugs and one packaging bug were present.

**Plan (checklist):**
- [x] Add `package.json` with `bin`, `engines >=22`, scripts (`dev:web`, `build:web`, `build:server`, `build`, `prepack`, `typecheck`, `lint`, `lint:copy`, `test`, `pretest:e2e`, `test:e2e`, `verify`).
- [x] Add `tsconfig.json` (NodeNext), `tsconfig.build.json` (emit to `dist/`), `tsconfig.web.json` (Bundler/JSX).
- [x] Add `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `.gitignore`.
- [x] Fix `src/server/index.ts`: correct web-build path and add static-asset serving with SPA fallback; handle server bind `error` so a taken port rejects instead of hanging; auth middleware on `/api/*`; Host/Origin/Content-Type checks.
- [x] Fix `src/cli.ts`: guard `main` behind an `invokedAsMain` check so importing it in tests does not start the server; print the `localhost` URL per spec; clean SIGINT shutdown.
- [x] Update e2e spec + add `global-setup`/`global-teardown`/`helpers` that start the real built CLI and capture token/port.
- [x] Install deps, approve esbuild postinstall, install Playwright Chromium.
- [x] Run the loop (steps 3-10) and record results.
- [x] Create handoff docs: `docs/spec.md` (verbatim prompt), `status.md`, `progress.md`, `decisions.md`, `architecture.md`, `setup.md`.
- [x] Commit on `main` only after `verify` is green.

**Steps and results:**
1. Plan — done (this list).
2. Work — see checklist.
3. Static check — `typecheck` pass, `lint` pass, `lint:copy ok`. Two initial typecheck errors were fixed: `ServerType` union lacks `closeAllConnections` (cast to a narrow shape), and e2e relative imports needed `.js` extensions under NodeNext.
4. Unit test — `vitest run`: 5 passed. The fixture test builds real git repos in a temp dir and asserts `.git` and files exist.
5. Run the app — `node dist/cli.js --no-open`. Banner printed `Forgeline is running at http://localhost:<port>/?t=<token>`. Port rules verified: no port (auto 45527), free port (4710), taken port (4710 -> non-zero exit with the spec message), invalid port (`abc`, `80` -> usage line + exit 1). `--help` and `--version` OK. Ctrl+C prints `Forgeline stopped. Goodbye.`
6. API check — `curl`: `/api/health` 401 without cookie, `{"ok":true}` with cookie; foreign `Host` -> 403; `/?t=` -> 302 + `Set-Cookie`; `/` -> index.html; `/assets/index-*.css` -> 200 `text/css`.
7. Browser test — `playwright test`: 10 passed across desktop (1440px) and narrow (800px).
8. Screenshot — `node scripts/capture-screenshots.mjs` wrote 4 PNGs to `screenshots/milestone-1/`.
9. Screenshot review — I viewed all four images (I can view images in this environment). Paper and Midnight, desktop and narrow, all pass the litmus test: calm layout, one blue accent, thin borders, empty states with one sentence + one action, no clipping/overlap. Fixed one artifact: the capture script originally set `data-theme` via `evaluate`, leaving the button label stale; changed it to click the real toggle so React state and the label agree.
10. Error check — capture reported `No console errors or failed requests.` (target zero met).
11. Fix and repeat — the Vite `outDir` was `new URL("../../dist/web", ...)` which resolved outside the project root, so the server served 404 for the SPA. This caused the first e2e run to fail the two UI tests ("Not found"). Fixed `outDir` to `./dist/web` from the config file, cleaned the stray `~/Desktop/dist`, rebuilt, and re-ran: 10 passed.
12. Record and commit — see `docs/status.md` for the next step; commit message describes this slice.

**Errors seen and fixes:**
- `typecheck`: `closeAllConnections` not on `ServerType` -> cast to a narrow interface in `cli.ts`.
- `typecheck`: e2e imports missing `.js` -> added extensions (`./helpers.js`, `./global-setup.js`).
- e2e UI tests failed with body "Not found" -> Vite `outDir` path bug (see 11).

**Screenshot folder:** `screenshots/milestone-1/` (paper/midnight x desktop/narrow).

**Follow-up noted for a human:** none blocking. Font bundling and the LICENSE choice are deferred to Milestone 9 by design.

---

## 2026-10-15 — Update 1 repair: expired-token e2e, file route, traversal, docs

**Slice:** repair of the half-landed Update 1 hardening on top of Milestone 1.

**Context:** a prior `verify`-green claim (26 unit / 22 e2e) left four gaps open: no e2e for expired tokens, no HTTP route exercising `registry.child`, regex-based static serving with one-encoding traversal coverage, and a missing "not a sandbox" note plus stale `302`s.

**Plan (checklist):**
- [x] Fix the mangled comment above `POST /api/__test__/expire-bootstrap` in `src/server/index.ts`.
- [x] Add test-only `POST /api/__test__/roots`, `setRootsForTest` + `registerRepoForTest` helpers, and three file-route e2e tests (valid/400/404, symlink-swap 403, oversize 413).
- [x] Gap 4 docs: "not a sandbox" paragraph in `docs/architecture.md`; `302`→`303` in architecture + decisions.
- [x] Run the build-and-verify loop, update handoff docs, commit + push.

**Steps and results:**
1. Work — `src/server/session.ts` gained `expireBootstrapForTest`; `src/server/index.ts` gained the file route plus the guarded `__test__/roots` + `__test__/register-repo` endpoints; `serveStaticFile` is resolve-then-compare.
2. Static check — `typecheck` pass, `lint` pass, `lint:copy ok`.
3. Unit test — `vitest run`: 27 passed (4 files).
4. Browser test — `playwright test`: 30 passed across desktop (1440px) and narrow (800px).
5. Commit — on `main` with a `Verified:` trailer (`verify` green); push + `ls-remote` confirmation recorded below.

**Commit:** `698a921` — `feat(server): Update 1 repair — expired-token e2e, file route, traversal, docs`
**Push:** `git push origin main` succeeded (`e69952d..698a921 main -> main`); `git ls-remote origin main` returns `698a9211856219f3eb262b90ae9eb81495c414a1`, matching local `main`.

---

## 2026-10-15 — Milestone 2, slice 1: repo discovery, git read helpers, live dashboard list

**Slice:** Milestone 2 first slice — scanning, the `git.ts` read helpers, the live `GET /api/repos`, and the dashboard wired to real data.

**Context:** Milestone 1 shipped a verified skeleton with an empty dashboard. `GET /api/repos` returned `{repos:[{id}]}` only, the registry had no removal, and the Sidebar/Header were static. The scan and git-helper scaffolds existed but were uncommitted and unverified.

**Plan (checklist):**
- [x] Verify the scan + git-helper scaffolds and their tests pass against real fixtures.
- [x] Add `RepoSummary` to `src/shared/types.ts` and `summarizeRepo`/`summarizeRepos` in `src/server/repo-summary.ts` (never throws, sorted by path).
- [x] Add `RepoRegistry.remove(id)` so a repo whose path vanished can be pruned.
- [x] Make `GET /api/repos` return live status (name/path/branch/changed/ahead/behind) and prune vanished paths.
- [x] Add `POST /api/repos/scan` (picked roots, bounded depth, registers what is found, idempotent).
- [x] Wire the dashboard: `useRepos` hook (3s poll + focus refresh), Sidebar repo list, Header repo count.
- [x] Unit tests for the helper and registry removal; e2e for both routes.
- [x] Run the verify loop, update handoff docs, commit.

**Steps and results:**
1. Work — see checklist. `repoStatusFields` is called once per repo per refresh; git runs are `["-C", dir]` kept as their own argv elements with `GIT_OPTIONAL_LOCKS=0`.
2. Static check — `typecheck` pass, `lint` pass, `lint:copy ok`. Two fixes along the way: `src/server/repo-summary.ts` originally imported from `../../shared/types.js` and `../registry.js` (one level too deep — it lives in `src/server/`, not a subfolder), and one new e2e assertion used `res.arrayBuffer()` on an `APIResponse`, which has no such member.
3. Unit test — `vitest run`: 43 passed (7 files; was 27).
4. Browser test — `playwright test`: 36 passed across desktop (1440px) and narrow (800px) — 18 tests x 2 widths, up from 15 x 2.
5. Record and commit — see `docs/status.md` for the next step.

**New tests:** `summarizeRepo` (clean repo, dirty repo, non-repo path -> `unknown` without throwing, explicit name), `summarizeRepos` (sorted by path), `RepoRegistry.remove` (drops from both maps, path re-registers with a new id, unknown id is a no-op), e2e "repo list returns live status and prunes a deleted repo", "scan endpoint finds nested repos and is idempotent", "scan endpoint rejects a body with no roots".

**Known gaps recorded, not fixed:** no scan-result cache in app-data yet (gap 9), the "Choose folders" button is still static (gap 10), and `repoStatusFields` spawns three git processes per repo per refresh when the branch is already in the `status --porcelain=v2 --branch` header (gap 11). All three are listed in `docs/status.md` with their proving tests.

**Commit:** `27b169a` — `feat(m2): repo discovery, git read helpers, live dashboard list`
**Push:** `git push origin main` succeeded (`51cfa31..27b169a main -> main`); `git ls-remote origin main` returns `27b169a4353d7c38608afc355aa5398877538de1`, matching local `main`.

---

## 2026-10-15 — Milestone 2, slice 2: live updates, per-repo queue, README

**Slice:** live updates over SSE, the single-writer queue, one fewer git process per refresh, and a real README.

**Context:** slice 1 shipped a dashboard that refreshed on a 3-second client-side timer. The spec wants file watching with a polling fallback, a per-repo single-writer queue, and pushes over the existing SSE endpoint, which at that point only sent a comment and a `retry`.

**Plan (checklist):**
- [x] Add `src/server/queue.ts`: per-repo single-writer queue, used by every status read.
- [x] Add `chokidar` (v4.0.3) and `src/server/live/watcher.ts`: watch `.git/HEAD`, `.git/index`, the `refs` subtree and `packed-refs`, debounce, 3s polling fallback with a visible note.
- [x] Make `/api/events` push real rows: mode + full snapshot on connect, then only changed repos.
- [x] Drive the dashboard from `EventSource`, falling back to a slow poll if the stream cannot be established.
- [x] Read the branch from the `status --porcelain=v2 --branch` header instead of a second `rev-parse`.
- [x] Stop watchers and the server cleanly on Ctrl+C; guard against a second signal.
- [x] Unit tests for the queue, the branch parser, and the watcher; e2e for the SSE push.
- [x] Capture real M2 screenshots and write `README.md`.
- [x] Run the verify loop, update handoff docs, commit + push.

**Steps and results:**
1. Work — see checklist. `summarizeRepo` takes an optional queue so the read path serializes per repo while different repos still run concurrently.
2. Static check — `typecheck`, `lint`, `lint:copy` all pass.
3. Unit test — `vitest run`: 58 passed (9 files; was 43).
4. Browser test — `playwright test`: 38 passed across desktop (1440px) and narrow (800px) — 19 tests x 2 widths.
5. Screenshots — `node scripts/capture-screenshots-m2.mjs` wrote 4 PNGs to `screenshots/milestone-2/` with three real throwaway repos (clean, uncommitted, unpushed commit) scanned through the real API. Console was clean. **Not visually reviewed:** the model that wrote this cannot view images, so the screenshots are unverified by eye and should be checked by a human before being treated as approved.
6. Record and commit — see `docs/status.md` for the next step.

**The interesting bug.** Watching `[.git/HEAD, .git/index, .git/refs]` as three separate chokidar targets silently failed: chokidar computes a common base for the path set and applies `depth` from there, so the depth budget was spent walking back down into `.git` and changes inside `refs/` were never reported. `getWatched()` showed the repository root being watched instead of the ref files. Fixed by watching `.git` once with `depth: 3` and an `ignored` predicate that admits only `HEAD`, `index`, `packed-refs`, and the `refs` subtree — verified to fire on all three and stay silent for `.git/config`, `.git/objects`, and working-tree files. Both behaviours are now tests.

**Two smaller fixes along the way:** `src/server/repo-summary.ts` had imported one directory level too deep; the DOM lib's `WritableStreamDefaultController` is neither generic nor equipped with `enqueue` in this config, so the SSE writable side is typed structurally. One e2e assertion also used `res.arrayBuffer()` on an `APIResponse`, which has no such member.

**New tests:** `RepoQueue` (same-repo order, cross-repo concurrency, rejection does not poison the chain, per-caller results, pending/forget); `parseStatusBranch` (branch, detached, missing header, name with spaces); `LiveWatcher` (HEAD change, burst coalescing, unwatched repo ignored, set membership changes, refs/index watched, `.git` noise ignored); e2e "a change in a watched repo reaches the dashboard over SSE".

**Dependency:** `chokidar@4.0.3` added to `dependencies` and the lockfile. `npm audit` is unchanged by it — the 6 reported vulnerabilities are pre-existing dev-dependency issues in vitest's tinypool chain, confirmed by stashing the change and re-auditing.

**README:** rewritten from a two-line stub into the real thing — principles, status with an explicit "not published" warning, requirements, run and port rules, how scanning and live updates work, the security model, development commands, layout, and the docs map. Screenshots embedded are from `screenshots/milestone-2/` (see the unverified-by-eye note above).

**Gaps recorded, not fixed:** the polling fallback has no test (new gap 12); settings and the scan cache are still memory-only and want a shared app-data module (gaps 9 and 13); the "Choose folders" button is still static (gap 10).

**Commit:** `13e9856` — `feat(m2): live updates over SSE, per-repo queue, real README`
**Push:** `git push origin main` succeeded (`e37abc7..13e9856 main -> main`); `git ls-remote origin main` returns `13e9856caafdd2819c4ecf9f9d9d7f2d170baf80`, matching local `main`.

---

## 2026-10-15 — Design foundation pass (D1–D4): families, contrast gate, Workbench shell

**Slice:** Update 2 §3 and Update 3 §3 design foundation, before any new interface.

**Context:** the app still looked like the spec's restrained original. Update 2 replaced that direction and Update 3 supplied the Workbench layout and the theme families. Every later screen depends on these tokens and components, so the pass runs first.

**Plan (checklist):**
- [x] D1 — `families.ts` as the single source of truth for colour; seven families × modes; `check-contrast.mjs` as a `verify` gate; `docs/design.md`.
- [x] D2 — Workbench shell: sidebar, toolbar, work area, status bar.
- [x] D3 — Core components in `tokens.css`: button, keycap, panel with ticks, row, readout, lamp, heatbar, watcher dot, toast/dialog/palette surfaces.
- [x] D4 — Restyle the dashboard onto the shell; appearance controls for family, mode, surface, effects, density.

**Steps and results:**
1. Work — see checklist. Colours live in TypeScript, not CSS, so the contrast script reads the same file the app does and a family and its modes cannot drift. `ThemeProvider` turns a family + mode + surface into custom properties; Solid composites translucent surfaces over the base so they are genuinely opaque.
2. Contrast gate — `npm run check:contrast` runs 297 text/graphic pairs and 264 lane checks. It failed on the first run with 12 real problems, all fixed: Mono's light lanes were light greys on a white panel (inverted); four families had heat ramps too narrow to encode anything; several lane sets had neighbours too close to tell apart, including a wrap-around from the last lane back to the first.
3. Static check — `typecheck`, `lint`, `lint:copy` pass.
4. Unit test — `vitest run`: 58 passed (unchanged; no server logic changed here beyond `health`).
5. Browser test — `playwright test`: 40 passed across desktop and narrow, up from 38. Two new tests cover the appearance panel (family, mode, Effects Off, and a family lacking a mode disabling it) and the command palette.

**Two bugs found and fixed:**
- The narrow (800px) layout had `grid-template-rows` with four rows but only three grid areas, and hid the sidebar outright. A hidden repo rail means no way to switch repositories on a small screen, so the rail now becomes a horizontal strip instead of disappearing.
- The new palette e2e test pressed Ctrl+K before React had mounted, so the shortcut listener was not attached yet. The test now waits for the shell first. The app was correct; the test raced it.

**Slot rule applied:** Fetch, Pull, Push, Branch, Merge, and Stash are not drawn at all — not as disabled stubs. They appear when their features meet their exit criteria. The toolbar currently shows only the search field and appearance, both of which work.

**Gaps closed:** the static "Choose folders" button (old gap 10) became a working Scan folder control posting to `POST /api/repos/scan`; `GET /api/health` now returns `gitVersion` and `liveMode` so the status bar shows real data.

**Commit:** design foundation pass.
**Push:** after each step, per Update 2 §2.

---

## 2026-10-15 — M3 foundation: diff parsing, README screenshots of new themes

**Slice:** Milestone 3 commit-flow foundation + README refresh with the new design screenshots.

**Context:** the next commit-flow slice needs to read what git changed and render it. Before any UI, I needed a trustworthy changed-file list and a unified-diff parser that handles the file shapes that break viewers.

**Plan (checklist):**
- [x] `git.ts`: runGit timeouts (PATIENCE_MS 15s local / IMPATIENCE_MS 120s fetch/push), SIGKILL on timeout, `withPaths()` appends `--` before path args so a path beginning with `-` can never be read as an option.
- [x] `diff.ts`: `parseStatusFiles()` from `status --porcelain=v2 -z` into staged/unstaged/conflicted change records (renames via consecutive NUL records); `parseUnifiedDiff()` into numbered hunks with add/del/context line numbers, binary-file detection, `\ No newline at end of file` markers; `readChangedFiles()`, `readFileDiff(staged|unstaged)`, `readRepoDiff()`.
- [x] `diff.test.ts`: 14 tests against real git covering CRLF, missing trailing newline, renames, binary blobs, mode-only changes, symlinks, non-Latin and spaced paths, staged-vs-unstaged separation, unknown paths.
- [x] `README.md`: hero screenshots replaced with the new themes (Lagoon dark, Cathode dark, Paper light, Nord dark, Mono solid, Effects Off) captured from the running app; updated themes table (family × modes) and capture command; updated Status and Layout sections for the new design.

**Steps and results:**
1. Work — see checklist above.
2. Contrast gate — `npm run check:contrast` green (297 text/graphic pairs + 264 lane checks across 7 families).
3. Typecheck, lint, lint:copy — pass.
4. Unit test — `vitest run`: 72 passed (58 existing + 14 new diff tests).
5. Frontend build — `vite build` succeeds.
6. Browser test — `playwright test`: 40 passed across desktop and narrow.
7. Screenshots — `scripts/capture-screenshots-design.mjs` seeds `localStorage.forgeline-appearance` before the app boots and captures the Workbench across themes; all seven are under 1MB.

**Verified:** `npm run verify` fully green (contrast, typecheck, lint, lint:copy, 72 unit, 40 e2e) on Node v24.21.0 / git 2.47.3 / Linux.

**Commit:** `6012010` — `feat(server): parse changed-file records and unified diffs`.
**Push:** `git push origin main` succeeded (`b44f0fd..6012010 main -> main`); `git ls-remote origin main` matches local `main`.

---

## 2026-10-15 — Milestone 3 (commit flow): staging, hunk toggling, commit composer

**Slice:** Milestone 3, the full commit flow, built on the diff parser and pushed to the gate tag.

**Context:** M3.1 gave us a trustworthy changed-file list and unified-diff parser with no write path and no UI. The user said "continue working," so the remaining three slices ran in sequence.

**Plan (checklist):**
- [x] M3.2 — stage/unstage whole files, stage/unstage a single hunk.
- [x] M3.3 — diff viewer rendering numbered hunks with +/- prefixes.
- [x] M3.4 — commit composer, commit action, sanity-check card.
- [x] M3 gate — full verify, tag, push.

**Steps and results:**
1. Work — `runGit` gained an optional stdin pipe so `git apply` can consume a hunk patch rather than a temp file. Four write endpoints plus two read endpoints (`/changes`, `/diff`), all serialised per repo through `RepoQueue`, all validating the path against the registry before git runs, all putting paths behind `--`.
2. Static check — `typecheck` clean. Two fixes along the way: standalone Hono route helpers needed an explicit `Context` parameter type (Hono infers it for inline handlers but not for extracted functions), and `c.req.param("id")` is `string | undefined`, so every extracted helper takes an explicit `if (!id) return c.notFound();`.
3. Typecheck also caught two frontend mistakes worth recording: my new components sat in `src/web/src/components/` but imported from `./git.js` instead of `../app/git.js`, and I used CSS variables that do not exist as theme tokens (`--panel-hover`, `--font-mono`, `--text-muted`, `--heat-3`). Colour in this project comes from `families.ts` and reaches CSS as custom properties set by `ThemeProvider`; anything not in that file has to be spelled out.
4. Unit test — `vitest run`: 72 passed (unchanged; the new logic is HTTP-level and is covered by e2e).
5. Browser test — `playwright test`: 52 passed, up from 40. Six new tests, each at desktop (1440px) and narrow (800px).
6. Record and commit — see below.

**The interesting bug — a leak, not a crash.** All 26 desktop tests passed. Every narrow test after the first M3 test then failed: "No folders scanned yet." was gone, and the SSE test saw *two* repos both named `demo`. The cause was in my own new test "write paths reject a forged repo id and an escaping path": it called `makeCommitRepo` (which registers a repo server-side) and never deleted the temp directory. Because e2e runs both viewport projects against one long-lived server, that live repo stayed registered for every later test in the narrow pass. The tests were not racing; they were remembering. Fixed with a `try/finally` cleanup, and the reason is now a comment on that `finally` block so the next person does not repeat it. Two of the failures it caused were in tests I had not touched, which is exactly why the leak was worth chasing rather than working around.

**New tests (e2e):** changes/diff report real working-tree state; stage → commit → clean worktree proven via `git log`; an empty commit message is 400 and writes nothing; a single hunk staged through `git apply --cached`; a forged repo id 404s and an escaping path 400s before git runs; the workbench lists the file, stages it, shows the composer naming the staged file, refuses an empty message, and commits.

**Slot rule applied:** Pull, Push, Fetch, Branch, Merge and Stash are still absent from the interface — not disabled, not stubbed. Stage, unstage, and commit exist because their features do.

**Commit:** `aee647a` — `feat(m3.2): stage and unstage, including hunk toggling`; `06ad8a3` — `feat(m3.4): commit composer, commit action, sanity-check card`.
**Push:** both to `main`; `git tag milestone-3` pushed as the gate.

## M4.1 — journal and app-data storage (commit `7112d1f`)

**Steps and results:**

1. Work — `src/server/appdata.ts` resolves the OS-standard app-data folder and is the only module that writes JSON there; `src/server/journal.ts` holds the spec's entry shape and the `journaled()` wrapper that every mutating action now goes through. Three private concerns were settled while building them:
   - **The folder resolves once and caches.** A test that changes `$XDG_DATA_HOME` after the first call would otherwise silently keep the old answer, so the cache has its own reset and `$FORGELINE_DATA_DIR` is read inside `appDataDir()`, not at module load.
   - **A missing file and a corrupt file look the same.** Both read as absent. A half-written journal from a killed process must not break the timeline.
   - **Writes never throw.** A read-only home degrades to memory-only. The journal is a safety feature; it must not be able to take the app down.
2. Static check — `typecheck` clean. One real catch: `journal.ts` imported `appDataFile` it never used, which `tsc` flagged under `noUnusedLocals`. Also found and fixed an infinite recursion I had written by reflex (`return cachedDir();`) — TypeScript accepted it because `cachedDir` is `string | null` and calling a `string` is a type error only at runtime; it would have hung the process on the first read.
3. Unit test — `vitest run`: 91 passed (up from 72). 19 new tests, run against real git in throwaway repos: refs before/after, no entry on a failed action, an index-only change honestly reporting identical HEAD refs, a non-undoable entry carrying its reason, and the journal never landing inside a repo.
4. Browser test — `playwright test`: 54 passed (up from 52). Two new tests, one per viewport.
5. Out-of-band proof for gap 13 — with the server killed and restarted against the same data dir, registering a repo inside the previously scanned root succeeded *without scanning again*, and a path outside it was still refused. That is the restart persistence the gap asked for, proven rather than asserted.
6. Record and commit — see below.

**Two test bugs worth recording, because they were both mine and neither was in the code.** The first test wrote app-data to `/proc/definitely/not/writable` and timed out at 60s: nothing about that path fails fast, it just hangs. The reliable way to prove best-effort storage is a path that fails *immediately* — a file name that is already a directory, so the write gets `EISDIR`. The second test tried to make `git commit` fail by unstaging a file, then asserted a non-zero exit; `git rm --cached a.txt` had left a staged *deletion*, so the commit succeeded. The honest way to force a failure is `git add -- no/such/file.txt`, which fails every time without depending on what the index holds.

**Commit:** `7112d1f` — `feat(m4.1): app-data storage and the action journal`.

## M4.2 — snapshots and the recovery kind per action

**Steps and results:**

1. Work — `src/server/snapshots.ts` builds a snapshot from a temporary index so the user's real index is never touched while one is being made, and `POST /api/repos/:id/discard` is the first risky action, taking a snapshot before it throws anything away and returning the ref in its response body.
2. The spec asked for the real index to be recorded "so the staged state can be restored", but reading the worktree tree back restores every file *and flattens the staged/unstaged distinction*. So two private refs are written: `refs/forgeline/snapshots/<ts>` for the working tree (`read-tree --reset -u`) and `refs/forgeline/snapshots/<ts>.index` for the index alone (`read-tree`, no `-u`). Neither appears in `git stash list`, which is the whole point of a private ref.
3. Static check — `typecheck` clean after removing two pieces of my own scaffolding: a `refFor()` helper that was a convoluted no-op, and four `for-each-ref` format fields nobody read.
4. Unit test — `vitest run`: 99 passed (up from 91). 8 new tests. Two failed first, both of them my test's fault rather than the code's, and one of them interesting:
   - **The trailing-newline trap.** A restored tree SHA compared against a captured tree SHA and they printed identically but differed, because `git write-tree` emits a newline and I had trimmed one side. Fixed in the test helper, which now trims for everyone.
   - **Wrong prune arithmetic.** I asserted 51 deletions from 52 refs and got 2. The code was right: newest 50 are kept, so only the 2 oldest of the ancient ones go. My test had quietly assumed all 51 would go, which is the opposite of the "latest 50" rule it was supposed to be proving.
5. Browser test — `playwright test`: 56 passed (up from 54). Two new tests.
6. **The discard bug that only a real run found.** The endpoint's git call was `runGit(withPaths(["checkout","--force","--"], paths))`. It returned 500 on the first e2e run, and the git error was `error: pathspec '--' did not match any file(s) known to git`. Two separate mistakes stacked:
   - `withPaths` already appends the `--` separator, so passing my own made two and git read the first as a pathspec.
   - Even with that fixed, one `checkout --force` covering *all* paths fails outright when any single path is untracked — which would silently leave the tracked ones dirty. It has to be per-path.
   - And a third, found by running the logic by hand rather than trusting the test: `git checkout --force` on a **newly added** file is a no-op, because there is no committed version to restore. Discard has to drop it from the index and delete it. Verified all three cases (modified tracked, new staged, new untracked) leave the worktree clean.
7. Record and commit — see below.

**Recovery contracts are now recorded per action** in `docs/architecture.md`: stage/unstage and commit are exact undo; discard is exact undo via the ref it returns; push and release are irreversible and will say so in one sentence. Merge, rebase, and reset are unclassified until built and tested against real fixtures.

**Tests (e2e):** a commit is journaled with its command and its refs, and the repo stays clean afterwards; discarding changes takes a snapshot that still contains the exact discarded text, is absent from `git stash list`, and is named in the journal.

## M4.3 — undo timeline, rescue mode, confirmation previews

**Steps and results:**

1. Work — journal entries now carry an **undo plan** written at the same moment as the action, because the code that just staged the paths or ran `git apply` already knows exactly what the reverse is. Deriving it later by parsing the command string would be guesswork, and guessing is what this whole milestone exists to avoid. `undoCommand()` maps a plan to its git and is the single definition of "the reverse of this", shared by the server and the tests.
2. `POST /api/journal/:id/undo` executes a plan. It **snapshots first, always**, because an undo that goes wrong has to be recoverable too, and it journals itself so the undo can be undone back. An entry with no plan, or one marked non-undoable, answers 400 with the reason in one sentence instead of running something random.
3. `POST /api/repos/:id/rescue` is the spec's "reset to clean state, keep my work" button: snapshot, then park HEAD under `refs/forgeline/backup/<ts>` so no local commit is lost, then `reset --hard`, then journal it with the snapshot as its own undo.
4. The UI gets three things. An **Undo timeline** panel (toolbar button and a "Safety" group in the palette) listing entries newest-first with plain English, the time, an honest HEAD-moved-or-not note, the snapshot ref when one was taken, the exact command behind a toggle, and an Undo button **only** for entries whose recovery is proven. A **discard confirmation** that replaces the Discard button in place rather than throwing up a modal, because what you are about to destroy should sit next to the file it belongs to. Rescue is reachable through the palette's Safety group.
5. **A real filter bug caught by driving the actual UI.** The timeline rendered and was empty. The cause: I filtered `entries.filter(e => e.repoPath === repoId)`, but `repoId` is an opaque registry ID and `repoPath` is a filesystem path — they never match, so the filter silently matched nothing and showed a plausible-looking "Nothing has happened yet". Fixed by passing the selected repo's path, and the prop is now documented as taking a path *specifically so this cannot be reintroduced*.
6. **A latent event-bubbling bug found the same way.** The file row's click handler opened the diff viewer, so clicking Stage or Discard inside the row also opened the diff. It had never failed a test because the composer renders outside the file/diff ternary. Moved the handler onto the path itself, which is the semantic truth: clicking the *path* opens the diff.
7. Two cosmetic wording fixes along the way: an undo description that read "Undid: Committed: Commit to undo" is a stutter in a timeline, so it is now "Undone — Committed: Commit to undo"; and the throwaway `refFor()` and four unread `for-each-ref` format fields were deleted.
8. Unit test — `vitest run`: 104 passed (up from 99). `undoCommand` tests for every plan kind, dash-leading paths surviving behind `--`, and the plan being written or honestly absent.
9. Browser test — `playwright test`: 66 passed (up from 56). Five new API tests (undo of a commit keeps the work tree; undo of a discard restores the exact text; rescue leaves a clean tree and parks HEAD; an unknown entry is a 404) plus one UI test asserting the panel shows plain English, the command behind a toggle, and a real Undo button rather than a "Cannot be undone" label.

**Verified by driving the real browser**, not just by assertions: the Discard confirmation appears with its warning, completing the discard empties the file list, and the timeline then shows the entry "Discarded local changes in a.txt", its snapshot ref, and the command `git checkout --force -- a.txt`. All three new endpoints were also proven by hand against a running server before the tests were written, which is how the `--` duplication and the untracked-path bug in M4.2 were found.

**Slot rule applied throughout:** every control drawn has a working feature behind it. There is no disabled Undo, no greyed-out action, and no button for merge, rebase, reset, push, or release.

## M5.1 — the translator, verified against real git output

**Steps and results:**

1. `src/server/git/errors.ts` holds the catalogue. Every rule is `{ matches, build }`; `translateError(output, command)` returns `{ code, title, explanation, fixes, raw }`, and the raw output is preserved verbatim behind every card. `ForgeError.fixes` gained a shape (`ErrorFix[]` with an `id` and a `label`) rather than staying `string[]`, because a fix has to be a button the interface can map to an action, not a sentence.
2. **A discovery pass before a single pattern was written, and it was worth it.** Patterns first run against every situation the catalogue claims to cover produce git's actual output on this machine: git 2.47.3, Linux. Four findings no amount of memory would have caught:
   - **Several failures go to STDOUT, not stderr.** A merge conflict (`Auto-merging f.txt` / `CONFLICT (content): Merge conflict in f.txt`), `nothing to commit, working tree clean`, and `HEAD detached at <sha>` all print to stdout. A translator reading stderr alone translates none of them. The function takes the combined output, and every caller is documented to pass both.
   - "no upstream branch" is never what git says. The real message is `fatal: no upstream configured for branch 'main'`.
   - A held lock reads `fatal: Unable to create '…/.git/index.lock': File exists.` followed by a paragraph explaining it — not "index.lock exists".
   - An unresolved merge says `error: Merging is not possible because you have unmerged files.` / `Committing is not possible because you have unmerged files.`, never "you are in the middle of a merge".
3. Real 401/403 wordings were captured from a live local HTTP fixture, not imagined: `fatal: could not read Username for 'http://127.0.0.1:35765': terminal prompts disabled` for 401, and `remote: 403 Unauthorized` / `The requested URL returned error: 403` for 403. Getting them took a fix worth recording: an in-process HTTP fixture served with `spawnSync` **deadlocks**, because `spawnSync` blocks the event loop and the fixture can never answer. The fixture has to be served while git runs, so round 3 uses async spawn.
4. `src/server/errorHistory.ts` is the local record the spec asks for: which errors were hit, which fix was chosen, and whether it worked. `fixScorecard(code)` is the reason it exists — it can tell a card that one button works and another doesn't, and it deliberately ignores entries whose fix was never tried so an untried remedy is never scored as a failure.
5. All six ad-hoc `{ code: "git-error", title: res.stderr }` responses in `index.ts` now go through one `gitFailure(c, res)` helper, so every route speaks the same language and a conflict gets a 409 rather than a 500. Six new endpoints carry the fixes that have real actions today: init, identity, abort-merge, remove-lock (snapshot first, confirmation required), and a read-only running-git check.
6. **Abandoning a merge is deliberately NOT undoable.** Restoring a snapshot brings back the files and the index but not MERGE_HEAD — the state of "a merge is in progress" — so calling that an undo would be a lie that loses the merge. A snapshot is taken, the entry records the refs either side, and `notUndoableReason` says exactly that in one sentence.
7. Suite — unit **140 passed** (24 translator tests + 12 history tests). **10 of the translator tests run real git in real temp repositories** and feed its actual output in, which is how a wording-only mistake is caught. Browser — **82 passed** (8 new × 2 viewports), including a commit with no identity returning a real card, the identity fix making the *same commit then succeed*, init creating a repository git itself can read, abort restoring `ours\n` and clearing the conflict markers, and the card's absence being asserted before anything fails.

**Two mistakes worth recording.** First, I ran `git config --global --remove-section user` while checking an option name and **deleted the developer's global git identity**. Both values were recoverable from this repository's own commit objects (`Binayak <bi728386@gmail.com>`) and were restored immediately and verified. The correct isolation for the no-identity case was the e2e server's env (`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointing at an empty file in `global-setup.ts`), which is what the tests now use — a file, not an empty variable, because git treats an empty variable as "look at the default path". Second, `spawnSync` reports its exit status as `status`, and my first assertion read `exitCode`, which is `undefined` and would have passed vacuously.

## M6.1 — fetch, pull, push against a real remote

**Steps and results:**

1. `src/server/git/remote.ts` is the remote layer. It returns a `RemoteResult` that carries `GitRun`'s own fields, which is what lets a fetch, pull, or push be journalled by the same `journaled()` every other action uses rather than through an adapter that would have had to invent a command string.
2. **`changed` is observed, not read.** First pass trusted git's output — `fetch` prints something when it does something — and two tests failed immediately: `git fetch` against a *local* bare remote prints absolutely nothing even when refs move, and `git push` prints "Everything up-to-date" for a no-op while `git pull` prints "Already up to date." for one. There is no wording to parse, so `refFingerprint()` snapshots `refs/heads` and `refs/remotes` either side of the run and compares. A byte-identical fingerprint is the only honest "nothing changed".
3. `push --set-upstream` alone is **refused** by git: "fatal: The current branch main has no upstream branch." It has to be told which remote, so the args are `--set-upstream origin HEAD`. With no remote argument at all, `git push` in a remote-less repo produces the honest "No configured push destination" rather than a misleading complaint about 'origin'.
4. `pull` passes `--no-rebase` explicitly, and not as a preference: **git 2.34 and newer refuses a pull when the two sides have diverged and no reconciliation mode is configured**, printing "You have divergent branches and need to specify how to reconcile them" instead of doing anything. Merging is also the right default for a button labelled Pull.
5. Sign-in is deliberately absent from this slice. A remote that already works through SSH keys on the machine, or a public HTTPS one, just works — and a push that fails for want of a credential comes back as a `remote-auth` card, which is what will offer sign-in. That is the spec's lazy prompt, earned by a real failure rather than pre-empted by a login screen.
6. **`gitFailure`'s status was wrong for a year of quiet correctness.** Nearly every translated code means "the repository's own state does not permit this" — a held lock, a merge in progress, no upstream yet, nothing to commit — which is 409 Conflict, not 500 Internal Server Error. Now only the remote-fault codes (`remote-unreachable`, `remote-auth`, `remote-not-found`, `ssh-key`, `host-key`, `no-remote`, `remote-exists`) get 502, because the far end is the problem and retrying later may help. Nothing in the suite pinned 500, which is exactly why nobody noticed: the card was always right and only the status lied.
7. `<RemoteBar>` is drawn only when the repository has a remote, so a local-only repository never shows disabled buttons it cannot honour. It also takes the opaque registry id, and the prop comment says it is not a filesystem path — the same confusion that once made the undo timeline look permanently empty.

**One e2e lesson worth keeping.** Three of my new tests navigated to `baseUrl` with a page that had no session, so they silently saw an empty workbench. Every UI test in this file already navigates with `?t=${token}`; the page and the API client need separate sessions because each minted token is its own. Two of the twelve failed for exactly this and passed the moment the navigation was fixed.

## M6.2 — sign-in, verified against a mock instead of guessed at

**Steps and results:**

1. `src/server/config.ts` reads `GITHUB_CLIENT_ID`, `GITHUB_BASE_URL`, and `GITHUB_DEVICE_URL` from the environment. The base URL is overridable for two stated reasons: so the device flow can be tested against a local mock (which the spec requires until a real app exists), and so a self-hosted instance works. A client id is never invented — the file says why, in the comment, in the words that matter: a guessed id would make every Forgeline install authenticate as whoever registered it, with whatever repositories their token can reach.
2. `src/server/tokenStore.ts` is the one place a token may live. It probes the keychain by writing a value and reading it back, because `secret-tool` being installed is not the same as a Secret Service running — on a machine with no D-Bus session the two look identical until you try. The fallback is **memory only** and it carries a notice saying so; a plain file is never used, because that would put a live GitHub token beside the repositories it can push to. On this machine the probe fails and memory is what actually runs, so the notice is real rather than theoretical.
3. `scripts/askpass.mjs` is the only route a token takes to git. git asks for a username and then a password, so the script answers `x-access-token` to the first and the token to the second, reading it from `FORGELINE_TOKEN`. `GIT_TERMINAL_PROMPT=0` is set alongside it so a failed askpass answer is an error rather than a hang — which matters because a hung git is a request the interface waits on forever.
4. `src/server/auth.ts` defines the `AuthProvider` interface and implements GitHub's device flow. The token never crosses the HTTP boundary: `/api/auth` answers `signedIn` plus the name and avatar and nothing else, because a token in a JSON response is a token in a devtools window. The four polling states are ordinary states, not exceptions — an unknown error string is treated as "expired" so the interface offers to start again rather than spinning.
5. The prompt is lazy in the tested sense. `AUTH_FAILURE_CODES` is a set of codes **the translator actually emits** — `remote-auth`, `ssh-key`, `host-key` — and listing a code git never produces would be a prompt that never appears. A push refused for want of a credential opens it on its own; a `no-upstream` push does not, because an account would not have helped there.

**Two things the first attempt got wrong, both caught by tests.** The e2e fetch to `/api/auth` went out without a session cookie and parsed the app's own HTML as JSON, which looked exactly like "not signed in" and proved nothing. And the auth-failure test pushed an unpublished branch, so git refused with `no-upstream` before it ever opened a connection — the 401 was never reached. Pointing the branch at the remote fixed it, and the prompt then appeared on its own.

## M7.1 — branches, and a translator bug that a port number found

**Steps and results:**

1. `src/server/git/branches.ts` does list, create, switch, adopt-a-remote, delete, and rename. It uses `git switch`, not `git checkout`, because a branch called `feature` and a path called `feature` are both legal and only `switch` refuses to guess. Delete is two functions rather than one flag, so the unmerged case has to be asked for rather than defaulted.
2. `currentBranch` is exported because every question about the result of switching is really "which branch am I on now", and `symbolic-ref` is the only honest way to get it. `git branch --show-current` prints an empty line when detached, which reads like a branch with no name.
3. 13 unit tests and 4 e2e tests, all real repositories on disk, and every branch state assertion answered by git rather than by the API's own reply.

**A bug worth recording, because it was found by a test and would not have been found by reading.** The M6 sign-in e2e passed and then failed, and the card had changed from "the remote needs you to sign in" to "the remote refused you — permissions problem". Nothing in the sign-in code had changed. The cause: `has(output, "http", "403")` was matching the *port number*. The local fixture was on `http://127.0.0.1:40387`, which really does contain "403", so a 401 was translated as a permissions problem. It had been passing before because the fixture had a different port.

Fixing it exposed a second instance of the same class of mistake: the rule matching `"unable to access"` plus `"http"` claimed *every* unreachable remote was a credentials problem, so a hostname that didn't resolve told the user to set up sign-in. `git` prints "unable to access" identically for a typo and for a refusal, so that wording cannot separate them. Both rules now match only what a credential refusal actually prints — `authentication failed`, `could not read username`, `terminal prompts disabled` — and the network rule takes the rest. Wrong-but-plausible cards are worse than vague ones, because a user acts on them.

## M7.2 — stashes, and a translator parser that had been quietly wrong

**Steps and results:**

1. `src/server/git/stash.ts` does save, list, apply, pop, and drop. `push` is used rather than bare `git stash` so a stash can carry a name — three unnamed stashes are anonymous by the second one. The stack is listed with `--format` so nothing has to be parsed out of a column layout.
2. **`git stash push` exits 0 on a clean tree.** It prints "No local changes to save" and returns success, so an exit-code check reports a stash that does not exist and tells the user their work is safe when it was already committed. The stack is counted before and after instead. This was found by a test, not by reading.
3. 12 unit tests and 5 e2e tests. `apply` and `pop` are two separate functions rather than one with a flag, and two separate buttons in the interface with the difference written out in words, because restoring is the one a user asks for more often than they think.
4. A translator rule was added for "No local changes to save" — with no fixes attached, since it is not a failure and there is nothing for a button to act on.

**A parser bug found while adding it.** `conflictFiles()` had one pattern for every CONFLICT line: "everything after the last ' in '". Real git prints two shapes, and the pattern read the second one as a whole sentence:

- `CONFLICT (content): Merge conflict in f.txt` — worked.
- `CONFLICT (modify/delete): f.txt deleted in del and modified in HEAD.  Version HEAD of f.txt left in tree.` — did not. It produced `del and modified in HEAD.  Version HEAD of f.txt left in tree.` as a filename.

The fix chooses the shape first and reads the name from the right end of it, which also had to strip a trailing period that belongs to git's sentence and not to the file. Both shapes are now tested against strings captured from real git, and a three-shapes-at-once case checks that names come out once each in order. A filename is the thing a user copies into a command, so a wrong one is worse than none.

## M7.3 — history, blame, and two things a parser had to be talked into

**Steps and results:**

1. `src/server/git/history.ts` reads the log, one file's history, one commit, and one file's blame. It uses `git log --format` with the ASCII unit separator as a delimiter instead of the default human layout, because a subject containing a colon, a quote, or a newline is enough to shift a column in the default and nothing else in this module rests on it.
2. `--all` is the default, not `HEAD`. A branch with no commits of its own is a fact worth showing; a log that omits a branch claims a commit doesn't exist, and the e2e fixture has two branches on purpose so that failure is visible.
3. Blame uses `--porcelain`, which has a stable grammar, rather than the default format whose wrapping and quoting change with terminal width.
4. 14 unit and 5 e2e tests.

**Two bugs the tests found, both in the reading rather than the doing.**

- The record parser looked for a line that was *exactly* the unit separator, which never happens: `--format` (not `--pretty`) prints one record per line *prefixed* by it. Every history read returned nothing, and the first test said `[]` rather than three commits.
- The two e2e tests that failed on `refs/stash`-style details were the test's fault (`git switch -c` on a branch that already exists fails silently, and `git rev-parse HEAD~2` past the root commits prints the literal argument). Both are the kind of thing that only shows up when the assertion is answered by git instead of by the code under test.

**A design decision worth recording.** `git blame` on a path git doesn't have exits 128 with `fatal: no such path 'x' in HEAD`, and the first version flattened that into an empty list — which tells the user "this file has no history". That is a different statement from "there is no such file", and the second is the true one. Blame now hands the failure through to the translator so the card says so, and there is a test in each layer asserting the two are not confused.

## M7.4 — the conflict resolver, and five bugs that only real git produced

**Steps and results:**

1. `src/server/git/conflicts.ts` reads the index, classifies each conflict from the *stages git recorded*, reads any side as text, resolves by taking a side, keeps both, and finishes or abandons the stopped operation.
2. The resolver opens on its own. A stopped merge is the one state in git that does not go away by itself, and leaving the user to notice it would be the most useless thing this feature could do.
3. Every action takes a working-tree snapshot first, because "take theirs" is exactly the choice a user regrets.
4. 11 unit and 6 e2e tests, all driving a real merge into a real conflict.

**Five bugs found, and the list is worth keeping because every one of them would have passed a fixture test.**

- **`ls-files -u` prints `<mode> <sha> <stage>\t<path>`, so the stage number is the third field.** The code looked for a line *starting* with "1 ", "2 ", or "3 ", which never matches. Every conflict read as "other" — wrong, and nothing crashed, which is why it survived until a test compared the kind.
- **The merge marker is `MERGE_HEAD`, not the word "merge".** `git rev-parse --verify merge` resolves a branch that usually doesn't exist, so every in-progress merge looked like nothing was happening — the resolver would never have opened.
- **`git show :0:<path>` has no stage 0 for a conflicted file**, so `hasMarkers` returned `false` on exactly the conflicted files. It now reads the working tree with `readFileSync`.
- **"Keep both" called `git add`**, which stages a conflicted path into stage 0 and makes git consider the conflict resolved. A button labelled "keep both" that then hid the conflict is the worst possible behaviour for this panel, so it now writes nothing and stages nothing, and an e2e test asserts the markers and the unmerged entry are both still there.
- **The path escape check passed for `../elsewhere/x`**, because the *joined string* still begins with the repository's name. `resolve()` is applied to both sides before comparing, and a test writes a file outside the repository and asserts it survived.

The one "bug" that was the test's fault is recorded too: taking "ours" leaves the file identical to what is already committed, so there is nothing to stage and no `M ` code in `git status --porcelain`. The assertion is now "no longer `UU`", which is the actual statement.

suite: 202 unit / 140 e2e, `npm run verify` green on Node v24.21.0 / git 2.47.3 / Linux.
