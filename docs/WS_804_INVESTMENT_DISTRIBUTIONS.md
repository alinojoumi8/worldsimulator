# WS-804 — Exact investment distributions

## Outcome

WS-804 completes the Phase 8 backend ownership lifecycle. A company can declare a positive integer-cent distribution against its authoritative cap table. The engine aggregates all current stakes by beneficial owner, orders owners by code-unit `holderKind` then `holderId`, and applies the shared largest-remainder primitive. The result is independent of query/input order and always allocates the declared amount exactly.

## Authoritative transaction and event chain

`SqliteInvestmentDistributionStore.distribute` performs one atomic path:

1. Validate the request, cap-table INV-4 identity, company balance, and every active recipient account before consuming an ID.
2. Emit `investment.distribution.requested` with the exact owner/share/cent quote and causal evidence.
3. Post one domestic `dividend` transaction: a company credit leg plus one owner debit leg for every positive allocation.
4. Emit the normal `transaction.posted` fact and then `investment.distribution.completed` with the exact recipient accounts and allocation evidence.
5. Persist immutable parent/allocation rows. Reusing the same company/reference/amount returns the prior result; a conflicting amount fails closed.

Owners whose exact allocation is zero cents retain an allocation row, but no invalid zero-value ledger leg is created.

## Persistence guarantees

Migration 34 adds `investment_distributions` and `investment_distribution_allocations`. Database constraints and triggers independently require:

- canonical signed-64-bit cent/share values;
- one aggregate allocation per current beneficial owner;
- allocation shares equal the historical cap-table total;
- allocation cents equal the declared amount;
- active agent or dedicated venture-fund recipient accounts;
- exactly one matching balanced `dividend` transaction; and
- typed request/completion source events in either immediate-test or deferred tick-commit ordering.

Both tables are immutable. Logical state-hash version 26 includes parent and allocation projections, so snapshot restoration and replay-equivalent continuation cover distribution state.

## Verification coverage

- Fast-check properties over arbitrary positive amounts and ownership weights prove exact cent/share sums.
- Goldens prove duplicate-stake aggregation, input-order independence, and canonical equal-remainder tie-breaking.
- Persistence integration proves the 10,000/2,500-share founder/fund split of seven cents is exactly 6/1, with matching account deltas and causal events.
- Duplicate-reference idempotency, conflicting-reference rejection, unfunded zero-mutation behavior, immutable-row guards, migration 33→34 upgrade/reopen, forced rollback, and snapshot restore-equivalence are covered.

Required handoff gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Verified on 2026-07-16: all four commands passed; Vitest reported 133 files and 708 tests green, and the production build completed with only the existing chunk-size advisory.
