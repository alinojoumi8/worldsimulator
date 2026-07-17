# Phase 3 finance implementation

WS-301 through WS-309 are implemented as one authoritative financial path. Shared schemas define banks, accounts, transaction kinds and legs, employment contracts, policies, and indicators. The engine owns deterministic posting and allocation rules; SQLite owns durable records and read models; tick handlers request postings inside the existing all-phase transaction boundary.

## Genesis

First Ledger Bank opens checking accounts for all 100 residents, six opening companies, the town treasury, institution employers, and controlled internal/ROW books. Generated balances are posted from zero through balanced `mint` transactions. Treasury receives $180,000. Seed loans receive matching bank-asset, internal-liability, borrower-account, and disbursement-link records. Six founder cap tables each sum to 10,000 shares.

The opening checks prove:

- mint debits equal all non-ROW, non-internal opening balances;
- every transaction balances and every cached balance reconciles;
- no account is below its floor;
- every employed resident has one active agreement;
- every seeded loan has its linked asset, deposit account, and opening recognition transaction;
- INV-1 through INV-6 are active and pass.

## Tick behavior

On simulated days 15 and 30, annual wages are split with largest-remainder allocation over 24 periods. Withholding is `mulDiv(gross, rateBp, 10000, HALF_EVEN)` and net is exactly `gross - withholding`. A payroll transaction credits the employer and debits employee checking plus treasury. Missing employer cash emits `payroll.missed` without a partial posting. Unemployment benefits use the same exact 24-period allocation and stop with `benefit.suspended` before treasury could cross zero.

Every tick, households request food, utilities, rent, then discretionary consumption. Monthly amounts use exact 30-part allocation. Available checking funds are consumed in priority order, never beyond account floors. All external purchases settle against the ROW account as `row_settlement`; an unmet essential request emits `financial_stress.triggered`.

## Indicator formulas

The Phase 3 boundary originally persisted four integer-string points per tick:

- `m1`: sum of agent and company checking balances;
- `averageWage`: integer-cent mean annual wage across active employment contracts;
- `unemploymentRate`: unemployed divided by employed plus unemployed, in basis points;
- `treasuryBalance`: town treasury checking balance.

WS-507 added `creditOutstanding` and `defaultRate`; WS-704 completes the same
atomic boundary with `gdpProxy`, `cpi`, `businessCount`, and `sentimentIndex`.
All ten latest values now appear in the committed tick digest and the bounded
series API. Every persisted point carries its formula version and canonical
source-input digest. Exact current formulas, units, price-source priority, and
restore evidence are documented in [WS-704](WS_704_FULL_INDICATORS.md).

## WS-508 conservation attribution

M1 v1 deliberately excludes treasury, while the authorized supply boundary includes all domestic checking deposits (agent, company, and government). The audit therefore proves the following identity independently at every persisted tick:

```text
M1 delta = mint + lending + repayment + ROW supply deltas - treasury delta
```

Each channel term is the signed domestic-checking effect of immutable transaction legs. The treasury term is the explicit fiscal reclassification bridge: withholding can move deposits from private M1 into treasury and benefits can move them back without creating or destroying domestic deposits. The audit reconstructs M1 and treasury from zero, compares them with the persisted point pair at ticks 0–360, and requires exactly one matching `transaction.posted` event with the same tick and kind for every ledger transaction. Unauthorized non-channel supply effects, missing/duplicate events, indicator drift, or any residual cent fail the report and CI. INV-2 consumes the same real signed domestic deltas rather than placeholder values.

## Read APIs

- `GET /api/v1/simulations/{simId}/transactions`
- `GET /api/v1/simulations/{simId}/banks`
- `GET /api/v1/simulations/{simId}/banks/{bankId}`
- `GET /api/v1/simulations/{simId}/indicators`
- `GET /api/v1/simulations/{simId}/agents/{agentId}/finances`

The transaction endpoint supports account, kind, tick-range, correlation, and cursor filters. Every returned item contains owner-resolved legs whose debit and credit totals are equal.
