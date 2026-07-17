# WS-503 — Amortization and atomic disbursement

WS-503 turns an approved, immutable underwriting decision into authoritative credit. It does not collect installments or default loans; those state transitions belong to WS-504.

## Deterministic schedule

`generateAmortizationSchedule` is a pure engine function. Its inputs are positive integer-cent principal, annual rate in basis points, term in months, and disbursement tick.

- Every month is exactly 30 days and every year is exactly 360 days.
- Installment `n` is due at `disbursedTick + n × 30`.
- Rows 1 through `N−1` receive `floor(principal/N)` principal.
- Row `N` receives the entire remaining principal, so principal always reconciles exactly.
- Row interest is `openingPrincipal × annualRateBp × 30 / (10,000 × 360)` using the canonical `mulDiv(..., "HALF_EVEN")` cents rule.
- The SHA-256 schedule digest covers the canonical ordered contractual rows. Persistence-only IDs and later payment state do not change it.

The implementation rejects unsafe ticks, rates, terms, and malformed cent strings before constructing any row.

## Atomic credit creation

`SqliteCreditStore.disburseApprovedApplication` runs as one immediate SQLite transaction, or joins an existing outer transaction. It requires:

1. an approved application and matching immutable approved decision with an offered rate;
2. an active bank and active borrower checking account at that bank;
3. the bank's active internal loan-source liability account; and
4. an active company when the borrower is a company.

The operation allocates the loan, asset-account, transaction, and installment IDs deterministically. It then opens the loan asset, builds the immutable schedule, posts the lending entry, and inserts the loan and installment rows. Any failure rolls all of these records and their events back together.

The balanced three-leg transaction is:

| Account | Direction | Amount |
| --- | --- | ---: |
| Loan-specific bank internal asset | debit | principal |
| Borrower checking deposit | debit | principal |
| Bank internal loan-source liability | credit | `2 × principal` |

In WorldTangle's signed-balance convention, debit raises an account balance and credit lowers it. The entry therefore raises the loan asset and domestic deposit by the principal while keeping total ledger debits and credits exactly equal. Only the system actor may post this controlled money channel.

SQLite guards require the loan terms to match the approved application/decision, the exact asset and borrower accounts to exist, and the linked system transaction to contain exactly those two debit legs plus the bank loan-source credit leg. Terms and schedule cores are immutable and neither loan nor installment rows may be deleted.

## Events and evidence

Every origination emits version-1 events under `loan-application:<applicationId>`:

1. `loan.disbursed`, caused by the approval event and acted by the bank institution;
2. `account.opened`, caused by `loan.disbursed`;
3. `loan.schedule.created`, caused by `loan.disbursed`; and
4. `transaction.posted`, caused by `loan.disbursed`.

The payloads carry the application/decision references, exact terms, ledger IDs, schedule digest, ordered installments, and source evidence needed to reconstruct why the state exists. The transaction's own `sourceEventId` is the `loan.disbursed` event.

## Persistence and replay boundary

Migration v14 adds `loans` and `loan_installments`, their deterministic read indexes, foreign keys, consistency triggers, and immutability guards. Logical state-hash v12 includes both tables in stable disbursement/due ordering. The invariant probe now exposes seed and originated loans to INV-6.

Subsequent credit assessments include originated outstanding principal, remaining twelve-installment debt service, completed/missed installments, defaults, and bounded loan evidence IDs. This prevents the scoring boundary from forgetting debt created after world generation.

## Verification

Coverage includes:

- exact 12-month and residual-cent goldens;
- HALF_EVEN interest goldens and bounded schedule properties;
- exact principal exhaustion and stable schedule digests;
- borrower-deposit, bank-asset, and loan-source balance deltas;
- balanced legs, controlled actor, and complete causal events;
- live-debt feedback into the next credit assessment;
- INV-6 for originated loans;
- duplicate disbursement and SQL immutability rejection;
- outer-transaction rollback across events, accounts, ledger, loan, and schedule;
- database reopen/state-hash equality; and
- snapshot restore followed by equivalent next-disbursement IDs, records, events, and state hash.
