# Phase 4 Foundations: Contracts, Companies, Labor, and Markets

WS-401 through WS-409 complete the authoritative legal, organizational, labor, production, inventory, posted-price market, dynamic-pricing, energy, insolvency, bounded world-event, API, and World Explorer layers. All runtime transitions execute inside the existing tick unit of work, so state and their emitted events commit or roll back together; WS-409 reads those committed records without changing authoritative state.

## Legal contracts (WS-401)

The shared contract model supports four discriminated templates: incorporation, employment, service, and lease. Money remains decimal integer cents and all tick fields are safe nonnegative integers.

The only valid lifecycle is:

```text
draft -> signed -> active -> completed | terminated | breached
```

- Only listed parties may sign, and every party must sign before the contract becomes `signed`.
- Activation requires both all-party signatures and the configured effective tick.
- Incorporation and service templates create one-time payment obligations. Leases create 30-tick recurring rent obligations that stop at their end tick. Employment terms carry the job, employer, employee, wage, start tick, and notice period.
- Due obligations fire deterministically by due tick and ID. A fired one-time obligation that remains incomplete into a later tick satisfies the persisted overdue breach predicate.
- Contract state, parties, obligations, executions, breaches, and timeline entries are included in the v6 logical state hash and snapshot restore-equivalence gate.

## Company formation (WS-402)

A formation request validates the founder, normalized unique company name, positive capital/equity values, incorporation fee, founder funds, and the law-firm destination account. It creates a `forming` company and draft incorporation contract. After all parties sign, the tick phases advance at most one formation stage per day:

1. Activate the incorporation contract, fire its fee obligation, transfer the fee through the double-entry ledger, and complete the obligation.
2. Register the company.
3. Open its business checking account.
4. Transfer founder capital into the business account.
5. Issue the exact founder share total and activate the company.

Hiring and trading are rejected until `active`; job posting is delayed until the tick after activation. Fee and capital transactions are caused by `company.incorporation_fee.requested` and `company.capital.deposit.requested` events respectively, and each `transaction.posted` event preserves that causal link.

## Labor matching (WS-403)

Only active companies may post jobs, and the default minimum annual wage is 3,000,000 cents. An application is eligible when the agent is not already employed, the offered wage meets the reservation wage, and every weighted skill minimum is satisfied.

The Tier-1 score is deterministic:

```text
score = weighted_skill_total * 10,000
      + clamp(wage_premium_basis_points, 0, 100,000)
```

Candidates sort by score descending and then by code-unit `agentId` ascending. This intentionally avoids locale-dependent ordering. A selected application creates both the authoritative employment row and an already fully signed/active legal employment contract; remaining applicants are declined when the posting fills.

Employees may request a quit and the employer may request a layoff. Authority is checked at request time, and both paths become effective only after the stored notice days. The effective tick ends employment, updates the agent, terminates the linked legal contract, and emits `employment.terminated` with the reason and notice timeline.

## Production, inventory, and sales (WS-404)

The market catalog has seven stable SKUs: groceries, meals, durable goods, repair services, healthcare visits, tuition, and electricity. Each catalog row declares whether the product is inventoried, its basket category and weight, unit, ROW reference price, and ruleset version. WS-404 activates company offerings and production only for inventoried goods; later tasks own service delivery and electricity billing.

An active company may configure one production profile and offering for a SKU. On each production tick, active employees provide labor and output is calculated entirely with safe integers:

```text
labor_bound = floor(worker_count * hours_per_worker * productivity_milliunits_per_hour / 1,000)
units_produced = min(labor_bound, capacity_units_per_tick)
```

Production creates an immutable run and inventory movement, increments stock, and updates the moving-average unit cost using half-even integer rounding. Database constraints and engine rules reject negative inventory, overselling, unsafe quantities, and duplicate company/SKU production in the same tick.

Orders are immediate fill-or-reject. Placement validates the active offering, seller, SKU, expected posted price, quantity, buyer identity, and ownership of every proposed payment account. Settlement repeats the price, funds, ownership, and inventory checks inside one database transaction. A fill posts a balanced `purchase` journal entry, decrements inventory, records an immutable sale movement, and emits its causal events. Any failure—including an injected error after the ledger write—rolls the complete order, journal, inventory, and event change back.

Households allocate food before discretionary demand. Grocery requests visit active offerings by posted price and then code-unit offering ID. Available local stock is bought from real companies; an unavailable quantity creates a rejected order plus durable stockout, and any remaining approved food budget uses the explicit ROW settlement path. This preserves the existing empty-market world while making local sellers authoritative whenever they exist.

## Weekly pricing and founder overrides (WS-405)

Each active offering is reviewed every seven ticks relative to its creation tick. The review uses inventory at the end of settlement plus sales and unfilled stockout units from `(tick - 7, tick]`. All calculations use safe integers:

| Signal | Rule |
|---|---|
| any unfilled stockout units | raise 5% |
| inventory / sales below 0.5 | raise 5% |
| inventory / sales from 0.5 through 2.0 | hold |
| inventory / sales above 2.0 | lower 5% |
| inventory with zero sales | lower 5% |
| zero inventory and zero sales | hold |

Stockouts take precedence over the ratio so shortages feed the rule directly. Five-percent steps use half-even cent rounding. The final price is always clamped to `[unit cost, floor(unit cost × 1.5)]`; the current moving-average inventory cost is used when available and the production-profile cost is the pre-production fallback. This same envelope applies when an offering is created and when a founder overrides it.

A founder override requires an active offering, the company's actual founder, and a persisted same-tick Tier-1 or Tier-2 decision owned by that founder. Accepting both tiers keeps the rule-tier WS-405 seam compatible with the later live Tier-2 decision path. A no-op price emits nothing. Every actual rule or decision change atomically updates the offering, appends immutable price history, and emits `market.price.updated` with old price, new price, cost/ratio evidence, and cause `rule` or `decision:{id}`.

## Persistence and phase ordering

Migrations `phase_4_legal_companies_labor`, `phase_4_production_inventory_market`, `phase_4_market_pricing`, `phase_4_energy_tariffs_billing`, `phase_4_insolvency_wind_down`, and `phase_4_world_event_injection` add the legal, company, labor, market, energy, solvency, creditor, salvage, wind-down, WorldEvent, ROW-price, demand, and capacity-disaster records with run-scoped keys, constraints, indexes, and immutable-history triggers. Runtime handlers are registered as:

| Phase | Module | Order | Responsibility |
|---|---|---:|---|
| obligations | `M01-scheduler` / `M19-world-events` | 0 / task -100 | claim due tasks and apply approved effects before other obligations |
| obligations | `M11-legal-contracts` | 25 | activate contracts, fire/breach obligations, apply due terminations |
| execute | `M08-company-formation` | 25 | advance one formation stage |
| execute | `M08-production-inventory` | 50 | produce capacity-bounded units and update inventory |
| clearing | `M07-labor-matching` | 25 | rank applications and create employment |
| settlement | `M06-household-market-settlement` | 50 | buy local groceries, record stockouts, settle the ROW remainder |
| settlement | `M08-weekly-pricing` | 75 | review the completed sales window and update bounded prices |
| metrics | `M08-insolvency-wind-down` | 25 | persist daily solvency and atomically liquidate threshold failures |

## Verification

`pnpm test:phase4` runs a 360-tick production-service release gate. It reopens a real Riverbend world, activates a durable producer and an intentionally undercapitalized employer, matches labor, configures grocery production, injects an approved +100% fuel shock at tick 8, and verifies:

- the surviving company, job, employment, and linked legal contract are authoritative;
- the fragile employer fails only after 30 consecutive shortfall assessments, terminates employment, closes relationships and accounts, and exposes its complete why-panel;
- production runs, filled orders, nonnegative inventory, and stockouts are authoritative;
- every filled order has one balanced purchase transaction and matching negative sale movement;
- weekly price changes follow the offering cadence, remain inside cost bounds, and link to committed `market.price.updated` events;
- all contract parties signed;
- every ledger transaction has a real committed source event;
- the fuel shock is applied at its scheduled boundary, raises the tick-30 tariffs, and reaches household/business bills and firm production costs;
- contract-valid company/job views expose activation, hiring, production, pricing, insolvency, termination, and failure evidence to the API and UI;
- account caches reconcile and all active invariants pass; and
- periodic snapshots exist at ticks 120, 240, and 360.

Unit and integration tests separately cover every legal transition/template, obligation behavior, formation gate/stage, deterministic ranking, minimum-wage/eligibility rule, quit/layoff/failure termination, notice timing, production/inventory properties, buyer validation, stockout paths, settlement rollback after an injected ledger write, pricing and energy pass-through goldens/properties, exact integer bounds, founder authority and decision provenance, balanced utility/ROW/salvage postings, strict creditor seniority, exact recovery/write-off allocation, billing and wind-down rollback/reopen, the strict four-event catalog, API journaling and causality, bounded propagation and effect rollback, v9 hashes, and market/price/energy/insolvency/world-event snapshot restore equivalence through the next deterministic action.

WS-406 adds the M17 energy slice described in [WS_406_ENERGY.md](./WS_406_ENERGY.md). WS-407 adds the complete M08 terminal lifecycle described in [WS_407_INSOLVENCY.md](./WS_407_INSOLVENCY.md). WS-408 adds the bounded M19 injection system described in [WS_408_WORLD_EVENTS.md](./WS_408_WORLD_EVENTS.md). WS-409 completes the public read and UI layer described in [WS_409_WORLD_EXPLORER.md](./WS_409_WORLD_EXPLORER.md).
