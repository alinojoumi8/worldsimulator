# ADR-0004 — SQLite (better-sqlite3) for MVP; Postgres as scale-up seam

**Status:** accepted · **Date:** 2026-07-14

## Context

The simulation is a single-writer process committing one transaction per tick; the dashboard reads ad-hoc. Local-first on Windows, zero-ops. Later: multi-run servers, bigger worlds, maybe multi-user.

## Decision

**SQLite via better-sqlite3** behind repository interfaces defined in M20:

- Synchronous API is a determinism *feature* (no `await` interleaving mid-tick) and it is the fastest embedded option; win32-x64 prebuilds exist for Node 24.
- WAL mode; one write transaction per tick (`commitTick`); `defaultSafeIntegers` for bigint round-tripping.
- **Snapshots use the SQLite backup API or `VACUUM INTO`** — never file-copying a live WAL database (corruption risk, especially with Windows file locking). Snapshot writes are atomic: temp file → fsync → same-volume rename.
- No ORM in the write path (hand-written repositories with typed row mappers); a query builder may serve read-model/dashboard queries later.
- **Postgres is the documented scale-up path** behind the same repository interfaces (needed for: concurrent multi-run writes, multi-user, replicas). `node:sqlite` (built into Node) is the fallback if native-module pain appears — same SQL, thinner API.

## Alternatives considered

- **Postgres now:** operational burden (service, migrations tooling, Windows dev) with zero MVP benefit; single-writer workload doesn't use its strengths.
- **node:sqlite now:** zero native deps, but Stability-1 API and fewer features (backup API); kept as fallback.
- **LMDB/LevelDB/JSON files:** lose ad-hoc SQL for the dashboard and analytics.

## Consequences

- Zero-config dev and CI; a run's full state is one file → trivial archiving.
- Native module: pin versions, verify prebuilds in CI matrix (win+linux).
- Repository seam must stay SQL-portable (no SQLite-only SQL outside clearly-marked spots) to keep the Postgres path honest.
