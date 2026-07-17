# WS-409: Phase 4 API and World Explorer

WS-409 makes the complete Phase 4 lifecycle explorable without introducing another authoritative store. Every response is derived from committed simulation records, validated by a shared Zod contract, bound to one run, and safe to reconstruct after reopen or snapshot restore.

## Public read surface

All routes are under `/api/v1/simulations/{simId}` and accept an optional `runId`. Collection cursors are opaque and encode the run, view, ordering key, and entity ID so they cannot be reused across runs or resource types.

| Route | Main evidence |
|---|---|
| `GET /companies` | status, sector, employee count, cash, trailing 30-tick profit, shortfall streak |
| `GET /companies/{companyId}` | founder, cap table, staff, offerings, jobs, financials, solvency, wind-down, causal timeline |
| `GET /contracts` and `/{contractId}` | typed legal terms, named parties, signatures, state timeline |
| `GET /jobs` and `/{jobId}` | wage, openings, applications, deterministic selection, linked employment contracts |
| `GET /institutions` and `/{institutionId}` | the eight Riverbend institutions, officeholders, public rulebooks, key figures |
| `GET /markets/goods` | seven-SKU catalog, ROW references, demand multipliers, live offerings, costs, stock and recent price changes |

The existing agent directory, profile, and finance routes supply the citizen side of the same story. No route synthesizes missing money or employment data.

## Company why-panel

Company detail is intentionally sufficient for a complete explanation in one request:

- `financials` computes cash and trailing revenue, cost, and profit from authoritative accounts and ledger entries;
- `solvency` stores the exact cash, 30-tick obligation, shortfall, streak, rule version evidence event, and terminal result;
- `windDown` exposes liquidation cash, salvage, creditor recovery, write-offs, relationship cleanup counts, and its source event;
- `timeline` condenses formation stages, employment starts/ends, first/latest production, price changes, solvency, and failure while retaining event/reference IDs.

This is a read projection only. A projection call leaves the v9 logical state hash unchanged and returns the same result after closing and reopening the database.

## React routes

The cockpit links to `/simulations/{simId}/world`. The World Explorer provides sections for companies, jobs, contracts, institutions, the goods market, and citizens. Entity links open focused detail pages:

- `/simulations/{simId}/companies/{companyId}`
- `/simulations/{simId}/contracts/{contractId}`
- `/simulations/{simId}/jobs/{jobId}`
- `/simulations/{simId}/institutions/{institutionId}`
- `/simulations/{simId}/agents/{agentId}`

Money is formatted from integer-cent strings without conversion through floating-point arithmetic. Loading, empty, and error states remain explicit, and event/reference IDs stay visible as evidence rather than being replaced by generated prose.

## Acceptance evidence

The WS-409 HTTP integration test creates a real company, advances formation, hires a worker, produces and sells groceries, and contract-parses every public Phase 4 resource plus citizen employment and finances. Projection tests prove deterministic reopen behavior and a stable state hash. Component tests cover navigation, timeline evidence, money formatting, and citizen finance/employment rendering.

`pnpm test:phase4` is the phase gate. Its 360-tick scenario contains a surviving producer, real energy billing, an approved tick-8 fuel shock, and a second company that winds down after exactly 30 shortfall days. The API-facing projections explain both outcomes, snapshots exist at ticks 120/240/360, ledger reconciliation succeeds, and every active invariant passes.
