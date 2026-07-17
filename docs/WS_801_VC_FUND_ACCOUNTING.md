# WS-801 — VC entities and exact fund accounting

Status: implemented on 2026-07-16.

## Delivered contract

- `VentureCapitalFirm`, `VentureFund`, and `VentureFundDeployment` have strict shared Zod contracts. All money is canonical integer-cent text bounded to SQLite's signed 64-bit range and handled as `bigint` in deterministic rules.
- Complete Riverbend runs seed `inst_foundry_capital` and Foundry Fund I with a fixed size of `500000000` cents and zero deployed capital.
- `venture.firm.created`, `venture.fund.created`, and `venture.fund.deployed` are schema-versioned facts with explicit actor, correlation, causation, and evidence.
- A deployment records amount, exact before/after totals, target company, reference, tick, and source event. It is append-only and unique per fund/reference.

## Hard accounting boundary

`quoteVentureFundDeployment` computes:

```text
deployedAfter = deployedBefore + amount
remaining = fundSize - deployedAfter
0 <= deployedAfter <= fundSize
```

The same boundary is enforced independently by shared schemas and migration 31. The database validates canonical cents, the immutable deployment chain, current parent total, open-fund status, target-company existence, exact addition, monotonicity, and the fund cap. An accepted deployment trigger advances the fund total and marks exact exhaustion as `fully_deployed` in the same transaction.

## Persistence and replay

- Logical state-hash v23 includes all firms, funds, and deployment records in canonical order.
- Snapshot restore reproduces the next deployment entity, event, checkpoint, and final state hash exactly.
- Reopen preserves the same fund projection and hash.
- Injected outer-transaction failure rolls back the deployment row, fund total, journal event, sequence, and logical hash together.
- Direct total updates without a matching immutable deployment are rejected.

## Verification

Focused coverage includes fund-accounting properties over generated deployment sequences, schema failures, migration-30 upgrade/reopen, seeded entity reads, exact exhaustion, over-deployment, closed-fund behavior, duplicate references, SQL tamper attempts, transactional rollback, state hashing, and restore equivalence.

The ticket gate is:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The final Windows run passed all four commands: 130 Vitest files and 684 tests were green, including both long phase gates, strict replay, and the two-run seed-42 state/journal comparison. The production dashboard build also completed successfully.
