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

## Update 2 (2026-10-15)

Recorded as instructed, summarizing sections 1, 2, 3, and 5 only. Section 4 of that update is not copied here or into any other file, and nothing in this repository states what it asks for.

### Run plan (section 1)

- **Choice:** finish two milestones completely, back to back, without waiting for the user between them. A milestone counts as finished only when every Update 1 section 3 exit criterion is met with evidence. The two milestones are the first two unfinished ones in the table, in order. The design foundation pass runs first, then milestone one slice by slice, then its gate, then milestone two slice by slice, then its gate.
- **Alternatives rejected:** stopping after the first milestone to check in (rejected — the point of the run is two finished milestones); building new interface before the design pass (rejected — every later screen depends on the tokens and components).
- **Reason:** the user asked for two complete milestones in one run. Design work never pushes a safety, security, or recovery criterion out of the run: if time runs short, visual polish is deferred and recorded, and the criterion is never deferred. A third milestone is not started even if budget remains; leftover budget goes to hardening.

### Working method (section 2)

- **Choice:** parallelize independent reads, commands, and test files; build fixture repositories once per run and reuse them; never re-read a file already in context; never rerun a passing check whose code has not changed; estimate each slice and split it if it runs past twice the estimate; keep documentation entries short and factual; read `git diff --staged` before every commit; spend a focused stranger's-read pass on each milestone's code after its gate and test the three riskiest places; treat `verify` taking over five minutes as a bug.
- **Reason:** the run has a fixed budget and two gates to clear, so waste is the main risk. The commit and push cadence from Update 1 section 2 is unchanged.

### Design direction (section 3)

- **Choice:** an "instrument panel for a forge". The restrained, consistent, calm look from the spec is replaced by a bolder, technical, unmistakably designed one. Heat is the organising idea: recent or active runs hot, old or idle runs cold, and the commit graph is the centrepiece — white-hot at HEAD, cooling along the history behind it. Heat is always paired with a number, an icon, or text, so colour never carries meaning alone.
- **Rules lifted:** the bans on gradients, glass, glow, neon, and purple-and-cyan palettes; the single-accent-colour rule; the calm dark grey Midnight theme; borders over shadows; the bans on entrance animation and looping decoration.
- **Rules kept:** no stock art, no generated imagery, no floating mockups, no invented data, no banned phrases, no popups on launch, no telemetry, and all accessibility rules.
- **The new test for every visual effect:** it must encode information or help orientation. A glow marks something active or focused; a gradient follows a real ramp such as age or activity; a texture gives structure. An effect that does nothing is deleted.
- **Alternatives rejected:** the spec's restrained look (rejected — the user asked for something bolder, more technical, and more creative); a generic dashboard template (rejected explicitly).
- **Reason:** the user asked for a bolder, more technical, more creative look. Surfaces become three layered levels with 1 px hairlines; panel corners carry registration ticks; a static grain and dot grid add structure at low opacity; typography keeps the three font roles with monospace for everything technical.

### Documentation (section 5)

- **Choice:** `docs/design.md` holds the tokens, components, effects levels, and the design review checklist, kept current. The design foundation pass order is fixed: tokens and themes, then the app shell, then the core components, then restyling the screens that already exist, committing and pushing after each step.
- **Reason:** the design has to be written down before it is built, or six theme families drift apart within a slice.

## Update 3 (2026-10-15)

Supersedes the parts of Update 2 it names. Updates 1 and 2 stay in force otherwise.

### What it replaces from Update 2

- **The three-pane layout** (repo rail, worktable, inspector, command bar) is replaced by the **Workbench layout**: a resizable collapsible sidebar with sections, a toolbar, a horizontal Timeline strip, a worktable with file lists and a diff viewer, a pinned commit panel, and the status bar. See `docs/design.md`.
- **The theme list** is replaced by families with modes. Update 2's Forge and Blueprint are gone: Forge is merged into Cathode, and Blueprint is no longer required. The families are Lagoon (the default), Cathode, Paper, Mono, Dracula, Nord, and the hidden Phosphor. Each has Dark and/or Light mode.
- **Glass scope** is widened: Update 2 allowed blur only on overlays; glass is now permitted on every primary panel, subject to the performance budgets. Update 2's rule that every effect must encode information still applies.
- **The commit graph** becomes the horizontal Timeline strip, with lane hue identifying the branch and brightness and glow showing recency, HEAD brightest.
- **The heat idea survives** but becomes relative to the theme: the hot end of the ramp is the theme's accent, the cold end its muted tone.

### What stays from Update 2

The three font roles, the motion rules, the Effects setting (Full, Reduced, Off), the performance and accessibility rules, and the design review checklist all stand unchanged.

### The slot rule

- **Choice:** never show a control or region with no working feature behind it. A region appears when its feature meets its exit criteria, and until then the layout closes up around it. The toolbar shows only the buttons whose features exist.
- **Reason:** this is how the integrity contract applies to the layout. A disabled stub button is a promise the app is not keeping, and the spec's "never lose the user's work" principle extends to not pretending.

### Themes and modes (section 4)

- **Choice:** two separate controls — family (palette and style) and mode (Dark, Light, Auto). A family that does not support a mode disables it in the control and says why. Each theme defines two accent tokens, one for fills and graphics and a darker one for text on light surfaces, so text always meets 4.5:1. Each theme defines eight lane colours that are easy to tell apart, each at 3:1 against its panel. The starting values in the update are suggestions; every pair is verified with a script and adjusted.
- **Surfaces:** Glass (blur, translucent panels, ambient gradient) or Solid (opaque, flat). Effects Off forces Solid. Text contrast is measured against the worst case behind the panel — the lightest and darkest points of the ambient gradient — so a text surface needs 90% opaque fill or must pass at both extremes.
- **Reason:** the reference the user supplied is a dark glassy client, and the update asks for that look without copying its branding. Separating family from mode keeps one layout with only tokens differing.

### UI options (section 5)

- **Choice:** family, mode, surface, effects, density, layout (sidebar or top tabs), toolbar (icons with labels or icons only), timeline visibility and height, repo list (cards or rows), panel options, text size, reduced motion, simple mode, and accent colour — all through tokens. The accent picker works with every family and adjusts the chosen colour's lightness so text meets 4.5:1 and graphics 3:1, telling the user when it adjusted something.
- **Reason:** these are the spec's display options mapped onto the new layout, plus the new surface, toolbar, and timeline controls.

## Update 4 (2026-10-16)

**Source:** a mid-build amendment, delivered out of band, that replaces the earlier version of Update 4. It is a design repair and visual language, not a milestone. Where it disagrees with Update 3 on visuals, Update 4 wins; Updates 1 to 3 still rule on safety, recovery, secrecy of surprises, commit cadence, the slot rule, and real data only.

### What it replaces from Updates 2 and 3

- **The three font roles become four.** A new `--font-display` role carries repo names, card titles, and hero numbers. The three roles from the spec stand: `--font-ui`, `--font-code`, `--font-message`.
- **Corner registration marks are deleted**, along with whatever draws them. Update 2's "registration ticks" are gone.
- **The heat ramp is no longer the organising idea.** Colour now means something specific per theme, from a fixed map that is the same in every family: the hero accent is uncommitted work and anything needing attention, green is clean or synced, cool steel is the remote or other people's work, red is deleted lines and destructive actions only, and diffs use their own green and red tints. `--cold`, `--heat-1`…`--heat-5`, `--hot`, and `--white-hot` survive only where the graph needs a ramp; a status never borrows from it.
- **Two accent tokens become three.** `--accent` for graphics, focus ring, and the selection bar; `--accent-text` for text on the panel; `--accent-strong` for the fill behind button text. This corrects Update 3: white on `#D45A00` and white on `#0B8F83` are both about 4.0:1, which fails button text.
- **"Cozy" leaves the toolbar** and the density choice moves into the View menu. "History" reads "Undo history".
- **The undo drawer moves** to a proper overlay — 420px, between toolbar and status bar, 40% scrim, shadow, focus trap, Esc to close — and never covers the status bar. Raw snapshot ids and "no ref change" are behind a collapsed Technical details disclosure.

### What stays

The slot rule, real data only, the wrap-the-git-CLI contract, everything about safety and recovery, the effects levels, the motion rules, the accessibility floor, and the bounded performance budgets.

### Decisions made while applying it

- **Display face: Barlow Condensed**, OFL-1.1, weights 400 and 600 only, Latin subset only. Its Latin 600 woff2 is 22,308 bytes, inside the 40 KB budget. No network font loading; the files are bundled by Vite from `@fontsource/barlow-condensed` into the built package, and the OFL licence text ships with it.
- **The spec's three fonts are bundled now**, rather than deferred as Update 2 did: IBM Plex Sans (`--font-ui`), JetBrains Mono (`--font-code`), Source Serif 4 (`--font-message`), each weights 400/500/600 as Latin subsets with its licence file. They were rendering through fallbacks until now, which is recorded here as a gap that Update 4 closes rather than leaves open.
- **Barlow Condensed has no tabular figures.** Hero numbers stay in it, because they are one number at a time; any table of numbers uses `--font-ui` with tabular figures, exactly as the update allows.
- **`@axe-core/playwright` is added as a dev dependency.** It is not already present, and section 6 asks for it only with a justification: the six design checks include keyboard access and hit targets, and a font-size/contrast script cannot see a control that is only reachable by pointer, or a focus ring that never appears. This is the one-line justification. It is a dev dependency and never ships.
- **Font packages are dev dependencies, not dependencies.** They are consumed at build time by Vite; the running app imports nothing from `node_modules`. A runtime dependency would mean the package could not start from a plain `npm ci --omit=dev` install.
- **Branch and gate.** Three sub-slices, `wip/design-foundations`, `wip/design-desktop`, `wip/design-charts`, each merged to `main` only when `npm run verify` and `npm run verify:design` both pass. Sections 6.1 to 6.7 become `npm run verify:design`.

### Places where the update contradicts itself

The update is a design document, not a spec, and three of its own rules cannot
all be true at once. Each is resolved below with the reason, so the next person
can disagree with a specific decision instead of a vague feeling.

**0. Lagoon Dark's panel cannot clear its own surface step either.** Section 5
gives `rgba(16,28,40,.72)` as Lagoon Dark's glass panel over a `#0A141C` base.
Composited, that panel is 0.026 in OKLCH lightness above the base, and the same
document requires at least 0.04. No alpha can close the gap: at the paint's own
lightness the alpha would have to exceed 1, so the paint itself has to be lighter.

*Decision:* the panel paint is `rgb(28,38,45)` at the update's own 0.72 alpha,
which composites 0.056 above the base. The hue is unchanged — this is the same
teal-black, lightened by as much as the rule requires and no more.

**1. Its light bases cannot clear its own surface step.** Section 5 specifies
`#F6F8FA` for Paper and `#EAF4F6` for Lagoon Light, and says panels are white.
A white card over `#F6F8FA` is 0.032 in OKLCH lightness, and the same document
requires at least 0.04 between the base and a card. Nothing a white paint can do
closes that gap, because white is the ceiling.

*Decision:* each light base is darkened by about two percent of lightness and
nothing else — the hue is kept, and `#EAF4F6` becomes `#E6F0F2`, `#FFF4E8`
becomes `#F7ECE1`, `#F6F8FA` becomes `#ECEEF0`, and Mono's white becomes
`#EEEEEE`. A white card then steps 0.05, which is above the floor rather than
just under it. The panels stay white and translucent enough that Glass still
reads as glass, at alpha 0.97.

**2. The third surface level has a direction that only works on one side.** The
update says a menu or drawer is "at least 0.04 lighter again", which a light
theme cannot do past a white card. In a light theme the third level is the row
hover, which is *darker* than the card, and that is correct there.

*Decision:* the check measures the **size** of each step, not its direction, and
reports it as `above` for want of a better word that covers both. The alternative
was either an unmeasurable rule or a light theme with two levels pretending to
have three.

**3. It specifies 12px text twice while flooring body text at 13px.** Section 4
sketches a 28px status bar with 12px text; the same section's sidebar sketch puts
branches at 12px; section 3's type table floors body and control text at 13px.

*Decision:* the floor wins, and the bar stays 28px. This is not a weakening of
the floor — it is the floor winning against a size suggestion in the same
document. `docs/design.md` records it where it can be seen.

### Update 4 vs Update 3

Where the two disagree on visuals, Update 4 wins, and the Update 3 rules still
govern safety, recovery, secrecy, commit cadence, the slot rule, and real data
only. What Update 4 replaced from the earlier updates: the four font roles, the
deletion of corner marks, the demotion of the heat ramp, the three accent tokens,
the removal of "Coasy", and the rework of the undo drawer.

### Anti-slop note

The update names banned copy in the spec; `npm run lint:copy` already enforces the phrase list and already skips `docs/`. The new screenshots are real captures of the real app, not mockups, and no invented data is drawn anywhere — every chart and hero number reads git.

## LICENSE (open) — closed

- **Choice:** MIT, Copyright (c) 2026 porkfrnd. The user picked it from three offered options rather than us choosing silently.
- **Status:** `LICENSE` written, `package.json` declares `MIT`. Nothing is published, so this is settled for the repository and re-checked at publish time against the current `npm view forgeline`.
