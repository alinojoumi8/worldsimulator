# WS-505 - Bank circuit breakers

WS-505 makes First Ledger's reserve, capital, and per-borrower exposure limits live at both underwriting and disbursement. No approved amount can create a deposit or loan asset until a fresh post-credit assessment clears.

## Calibrated opening position

Riverbend retains the documented opening balance sheet:

| Measure | Opening value | Lending floor |
| --- | ---: | ---: |
| Domestic deposits | 528,000,000 cents | denominator |
| Liquid reserves | 95,040,000 cents | 1,200 bp |
| Reserve ratio | 1,800 bp | 1,200 bp |
| Opening capital | 73,920,000 cents | 1,000 bp |
| Capital ratio | 1,400 bp | 1,000 bp |
| Exposure per borrower | current bank-specific principal | 120,000,000 cents |

The old stored 1,800/1,400 values described the calibrated opening ratios but were previously treated as live values and minimums. Migration v16 separates the fixed reserve stock from live derived ratios and installs explicit 1,200/1,000 floors, leaving headroom for normal lending while ensuring a credit boom reaches a hard boundary.

## Deterministic pro-forma rules

For requested principal `P`:

```text
projectedDeposits = currentDomesticDeposits + P
projectedBorrowerExposure = currentBankSpecificExposure + P
reserveRatioBp = floor(reserveCents * 10,000 / deposits)
capitalRatioBp = floor(effectiveCapitalCents * 10,000 / deposits)
effectiveCapitalCents = max(0, openingCapital + interestIncome - creditLossExpense)
```

Approval and disbursement use the projected deposit denominator. Ratios are integer-only and capped at 100,000 bp; a zero current-deposit denominator uses the established 10,000 bp convention. Seed and originated principal both count toward borrower concentration. Defaulted originated principal remains visible to exposure while its write-down reduces effective capital through the authoritative loss account.

The breakers are evaluated in stable order: closed bank, reserve ratio, capital ratio, borrower exposure. Reserve or capital failure changes the bank to `lending_halted`. A later request whose projected systemic position is safe changes it back to `active`. Exposure failure is borrower-scoped and does not freeze unrelated applicants.

## Approval and disbursement boundaries

Every Tier-1 decision first persists `bank.lending.assessed`. The existing six-check underwriting record then consumes its bank-specific borrower exposure, projected capital position, and circuit-derived status. The full assessment is embedded in the `loan.approved` or `loan.rejected` event and remains independently queryable.

Every approved application is assessed again immediately before disbursement. A stale approval that no longer clears commits only its assessment and blocked/halt events. It does not create an account, ledger transaction, loan, schedule, deposit, or asset. Callers that need a non-throwing result use `tryDisburseApprovedApplication`; the compatibility wrapper throws only after the blocked attempt has committed.

## Persistence and causality

Migration v16 adds fixed `reserve_cents` and immutable `bank_lending_assessments`. SQL recomputes authoritative deposits, effective capital, borrower exposure, ratios, pass flags, and application/bank/decision provenance on insert. New decisions require a same-tick approval assessment; new loans require an allowed same-tick disbursement assessment. Records cannot be updated or deleted.

The causal chain is:

```text
review or approved decision
  -> bank.lending.assessed
  -> bank.lending.halted or bank.lending.resumed (when status changes)
  -> bank.lending.blocked (when denied)
  -> loan.rejected or loan.disbursement.blocked
```

Allowed assessments instead cause `loan.approved` or `loan.disbursed`. Logical state-hash v14 includes bank reserve state and the complete ordered assessment journal.

## Verification

Coverage proves:

- exact opening and projected ratio calculations;
- boundary-safe integer behavior over a bounded cents matrix;
- systemic halt and recovered-position resume transitions;
- borrower-scoped concentration blocking;
- fresh approval and disbursement assessments;
- stale approval denial without any impossible balance or partial loan state;
- live bank read ratios and originated-loan totals;
- SQL provenance, arithmetic, immutability, and mandatory-assessment guards;
- outer-transaction rollback and reopen/hash equality; and
- snapshot restore followed by identical next assessment, decision, IDs, events, and state hash.
