# Architecture Decision Records

Format per ADR: **Status · Date · Context · Decision · Alternatives considered · Consequences**. Statuses: `proposed | accepted | superseded-by-XXXX | deprecated`. New decisions get the next number; changed decisions get a *new* ADR that supersedes the old one — ADRs are never edited into a different decision.

| # | Title | Status |
|---|---|---|
| [0001](0001-typescript-node-monorepo.md) | TypeScript on Node 24, pnpm-workspaces monorepo | accepted |
| [0002](0002-modular-monolith.md) | Modular monolith, not microservices | accepted |
| [0003](0003-event-driven-architecture.md) | Synchronous in-process event bus + append-only event log | accepted |
| [0004](0004-database-sqlite.md) | SQLite (better-sqlite3) for MVP; Postgres as scale-up seam | accepted |
| [0005](0005-simulation-time-model.md) | Discrete daily ticks, 360-day calendar, ordered phase pipeline | accepted |
| [0006](0006-deterministic-rules-vs-llm.md) | Deterministic engine; LLMs propose, never apply | accepted |
| [0007](0007-llm-provider-abstraction.md) | LLM gateway: provider abstraction, tier routing, budgets, mock | accepted |
| [0008](0008-determinism-rng-ids.md) | Determinism policy: seeded RNG streams, monotonic IDs, banned APIs | accepted |
| [0009](0009-event-log-snapshots-replay.md) | Hybrid state+log (not full event sourcing), snapshots, replay & reproducibility limits | accepted |
| [0010](0010-api-versioning.md) | URI-versioned API + schemaVersion on payloads | accepted |
| [0011](0011-authentication-authorization.md) | Local-first: no auth by default, optional bearer; in-engine capability model | accepted |
| [0012](0012-realtime-sse.md) | Server-Sent Events for real-time updates | accepted |
| [0013](0013-money-decimal-arithmetic.md) | Money as bigint minor units; fixed-point rates; no floats | accepted |
| [0014](0014-deployment-strategy.md) | Local-first single-node deployment; Docker later | accepted |
| [0015](0015-authoritative-ledger-posting-convention.md) | Authoritative ledger posting convention and supply channels | accepted |
