# WS-705 deterministic replay executor

WS-705 turns an immutable run manifest, the admin-command journal, and the
checksummed LLM cache into a fresh executable run. Replay never calls a live
provider. It either reproduces the source through cache-only evidence or
records a typed divergence.

## Replay boundary

`POST /api/v1/simulations/{simulationId}/runs/{sourceRunId}/replay` accepts:

```json
{
  "mode": "strict",
  "toTick": 200
}
```

`mode` defaults to `strict`; `toTick` defaults to the source run's terminal
tick. The source must be `completed`, `stopped`, or `failed`, and the target
tick cannot exceed the source checkpoint. The executor rejects a source whose
pinned engine, ruleset, prompt-pack, or event-schema version differs from the
current binary.

The 202 response contains the complete replay record. The existing status
endpoint exposes the same record under `replay`, including progress, the first
divergence, source/replay hashes, artifact digests, and terminal error fields.
The worker resumes a `running` replay after process restart.

## Deterministic execution

The target is initialized under the same simulation with a fresh globally
allocated run ID and the source manifest pins. Genesis events are compared
immediately. At each tick boundary the executor reapplies journaled lifecycle,
advance, world-event, and LLM-control commands in source sequence order, then
runs exactly one normal engine tick.

Event comparison hashes a canonical projection of every committed envelope.
Only operational identity fields (`simulationId`, `runId`, `createdWall`,
`wallTime`, and `correlationId`) are removed recursively. Event type, tick,
sequence, actor, causation, evidence, payload, and deterministic IDs remain in
the comparison. A causal or economic difference therefore fails at its first
event sequence instead of being hidden by a final aggregate.

The source cache artifact is checksum-validated and imported before execution.
`ReplayEvidenceLlmProvider` consumes immutable source-call expectations in
order, verifies the canonical request hash and provider/model route, and uses
the normal provider stack in hard `cache_only` mode. It restores source cache,
attempt, token, and fallback evidence so replay accounting is identical while
making zero upstream requests. Missing successful-call evidence is recorded as
`cache_incomplete` before the first tick.

## Divergence modes

- `strict` stops at the first known divergence and finishes `diverged` without
  applying later ticks.
- `observe` records divergences and continues. Cache misses flow through the
  engine's deterministic fallback, so later differences remain inspectable.

The persisted kinds are `cache_incomplete`, `event_mismatch`,
`state_hash_mismatch`, and `unsupported_journal_command`. Each record stores
its tick, expected/actual hashes when available, canonical details, and a
monotonic replay-local sequence. The replay summary always retains the first
record.

At the source terminal tick, the executor compares complete logical state
hashes. A partial replay also compares a source hash when an exact-tick snapshot
exists; otherwise the event-prefix comparison remains authoritative and the
source state hash is `null`.

## Persistence and recovery

Migration 29 adds immutable `replay_runs`, `replay_divergences`, and
`replay_llm_expectations` tables with guarded status transitions. These are
execution metadata rather than simulated-world state, so they are deliberately
excluded from logical state-hash v22. SQLite backup snapshots still preserve
them. Tests cover outer-transaction rollback, reopen, snapshot restore, and
hash neutrality.

## Acceptance evidence

Focused coverage proves:

- a stopped manifest/journal/cache fixture replays to the identical final hash;
- an injected fuel-price shock is reapplied at its original tick boundary;
- a live-shaped cached call reproduces its source state without invoking the
  provider;
- strict mode halts before tick mutation when cache evidence is missing;
- observe mode records the miss and continues through bounded fallback;
- a changed causal payload is reported at the first mismatching sequence; and
- API request, response, status, migration, reopen, and snapshot contracts are
  strict.

The completion gate passed `pnpm typecheck`, `pnpm lint`, all 118 test files
(641 tests), and `pnpm build` on 2026-07-16.
