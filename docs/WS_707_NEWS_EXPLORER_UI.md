# WS-707 — News, causality, and replay explorer

WS-707 completes the Phase 7 explanatory UI. A simulation now has one bounded
workspace for published news, public sentiment, committed events, balanced
transactions, causal ancestry, and cache-only replay progress.

## Public read contract

- `GET /api/v1/simulations/{simId}/news` returns only published stories in
  deterministic `(tick desc, id desc)` order. It supports run, topic, tick,
  cursor, and bounded-limit filters.
- Every feed item resolves the author and newsroom names and retains its exact
  cited event IDs and publication source event.
- The feed also returns the three authoritative sentiment series in canonical
  `economy`, `employment`, `institutions` order.
- `GET /api/v1/simulations/{simId}/news/{storyId}` returns the inert story text,
  exact immutable event facts, decision/call references, and reconciled
  sentiment components. Spiked stories are not public and return 404.
- The existing events and transactions endpoints power the explorer. Event
  ancestry follows immutable `causationId` links; ledger items retain balanced
  enriched legs and their committed source event.

Shared Zod contracts reject invalid tick ranges, noncanonical sentiment order,
out-of-order sentiment points, mismatched citation identity/order, and
unreconciled sentiment effects. News cursors are opaque and bound to their
source run.

## User experience

The `/simulations/{simId}/explorer` route provides:

- a cited story feed with topic, stance, reach, author, and newsroom context;
- compact, accessible sentiment sparklines for all three public indices;
- a one-click story why-panel containing the exact body, cited facts, and
  attributed sentiment effect;
- filterable event and transaction tabs with actor, tick, correlation, source,
  balanced legs, and one-click causal ancestry;
- a second click from any cited fact into the matching explorer event, meeting
  the NFR-8 two-click explanation boundary;
- an admin replay stepper for strict or observe mode, a bounded target tick,
  live progress, compared-prefix count, and typed first-divergence evidence.

Story and event payload text is rendered as inert React text. Raw evidence is
available only in a secondary disclosure and is not the primary explanation
surface. Replay uses the WS-705 cache-only backend and never makes a live
provider call.

## Verification

Coverage includes:

- shared feed/detail, sentiment, citation, cursor, and route contracts;
- a real one-tick Fastify/SQLite run that publishes LLM-off stories and proves
  filters, pagination, resolved parties, exact citation lookup, and sentiment
  reconciliation;
- component coverage for hostile story text, cited-story tracing, event and
  transaction why-panels, full causal ancestry, and replay stepping/progress;
- strict type-check, ESLint, all 124 test files and 657 tests, and the production
  web build.

The ticket gate is:

```text
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
