# ADR-0009 — Hybrid state + event log (not full event sourcing); snapshots; replay & reproducibility limits

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

We need: full audit trail, tick-level replay, run comparison, crash recovery — and honest handling of LLM non-determinism. Full event sourcing (state = fold(events)) is the textbook answer; is it the right one here?

## Decision

**Hybrid:** authoritative relational state + append-only event log + periodic snapshots.

- State tables are the source of truth for *now*; the event log is the source of truth for *how we got here*. Both commit in the same transaction per tick (ADR-0003) so they cannot drift.
- **Snapshots:** SQLite backup/`VACUUM INTO` every N ticks + logical `stateHash` (canonical serialization) recorded as an event.
- **Replay = re-execution**, not event folding: start from manifest (or snapshot), re-run the engine with the same seeds, the journaled operator inputs, and the **LLM response cache**. Deterministic subsystems reproduce exactly; LLM calls replay from cache.
- **Reproducibility limits (documented honestly):**
  1. `llmMode=mock/off` runs are **bit-reproducible**, cross-OS (CI-enforced).
  2. Live runs are **replayable** exactly *from cache*; they are NOT re-generatable bit-for-bit against the live provider (models reject sampling pinning; providers retire/retune models). Cache completeness = replayability.
  3. Divergence is *detected*, never silent: replay compares periodic stateHashes; `strict` mode halts at first mismatch, `observe` mode records and continues.
  4. Run manifests pin seed, engine/ruleset/promptPack/schema versions, and model IDs — replay refuses to start on mismatched engine versions.

## Alternatives considered

- **Full event sourcing:** replay would *still* depend on the LLM cache (decisions aren't derivable from prior events), so ES buys no additional reproducibility — while costing projection machinery for every dashboard query. Rejected.
- **State-only + logs-as-logging:** loses auditability guarantees (INV/AC requirements) and replay entirely.
- **Record/replay at the LLM boundary only (no event log):** can't power the explorer UI, cause chains, or exports.

## Consequences

- Dashboards query relational state directly; explanations query the log — both first-class.
- The LLM cache is part of a run's artifact set (export/archive includes it).
- SQLite snapshots include the response cache and its append-only audit stream, but both are operational replay metadata excluded from the authoritative logical world hash and simulation event-ID sequence.
- LLM budget usage and kill-switch state are authoritative because they govern future execution. They are therefore included in the logical hash and main `evt_*` causality, unlike response-cache metadata. The current hash is v26 after Phase 8 persistence additions; each ticket records the version it introduced.
- Two sources must be kept honest: the `commitTick` choke point + drift-detecting stateHash events are load-bearing and tested (kill tests, golden replays).
