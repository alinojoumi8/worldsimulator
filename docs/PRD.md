# WorldTangle — Product Requirements Document

| | |
|---|---|
| **Status** | Approved v1.0 baseline — MVP and Phase 8 accepted through WS-805 |
| **Date** | 2026-07-24 |
| **Owners** | Project owner + engineering |
| **Related docs** | [PROJECT_STATUS.md](PROJECT_STATUS.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [API_CONTRACTS.md](API_CONTRACTS.md) · [DOMAIN_MODEL.md](DOMAIN_MODEL.md) · [INITIAL_WORLD.md](INITIAL_WORLD.md) · [TASK_BACKLOG.md](TASK_BACKLOG.md) · [adr/](adr/README.md) |

**Priority tags used throughout:** `[MVP]` must exist in the first shippable milestone (Phases 1–7) · `[V1]` first post-MVP release (Phases 8–10) · `[LATER]` long-term idea, design for but do not build · `[NOT-YET]` explicitly must **not** be built until re-approved.

---

## 1. Executive summary

WorldTangle is a research-oriented economic and social world simulator. It models a small stylized town ("Riverbend") populated by ~100 AI-controlled people and a set of institutions — a bank, a venture-capital firm, a law firm, a school, a news organization, a town government, an energy utility, several businesses, and (later) a stock exchange. Agents hold jobs, earn salaries, consume, save, borrow, start companies, hire, negotiate investments, sign contracts, talk to each other, read news, and change their opinions over time.

The system is a **hybrid**: a deterministic economic engine owns money, accounting, contracts, markets, and time; LLMs act only as bounded decision-makers that *propose* structured intents which the engine validates and applies. Every state change is recorded in an immutable audit log so that any outcome can be explained, replayed, and compared across runs.

The MVP (Phases 1–7 of the [roadmap](IMPLEMENTATION_PLAN.md#3-phased-roadmap)) delivers one town, 25–100 agents, employment, payroll, personal banking, company formation, bank loans, simple contracts, conversations, generated news, a small set of economic indicators, and an observation dashboard — all runnable fully deterministically with a mock LLM provider.

WorldTangle is a **simulation and research environment**. It must never present output as a prediction of any real economy, and the UI must label all results as simulated scenarios, not financial, legal, or political advice.

## 2. Product vision

Build a living, observable, explainable miniature society in which:

- **Individuals** have distinct identities, occupations, finances, personalities, goals, relationships, memories, and opinions, and make decisions consistent with them.
- **Institutions** (banks, firms, government, media, schools) operate under explicit rules and are staffed by agents in roles with real, bounded authority.
- **Emergence is the product**: business formation and failure, credit cycles, labor-market churn, price movements, sentiment waves, and policy consequences arise from agent interactions rather than being scripted.
- **Every important outcome is explainable**: a user can click on a bankruptcy, a loan rejection, or a price spike and trace the chain of decisions, conversations, events, and rules that produced it.
- **Runs are reproducible** to the extent the LLM provider permits, and always replayable exactly from the recorded event log.

Long-term, WorldTangle scales from one town of 100 agents to regions of thousands of agents with securities markets, elections, and policy experiments, while keeping cost, determinism, and auditability under control.

## 3. Problem statement

Existing tools each solve a fragment of this:

- **Classical agent-based economic models** (NetLogo, Mesa, custom ABMs) have deterministic rigor but agents are simple rule-followers — no natural-language negotiation, no persona-consistent judgment, no news-and-opinion feedback loop.
- **LLM "generative agent" demos** (Smallville-style towns) show believable social behavior but have no serious economy: no double-entry money, no credit, no enforced contracts, no reproducibility, and unbounded token costs.
- **Spreadsheet/DSGE-style macro models** have no individual agency at all.

There is no accessible environment where a researcher or curious builder can watch a *financially rigorous* society of LLM-driven individuals evolve, intervene with policies and shocks, and get an auditable explanation of what happened and why. WorldTangle closes that gap: LLM judgment where judgment matters, deterministic machinery everywhere money, law, and time are involved.

## 4. Target users

| User | Needs | Priority |
|---|---|---|
| **Owner/researcher** (primary, single user in MVP) | Configure scenarios, run/pause/replay simulations, observe outcomes, compare runs, export data | MVP |
| **Simulation engineer** (also the owner initially) | Debug agent decisions, inspect prompts/token spend, replay deterministic tests, tune rules | MVP |
| **Economics/AI-behavior researchers** | Scenario experiments (policy A/B), data export for analysis, reproducibility documentation | V1 |
| **Educators & students** | Watch worked examples (credit creation, business cycles) with explanations | LATER |
| **Public demo viewers** | Read-only shareable view of a running world | LATER |

No multi-tenant public product is in scope before LATER. Authentication remains minimal until then (see §22, ADR-0011).

Controlled design-partner testing may include mixed curious users. That cohort
validates whether one bounded causal experiment is understandable; it does not
expand the product into a multi-tenant public service. First-session testing
uses deterministic mock mode, a fixed seed, a short run, and an explicit
simulated-scenario disclaimer.

## 5. Primary use cases

- **UC-0 [MVP] Complete a guided causal test.** Start the recommended mock fixture without credentials, schedule one approved fuel-price shock, follow the intervention into a committed state and CPI observation, reload without losing the next step, and copy a reproducibility receipt.
- **UC-1 [MVP] Run a baseline world.** Create a simulation from the default Riverbend scenario, run 360 simulated days, watch the dashboard update per tick.
- **UC-2 [MVP] Observe an agent's life.** Open an agent profile; see persona, job, balances, relationships, recent decisions with reasons, conversations, and memory highlights.
- **UC-3 [MVP] Trace a business story.** An agent founds a café: see the founding decision, the legal registration contract, the bank account, the loan application and the officer's assessment, hiring, revenue, and either survival or failure — each step linked to its audit events.
- **UC-4 [MVP] Explain an outcome.** For any loan decision, job change, company failure, or price movement, view a "why" panel listing the rules applied, inputs, and influencing events.
- **UC-5 [MVP] Intervene with a shock.** Inject an approved world event (e.g., "energy price +30%") and watch propagation into prices, consumption, and sentiment.
- **UC-6 [MVP] Reproduce & replay.** Re-run a scenario with the same seed and cached LLM responses; replay a finished run tick-by-tick from its event log.
- **UC-7 [V1] Compare two runs.** Same scenario, different policy (e.g., corporate tax 15% vs 25%); compare indicator time series side-by-side.
- **UC-8 [V1] Negotiate an investment.** Watch a founder pitch a VC, multi-turn negotiation over valuation and equity, term sheet, and cap-table change.
- **UC-9 [LATER] Elections & markets.** Political groups campaign, agents vote, policy changes; companies IPO on the Riverbend Exchange.

## 6. Core simulation loop

One **tick = one simulated day** (ADR-0005). Each tick executes a fixed, ordered, deterministic phase pipeline:

1. **TickStart / Obligations** — due items fire: payroll (days 15/30), loan installments, contract expirations, scheduled tasks.
2. **Perception & Triggers** — the engine computes which agents have a *reason to think* (new message, payday shortfall, job offer, news, goal actionable, policy change). Everyone else runs scripted routine only. No LLM calls happen for un-triggered agents.
3. **Decisions** — triggered agents produce intents via the decision engine (rule tiers first, LLM tiers when warranted). Prepared opportunities use a stable domain order; provider calls currently issue sequentially before the authoritative tick and results enter the same deterministic apply barrier.
4. **Intent validation & execution** — every intent is validated against permissions, funds, laws, and world state; approved intents pass through module-owned typed apply/persistence boundaries inside the tick unit of work; rejected intents are recorded with reasons.
5. **Market clearing** — labor matches, goods purchases, (V1: securities auction) resolve deterministically.
6. **Settlement & accounting** — all money movements post as balanced double-entry transactions.
7. **News & sentiment** — journalists may write stories about notable events; sentiment indices update.
8. **Metrics** — economic indicators recompute; `economic.metrics.updated` publishes.
9. **Commit** — all state changes + events for the tick commit atomically; periodic snapshot/state-hash; `simulation.tick.completed` publishes to subscribers (SSE digest).

Acceptance criteria for the loop are in §28 (AC-1..AC-4).

## 7. Functional requirements

Every requirement has an ID, a priority tag, and an observable acceptance criterion (AC). Requirements marked `[NOT-YET]` are listed in §26.

### 7.1 Simulation lifecycle (module M01, M22, M24)

- **FR-SIM-1 [MVP]** Create a simulation from a scenario config (world spec reference, seed, rule/prompt versions, budgets). *AC: `POST /simulations` returns a simulation with `status=created` and a persisted, immutable run manifest.*
- **FR-SIM-2 [MVP]** Start, pause, resume, and stop a run. *AC: each control call transitions state per the state machine in DOMAIN_MODEL §Simulation; illegal transitions return HTTP 409; every control command is journaled as an `admin.command.received` event.*
- **FR-SIM-3 [MVP]** Advance time by N ticks while paused (step mode). *AC: `POST .../advance {ticks:N}` executes exactly N full tick pipelines and returns the new tick number.*
- **FR-SIM-4 [MVP]** Simulation time never moves backward and ticks are never partially applied. *AC: a crash mid-tick leaves the store at the previous tick's committed state (verified by kill-test).*
- **FR-SIM-5 [MVP]** Multiple runs per scenario with different seeds. *AC: two runs of the same scenario with different seeds produce different event logs; same seed + mock LLM produces byte-identical canonical state hashes.*
- **FR-SIM-6 [V1]** Concurrent independent simulations in one server process. *AC: two running simulations do not share RNG streams, ID counters, or event logs.*

### 7.2 Agents: identity, memory, decisions (M02, M03, M04)

- **FR-AGT-1 [MVP]** Every person-agent has a persona: name, age, occupation, skills, education, household, personality (Big Five + risk tolerance, time preference, ambition), goals, and opinion axes (redistribution, regulation, institutional trust, economic optimism). *AC: `GET /agents/{id}` returns all persona fields; world-gen validation rejects out-of-range values.*
- **FR-AGT-2 [MVP]** Agents have needs and a personal budget: subsistence (food, housing, utilities) and discretionary consumption scaled by income and personality. *AC: each tick, household consumption posts balanced transactions; an agent with insufficient funds triggers a `financial_stress` trigger instead of a negative balance.*
- **FR-AGT-3 [MVP]** Agents have goals with lifecycle (`dormant → active → achieved|abandoned`), e.g. "save $5,000", "start a bakery", "find a better job". *AC: goal state changes are events; an activated goal appears as a decision trigger.*
- **FR-AGT-4 [MVP]** Agent memory: an append-only stream of salient memories (events, conversation summaries, outcomes) with recency/importance scoring; the decision engine receives the top-k relevant memories in its observation. *AC: a memory written at tick T is retrievable and appears in the next decision context when relevant score qualifies; memory size per agent is bounded with deterministic compaction.*
- **FR-AGT-5 [MVP]** Decision tiers: Tier 0 scripted routines, Tier 1 deterministic utility rules, Tier 2 LLM structured choice from a bounded action menu, Tier 3 LLM negotiation/dialogue. Tier selection is rule-based per trigger type. *AC: decision records show tier used, action menu offered, choice made, and validation result; simulation runs to completion with the LLM disabled (all Tier ≥2 downgraded to Tier 1 fallback).*
- **FR-AGT-6 [MVP]** An LLM can never mutate state directly: it can only select/parameterize actions from the menu the engine offered. *AC: fuzzed LLM outputs (wrong schema, illegal action, other agent's assets) are all rejected by validation and logged as `agent.action.rejected`; no invalid state change occurs (property test).*
- **FR-AGT-7 [MVP]** Agents act only within their permissions (self, or institutional role grants). *AC: an intent whose actor lacks capability for the target account/company is rejected with `PERMISSION_DENIED`.*
- **FR-AGT-8 [V1]** Opinions drift from news, conversations, and personal outcomes with bounded per-tick deltas. *AC: opinion changes are events referencing their cause; max |Δ| per tick enforced.*
- **FR-AGT-9 [MVP]** A failed agent (LLM errors, repeated invalid outputs) is quarantined to Tier 1 for a cooldown without halting the simulation. *AC: kill-switch test — 100% LLM error rate still completes the tick; quarantined agents emit `agent.quarantined`.*

### 7.3 Employment & labor (M07)

- **FR-LAB-1 [MVP]** Companies post jobs (role, wage, requirements); job-seekers discover and apply; matching resolves deterministically by scoring (skill fit, wage vs reservation wage), with Tier 2 accept/decline decisions. *AC: `employment.created` event carries contract terms; no hire without a signed employment agreement (invariant INV-5).*
- **FR-LAB-2 [MVP]** Payroll: semi-monthly (sim days 15/30), gross → income-tax withholding → net deposit; employer cash decreases accordingly. *AC: payroll posts balanced multi-leg transactions (net to employee, withholding to treasury); sum of legs equals gross exactly in integer cents.*
- **FR-LAB-3 [MVP]** Terminations (voluntary quit, layoff, company failure) with notice rules; unemployed agents receive the unemployment benefit while it is funded. *AC: `employment.terminated` includes reason; benefit payments stop when treasury rules say so.*
- **FR-LAB-4 [V1]** Wage negotiation (Tier 3) within employer-budget bounds; raises and promotions.

### 7.4 Money, banking & credit (M06, M09)

- **FR-BNK-1 [MVP]** All money is deposits at simulated banks (cashless town). Personal, business, and treasury accounts. Opening a business account requires a registered company. *AC: `account.opened` events; account ownership enforced on every transaction.*
- **FR-BNK-2 [MVP]** Every money movement is a balanced double-entry transaction (equal debits and credits, integer cents) with actor, tick, reason, source event, and correlation ID. *AC: property test over arbitrary operation sequences: per-transaction balance always holds; global conservation holds except via authorized issuers (mint at world-gen, lending, ROW channel — each explicitly evented).*
- **FR-BNK-3 [MVP]** Loan applications: applicant submits purpose/amount/term; engine computes a deterministic credit score (income stability, debt-to-income, history); a loan-officer agent (Tier 2) reviews and may adjust within a bounded band (e.g. ±5 points) and must produce a written rationale; approval requires score ≥ policy threshold AND bank capital/reserve checks. *AC: `loan.approved`/`loan.rejected` events carry score inputs, officer adjustment, rationale, and policy checks — the UI "why" panel renders from this data alone.*
- **FR-BNK-4 [MVP]** Loan disbursement creates the loan asset and the borrower deposit (credit creation); amortization uses 30/360 day-count with fixed-point rates and an explicit rounding step; final installment absorbs residual cents. *AC: sum of scheduled principal == principal exactly; interest computed by `mulDiv` with documented rounding; schedule regenerable byte-identically.*
- **FR-BNK-5 [MVP]** Missed payments (insufficient funds on due date) → `loan.payment.missed`; 3 consecutive misses → default: write-down, credit-score penalty, collection rules. *AC: default emits `loan.defaulted` with the miss history; bank books the loss; borrower flagged.*
- **FR-BNK-6 [MVP]** Bank circuit breakers: reserve requirement, per-borrower exposure cap, minimum capital ratio; lending halts (with event) when breached. *AC: stress test drives the bank to its limits and lending stops rather than balances going impossible.*
- **FR-BNK-7 [V1]** Deposit interest, multiple banks, interbank settlement.

### 7.5 Companies (M08) & contracts (M11)

- **FR-CO-1 [MVP]** Company formation workflow: founder intent → legal registration via law firm (fee + `LegalContract` of type `incorporation`) → business bank account → founding capital deposit → optional loan → hiring. *AC: each step emits its event; a company cannot hire or trade before `status=active`; the full chain is visible in the company timeline view.*
- **FR-CO-2 [MVP]** Company operations each tick: production (labor → units, capacity-bounded), inventory, posted-price sales, cost of goods, payroll, rent/utilities, simple P&L and quarterly corporate tax. *AC: company financial statements derive 1:1 from posted transactions; inventory never negative.*
- **FR-CO-3 [MVP]** Pricing: deterministic weekly rule (inventory/sales ratio adjusts price within bounds); founder may override via Tier 2 within [unit cost, +50%]. *AC: `market.price.updated` events carry old/new price and cause (`rule` or `decision:{id}`).*
- **FR-CO-4 [MVP]** Company failure: insolvency test (cash < obligations for N consecutive days) → wind-down: terminate staff, sell inventory at salvage to ROW, repay creditors by seniority, emit `company.failed` with cause chain. *AC: post-failure, no dangling employment/contracts/accounts; creditors' recoveries sum to liquidation proceeds exactly.*
- **FR-CTR-1 [MVP]** Contracts (employment, loan, incorporation, service, lease) have status machines (`draft → signed → active → completed|terminated|breached`), parties, terms, and are enforced by the engine — obligations they encode fire on schedule. *AC: `contract.signed` requires all party signatures (intents); breach conditions are rule-evaluated and emit `contract.breached`.*
- **FR-CTR-2 [V1]** Disputes and simple arbitration via the law firm; damages transfers.

### 7.6 Goods, services & consumer market (M12, M17)

- **FR-MKT-1 [MVP]** Posted-price consumer market for a small catalog: groceries, meals, durable goods, repair services, healthcare visits, tuition, electricity. Households buy subsistence first, then discretionary by budget rules. *AC: every purchase decrements inventory and posts a balanced transaction; shortages emit stockout events that feed price rules and news.*
- **FR-MKT-2 [MVP]** Rest-of-World (ROW) channel: external supplier/buyer at slowly-moving reference prices for wholesale inputs and surplus exports; all ROW flows are explicitly evented (they are the authorized external money source/sink). *AC: ROW cash flows appear in conservation accounting; scenario config can shock ROW prices.*
- **FR-NRG-1 [MVP]** Energy: the utility sells electricity to households (flat tariff) and businesses (per production unit); it buys fuel from ROW. Fuel-price shocks propagate to tariffs via a deterministic pass-through rule. *AC: injecting `energy price +30%` raises tariffs next billing cycle and shows up in CPI and firm costs.*
- **FR-NRG-2 [LATER]** Commodity spot market, generation capacity, outages.

### 7.7 Investment & VC (M10) — V1

- **FR-INV-1 [V1]** Founders pitch VC (Tier 3 negotiation): valuation, amount, equity; engine validates cap-table math (Σ ownership = 100%, non-negative, price consistency). *AC: `investment.proposed` → negotiation transcript → `investment.completed` with cap-table diff, or rejection with reason.*
- **FR-INV-2 [V1]** Ownership stakes tracked per company; dividends/exits post to owners pro-rata by largest-remainder. *AC: property test — allocations always sum exactly to the distributed amount.*

### 7.8 Securities market (M13) — V1

- **FR-SEC-1 [V1]** Listing: qualifying companies may IPO on the Riverbend Exchange; shares registered as securities. Daily **call auction** (single batch clearing price per tick), limit orders only. *AC: trades occur only between compatible orders; clearing price maximizes matched volume with deterministic tie-breaks; `market.trade.executed` and `market.price.updated` events per auction.*
- **FR-SEC-2 [NOT-YET]** Continuous order book, market makers, derivatives, short selling.

### 7.9 News, sentiment & media (M14, M15)

- **FR-NWS-1 [MVP]** Journalist agents receive a curated notable-event digest each tick and may write stories (LLM, strict schema: headline, body, topic, entities, stance, cited event IDs). Editor rules (deterministic) cap stories/day and check schema. *AC: `news.story.published` stories always cite ≥1 real event ID; invalid story outputs are dropped and logged, never published.*
- **FR-NWS-2 [MVP]** Public sentiment: per-topic indices (economy, employment, institutions) updated deterministically from story stance/reach and event outcomes; sentiment modulates agent decision priors via bounded deltas. *AC: `sentiment.updated` events show contributing stories; effect size caps documented and enforced.*
- **FR-NWS-3 [V1]** Agents consume news selectively (interest/relationship-weighted) and reference stories in conversations and opinion changes.

### 7.10 Government & policy (M16)

- **FR-GOV-1 [MVP]** Static fiscal rules at world start: income-tax withholding, quarterly corporate tax, unemployment benefit; treasury account with balance rules. *AC: tax collection posts to treasury with `tax.collected` events; benefits halt if treasury is empty (with event) rather than creating money.*
- **FR-GOV-2 [MVP]** Policy changes only via approved admin injection or scenario schedule (no autonomous government LLM decisions in MVP). *AC: `policy.changed` carries old/new values and effective tick; changes apply at tick boundaries only.*
- **FR-GOV-3 [V1]** Government agents (mayor, treasurer) propose policy within bounded menus; simple approval process; interest-rate lever via a rule-based monetary authority.
- **FR-GOV-4 [NOT-YET]** Elections, political campaigning, party formation (design exists in DOMAIN_MODEL; build only after V1 review).

### 7.11 Scenarios & world events (M19)

- **FR-EVT-1 [MVP]** Approved world-event catalog (energy shock, ROW price shift, demand shock, natural-disaster stub affecting a business) injectable via API while paused or scheduled in scenario config. *AC: `world.event.injected` journaled; unknown event types rejected; effects applied by deterministic handlers.*
- **FR-EVT-2 [MVP]** Scenario settings editable only when `created` or `paused`, and every change is journaled and versioned. *AC: `PATCH /scenario` during `running` returns 409; accepted changes appear in the run manifest history.*

### 7.12 Observability, replay & explainability (M18, M24, M25)

- **FR-OBS-1 [MVP]** Immutable audit event log: every state change has actor, wall time, sim tick, reason, source event, prior/new value where appropriate, correlation + causation IDs. *AC: sampled deep-audit — for 100 random transactions, the full cause chain resolves to a root trigger.*
- **FR-OBS-2 [MVP]** Economic indicators per tick: GDP proxy, unemployment rate, CPI (fixed basket), average wage, money supply M1, credit outstanding, default rate, active business count, treasury balance, sentiment index. *AC: indicators recompute deterministically from state/transactions; formulas documented in code and IMPLEMENTATION_PLAN M18.*
- **FR-OBS-3 [MVP]** Replay: re-execute a finished run from its manifest + event journal + LLM response cache to byte-identical state hashes; step a replay tick-by-tick in the UI. *AC: replay CI test on golden fixture passes; divergence (if cache incomplete) is detected via stateHash events and reported, not silently ignored.*
- **FR-OBS-4 [MVP]** Decision explainability: every Tier ≥1 decision stores observation summary, options offered, choice, rationale (LLM text or rule name), validation outcome. *AC: agent profile shows last N decisions with "why" details; loan/hire/price outcomes link back to decisions.*
- **FR-OBS-5 [MVP]** LLM telemetry: per-call model, latency, tokens, cost estimate, cache hit; per-agent and per-run budget meters. *AC: `GET /simulations/{id}/status` includes spend; budget threshold events fire at 80%/100%.*
- **FR-OBS-6 [V1]** Run comparison: aligned indicator time series and event-frequency diffs between two runs. *AC: `GET /runs/compare` returns aligned series with divergence-point annotation.*
- **FR-OBS-7 [MVP]** Export: full event log, transactions, indicators as JSONL/CSV via async export job. *AC: exported transaction set re-sums to in-store balances.*

### 7.13 Administration & safety controls (M24)

- **FR-ADM-1 [MVP]** Hard cost ceiling per run: when the token/cost budget is exhausted the simulation auto-pauses with a clear event and UI banner. *AC: forced-low-budget test auto-pauses; no further LLM calls issue.*
- **FR-ADM-2 [MVP]** Kill switches: disable LLM globally (fallback tiers), quarantine one agent, freeze one module's intents. *AC: each switch is journaled and reversible without restart.*
- **FR-ADM-3 [MVP]** Error dashboard: recent engine errors, rejected intents, schema-validation failures, per-agent failure counts. *AC: `GET /simulations/{id}/errors` paginates all of the above with correlation IDs.*

## 8. Non-functional requirements

- **NFR-1 Performance [MVP]:** With LLM disabled (mock), ≥50 ticks/second at 100 agents on a developer laptop; with live LLM, tick latency dominated by LLM batch latency, target ≤60s per tick at 100 agents with ≤20 triggered agents/tick. *(Measured by a benchmark script; numbers revisited each phase.)*
- **NFR-2 Scale path [V1→LATER]:** Architecture supports 1,000+ agents: O(triggered agents) LLM work per tick, O(n log n) matching, indicator computation streaming over transactions, event-log writes batched per tick. No design element may require O(n²) cross-agent interaction by default.
- **NFR-3 Cost [MVP]:** Default budgets: ≤$5 per 360-tick run at 100 agents on default routing (see §18); budget enforcement cannot be disabled silently.
- **NFR-4 Reliability [MVP]:** A crash never corrupts a run: tick atomicity (FR-SIM-4), atomic snapshot writes (temp+fsync+rename), resume from last committed tick.
- **NFR-5 Reproducibility [MVP]:** Mock-LLM runs are bit-reproducible across OSes (Windows/Linux CI matrix); live-LLM runs are replayable from cache; limits documented (§ADR-0009, §27).
- **NFR-6 Auditability [MVP]:** No code path may mutate financial state outside the `apply()` choke point (lint + code review rule); event log is append-only (no UPDATE/DELETE).
- **NFR-7 Security [MVP]:** Server binds 127.0.0.1 by default; provider API keys only in server env; agent/news content treated as untrusted data in all prompts (§22).
- **NFR-8 Explainability [MVP]:** Every UI screen that shows an outcome must be able to show its cause chain within 2 clicks.
- **NFR-9 Testability [MVP]:** Whole engine runs headless with mock LLM in CI; each module testable in isolation via its public interface.
- **NFR-10 Incremental delivery [MVP]:** After every roadmap phase the repo is runnable and its tests pass.

## 9. Agent model

An **Agent** = Persona + State + Memory + Decision policy. Institutions are **not** agents; they are rule systems that grant *roles* to agents (see §10).

- **Persona (mostly immutable):** name, age, education, occupation, skills (0–100 per skill), personality — Big Five (0–100) plus risk tolerance, time preference, ambition; opinion axes (−100..100): redistribution, regulation, institutional trust, economic optimism. Generated per [INITIAL_WORLD.md](INITIAL_WORLD.md) templates.
- **State (mutable, engine-owned):** employment, accounts/balances (via banking module), household membership, goals, needs satisfaction, relationships (typed edges with strength −100..100), credit score, quarantine status.
- **Memory:** append-only salient records `{tick, kind, content, importance, references}`; deterministic salience scoring (recency × importance × relevance-to-trigger); top-k retrieval into observations; periodic compaction into summary memories (Tier 2 LLM or deterministic template when LLM off). Memory is the *only* free-text state an LLM writes, and it is data, never instructions (§22).
- **Decision tiers (ADR-0006, §18):**
  - Tier 0 scripted: routine consumption, bill payment — no decision record.
  - Tier 1 rules: utility scoring over a decision table (e.g. apply-for-job if unemployed and posting score > reservation). Deterministic, always available as fallback.
  - Tier 2 LLM structured choice: engine builds observation (persona summary, relevant state, top-k memories, action menu with parameters schemas); LLM returns `{actionId, params, rationale}`; strict schema validation.
  - Tier 3 LLM dialogue: bounded multi-turn conversation/negotiation (≤6 turns MVP) with a structured outcome extraction at the end.
- **Tier-2 execution boundary:** provider work completes before the authoritative tick. The engine then requires the returned action type and canonical parameters to exactly equal one offered entry and revalidates current actor/domain authority. Any provider, hash, schema, budget, or capability failure records a typed call outcome and applies the deterministic Tier-1 choice instead. Founder employment choices bind only with the applicant's separate current choice; loan adjustment remains an enumerated -5..+5 menu.
- **Triggers** (the only paths into Tier ≥1 thinking): scheduled task due, message received, job opportunity match, financial stress (balance below N days of subsistence), news relevance score > threshold, policy change affecting agent, relationship event, company event (own employer/company), market movement (V1), goal became actionable.
- **Permissions:** an agent may act on: self, own accounts, own household (shared budget), companies where it holds an office (founder/manager roles), institutional powers granted by role (loan officer: decide applications at their bank within limits). All enforced at validation, not in prompts.

## 10. Institution model

Institutions are engine-side entities with rulebooks, staffed by agents holding **roles** with bounded authority:

| Institution | Kind | Rule system owns | Agent roles (LLM-driven judgment) |
|---|---|---|---|
| First Ledger Bank | bank | ledger, reserve/capital rules, amortization, default process | loan officers (bounded adjustment + rationale), branch manager (rate-setting within band, V1) |
| Foundry Capital | vc_firm | fund accounting, cap-table math, term-sheet validation | partners (pitch evaluation, negotiation) — V1 |
| Hale & Marrow LLP | law_firm | contract templates, registration process, fees | lawyers (drafting flavor, dispute arguments — V1) |
| Riverbend School | school | enrollment, tuition billing | teachers/principal (personas; skill effects LATER) |
| The Riverbend Ledger | news_org | publication caps, schema checks, distribution | editor/journalists (story selection & writing) |
| Town of Riverbend | government | tax rules, treasury, benefits, policy application | mayor/treasurer (proposals within menus — V1) |
| Riverbend Exchange | market_operator | listing rules, call auction, settlement | ops manager persona only; matching is never LLM |
| Riverbend Power & Light | energy_co | tariffs, pass-through rule, fuel purchasing | manager (investment decisions — V1) |
| Businesses (Ironvale, Hearthside, Fogline, Bluepine, Cedar & Sage, Willow & Rye) | company | production, inventory, accounting | founders/managers (pricing, hiring, strategy via tiers) |

**Institutional systems, not agents:** market matching, tax collection, payroll processing, registrar, monetary authority (V1 rule-based), ROW supplier/buyer, utility billing. These never call an LLM (see INITIAL_WORLD §7).

## 11. Economic model

Stylized small open economy, cashless, single currency (simulated USD, integer cents):

- **Money & credit:** all money is bank deposits. M1 = Σ customer deposits. Money enters/leaves only via: world-gen mint (initial endowments), bank lending/repayment (credit creation/destruction), and the ROW channel (exports/imports). Each channel is explicitly evented → conservation is checkable (INV-2).
- **Households:** income (wages, benefits, V1 dividends) → consumption (subsistence basket first: groceries, housing rent to ROW-landlord [MVP simplification], utilities; then discretionary by propensity-to-consume rule shaped by personality and sentiment) → savings buffer → (V1) investment.
- **Firms:** linear production `units = min(labor_hours × productivity, capacity)`; inputs purchased (wholesale from ROW or Ironvale); posted-price sales; costs: wages, inputs, energy, rent, interest, taxes. Retained earnings fund growth; insolvency → failure workflow (FR-CO-4).
- **Labor:** wage posting + reservation wages; unemployment emerges; benefit provides a floor while funded.
- **Prices:** firm-level rule-based adjustment (inventory/sales ratio) + bounded founder overrides → CPI over a fixed basket.
- **Taxes:** income withholding at payroll; corporate tax on quarterly profit; treasury funds government salaries and benefits.
- **What is deliberately absent from MVP:** housing market (fixed rents), monetary policy dynamics (fixed base rate), FX/trade dynamics beyond ROW reference prices, demographics (no aging/birth/death), inflation-indexing.

## 12. Financial-market model

- **MVP:** no securities market. Private ownership only: founder equity recorded at company creation; cap table exists from day one so V1 investments slot in without migration.
- **V1 (Phase 8–9):** VC deals (priced rounds only: amount, pre-money valuation, new shares); Riverbend Exchange **daily call auction**: collect limit orders during the tick → single clearing price maximizing volume (deterministic tie-break: price-time by orderId) → trades settle same tick against buyer/seller accounts. Circuit breaker: ±20%/day price band.
- **Validation invariants:** Σ ownership = 100% ± 0 (integer share counts), no negative positions, orders require funded accounts (cash or shares escrowed at order time), a trade requires compatible orders (INV-7).
- **[NOT-YET]:** continuous trading, margin, shorting, derivatives, market makers, index products.

## 13. Communication & negotiation model

- **Conversation objects:** participants, topic, initiating trigger, messages (each an event), bounded length (MVP ≤6 turns) and per-conversation token budget; hard stop → deterministic outcome extraction (Tier 2 schema: agreement | no-agreement | escalate).
- **Negotiations** (job offers V1, VC deals V1, purchases MVP-lite): structured "positions" carried alongside free text — every offer message must include machine-readable terms `{price?, salary?, equity?, ...}`; only the structured terms are binding; the engine validates final terms before any contract is created.
- **Async inboxes:** messages delivered next tick; agents triggered by unread messages.
- **Anti-loop protections:** max conversations per agent per tick, max rounds, no-progress detector (identical terms twice → auto-close), cooldown between repeat conversations on the same topic (INV protections, §13 of IMPLEMENTATION_PLAN M05).
- **Prompt-injection stance:** message text from other agents is untrusted data — it is quoted inside fenced observation blocks, never concatenated as instructions (§22, ADR-0007).

## 14. News & public-sentiment model

- **Pipeline:** notable-event digest (deterministic newsworthiness scoring: money size, rarity, affected count) → journalist selection (LLM ranked choice) → story generation (strict schema; must cite event IDs; stance ∈ [−2..2]) → editor checks (schema, caps, topic dedupe) → publication event → distribution (agents' interest match) → sentiment update (deterministic: decay + Σ stance × reach) → decision-prior modulation (bounded ±10% on relevant utility weights).
- **Guarantees:** stories cannot invent events (must cite real event IDs; fact fields are copied from events, LLM writes only narrative); publication caps prevent spam; all sentiment effects bounded and evented.

## 15. Government & policy model

- **MVP:** fixed policy set (income tax rate, corporate tax rate, unemployment benefit amount, minimum wage) applied by deterministic systems; treasury with hard no-overdraft rule; policy changes only via admin injection/scenario schedule at tick boundaries.
- **V1:** government agents propose changes from a bounded policy menu with rule-validated ranges (e.g. income tax 0–50%); a simple adoption process (mayor proposes, takes effect after N ticks with news coverage); rule-based monetary authority adjusts base rate on inflation/unemployment triggers (Taylor-lite, fully deterministic).
- **[NOT-YET]:** elections, parties, campaign dynamics, lobbying, regulation of specific industries.

## 16. Event & time system

- **Time:** tick = 1 sim day; 360-day year, 12 × 30-day months; dates `Y####-M##-D##`; epoch Y0001-M01-D01. No weekends (documented simplification). Semi-monthly payroll (D15/D30), monthly loan installments, quarterly taxes (M3/M6/M9/M12 D30), annual reports (Y-end).
- **Scheduler:** priority queue of `(tick, order, taskRef)`; tasks fire in the Obligations phase in deterministic order.
- **Events:** versioned envelope (see API_CONTRACTS §4): `{eventId, type, schemaVersion, simulationId, runId, seq, tick, simDate, wallTime, actor, correlationId, causationId, payload}`. `seq` is a per-run monotonic integer; the log is append-only. Operator commands and world-event injections are journaled as input events so replay reproduces them (ADR-0003/0009).
- **Causality:** every event caused by another carries `causationId`; every user-visible outcome traces to a root (trigger, schedule, or admin command).

## 17. Data model

Authoritative catalog in [DOMAIN_MODEL.md](DOMAIN_MODEL.md) (~50 entities incl. Simulation, SimulationRun, WorldState, Agent, Persona, Goal, Memory, Relationship, Household, Company, Job, EmploymentContract, Bank, BankAccount, LoanApplication, Loan, Payment, Transaction, VentureCapitalFirm, InvestmentProposal, Investment, OwnershipStake, LegalContract, Product, Inventory, Order, Market, Security, StockOrder, Trade, PriceHistory, NewsOrganization, NewsStory, GovernmentInstitution, Policy, Tax, PoliticalGroup, Election, EconomicIndicator, WorldEvent, Conversation, Message, AgentAction, Decision, AuditLog/EventRecord). Key principles:

- Single-writer ownership: each entity has exactly one owning module (writes); all others read via interfaces.
- Financial truth lives in `Transaction` postings; balances are derived/cached with invariant checks.
- Free text (rationales, messages, stories, memories) is stored as data payloads, never parsed for control flow.
- All entities carry `simulationRunId`; nothing is shared across runs except immutable scenario/world-spec definitions.

## 18. LLM integration strategy

(Details: ADR-0007, IMPLEMENTATION_PLAN M21.)

- **Provider abstraction:** `LlmProvider` interface; adapters: MiniMax, Kimi, Anthropic (legacy) and Mock (tests). Kimi/Anthropic use provider-native JSON-schema mode; MiniMax uses a strict schema-in-prompt contract. Every result is parsed as one JSON value and revalidated with Zod.
- **Model routing by tier:** Tier 2 → MiniMax `MiniMax-M3`; Tier 3 → Kimi `kimi-k2.6` by default, with `kimi-k2.7-code` as an explicit opt-in. The routing table is configuration pinned in the run manifest.
- **Scheduling & batching:** agents think only on triggers. Opportunities are sorted by a stable domain key, provider calls currently issue sequentially and results apply behind the same pre-tick barrier. WS-1103 may batch transport, but it may not change decision or application ordering.
- **Prompt structure:** stable persona system prompt first (provider prompt-cache friendly), volatile observation last; prompts versioned; prompt hash in every decision record.
- **Caching:** response cache keyed by `(provider, model, promptVersion, schemaVersion, canonicalRequestHash)`; cache is the reproducibility boundary for live runs (models reject temperature pinning; ADR-0009 documents limits).
- **Validation & retries:** schema-invalid output → 1 repair retry → deterministic Tier 1 fallback action + `agent.action.rejected(reason=llm_invalid)`. Never block the tick on one agent.
- **Budgets:** per-agent per-day token allowance, per-run cost ceiling; exact integer-microcent input/cached-input/output rates; degradation ladder Tier 3→2→1 as budget tightens; auto-pause at 100% (FR-ADM-1). Provider-reported cached input is priced explicitly, while a WorldTangle response-cache hit is free because no request occurs.
- **Rate limits:** global concurrency + provider 429 backoff with jitter from a seeded stream (determinism preserved because ordering is by agentId, not completion).
- **No-LLM mode:** `llm.mode=off|mock|live` — `off` forces Tier ≤1 everywhere; CI uses `mock`.

## 19. User interface requirements

MVP screens (smallest useful subset — M23, Phase 7):

- **UI-1 [MVP] World dashboard:** sim controls (start/pause/resume/step/stop), tick/date, indicator sparklines, live event ticker (SSE), budget meter.
- **UI-2 [MVP] Agent directory + profile:** searchable list; profile with persona, finances (balances, income/expenses), employment, relationships, goals, recent decisions with "why", conversations, memories.
- **UI-3 [MVP] Company pages:** overview, timeline (formation chain), staff, financials, prices/inventory; failure post-mortem view.
- **UI-4 [MVP] Bank & loans:** bank dashboard (deposits, loans outstanding, capital ratio), loan list + detail with full decision explanation.
- **UI-5 [MVP] News feed:** stories with cited events; per-topic sentiment sparkline.
- **UI-6 [MVP] Event & transaction explorer:** filterable log with causality chain viewer ("what caused this?").
- **UI-7 [MVP] Errors & health:** engine errors, rejected intents, LLM failures, quarantines.
- **UI-8 [V1]:** conversation viewer with negotiation terms diff; investments & cap tables; markets (auction results, price charts); policy pages; relationship network graph; scenario editor; run comparison.
- **Explainability rule (NFR-8):** every outcome view has a "Why?" affordance rendering the stored decision/validation/cause-chain data — no raw log dumps as the primary surface.
- **Disclaimer rule:** persistent banner: "Simulated scenario — research tool, not financial, legal, or political advice." Exports carry the same notice in metadata.

## 20. Administrative and debugging tools

- **ADM [MVP]:** run manifest viewer; kill switches (LLM off, agent quarantine, module freeze); budget controls; world-event injector (approved catalog only); prompt/response inspector for any decision (with token counts); replay stepper; determinism self-check (re-hash state vs stateHash events).
- **ADM [V1]:** scenario editor with validation; agent "interview" console (out-of-band Q&A with a persona that does NOT mutate sim state — sandboxed, clearly labeled); event-frequency anomaly alerts.

## 21. Observability and simulation analytics

- Structured logs (JSON) with `simulationId/runId/tick/correlationId` on every line; log levels per module.
- Metrics: ticks/sec, LLM calls & tokens & cost per tick, cache hit rate, rejected-intent rate, event counts by type, per-module timing.
- Traces: per-tick phase spans; per-decision spans (observation build → LLM → validation → apply).
- Analytics store: indicators + event aggregates queryable for charts; export to JSONL/CSV (FR-OBS-7); Parquet [LATER].
- Anomaly checks (V1): conservation drift, runaway conversation counts, price explosion detectors — alerting into the errors dashboard.

## 22. Safety, privacy, and responsible-use requirements

- **SAF-1 [MVP] Simulation labeling:** all UI surfaces and exports carry the simulated-scenario disclaimer; the API returns `"simulated": true` in root metadata. Never present output as prediction or advice (this PRD's mandate; enforced by UI review checklist).
- **SAF-2 [MVP] Synthetic people only:** world generation must not use real persons' names/identities; name lists are synthetic; scenario import validates against configurable blocklists (public figures).
- **SAF-3 [MVP] Prompt-injection defense:** all agent-authored text (messages, memories, news) is untrusted data: fenced/quoted in prompts, never system-level instructions; LLMs have no tools and no state authority (FR-AGT-6); action menus are engine-generated; validation is the hard boundary. Red-team tests include hostile message content attempting to hijack other agents' decisions.
- **SAF-4 [MVP] Cost safety:** budgets + ceilings + auto-pause (FR-ADM-1); no unbounded loops (conversation caps, per-tick decision caps, task-generation caps INV-8).
- **SAF-5 [MVP] Key & data hygiene:** provider keys server-side env only; no telemetry leaves the machine except LLM API calls; event log contains no real personal data by construction (synthetic world).
- **SAF-6 [MVP] Content boundaries:** story/conversation generation prompts constrain content to the economic-social domain; generated content failing schema or containing disallowed categories is dropped and logged.
- **SAF-7 [V1] Research ethics note:** docs include guidance on interpreting results (stylized model, not calibrated to real data) and on not using outputs to make claims about real populations.

## 23. Scalability requirements

- **SCA-1 [MVP]:** 100 agents, 360 ticks, single process, SQLite — comfortable headroom (NFR-1).
- **SCA-2 [V1]:** 1,000 agents: trigger-based thinking keeps LLM calls ≈ O(active agents); matching and indicators O(n log n); event writes batched (1 txn/tick); read API paginates everywhere.
- **SCA-3 [LATER]:** 10,000+ agents / multi-region: engine workers per region partition, Postgres migration (repository seam, ADR-0004), snapshot-shipped read replicas for the dashboard, batch-API LLM scheduling. Module boundaries (IMPLEMENTATION_PLAN) are drawn so M01–M19 can extract to services without API changes.
- **Anti-goals:** no premature microservices, no distributed transactions, no Kafka before event volume demands it (ADR-0002/0003).

## 24. Testing strategy

(Full detail: IMPLEMENTATION_PLAN M26 + per-phase test plans.)

- **Unit tests** per module (Vitest). **Integration tests** per workflow (company formation, loan lifecycle) on in-memory/SQLite stores with mock LLM.
- **Property-based tests** (fast-check): transaction balance, money conservation, allocation exactness, amortization schedule sums, cap-table validity, no-negative-inventory.
- **Simulation invariant suite** (runs after every CI sim): INV-1..INV-10 (§28).
- **Determinism gate:** same seed + mock → identical state & log hashes (Windows + Linux CI matrix).
- **Replay tests:** golden-fixture runs replay to identical hashes; snapshot-resume equals straight-through run.
- **Contract tests:** API responses validate against published JSON Schemas; SSE payloads against event schemas.
- **LLM-output validation tests:** adversarial fixtures (malformed JSON, illegal actions, injection attempts) never mutate state.
- **Frontend tests:** component tests + Playwright E2E on the dashboard happy path (Phase 7).
- **Load tests:** 1,000-agent mock-LLM soak (Phase 11); API read-load smoke.
- **Scenario regression:** golden scenarios with expected indicator envelopes (tolerance bands) to catch economic-rule regressions.

## 25. MVP definition

**In (Phases 1–7):** one town; 25–100 agents; sim clock + scheduler; personas, goals, basic memory; triggers + decision tiers with mock and live LLM; employment + payroll + income tax; personal/business banking; company formation (legal registration, accounts); basic operations (production, posted-price sales, pricing rule); bank loans end-to-end (application → officer review → amortization → repayment/default); simple contracts; conversations (bounded); news generation + sentiment indices; indicators (FR-OBS-2 list); SSE dashboard (UI-1..UI-7); pause/resume/step/replay; audit log; export; budgets + kill switches; mock-LLM deterministic CI.

**Simplified in MVP (explicitly):** housing = fixed rent to ROW; government = static rules + injected changes; energy = tariff pass-through only; school = employer + tuition sink (no skill growth); sentiment = deterministic indices (no per-agent belief network); negotiation = bounded job/purchase dialogues only; single bank; no deposit interest.

**Out of MVP:** securities market, VC, elections, monetary-policy dynamics, international trade beyond ROW, thousands of agents, multi-user auth. (§26.)

## 26. Future versions

- **V1 (Phases 8–10):** VC & investments (FR-INV), call-auction stock market (FR-SEC-1), government policy agents + rule-based monetary authority (FR-GOV-3), run comparison UI, wage negotiation, news consumption effects (FR-NWS-3), multiple banks.
- **LATER:** elections & political groups (FR-GOV-4); housing & real-estate market; demographics (aging, households forming/dissolving); skills & education progression; commodity markets & energy capacity (FR-NRG-2); multi-town regions & migration; public read-only sharing; Postgres deployment; researcher scripting API (sandboxed).
- **NOT-YET (do not build without re-approval):** continuous order books/derivatives/shorting (FR-SEC-2); real-money or real-market data integration; calibration claims against real economies; autonomous LLM control of policy without menus; multi-tenant SaaS. Citizen/agent tool-use, connectors and real accounts are excluded from MVP, V1 and Phase 11. Only after WS-1106 may a separate discovery plan consider a self-hosted, open-source, provider-neutral tool layer; the current architecture reserves no connector tickets or dependencies.

## 27. Risks and open questions

| # | Risk / question | Mitigation / owner |
|---|---|---|
| R1 | LLM cost blow-up at scale | triggers, tiers, budgets, batch API, cache; hard ceilings (FR-ADM-1) |
| R2 | Economic degeneracy: rounding leaks, exploit loops (loan-deposit cycling), price explosions | conservation property tests, circuit breakers (FR-BNK-6, price bands), anomaly detectors |
| R3 | Replay claims break as providers retire/retune models | pin model IDs in manifest; cache-first replay; document limits (ADR-0009) |
| R4 | Event-log growth (millions of rows) | per-tick batched writes, `(runId,seq)`/`(runId,tick)` indexes, export+archive path |
| R5 | Prompt injection via agent content | SAF-3 fencing, no LLM state authority, red-team suite |
| R6 | Believability vs budget: cheap models produce flat personas | routing table per decision weight; evaluation harness (M26) scores persona consistency |
| R7 | One-agent failures stalling ticks | quarantine + fallback tiers (FR-AGT-9) |
| R8 | Scope creep — the simulator can absorb infinite features | this PRD's NOT-YET list; phase exit criteria |
| Q1 | Calibration: should default parameters target stylized realism (unemployment ~5%, etc.)? | INITIAL_WORLD defines target envelopes; revisit after MVP data |
| Q2 | Conversation depth vs cost sweet spot (6 turns enough?) | tune in Phase 6 with telemetry |
| Q3 | Should memory compaction use LLM or stay deterministic in MVP? | start deterministic; A/B in V1 |
| Q4 | Multi-currency / FX ever needed? | not before multi-region (LATER) |

## 28. Acceptance criteria (MVP gate)

The MVP is accepted when all of the following pass on a clean checkout (`pnpm install && pnpm test` + documented manual script):

- **AC-1** A default Riverbend simulation (100 agents, seed 42, mock LLM) runs 360 ticks headless without error; twice in a row it produces **identical** final state hashes and event-log hashes, on Windows and Linux.
- **AC-2** With live LLM enabled and a $2 budget, the same scenario runs until budget auto-pause; no call is made after pause; spend telemetry within 5% of provider-reported usage.
- **AC-3** All simulation invariants hold over the AC-1 run: **INV-1** every transaction balances (Σdebits = Σcredits, integer cents); **INV-2** money conservation — M1 changes only via evented mint/lending/ROW channels; **INV-3** no account below its floor (0 for non-credit accounts); **INV-4** Σ ownership per company = 100% exactly; **INV-5** no employment without a signed agreement; **INV-6** no loan approval without matching asset+liability records; **INV-7** no trade without compatible orders (V1 market); **INV-8** no agent exceeds per-tick action/conversation caps; **INV-9** tick numbers strictly increase, no partial ticks; **INV-10** no actor performs an action outside its permissions.
- **AC-4** Replay of the AC-1 run from manifest + journal + cache reproduces identical hashes; the UI replay stepper walks any tick.
- **AC-5** The full company-formation → loan → operations → (survival|failure) chain occurs in the default scenario within 360 ticks, and every step is explorable in the UI with "why" panels (UC-3/UC-4).
- **AC-6** Injecting the energy-shock world event changes tariffs, CPI, and at least one firm's costs within 30 ticks, all visible in the dashboard (UC-5).
- **AC-7** ≥1 news story per 30 ticks on average; every story cites real event IDs; zero schema-invalid stories published.
- **AC-8** Export (events, transactions, indicators) round-trips: exported transactions re-sum to in-store balances.
- **AC-9** Adversarial LLM-output suite (malformed/illegal/injection fixtures) produces zero invalid state changes and 100% recorded rejections.
- **AC-10** All UI surfaces display the simulated-scenario disclaimer; API root metadata includes `"simulated": true`.

---

*This PRD is the single source of truth for scope. Changes require updating this document and, where architectural, a new/amended ADR.*
