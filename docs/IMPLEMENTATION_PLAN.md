# WorldTangle — Architecture & Implementation Plan

Companion to [PRD.md](PRD.md), [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [API_CONTRACTS.md](API_CONTRACTS.md), [TASK_BACKLOG.md](TASK_BACKLOG.md), and [ADRs](adr/README.md).

## 1. Architecture overview

**Repository was empty** → greenfield decision (rationale in ADR-0001/0002): a **TypeScript modular monolith** in a pnpm-workspaces monorepo on Node 24.

```
worldtangle/
├── packages/shared     # pure primitives: money, RNG, codec, envelopes, error codes
├── packages/engine     # deterministic simulation core: M01–M19 as internal modules
├── apps/server         # M22 API + M24 admin endpoints + M20 wiring (SQLite)
└── apps/web            # M23 React/Vite real-data shell; domain views grow by phase
```

Key structural rules (enforced by package boundaries, lint, and review):

1. **Deterministic core.** `packages/engine` contains no I/O, no `Date.now`, no `Math.random`, no direct LLM calls. Ports (interfaces) for persistence, LLM, and time are injected. Everything inside runs identically given the same inputs (ADR-0008).
2. **Single write path.** All state changes flow through one `apply(intent) → {stateChanges, events}` choke point per module, committed atomically with their events (ADR-0003).
3. **Events are the nervous system.** Modules communicate through a synchronous, deterministic in-process bus; every published event is appended to the immutable log. Subscribers never mutate state directly in handlers — they enqueue intents/tasks for defined phases.
4. **LLM at the edge.** M21 is the only module that talks to a provider. It returns *proposals* which M04 turns into intents. Proposals that fail validation simply never become state.
5. **Money is sacred.** Only M09 writes `Transaction` rows; every other module requests postings via its interface. All amounts integer cents (`bigint`), all rates fixed-point bp (ADR-0013).

**Module = folder with a public `index.ts`.** Cross-module imports of anything but `index.ts` are lint errors. This keeps later extraction (worker threads per region, or services) mechanical (ADR-0002).

---

## 2. Module catalog

Format per module — **Responsibility · Owns · Must NOT own · Interface · Inputs/Outputs · Publishes/Consumes · Deps · Failure behavior · Testing · MVP scope · Later**.

### M01 — Simulation Clock & Event Scheduler
- **Responsibility:** Run lifecycle (created/running/paused/…), the tick loop with its 9 ordered phases (PRD §6), the priority-queue scheduler for future tasks, run manifests.
- **Owns:** SimulationRun, RunManifest, scheduled-task queue, tick counter, sim-calendar math (360-day year).
- **Must NOT own:** any domain entity; what tasks *do* (owning modules register handlers).
- **Interface:** `createRun(scenario, seed)`, `start/pause/resume/stop(runId)`, `advance(runId, n)`, `schedule(runId, tick, taskRef)`, `PhaseHook` registration `registerPhase(phase, moduleHandler, order)`.
- **Inputs:** control commands (journaled), scenario config. **Outputs:** phase callbacks, lifecycle + tick events.
- **Publishes:** `simulation.created/started/paused/resumed/stopped`, `simulation.tick.started/completed`, `admin.command.received`. **Consumes:** budget-exhausted events (auto-pause).
- **Deps:** M20 (persist run state), shared.
- **Failure behavior:** any unhandled phase error → abort tick, roll back to last committed tick, run → `paused` with `system.error.raised` (never half-applied ticks, FR-SIM-4).
- **Testing:** calendar math unit tests; scheduler ordering property tests; kill-mid-tick recovery test; state-machine transition table test.
- **MVP:** everything above. **Later:** wall-clock pacing modes, multi-run parallel execution, region-partitioned loops.

### M02 — Agent Identity & Persona
- **Responsibility:** Agent + Persona records, occupation/skill catalogs, world-gen instantiation of agents from INITIAL_WORLD templates, relationship seeding.
- **Owns:** Agent (identity core), Persona, Occupation/Skill catalogs, initial Relationship graph.
- **Must NOT own:** balances, employment status transitions (M07), memory (M03), opinions (M15).
- **Interface:** `generatePopulation(worldSpec, rngStream)`, `getAgent/getPersona(id)`, `personaPromptBlock(id, promptVersion)` (the stable cached prompt prefix).
- **Publishes:** `agent.created`. **Consumes:** —.
- **Deps:** shared RNG/codec, M20.
- **Failure behavior:** world-gen is all-or-nothing: any validation failure aborts run creation with a report (no partial populations).
- **Testing:** generation-determinism (same seed → same population); distribution tests (occupation/income/age within INITIAL_WORLD envelopes); name-blocklist test.
- **MVP:** full. **Later:** demographics (aging, new agents), migration between regions.

### M03 — Agent Memory & Knowledge
- **Responsibility:** Append-only per-agent memory stream, salience scoring, top-k retrieval for observations, deterministic compaction.
- **Owns:** Memory records + retrieval index.
- **Must NOT own:** decision logic; world facts (those are events/state — memory stores an agent's *view*).
- **Interface:** `record(agentId, memory)`, `retrieve(agentId, context, k)`, `compact(agentId)`.
- **Publishes:** none (memory writes are not world events; compaction emits `agent.memory.compacted` telemetry). **Consumes:** decision outcomes, conversation summaries, salient events routed by M04/M05.
- **Deps:** M20; M21 only for [V1] LLM compaction (MVP compaction is templated).
- **Failure behavior:** retrieval failure degrades to persona-only observation (decision still proceeds); never blocks a tick.
- **Testing:** retrieval determinism; bound-enforcement (memory count cap); compaction preserves references; relevance scoring golden tests.
- **MVP:** rule-scored salience, template compaction. **Later:** embedding-based retrieval, LLM reflection memories.

### M04 — Agent Decision Engine
- **Responsibility:** Trigger evaluation (who wakes), observation building, tier selection, action menus, LLM proposal handling, intent validation orchestration, Decision/AgentAction records, quarantine.
- **Owns:** Decision, AgentAction, trigger rules, action catalog (schemas per action type), per-agent decision caps.
- **Must NOT own:** domain validation rules (each domain module validates its own intents); LLM transport (M21).
- **Interface:** `evaluateTriggers(tick) → wakeSet`, `decide(agentId, trigger) → intents`, `registerActionType(type, schema, validator, executor)` (domain modules register), `quarantine(agentId, until)`.
- **Inputs:** triggers, observations (from M02/M03/domain read models), LLM proposals. **Outputs:** validated intents to executors.
- **Publishes:** `agent.action.started/completed/rejected`, `agent.quarantined`. **Consumes:** messages, payroll shortfalls, news relevance, policy changes, goal activations (trigger sources).
- **Deps:** M02, M03, M21, all domain modules (via registered action types).
- **Failure behavior:** LLM invalid/timeout → 1 repair retry → Tier 1 fallback rule → if that fails, no-op + rejection record. N consecutive failures → quarantine (FR-AGT-9). A single agent can never stall the tick.
- **Testing:** adversarial LLM-output suite (AC-9); tier-routing table tests; fallback-ladder tests; cap enforcement (INV-8); mock-LLM end-to-end decision tests.
- **MVP:** Tiers 0–2 + bounded Tier 3 for conversations. **Later:** planning (multi-step task graphs, with cycle caps), theory-of-mind context.

### M05 — Agent Communication & Negotiation
- **Responsibility:** Conversations, messages, structured-terms negotiation protocol, outcome extraction, inboxes, relationship-strength updates, anti-loop protections.
- **Owns:** Conversation, Message, inbox queues, Relationship.strength updates.
- **Must NOT own:** the binding consequences (contracts/investments — those modules validate final terms).
- **Interface:** `open(participants, topic, trigger, budget)`, `deliver(msg)`, `step(conversationId)` (called in decision phase), `extractOutcome(conversationId)`.
- **Publishes:** `conversation.started`, `conversation.message.created`, `conversation.ended`. **Consumes:** intents `send_message/open_conversation` from M04.
- **Deps:** M04, M21, M02/M03 (context).
- **Failure behavior:** budget/turn cap hit → force-close with deterministic `no_agreement` outcome; no-progress detector force-closes; malformed message content dropped with rejection event.
- **Testing:** turn/budget cap tests; no-progress detection; outcome-extraction schema tests; injection red-team fixtures (hostile message content must not alter another agent's action menu — SAF-3).
- **MVP:** 2-party conversations ≤6 turns, purchase/job topics. **Later:** group conversations, standing relationships chat, rumor propagation.

### M06 — Household & Personal Finance
- **Responsibility:** Households, needs, Tier-0 consumption (subsistence basket, discretionary rule), personal budget policy, financial-stress triggers.
- **Owns:** Household, Need levels, consumption rules.
- **Must NOT own:** account balances (M09), goods fulfillment (M12).
- **Interface:** `consumptionPlan(householdId, tick) → orders`, `assessStress(agentId) → trigger?`.
- **Publishes:** consumption intents; `household.stress.detected` (trigger source). **Consumes:** payroll events, price updates, policy changes (benefit).
- **Deps:** M09 (balances read), M12 (place orders), M16 (benefit policy).
- **Failure behavior:** cannot afford subsistence → partial basket by priority (food > utilities > discretionary), stress trigger; never negative balances.
- **Testing:** budget-rule property tests (spend ≤ available); basket-priority tests; stress-trigger thresholds.
- **MVP:** full (rent fixed to ROW). **Later:** housing market, household formation/dissolution, savings products.

### M07 — Employment & Labor Market
- **Responsibility:** Job postings, applications, deterministic matching, employment contracts, payroll orchestration, terminations, unemployment benefit eligibility.
- **Owns:** Job, EmploymentContract, Agent.employmentStatus, labor-match rules, payroll schedule.
- **Must NOT own:** payroll postings (requests M09), benefit funding decisions (M16 policy).
- **Interface:** `postJob(employer, spec)`, `apply(agentId, jobId)`, `runMatching(tick)`, `runPayroll(tick)`, `terminate(contractId, reason)`.
- **Publishes:** `employment.created/terminated`, `payroll.executed`. **Consumes:** company failure events (mass termination), policy changes (min wage).
- **Deps:** M08 (employers), M09 (postings), M11 (contract records), M16 (policies).
- **Failure behavior:** employer cannot fund payroll → automatic missed-payroll event → triggers layoffs/insolvency path in M08; matching never creates a contract without both parties' intents.
- **Testing:** matching determinism + fairness (ordering by score then agentId); payroll multi-leg balance property tests; withholding math golden tests; INV-5 checks.
- **MVP:** full with single-job constraint. **Later:** part-time, gig work, wage negotiation (Tier 3), promotions.

### M08 — Company Formation & Operations
- **Responsibility:** Company lifecycle (forming→…→failed), production, inventory, offerings/pricing, business accounting views, insolvency detection, wind-down.
- **Owns:** Company, Inventory, offerings/posted prices, CompanyDepartment [V1], production rules.
- **Must NOT own:** cap table (M10), transactions (M09), legal records (M11), goods catalog (M12).
- **Interface:** `foundCompany(intent)`, `produce(companyId, tick)`, `setPrice(intent)`, `assessSolvency(companyId)`, `windDown(companyId)`.
- **Publishes:** `company.created/failed`, `market.price.updated` (goods), stockout events. **Consumes:** sales orders (M12), payroll results, loan events, energy tariffs.
- **Deps:** M09, M10, M11, M12, M07, M17.
- **Failure behavior:** insolvency → deterministic wind-down (FR-CO-4); a company failure never leaves dangling contracts/accounts (post-conditions asserted).
- **Testing:** formation-chain integration test; production/inventory property tests (never negative); wind-down completeness test (creditor waterfall sums); pricing-rule golden tests.
- **MVP:** single-product firms, linear production. **Later:** multi-product, supply chains between local firms, capex, departments.

### M09 — Banking, Deposits, Credit & Loans
- **Responsibility:** Banks, accounts, THE transaction ledger (double-entry), credit scoring, loan underwriting flow, amortization, collections/default, circuit breakers.
- **Owns:** Bank, BankAccount, **Transaction**, LoanApplication, Loan, Payment, credit-score model, mint/ROW settlement authority.
- **Must NOT own:** why someone wants money (borrower context read-only), fiscal policy (M16).
- **Interface:** `openAccount(owner, type)`, `post(transactionRequest) → txn` (validated, idempotent), `balance(accountId)`, `applyForLoan(intent)`, `reviewApplication(appId, officerProposal)`, `disburse(loanId)`, `collectInstallments(tick)`.
- **Publishes:** `account.opened`, `transaction.posted`, `loan.application.created`, `loan.approved/rejected`, `loan.disbursed`, `loan.payment.completed/missed`, `loan.defaulted`. **Consumes:** payroll/tax/purchase posting requests from all modules.
- **Deps:** M20; M04 (officer decisions arrive as bounded proposals).
- **Failure behavior:** any posting failing validation is rejected atomically (no partial legs); duplicate idempotency keys ignored with warning event; breaker breach → lending halted with event, never impossible balances.
- **Testing:** THE property-test hotspot — INV-1/2/3/6 over arbitrary operation sequences; amortization golden + property tests (Σ principal exact); idempotency tests; breaker stress tests.
- **MVP:** one bank, checking accounts, personal+business term loans. **Later:** deposit interest, multiple banks + interbank, credit lines, restructuring.

### M10 — Venture Capital & Investment [V1]
- **Responsibility:** VC firms/funds, pitch→negotiation→closing pipeline, cap tables (incl. founder equity from MVP day 1), dividends/exits.
- **Owns:** VentureCapitalFirm, InvestmentProposal, Investment, OwnershipStake.
- **Must NOT own:** negotiation transport (M05), company ops.
- **Interface:** `recordFoundingEquity(companyId, founder, shares)` (MVP), `propose(intent)`, `close(proposalId, finalTerms)`, `distribute(companyId, amount)` (pro-rata largest-remainder).
- **Publishes:** `investment.proposed/completed/rejected`. **Consumes:** conversation outcomes (M05), company events.
- **Deps:** M05, M08, M09, M11.
- **Failure behavior:** terms failing cap-table math → proposal rejected with validation detail; closing is atomic (txn + shares + contract) or nothing.
- **Testing:** cap-table property tests (INV-4, Σ=100%); dilution math golden tests; allocation exactness.
- **MVP scope:** founding equity records only. **V1:** full pipeline. **Later:** follow-on rounds, secondaries, funds-of-funds.

### M11 — Contracts & Legal Process
- **Responsibility:** LegalContract records for all agreement types, drafting via law firm (fees), signature collection, obligation scheduling, breach detection, terminations.
- **Owns:** LegalContract (+ obligations), contract templates per type, breach predicates.
- **Must NOT own:** hot-path copies (M07 employment, M09 loans — linked by `legalContractId`).
- **Interface:** `draft(type, parties, terms) → contract(fee)`, `sign(contractId, partyIntent)`, `scheduleObligations(contractId)`, `evaluateBreaches(tick)`, `terminate(contractId, reason)`.
- **Publishes:** `contract.drafted/signed/terminated/breached`. **Consumes:** obligation task firings (M01 scheduler), payment outcomes.
- **Deps:** M01, M09 (fees, damages).
- **Failure behavior:** unsigned contracts expire after N ticks; breach handling is rule-based (damages transfer or termination), never free-form.
- **Testing:** state-machine tests; all-party-signature enforcement; obligation firing integration tests; template schema tests.
- **MVP:** incorporation, employment, loan, service, lease types; deterministic breach rules. **Later:** disputes/arbitration (Tier 3), custom clauses.

### M12 — Goods, Services, Production & Consumer Market
- **Responsibility:** Product/Service catalog, posted-price order flow (buy validation → inventory + funds), ROW supplier/buyer channel, goods price history, CPI basket definition.
- **Owns:** Product catalog, goods Orders, goods PriceHistory, ROW reference prices & settlement authority (with M09).
- **Must NOT own:** inventory quantities (M08), posted prices (M08 offerings), household budgets (M06).
- **Interface:** `placeOrder(buyer, seller, sku, qty)`, `rowBuy/rowSell(companyId, sku, qty)`, `referencePrices(tick)`.
- **Publishes:** goods `market.order.created`, order filled/rejected events, stockouts. **Consumes:** consumption plans (M06), production output (M08), world events (ROW shocks).
- **Deps:** M08, M09, M06.
- **Failure behavior:** stockout/insufficient funds → deterministic rejection (partial fills by priority for subsistence baskets); ROW channel always liquid at reference prices (documented sink/source).
- **Testing:** order settlement atomicity; basket fulfillment priority tests; ROW conservation accounting tests.
- **MVP:** 7-SKU catalog (groceries, meals, durable goods, repair services, healthcare visit, tuition, electricity). **Later:** local supply chains, quality tiers, advertising.

### M13 — Stock Market & Securities [V1]
- **Responsibility:** Listings, order intake with escrow, daily call auction, clearing/settlement orchestration, price bands, securities price history.
- **Owns:** Market, Security, StockOrder, Trade, securities PriceHistory.
- **Must NOT own:** cash/share ownership records (settles via M09/M10 interfaces).
- **Interface:** `list(companyId)`, `placeOrder(intent)`, `cancel(orderId)`, `runAuction(securityId, tick)`.
- **Publishes:** `security.listed`, `market.order.created/cancelled`, `market.trade.executed`, `market.price.updated`. **Consumes:** trader intents, company events (delisting on failure).
- **Deps:** M09, M10, M08.
- **Failure behavior:** no compatible orders → no trade, price unchanged (evented); band breach → orders outside band rejected at placement; settlement failure (should be impossible due to escrow) → trade voided + alarm.
- **Testing:** clearing-price property tests (volume-maximizing, deterministic tie-breaks); INV-7; escrow tests (no naked orders); band tests.
- **MVP:** none. **V1:** call auction, limit orders. **NOT-YET:** continuous book, margin, shorting, derivatives.

### M14 — News & Media
- **Responsibility:** Notable-event digest (deterministic newsworthiness scoring), journalist story pipeline (LLM, strict schema, event citations), editor rules, publication, reach computation.
- **Owns:** NewsOrganization, NewsStory, newsworthiness scoring rules, publication caps.
- **Must NOT own:** sentiment values (M15), event log (M20).
- **Interface:** `digest(tick) → candidates`, `writeStories(tick)`, `publish(storyDraft)`.
- **Publishes:** `news.story.published`. **Consumes:** all domain events (digest input), world events.
- **Deps:** M21, M02 (journalist personas), M15 (downstream).
- **Failure behavior:** schema-invalid or cap-exceeding drafts → spiked with log, never published (FR-NWS-1); LLM off → template headlines from event facts (deterministic fallback).
- **Testing:** citation-integrity tests (every story cites real events); schema fuzzing; cap tests; fallback-mode tests.
- **MVP:** single org, 2–3 journalists, ≤3 stories/day. **Later:** competing outlets with slants, subscriptions, misinformation experiments (behind explicit scenario flag).

### M15 — Public Sentiment & Opinion
- **Responsibility:** Topic sentiment indices (deterministic update from stories/events), agent Opinion values and bounded drift, decision-prior modulation weights.
- **Owns:** SentimentIndex, Opinion (incl. beliefs).
- **Must NOT own:** stories (M14), decisions (M04 — it only supplies bounded weight modifiers).
- **Interface:** `update(tick)`, `sentiment(topic)`, `opinion(agentId)`, `priorModifiers(agentId, decisionKind) → bounded deltas`.
- **Publishes:** `sentiment.updated`, `agent.opinions.updated`. **Consumes:** `news.story.published`, salient personal-outcome events, conversation outcomes.
- **Deps:** M14, M02.
- **Failure behavior:** none critical — worst case sentiment freezes at last value (evented warning).
- **Testing:** update-rule golden tests; bound enforcement (|Δ| caps); attribution completeness (every delta has a cause).
- **MVP:** 3 FR-NWS-2 public topic indices, deterministic rules, and conservative four-axis opinion drift. **Later:** per-agent media diets, belief networks, persuasion experiments.

### M16 — Government, Regulation, Taxation & Policy
- **Responsibility:** Policy registry (versioned levers), tax assessment (withholding, corporate), treasury, benefits, government payroll; [V1] bounded policy proposals + rule-based monetary authority.
- **Owns:** GovernmentInstitution, Policy, Tax records; Election/PoliticalGroup [LATER].
- **Must NOT own:** treasury postings execution (M09), policy *effects* (owning modules read policy values).
- **Interface:** `policy(key, tick)`, `assessIncomeWithholding(gross)`, `assessCorporateTax(profit)`, `payBenefits(tick)`, `applyPolicyChange(change)` (admin/scenario only in MVP).
- **Publishes:** `policy.changed`, `tax.collected`. **Consumes:** payroll events (withholding), quarterly closes, world events.
- **Deps:** M09, M01.
- **Failure behavior:** treasury empty → benefits suspended with event (no money creation, FR-GOV-1); invalid policy change rejected against per-key ranges.
- **Testing:** tax math golden tests (mulDiv HALF_EVEN); treasury no-overdraft property; policy-boundary tests; effective-tick application tests.
- **MVP:** static rules + admin changes. **V1:** proposal menus + Taylor-lite base rate. **LATER:** elections.

### M17 — Energy & Commodity System
- **Responsibility:** Utility tariffs (household flat, business per-unit), fuel purchasing from ROW, deterministic pass-through rule, energy billing hooks.
- **Owns:** tariff schedule, pass-through rule, fuel cost state (utility company's operational data).
- **Must NOT own:** the utility's accounts/transactions (M09), company mechanics (it *is* an M08 company with an extra rule pack).
- **Interface:** `tariff(customerClass, tick)`, `billCycle(tick)`, `applyFuelShock(params)`.
- **Publishes:** tariff-updated events (as `market.price.updated` sku=electricity). **Consumes:** `world.event.injected` (energy shocks), production volumes.
- **Deps:** M08, M09, M12, M19.
- **Failure behavior:** shocks clamp to configured min/max tariffs; billing failures follow standard order-rejection path.
- **Testing:** pass-through golden tests (shock → tariff → CPI propagation, AC-6); billing balance tests.
- **MVP:** as above. **Later:** generation capacity, outage events, commodity spot market (FR-NRG-2).

### M18 — Macroeconomic Metrics
- **Responsibility:** Compute the indicator set per tick from state + transaction aggregates; publish snapshots; maintain history.
- **Owns:** EconomicIndicator series + formulas (versioned).
- **Must NOT own:** any source data.
- **Interface:** `computeIndicatorSnapshot(tick)`, `series(name, range)`, `latest()`.
- **Publishes:** `economic.metrics.updated`. **Consumes:** transactions, employment events, price history, sentiment.
- **Deps:** read models of M07/M08/M09/M12/M15.
- **Failure behavior:** source or formula validation failure aborts the metrics phase and rolls back the complete ten-point batch; partial ticks are never published.
- **Testing:** formula goldens on fixture worlds, authoritative recompute/API integration, immutable evidence, migration/reopen, shock propagation, and snapshot equivalence.
- **MVP:** all 10 PRD FR-OBS-2 series are implemented with formula-version and canonical-input evidence. **Later:** Gini, sectoral GDP, flow-of-funds matrix, expectations indices.

### M19 — Scenario & World-Event System
- **Responsibility:** Scenario config schema/versioning, approved world-event catalog, injection validation, scheduled event firing, effect dispatch to owning modules.
- **Owns:** WorldEvent records, event catalog (param schemas per type), scenario mutation journal.
- **Must NOT own:** the effects themselves (each owning module registers an effect handler).
- **Interface:** `inject(runId, event)` (validates + journals), `scheduleFromScenario(runId)`, `registerEffectHandler(type, module)`.
- **Publishes:** `world.event.injected`. **Consumes:** admin commands, scenario schedules.
- **Deps:** M01, all effect-owning modules.
- **Failure behavior:** unknown type/invalid params → rejected at API; a failing effect handler aborts the tick like any phase error (atomicity).
- **Testing:** catalog schema tests; injection-while-running rejection test; effect-propagation integration tests per event type.
- **MVP:** 4 event types (energy shock, ROW price shift, demand shock, business disaster stub). **Later:** compound scenarios, stochastic event streams (seeded).

### M20 — Persistence & Database Layer
- **Responsibility:** SQLite storage (better-sqlite3), migrations, repositories per aggregate, append-only event store, snapshots (backup API), state hashing, resume-from-snapshot.
- **Owns:** schema/migrations, EventRecord storage, Snapshot records, transaction-boundary helper (`commitTick`).
- **Must NOT own:** domain semantics; no business rules in SQL.
- **Interface:** repository interfaces per aggregate (defined here, consumed by modules), `appendEvents(batch)`, `commitTick(stateChanges, events)`, `snapshot(runId)`, `restore(snapshotId)`, `stateHash(runId)`.
- **Publishes:** `simulation.snapshot.created`, `simulation.statehash.computed`. **Consumes:** —.
- **Deps:** shared codec.
- **Failure behavior:** any commit failure rolls back the whole tick; snapshot writes atomic (temp+fsync+rename); WAL mode; DB corruption → refuse to start, point to last snapshot.
- **Testing:** commit atomicity (kill tests); migration up/down tests; event-store append-only enforcement; snapshot/restore hash-equality tests; bigint round-trip tests (`defaultSafeIntegers`).
- **MVP:** SQLite. **Later:** Postgres adapter behind the same repositories (ADR-0004), read replicas, Parquet export.

### M21 — LLM Provider & Model-Routing Layer
- **Responsibility:** Provider abstraction; MiniMax + Kimi + legacy Anthropic + Mock adapters; routing table (tier→model); structured-output enforcement; response cache; budgets/ceilings; rate limiting/backoff; telemetry records.
- **Owns:** LlmCallRecord, response cache, routing config, budget counters, prompt-pack version registry.
- **Must NOT own:** prompt *content* semantics (M04/M05/M14 build prompts), world state.
- **Interface:** `propose(request: {purpose, tier, agentId?, promptParts, schema, budgetTag}) → proposal | fallback-signal`, `spend(runId)`, `setMode(off|mock|live)`.
- **Publishes:** `llm.budget.threshold`, telemetry. **Consumes:** —.
- **Deps:** shared codec (request hashing); provider SDK at the edge only.
- **Failure behavior:** schema-invalid → 1 repair retry → typed fallback signal (caller runs Tier 1); provider errors → bounded backoff then fallback; budget exhausted → `budget_blocked` signals + auto-pause request at 100% (FR-ADM-1). Never throws into the engine.
- **Testing:** mock-adapter determinism tests; cache-key stability golden tests; budget/ceiling enforcement; retry-ladder tests; live smoke test (manual, not CI).
- **MVP:** MiniMax M3 Tier 2 + Kimi K2.x Tier 3 + Mock, cache, exact cached-token-aware budgets and pinned routing. **Later:** batch-API scheduling and embedding models (for M03). Anthropic remains a legacy adapter, not the default route.

### M22 — Backend API Layer
- **Responsibility:** REST /api/v1 (Fastify + Zod), SSE stream, RFC 9457 errors, cursor pagination, auth hook (bearer optional), OpenAPI generation, contract enforcement.
- **Owns:** HTTP schemas/DTOs (versioned), SSE digest assembly.
- **Must NOT own:** business logic — thin adapters over module interfaces; no direct DB access except read models exposed by M20/M25.
- **Interface:** [API_CONTRACTS.md](API_CONTRACTS.md) is the contract.
- **Publishes:** — (journals admin commands via M01/M19). **Consumes:** `simulation.tick.completed` (SSE digests).
- **Deps:** M01, M19, M24, read models, M25.
- **Failure behavior:** engine busy/paused → correct 409s; all errors problem+json with correlationId; SSE reconnect via `Last-Event-ID`.
- **Testing:** `fastify.inject` endpoint tests; schema contract tests (responses validate against published schemas); pagination determinism tests; SSE replay tests.
- **MVP:** endpoints marked MVP in API_CONTRACTS. **Later:** auth/multi-user, rate limiting, public read-only mode.

### M23 — Frontend Application
- **Responsibility:** React 19 + Vite dashboard (PRD §19): controls, directory/profile, company/bank/loan/news/event views, explainability panels, disclaimers.
- **Owns:** UI state, SSE client, API client (generated from schemas).
- **Must NOT own:** any computation of record — displays what the API explains; no client-side economics.
- **Interface:** consumes API_CONTRACTS only (no engine imports).
- **Deps:** M22.
- **Failure behavior:** SSE drop → auto-reconnect + catch-up fetch; API errors surfaced with correlationId for debugging.
- **Testing:** component tests (Vitest+RTL); Playwright happy path (Phase 7): create → run → observe agent → explain a loan.
- **MVP:** UI-1..UI-7. **Later:** UI-8 set (network graph, comparisons, scenario editor).

### M24 — Simulation Administration Tools
- **Responsibility:** Admin surface: run manifest viewer, kill switches (LLM off/agent quarantine/module freeze), budget controls, world-event injector UI/API glue, prompt inspector, determinism self-check trigger.
- **Owns:** admin command journal semantics (with M01), kill-switch state.
- **Must NOT own:** the mechanisms (switches flip flags owned by M21/M04/M19).
- **Interface:** admin endpoints in API_CONTRACTS §3.9; `selfCheck(runId)`.
- **Publishes:** `admin.command.received`. **Consumes:** —.
- **Deps:** M01, M04, M19, M21, M25.
- **Failure behavior:** admin commands validated + journaled before effect; unknown commands rejected.
- **Testing:** switch effect tests (LLM-off actually stops calls); journal-before-effect ordering test.
- **MVP:** all switches + injector + manifest viewer (API-first; UI minimal). **Later:** scenario editor UI, interview console (sandboxed).

### M25 — Analytics, Logs, Traces & Replay
- **Responsibility:** Structured logging (pino) with run/tick/correlation context; per-phase timing + LLM metrics; event/transaction read models for the API; export jobs (JSONL/CSV); replay executor (manifest + journal + cache → re-run) and divergence detection.
- **Owns:** read models/aggregations, export jobs, replay orchestration.
- **Must NOT own:** the event log itself (M20), indicator formulas (M18).
- **Interface:** `export(runId, spec) → job`, `replay(runId, {toTick}) → replayRun`, `compare(runA, runB, metrics)`, query APIs for explorers.
- **Publishes:** export/replay lifecycle events. **Consumes:** everything (read-only).
- **Deps:** M20, M01 (replay drives a fresh run), M21 (cache).
- **Failure behavior:** replay divergence (stateHash mismatch) → halt replay, report first divergent tick + cause diff; export jobs resumable.
- **Testing:** golden replay fixtures (CI); export round-trip sum tests (AC-8); comparison alignment tests.
- **MVP:** logs/metrics, exports, replay, self-check. **Later:** run comparison UI backing, anomaly alerting, Parquet.

### M26 — Testing & Evaluation Framework
- **Responsibility:** Test harness utilities: world fixtures, scenario builders, mock-LLM script kits, invariant checker (INV-1..10 as a reusable suite run after any sim test), property-test generators (money ops, order flows), benchmark runner, persona-consistency evaluation harness [V1].
- **Owns:** test utilities, golden fixtures, CI determinism gate.
- **Must NOT own:** production code paths.
- **Interface:** `buildWorld(spec)`, `runSim(opts)`, `checkInvariants(run)`, `expectEvents(...)` matchers.
- **Deps:** everything (dev-only).
- **Failure behavior:** n/a (it IS the failure detector).
- **Testing:** meta-tests for the invariant checker (seeded violations must be caught).
- **MVP:** invariant suite, determinism gate, fixtures, mock kits. **Later:** LLM-judge evaluation of persona consistency, scenario regression farm.

---

## 3. Phased roadmap

Rules: each phase ends **runnable + tests green**; no phase starts before its dependencies' exit criteria pass; every phase updates docs + backlog status.

### Phase 0 — Repository analysis & architecture decisions ✅ (this deliverable)
- **Goal:** Decide stack/architecture; produce full documentation suite; scaffold foundation kernel.
- **Features:** none user-facing. **Modules:** repo layout for all.
- **Backend:** foundation kernel (shared money/RNG/codec/envelopes; engine bus/clock skeleton/event-log interface/mock LLM; server health endpoint). **Frontend:** none. **API:** `/api/v1/health`. **DB:** none (in-memory).
- **Tests:** money/RNG/codec property tests, determinism smoke gate, bus/log tests, health inject test.
- **Exit criteria:** `pnpm install && pnpm test && pnpm typecheck` green on Windows; docs complete.
- **Deps:** —. **Risks:** over-scaffolding (mitigated: kernel-only file list).

### Phase 1 — Domain models, persistence, simulation clock, event log
- **Goal:** A run can be created, started, ticked (empty phases), paused, resumed, snapshotted, resumed-from-snapshot — fully persisted.
- **Features:** run lifecycle end-to-end (no agents yet).
- **Modules:** M01, M19 (journal only), M20, M22 (lifecycle endpoints), M24 (command journal), M25 (logging), M26 (harness v1).
- **Backend:** better-sqlite3 + migrations; repositories; `commitTick`; event store; snapshots + stateHash; scheduler; run state machine; run manifest.
- **Frontend:** the M23 shell was pulled forward: simulation library/create form, lifecycle cockpit, status/digest counts, connection state, and durable event ledger against current APIs; indicator charts remain deferred. **API:** simulations CRUD + controls + status + events endpoint + SSE v0. **DB:** initial schema (runs, events, snapshots, scheduled_tasks).
- **Tests:** kill-mid-tick atomicity; snapshot/restore hash equality; append-only enforcement; state-machine table; calendar/scheduler properties.
- **Exit criteria:** create→start→advance 100 empty ticks→pause→snapshot→restore→advance = identical hashes vs straight-through; all persisted.
- **Deps:** Phase 0. **Risks:** commit-boundary design errors (mitigate: kill tests early).

### Phase 2 — Agent framework & deterministic decision testing
- **Goal:** Population generation + trigger/decision pipeline running entirely on Tier 0/1 (no LLM), with decisions/actions/audit records.
- **Features:** 100 agents generated per INITIAL_WORLD; goals; memory writes; rule decisions visible in API.
- **Modules:** M02, M03, M04 (Tiers 0–1), M26.
- **Backend:** world-gen from templates; trigger evaluator; action catalog registry; Decision/AgentAction records; quarantine plumbing.
- **Frontend:** none (API-first). **API:** agents list/profile/decisions endpoints. **DB:** agents, personas, goals, memories, relationships, decisions, actions.
- **Tests:** generation determinism + distribution envelopes; trigger determinism; adversarial action-params fuzzing (validation holds with NO LLM in the loop yet).
- **Exit criteria:** 360-tick run with rule-only agents completes; AC-9 style fuzzing green; population stats within INITIAL_WORLD envelopes.
- **Deps:** Phase 1. **Risks:** trigger over-firing (cap + telemetry from day 1).

### Phase 3 — Employment, households, money, and transactions
- **Status (2026-07-15):** WS-301–WS-310 complete, including real finance and employment sparklines.
- **Goal:** The money system live: accounts, double-entry ledger, payroll with withholding, household consumption to ROW-stub sellers, benefits.
- **Features:** agents earn, spend, save; treasury collects withholding; unemployment benefit.
- **Modules:** M06, M07 (payroll, pre-matching), M09 (accounts+transactions), M12 (ROW-stub goods), M16 (static policies), M18 (first indicators).
- **Backend:** ledger + idempotency; payroll engine; consumption planner; benefit payer; indicator set v1 (m1, avgWage, treasury, unemployment).
- **Frontend:** the existing shell now renders the four committed indicator series in real finance/employment panels without synthesizing data. **API:** transactions, indicators, banks/accounts read endpoints; digest carries indicators. **DB:** banks, accounts, transactions, jobs (static), employment_contracts (seeded), taxes, policies.
- **Tests:** INV-1/2/3 property suite live in CI; payroll multi-leg golden tests; conservation over 360 ticks.
- **Exit criteria:** 360-tick run: zero invariant violations; indicators plot sanely (no NaN/negative M1); dashboard shows live ticks.
- **Deps:** Phase 2. **Risks:** rounding leaks (property tests + conservation sweep).

### Phase 4 — Companies, hiring, production, and business accounting
- **Status (2026-07-15):** complete (WS-401–WS-409); the 360-tick company, energy-shock, failure, API, and UI gate is green.
- **Goal:** Full company lifecycle with real labor market: formation chain, production, posted-price sales to households, pricing rule, insolvency wind-down.
- **Features:** UC-3 without the loan; job postings + matching + quits/layoffs.
- **Modules:** M07 (matching), M08, M11 (incorporation/service/lease), M12 (real sellers), M17 (tariffs v1).
- **Backend:** legal contracts, formation, labor matching, capacity-bounded production, nonnegative inventory, buyer-validated posted-price sales, stockouts, real-seller household groceries, weekly inventory/sales pricing, bounded founder overrides, RP&L tariffs, household/business energy billing, ROW fuel purchasing, deterministic pass-through, daily solvency assessment, complete atomic wind-down, and the bounded four-type world-event catalog with scheduled effect dispatch are implemented.
- **Frontend:** the World Explorer ships company, contract, job, institution, goods-market, and citizen employment/finance routes with complete formation, financial, solvency, and wind-down why-panels. **API:** strict shared contracts expose companies, contracts, jobs, institutions, and the goods market through run-bound deterministic reads. **DB:** companies, inventory, offerings, orders, legal_contracts, price_history; WS-409 adds no authoritative tables.
- **Tests:** formation-chain integration; INV-5 including failed-company post-conditions; inventory properties; atomic purchase rollback; stockout paths; pricing goldens/properties; founder authority/bounds; pass-through goldens/properties; balanced energy bills/fuel purchases; billing and liquidation rollback/reopen; exact creditor recovery/write-off sums; catalog/API/causality/propagation tests; state-hash v9 and market/energy/insolvency/world-event snapshot restore equivalence; shared HTTP contract, real-app integration, component, state-hash-neutral read, and 360-tick explanation gates.
- **Exit criteria:** default world runs 360 ticks with ≥1 company founded and ≥1 failure or near-failure; all chains explorable via API; invariants green.
- **Deps:** Phase 3. **Risks:** economic collapse/degeneracy in defaults (INITIAL_WORLD calibration envelopes + tuning loop).

### Phase 5 — Banking: loan applications, repayment, and defaults
- **Goal:** Credit end-to-end with deterministic underwriting (officer adjustment stubbed as rule); credit creation visible in M1.
- **Features:** UC-3 complete (loan chapter); FR-BNK-3..6.
- **Modules:** M09 (credit), M11 (loan contracts), M18 (credit indicators).
- **Backend:** WS-501–508 complete: versioned integer-only scoring, authoritative evidence capture, immutable applications/assessments/reviews/decisions, deterministic Tier-1 officer assignment, six-check policy evaluation, exact equal-principal 30/360 schedules, atomic ledger-backed disbursement with live-debt feedback, exact due-tick collection, full-arrears cure, three-miss default with balanced loss booking and bounded score penalty, live reserve/effective-capital/borrower-concentration circuit assessments at approval and disbursement, a complete audited eight-loan opening portfolio, persisted credit-outstanding/default-rate series, strict normalized loan reads, ledger-derived bank statements, and a pure 361-point M1 attribution report. Migration v18 expands the immutable indicator catalog; state-hash v14 already covers the indicator, loan, link, account, transaction and default records. The M26 audit is read-only and adds no persistence surface.
- **Frontend:** implemented credit dashboard, bank detail, loan schedule, and discriminated opening/underwritten why-panels. **API:** implemented bank and loan list/detail plus the credit/default slices of the now-complete ten-series indicator endpoint. **DB:** authoritative applications, assessments, reviews, decisions, circuit assessments, loans, schedules, defaults, opening credit and indicators.
- **Tests:** score/policy, amortization, collection, penalty, circuit-breaker, seeded-history, credit-read and M1-attribution goldens/properties; no-history; state-machine and authority enforcement; decision/schedule/default/assessment/seed immutability; atomic balance creation; exact recognition/repayment/write-down legs; arrears cure; three-miss default; systemic halt/recovery; borrower-scoped concentration; stale-approval blocking; complete opening INV-6; strict API/UI schemas; non-zero indicator/accounting reads; rollback/reopen; snapshot restore equivalence; and an event-complete 360-day supply sweep are complete.
- **Exit criteria:** green. Approval/rejection, disbursement, repayment/default and circuit/replay paths are covered from authoritative records; the stored why-panels are complete; the 360-day run attributes 100% of M1 movement with zero unexplained cents.
- **Deps:** Phase 4. **Risks:** credit rules too loose/tight (calibration envelopes; breakers protect invariants regardless).

### Phase 6 — Conversations, negotiation, and LLM integration
- **Goal:** Live LLM path: Tier 2 decisions (incl. loan officer with real bounded adjustment), Tier 3 bounded conversations; budgets, cache, telemetry, mock parity.
- **Features:** agents converse; officer rationales are real; founder pricing/hiring judgment; degradation ladder.
- **Modules:** M04 (Tiers 2–3), M05, M21 (full), M24 (kill switches live).
- **Backend:** WS-601–610 complete: dependency-free MiniMax M3 and Kimi K2.x transports, Kimi Code Token Plan/Open Platform route isolation, strict structured output with local Zod validation, canonical cache/replay boundary, exact cached-token-aware budgets and controls, versioned fenced prompt packs, prepared Tier-2 choices, bounded Tier-3 conversations, independently revalidated purchase/job bindings, and the LLM observability surface are implemented. New live manifests route Tier 2 to `MiniMax-M3` and Tier 3 to logical `kimi-k2.6` or explicitly selected `kimi-k2.7-code`; Anthropic is legacy-only. Append-only call receipts expose provider/model, attempts, input/cached-input/output tokens, latency, exact integer-microcent cost, cache status and causal evidence. Strict paginated projections expose calls, engine/rejected-intent/provider/schema failures, active quarantines, conversations, outcomes and bindings; `/status` reports authoritative spend, the actual cache-hit rate and the rolling 24-tick error count. Operational telemetry is restored by SQLite snapshots but excluded from the logical state hash so wall-clock latency cannot change replay identity. WS-609/610 artifact schema v2, semantic validators and `pnpm gate:phase6` all pass with real evidence.
- **Frontend:** implemented conversation viewer, budget meter, cached-token-aware per-call ledger, error feed and quarantine dashboard; untrusted transcript prose is rendered as inert text beside separately typed structured terms and binding outcomes. **API:** implemented `/llm-calls`, `/errors`, conversation list/detail and the completed LLM status projection. **DB:** cache/control/call records, cached-input usage counters, operational telemetry columns, conversation/message/inbox/relationship-history state, and negotiation bindings are implemented.
- **Tests:** provider/schema/validation failure classification, strict API/client contracts, exact input/cached-input/output price reconciliation, telemetry reopen/snapshot/hash-neutrality, hostile transcript rendering, budget auto-pause and cache-key stability are complete. WS-609 proves the real-HTTP nonbillable $2 reference-budget lifecycle, exact repricing, causal auto-pause and zero later attempts. WS-610 proves provider-neutral call, Decision, AgentAction, same-tick event and affected-agent parity. Artifact tests reject stale digests, recomputed but causally false budget evidence, request/proposal hash drift and reordered sections. The authoritative Phase 6 gate is green.
- **Exit criteria:** AC-2 demo (live $2 run auto-pauses); mock 360-tick determinism gate still green; red-team fixtures pass.
- **Deps:** Phase 5. **Risks:** cost surprises (ceilings first), injection (fencing + tests first).

### Phase 7 — News, sentiment, and economic indicators (MVP close-out)
- **Goal:** Close the perception loop: stories from real events, sentiment indices modulate decisions (bounded); full MVP indicator set; dashboard complete; MVP acceptance (PRD §28) passes.
- **Features:** UC-1..UC-6 all demonstrable.
- **Modules:** M14, M15, M18 (full set), M23 (UI-1..7 complete), M25 (replay UI hooks, exports).
- **Backend:** WS-701 through WS-710 are complete: versioned integer newsworthiness, stable logical hashes, an immutable role-checked newsroom, deterministic 30-tick editor windows, engine-authored cited drafts, exact-menu LLM selection, invalid-output spiking, LLM-off templates, three decaying public sentiment indices, fully attributed four-axis opinion drift, bounded persisted decision priors, all ten FR-OBS-2 series, manifest/journal/cache replay, restart-safe checksummed exports, the complete explanatory read surface, a production-shaped Playwright acceptance path, the canonically hashed seed-42/mock 360-tick regression envelope, and the complete PRD §28 acceptance matrix. CPI uses exact fixed expenditure shares, GDP is a trailing 30-tick final-expenditure proxy, and every point carries formula/input evidence. The replay worker is cache-only, restart-safe, supports strict/observe modes, compares every canonical event prefix, and verifies exact final state hashes. Export jobs pin a source tick/hash and atomically publish canonical JSONL or deterministic CSV plus a checksummed manifest. Achieved founder goals now enter the signed company-formation lifecycle, and the global three-action cap coordinates Tier-2, rule, and newsroom work. Replay-neutral prompt/news projections and deterministic built-in mock telemetry make independent source journals and strict replay exact. Migrations 29–30 store hash-neutral replay/export evidence; state-hash v22 remains authoritative.
- **Frontend:** Macro, Finance, Employment, and Business panels render all ten authoritative series. The News Explorer supplies exact cited-story why-panels, three sentiment sparklines, filterable event/transaction ledgers, causation ancestry, and strict/observe replay stepping within the two-click explanation boundary. The run cockpit now includes a paused-run-only injector for the four approved WS-408 event kinds, and the complete create-to-shock-to-CPI path is exercised in real Chromium.
- **API:** the bounded ten-series indicators, published-news feed/detail, event/transaction explorer, asynchronous replay, and export create/poll surfaces are complete. **DB:** newsroom, sentiment/opinion, full indicators, and immutable hash-neutral replay/export evidence are complete.
- **Tests:** AC-1..AC-10 pass through `pnpm gate:mvp`, including citation integrity, exact two-run hashes, strict full replay, adversarial containment, and the Playwright happy path.
- **Exit criteria:** **MVP accepted** — all PRD §28 criteria pass and are recorded in PROJECT_STATUS and [WS-710 evidence](WS_710_MVP_ACCEPTANCE.md).
- **Deps:** Phase 6. **Risks:** believability tuning absorbing unbounded time (timebox; ship envelopes).

### Phase 8 — Investments and venture capital [V1]
- **Status (2026-07-16):** WS-801–803 complete; WS-804 exact distributions are next.
- **Goal:** FR-INV: pitch → Tier 3 negotiation → term validation → close → cap table.
- **Modules:** M10, M05 (negotiation kinds), M11 (investment contracts).
- **Backend:** WS-801 persists run-scoped VC firms, funds, and immutable deployment chains with exact integer-cent accounting and a hard `deployed <= fundSize` boundary. WS-802 adds deterministic founder pitch triggers, provider-neutral Tier-3 investment conversations, exact bounded terms, outcome revalidation, typed rejection, and expiry. WS-803 validates exact integer-share priced rounds and atomically closes the investment contract, ROW-backed fund draw, domestic cash transfer, deployment, immutable stake, cap-table revision, proposal, and completion event. Remaining backend work is exact pro-rata distributions. **Frontend:** investment pages, cap tables, negotiation transcripts. **API:** investments, proposals. **DB:** firms, funds, fund cash links, deployments, proposals, generalized cap tables and ownership stakes, investment contracts, and completed investments are live; distributions follow in WS-804.
- **Tests:** INV-4 property suite; negotiation-outcome extraction; dilution goldens.
- **Exit criteria:** default world closes ≥1 negotiated investment in 360 ticks; all math exact.
- **Deps:** Phase 7. **Risks:** negotiation quality (routing to opus tier for these calls; transcripts reviewable).

### Phase 9 — Simplified securities market [V1]
- **Goal:** FR-SEC-1: listings + daily call auction + settlement + price history.
- **Modules:** M13, M09/M10 (settlement), M18 (market indicators).
- **Backend:** eligibility, escrowed orders, clearing algorithm, band enforcement. **Frontend:** market pages (auction results, price charts, order books per auction). **API:** markets endpoints + market events. **DB:** markets, securities, stock_orders, trades, price_history.
- **Tests:** clearing property tests; INV-7; escrow/no-naked-order tests; band tests.
- **Exit criteria:** ≥1 IPO + daily auctions with plausible prices for 90 ticks; zero settlement failures.
- **Deps:** Phase 8. **Risks:** thin-market degeneracy (band + auction design; ROW market-maker stub if needed, documented).

### Phase 10 — Government policy and taxation (dynamic) [V1]
- **Goal:** FR-GOV-3: bounded policy proposals by government agents; Taylor-lite monetary authority; policy → news → sentiment loop.
- **Modules:** M16, M04/M05 (proposal decisions), M14/M15 (coverage).
- **Backend:** proposal menus + adoption process; base-rate rule; policy effect wiring (bank rates reference base rate). **Frontend:** policy pages + timeline. **API:** policies (proposals). **DB:** policy_proposals.
- **Tests:** menu-bound enforcement; rate-rule goldens; end-to-end policy→price→sentiment integration.
- **Exit criteria:** a tax change adopted in-run shows measurable, explained downstream effects (UC-7 material).
- **Deps:** Phase 7 (news), Phase 5 (rates). **Risks:** feedback instability (dampening factors, envelopes).

### Phase 11 — Scaling, replay, evaluation, and scenario comparison
- **Goal:** 1,000-agent mock soak; run-comparison UI; scenario regression farm; performance/cost tuning; batch-API scheduling.
- **Modules:** M01/M20/M25 (perf), M21 (batch), M23 (comparison UI), M26 (regression farm, persona evaluation).
- **Backend:** profiling + hot-path fixes; incremental indicators; batch LLM scheduler; comparison APIs. **Frontend:** run-comparison view; anomaly panels. **API:** runs/compare. **DB:** indexes, archive/export tooling.
- **Tests:** 1,000-agent soak (NFR-2); load tests on read API; golden-scenario regression suite; long-replay tests.
- **Exit criteria:** 1,000 agents × 360 ticks mock run under target wall-clock with green invariants; comparison view ships.
- **Deps:** Phase 7+ (comparisons meaningful). **Risks:** SQLite write ceiling (measure; Postgres seam ready per ADR-0004).

After Phase 11 and WS-1106 are complete, a separate approved discovery effort
may evaluate a self-hosted, open-source, provider-neutral citizen-tool layer.
MVP, V1 and Phase 11 include no connector dependency, external-account access,
tool-execution surface or reserved integration ticket.

---

## 4. Cross-cutting engineering standards

- **Definition of done (every task):** code + tests + docs updated + invariant suite green + determinism gate green.
- **Versioning:** ruleset, prompt pack, event schemas, API DTOs all carry integer versions; run manifests pin all of them (ADR-0009/0010).
- **Error taxonomy:** typed `EngineError` codes (`VALIDATION_FAILED, INSUFFICIENT_FUNDS, PERMISSION_DENIED, LIMIT_EXCEEDED, NOT_FOUND, CONFLICT, BUDGET_EXHAUSTED, SCHEMA_INVALID, INTERNAL`) shared engine→API (problem+json `code`).
- **Concurrency model:** one run advances on one thread; LLM I/O is the only concurrency, always barriered per tick and re-ordered deterministically (ADR-0008).
- **Performance budget:** phase timing recorded per tick from Phase 1; regressions >20% fail CI benchmarks (Phase 11 formalizes).
- **Security:** provider keys env-only; server binds 127.0.0.1; injected content fencing per SAF-3; dependency audit in CI.
