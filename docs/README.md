# WorldTangle documentation

This is the canonical index for the repository's documentation. Current-state documents describe the implementation that exists today; roadmap and requirement documents distinguish implemented work from planned work; ticket evidence records the state of a specific ticket when it closed.

## Start here

- [Project status](PROJECT_STATUS.md) — current completion boundary, latest verified gate, and next work.
- [Local operations](LOCAL_OPERATIONS.md) — install, run, configure live providers, choose mock mode, and verify a run.
- [Product requirements](PRD.md) — product scope, safety boundaries, use cases, and acceptance criteria.
- [Implementation plan](IMPLEMENTATION_PLAN.md) — logical modules, phase gates, and remaining roadmap.
- [Task backlog](TASK_BACKLOG.md) — tracked tickets and their live status.
- [API contracts](API_CONTRACTS.md) — implemented REST/SSE contracts plus clearly labelled planned routes.
- [Domain model](DOMAIN_MODEL.md) — authoritative entity shapes, ownership boundaries, and workflows.
- [Initial world](INITIAL_WORLD.md) — deterministic Riverbend population and calibration contract.
- [Architecture decisions](adr/README.md) — accepted ADRs and amendments.

## Operational and cross-phase references

- [Live provider contract](LIVE_PROVIDER_CONTRACT.md)
- [Phase 3 finance](PHASE_3_FINANCE.md)
- [Phase 4 foundations](PHASE_4_FOUNDATIONS.md)
- [Phase 12 Agent Lab](PHASE_12_AGENT_LAB.md)
- [Agent Lab ODD record](ODD_AGENT_LAB.md)
- [Brand assets and export workflow](../design/brand/README.md)
- [Brand generation prompts](../design/brand/PROMPTS.md)

## Ticket evidence

### Phase 4 — companies and production

- [WS-406 energy tariffs and billing](WS_406_ENERGY.md)
- [WS-407 insolvency and wind-down](WS_407_INSOLVENCY.md)
- [WS-408 world-event injection](WS_408_WORLD_EVENTS.md)
- [WS-409 World Explorer](WS_409_WORLD_EXPLORER.md)

### Phase 5 — credit lifecycle

- [WS-501 credit scoring](WS_501_CREDIT_SCORING.md)
- [WS-502 application workflow](WS_502_APPLICATION_WORKFLOW.md)
- [WS-503 amortization and disbursement](WS_503_AMORTIZATION_DISBURSEMENT.md)
- [WS-504 collections and default](WS_504_COLLECTIONS_DEFAULT.md)
- [WS-505 bank circuit breakers](WS_505_BANK_CIRCUIT_BREAKERS.md)
- [WS-506 seeded credit state](WS_506_SEEDED_CREDIT_STATE.md)
- [WS-507 Credit Explorer](WS_507_CREDIT_EXPLORER.md)
- [WS-508 M1 attribution](WS_508_M1_ATTRIBUTION.md)

### Phase 6 — LLM decisions and conversations

- [WS-601 MiniMax/Kimi providers](WS_601_MINIMAX_KIMI_PROVIDERS.md)
- [WS-601 legacy Anthropic adapter](WS_601_ANTHROPIC_ADAPTER.md)
- [WS-602 response cache](WS_602_RESPONSE_CACHE.md)
- [WS-603 budgets and controls](WS_603_LLM_BUDGETS_CONTROLS.md)
- [WS-604 observations and prompts](WS_604_OBSERVATIONS_PROMPTS.md)
- [WS-605 Tier-2 decisions](WS_605_TIER2_DECISIONS.md)
- [WS-606 bounded conversations](WS_606_BOUNDED_CONVERSATIONS.md)
- [WS-607 negotiation bindings](WS_607_NEGOTIATION_BINDINGS.md)
- [WS-608 LLM observability](WS_608_LLM_OBSERVABILITY.md)
- [WS-609 live-budget acceptance](WS_609_LIVE_BUDGET_ACCEPTANCE.md)
- [WS-610 LLM parity](WS_610_LLM_PARITY.md)

### Phase 7 — news, replay, and MVP acceptance

- [WS-701 newsworthiness digest](WS_701_NEWSWORTHINESS_DIGEST.md)
- [WS-702 story pipeline](WS_702_STORY_PIPELINE.md)
- [WS-703 sentiment engine](WS_703_SENTIMENT_ENGINE.md)
- [WS-704 full indicators](WS_704_FULL_INDICATORS.md)
- [WS-705 replay executor](WS_705_REPLAY_EXECUTOR.md)
- [WS-706 export jobs](WS_706_EXPORT_JOBS.md)
- [WS-707 News Explorer UI](WS_707_NEWS_EXPLORER_UI.md)
- [WS-708 Playwright acceptance](WS_708_PLAYWRIGHT_ACCEPTANCE.md)
- [WS-709 scenario regression](WS_709_SCENARIO_REGRESSION.md)
- [WS-710 MVP acceptance](WS_710_MVP_ACCEPTANCE.md)

### Phase 8 — venture capital and investment

- [WS-801 VC fund accounting](WS_801_VC_FUND_ACCOUNTING.md)
- [WS-802 proposal pipeline](WS_802_INVESTMENT_PROPOSAL_PIPELINE.md)
- [WS-803 cap-table closing](WS_803_CAP_TABLE_CLOSING.md)
- [WS-804 investment distributions](WS_804_INVESTMENT_DISTRIBUTIONS.md)
- [WS-805 Investment Explorer](WS_805_INVESTMENT_EXPLORER.md) — complete; Phase 8 accepted.

### User testing

- [Guided causal test](USER_TESTING.md) — controlled mock pilot, tester brief,
  evidence states, receipt handoff, and known boundaries.

### Phase 12 — Agent laboratory and realism harness

- [Agent Lab architecture, operation, and gate](PHASE_12_AGENT_LAB.md)
- [ODD study record](ODD_AGENT_LAB.md)

## Maintenance rule

Every ticket updates its ticket evidence, [project status](PROJECT_STATUS.md), [task backlog](TASK_BACKLOG.md), and any affected API/domain/operations documents. Historical test counts in closed-ticket evidence remain point-in-time evidence; the latest repository-wide result belongs in `PROJECT_STATUS.md`.
