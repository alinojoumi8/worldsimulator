# ADR-0003 — Synchronous in-process event bus + append-only event log

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

Modules must react to each other (a company failure triggers terminations, news, sentiment) without tight coupling; every state change must be auditable and replayable; the tick pipeline must stay deterministic.

## Decision

1. **Synchronous, deterministic event bus:** handlers register in explicit order at startup; events dispatch from a FIFO queue drained to completion within the publishing phase. No async handlers in the tick path (microtask interleaving would break determinism). Handlers never mutate state directly — they enqueue intents/tasks for defined phases.
2. **Append-only event log:** every published event is persisted in the versioned envelope (API_CONTRACTS §4) with `seq` (per-run, gapless), `actor`, `correlationId`, `causationId`. No UPDATE/DELETE on the log, enforced at the store layer.
3. **One tick unit of work:** module-owned persistence adapters stage state changes and events inside the same `TickUnitOfWork`/SQLite transaction, so state, events, checkpoint, scheduler claims, and IDs cannot drift. The logical “apply” boundary is distributed across typed module stores rather than one physical global function.
4. **Operator input is events too:** every implemented API mutation (create, lifecycle control, advance, bounded LLM control, world-event injection, replay, and export) journals its command/effect evidence according to its contract, so replay and audit can reproduce operator behavior. The planned free-form scenario PATCH route is not part of the current server.

## Alternatives considered

- **Async message broker (Kafka/NATS):** capability we don't need at 10³ events/tick; adds ordering nondeterminism and ops burden.
- **Direct module-to-module calls only:** couples modules and loses the audit stream; calls remain for queries/commands, events for facts.
- **Full event sourcing:** rejected — see ADR-0009.

## Consequences

- Auditability and the "why" chain come for free (causationId).
- Bus discipline (no async, no direct mutation in handlers) is enforced by interfaces, tests, and review; it is not a dedicated ESLint rule today.
- The log grows large (millions of rows at scale): per-tick batched writes, `(runId,seq)` and `(runId,tick)` indexes, export/archive path (Phase 11).
