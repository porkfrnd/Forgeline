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

- **Choice:** a random 32-byte token per run, printed in the URL and opened in the browser; the page exchanges it for an `HttpOnly; SameSite=Strict` cookie via a 302 that also strips `?t=` from the address bar; every `/api/*` route requires the cookie; every request is checked for an allowed `Host`; writes also require an allowed `Origin` and `Content-Type: application/json`.
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

## LICENSE (open)

- **Status:** unresolved. `package.json` currently declares `MIT` as a placeholder. The spec says to ask the user which license to use and not to choose silently. **Action needed from the user** before Milestone 9 / any publish.
