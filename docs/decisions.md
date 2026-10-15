# Decisions

> Last updated: 2026-10-14
> Describes commit: 8d96914ded9e91bb1c5da09438a2fb7ff50fb260 (Milestone 1 Skeleton, first commit)

Each decision lists its date, the choice, the alternatives rejected, and the reason. Changes to the spec are recorded here, never by editing `docs/spec.md`.

## Stack (2026-10-14)

- **Choice:** TypeScript everywhere; Hono + `@hono/node-server` backend; React + Vite + TypeScript frontend built to static files and served by the backend; `commander` for the CLI; `open` for browser launch; plain CSS with design tokens; vitest + Playwright for tests.
- **Alternatives rejected:** Express (heavier, less typed), a git library such as `isomorphic-git` or `nodegit` (the spec forbids reimplementing git; native `nodegit` needs a toolchain), a CSS-in-JS or UI kit (the spec wants hand-designed tokens, not a heavy kit).
- **Reason:** matches the spec's stack table; keeps dependencies lean; the backend stays a thin, typed wrapper over the real git CLI.

## Node version (2026-10-14)

- **Choice:** `engines: ">=22"`; developed and verified on Node v24.21.0.
- **Reason:** Node 24 is the current Active LTS; Node 20 is end of life. The spec sets the floor at 22.

## Font roles (2026-10-14)

- **Choice:** three tokens — `--font-ui` (IBM Plex Sans), `--font-code` (JetBrains Mono), `--font-message` (Source Serif 4), each ending in a system fallback stack.
- **Alternatives rejected:** a single font for everything (the spec wants the message voice to stand apart); system fonts only (the spec requires bundling for offline use).
- **Reason:** follows the spec's three-role model. Bundling is deferred to Milestone 9, so the tokens currently render through fallbacks; this is recorded as a known limitation in `docs/status.md`.

## Port rules (2026-10-14)

- **Choice:** no port -> bind port `0`, read the assigned port from the server; valid free port -> use it; taken port -> print `Port <n> is in use. Try <n+1>, or run forgeline with no port.` and exit non-zero; invalid port (non-integer or outside 1024-65535) -> print the error and the usage line and exit non-zero. Bind `127.0.0.1` only.
- **Reason:** matches the spec exactly. A taken port never silently switches, so the user is never surprised about where the app is listening.

## Session auth (2026-10-14)

- **Choice:** a random 32-byte token per run, printed in the URL and opened in the browser; the page exchanges it for an `HttpOnly; SameSite=Strict` cookie via a 303 that also strips `?t=` from the address bar; every `/api/*` route requires the cookie; every request is checked for an allowed `Host`; writes also require an allowed `Origin` and `Content-Type: application/json`.
- **Reason:** matches the spec's security section and blocks other websites and DNS rebinding from reaching the local API.

## Sign-in method (2026-10-14)

- **Choice:** GitHub OAuth Device Flow (no callback server, no client secret), token stored in the OS keychain, passed to git only through a shipped `GIT_ASKPASS` helper. Not implemented yet (Milestone 6).
- **Reason:** matches the spec. Device flow avoids exposing a secret in a local app.

## Web build output location (2026-10-14)

- **Choice:** Vite emits the SPA to `<pkg>/dist/web`; the compiled server lives in `<pkg>/dist/server`; the server resolves its web root as `join(dirname(index.js), "..", "web")`.
- **Reason:** keeps the whole `dist/` tree inside the package so the shipped tarball is self-contained. An earlier `outDir` of `../../dist/web` resolved outside the project and broke static serving; fixed and recorded in `docs/progress.md`.

## Spec fidelity for `docs/spec.md` (2026-10-14)

- **Choice:** `docs/spec.md` is a verbatim copy of the build prompt (with a small metadata header noting the date and commit).
- **Alternatives rejected:** a condensed summary (rejected — the spec requires an unchanged copy as the source of truth).
- **Reason:** the spec says `docs/spec.md` is "a copy of this build prompt, unchanged".

## Update 1 (2026-10-14)

- **Source:** a mid-build amendment delivered in-chat. Where it disagrees with `docs/spec.md`, the amendment wins. `docs/spec.md` is untouched.
- **Scope kept:** only the security hardening (§5) and the GitHub remote setup (§2) were applied to the existing Milestone 1 code. Milestones are otherwise unchanged; the plan is still core (1-6) before extras (7-9).
- **Feasibility verdicts (Update 1, sections 1-10):**
  - §1 Orient: feasible as written. Done: `git status`/`log`/`branch` read, handoff files re-read, `npm ci` clean, `verify` green, status corrected where the run disagreed.
  - §2 GitHub remote (`https://github.com/porkfrnd/Forgeline`): feasible with limits. `gh` is authenticated on this machine, so the first push can proceed. Never force-push; tokens never touch URLs, config, docs, or logs.
  - §3 Scope control: feasible as written. Core exit criteria recorded in `docs/status.md`; nothing from 7-9 starts until the core gates pass.
  - §4 Recovery contract: feasible as written, but not yet implemented (it belongs to Milestone 4). Write-ahead journal, state tokens, pending-entry recovery cards, and SIGKILL failure-injection tests are all scheduled there. No Undo label is offered anywhere until its recovery test passes.
  - §5 Security tightening: feasible as written, applied to Milestone 1 now. Gaps found and closed: the Origin check previously trusted the absence of `sec-fetch-site` (plain clients send none), Content-Type matching was case-sensitive, and `RepoRegistry.setRoots` stored raw strings so a symlinked root compared wrong. Fixes: explicit Origin allow-list for same-host+port, case-insensitive `application/json` requirement on writes, roots resolved per `register()` call. Proven by 26 unit tests and 22 e2e tests (replay/expired token, bad Host, cross-origin POST, non-JSON write, no-CORS, traversal body check, forged repo ID, symlinked root).
  - §6 Git operation contracts: feasible as written, scheduled for Milestone 3. CRLF, no-trailing-newline, rename, binary, mode-change, symlink, and non-Latin filename fixtures are required before hunk staging ships.
  - §7 Proportionate verification: feasible as written. Logic slices skip browser runs; interface slices add Playwright + Paper/Midnight screenshots; write paths, journal, snapshots, auth, and the HTTP layer always run their full suites; milestone gates run everything plus `npm audit`, the packed-tarball smoke test, and the three-OS CI results.
  - §8 Dependencies/npm name: feasible as written. Every new dependency gets a license/maintenance/platform/install check recorded here. `npm view forgeline` runs immediately before the user publishes; never `npm publish` from a session.
  - §9 Spec corrections: feasible as written; all already match the code (Node >= 22, `prepack`, git 2.31+, fixed git env, askpass-only tokens, `Accept: application/json`, GitLab device grant >= 17.9 with PAT fallback, in-memory tokens without a keychain, tokenized banner, folder-picker first run, corrected fix-button wording, real conflict/SSH features, 30-day/50-snapshot retention, chokidar + 3s polling fallback, static skeletons, `lint:copy` skipping `docs/`, remote actions marked non-undoable).
  - §10 Milestone reports: feasible as written. Each gate writes verification output, working flows, limitations/Deferred/unconfirmed items, tag + pushed hash + `ls-remote` confirmation, and the next concrete step into `docs/status.md`.
- **Alternatives rejected:** deferring the §5 fixes to Milestone 4 (rejected — M1's exit criteria demand the security tests pass now); weakening the Origin check to `sec-fetch-site`-only (rejected — curl sends no such header); resolving roots once at `setRoots` (rejected — a root symlink would then compare unresolved against resolved repo paths).

## Live updates: watching strategy (2026-10-15)

- **Choice:** one chokidar watcher per repository over `.git` alone, with `depth: 3` and an `ignored` predicate that admits only `HEAD`, `index`, `packed-refs`, and the `refs` subtree. Debounced at 200ms. If a watcher errors, every watcher is rebuilt with `usePolling: true, interval: 3000` and the interface shows "Live updates are polling."
- **Alternatives rejected:** watching `[.git/HEAD, .git/index, .git/refs]` as three separate targets — chokidar applies `depth` from the common base of the path set, so the budget is spent walking back into `.git` and changes inside `refs/` are never reported. Reproduced during this slice and recorded in `docs/progress.md`. Also rejected: watching the whole working tree (far too many events, and it misses nothing we need), and polling unconditionally (the spec asks for the fallback only when native watching fails).
- **Reason:** those three paths are exactly what changes when a repository's state changes, so the watcher is both cheap and complete for the dashboard. It cannot report its own reads, because status calls set `GIT_OPTIONAL_LOCKS=0`.

## Per-repo single-writer queue (2026-10-15)

- **Choice:** `RepoQueue` keyed by repository path, wrapping every status read. Independent keys run concurrently; a rejected task does not reject the tail later tasks wait on, and each caller receives its own result.
- **Alternatives rejected:** one global queue (would serialize unrelated repositories and make scanning twenty folders slow); no queue at all (a `status` reading the index while a future `add` or `commit` rewrites it is exactly the class of bug that corrupts work).
- **Reason:** git expects one writer per repository. Queueing per repository matches that contract without giving up parallelism across repositories.

## Branch read without a second git process (2026-10-15)

- **Choice:** parse the branch from the `status --porcelain=v2 --branch` header via `parseStatusBranch`. Only a detached HEAD pays for `rev-parse --short`, to name the commit.
- **Alternatives rejected:** keeping `currentBranch` in the status path — three git processes per repository per refresh where two suffice.
- **Reason:** `--branch` already returns the branch name. `currentBranch` stays exported for callers that want the branch without a status read.

## LICENSE (open)

- **Status:** unresolved. `package.json` currently declares `MIT` as a placeholder. The spec says to ask the user which license to use and not to choose silently. **Action needed from the user** before Milestone 9 / any publish.
