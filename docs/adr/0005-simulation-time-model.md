# ADR-0005 — Discrete daily ticks, 360-day calendar, ordered phase pipeline

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

The simulation needs a time model that is deterministic, replayable, cheap enough for LLM-in-the-loop decisions, and friendly to financial math (amortization, payroll, taxes).

## Decision

- **1 tick = 1 simulated day.** Banking convention calendar: **360-day year, 12 months × 30 days** (`Y####-M##-D##`), no weekends (documented simplification — leisure is modeled through consumption, not days off).
- Financial cadences: **semi-monthly payroll** (D15/D30 — no drift against 30-day months), monthly loan installments, quarterly taxes (M3/M6/M9/M12 D30), annual closes.
- Each tick runs a **fixed, ordered phase pipeline** (PRD §6): obligations → perception/triggers → decisions → collect/order → validate/execute → market clearing → settlement → news/sentiment → metrics → atomic commit. Within every phase, agents/entities process in **sorted-ID order**; any required shuffling draws from a named RNG stream.
- Conversations advance across ticks through persistent next-tick inbox delivery. They remain bounded to six turns and an aggregate output-token budget, with deterministic no-progress/failure closure.
- Scheduler: priority queue of `(tick, order, taskRef)` firing in the obligations phase.

## Alternatives considered

- **Hourly ticks:** ~24× LLM cost and event volume for marginal realism; conversations don't need wall-clock granularity.
- **Continuous/event-driven time (DES):** elegant for queues, but interleaves LLM latency with sim causality and makes replay and "what happened today" UX much harder.
- **Real 365-day calendar:** leap years and uneven months pollute amortization and payroll math with no simulation benefit.

## Consequences

- Amortization and payroll are exact by construction; date math is trivial and deterministic.
- A "day" is the smallest causal unit: intra-day ordering is phase order, not timestamps — documented so users don't over-read within-tick sequence.
- If sub-day dynamics are ever needed (market microstructure), they nest *inside* a tick as ordered rounds rather than changing the clock.
