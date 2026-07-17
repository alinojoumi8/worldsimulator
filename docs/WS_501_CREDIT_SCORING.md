# WS-501 — Deterministic credit scoring

WS-501 introduces the first authoritative Phase 5 write path: submitting a personal or company loan application stores the request, derives a versioned score from current simulation state, stores every score input and evidence reference, and emits a directly causal event pair. It does not make an approval decision or disburse funds; those are WS-502 and WS-503.

## Model v1

All money inputs are nonnegative decimal cents strings and every calculation is integer-only.

```text
score = 300
      + floor(incomeStabilityBp * 200 / 10,000)
      + dtiPoints
      + floor(historyScoreBp * 150 / 10,000)
```

`dtiPoints` is 200 at or below 2,000 bp, zero at or above 6,000 bp, and declines linearly with an explicit floor between those bounds. The total is therefore always 300–850.

Debt-to-income basis points use the conservative ceiling of annual debt service divided by annual income and cap at 100,000 bp. Zero income maps to the cap. Annual debt service includes the next 12 unpaid seeded-loan rows plus the exact first-year principal for the proposed loan. Equal-principal remainder cents are absorbed by the final term row, matching WS-503's authoritative schedule.

Payment history uses:

```text
clamp(7,000 + min(completed, 20) * 150 - missed * 1,200 - defaults * 3,500,
      0, 10,000)
```

An applicant with no completed, missed, or default observations receives the documented neutral factor of 6,000 bp. Defaults remain zero until the WS-504 default lifecycle becomes authoritative.

## Authoritative input evidence

Agent income uses the resident's stored annual income. Stability is bounded by active-employment tenure and observed payroll reliability; the assessment records the employment contract and payroll transaction IDs used. An agent without an active employment contract receives 3,000 bp stability when stored income is positive, otherwise zero.

Company income annualizes up to 90 ticks of actual inbound purchase/ROW-settlement revenue. Stability is the lower of revenue-day frequency and a 30-day maturity factor. The assessment records the revenue transaction IDs used. Only active companies with an open business account can apply.

Existing debt, upcoming service, completed payments, and missed payments are derived from authoritative seeded loans. The assessment records every contributing loan ID. Derived DTI and history values are revalidated against their stored raw inputs before a score can be returned.

## Persistence and events

Migration v12 adds `loan_applications` and `credit_score_assessments`. Request inputs cannot be updated, neither table permits deletes, and assessments permit no updates. The application workflow may change only status and decision tick under the transition rules added by WS-502.

Submission emits:

1. `loan.application.created`, carrying the request and assessment/model references.
2. `loan.score.computed`, carrying all stored inputs, evidence, score, and breakdown.

Both events share `loan-application:<applicationId>` correlation. The score event is caused directly by the application event. Logical state hash v10 includes both tables, so credit changes participate in snapshots and replay equivalence.

## Acceptance evidence

- Formula goldens cover excellent, stressed, and no-history files.
- Property coverage proves the score remains an exact component sum in 300–850.
- Stored DTI/history inconsistencies and malformed inputs are rejected.
- Persistence tests cover exact evidence, event causation, SQL immutability, transactional rollback, database reopen, state-hash change, snapshot restore, and equivalent next-application advancement.

Run the focused gate with:

```bash
pnpm vitest run packages/engine/src/credit-scoring.test.ts apps/server/src/persistence/credit-store.test.ts apps/server/src/persistence/database.test.ts
```
