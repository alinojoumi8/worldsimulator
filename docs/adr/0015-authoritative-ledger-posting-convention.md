# ADR-0015 — Authoritative ledger posting convention and supply channels

**Status:** accepted · **Date:** 2026-07-15

## Context

Phase 3 introduces one cashless bank, customer and internal accounts, opening endowments, payroll, tax, benefits, household purchases, and explicit rest-of-world flows. Every module needs the same answer for how a debit or credit changes the account balance, which actors may lower a balance, and which postings are allowed to change M1.

## Decision

- The immutable transaction journal and its legs are authoritative. `bank_accounts.balance_cents` is a checked cache and must equal the signed sum of all legs.
- The engine uses an owner-view, debit-positive convention: a debit increases an account balance and a credit decreases it. Customer checking accounts therefore read naturally as available funds. Bank-internal contra accounts absorb the opposite side and may have an explicitly negative floor.
- Every transaction has at least two distinct accounts, positive integer-cent legs, and exactly equal debit and credit totals.
- A non-system actor may credit, and therefore spend from, only an account it owns. System and admin actors remain subject to account existence, status, floor, transaction-kind, and money-channel checks.
- World-generation mint transactions require a credited bank-internal equity or liability source. Lending/repayment and ROW settlement are separately labeled authorized channels. All channel transactions emit `transaction.posted`.
- M1 v1 is the sum of active agent and company checking balances. Treasury and bank-internal accounts are excluded, matching the INITIAL_WORLD $4.2M household plus $0.9M business baseline.
- Idempotency keys are unique per run. An exact retry returns the original transaction with `duplicate_idempotency_key_ignored`; reuse for different work is a conflict.
- Transaction rows and legs are immutable. Account identity and ownership are immutable; only the cached balance and lifecycle status may change.

## Alternatives considered

- Conventional normal-side signs per account class: richer for a full bank general ledger, but makes customer available balances harder to interpret and adds a normal-side branch to every floor check.
- Direct balance mutation plus audit events: simpler initially, but cannot prove INV-1/2 or reconstruct balances.
- Event sourcing without balance caches: authoritative but makes every read and floor check need an unbounded fold.

## Consequences

- Internal source accounts can be negative by design and must never be included in M1.
- Reconciliation is cheap and deterministic: fold debit as `+amount`, credit as `-amount`, then compare with each cached balance.
- WS-508 audits the treasury-excluded M1 definition without broadening it: domestic supply is agent + company + government checking, and each raw M1 delta must equal its authorized domestic-supply delta minus the simultaneous treasury delta. Taxes and benefits are explicit fiscal reclassifications, not issuer channels.
- Later multi-bank and full bank-statement work may add a bank-view reporting projection without changing the owner-view journal.
