# WS-502 — Application workflow and policy decisions

WS-502 turns the score snapshot from WS-501 into a deterministic underwriting workflow. It records review assignment and terminal decisions without disbursing money; loan creation and schedules begin in WS-503.

## State machine

The legal transitions are:

```text
submitted -> under_review -> approved
                          -> rejected
submitted/under_review   -> withdrawn
```

Approved, rejected, and withdrawn states are terminal. SQL transition guards reject direct submission-to-decision changes, terminal rewrites, and review/decision states without their matching immutable records. Review cannot precede submission and decision cannot precede review.

## Officer slot

First Ledger's active `bank.loan_officer` agents are ordered by prior review count and then agent ID. The least-loaded officer receives the next file. A requested reviewer is accepted only when that agent currently holds the same active role; a teller or unrelated agent is rejected before state changes.

Until WS-605 enables the live Tier-2 choice, review tier `tier1` applies exactly zero discretionary points. It still records a deterministic written rationale that either confirms all checks or names every failure in stable policy order.

## Policy model v1

Approval is the conjunction of six immutable checks:

| Check | Rule |
|---|---|
| `minimum_score` | final score >= 650 |
| `maximum_dti` | stored DTI <= 5,000 bp |
| `maximum_term` | term <= 120 months |
| `borrower_exposure` | existing debt + request <= bank exposure cap |
| `bank_status` | bank status is `active` |
| `minimum_capital_ratio` | current integer capital ratio >= bank minimum |

Each check stores comparator, actual value, threshold, pass/fail, and evidence references. The current capital ratio is floored integer basis points; a bank with zero deposits uses the 10,000 bp convention.

An approval receives a deterministic offered rate:

```text
baseLendingRateBp + max(0, 750 - finalScore) * 5
```

A rejection stores no offered rate. WS-505 now precedes this six-check decision with an immutable live circuit assessment. Its borrower exposure and projected capital feed the corresponding checks, while a reserve or systemic failure feeds `bank_status`; the complete reserve/capital/concentration evidence remains separately queryable without rewriting this WS-502 decision record.

## Persistence and causality

Migration v13 adds `loan_application_reviews` and `loan_application_decisions`. Both are append-only. Insert guards enforce active-officer authority and require the decision's application, score, review, officer, and tier to match. Logical state hash v11 includes the two tables.

The event chain is:

1. `loan.application.created`
2. `loan.score.computed`, caused by creation
3. `loan.application.review_started`, caused by creation and acted by the officer
4. `loan.approved` or `loan.rejected`, caused by review and acted by the officer

The terminal event carries score inputs and breakdown, officer identity/adjustment/rationale, every policy check and evidence reference, failed-check IDs, and the offered rate. A why-panel can therefore render from authoritative stored data alone.

## Acceptance evidence

- Pure goldens cover approval, total rejection, rate spread, capital-ratio rounding, bounded adjustments, and every state transition.
- Persistence coverage proves deterministic load-balanced assignment, role authority, complete event causality/payloads, terminal immutability, and SQL bypass rejection.
- Failure coverage proves review work rolls back with application state.
- Reopen coverage proves byte-equivalent decisions and state hashes.
- Snapshot coverage proves restored state produces the same next decision hash as straight-through state.

Run the focused gate with:

```bash
pnpm vitest run packages/engine/src/credit-policy.test.ts apps/server/src/persistence/credit-workflow.test.ts apps/server/src/persistence/database.test.ts
```
