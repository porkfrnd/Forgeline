# AGENTS.md

Forgeline is a local-first visual git manager: an npm CLI starts a Hono server on 127.0.0.1 that serves a React + Vite interface for everyday git work.

Reading order: `AGENTS.md`, then `docs/status.md`, then `docs/decisions.md`, then `docs/spec.md`. Do not write code until all four are read.

Commands: `npm ci` (install from lockfile), `npm run dev:web` (frontend dev), `npm run verify` (typecheck + lint + lint:copy + test + test:e2e), `npm run test:e2e` (Playwright at 1440px and 800px).

Every session: wrap git via `spawn` arg arrays only; bind 127.0.0.1 only; never log tokens; run the build-and-verify loop per slice; update `docs/status.md` and `docs/progress.md` before stopping; commit to `main` only when `verify` is green, otherwise use `wip/<milestone>-<slice>`.

Do not remove or tidy playful or unusual text in strings and comments unless the user asks.
