# WS-407 Insolvency and Wind-down

WS-407 completes the deterministic company lifecycle required by FR-CO-4. An active company is assessed once per tick after settlement. The assessment compares all active company checking-account cash with obligations due inside the next 30 ticks:

- the next exact semi-monthly gross payroll amount for every active employee;
- unresolved registered creditor claims;
- rejected business-energy bills; and
- active legal payment obligations due within the horizon.

A shortfall is `max(0, obligations - cash)`. The streak resets to zero on any fully funded day. Thirty consecutive shortfall days trigger insolvency. Every assessment is immutable, versioned, hashed, and linked to `company.solvency.assessed`; the threshold crossing emits `company.insolvency.detected`.

## Atomic wind-down order

The threshold-crossing tick executes one atomic workflow:

1. Change the company to `insolvent`, then `winding_down`, with timeline and causal events.
2. End all active employment immediately with reason `company_failure`, set affected agents to unemployed, withdraw open jobs, decline pending applications, waive unfired obligations, and terminate employment plus incorporation/company contracts.
3. Deactivate every market offering.
4. Sell all inventoried goods to ROW at 50% of the immutable ROW reference price. The price uses integer-cent FLOOR rounding, every SKU has its own balanced `row_settlement`, and immutable salvage evidence sets inventory to zero.
5. Register employee, energy, legal, and pre-existing claims, then pay them by seniority: employee wages, secured debt, tax, trade debt, unsecured debt. Ties break by registration tick and raw code-unit claim ID.
6. Record every partial or zero recovery as an immutable write-off. If all liabilities are paid, a final equity-residual tier transfers the remaining cents to the founder.
7. Assert the complete pool was allocated, close every zero-balance company account, set the company terminal status to `closed`, and emit `company.failed` with the full cause chain and recovery detail.

The residual tier means `sum(creditorRecoveries) == opening cash + salvage proceeds` for every liquidation, including a solvent surplus after salvage. Unrecovered claim principal is separately exact: `recovery + write-off == claim amount`.

## Persistence and replay

Migration v10 adds immutable solvency assessments, creditor claims, recoveries, write-offs, inventory salvages, and wind-down summaries. Logical state hash v8 covers all of them. The production invariant probe treats a terminal failed company with employment, live contracts, open jobs, active offerings, inventory, live accounts, cash, or unresolved claims as an INV-5 violation.

Tests cover the 29/30-day boundary, reset behavior, deterministic tie-breaking, recovery conservation, complete relationship cleanup, ROW salvage accounting, partial creditor recovery, injected rollback before account closure, database reopen, and snapshot restore followed by byte-equivalent next-day liquidation.
