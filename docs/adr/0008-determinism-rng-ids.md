# ADR-0008 — Determinism policy: seeded RNG streams, monotonic IDs, banned APIs

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

Reproducibility (PRD NFR-5, AC-1) requires that the engine, given identical inputs, produces byte-identical outputs — across runs *and across OSes* (dev is Windows, CI adds Linux).

## Decision

- **RNG:** small portable PRNG (sfc32) seeded from the run seed; **named streams** forked by hashed string key (`fork("gen.personality")`, `fork("labor.tiebreak")`) so adding a consumer in one subsystem cannot shift another subsystem's draws. Stream states serialize into snapshots.
- **IDs:** per-run monotonic counters per entity type (`agt_0000002a` = base36 seq) — no UUIDs/ULIDs (wall-clock + entropy) inside the engine. Global uniqueness = runId + id.
- **Iteration order:** Maps (insertion-ordered) instead of plain objects for keyed state (objects reorder integer-like keys); every `sort` passes an explicit comparator; processing order is sorted-ID unless a seeded shuffle is explicit.
- **Banned in `packages/engine` and `packages/shared`:** ESLint directly rejects `Date.now`, argless `new Date()`, `Math.random`, and `String.prototype.localeCompare`. Review, deterministic tests, and the source scan keep `Intl.*` and transcendental float math (`Math.exp/pow/log/sin…`) out of state-affecting paths; those broader forms are policy, not currently separate ESLint selectors. Use integer/fixed-point forms or precomputed tables.
- **Serialization:** the canonical codec (sorted keys, bigint↔string, LF-normalized) is the only serializer for hashing/caching; `.gitattributes` forces LF so prompt/fixture hashes survive Windows checkouts; directory listings are sorted before use.
- **Concurrency:** LLM I/O is the only permitted concurrency. Prepared opportunities use a stable domain ordering and provider transport is currently sequential; any future batching must restore that exact order before the synchronous tick apply barrier (ADR-0007).
- **Enforcement:** the CI determinism gate runs the same seeded mock simulation twice (and cross-OS in the matrix) asserting identical state & event-log hashes; periodic `stateHash` events catch divergence early in long runs.

## Alternatives considered

- **UUIDv7/ULID for IDs:** convenient but time/entropy-laced; determinism would depend on mocking clocks everywhere.
- **Float math with tolerance-based comparisons:** hides drift until it compounds; integer/fixed-point is exact and testable with equality.
- **"Best-effort" determinism:** without a CI gate it decays immediately; the gate is the decision.

## Consequences

- Replay/debugging superpowers: any bug reproduces from (seed, manifest).
- Small ergonomic tax: no quick `Math.random()`, comparator discipline, fixed-point math utilities required (ADR-0013).
- V8 version pinning matters for long-term hash stability; engine version recorded in the manifest.
