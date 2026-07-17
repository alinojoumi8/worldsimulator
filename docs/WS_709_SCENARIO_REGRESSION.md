# WS-709 Scenario Regression Envelopes

WS-709 makes the default Riverbend outcome range an executable, versioned contract. The authoritative command is:

```bash
pnpm test:scenario
```

It runs both the pure envelope evaluator and the persistence-backed 360-tick scenario. The contract identity is `riverbend-100@1`, seed `42`, LLM mode `mock`, through tick `360`. Envelope version 1 has canonical SHA-256 hash `6ff43f24451ade3b219a9dca1fc8a19d52f53b984125003b51da04eadb2db857`.

## Enforced envelope

| Measure | INITIAL_WORLD §9 contract | Measured baseline |
|---|---:|---:|
| Unemployment | 300–1200 bp at every tick | 390–649 bp across 361 points |
| CPI | 950–1200 at every tick | 995–1193 across 361 points |
| New companies | 1–4 | 3 active companies |
| Business failures | 0–3 | 0 |
| Loan defaults | 0–4 | 0 |
| Treasury balance | Never negative | Minimum 18,000,000 cents |
| Benefit suspension | At most 30 ticks | 0 ticks |
| M1 attribution | 100% explained | 10,000 bp; zero unexplained delta |

The evaluator rejects the wrong world spec, seed, provider mode, or terminal tick. It also requires exactly one point for each of unemployment, CPI, and treasury at every tick from 0 through 360; unique sorted outcome evidence; a complete M1 audit; and zero gross or net unexplained M1 change. Inputs are canonicalized before hashing so database row order cannot change the result.

Envelope v2 is the first V1 baseline. WS-801 adds two required tick-0 authoritative VC genesis facts to the gapless journal. That intentionally advances subsequent causal event identities and therefore changes deterministic mock choices without changing replay correctness. The measured path peaks at CPI 1193, so the upper bound moved narrowly to 1200; all accounting, M1, replay, company, credit, and outcome assertions remain unchanged.

## Authoritative evidence path

`readRiverbendBaselineObservation` reads the simulation scenario and run manifest, authoritative indicator rows, company outcomes, loan defaults, benefit-suspension events, and the same ledger evidence used by the WS-508 M1 auditor. `evaluateRiverbendBaseline` returns a typed report containing the envelope hash, observation hash, metrics, and exact violations.

The integration gate additionally requires:

- three goal-caused `company.formation.requested` events and three `company.activated` events;
- one `company.formation.deferred` event for the unfunded founder;
- zero finance reconciliation differences;
- every active INV-1–10 check to pass;
- periodic snapshots at ticks 120, 240, and 360; and
- a canonical terminal logical state hash.

## Rule defects repaired by the baseline

The first diagnostic run had four achieved `start_business` goals but no new company rows. Achieved founder goals now deterministically request an incorporation, emit goal-linked formation evidence, collect all signatures, and enter the existing registration/capital/activation lifecycle. Three founders have the required capital; the fourth records one bounded insufficient-funds deferral.

The first complete invariant pass also found a journalist with four decision-linked actions at tick 331 and stale authorization logic for Tier-2 goal choices. The decision engine now accepts action slots consumed or reserved by other phases. The persistence-backed agent phase counts prior Tier-2 actions and reserves planned newsroom work before rule decisions, keeping the global cap at three. The invariant adapter recognizes the exact actor-identity fields for every engine-validated Tier-2 action type.

## Calibration protocol

Envelope failures are never fixed by silently widening a range.

1. Re-run the exact seed-42/mock/tick-360 contract and preserve the typed violation and evidence IDs.
2. Classify the change as a rule defect, an evidence/probe defect, or an intentional world-model recalibration.
3. Fix rule or probe defects while retaining the current envelope and rerun focused tests.
4. For an intentional model change, update `INITIAL_WORLD.md`, increment the world-spec or envelope version, record the rationale, and regenerate the canonical envelope hash.
5. Re-run typecheck, lint, the full Vitest suite, build, deterministic replay, and snapshot restore equivalence before accepting the new baseline.

This protocol keeps broad believability bands separate from exact deterministic regression evidence: the contract accepts the documented range, while the integration fixture also records the current seed-42 outcome so accidental drift is visible.
