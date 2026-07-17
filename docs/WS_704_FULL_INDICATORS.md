# WS-704 full economic indicator set

WS-704 completes FR-OBS-2 with ten deterministic, persisted series. Every
series is computed from authoritative ordered rows at genesis and at each
metrics phase. Values are integers, money is integer cent strings, and every
division uses `HALF_EVEN` rounding.

## Series and formulas

| API name | Persisted key | Unit | Version 1 definition |
|---|---|---|---|
| `gdpProxy` | `gdp_proxy_cents` | cents | Sum of final domestic expenditure during the inclusive trailing 30 ticks: filled goods orders bought by agents/households plus paid household energy bills. Business intermediate purchases and ROW flows are excluded. Tick 0 is zero. |
| `cpi` | `cpi_index` | index | Fixed base-period expenditure basket, base 1000. Immutable catalog weights total exactly 10,000 basis points. |
| `m1` | `m1_cents` | cents | Sum of agent and company checking-account balances. |
| `averageWage` | `average_wage_cents` | cents | `HALF_EVEN` mean annual wage across active employment contracts; zero when none are active. |
| `unemploymentRate` | `unemployment_rate_bp` | bp | Unemployed agents divided by employed plus unemployed agents, scaled by 10,000. |
| `creditOutstanding` | `credit_outstanding_cents` | cents | Sum of stored outstanding principal for opening and originated loans, including legally unresolved defaulted obligations. |
| `defaultRate` | `default_rate_bp` | bp | Recorded loan defaults divided by all opening and originated loans, scaled by 10,000. |
| `businessCount` | `active_business_count` | count | Unique owners of active company checking accounts. This includes seeded employers and later formed companies and excludes wound-down owners after account closure. |
| `treasuryBalance` | `treasury_balance_cents` | cents | Riverbend town treasury checking balance. |
| `sentimentIndex` | `sentiment_index_bp` | bp | `HALF_EVEN` mean of the effective, lazily decayed economy, employment, and institutions sentiment values on the `-10,000..10,000` scale. |

The CPI formula is:

```text
CPI(t) = HALF_EVEN(1000 / 10000 * sum_i(weightBp_i * price_i(t) / price_i(0)))
```

The implementation combines the price relatives as one exact rational using a
common denominator and rounds only the final index. Base prices and weights
come from the immutable tick-0 product catalog. Current electricity uses the
latest effective household tariff. Other products use the `HALF_EVEN` mean of
active local posted prices; when no local offering exists they use the latest
effective ROW reference price, then the tick-0 reference price. An 18% power
tariff increase therefore adds exactly 36 index points at the fixed 20%
electricity weight.

## Evidence, persistence, and replay

Ruleset version 1 writes exactly one row per series and tick. Each immutable
`indicator_points` row stores `formula_version=1` and a lowercase SHA-256
`inputs_digest` over the indicator key, version, tick, and its canonically
ordered authoritative inputs. `economic.metrics.updated` carries the same ten
values, ruleset version, and per-series digest map, so explanations can join an
event to the exact aggregate boundary without copying every source row into the
journal. `simulation.tick.completed` carries the ten friendly-name values in
its committed digest.

Migration 28 transactionally expands the indicator catalog and adds the
formula/evidence columns while retaining update/delete guards. Rows created by
older binaries remain explicitly marked as legacy (`formula_version=0` and the
all-zero digest); they are not presented as freshly recomputed evidence.
Logical state-hash version 22 includes the ten values, formula versions, and
input digests. Snapshot tests compare all indicator rows after restore and
recompute the identical logical hash.

## API and dashboard

`GET /api/v1/simulations/{simulationId}/indicators` accepts any subset of the
ten names. Cent values remain strings; basis-point, index, and count values are
safe JSON integers. The dashboard requests the complete bounded history and
groups it into Macro, Finance, Employment, and Business panels.

Formula goldens cover unequal base prices, the energy-shock response,
`HALF_EVEN` boundaries, malformed input, the Riverbend genesis values, and the
30-tick authoritative integration path. Migration, immutability, atomic
rollback, event evidence, API contract, UI formatting, state hash, reopen, and
snapshot restore are also covered.
