# WS-803 - Exact cap-table math and atomic investment closing

Status: implemented on 2026-07-16.

## Delivered contract

- Negotiated priced rounds close only when the pre-money valuation is exactly divisible by the current integer share count and the investment amount is exactly divisible by that integer-cent share price.
- The engine recomputes issued shares, post-round shares, post-money valuation, and investor basis points. A negotiated equity value may differ from the exact cap table by at most one basis point.
- Bounded terms that would require fractional cents or fractional shares emit a typed `investment.rejected` event with validation evidence. They create no contract, transaction, deployment, stake, or cap-table update.
- `company_cap_tables` and immutable `ownership_stakes` are now the authoritative ownership projection for both opening and dynamically formed companies. Founder tables remain dual-written only for compatibility with earlier phases.
- INV-4 is exact: the sum of integer ownership-stake shares must equal the cap table's integer total. There is no percentage rounding or tolerance.

## One atomic close

An agreed proposal closes inside the tick transaction as one rollback boundary:

1. Revalidate the proposal, open fund, available commitment, company status, fund account, company account, cap table, and exact priced-round identities.
2. Draft and sign an immutable `investment` legal contract containing the exact price, amount, and before/after share counts.
3. Draw only the fund-account shortfall from ROW through an explicit `row_settlement` capital call.
4. Transfer the negotiated cash from the fund account to the company checking account.
5. Record the immutable fund deployment.
6. Emit `investment.completed` with the complete before/after cap-table diff and causal evidence.
7. Insert the fund's ownership stake, advance the cap-table revision, transition the proposal to `completed`, and persist the immutable investment record.

Any failure rolls back the event chain, contract, cash, fund deployment, shares, proposal transition, and investment together. The ROW capital call is the only M1-changing leg; the fund-to-company transfer is domestic and net-zero.

## Persistence and tamper boundaries

Migration 33:

- extends legal contracts with the `investment` template while preserving populated party, obligation, breach, and timeline children;
- maps every fund to one dedicated active firm checking account, including deterministic backfill accounts for pre-v33 funds;
- backfills generalized cap tables and founder stakes from existing opening and dynamic company ownership;
- adds immutable investments with database-checked proposal, contract, cash, fund-deployment, stake, and cap-table identities;
- guards cap-table revisions so an exact evented investment stake must precede every issuance;
- accepts both event-before-stake direct persistence and stake-before-event tick-commit ordering, while rejecting a non-`investment.completed` source in either order;
- reopens idempotently with a clean foreign-key check.

Logical state-hash version 25 includes fund-account links, cap tables, all ownership stakes, and completed investments. Snapshots preserve the same projection.

## Event and evidence chain

The close retains actor, correlation, causation, schema version, and evidence through:

```text
investment.proposal.agreed
  -> investment.closing.requested
  -> contract.drafted
  -> contract.signature.recorded
  -> contract.signed
  -> venture.fund.capital_call.requested (only for a shortfall)
  -> transaction.posted
  -> investment.cash_transfer.requested
  -> transaction.posted
  -> venture.fund.deployed
  -> investment.completed
```

The completion payload contains the real proposal, contract, transaction, deployment, ownership-stake, and event IDs plus the exact pre/post cap tables.

## Acceptance coverage

- Pure bigint dilution golden: 1,000 existing shares, $8,000 pre-money, and $2,000 invested produces an $8.00 share price, 250 new shares, 1,250 post-round shares, and exact 80/20 ownership.
- Property tests prove price, valuation, amount, issuance, and total-share identities for exact generated rounds.
- Invalid canonical values, SQLite-range overflow, fractional price/share results, and inconsistent negotiated equity fail closed.
- End-to-end closing proves cash balances, ROW attribution, signed contract terms, fund deployment, proposal completion, cap-table diff, immutable rows, causal events, and INV-4.
- A bounded but fractionally unrepresentable agreement proves zero partial mutation and typed rejection.
- Transaction rollback, database reopen, populated v32-to-v33 migration, deferred event ordering, logical state hash, and snapshot restore-equivalent closing are covered.
- The complete repository gate passes 132 Vitest files (700 tests), including the 360-tick source run, strict replay, and independent seed-42 state/journal hash comparison.
