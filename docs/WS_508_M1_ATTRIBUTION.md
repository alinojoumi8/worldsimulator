# WS-508 M1 Attribution

WS-508 closes Phase 5 with a reusable M26 conservation report and a 360-day CI sweep. The audit is read-only: it adds no table, migration, event or hash surface.

## Boundary and identity

The accepted ADR-0015 definition remains unchanged:

- M1 v1 is agent and company checking deposits.
- Treasury is a separate indicator.
- Domestic supply is agent, company and government checking deposits.
- Bank-internal and ROW balances are outside domestic supply.

Because fiscal transfers cross the M1/treasury reporting boundary without changing domestic supply, every tick uses the exact identity:

```text
M1 delta
  = authorized domestic-supply delta - treasury delta
  = mint + lending + repayment + ROW - treasury delta
```

Debits are positive and credits are negative under the owner-view ledger convention. A tax payment therefore lowers M1 and raises treasury by the same cents; a benefit does the reverse. Neither is mislabeled as money creation.

## Evidence sweep

`auditM1Attribution()` is pure and deterministic. Its SQLite probe supplies only authoritative rows:

1. all transactions and ordered legs joined to immutable account ownership/type;
2. every `transaction.posted` event, parsed for transaction ID and kind;
3. persisted `m1_cents` and `treasury_balance_cents` point pairs;
4. the committed run tick.

For every tick from zero through the run checkpoint, the audit:

- folds private and treasury checking deltas from zero;
- compares reconstructed balances to both persisted indicators;
- classifies non-zero domestic effects as `mint`, `lending`, `repayment`, or `row`;
- rejects any non-channel transaction that changes domestic supply;
- requires exactly one same-tick, same-kind `transaction.posted` event per transaction;
- records channel totals, treasury reclassification, reconstructed M1 and residual cents;
- computes a basis-point attribution rate from gross observed versus gross residual movement.

The existing INV-2 probe now derives real signed domestic-deposit changes from ledger legs. It no longer supplies zero placeholders for controlled transaction kinds.

## Acceptance evidence

The 360-day CI gate audits 361 point pairs (genesis plus ticks 1–360). It requires:

- `complete = true`;
- `attributionRateBp = 10000`;
- `unattributedM1DeltaCents = 0`;
- `grossUnattributedM1ChangeCents = 0`;
- every material supply transaction to have evidence;
- final reconstructed M1 and treasury to equal the latest persisted indicators;
- exercised mint and ROW channels.

Focused pure tests also prove that an internal-to-private transfer using an unauthorized kind produces an unattributed residual, and that missing evidence or a drifted indicator makes the report fail. The ticket gate is `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
