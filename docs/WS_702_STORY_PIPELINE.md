# WS-702 - Story pipeline

Status: implemented on 2026-07-16.

WS-702 turns the deterministic WS-701 digest into immutable, cited news
stories. The LLM is a bounded selector over engine-authored drafts. It never
authors facts, chooses arbitrary event IDs, or mutates simulation state.

## Newsroom and editorial rules

Riverbend starts with one news organization, The Riverbend Ledger. Persistence
checks that it has exactly one `news.editor` and one to three employed
`news.journalist` agents attached to the news institution. Only assigned staff
journalists can apply `news.story.publish` actions.

Every tick receives a curated digest for the preceding committed tick. The
editor opens an issue every 30 source ticks, beginning at tick 0, selects at
most one candidate per topic, and enforces the organization's maximum of three
published stories on that publication tick. Authors rotate deterministically
by source tick and candidate order. This bounded cadence satisfies AC-7's
minimum average of one story per 30 ticks while preventing routine audit events
from flooding the journal.

Operational audit families are excluded before event-envelope deserialization.
Rarity counts use one indexed SQL aggregation over the inclusive 30-tick
window, and expensive fact hashes are computed only for the final top 25. The
digest contract and ranking remain identical to WS-701.

## Strict proposal boundary

For each selected event the engine constructs three complete drafts:
`neutral`, `context`, and `brief`. Every draft contains:

- a bounded headline and body;
- one of the approved news topics;
- deterministic entities and stance;
- at least one real committed event ID; and
- exact copied source facts, including payload, actor, tick, date, causal
  evidence, and an immutable fact hash.

Complete facts remain engine-side. The Tier-2 request receives fenced
untrusted source prose plus safe draft summaries and exact `{draftId,
draftHash}` menu references. The strict response schema permits only
`news.story.publish.(neutral|context|brief)` and an exact offered parameter
tuple. Request-hash drift, provider errors, malformed output, forged hashes,
or menu mismatches are recorded and spiked with zero reach. They never emit a
publication event or apply a state-changing action.

LLM-off mode selects the neutral engine template deterministically and performs
no provider call. Mock and live modes use the existing cache, budget, prompt,
telemetry, quarantine, and pre-tick barrier boundaries. Phase 6's deliberately
single-call acceptance fixtures use the explicit phase-isolation seam; normal
production services enable news by default.

## Persistence, events, and replay identity

Migration 26 adds append-only tables for:

- `news_organizations`;
- `news_digests`;
- `news_stories`; and
- `news_story_citations`.

Database constraints enforce staff authority, one digest per source tick,
daily editor caps, unique organization/source-event citations, and immutable
rows. Story insertion re-reads each committed event and compares every copied
fact before atomically storing the story and citation rows.

Versioned organization, digest, publication/spike, Decision, AgentAction, and
LLM-call events carry actor, correlation, causation, and evidence IDs. Logical
state-hash version 20 includes all Phase 7 tables while normalizing run and
operational correlation identity. Exact stored facts remain unchanged.
Snapshots restore the same logical hash and news rows, and equal-seed runs with
different run/request identities produce the same logical state hash.

## Verification

Focused coverage proves:

- exact citation copying and store-side revalidation;
- strict menu equality and forged-hash containment;
- malformed/extra-field schema fuzz cases;
- deterministic off-mode fallback with zero LLM calls;
- valid mock publication and immutable call evidence;
- provider/schema/menu failures produce only spiked stories;
- organization roles, editor cap, dedupe, rollback, reopen, and migration 26;
- state-hash and snapshot restore equivalence;
- deterministic 30-tick editorial windows;
- Phase 6 call-count isolation and mock/live shape parity;
- INV-10 journalist capability authorization; and
- at least 12 published stories in the complete 360-tick Phase 4 gate.

The long-run implementation was reduced from a 332-second regression to a
verified 168-second Phase 4 gate by pre-aggregating rarity counts, excluding
operational rows in SQL, validating each candidate once, and hashing only the
bounded final selection. The comprehensive Phase 4 timeout is 240 seconds to
retain CI headroom as the roadmap expands.

Run the focused suite with:

```text
pnpm exec vitest run packages/engine/src/news-story.test.ts packages/engine/src/newsworthiness.test.ts apps/server/src/news-phase.test.ts apps/server/src/persistence/database.test.ts apps/server/src/persistence/event-store.test.ts
```
