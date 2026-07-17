# WS-504 - Collections, arrears, and default

WS-504 advances originated loans from disbursement through repayment, delinquency, cure, or default. Regulatory lending circuit breakers are implemented separately by WS-505.

## Due-tick collection rule

`M09-credit-collections` runs in the obligations phase at order 60, after payroll and benefits at order 50. An installment is evaluated only on its exact contractual due tick. The collection set contains every earlier `missed` row plus the current `due` row in installment-number order.

- Available cash is checking-account balance above its configured floor.
- Exact equality is sufficient.
- The borrower must fund the entire collection set.
- There are no partial installments and no partial arrears cures.
- A successful set completes each row with its own immutable ledger transaction, reduces outstanding principal by the exact principal total, resets consecutive misses to zero, and marks the loan `paid_off` only at zero principal.
- An insufficient set marks only the current due row `missed`; earlier missed rows remain explicit.

The pure engine rules validate ordered unique rows, sum principal/interest/total as `bigint` cents, enforce full-set affordability, preserve principal conservation, and define the third consecutive miss as the default threshold.

## Repayment accounting

WorldTangle uses a debit-positive signed-balance convention. For principal `P` and interest `I`, each installment posts:

| Account | Direction | Amount |
| --- | --- | ---: |
| Bank loan-source internal liability | debit | `2 x P` |
| Bank interest-income account (when `I > 0`) | debit | `I` |
| Borrower checking deposit | credit | `P + I` |
| Loan-specific bank asset | credit | `P` |

Debits and credits are equal. The principal legs unwind the matching origination balances, the checking credit removes the funded amount, and the dedicated income account makes interest independently auditable. SQLite requires this exact three- or four-leg shape before an installment may become completed.

## Misses, cure, and default

Every insufficient due date emits `loan.payment.missed` with required and available cents, the consecutive count, the threshold, and the full current miss history. A later funded due date atomically completes its earlier missed rows and the current row, then resets the streak.

On the third consecutive miss:

1. the loan becomes `defaulted` while its legal outstanding principal remains visible;
2. `loan.defaulted` records the ordered three-row history and planned write-down identifiers;
3. a balanced system transaction debits the bank's dedicated `internal_expense` credit-loss account and credits the loan asset for the exact outstanding principal;
4. a personal borrower loses 100 persisted credit-score points, bounded at the 300 floor, and receives `agent.credit_score.penalized`; and
5. an immutable `loan_defaults` row links the loan, miss history, write-down, scores, and causal default event.

Company defaults carry null score fields and do not mutate an agent. Subsequent underwriting observes the live default and missed-payment history from authoritative loan/installment state.

## Atomicity and persistence

The complete due cycle joins the current SQLite unit of work or opens one immediate transaction. Events, account creation, ledger legs, installment transitions, loan aggregate state, score mutation, and default record therefore commit or roll back together.

Migration v15 adds `loan_defaults`, stable borrower/bank indexes, collection transition guards, exact payment/write-down ledger guards, outstanding-principal reconciliation against completed installments, and immutable default guards. Logical state-hash v13 adds the ordered default records; loans, installments, accounts, transactions, events, and agent scores were already authoritative hash inputs.

## Verification

Coverage proves:

- full-set quote and affordability boundaries;
- bounded principal-conservation properties;
- exact funded installment ledger balances and causal events;
- first-miss persistence and a two-installment arrears cure;
- default on exactly the third consecutive miss;
- complete miss history, zeroed bank asset, equal credit-loss balance, and bounded score penalty;
- future score inputs observe three misses and one default;
- SQL rejection of terminal-installment, outstanding-principal, and immutable-default tampering;
- outer-transaction rollback and database reopen/hash equality; and
- snapshot restore followed by identical next-collection records, IDs, events, and state hash.
