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
