# WS-506 - Seeded credit state

WS-506 closes the gap between Riverbend's generated credit story and its authoritative bank books. The opening portfolio is no longer accepted merely because eight loan-shaped rows exist: one deterministic audit now proves every stored term, historical installment, ledger relationship, and causal event together.

## Exact opening portfolio

- Ironvale Manufacturing has one current $300,000 original-principal working-capital loan at 6.50%, with a 36-month term and 22 seasoned months. Its exact outstanding principal is $116,666.62.
- Seven distinct eligible adults have 24-month vehicle or appliance loans with $3,000–$12,000 original principal.
- Six personal loans are current. One additional personal loan has exactly its latest seasoned installment marked missed and all later installments scheduled.

The portfolio is deterministic for a scenario seed. The generator's existing all-or-nothing validation remains in place, while `auditSeededCreditPortfolio` supplies the reusable acceptance boundary used by focused tests.

## History arithmetic

For every loan the audit independently verifies:

- contiguous installments 1 through the contractual term;
- equal-principal allocation with at most one cent between rows;
- exact principal conservation;
- monthly interest from the row's scheduled opening principal using `annualRateBp / 120,000`, rounded with canonical HALF_EVEN;
- paid, missed, and scheduled chronology implied by `seasonedMonths`;
- outstanding principal equal to every non-paid principal row; and
- current/delinquent status equal to the stored missed-payment count.

No ambient time, floating point, locale ordering, or nondeterministic rounding participates.

## Authoritative bank evidence

`SqliteOpeningCreditStore` reconstructs the complete persisted state and runs `auditOpeningCreditState`. Each loan must have:

- one active internal bank-asset account whose balance equals outstanding principal;
- the correct borrower's active checking account at the same bank;
- one balanced tick-0 `world_gen.seed_loan_recognition` transaction that debits the asset and credits First Ledger's loan-source liability for the exact same cents;
- one immutable ledger link; and
- one versioned `loan.seeded` event whose stored terms and schedule digest match the loan and whose causation points to that recognition transaction's `transaction.posted` fact.

The original loan proceeds are already reflected in calibrated opening deposits, so recognition deliberately uses two bank-internal legs rather than minting or crediting the borrower again.

## Persistence and invariants

Migration v17 adds insert-time JSON/history checks, borrower provenance checks, exact account/transaction/leg checks, and update/delete guards for `seed_loans`. Existing link rows were already immutable; their new insert guard now enforces their complete shape.

INV-6 still checks every seed and originated loan for asset, borrower-account, and transaction references. When an opening portfolio exists, it additionally runs the complete WS-506 audit and reports each failure under `openingCreditState`.

Logical state-hash v14 already includes seed canonical rows, links, bank accounts, transactions, and legs, so no projection-version bump is needed for trigger-only migration v17. The integration test proves rejected writes leave the hash unchanged, a reopened database returns the same audit, and a verified tick-0 snapshot restores to the identical audit, hash, and INV-6 result.

## Verification

Focused coverage includes multi-seed portfolio histories, exact Ironvale terms, corrupted-interest detection, strict canonical parsing, SQL rejection/immutability, causal event matching, full INV-6, reopen, and snapshot restore equivalence. The repository gate remains:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
