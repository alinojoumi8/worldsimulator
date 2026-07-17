# ADR-0003 — Synchronous in-process event bus + append-only event log

**Status:** accepted · **Date:** 2026-07-14

## Context

Modules must react to each other (a company failure triggers terminations, news, sentiment) without tight coupling; every state change must be auditable and replayable; the tick pipeline must stay deterministic.

## Decision

1. **Synchronous, deterministic event bus:** handlers register in explicit order at startup; events dispatch from a FIFO queue drained to completion within the publishing phase. No async handlers in the tick path (microtask interleaving would break determinism). Handlers never mutate state directly — they enqueue intents/tasks for defined phases.
2. **Append-only event log:** every published event is persisted in the versioned envelope (API_CONTRACTS §4) with `seq` (per-run, gapless), `actor`, `correlationId`, `causationId`. No UPDATE/DELETE on the log, enforced at the store layer.
3. **Single `apply()` choke point per module:** state changes + their events commit in the *same* database transaction (`commitTick`), so state and log can never drift.
4. **Operator input is events too:** every API command (pause, inject, scenario patch) is journaled as `admin.command.received` *before* taking effect, so replay reproduces operator behavior.

## Alternatives considered

- **Async message broker (Kafka/NATS):** capability we don't need at 10³ events/tick; adds ordering nondeterminism and ops burden.
- **Direct module-to-module calls only:** couples modules and loses the audit stream; calls remain for queries/commands, events for facts.
- **Full event sourcing:** rejected — see ADR-0009.

## Consequences

- Auditability and the "why" chain come for free (causationId).
- Bus discipline (no async, no direct mutation in handlers) must be lint/review-enforced.
- The log grows large (millions of rows at scale): per-tick batched writes, `(runId,seq)` and `(runId,tick)` indexes, export/archive path (Phase 11).
