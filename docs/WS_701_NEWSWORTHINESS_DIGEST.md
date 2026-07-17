# WS-701 — Newsworthiness digest

Status: implemented on 2026-07-16.

WS-701 adds the deterministic `buildNewsworthinessDigest` engine boundary that
WS-702 will use to select real journal events for stories. It is a derived
projection, not authoritative state, so this ticket adds no table, migration,
event type, snapshot row, or logical-state-hash version.

## Input and eligibility

The caller supplies one simulation/run identity, a target tick, and immutable
events containing enough history for the requested lookback. The default
lookback is 30 ticks and the default returned-candidate limit is 25.

The inclusive rarity window is:

`max(0, targetTick - lookbackTicks + 1) ... targetTick`

Only events on the target tick can become candidates. Administrative, agent
decision, API, conversation, goal, LLM, memory, news, scheduler, simulation,
snapshot, ledger-posting, and trigger event families are operational evidence
and are excluded. Economic, company, employment, market, energy, credit,
legal, policy, and world-event facts remain eligible. History and future events
cannot become target-tick candidates. Inputs with an empty identity, invalid
integer bounds, duplicate event IDs, or mixed simulation/run identities fail
closed.

Callers may supply validated event-type occurrence counts for the inclusive
lookback while passing only target-tick envelopes. Counts must be positive,
unique by type, and cannot undercount the supplied events. WS-702 uses an
indexed SQLite aggregation for this path, avoiding repeated deserialization of
the complete 30-tick window without changing the digest result.

## Scoring version 1

All arithmetic is integer-only. The total is bounded to 10,000 points.

| Component | Rule | Maximum |
|---|---|---:|
| Money size | Find the largest absolute payload value whose field ends in `Cents` (excluding `Microcents`), then award `500 × (decimal digits - 1)` | 4,000 |
| Rarity | `floor(3,500 / occurrences of the event type in the lookback)` | 3,500 |
| Affected entities | Deduplicate recognized entity-ID fields plus a non-system actor; take the greater of that set size and an explicit affected/impacted count; award 250 per entity | 2,500 |

The money component uses the largest fact rather than a sum. That avoids
double-counting debit/credit transaction legs and gross/net breakdowns.
Affected counts are capped at 10,000 before scoring, while points saturate at
10 entities.

## Stable ranking and hashes

Candidates sort by total score descending, then target tick, event type, and
event ID using direct code-unit comparison. Input order and locale never affect
the result. Each candidate includes `eventFactHash`, computed from immutable
event facts while excluding informational wall time, simulation/run identity,
and operational request correlation. Persisted source facts still retain that
metadata and are compared exactly at the citation boundary. Same-score payload
changes remain visible without allowing host/request identity to change replay
identity.

The digest hash covers scoring version, target/window settings, the total
eligible count, ranks, score components, logical causal metadata, and every
candidate fact hash. The returned digest still carries simulation/run identity,
but those operational identities are excluded from the logical hash. The seed
fixture golden is:

`0f641c2d3c289f6313460cf7d4c5d7aa9f059378c88a6e7180d2066ea09c3350`

## Verification

The focused suite covers:

- exact money, rarity, affected-count, and total score goldens;
- maximum-money selection, negative amounts, entity deduplication, explicit
  counts, and `Microcents` exclusion;
- identical ranking and hash under reversed input order;
- inclusive lookback, future-event isolation, and operational filtering;
- deterministic type/event-ID tie-breaks;
- wall-time, run-identity, and request-correlation neutrality;
- pre-aggregated lookback equivalence and count validation;
- same-bucket source-fact sensitivity;
- invalid policy, duplicate-event, and mixed-run rejection.

Run it with:

```text
pnpm exec vitest run packages/engine/src/newsworthiness.test.ts
```

The combined WS-701/702 repository gate passes: strict typecheck, lint, 112
test files / 615 tests, and the production web build. Vite reports only the
existing 538.50 kB chunk-size advisory.
