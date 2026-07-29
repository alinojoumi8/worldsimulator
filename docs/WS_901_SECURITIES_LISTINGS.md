# WS-901 — Securities listings and eligibility

## Outcome

WS-901 establishes the first authoritative Phase 9 securities state without claiming that trading exists. A Riverbend company may be listed only when it is active, at least 30 ticks old, has either positive trailing 30-tick operating profit or at least $100,000 in its active checking account, and lists no more shares than its authoritative cap table contains.

The shared contract fixes the pilot policy as `riverbend_listing_v1`. Symbols are two to five uppercase alphanumeric characters, reference prices and listed shares are positive signed-64-bit integers, and the exchange uses a deterministic daily call schedule with a ±20% price band reserved for WS-903.

## Authoritative listing path

`SqliteSecuritiesStore.listSecurity` performs one bounded path:

1. Strictly parse the command and verify its causal trigger.
2. Recompute company status, age, trailing profit, active checking balance, and current cap table from authoritative projections.
3. Reject malformed, ineligible, or duplicate company/symbol requests before consuming IDs.
4. Open the singleton Riverbend securities market when needed and emit `market.securities.opened`.
5. Emit the exact documented `security.listed` payload and persist its eligibility receipt.

The store never treats a listing as an order, trade, IPO allocation, or price discovery result. Those behaviors remain assigned to WS-902–905.

## Persistence guarantees

Migration 36 adds `securities_markets` and `securities`. Constraints and triggers independently require:

- the loopback Riverbend exchange identity, daily schedule, and 2,000-basis-point band;
- one market, one listing per company, and one company per symbol in each run;
- an active company with the required age and capital-or-profit basis;
- listed shares within the authoritative cap-table total;
- exact typed opening/listing source events and eligibility fields;
- immutable listing identity and controlled market/security status transitions; and
- no destructive deletion of authoritative market or listing rows.

Logical state-hash version 27 includes both projections so replay and snapshot comparisons cannot omit listing state.

## Verification coverage

- Shared rule tests cover age, active status, profitability, capitalization, cap-table bounds, strict schemas, and signed-SQLite limits.
- Persistence integration covers exact events, duplicate rejection without ID consumption, logical-hash inclusion, database reopen, and forged direct-listing rejection.
- Migration coverage proves 35→36 upgrade and rollback behavior while preserving existing reopen checks.

Required handoff gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Verified on 2026-07-28: all four commands passed. Vitest reported 145 files
and 762 tests green; the production build completed with only the existing
chunk-size advisory.
