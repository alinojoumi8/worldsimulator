# WS-507 Credit Explorer

WS-507 closes the stored-data presentation boundary for the Phase 5 credit lifecycle. It adds persisted credit indicators, strict bank/loan read contracts, and React views that explain opening and originated credit without reconstructing decisions or inventing missing history.

## Indicator definitions

`creditOutstanding` is the gross contractual principal still stored on all opening and originated loans. A default writes down the bank asset but does not erase the borrower's legal obligation, so defaulted principal remains in this series until a later legal resolution changes the obligation.

`defaultRate` is:

```text
HALF_EVEN(recorded loan defaults × 10,000 / all opening and originated loans)
```

The value is persisted in integer basis points. Both series are written through the existing immutable `indicator_points` path at genesis and metrics boundaries. Migration v18 rebuilds the table constraint transactionally so it accepts the two new keys while preserving existing points and immutability triggers.

## Stored read boundary

`GET /api/v1/simulations/:simId/loans` normalizes `seed_loans` and originated `loans` into one strict response. It supports run selection, opaque keyset pagination and exact origin, status, bank, borrower-kind and borrower-ID filters. Ordering is deterministic by opening tick descending, then code-unit ID descending.

`GET /api/v1/simulations/:simId/loans/:loanId` returns the normalized loan, full schedule and one of two exhaustive why shapes:

- `opening_seed` exposes the seasoned history, recognition transaction, asset/deposit accounts, schedule digest, source/causation/correlation IDs and stored evidence. Historical simulation ticks and transactions that were never captured are left `null` rather than fabricated.
- `underwritten` exposes the immutable application, exact score inputs and component breakdown, assigned review, six policy checks, decision rationale, approval and disbursement circuit assessments, full schedule, optional default record and a complete event-evidence chain.

The legacy Ironvale opening borrower retains its stored `biz_ironvale` identity and is represented as borrower kind `business`; it is not coerced into a Phase 4 company.

## Bank and UI projections

Bank detail reports current deposits, contractual loan principal, ratios, halt status, account/loan counts and a trailing 30-tick statement. Interest income and write-downs are summed from immutable ledger debit legs on the bank's dedicated income/loss accounts and constrained to `loan.installment.payment` and `loan.default.write_down` transactions.

The World Explorer adds `/simulations/:simId/world/credit`, with persisted credit sparklines, bank cards and the normalized loan feed. `/simulations/:simId/banks/:bankId` exposes the bank position and loan book. `/simulations/:simId/loans/:loanId` shows terms, schedule and the complete discriminated why-panel.

## Integrity and acceptance evidence

- Shared Zod schemas reject unknown query fields, mismatched borrower prefixes, invalid series and malformed responses.
- Real Fastify integration proves opening pagination/filtering, exact Ironvale provenance, originated underwriting/circuit evidence, indicator reconciliation and rejected-request hash neutrality.
- A non-zero collection/default test proves ledger-derived interest/write-down statements and an exact 1,111 bp default rate for one default among nine stored loans.
- Reopen and snapshot restore return identical loan feeds/details and the same logical state hash.
- React component tests cover the bank/indicator/loan dashboard, all six underwritten policy checks, both circuit stages, and opening provenance without invented underwriting.

The ticket gate is `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
