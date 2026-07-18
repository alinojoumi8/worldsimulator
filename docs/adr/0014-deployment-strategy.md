# ADR-0014 — Local-first single-node deployment; Docker later

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

MVP user = the owner, on Windows 11, running simulations locally. Production-style execution is one Node/Fastify process, per-run SQLite files, and a static-built React dashboard. Development uses a separate Vite process. Long runs should survive terminal sessions; nothing needs the cloud yet.

## Decision

- **Development:** `pnpm dev` runs the Fastify server in tsx watch mode at `127.0.0.1:4000` and Vite at `127.0.0.1:5173`; Vite proxies `/api` to Fastify.
- **Production-style local run:** `pnpm build && pnpm start` builds `apps/web/dist/`, then starts Fastify on port 4000. Fastify serves `/`, `/simulations/:simId`, and exact built assets when the directory exists; without a build, API-only startup still works.
- **Configuration:** SQLite files, snapshots, and exports live under `WORLDTANGLE_DATA_DIR` (default `./data`, gitignored). `.env.example` is the complete operator-facing catalog for network, auth, provider credentials/routes/prices, data, scheduler, snapshot, SSE, acceptance, and logging variables. The server `dev` and `start` scripts load an existing repository-root `.env` with Node's `--env-file-if-exists`; live acceptance scripts do the same but retain separate consent checks. Test and gate commands do not auto-load `.env`. Provider keys remain server-only and `.env` remains gitignored.
- **Exposure:** static dashboard files are public; the optional token guards `/api/v1/*` except health. A non-loopback bind is refused unless `WORLDTANGLE_API_TOKEN` is set (ADR-0011).
- **CI:** GitHub Actions, windows-latest + ubuntu-latest matrix (typecheck, tests incl. determinism gate). The matrix is itself a deployment test (path/CRLF/ICU drift).
- **Phase 11 / WS-1106:** single `Dockerfile` (node:24-slim, pnpm fetch, volume for data dir) + `docker compose` example — for anyone wanting a server deployment; still single-node. It is not implemented yet.
- **LATER (with multi-user):** Postgres profile (ADR-0004 seam), reverse proxy + TLS + real auth (ADR-0011), object storage for exports/snapshots. Explicitly **not** Kubernetes/serverless — a stateful single-writer simulator gains nothing from them at this scale.

## Alternatives considered

- **Cloud-first (Vercel/Fly/containers now):** long-lived stateful process with a local file DB and per-run costs — a poor fit for serverless, and premature ops for zero external users.
- **Electron/desktop packaging:** attractive later for distribution; unnecessary while the user is the developer.
- **Docker from day 0:** slows the inner loop on Windows (volume I/O) for no current benefit; comes at Phase 7 for parity instead.

## Consequences

- Onboarding = `pnpm install --frozen-lockfile && pnpm dev` — the repo must keep working from a clean checkout (CI-enforced).
- Data directory layout (`data/<simId>/<runId>/{world.db,snapshots/,exports/}`) is a documented contract from Phase 1 so backup/archive tooling stays trivial.
- The Windows dev machine is a first-class target: native-dep prebuilds verified in CI, LF forced via `.gitattributes`, optional Defender-exclusion note in README.
