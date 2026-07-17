# WS-406 — Energy tariffs and billing

WS-406 replaces the generic household-utilities ROW sink with a deterministic Riverbend Power & Light operating loop. M17 owns tariff and fuel operational data; all cash remains owned and posted by the M09 double-entry ledger.

## Ruleset v1

- Billing cycle: 30 ticks.
- Household tariff: one flat bill per household per cycle, seeded from `utilities_monthly_cents` (15,000 cents by default).
- Business tariff: 50 cents per produced unit by default.
- Reference fuel price: 100 cents per fuel unit.
- Pass-through: 60% of the fuel-price movement relative to the reference price.
- Tariff bounds: 50%–200% of each base tariff.
- Fuel-price bounds: 50%–300% of the reference fuel price.
- Household fuel requirement: 100 fuel units per paid flat bill.
- Business fuel requirement: 0.25 fuel units per paid production unit.

All arithmetic is integer `bigint` cents. Pass-through uses explicit HALF_EVEN rounding; lower tariff bounds use CEIL and upper bounds use FLOOR so the integer envelope is exact. A +30% fuel shock changes the household tariff from 15,000 to 17,700 cents and the business tariff from 50 to 59 cents at the next 30-tick boundary.

## Tick flow and accounting

1. At the start of a billing-boundary tick, M17 derives new tariffs from the latest fuel-price record and emits `market.price.updated` for `sku=electricity`.
2. M08 production includes the active business energy tariff in the produced unit cost and inventory moving average.
3. M06 settles the due flat household bill to RP&L. The payment is all-or-nothing; insufficient funds produce `energy.bill.rejected` and financial-stress evidence without a transaction.
4. M17 bills each active company for the current tick's authoritative `production_runs` volume.
5. M17 aggregates the fuel requirements of paid bills and posts RP&L's purchase to the ROW account with `row_settlement`.

Every paid bill is a balanced `purchase`; every fuel purchase is a balanced authorized ROW flow. Events carry actor, correlation, causation, tariff/bill/transaction IDs, and production or household evidence references.

## Persistence and replay boundary

Migration v9 adds immutable `energy_systems`, `energy_tariff_history`, `energy_fuel_price_history`, `energy_bills`, and `energy_fuel_purchases`. These tables are part of logical state-hash v7. Tests cover migration/reopen, immutable history, exact pass-through properties, paid and rejected billing, injected transaction rollback, ROW conservation, event linkage, snapshot restore, and identical next-shock hashes after restore.

WS-408 will expose the approved world-event API and call the existing bounded `applyFuelShock` seam at tick boundaries. CPI uses the tariff history in the later full-indicator ticket; WS-406 does not add the WS-408 injection endpoint or the Phase 7 CPI surface early.
