# WS-408: Approved World-Event Injection

WS-408 implements the version-1 M19 world-event catalog. An admin may submit only a schema-bound event while a run is `created` or `paused`. The accepted command and `world.event.injected` fact are appended first, then a durable scheduler task applies the effect at the requested future tick. Omitting `scheduleTick` selects the next tick.

## Approved catalog

| Type | Parameters | Bounds | Owning effect |
|---|---|---|---|
| `energy.fuel_price_shock` | `deltaPct` | -99% through +1000% | M17 changes fuel price; the existing 60% pass-through changes tariffs at the next billing boundary |
| `row.reference_price_shift` | `sku`, `deltaPct` | -90% through +500% | M12 appends a ROW price; grocery reference changes alter household food requirements |
| `market.demand_shock` | `sku`, `deltaPct`, `durationTicks` | -90% through +500%; 1–360 ticks | M06/M12 applies a temporary demand multiplier, clamped to 10%–500% across overlaps |
| `business.disaster` | `companyId`, `capacityReductionPct`, `durationTicks` | 1%–100%; 1–360 ticks | M08 temporarily reduces production capacity; overlapping reductions cannot make capacity negative |

Unknown types, extra properties, missing targets, out-of-range values, a nonfuture schedule, and schedules beyond the run end are rejected before any journal or state write. External tools, accounts, connectors, free-form functions, and arbitrary effect payloads are not part of this catalog.

## Tick-boundary and causality contract

The API transaction performs the following atomic sequence:

1. Validate lifecycle, catalog parameters, target entities, and schedule.
2. Append `admin.command.received`.
3. Append `world.event.injected`, caused by that command.
4. Persist the scheduled `WorldEvent` and `world.event.apply` task.
5. Persist the advanced ID checkpoint.

At the scheduled obligations boundary, the M01 scheduler claims the task before other obligations. M19 emits `world.event.applied`, caused by the injection, then delegates to exactly one owning handler. The handler's effect event is caused by `world.event.applied`. A handler error rolls back the task claim, effect records, WorldEvent transition, emitted events, tick, and checkpoint together.

The four effect events are `energy.fuel_price.changed`, `market.row_reference_price.changed`, `market.demand.changed`, and `company.capacity.disrupted`. The applied WorldEvent stores both its application event and effect event IDs, preserving a complete command → injection → application → domain-effect chain.

## Persistence and deterministic propagation

Migration v11 adds `world_events`, `row_reference_price_history`, `market_demand_shocks`, and `company_capacity_disasters`. WorldEvents permit one transition from `scheduled` to `applied` or `cancelled`; effect tables are append-only. All four tables and the scheduler state are included in logical state-hash v9 and SQLite snapshots.

ROW prices use half-even integer-cent changes. Demand multipliers combine by integer basis points inside a 1,000–50,000 bp envelope. Capacity reductions combine inside 0–10,000 bp and integer production floors the resulting capacity. Ambient time, randomness, floating money, and locale ordering are not used.

The propagation integration proves that a +30% fuel event raises fuel from 100 to 130 cents, the existing rule raises household and business tariffs 18% at tick 30, and the higher business tariff raises the next firm's recorded unit cost. It also proves that ROW and demand shocks reach household purchase evidence and that a 50% disaster halves the target firm's capacity for its exact duration. Full CPI publication remains owned by WS-704; WS-408 supplies its authoritative tariff and reference-price inputs.

## Verification

Coverage includes:

- strict catalog and parameter validation, including arbitrary-tool rejection;
- real HTTP injection, journal ordering, running-state rejection, scheduled application, causality, and reopen;
- all four effect handlers in one deterministic boundary;
- overlapping multiplier bounds and exact integer rule tests;
- household demand/ROW-price, energy tariff, firm-cost, and production-capacity propagation;
- injected apply failure with task/effect rollback;
- immutable effect history across reopen; and
- scheduled-event snapshot restore followed by identical next-boundary state hashes.

The completed ticket gate passes strict type-checking, linting, all 68 test files
(378 tests), and the production web build.
