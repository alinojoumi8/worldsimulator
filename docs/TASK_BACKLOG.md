# WorldTangle — Engineering Task Backlog

Derived from [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) phases. Task ID scheme: `WS-<phase><nn>` (WS-3xx = Phase 3; WS-10xx = Phase 10).

**Format:** each task lists module · label (`backend|frontend|infra|docs`) · complexity (`S|M|L`) · dependencies · **Ind?** = implementable as an isolated PR. **Do** = description; **Accept** = acceptance criteria; **Tests** = suggested tests. Definition of done for every task additionally includes: invariant suite green, determinism gate green, docs updated.

---

## Phase 0 — Foundation (this session's deliverable)

### WS-001 — Monorepo scaffold
`infra` · `S` · deps: — · Ind? yes
**Do:** pnpm workspace (packages/shared, packages/engine, apps/server), strict tsconfig, vitest, eslint with engine determinism bans, `.gitattributes` (LF), `.gitignore`, CI workflow (win+linux). **Accept:** `pnpm install && pnpm test && pnpm typecheck` green on clean checkout. **Tests:** CI itself.

### WS-002 — Money primitives ✅
`shared` · `backend` · `M` · deps: WS-001 · Ind? yes
**Status:** implemented. `Money` is a branded bigint-cent type with explicit construction, branded `add`/`sub`/`mulDiv`/`allocate` results, bigint-only rate math, and compile-time rejection coverage for raw bigint and number inputs.
**Do:** branded `Money` (bigint cents), `add/sub`, `mulDiv(mode)`, `allocate` (largest remainder), bp rate helpers per ADR-0013. **Accept:** API exactly as ADR-0013; no `number` money paths compile. **Tests:** fast-check: allocation sums exactly, mulDiv rounding modes, add/sub identities.

### WS-003 — Seeded RNG streams ✅
`shared` · `backend` · `S` · deps: WS-001 · Ind? yes
**Status:** implemented. Seeded sfc32 streams support stable forks, exact serialization/restore, unbiased integer draws, deterministic floats, picks, and shuffles with direct and property coverage.
**Do:** sfc32 PRNG, `fork(streamKey)` via string hash, serializable state, int/float/pick/shuffle helpers. **Accept:** same seed → same sequences; forked streams independent (adding draws to one doesn't shift another). **Tests:** determinism + independence + serialization round-trip.

### WS-004 — Canonical codec & ID factory ✅
`shared` · `backend` · `M` · deps: WS-001 · Ind? yes
**Status:** implemented. Canonical sorted-key serialization, bigint round-tripping, pure SHA-256 hashing, and serializable typed-prefix monotonic IDs are covered by golden, invariance, and restore tests.
**Do:** canonical JSON (sorted keys, bigint↔string, LF), sha-256 hashing, typed-prefix monotonic ID factory per ADR-0008. **Accept:** stable hashes across OSes; codec is the only serializer used for hashing. **Tests:** golden hashes, bigint round-trip, key-order invariance.

### WS-005 — Envelopes, run manifest, error taxonomy ✅
`shared` · `backend` · `M` · deps: WS-004 · Ind? yes
**Status:** implemented. Zod remains the source of truth for event/intent envelopes, run manifests, and engine error codes; named Draft 2020-12 documents and a versioned `coreJsonSchemaBundle` are exported with a canonical stability hash.
**Do:** Zod schemas: EventEnvelope, IntentEnvelope, RunManifest, EngineError codes (IMPLEMENTATION_PLAN §4). **Accept:** schemas validate API_CONTRACTS §4.1 examples; exported JSON Schema stable. **Tests:** schema acceptance/rejection fixtures.

### WS-006 — Engine kernel: bus, event log, clock skeleton, mock LLM ✅
`engine` · `backend` · `M` · deps: WS-003..005 · Ind? yes
**Status:** implemented. The synchronous FIFO bus, validated in-memory event log, fixed-order tick loop, named RNG streams, and deterministic mock LLM provider satisfy the cross-run determinism gate.
**Do:** synchronous FIFO event bus (ordered handlers), EventLog interface + in-memory impl, tick loop skeleton with ordered Phase registry, `LlmProvider` interface + MockLlmProvider (scripted + hash-choice). **Accept:** demo sim of empty ticks runs; determinism gate (2 runs → identical log hashes) passes. **Tests:** bus ordering, log append-only, mock determinism, double-run gate.

### WS-007 — Server skeleton
`server` · `backend` · `S` · deps: WS-005 · Ind? yes
**Do:** Fastify app factory, `/api/v1/health`, `/api/v1/version`, 127.0.0.1 binding, problem+json error hook. **Accept:** health returns contract shape incl. `simulated:true`. **Tests:** `fastify.inject` health + error shape.

---

## Phase 1 — Persistence, clock, event log, lifecycle

### WS-101 — SQLite storage + migrations
`M20` · `backend` · `M` · deps: WS-006 · Ind? yes
**Do:** better-sqlite3 wiring (WAL, `defaultSafeIntegers`), migration runner, data-dir layout `data/<simId>/<runId>/world.db`. **Accept:** migrations idempotent up from empty; bigint round-trips. **Tests:** migration cycle, bigint storage, WAL mode assertion.

### WS-102 — Event store (durable)
`M20` · `backend` · `M` · deps: WS-101 · Ind? yes
**Do:** append-only event table `(runId, seq)` unique, gapless seq allocation, batch append, cursor reads, type/tick/correlation indexes. **Accept:** UPDATE/DELETE rejected at store layer; 10k-event batch append <100ms. **Tests:** append-only enforcement, gaplessness, cursor pagination determinism.

### WS-103 — commitTick transaction boundary ✅
`M20` · `backend` · `M` · deps: WS-102 · Ind? no (pairs w/ WS-104)
**Status:** implemented. **Do:** `TickUnitOfWork` spans all phases, scheduled effects, staged events, and checkpoint persistence in one root `BEGIN IMMEDIATE`; persisted loops require the port. **Accept:** any failure leaves the durable store and in-memory tick/sequence/ID state at the previous checkpoint. **Tests:** failures in a task, later phase, and after event insertion; gapless retry; reopen/hash equivalence.

### WS-104 — Run state machine & manifest
`M01` · `backend` · `M` · deps: WS-103 · Ind? no
**Do:** SimulationRun lifecycle (created/running/paused/…), write-once manifest, tick counter persistence, `advance(n)`. **Accept:** illegal transitions rejected (CONFLICT); manifest immutable. **Tests:** transition table, manifest write-once, resume-at-tick.

### WS-105 — Scheduler ✅
`M01` · `backend` · `M` · deps: WS-104 · Ind? yes
**Status:** implemented. **Do:** persisted queue ordered by `(dueTick, order, id)`; `M01-scheduler` obligations handler at order 0; explicit task dispatcher; calendar math (360-day, D15/D30 helpers). **Accept:** tasks fire exactly once; unknown/throwing handlers roll back and leave the task pending. **Tests:** queue properties, calendar goldens, persistence, atomic effect/event rollback, and real service advance.

### WS-106 — Snapshots & stateHash ✅
`M20` · `backend` · `M` · deps: WS-103 · Ind? yes
**Status:** implemented. Periodic post-commit backup scheduling (default every 100 ticks), canonical logical state hashes, paired `simulation.statehash.computed`/`simulation.snapshot.created` events, crash-window repair, and exact restore/resume checkpoints are wired through manual, continuous, and durable async advances.
**Do:** SQLite backup-API snapshots every N ticks, logical stateHash (canonical codec) + `simulation.statehash.computed` events; restore. **Accept:** restore(snapshot) then advance == straight-through run (hash-equal). **Tests:** snapshot/restore equality, atomic write (temp+rename) crash test.

### WS-107 — Admin command journal
`M01/M24` · `backend` · `S` · deps: WS-104 · Ind? yes
**Do:** every control mutation journals `admin.command.received` before effect. **Accept:** replayed journal reproduces control timing. **Tests:** journal-before-effect ordering.

### WS-108 — Lifecycle + status + events API
`M22` · `backend` · `M` · deps: WS-104, WS-107 · Ind? no
**Do:** POST /simulations, controls, advance, status, GET /events with filters/cursors per API_CONTRACTS. **Accept:** contract tests pass; 409s on illegal transitions. **Tests:** inject tests per endpoint incl. pagination determinism.

### WS-109 — SSE stream v0 ✅
`M22` · `backend` · `M` · deps: WS-108 · Ind? yes
**Status:** implemented. **Do:** committed-row `/stream` with digest/lifecycle/gap schemas, `Last-Event-ID` resume, heartbeat, backlog limit, and clean shutdown; authenticated browser fetch-stream with bounded retry. **Accept:** reconnect resumes from seq, 401 suspends, and a lagging client refreshes durable REST state after a gap. **Tests:** server stream integration plus parser/header/contract client tests.

### WS-110 — Structured logging & correlation ✅
`M25` · `backend` · `S` · deps: WS-101 · Ind? yes
**Status:** implemented. Success, rejection, asynchronous-task, restart-recovery, and automatic-worker failure paths emit structured Pino events with run/tick/correlation context. An unhandled tick error rolls back to the last checkpoint, pauses the run, and records `system.error.raised`; kill-mid-tick and restart recovery gates cover the lifecycle behavior.
**Do:** pino with runId/tick/correlationId bindings; per-phase timing metrics. **Accept:** every engine log line carries context; timings recorded per tick. **Tests:** log-shape unit tests.

---

## Phase 2 — Agent framework (rule-tier only)

### WS-201 — Persona/occupation/skill schemas + catalogs ✅
`M02` · `backend` · `M` · deps: WS-005 · Ind? yes
**Status:** implemented. Strict agent/persona/household/goal/relationship schemas, all 14 skills, a 40-occupation role-complete catalog, deterministic ID contracts, and curated synthetic name inputs with public-figure blocklist enforcement are covered by schema and catalog tests.
**Do:** entity schemas per DOMAIN_MODEL §3.2, occupation/skill catalogs, synthetic name lists + blocklist. **Accept:** catalogs cover INITIAL_WORLD §5.3 roles. **Tests:** schema fixtures, blocklist hit rejection.

### WS-202 — World generator ✅
`M02` · `backend` · `L` · deps: WS-201, WS-105 · Ind? no
**Status:** implemented. `riverbend-100@1` now generates the exact roster through named RNG streams, constraint-adjusted personas and incomes, exact households, balanced opening mints, consistent seeded credit, a connected bounded social graph, storyline goals, a versioned spec/population hash, and an all-or-nothing validation report. Same run/seed output is canonical byte-identical; multi-seed envelope tests cover all hard gates.
**Do:** the 10-step pipeline of INITIAL_WORLD §6 (roster→personas→households→finances→credit→graph→goals→constraint pass→validation→genReport). **Accept:** INITIAL_WORLD §7 gate all-or-nothing; same seed → byte-identical population. **Tests:** determinism compare, envelope tests (age/education/wage/Gini/graph), storyline-seed presence.

### WS-203 — Memory store & retrieval ✅
`M03` · `backend` · `M` · deps: WS-201 · Ind? yes
**Status:** implemented. Memories are immutable append-only records; compaction membership is a separate append-only relation. Integer recency × importance × relevance scoring, stable tie-breaks, bounded top-k retrieval, and deterministic template compaction preserve source IDs and event references. The production decision phase retrieves active memories into observations and records outcome memories; in-memory and SQLite cap/reopen tests cover the contract.
**Do:** append-only memories, rule salience scoring, top-k retrieval, template compaction with caps. **Accept:** bounded per-agent size; retrieval deterministic. **Tests:** cap enforcement, retrieval goldens, compaction reference preservation.

### WS-204 — Trigger evaluator ✅
`M04` · `backend` · `M` · deps: WS-202 · Ind? no
**Status:** implemented. All eight Phase 2 trigger kinds have strict payload contracts and deterministic activation, deduplication, priority ordering, known-agent filtering, wake-set hashing, and per-agent caps. Invalid, stale, future, duplicate, unknown-agent, and cap-dropped signals remain explicit; agents absent from the wake set receive no Tier ≥1 decision.
**Do:** per-tick wake-set computation from trigger catalog (schedule, message, stress, news, goal, policy, company, market); per-agent caps. **Accept:** untriggered agents make zero decisions; caps enforced (INV-8). **Tests:** trigger matrix tests, cap tests, determinism.

### WS-205 — Action catalog & registry ✅
`M04` · `backend` · `M` · deps: WS-005 · Ind? yes
**Status:** implemented. The typed registry validates intent envelopes and registered Zod params, invokes a capability hook before domain validation, binds prepared actions to one registry/run/tick context, and permits state mutation only through the executor choke point. Rejections use the engine taxonomy (`NOT_FOUND`, `SCHEMA_INVALID`, `PERMISSION_DENIED`, domain codes), while executor faults become typed failed actions. A 250-run adversarial JSON property suite proves invalid params never reach an executor.
**Do:** `registerActionType(type, schema, validator, executor)`; typed params; capability check hook (INV-10). **Accept:** unknown/invalid/unauthorized intents rejected with taxonomy codes. **Tests:** fuzzing suite over registry (adversarial params).

### WS-206 — Tier 0/1 decision engine ✅
`M04` · `backend` · `L` · deps: WS-204, WS-205 · Ind? no
**Status:** implemented. Scripted Tier 0 routines create actions without Decision rows; every triggered Tier 1 choice records its observation digest, bounded option menu, stable max-utility choice, rule rationale, validation result, and resulting AgentAction. Per-agent decision/action caps, deterministic no-op fallback, fault isolation, taxonomy rejections, tick work counters, and the consecutive-failure quarantine cooldown are enforced. A twice-run 360-tick Riverbend gate produces identical decision/action and event-log hashes with 360 complete Tier 1 records and 1,560 applied actions.
**Do:** scripted routines; utility-rule decision tables per trigger kind; Decision/AgentAction records; quarantine ladder. **Accept:** 360-tick rule-only run completes; every Tier-1 decision has options+rationale recorded. **Tests:** decision-table goldens, quarantine ladder, record completeness.

### WS-207 — Agents API ✅
`M22` · `backend` · `M` · deps: WS-206 · Ind? yes
**Status:** implemented. Creating a simulation now persists the complete Riverbend population by default. Strict shared schemas and Fastify routes serve deterministic agent directory pages with occupation/employment/name-prefix filters, complete profiles with active memory highlights, relationship pages, and descending decision feeds. Opaque cursors are run/agent-bound; real API integration covers all 100 agents, malformed/404 paths, tick-1 decisions, persistence, and reopen equivalence.
**Do:** GET agents (filters/search), agent detail, decisions feed per contracts. **Accept:** contract tests; pagination deterministic. **Tests:** inject + schema validation.

### WS-208 — Goal lifecycle ✅
`M02/M04` · `backend` · `S` · deps: WS-206 · Ind? yes
**Status:** implemented. Dormant goals activate through deterministic catalog rules and active-goal caps; progress, achievement, and abandonment use optimistic persisted transitions and require authoritative events. Each active or newly activated goal emits a bounded goal trigger consumed by the decision phase. Table tests cover event-required transitions, activation ordering, progress, terminal states, and stale-write rejection.
**Do:** goal activation rules, progress tracking, achieved/abandoned transitions with events. **Accept:** activated goal produces trigger; transitions evented. **Tests:** lifecycle table tests.

### WS-209 — Invariant checker harness v1 ✅
`M26` · `backend` · `M` · deps: WS-206 · Ind? yes
**Status:** implemented. The reusable test-only checker reports passed/failed/inactive status for INV-1..10, catches one deliberately seeded violation for every invariant, and never runs in production ticks. The persisted-run probe now activates INV-1..6 and INV-8..10 from authoritative Phase 3 records; only the V1 market invariant INV-7 remains inactive. Both the live day-15 integration and 360-day release gate pass every active check.
**Do:** reusable INV-1..10 suite runnable after any sim test (financial ones activate in P3). **Accept:** seeded violations are caught (meta-test). **Tests:** meta-tests with deliberately broken fixtures.

---

## Phase 3 — Money, employment, households

### WS-301 — Banks & accounts
`M09` · `backend` · `M` · deps: WS-202 · Ind? no
**Status:** implemented. First Ledger Bank and authoritative owner-view accounts are persisted with immutable identity/ownership, account-opening capability checks, registered-owner validation, outbound ownership enforcement on every posting, and explicit floors. INV-3 is active against the live account table.
**Do:** Bank/BankAccount entities, account opening action, ownership enforcement, floors. **Accept:** INV-3; ownership immutable. **Tests:** floor property tests, capability tests.

### WS-302 — Transaction ledger
`M09` · `backend` · `L` · deps: WS-301 · Ind? no
**Status:** implemented. The deterministic multi-leg engine validates equal positive-cent debits/credits, catalog kinds, account permissions/status/floors, authorized mint sources, and per-run idempotency. SQLite transactions/legs are immutable, balances are reconciled from postings, duplicates return an explicit warning, and each committed posting emits `transaction.posted`. INV-1/2 are active.
**Do:** THE double-entry posting engine: multi-leg validation, idempotency keys, kind catalog, `transaction.posted`, balance caches with recheck job. **Accept:** INV-1 & INV-2 property suites green; duplicate keys ignored w/ warning. **Tests:** fast-check op sequences, idempotency, balance-cache reconciliation.

### WS-303 — Opening books mint
`M02/M09` · `backend` · `S` · deps: WS-302 · Ind? no
**Status:** implemented. All generated deposits and the treasury start at zero and receive balanced mint postings; seeded loans have asset/liability recognition links and the six founder cap tables sum exactly. Opening mint debits equal $5.28M of non-internal/non-ROW balances ($5.1M M1 plus $180k treasury), and INV-1..6 pass on the opening state.
**Do:** world-gen endowments as mint transactions; opening-balance validation. **Accept:** Σ mint = Σ balances; INITIAL_WORLD §7.5. **Tests:** opening-state invariant run.

### WS-304 — Payroll engine
`M07` · `backend` · `M` · deps: WS-302, WS-105 · Ind? no
**Status:** implemented. Day-15/30 payroll splits each annual wage exactly over 24 periods, posts gross as employer credit plus employee-net and treasury-withholding debits, pre-funds institution employers through labeled ROW revenue, and emits `payroll.missed` without partial tax when an employer cannot fund gross.
**Do:** D15/D30 payroll: gross→withholding→net multi-leg txns; employer funding check; missed-payroll event path. **Accept:** legs sum to gross exactly (allocate); withholding to treasury. **Tests:** payroll goldens, allocation properties, insufficient-funds path.

### WS-305 — Static policies & treasury
`M16` · `backend` · `M` · deps: WS-302 · Ind? yes
**Status:** implemented. Append-only effective-tick policies support world-gen values, scenario overrides, and capability-checked future admin/schedule changes. Withholding uses HALF_EVEN integer math; tax records and events link to payroll; treasury-funded unemployment benefits suspend before overdraft. Genesis emits `policy.changed` and payroll emits `tax.collected`.
**Do:** policy registry (world-gen values), income withholding calc, treasury account, unemployment benefit payer with suspend-on-empty. **Accept:** FR-GOV-1 ACs; `tax.collected`/`policy.changed` events. **Tests:** tax math goldens (HALF_EVEN), treasury no-overdraft property.

### WS-306 — Household consumption
`M06` · `backend` · `M` · deps: WS-302 · Ind? no
**Status:** implemented. Every tick, exact daily portions of food, utilities, rent, and propensity-based discretionary demand are allocated in priority order against pooled household checking funds. Posted spend cannot exceed available funds; unmet essentials emit `financial_stress.triggered` instead of creating a negative balance.
**Do:** subsistence basket planner (priority: food>utilities>discretionary), discretionary propensity rule, financial-stress trigger. **Accept:** spend ≤ available always; stress trigger fires at threshold. **Tests:** budget property tests, basket priority, stress thresholds.

### WS-307 — ROW goods stub + rent/utilities billing
`M12/M17` · `backend` · `M` · deps: WS-306 · Ind? no
**Status:** implemented. Immutable ROW reference SKUs cover food, utilities, three rent tiers, and discretionary units. Household outflows and institution operating inflows use balanced, labeled `row_settlement` transactions and corresponding posted/purchase events; the conservation sweep passes over 360 ticks.
**Do:** ROW seller for basket SKUs at reference prices; rent to ROW landlord; flat utility billing. **Accept:** all ROW flows evented (`row_settlement`); conservation audit passes. **Tests:** ROW accounting tests.

### WS-308 — Indicators v1
`M18` · `backend` · `M` · deps: WS-302..307 · Ind? yes
**Status:** implemented. M1, active-contract average wage, labor-force unemployment rate, and treasury balance are recomputed and persisted at genesis and every tick. Stored latest values equal full recomputation, survive snapshot restore, and publish through `economic.metrics.updated`.
**Do:** m1, averageWage, unemploymentRate, treasuryBalance series + `economic.metrics.updated`. **Accept:** deterministic recompute == incremental values. **Tests:** formula goldens, incremental-vs-full equivalence.

### WS-309 — Transactions/banks/indicators API + digest v1
`M22` · `backend` · `M` · deps: WS-308 · Ind? yes
**Status:** implemented. Contract-backed endpoints expose filtered/keyset-paginated balanced transactions, bank list/detail, bounded indicator series, and ledger-derived agent finances. Committed digest frames carry all four real indicator values. Route, schema, day-15 integration, reopen, and snapshot-equivalence tests are green.
**Do:** GET transactions (filters), banks, indicators, agents/{id}/finances; digest frame gains indicators. **Accept:** contract tests; every transactions item balances. **Tests:** inject + schema.

### WS-310 — Web scaffold + dashboard v0 (shell pulled forward)
`M23` · `frontend` · `L` · deps: WS-108/109 for shell; WS-309 for indicators · Ind? yes
**Status:** implemented. The cockpit requests all four committed WS-308 series and renders BigInt-safe SVG sparklines in separate Finance and Employment panels, including constant-series geometry, current values, tick ranges, accessible labels, loading/error states, and an honest empty state. **Do:** React 19 + Vite + TanStack Query library/cockpit, shared-schema REST client, authenticated SSE hook, controls, tick/date/progress, digest counts, event ledger, connection state, disclaimer, and real indicator panels. **Accept:** lifecycle/status/event/indicator surfaces work without importing engine internals or fabricating series. **Tests:** component geometry/formatting tests, page-to-API contract integration, SSE parser/header tests, static-route/auth tests, and browser lifecycle smoke.

---

## Phase 4 — Companies, labor market, production

### WS-401 — Legal contracts core
`M11` · `backend` · `L` · deps: WS-105, WS-302 · Ind? yes
**Status:** implemented. Strict shared schemas cover incorporation, employment, service, and lease terms. The exact `draft→signed→active→completed|terminated|breached` state machine enforces all-party signatures and effective ticks; deterministic obligation firing/completion, recurring lease cutoffs, overdue breach predicates, timelines, and immutable persistence are covered.
**Do:** LegalContract entity + state machine, templates (incorporation, employment, service, lease), signature collection, obligation scheduling, breach predicates. **Accept:** FR-CTR-1 ACs; all-party signature enforcement. **Tests:** state-machine table, obligation firing, template schemas.

### WS-402 — Company formation workflow
`M08` · `backend` · `L` · deps: WS-401 · Ind? no
**Status:** implemented. Signed incorporation contracts drive one deterministic stage per tick through fee payment, registration, business-account opening, founder-capital transfer, exact founder equity issuance, and activation. Fee/capital postings use the real ledger and durable causal source events; hiring and trading are rejected before activation, and job posting starts no earlier than the following tick.
**Do:** forming→registered→active chain: registration via law firm (fee), business account, capital deposit; founder equity via M10 interface. **Accept:** DOMAIN_MODEL §4.1 sequence; no hire/trade before active. **Tests:** chain integration test, gate enforcement.

### WS-403 — Job postings & labor matching
`M07` · `backend` · `L` · deps: WS-402 · Ind? no
**Status:** implemented. Active companies persist minimum-wage postings and agent applications. Tier-1 eligibility checks employment, reservation wage, and weighted skills; matching is stable by score descending then code-unit `agentId`. Selection creates an all-party-signed active legal employment contract, updates authoritative employment state, and supports permission-checked quit/layoff requests with notice and effective termination events.
**Do:** postings, applications (Tier-1 rules), deterministic scored matching, employment contracts, quits/layoffs with notice. **Accept:** INV-5; matching order by score then agentId. **Tests:** matching determinism/fairness, termination paths.

### WS-404 — Production, inventory, sales
`M08/M12` · `backend` · `L` · deps: WS-402 · Ind? no
**Status:** implemented. The fixed seven-SKU catalog, company production profiles, append-only production/inventory records, and nonnegative inventory constraints are authoritative. Active labor produces capacity-bounded integer units; immediate posted-price orders revalidate buyer ownership, funds, price, and stock at settlement. Filled orders atomically post balanced purchase transactions and decrement stock, rejected shortages emit durable stockouts, and household grocery demand now buys from real sellers before falling back to ROW.
**Do:** linear production, inventory (never negative), posted-price order flow buyer-validated, stockout events; households buy from real sellers (replacing part of ROW stub). **Accept:** FR-MKT-1 ACs. **Tests:** inventory properties, order settlement atomicity, stockout paths.

### WS-405 — Pricing rule + bounded overrides
`M08` · `backend` · `M` · deps: WS-404 · Ind? yes
**Status:** implemented. Each offering reviews its trailing seven ticks on an offering-relative weekly cadence. Stockouts or inventory below 0.5 weeks of sales raise price 5%; inventory above 2 weeks or unsold stock lowers it 5%; balanced/no-activity windows hold. Every rule and founder price is clamped to the exact integer `[unit cost, unit cost + 50%]` envelope. Same-tick Tier-1/Tier-2 founder decisions are authority-checked, immutable price history is included in state hashes/snapshots, and actual changes emit `market.price.updated` with old/new price and `rule` or `decision:{id}` cause.
**Do:** weekly inventory/sales-ratio price adjustment; Tier-1 founder override within [cost, +50%]; `market.price.updated` with cause. **Accept:** FR-CO-3 ACs. **Tests:** rule goldens, bound enforcement.

### WS-406 — Energy tariffs & billing
`M17` · `backend` · `M` · deps: WS-404 · Ind? yes
**Status:** implemented. Riverbend Power & Light now owns a run-scoped immutable tariff/fuel history, charges households a flat tariff every 30 ticks, charges active firms per produced unit, folds the active business tariff into inventory cost, and buys the fuel for paid deliveries from ROW through balanced `row_settlement` postings. A 60% pass-through maps a +30% fuel-price shock to +18% tariffs at the next billing boundary; fuel and tariff envelopes are exact integer bounds. Every bill, rejection, tariff move, fuel-price change, transaction, and fuel purchase is causally evented. Migration v9 and state-hash v7 cover all energy records, including rollback, reopen, and snapshot/next-shock restore equivalence.
**Do:** RP&L tariff schedule, per-unit business billing, fuel purchases from ROW, pass-through rule. **Accept:** FR-NRG-1 shock propagation (with WS-408). **Tests:** pass-through goldens, billing balance.

### WS-407 — Insolvency & wind-down
`M08` · `backend` · `L` · deps: WS-403, WS-404 · Ind? no
**Status:** implemented. Active companies now receive immutable daily cash-versus-30-tick-obligation assessments; 30 consecutive shortfall days trigger one atomic wind-down. Staff, jobs, applications, legal agreements and offerings are closed first, inventory is sold to ROW at an exact 50% reference-price salvage rule, claims are paid by deterministic seniority, shortfalls are written off, any surplus reaches the founder residual tier, and all zero-balance company accounts close before `company.failed`. Migration v10, state-hash v8, causal events, post-condition invariants, rollback/reopen, and snapshot/next-day liquidation equivalence are covered.
**Do:** insolvency detector, wind-down waterfall (terminate staff → salvage to ROW → creditor seniority), `company.failed` with cause chain. **Accept:** FR-CO-4 ACs; no dangling records (post-conditions). **Tests:** wind-down completeness, recovery sums.

### WS-408 — World-event injection v1
`M19` · `backend` · `M` · deps: WS-406 · Ind? yes
**Status:** implemented. The versioned four-type catalog accepts only bounded energy, ROW-price, demand, and business-capacity shocks. API injections are allowed while created/paused, journal `admin.command.received` then `world.event.injected`, and create a durable future-boundary task. M01 applies the task before other obligations; M19 delegates to the owning module and preserves command → injection → application → effect causality. Demand and disaster effects expire exactly, overlapping modifiers are clamped, ROW prices and energy pass-through reach household requirements and firm costs, and any handler failure rolls back the task claim and tick. Migration v11 and state-hash v9 include WorldEvents and all effect histories with catalog, HTTP, rollback/reopen, propagation, and snapshot/next-boundary equivalence coverage.
**Do:** approved catalog (energy shock, ROW shift, demand shock, business disaster), API endpoint, scheduled firing, effect handlers. **Accept:** FR-EVT-1; AC-6 propagation demo. **Tests:** catalog validation, propagation integration.

### WS-409 — Companies/contracts/institutions API + UI pages
`M22/M23` · `backend+frontend` · `L` · deps: WS-402..407 · Ind? no
**Status:** implemented. Strict shared request/response contracts and run-bound cursor pages now expose companies, legal contracts, jobs, the eight Riverbend institutions, and the posted-price goods market. Company detail combines ownership, staff, offerings, jobs, 30-tick financials, current solvency/wind-down evidence, and a compact causal timeline; citizen detail reuses authoritative employment and finance reads. The React World Explorer provides list/detail routes and why-panels for formation, hiring, production, pricing, survival, and failure. Read projections are deterministic and state-hash neutral across reopen. Contract, integration, component, and a 360-tick Phase 4 acceptance gate cover the complete surface.
**Do:** endpoints per contracts; company pages with formation timeline; agent profile employment/finances view. **Accept:** UC-3 (sans loan) explorable end-to-end in UI. **Tests:** contract tests + component tests.

---

## Phase 5 — Credit

### WS-501 — Credit scoring
`M09` · `backend` · `M` · deps: WS-304 · Ind? yes
**Status:** implemented. Model v1 stores the exact authoritative income, debt-service, existing-debt, requested-loan, stability, DTI, payment-history, no-history, and evidence-reference inputs for every submitted application. The integer-only 300–850 formula, immutable assessment, causal `loan.application.created`/`loan.score.computed` events, migration v12, state-hash v10, rollback/reopen, and snapshot/next-application equivalence are covered.
**Do:** deterministic score from income stability, DTI, history; versioned formula. **Accept:** score inputs stored per application. **Tests:** formula goldens, edge cases (no history).

### WS-502 — Application workflow
`M09` · `backend` · `M` · deps: WS-501 · Ind? no
**Status:** implemented. Applications move only through submitted → under_review → approved/rejected (or withdrawal), with deterministic least-loaded active loan-officer assignment. The Tier-1 officer slot applies exactly zero adjustment and records a written rationale. Immutable model-v1 decisions store six ordered score, DTI, term, exposure, bank-status, and capital-ratio checks plus the offered rate. Complete causal events, migration v13, state-hash v11, authority/transition SQL guards, rollback/reopen, and snapshot/next-decision equivalence are covered.
**Do:** submitted→under_review→decision states; officer review slot (Tier-1 stub: adjustment=0 until Phase 6); policy checks; threshold decision. **Accept:** FR-BNK-3 event payloads complete (why-panel renders). **Tests:** state machine, decision immutability.

### WS-503 — Amortization & disbursement
`M09` · `backend` · `M` · deps: WS-502 · Ind? no
**Status:** implemented. Approved decisions generate immutable equal-principal 30/360 schedules with per-row HALF_EVEN interest and an exact residual-absorbing final principal row. One SQLite transaction opens the bank asset, credits the borrower deposit, posts the balanced system-authorized lending transaction, stores the loan/installments, and appends a complete causal event chain. Live loans feed later credit history. Migration v14, state-hash v12, INV-6, duplicate/immutability guards, rollback/reopen, and snapshot/next-disbursement equivalence are covered.
**Do:** 30/360 schedule generation (final row absorbs residue), atomic disbursement (loan asset + deposit). **Accept:** INV-6; Σ principal exact. **Tests:** schedule property+goldens, disbursement atomicity.

### WS-504 — Collections, missed payments, default
`M09` · `backend` · `M` · deps: WS-503, WS-105 · Ind? no
**Status:** implemented. A dedicated obligations handler collects exact due installments after payroll/benefits, requires enough available cash for the complete ordered arrears set, and never posts partial payments. Each failure marks only the current installment missed; a funded later due date cures every missed row atomically and resets the streak. The third consecutive miss emits complete miss history, records an immutable default, writes the remaining bank asset to a dedicated internal loss account with a balanced system transaction, and applies a 100-point personal credit-score penalty bounded at 300. Migration v15, state-hash v13, transition/ledger consistency guards, rollback/reopen, and snapshot/next-collection equivalence are covered.
**Do:** installment collection on due ticks; missed events; 3-consecutive default; write-down accounting; credit-score penalty. **Accept:** FR-BNK-5 ACs. **Tests:** default path integration, write-down balance.

### WS-505 — Circuit breakers
`M09` · `backend` · `M` · deps: WS-503 · Ind? yes
**Status:** implemented. Every approval and disbursement now persists an immutable pro-forma assessment of domestic deposits, fixed liquid reserves, retained-income/loss-adjusted capital and bank-specific borrower exposure. The opening 18% reserve and 14% capital positions are protected by explicit 12% and 10% floors. Systemic projected breaches transition the bank to `lending_halted`; a recovered projected position resumes it, while concentration failures block only that borrower. Stale approvals are rechecked before any account or loan mutation. Migration v16, state-hash v14, SQL provenance/arithmetic guards, stress boundaries, rollback/reopen, and snapshot next-assessment equivalence are covered.
**Do:** reserve ratio, capital ratio, exposure cap checks blocking approval/disbursement with events. **Accept:** FR-BNK-6 stress AC. **Tests:** breaker stress suite.

### WS-506 — Seeded credit state
`M02/M09` · `backend` · `S` · deps: WS-503 · Ind? no
**Status:** implemented. The eight deterministic world-gen loans now pass one shared portfolio/history/ledger/event audit: Ironvale's 36-month loan is current at month 22 with $116,666.62 outstanding, six personal loans are current, and one personal loan has exactly one missed seasoned installment. Exact 30/360 interest, equal-principal allocation, outstanding balances, borrower accounts, bank assets, two-leg opening recognition transactions, and one causal `loan.seeded` fact per loan are all cross-checked. Migration v17 guards canonical histories and recognition links and makes seed rows immutable; INV-6 consumes the full opening audit. Failed writes, reopen, logical hash, and snapshot restore equivalence are covered.
**Do:** world-gen seeds Ironvale loan + 6 personal loans + 1 delinquent (INITIAL_WORLD §5.11) with consistent history. **Accept:** opening invariants incl. INV-6. **Tests:** opening-state audit.

### WS-507 — Credit indicators + loans API + bank/loan UI
`M18/M22/M23` · `backend+frontend` · `M` · deps: WS-504 · Ind? no
**Status:** implemented. `creditOutstanding` now persists gross contractual outstanding principal across opening and originated credit, while `defaultRate` persists recorded defaults divided by all loans in deterministic HALF_EVEN basis points. Strict keyset-paginated loan reads normalize opening and originated credit without inventing missing history; loan detail returns either exact opening-recognition provenance or the complete stored application, score inputs/breakdown, officer review, six-check decision, approval/disbursement circuit evidence, schedule and default outcome. Bank detail derives its trailing 30-tick interest income and write-downs from immutable ledger legs. Migration v18 expands the immutable indicator catalog, and route/schema, UI, non-zero default, reopen, logical-hash and snapshot-restore tests cover the read path.
**Do:** creditOutstanding/defaultRate series; loans endpoints; bank dashboard + loan detail with full why-panel. **Accept:** UC-4 for loans entirely from stored data. **Tests:** contract tests, UI component tests.

### WS-508 — M1-attribution audit
`M26` · `backend` · `S` · deps: WS-504 · Ind? yes
**Status:** implemented. The pure M26 audit reconstructs agent/company M1 and treasury balances from every immutable ledger leg at ticks 0–360, reconciles both persisted series, classifies domestic-supply deltas as mint, lending, repayment or ROW, and requires exactly one matching same-tick/same-kind `transaction.posted` event for every transaction. Because accepted M1 v1 excludes treasury, the exact identity is `M1 Δ = authorized domestic-supply Δ − treasury Δ`; fiscal flows are therefore explicit reclassifications, not mislabeled creation. INV-2 now carries real domestic-deposit deltas instead of placeholder zeros. The 361-point CI sweep reports 10,000 bp attribution, equal material/evented supply counts and zero unattributed cents; unit tests prove unauthorized channels, indicator drift and missing evidence fail.
**Do:** conservation sweep attributing every M1 delta to mint/lending/ROW events. **Accept:** 360-tick run: 100% attribution. **Tests:** the sweep itself in CI.

---

## Phase 6 — LLM integration & conversations

### WS-601 — Live provider adapters + structured output
`M21` · `backend` · `M` · deps: WS-006 · Ind? yes
**Status:** implemented. New live manifests route Tier 2 to `MiniMax-M3` and Tier 3 to Kimi `kimi-k2.6`, with `kimi-k2.7-code` explicitly selectable; Anthropic remains a legacy adapter. The dependency-free OpenAI-compatible Bearer transport never sends credentials in bodies and never exposes tools. Kimi uses native strict JSON Schema; MiniMax uses a strict schema-in-prompt contract. Both parse exactly one JSON value, revalidate with the registered Zod schema, permit one fresh repair request without echoing invalid text, validate cached-token usage, and convert terminal invalid/refusal/truncation/envelope/HTTP/network cases to bounded typed fallbacks. Adversarial mocked-transport tests prove forged choices, extra fields and malformed payloads cannot escape the gateway. See [provider evidence](WS_601_MINIMAX_KIMI_PROVIDERS.md).
**Do:** provider adapter (native JSON-schema mode), Zod re-validation, repair-retry→fallback-signal ladder, error taxonomy mapping. **Accept:** adversarial fixtures never escape the gateway; ADR-0007 behavior. **Tests:** mocked-transport adapter tests, retry ladder.

### WS-602 — Response cache & request hashing
`M21` · `backend` · `M` · deps: WS-601 · Ind? yes
**Status:** implemented. Canonical SHA-256 request identity now covers every output-shaping request field and feeds the immutable `(provider, model, promptPackVersion, schemaVersion, requestHash)` key, with hard-coded request/key goldens and event-chain metadata exclusion tests. `CachedLlmProvider` supports deterministic read-through and hard `cache_only` replay, contains poisoned rows/audit failures as typed fallbacks, and never falls through to live on replay misses. Migration v19 adds run-scoped immutable responses plus an independent versioned `llmce_*` audit stream with actor, correlation, causation, and evidence, preserving authoritative `evt_*` ordering. Checksummed sorted artifacts validate before atomic idempotent import. Rollback/reopen, logical-state-hash exclusion, and exact SQLite snapshot/restore coverage are green.
**Do:** cache keyed (provider, model, promptPackVersion, schemaVersion, requestHash); hit/miss telemetry; export/import with run artifacts. **Accept:** cache-key stability goldens; replay reads cache-only. **Tests:** key stability, hit-path determinism.

### WS-603 — Budgets, ceilings, degradation
`M21/M24` · `backend` · `M` · deps: WS-601 · Ind? yes
**Status:** implemented. `BudgetedLlmProvider` authorizes every approved simulation-module request before provider access, charges validated non-cached successes with exact integer microcents, degrades Tier 3→2 at 80%, and returns a zero-attempt Tier-1 fallback at 100%. Provider-reported cached input is priced separately from uncached input; a WorldTangle response-cache hit still makes no upstream call and costs zero. Per-agent counters reset by simulated day; one-shot agent/run 80/100 facts and a running-run auto-pause commit atomically with usage. Migration v25 adds cached-input counters and monotonic constraints, state-hash v19 and snapshots include authoritative budget state, and the strict admin API journals reversible global-off, quarantine and module-freeze controls. Exact cached-price, forced-low-budget, cache non-charging, unpriced-model, rollback/reopen and restore-equivalence tests are green.
**Do:** per-agent daily tokens, per-run cost ceiling, 80/100% events, auto-pause, tier degradation ladder, kill switches (LLM off, agent quarantine, module freeze). **Accept:** FR-ADM-1/2 ACs; forced-low-budget test. **Tests:** budget enforcement, switch effects.

### WS-604 — Observation builder & prompt packs
`M04` · `backend` · `L` · deps: WS-203, WS-602 · Ind? no
**Status:** implemented. `PromptPackRegistry` resolves only exact immutable pack versions and ships the manifest-aligned `agent.decision@1` pack with its tier, module, structured response schema and output cap. `AgentObservationBuilder` canonicalizes strict engine state, uniquely fences bounded memory/message/news prose, and emits the sorted duplicate-free trusted action menu only after the closing fence. `buildAgentDecisionPrompt` keeps the Persona system prefix byte-stable, returns canonical observation/prompt/request identities, and never grants tools or state authority. Tier-2/3 Decisions now require and expose the pack key, version and SHA-256 prompt hash; Tier-1 rejects prompt metadata. Snapshot goldens, hostile-content fixtures, exact-version failures, Riverbend persistence/API/reopen and snapshot-restore coverage are green without a migration or hash-version bump.
**Do:** persona prefix (cache-friendly) + fenced observation (state, memories, menu) with injection fencing; versioned prompt pack registry; prompt hash in Decision. **Accept:** SAF-3 fencing red-team fixtures pass. **Tests:** prompt snapshot tests, fencing tests.

### WS-605 — Tier 2 decisions live
`M04` · `backend` · `L` · deps: WS-604, WS-603 · Ind? no
**Status:** implemented. Mock/live runs now discover five canonically ordered engine-authored menus before each tick and synchronously apply prepared founder pricing, founder hiring, applicant job response, loan-officer adjustment, and goal activation choices inside the authoritative tick transaction. Exact action type and canonical parameter equality is mandatory; forged assets or out-of-band values emit rejection evidence and fall back to Tier 1 without unauthorized mutation. Two current persisted decisions are required for employment, loan adjustments are exactly -5..+5, and selected goals are revalidated at apply time. Migration v21 adds immutable per-call evidence plus the loan agent-decision link; state-hash v16 and snapshots include both. Mock integration, hostile proposal, labor cross-product, loan boundary, goal selection, migration/reopen/restore, and public Tier-2 why-panel coverage are green.
**Do:** structured-choice decisions for: founder pricing/hiring, job accept/decline, loan officer adjustment (real ±band now), goal activation choices. **Accept:** FR-AGT-5/6; officer rationale appears in loan why-panel. **Tests:** mock-LLM decision integration, bound enforcement on officer adjustment.

### WS-606 — Conversation engine (Tier 3 bounded)
`M05` · `backend` · `L` · deps: WS-604 · Ind? no
**Status:** implemented. Two-party purchase/job conversations now run through canonical pre-tick Tier-3 message and Tier-2 outcome preparation, followed by synchronous transactional revalidation. The protocol enforces six turns, a 4,096-output-token aggregate cap, one opportunity per agent per tick, seven-tick topic cooldown, strict alternation, next-tick inbox delivery/read state, exact structured-term menus, structural acceptance, and same-sender no-progress closure. Free text is fenced and non-binding; forged params, stale requests, provider/schema/budget failures, and LLM-off mode deterministically fail closed without unauthorized mutation. Migration v22 adds immutable conversation, message, inbox, and relationship-history state; state-hash v17, causal events, two-way bounded relationship updates, memories, rollback/reopen, and snapshot restore equivalence are covered. See [WS-606 evidence](WS_606_BOUNDED_CONVERSATIONS.md).
**Do:** conversations ≤6 turns with token budgets, structured terms per message, outcome extraction, inboxes, no-progress detector, relationship-strength updates. **Accept:** PRD §13 protections all enforced. **Tests:** cap/no-progress/outcome-extraction suites, injection red-team.

### WS-607 — Purchase & job negotiation kinds
`M05/M07/M12` · `backend` · `M` · deps: WS-606 · Ind? no
**Status:** implemented. Terminal purchase/job conversations are bound once, in canonical order, only after both the binding coordinator and the owning market/labor store independently revalidate the exact structured terms, participants, terminal evidence, and fresh authoritative state. Misleading dialogue has no authority. Negotiated purchases recheck active offering, cost/posted-price bounds, inventory, buyer account authority and funds before an atomic exact-cents fill; negotiated jobs recheck submitted top-ranked application, active company, live vacancy and reservation/advertised wage bounds before an atomic signed employment contract. Migration v23 adds immutable causal binding results, state-hash v18 includes them, and idempotence, stale-state rejection, rollback/reopen and snapshot restore equivalence are covered. See [WS-607 evidence](WS_607_NEGOTIATION_BINDINGS.md).
**Do:** wire negotiation outcomes to binding validations (purchase terms, job offers). **Accept:** only structured terms bind; engine re-validates before contract. **Tests:** terms-vs-text divergence tests (text lies, terms rule).

### WS-608 — LLM telemetry & errors API/UI
`M25/M22/M23` · `backend+frontend` · `M` · deps: WS-603 · Ind? yes
**Status:** implemented. Migration v24 adds append-only per-call latency and exact integer-microcent cost receipts while deliberately excluding operational latency/cost from the logical replay hash; SQLite backup/restore still preserves them. Migration v25 extends authoritative run/agent usage with cached-input counters. `llm.call.recorded` v2 carries provider/model, attempts, input/cached-input/output tokens, latency, cost, cache status and causal evidence. Strict paginated call, error and conversation projections expose spend reconciliation, provider/schema/validation failures, rejected intents, engine errors, per-agent failure counts, active quarantines, terminal outcomes and negotiation bindings. `/status` reports authoritative spend, a real cache-hit rate and the rolling 24-tick error count. The World Explorer exposes cached input in both its budget meter and call ledger. Reopen/snapshot/hash-neutrality, route/client schemas, exact-price reconciliation and hostile-transcript rendering are covered. See [WS-608 evidence](WS_608_LLM_OBSERVABILITY.md).
**Do:** LlmCallRecords, spend in /status, errors endpoint, conversation viewer UI, budget meter, errors dashboard. **Accept:** FR-OBS-5, FR-ADM-3, UI-7. **Tests:** contract tests; spend reconciliation tolerance test.

### WS-609 — Live-mode acceptance run
`M26` · `docs` · `S` · deps: WS-605..608 · Ind? no
**Status:** complete. The refreshed real seed-42 loopback run exercised authenticated MiniMax and Kimi routes under the calibrated nonbillable 200-cent reference table. Two upstream attempts across 28 receipts reported 2,142 input, 882 cached-input and 360 output tokens; recorded and independently repriced spend both equal 474,606,000 microcents. The bounded one-call overshoot causally auto-paused the run at tick 301 and no later provider attempt occurred. Artifact digest: `913445f696aab6994ec6448a378b1e4f6b6695e14c61be5d7ff9fca440e17b5f`. See [WS-609 runbook](WS_609_LIVE_BUDGET_ACCEPTANCE.md).
**Artifact gate:** the shared strict validator independently verifies the schema, canonical digest, exact price math, tolerance basis points, displayed-cent rounding, causal threshold/pause link and stable post-pause attempt count. `pnpm gate:phase6` consumes this artifact together with WS-610 and fails closed while either live artifact is absent or inconsistent.
**Do:** scripted AC-2 demonstration ($2 ceiling live run → auto-pause) + recorded results in PROJECT_STATUS. **Accept:** AC-2 evidence recorded. **Tests:** the script itself (manual, documented).

### WS-610 — Mock/live parity suite
`M26` · `backend` · `M` · deps: WS-605 · Ind? yes
**Status:** complete. `captureLlmParity` compares canonical request/prompt/schema identities, provider-neutral call contracts, full Decisions and AgentActions, every event in the decision tick, causal IDs, and all affected-agent goals/memories while retaining provider/model/cache/attempt/token/cost provenance separately. A refreshed real MiniMax M3 proposal and its mock replay passed all five ordered section comparisons. Proposal hash: `f1ff27bdfa771150636b7e563cb968a4552d370efd01836c218b9d5f12536284`; evidence digest: `07eaceedf30bdc616ae14c87ac2c1d4fce1bf13bcc5e6f93bedc6b31014f6db0`. See [WS-610 evidence and runbook](WS_610_LLM_PARITY.md).
**Artifact gate:** the live runner now records both canonical request hashes plus a self-contained replay proposal. The strict validator recomputes its proposal hash, the five provider-neutral section digests in canonical order, the overall digest and every checklist claim. The authoritative `pnpm gate:phase6` command accepts only a semantically valid WS-609/610 artifact pair.
**Do:** same scenario mock vs live shape-compare (decisions valid, no engine-visible difference in types/flows). **Accept:** CI (mock) + manual (live) checklists green. **Tests:** parity assertions.

---

## Phase 7 — News, sentiment, MVP close-out

### WS-701 — Newsworthiness digest
`M14` · `backend` · `M` · deps: WS-302+ · Ind? yes
**Status:** implemented. `buildNewsworthinessDigest` projects one tick from immutable run events using scoring version 1: up to 4,000 points for decimal-order cents magnitude, up to 3,500 inverse-frequency rarity points over an inclusive lookback, and up to 2,500 points for deduplicated or explicitly counted affected entities. Operational event families are excluded. Score-descending ranking uses deterministic code-unit event-type/event-ID tie-breaks and is independent of input order. Each candidate includes a wall-time-neutral source-fact hash; the bounded digest has its own canonical golden hash. Mixed-run and duplicate-event inputs fail closed. See [WS-701 scoring contract](WS_701_NEWSWORTHINESS_DIGEST.md).
**Do:** deterministic scoring (money size, rarity, affected count) → per-tick candidate digest. **Accept:** stable ranking given same events. **Tests:** scoring goldens.

### WS-702 — Story pipeline
`M14` · `backend` · `L` · deps: WS-701, WS-604 · Ind? no
**Status:** implemented. Riverbend Ledger roles are verified from persisted agents; deterministic 30-tick editor windows select up to three distinct-topic candidates and rotate staff journalists. The engine owns neutral/context/brief drafts with exact copied event facts, while Tier 2 may return only an exact draft ID/hash menu tuple. Invalid, forged, mismatched, or failed proposals are durably spiked and never published; LLM-off mode uses the neutral template with no call. Migration 26 adds immutable organization/digest/story/citation rows, state-hash v20 and snapshot equivalence. The 360-tick gate proves at least 12 valid publications. See [WS-702 story contract](WS_702_STORY_PIPELINE.md).
**Do:** journalist selection, LLM story generation (strict schema, cited event IDs, fact fields copied), editor caps/dedupe, template fallback for LLM-off. **Accept:** FR-NWS-1 & AC-7; zero invalid publications. **Tests:** citation integrity, schema fuzzing, fallback mode.

### WS-703 — Sentiment engine
`M15` · `backend` · `M` · deps: WS-702 · Ind? no
**Status:** implemented. Three public topic indices decay by an integer 0.5% per tick and combine versioned event-outcome polarity with bounded stance×reach effects. Market stories route to economy without changing their stored topic. Persisted reach deterministically samples exposed agents; immutable story contributions drive at most one fully attributed opinion record per exposed agent/axis/tick with a five-point cap, and one `agent.opinions.updated` event journals the complete ordered tick batch. Later Tier-1 decisions store the exact sentiment/opinion evidence and apply only opposing ±25 response/no-op utility deltas; forged modifiers are skipped. Migration 27 adds immutable sentiment, contribution, opinion, and cause ledgers; logical state-hash v21 and snapshot restore equivalence include all rows. See [WS-703 sentiment contract](WS_703_SENTIMENT_ENGINE.md).
**Do:** topic indices (decay + bounded stance×reach), opinion drift (bounded, attributed), decision-prior modifiers. **Accept:** FR-NWS-2, FR-AGT-8. **Tests:** update goldens, bound/attribution tests.

### WS-704 — Full indicator set
`M18` · `backend` · `M` · deps: WS-703 · Ind? yes
**Status:** implemented. FR-OBS-2 now exposes all ten deterministic series at genesis and every tick. CPI is an exact fixed-share base-1000 basket with one final HALF_EVEN rounding; GDP proxy sums the trailing 30 ticks of final domestic goods and household-energy expenditure; active businesses are unique active company checking owners; and the sentiment index is the HALF_EVEN mean of the three effective decayed public topics. Every point carries formula version 1 and a canonical authoritative-input digest, and `economic.metrics.updated` publishes the same evidence. Migration 28 preserves older rows as explicit version-0 legacy evidence, state-hash v22 includes all value/version/digest fields, and API, grouped UI, migration, rollback, reopen, shock, event, and snapshot-restore tests are green. See [WS-704 indicator contract](WS_704_FULL_INDICATORS.md).
**Do:** CPI (fixed basket), GDP proxy, businessCount, sentimentIndex; formulas documented. **Accept:** FR-OBS-2 list complete. **Tests:** formula goldens on fixture worlds.

### WS-705 — Replay executor
`M25` · `backend` · `L` · deps: WS-602, WS-106 · Ind? no
**Status:** implemented. A terminal run can now be re-executed into a fresh run from its immutable manifest, ordered admin journal, and checksummed LLM cache. The asynchronous worker verifies all version pins and artifact digests, resumes after restart, reapplies lifecycle/advance/world-event/LLM-control commands at their original boundaries, and compares canonical event hashes after every boundary and tick. Strict mode halts on the first typed divergence; observe mode records and continues through cache-only deterministic fallback. Migration 29 stores hash-neutral replay summaries, immutable divergences, and source-call expectations. Terminal state hashes, partial exact-snapshot hashes, zero-provider cache replay, API/status contracts, rollback/reopen, snapshot preservation, injected-shock replay, and causal divergence detection are green. See [WS-705 replay contract](WS_705_REPLAY_EXECUTOR.md).
**Do:** replay from manifest+journal+cache; strict/observe modes; divergence reporting; replay API. **Accept:** FR-OBS-3 & AC-4 golden fixture. **Tests:** golden replay CI, divergence detection meta-test.

### WS-706 — Export jobs
`M25` · `backend` · `M` · deps: WS-302 · Ind? yes
**Status:** implemented. Migration 30 stores restart-safe, hash-neutral export jobs, immutable content metadata, and a versioned causal audit chain. Terminal source runs now produce canonical JSONL or fully quoted deterministic CSV for committed events, authoritative enriched transactions, and formula-evidenced indicators. Every dataset file is UTF-8 byte-counted, SHA-256 content-addressed, flushed and atomically published alongside a checksummed canonical manifest and exact simulation disclaimer. The worker serializes against a pinned source tick/hash under the normal run lock, resumes queued or running jobs after restart, and exposes strict create/poll contracts. Request/manifest/job rejection, migration upgrade, trigger immutability, rollback/reopen, snapshot preservation, state-hash neutrality, Windows flushing, JSONL/CSV round trips, transaction re-summing, authoritative row reconciliation, and worker restart recovery are green. See [WS-706 export contract](WS_706_EXPORT_JOBS.md).
**Do:** async JSONL/CSV export (events, transactions, indicators) with disclaimer metadata + checksums. **Accept:** AC-8 round-trip. **Tests:** export/re-sum test.

### WS-707 — News feed + explorer + replay UI
`M23` · `frontend` · `L` · deps: WS-702..706 · Ind? no
**Status:** implemented. The shared API now validates bounded published-story queries, run-bound keyset cursors, resolved feed parties, canonical three-topic sentiment series, exact immutable citations, and reconciled sentiment effects. Fastify exposes the feed and story-detail reads, while `/simulations/{simId}/explorer` combines cited stories, accessible sentiment sparklines, filterable committed events and balanced transactions, immutable causation ancestry, and a strict/observe cache-only replay stepper. Story text is inert, raw evidence is secondary, and a cited story reaches its causal event within two clicks. Shared, route, real Fastify/SQLite, hostile-content, why-panel, causality, and replay-progress tests are green. See [WS-707 UI contract](WS_707_NEWS_EXPLORER_UI.md).
**Do:** news feed w/ cited events, sentiment sparklines, event/transaction explorer with causality chains, replay stepper. **Accept:** UI-5/6 + NFR-8 (2-click why). **Tests:** component tests.

### WS-708 — Playwright happy path
`M26` · `frontend` · `M` · deps: WS-707 · Ind? yes
**Status:** implemented. A production-shaped Chromium scenario now creates a seed-42 mock Riverbend world, starts and pauses it, opens a citizen, inspects a real seeded loan why-panel, schedules an approved fuel-price shock through the new bounded admin surface, resumes to tick 31, and observes the authoritative CPI series. Playwright starts the built Fastify/React application against an isolated temporary SQLite directory, retains trace/screenshot/video evidence on failure, and runs on both Ubuntu and Windows CI without provider credentials. Component coverage proves exact catalog request shapes, paused-run authority, and the typed scheduling receipt. See [WS-708 acceptance contract](WS_708_PLAYWRIGHT_ACCEPTANCE.md).
**Do:** E2E: create sim → run → open agent → explain a loan → inject shock → observe CPI. **Accept:** green in CI (mock mode). **Tests:** itself.

### WS-709 — Scenario regression envelopes
`M26` · `backend` · `M` · deps: WS-704 · Ind? yes
**Status:** implemented. The version-1 `riverbend-100@1` seed-42/mock envelope is an immutable, canonically hashed engine contract with strict identity, gapless tick 0–360 indicator coverage, inclusive INITIAL_WORLD §9 bands, unique outcome evidence, zero unexplained M1 deltas, and typed violations. The authoritative SQLite probe reads the persisted scenario, indicators, companies, defaults, benefit events, and M1 audit. Its full 360-tick gate measures unemployment at 649 bp and CPI at 1000 throughout, three new active companies, one causally explicit insufficient-funds founder deferral, zero failures/defaults/suspensions, a nonnegative treasury, 100% M1 attribution, reconciled finance, all active invariants, periodic snapshots, and a logical state hash. The gate also repaired the missing achieved-goal-to-formation transition and made the three-action cap global across Tier-2, rule, and newsroom work. See [WS-709 evidence](WS_709_SCENARIO_REGRESSION.md).
**Do:** baseline-envelope suite per INITIAL_WORLD §9; tuning loop documented. **Accept:** default scenario inside envelopes. **Tests:** the envelope suite.

### WS-710 — MVP acceptance gate
`M26` · `docs` · `M` · deps: all P7 · Ind? no
**Status:** implemented. The PRD §28 AC-1 through AC-10 matrix is executable through `pnpm gate:mvp` and repeated on Windows/Ubuntu CI. The authoritative seed-42/mock gate now completes a 360-tick source run, strict manifest/journal/cache replay with zero divergences, and a second independent 360-tick run with identical terminal logical-state and raw event-log hashes. The gate also made replay expectations causal, neutralized replay-only identity in prompts/news hashes, and made built-in mock latency deterministic without weakening live telemetry. Invariants, formation-to-loan-to-operations evidence, energy-shock propagation, cited news, reconciled exports, adversarial rejection, API metadata, and the global UI disclaimer are all covered. See [WS-710 acceptance evidence](WS_710_MVP_ACCEPTANCE.md).
**Do:** execute PRD §28 AC-1..10; record evidence; fix-or-file gaps. **Accept:** all ACs pass or have owned follow-ups. **Tests:** the gate run.

---

## Phase 8 — VC & investments [V1]

### WS-801 — VC entities & fund accounting `M10` · `backend` · `M` · deps: WS-302 · Ind? yes — **Do:** firms, funds, deployed tracking. **Accept:** deployed ≤ fundSize. **Tests:** fund accounting properties.
**Status:** implemented. Foundry Capital and its first fund are authoritative run-scoped entities; new Riverbend runs seed a $5,000,000 integer-cent fund with causal genesis events. Every capital deployment is an immutable chain record whose database trigger advances the cached fund total atomically. Pure bigint rules, strict schemas, and SQL checks all reject malformed, duplicate, closed-fund, missing-company, and over-cap deployments before authoritative state can diverge. Migration 31 upgrades/reopens cleanly; logical state-hash v23, event/state rollback, database tamper guards, reopen, and snapshot restore-equivalence coverage are green. See [WS-801 evidence](WS_801_VC_FUND_ACCOUNTING.md).
### WS-802 — Proposal pipeline & negotiation kind `M10/M05` · `backend` · `L` · deps: WS-606 · Ind? no — **Do:** pitch triggers, Tier-3 negotiation (opus routing), expiry. **Accept:** FR-INV-1 events. **Tests:** pipeline integration, expiry.
**Status:** implemented. Active founders deterministically pitch an authorized Foundry partner from an adequately funded open fund 30 ticks after activation. Investment conversations use exact engine-authored amount, pre-money, and recomputed equity-basis-point menus under the existing Tier-3 route, six-turn/4,096-token caps, capacity limits, cooldowns, and synchronous outcome revalidation. Agreements stop in an auditable `agreed` state for WS-803; decline, no-agreement, escalation, invalid terms, and the explicit 14-tick deadline emit typed rejection evidence without mutating cash or ownership. Migration 32 preserves populated conversation child graphs, adds guarded proposal state, and advances logical state-hash v24. Pipeline, expiry, rollback, populated upgrade/reopen, and snapshot restore-equivalence coverage are green. See [WS-802 evidence](WS_802_INVESTMENT_PROPOSAL_PIPELINE.md).
### WS-803 — Cap-table math & closing `M10` · `backend` · `M` · deps: WS-802 · Ind? no — **Do:** term validation, atomic close (txn+shares+contract), dilution. **Accept:** INV-4 suite. **Tests:** cap-table properties, dilution goldens.
### WS-804 — Distributions `M10` · `backend` · `S` · deps: WS-803 · Ind? yes — **Do:** pro-rata dividends (largest remainder). **Accept:** exactness property. **Tests:** allocation tests.
### WS-805 — Investment API + UI `M22/M23` · `backend+frontend` · `M` · deps: WS-803 · Ind? no — **Do:** proposals/investments endpoints, cap-table + transcript UI. **Accept:** UC-8 explorable. **Tests:** contract + component.

## Phase 9 — Securities market [V1]

### WS-901 — Listings & eligibility `M13` · `backend` · `M` · deps: WS-803 · Ind? yes — **Do:** listing rules, Security entity, IPO event. **Accept:** eligibility enforced. **Tests:** rule tests.
### WS-902 — Order intake & escrow `M13/M09` · `backend` · `M` · deps: WS-901 · Ind? no — **Do:** limit orders, cash/share escrow at placement, cancels. **Accept:** no naked orders. **Tests:** escrow properties.
### WS-903 — Call auction & settlement `M13` · `backend` · `L` · deps: WS-902 · Ind? no — **Do:** volume-maximizing clearing price, deterministic tie-breaks, atomic settlement, ±20% band. **Accept:** INV-7; FR-SEC-1 ACs. **Tests:** clearing property tests, band tests.
### WS-904 — Trader decisions `M04` · `backend` · `M` · deps: WS-903 · Ind? no — **Do:** Tier-1/2 order decisions for eligible agents/VC. **Accept:** funded-only orders. **Tests:** decision bounds.
### WS-905 — Market API + UI `M22/M23` · `backend+frontend` · `M` · deps: WS-903 · Ind? no — **Do:** markets/prices endpoints, auction & chart UI, market SSE topic. **Accept:** contracts pass. **Tests:** contract + component.

## Phase 10 — Dynamic government [V1]

### WS-1001 — Policy proposal menus `M16/M04` · `backend` · `M` · deps: WS-605 · Ind? no — **Do:** bounded proposal decisions (mayor/treasurer), adoption process with delay + news hook. **Accept:** FR-GOV-3; menu bounds enforced. **Tests:** bound tests, adoption flow.
### WS-1002 — Monetary authority rule `M16/M09` · `backend` · `M` · deps: WS-704 · Ind? yes — **Do:** Taylor-lite base rate; bank rates reference base. **Accept:** deterministic; documented formula. **Tests:** rule goldens.
### WS-1003 — Policy→economy integration tests `M26` · `backend` · `M` · deps: WS-1001 · Ind? yes — **Do:** tax change → prices/sentiment propagation suite. **Accept:** effects explained via cause chains. **Tests:** the suite.
### WS-1004 — Policy UI `M23` · `frontend` · `S` · deps: WS-1001 · Ind? yes — **Do:** policy pages + timeline. **Accept:** UC-7 material visible. **Tests:** component.

## Phase 11 — Scale, comparison, evaluation

### WS-1101 — 1k-agent soak & profiling `M26/M01` · `backend` · `L` · deps: P7 · Ind? yes — **Do:** worldSpec scaling tables, soak run, profile, fix hot paths. **Accept:** NFR-2 targets; invariants green at 1k. **Tests:** soak in nightly CI.
### WS-1102 — Incremental indicators & read-model tuning `M18/M20` · `backend` · `M` · deps: WS-1101 · Ind? yes — **Do:** streaming aggregates, index tuning, archive path. **Accept:** benchmark budget met. **Tests:** equivalence + perf tests.
### WS-1103 — Batch-provider LLM scheduling `M21` · `backend` · `M` · deps: WS-602 · Ind? yes — **Do:** provider-supported batch mode per tick barrier. **Accept:** transport batching works without changing decision or apply ordering. **Tests:** scheduler tests (mock transport).
### WS-1104 — Run comparison API + UI `M25/M23` · `backend+frontend` · `L` · deps: WS-705 · Ind? no — **Do:** aligned series, divergence point, event diffs; comparison view. **Accept:** FR-OBS-6/UC-7. **Tests:** alignment tests, component tests.
### WS-1105 — Persona-consistency evaluation harness `M26` · `backend` · `M` · deps: WS-605 · Ind? yes — **Do:** scored eval of decisions vs personas (LLM-judge offline). **Accept:** report per run; R6 tracked. **Tests:** harness meta-tests.
### WS-1106 — Docker packaging `infra` · `S` · deps: P7 · Ind? yes — **Do:** Dockerfile + compose per ADR-0014. **Accept:** containerized run passes smoke. **Tests:** CI image build.

---

**Totals:** 7 (P0) + 10 (P1) + 9 (P2) + 10 (P3) + 9 (P4) + 8 (P5) + 10 (P6) + 10 (P7) + 5 (P8) + 5 (P9) + 4 (P10) + 6 (P11) = **93 tasks.**

Citizen tools, connectors and real external accounts are deliberately outside
all 93 tasks. After WS-1106, any self-hosted open-source provider-neutral tool
system requires a separate discovery plan and explicit approval.
