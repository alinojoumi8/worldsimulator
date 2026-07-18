# WorldTangle — API Contracts (v1)

Frontend ⇄ backend contract. The frontend consumes the shared schemas described here and never imports engine internals. Companion: [DOMAIN_MODEL.md](DOMAIN_MODEL.md) (entity shapes), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (M22).

## 1. Conventions

- **Base URL:** `http://127.0.0.1:4000/api/v1` (server binds loopback by default).
- **Versioning:** URI major version (`/api/v1`); additive changes only within v1; breaking → `/api/v2`. Every event/DTO also carries an integer `schemaVersion` (ADR-0010).
- **Machine-readable contracts:** current request, response, and SSE DTOs are Zod schemas in `packages/shared` (single source of truth). Server, frontend, and contract tests consume those schemas directly. The Phase 0 event/intent envelope, run-manifest, and engine-error contracts also export stable Draft 2020-12 documents through `coreJsonSchemaBundle`; HTTP JSON Schema/OpenAPI publication remains planned work.
- **Auth:** MVP is a single-user local tool with no auth by default. If `WORLDTANGLE_API_TOKEN` is set, `/api/v1/*` requires `Authorization: Bearer <token>` except `GET /health`; missing/invalid tokens return 401. Built dashboard routes and static assets remain public. The `read`/`admin` labels below are future authorization categories; the current token grants both, with role-based 403 semantics reserved for later (ADR-0011).
- **Money:** integer cents serialized as **strings** (`"125000"` = $1,250.00) with `"currency":"SIM_USD"`. Rates in basis points (int).
- **Time:** `tick` (int) + `simDate` (`"Y0001-M02-D15"`); wall times ISO-8601 UTC.
- **IDs:** typed-prefix strings (`agt_…`, `co_…`).
- **Root metadata:** simulation-route response envelopes include `"meta": {"simulated": true, "apiVersion": 1}` (SAF-1); platform health/version use their documented compact shapes.
- **Errors:** RFC 9457 `application/problem+json`:

```json
{ "type": "urn:worldtangle:error:insufficient-funds", "title": "Insufficient funds",
  "status": 409, "detail": "Account acct_0000000f has 12000, transfer needs 50000",
  "code": "INSUFFICIENT_FUNDS", "correlationId": "cor_000f3a12", "instance": "/api/v1/simulations/sim_1/..." }
```
  Standard codes: `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409 — incl. illegal lifecycle transitions), `LIMIT_EXCEEDED` (429), `BUDGET_EXHAUSTED` (409), `INTERNAL` (500).
- **Pagination (all list endpoints):** cursor-based — request `?limit=50&cursor=<opaque>`; response `{"items":[...], "nextCursor": "…"|null, "meta":{...}}`. `limit` 1–200, default 50. Ordering is documented per endpoint and always deterministic. Cursors are opaque and expire with the run.
- **Common query params:** `runId` (defaults to the simulation's latest run), `fromTick`/`toTick` ranges where noted.
- **Implementation labels:** endpoints without a label are registered today. **Planned** endpoints document an approved future contract but are not registered by the current server.

## 2. REST endpoints

### 2.1 Platform

**GET `/api/v1`** — API discovery document. Response 200: `{"name":"WorldTangle","simulated":true,"apiVersion":1,"engineVersion":"0.1.0","eventSchemaVersion":1,"rulesetVersion":1,"promptPackVersion":1,"links":{"health":"/api/v1/health","version":"/api/v1/version","simulations":"/api/v1/simulations"}}`.

**GET `/health`** — liveness/readiness. Auth: none. Response 200: `{"status":"ok","engine":"idle|running","version":"0.1.0","simulated":true}`. Errors: 500. No pagination.
Example: `curl :4000/api/v1/health` → above.

**GET `/version`** — build + schema versions. Auth: read (token required when configured). Response 200: `{"apiVersion":1,"engineVersion":"0.1.0","eventSchemaVersion":1,"rulesetVersion":1,"promptPackVersion":1,"simulated":true}`.

**Dashboard routes (outside `/api/v1`):** when `apps/web/dist/` exists, `GET /`, `GET /simulations/{simId}`, and exact built asset paths are served publicly by Fastify. During `pnpm dev`, Vite serves the same SPA at `http://127.0.0.1:5173` and proxies `/api` to port 4000.

### 2.2 Simulation lifecycle & control

**POST `/simulations`** — create a simulation (scenario + first run). Auth: admin.
Request:
```json
{ "name": "baseline-riverbend", "scenario": { "worldSpec": "riverbend-100@1", "seed": 42,
    "llmMode": "mock", "budgets": { "runCostCentsMax": "500", "perAgentDailyTokens": 2000 },
    "policyOverrides": { "income_tax_rate_bp": 1800 }, "endTick": 360 } }
```
Response 201: `{"simulation":{"id":"sim_000001","name":"…","status":"created","createdAt":"…"},"run":{"id":"run_000001","status":"created","currentTick":0,"manifest":{…pinned versions…}},"meta":{…}}`.
Errors: 400 `VALIDATION_FAILED` (unknown worldSpec, bad budgets). No pagination.

**GET `/simulations`** — list simulations. Auth: read. Query: `limit,cursor,status?`. Response 200: page of `{id,name,status,latestRun:{id,status,currentTick},createdAt}` ordered by `createdAt desc, id desc`.
Example: `GET /simulations?limit=2` → `{"items":[{"id":"sim_000002",…},{"id":"sim_000001",…}],"nextCursor":null,"meta":{…}}`.

**GET `/simulations/{simId}`** — detail incl. runs. Response 200: `{simulation, runs:[{id,seed,status,currentTick,spend:{inputTokens,cachedInputTokens,outputTokens,costCentsEstimate}}]}`. Errors: 404.

**POST `/simulations/{simId}/start`** · **`/pause`** · **`/resume`** · **`/stop`** — lifecycle controls for the active run (or `{"runId":"…"}` in body). Auth: admin. Request: `{"runId?":"run_000001"}`.
Response 202: `{"run":{"id":"…","status":"running|paused|stopped","currentTick":N},"commandEventId":"evt_…"}` — every control is journaled (`admin.command.received`) before taking effect.
Errors: 404; 409 `CONFLICT` for illegal transitions (e.g. start a completed run).
Example: `POST /simulations/sim_000001/pause {}` → `{"run":{"id":"run_000001","status":"paused","currentTick":112},"commandEventId":"evt_00003a01"}`.

**POST `/simulations/{simId}/advance`** — step N ticks while paused. Auth: admin. Request: `{"ticks": 5, "runId?":"…"}` (1–1000).
Response 200 (sync for small N): `{"run":{"currentTick":117,"status":"paused"},"tickResults":{"executed":5,"events":432}}`. For `ticks>50` returns 202 with a task handle `{"taskId":"task_…","poll":"/simulations/{simId}/status"}`.
Errors: 409 if running; 400 range.

**GET `/simulations/{simId}/status`** — live status (poll target). Response 200:
```json
{ "run": {"id":"run_000001","status":"running","currentTick":118,"simDate":"Y0001-M04-D28","endTick":360},
  "tickRate": {"ticksPerSec": 0.4}, "llm": {"mode":"live","spend":{"inputTokens":182003,"cachedInputTokens":64000,"outputTokens":54012,"costCentsEstimate":"163"},"budgetPct":33,"cacheHitRate":0.41,"enabled":true,"effectiveTier":3,"autoPaused":false,"frozenModules":[],"limits":{"runCostCentsMax":"500","perAgentDailyTokens":2000}},
  "errors": {"last24Ticks": 2},
  "activity": {"committedEvents":4802,"latestEventSeq":4801,"latestDigest":{"v":1,"tick":118,"simDate":"Y0001-M04-D28","indicators":{},"counts":{"events":28,"transactions":5,"decisions":3,"llmCalls":2,"rejectedIntents":0},"notable":[],"spend":{"budgetPct":33}}},
  "task": null, "meta": {…} }
```

`activity` is a durable SQLite projection, not transient SSE state. `latestEventSeq` is the resume boundary for the first stream connection, and `latestDigest` remains available after a run is completed, stopped, or failed.

**Planned — GET `/simulations/{simId}/scenario`** — proposed current scenario config + mutation history. This route is not registered today; immutable creation config is available from `GET /simulations/{simId}`.

**Planned — PATCH `/simulations/{simId}/scenario`** — proposed paused-run mutation contract. This route is not registered today; use the implemented lifecycle, LLM-control, and bounded world-event commands instead.

**POST `/simulations/{simId}/world-events`** — inject an approved world event. Auth: admin. Request: `{"type":"energy.fuel_price_shock","params":{"deltaPct":30},"scheduleTick?":130}` (immediate = next tick boundary).
Response 202: `{"worldEvent":{"id":"wev_000003","type":"energy.fuel_price_shock","params":{"deltaPct":30},"source":"admin","status":"scheduled","createdTick":129,"scheduledTick":130,"appliedTick":null,"taskId":"task_000003","commandEventId":"evt_…","injectedEventId":"evt_…","appliedEventId":null,"effectEventIds":[],"catalogVersion":1},"commandEventId":"evt_…"}`.

**POST `/simulations/{simId}/admin/llm-controls`** — change one reversible provider-neutral LLM control. Auth: admin. Requests: `{"runId?":"run_…","command":"set_llm_enabled","enabled":false}`, `{"command":"set_module_frozen","moduleId":"agent_decisions|conversations|news","frozen":true}`, or `{"command":"set_agent_quarantine","agentId":"agt_…","quarantined":true,"untilTick":140}`. Clearing quarantine requires `quarantined:false` and omits `untilTick`. Response 202: `{"commandEventId":"evt_…","eventId":"evt_…","controls":{…authoritative status fields…}}`. Every accepted change journals `admin.command.received` and a resulting fact before mutation; no-op and stale requests return 409.
Errors: 400 unknown type/params, nonfuture/out-of-run schedule, or extra fields; 404 missing target; 409 while running, terminal, or otherwise not mutable. (FR-EVT-1)

Approved v1 request variants are: `energy.fuel_price_shock {deltaPct}`, `row.reference_price_shift {sku,deltaPct}`, `market.demand_shock {sku,deltaPct,durationTicks}`, and `business.disaster {companyId,capacityReductionPct,durationTicks}`. No arbitrary function/tool/connector payload is accepted.

**GET `/simulations/{simId}/llm-calls`** — immutable per-call telemetry. Query: `runId?,limit,cursor,agentId?,moduleId?,status?=success|fallback,fromTick?,toTick?`. Response 200: `{items:[{id,decisionId,agent,tick,moduleId,purpose,requestedTier,effectiveTier,provider,model,promptPackKey,promptVersion,promptHash,schemaKey,schemaVersion,requestHash,status,fallbackReason,providerErrorCode,detail,cached,attempts,inputTokens,cachedInputTokens,outputTokens,latencyMs,costMicrocents,costCentsEstimate,sourceEventId}],nextCursor,totals:{calls,success,fallback,cacheHits,providerAttempts,inputTokens,cachedInputTokens,outputTokens,costMicrocents},meta}` ordered `(tick desc,id desc)`. Cost is exact integer microcents; the per-item whole-cent estimate rounds up. Latency is operational telemetry from an injected monotonic clock: SQLite snapshots preserve it, but logical state hashes and replay decisions exclude it. (FR-OBS-5)

**GET `/simulations/{simId}/errors`** — errors, rejected intents and LLM failures. Query: `runId?,limit,cursor,kind?=engine|intent_rejected|llm|schema`. Response 200: `{items:[{eventId,seq,at,tick,kind,code,message,actor,agent,correlationId,causationId}],nextCursor,summary:{counts:{engine,intentRejected,llm,schema},perAgent:[{agent,failures}],activeQuarantines:[{agent,quarantine}]},meta}` ordered `seq desc`. Provider failures are distinct from schema/validation failures; the correlation and causation IDs link every item back to the committed journal. Summary counts cover the complete run even when the item page is filtered. (FR-ADM-3)

### 2.3 Agents

**GET `/simulations/{simId}/agents`** — directory. Query: `runId?,limit,cursor,occupation?,employmentStatus?,search?` (case-insensitive name prefix). Response 200: page of `{id,name,age,occupation,employmentStatus,householdId,netWorth:{cents}}` ordered by `id asc`.
Example item: `{"id":"agt_0000002a","name":"Rosa Fern","age":34,"occupation":"loan_officer","employmentStatus":"employed","householdId":"hh_00000011","netWorth":{"cents":"1842000"}}`.

**GET `/simulations/{simId}/agents/{agentId}`** — full profile. Response 200:
```json
{ "agent": {"id":"agt_0000002a","name":"Rosa Fern","age":34,"education":"college",
    "occupation":"loan_officer","employmentStatus":"employed","creditScore":712,
    "personality":{"openness":61,"conscientiousness":78,"extraversion":45,"agreeableness":66,"neuroticism":38,"riskTolerance":35,"timePreference":70,"ambition":55},
    "opinions":{"redistribution":12,"regulation":28,"institutionalTrust":41,"economicOptimism":-5},
    "goals":[{"id":"gol_000012","kind":"save_amount","params":{"target":"500000"},"status":"active","progress":0.63}],
    "skills":{"finance":72,"communication":64}, "bioSummary":"Synthetic Riverbend resident…","promptVersion":1,
    "quarantine":null,"annualIncome":{"cents":"6200000"},"roleCode":"bank.loan_officer","organizationId":"inst_first_ledger_bank",
    "memoryHighlights":[{"id":"mem_0000002a","tick":0,"kind":"event","content":"Rosa Fern began…","importance":75,"references":["evt_0000002d"]}] },
  "meta": {…} }
```
Errors: 404.

**GET `/simulations/{simId}/agents/{agentId}/finances`** — employment + financial state. Response 200:
```json
{ "employment": {"contractId":"emp_00000019","employer":{"id":"bank_000001","name":"First Ledger Bank"},"title":"Loan Officer","wage":"5200000","since":"Y0001-M01-D01"},
  "accounts": [{"id":"acct_0000003c","bank":"First Ledger Bank","type":"checking","balance":"1842000"}],
  "income": {"last30Ticks":{"salary":"433333","benefits":"0","other":"0"}},
  "expenses": {"last30Ticks":{"subsistence":"196500","discretionary":"88200","rent":"90000","utilities":"14400"}},
  "loans": [{"id":"loan_000004","principal":"1000000","outstanding":"614200","status":"repaying","nextDue":{"tick":150,"amount":"88849"}}], "meta":{…} }
```

**GET `/simulations/{simId}/agents/{agentId}/relationships`** — social edges. Query: `runId?,limit,cursor,type?`. Response 200: page of `{id,toAgent:{id,name},type,strength,lastInteractionTick}` ordered `strength desc, toAgentId asc`.

**GET `/simulations/{simId}/agents/{agentId}/decisions`** — explainability feed. Query: `runId?,limit,cursor,tier?,fromTick?,toTick?`. Response 200: page of
`{id,tick,trigger:{kind,sourceEventId},tier,observation:{hash,summary},optionsOffered:[{actionId,summary}],chosen:{actionId,params}|null,rationale,validation:{result,code?},llm?:{callId,promptPackKey,promptVersion,promptHash}}` ordered `tick desc, id desc`. The LLM block is all-or-nothing and its hash identifies the exact fenced prompt and registered pack used by the immutable Decision. (FR-OBS-4, SAF-3)

The directory, profile, relationship, and decision endpoints are implemented in WS-207. The WS-309 finances endpoint is implemented from authoritative ledger, employment, and seeded-loan records; it does not synthesize missing financial data.

### 2.4 Conversations

**GET `/simulations/{simId}/conversations`** — list. Query: `runId?,limit,cursor,participant?,topic?,status?,fromTick?,toTick?`. Response 200: `{items:[{id,participants:[{id,name}],topic,status,turns,startTick,endTick,outcome,binding}],nextCursor,meta}` ordered `(startTick desc,id desc)`.

**GET `/simulations/{simId}/conversations/{conversationId}`** — full transcript. Query: `runId?`. Response 200: `{conversation:{…header,initiatingTriggerEventId,termBounds,maxTurns,outputTokenBudget,outputTokensUsed,closeReason,sourceEventId},messages:[{id,turn,sender,recipient,kind,content,structuredTerms,tick,deliveryTick,decisionId,llmCallId,outputTokens,sourceEventId}],outcome,binding,meta}`. Errors: 404. Message `content` is untrusted, non-binding agent-generated text and the UI renders it as inert text without HTML or markdown execution. Only separately validated structured terms and the engine-produced binding record are authoritative.

### 2.5 Institutions & companies

**GET `/simulations/{simId}/institutions`** — all institutions. Query: `kind?=bank|vc_firm|law_firm|school|news_org|government|market_operator|energy_co`. Response 200: page of `{id,kind,name,staffCount,keyFigures:{…kind-specific summary…}}` ordered `id asc`. VC key figures expose `{initialized,firmId,status,fundCount,fundSizeCents,deployedCents,availableCents}` from authoritative WS-801 fund state.

**GET `/simulations/{simId}/institutions/{institutionId}`** — detail incl. roles: `{institution, officeholders:[{role,agent:{id,name}}], rulebook:{…public parameters…}}`.

**GET `/simulations/{simId}/companies`** — list. Query: `limit,cursor,status?,sector?`. Response 200: page of `{id,name,sector,status,foundedTick,employees,cash:{cents},lastProfit:{cents}}` ordered `foundedTick desc, id desc`.

**GET `/simulations/{simId}/companies/{companyId}`** — detail:
```json
{ "company": {"id":"co_00000007","name":"Fogline Coffee","sector":"food_service","status":"active","formationStage":"active","foundedTick":20,"registeredTick":22,"activatedTick":25,"incorporationContractId":"ctr_00000018","businessAccountId":"acct_0000003c","failureReason":null,"founder":{"id":"agt_00000031","name":"Dana Voss"}},
  "capTable": [{"holder":{"kind":"agent","id":"agt_00000031","name":"Dana Voss"},"shares":"10000","ownershipBp":10000}],
  "staff": [{"employmentId":"emp_00000019","agent":{"id":"agt_00000040","name":"Jo Reed"},"title":"Barista","annualWageCents":"3200000","status":"active","startTick":28,"endTick":null,"legalContractId":"ctr_00000022"}],
  "offerings": [{"id":"off_00000001","sku":"meals","postedPriceCents":"1250","unitCostCents":"780","inventory":12,"active":true,"createdTick":29}],
  "jobs": [{"id":"job_00000001","title":"Barista","status":"filled","annualWageCents":"3200000","openings":1,"filledCount":1}],
  "financials": {"cashCents":"921000","revenue30Cents":"388000","costs30Cents":"301200","profit30Cents":"86800"},
  "solvency": {"tick":40,"cashCents":"921000","obligationCents":"266667","shortfallCents":"0","consecutiveShortfallDays":0,"insolvent":false,"sourceEventId":"evt_00000988"},
  "windDown": null,
  "timeline": [{"id":"ctl_00000001","tick":20,"type":"company.formation.requested","sourceEventId":null,"referenceId":"ctr_00000018","details":{}}], "meta":{…} }
```

**GET `/simulations/{simId}/jobs`** — list. Query: `limit,cursor,status?,companyId?,occupation?`. Response 200: page of `{id,employer:{id,name},occupationCode,title,annualWageCents,openings,filledCount,status,postedTick,expiresTick,applicationCount,payrollRisk}` ordered `postedTick desc, id desc`.

**GET `/simulations/{simId}/jobs/{jobId}`** — detail: `{job,employer,applications:[{application,agent:{id,name}}],employmentContracts:[{id,employee:{id,name},legalContractId,startTick,endTick,status}],meta}`. Errors: 404.

### 2.6 Banking & credit

**GET `/simulations/{simId}/banks`** — list: page of `{id,name,totalDeposits,totalLoans,capitalRatioBp,reserveRatioBp,lendingHalted}`. Ratios are derived from current authoritative deposits, fixed liquid reserves, and retained-income/loss-adjusted capital rather than copied opening constants.

**GET `/simulations/{simId}/banks/{bankId}`** — dashboard detail: above + `{accounts:{count},loanBook:{active,defaulted,writtenOff},incomeStatement30:{interestIncome,writeDowns}}`. The 30-tick income statement sums exact immutable ledger debits from `loan.installment.payment` and `loan.default.write_down`; it is not a copied counter.

**GET `/simulations/{simId}/loans`** — normalized opening/originated list. Query: `runId?,limit,cursor,origin?=opening_seed|originated,status?,bankId?,borrowerKind?=agent|company|business,borrowerId?`; borrower kind and ID prefix must agree. Response 200: page of `{id,origin,borrower:{kind,id,name},bank:{id,name},purpose,principalCents,outstandingPrincipalCents,annualRateBp,termMonths,status,openedTick,progress:{completedInstallments,missedInstallments,totalInstallments,nextDueTick},sourceEventId}` ordered by `openedTick desc, id desc` with a run-bound opaque cursor.

**GET `/simulations/{simId}/loans/{loanId}`** — full normalized loan, exact stored schedule, and a discriminated why-panel:
```json
{ "loan": {"id":"loan_00000001","origin":"originated","borrower":{"kind":"agent","id":"agt_0000002a","name":"Rosa Fern"},"principalCents":"600001","outstandingPrincipalCents":"500001","annualRateBp":900,"termMonths":6,"status":"repaying","scheduleDigest":"…"},
  "schedule": [{"installmentNumber":1,"dueTick":34,"principalDueCents":"100000","interestDueCents":"4500","totalDueCents":"104500","status":"completed","paidTick":34,"transactionId":"txn_00000f11","sourceEventId":"evt_00000f12"}],
  "why": {"kind":"underwritten","application":{…},"assessment":{"inputs":{…},"breakdown":{…}},"review":{…},"decision":{"policyChecks":[…]},"circuitAssessments":[…],"default":null,"evidence":["evt_…"]},
  "meta": {…} }
```
For `why.kind=opening_seed`, the response contains only stored seasoned-month/miss counts, recognition transaction, bank asset, borrower account, schedule digest, causal event/correlation and evidence. For `why.kind=underwritten`, it contains the exact application, score inputs/breakdown, review, immutable six-check decision, approval/disbursement circuit assessments, optional default record and complete evidence chain. A Tier-2 decision includes `reviewTier:"tier2"`, `agentDecisionId`, the selected integer `officerAdjustment` in `[-5,5]`, and the written `rationale`; Tier 1 carries `agentDecisionId:null`. Errors: 404. This renders FR-BNK-3's why-panel with no synthetic reconstruction or extra requests.

### 2.7 Investments & contracts

**GET `/simulations/{simId}/investment-proposals`** — Query: `runId?,limit,cursor,status?,companyId?`. Page items resolve `{id,company,founder,firm,fund,vcPartner,askAmountCents,preMoneyValuationCents,initialEquityBasisPoints,status,conversationId,finalTerms,proposedTick,expiresTick,investmentId,sourceEventId,lastTransitionEventId}` and are ordered `(proposedTick asc,id asc)` with a run-bound cursor.

**GET `/simulations/{simId}/investment-proposals/{proposalId}`** — proposal item plus `{conversation,termsDiff,decision,timeline}`. The conversation is a bounded summary, `termsDiff` compares exact initial/final cents and basis points, and `decision` exposes rejection/validation and causal event evidence. Errors: 404.

**GET `/simulations/{simId}/investments`** — Query: `runId?,limit,cursor,companyId?,fundId?`. Page items contain `{id,proposalId,company,firm,investor,amountCents,preMoneyValuationCents,sharesIssued,totalSharesBefore,totalSharesAfter,pricePerShareCents,ownershipBasisPoints,completedTick,sourceEventId}` ordered `(completedTick asc,id asc)`.

**GET `/simulations/{simId}/investments/{investmentId}`** — exact investment item plus its proposal, pre/post cap-table snapshots, later distributions, completion why-record, and causal proposal timeline. The why-record contains the source/causation/evidence event IDs and exact contract, domestic transfer, optional capital call, and ownership-stake IDs. Errors: 404 or 409 if stored causal evidence is inconsistent.

**GET `/simulations/{simId}/companies/{companyId}/cap-table`** — current generalized ownership projection: `{capTable:{company,totalShares,stakes:[{id,holder:{kind:"agent"|"venture_fund",id,name},shares,ownershipBasisPoints,acquiredVia,sinceTick}]},meta}`. Stake shares must sum exactly to `totalShares`.

**GET `/simulations/{simId}/investment-distributions`** — Query: `runId?,limit,cursor,companyId?`. Page of `{id,company,amountCents,totalShares,referenceId,distributedTick,transactionId,allocationCount,requestEventId,sourceEventId}` ordered `(distributedTick asc,id asc)`.

**GET `/simulations/{simId}/investment-distributions/{distributionId}`** — immutable distribution plus `companyAccountId` and ordered beneficial-owner allocations `{allocationIndex,holder,shares,amountCents,accountId,ownershipBasisPoints}`. Errors: 404.

All investment reads are read-only joins over WS-801 through WS-804 authority; they add no migration or state-hash surface. The React Investment Explorer remains the unfinished half of WS-805, so Phase 8 is not closed yet.

**GET `/simulations/{simId}/contracts`** — Query: `type?,party?,status?`. Page of `{id,type,parties:[{id,role,signedTick}],status,effectiveTick,fee?}` ordered `id desc`.

**GET `/simulations/{simId}/contracts/{contractId}`** — full typed contract plus resolved parties and legal timeline: `{contract:{…,terms:{…typed…},obligations:[…],breaches:[…]},partyDetails:[{kind,id,name,role,signedTick}],timeline:[{id,tick,type,details}],meta}`. Errors: 404.

### 2.8 News, policies, economy, markets

**GET `/simulations/{simId}/news`** — published feed. Query: `runId?,limit,cursor,topic?,fromTick?,toTick?`. Response 200: `{items:[{id,tick,sourceTick,headline,topic,stance,reach,author:{id,name},org:{id,name},citedEventIds:[…],sourceEventId}],nextCursor,sentiment:[{topic:"economy"|"employment"|"institutions",points:[[tick,value],…]}],meta}`. Items are ordered `(tick desc,id desc)`; the three sentiment series always use canonical topic order and ascending tick order. Cursors are opaque and run-bound.

**GET `/simulations/{simId}/news/{storyId}`** — published story detail: `{story:{id,tick,sourceTick,headline,body,topic,stance,reach,entities,author,org,citedEventIds,decisionId,llmCallId?,sourceEventId},citedEvents:[{eventId,eventFactHash,eventType,tick,simDate,actor,correlationId,causationId?,payload}],sentimentImpact:[{topic,delta,stanceDelta,outcomeDelta,sourceEventId}],meta}`. Citation identity and order exactly match the story; every sentiment delta reconciles to its bounded components. Spiked or missing stories return 404.

**Planned — GET `/simulations/{simId}/policies`** — proposed current + history projection. Dynamic policy reads arrive with WS-1004; this route is not registered today.

**GET `/simulations/{simId}/indicators`** — persisted economic time series. Query: `series=gdpProxy,cpi,m1,averageWage,unemploymentRate,creditOutstanding,defaultRate,businessCount,treasuryBalance,sentimentIndex&fromTick=0&toTick=360&step?=1&max?=5000`. The ten supported v1 names are `gdpProxy`, `cpi`, `m1`, `averageWage`, `unemploymentRate`, `creditOutstanding`, `defaultRate`, `businessCount`, `treasuryBalance`, and `sentimentIndex`. `creditOutstanding` is gross stored contractual principal across opening and originated loans, including defaulted obligations until legally resolved. `defaultRate` is recorded defaults divided by all stored loans and rounded deterministically to basis points. Cent-valued points use integer strings; basis-point, index, and count values use safe integers. Exact formulas are versioned and documented in [WS-704](WS_704_FULL_INDICATORS.md). Response 200:
```json
{ "series": [ {"name":"gdpProxy","unit":"cents","points":[[0,"0"],[30,"184200"]]},
              {"name":"cpi","unit":"index","points":[[0,1000],[30,1036]]},
              {"name":"sentimentIndex","unit":"bp","points":[[0,0],[30,-127]]} ], "meta":{…} }
```
Errors: 400 unknown series. Not cursor-paginated (bounded by tick range; max 10 series and 5,000 total points/request).

**Planned — GET `/simulations/{simId}/markets`** — securities-market list scheduled for WS-905; this route is not registered today.

**GET `/simulations/{simId}/markets/goods`** — authoritative Phase 4 posted-price market. Response 200: `{market:{id:"goods_riverbend",kind:"posted_price",tick,catalogVersion},products:[{product,currentRowReferencePriceCents,demandMultiplierBp,offerings:[{id,company,postedPriceCents,averageUnitCostCents,inventory,active}]}],recentPriceChanges:[{id,offeringId,companyId,sku,tick,oldPriceCents,newPriceCents,source,sourceEventId}],energy:{householdTariffCents,businessTariffCents,fuelPriceCents}|null,meta}`.

**Planned — GET `/simulations/{simId}/markets/{marketId}/prices`** — securities price-history contract scheduled for WS-905. Current goods price changes are included in the implemented `/markets/goods` response.

**GET `/simulations/{simId}/transactions`** — ledger explorer. Query: `limit,cursor,accountId?,kind?,fromTick?,toTick?,correlationId?`. Page of
`{id,tick,kind,legs:[{accountId,owner:{kind,id,name},direction,amount}],reason,actor,sourceEventId,correlationId}` ordered `seq desc`. *Guaranteed: every item's legs balance.*

**GET `/simulations/{simId}/events`** — audit-log explorer. Query: `limit,cursor,type?,actorId?,correlationId?,causationId?,fromTick?,toTick?`. Page of full envelopes (§4) ordered `seq desc`. The `causationId` filter powers the "what caused this?" chain view.

### 2.9 Runs, replay, comparison, export

**Planned — GET `/simulations/{simId}/runs`** — proposed standalone run list. Today `GET /simulations/{simId}` returns the simulation's runs directly.

**POST `/simulations/{simId}/runs/{runId}/replay`** — start a replay run from the journal + LLM cache. Auth: admin. Request: `{"toTick?":200,"mode":"strict"}` (`strict` = fail on divergence; `observe` = record divergence and continue with cached-else-fallback).
Response 202: `{"replayRun":{"id":"run_000004","replayOf":"run_000001","sourceSimulationId":"sim_000001","mode":"strict","toTick":200,"status":"running","currentTick":0,"lastComparedSeq":1,"divergenceCount":0,"firstDivergence":null,"sourceStateHash":null,"replayStateHash":null,"cacheArtifactDigest":"…","journalDigest":"…","startedWall":"…","completedWall":null,"errorCode":null,"errorMessage":null}}`. Poll `GET /simulations/{simId}/status?runId=run_000004`; its optional `replay` field has the same shape. Terminal status is `completed`, `diverged`, or `failed`. Divergence kinds are `cache_incomplete`, `event_mismatch`, `state_hash_mismatch`, and `unsupported_journal_command`. Replay is cache-only and never calls a live provider. Errors: 400 target tick beyond source or malformed request; 404 source/run; 409 source not terminal, incompatible manifest pins, or mutated source artifact.

**Planned — GET `/runs/compare?base=run_000001&candidate=run_000002&series=cpi,unemploymentRate`** — aligned series and divergence contract scheduled for WS-1104; this route is not registered today.

**POST `/simulations/{simId}/exports`** — async export. Auth: admin. Request: `{"runId":"run_000001","datasets":["events","transactions","indicators"],"format":"jsonl"}` (`jsonl|csv`).
Response 202 returns the schema-v1 job: `{"export":{"id":"xpt_0000000100000001","simulationId":"sim_00000001","runId":"run_00000001","format":"jsonl","datasets":["events","transactions","indicators"],"status":"queued","sourceTick":360,"sourceStateHash":"…","disclaimer":"Simulated scenario data - not a prediction and not financial, legal, or political advice.","files":[],"manifest":null,"auditEvents":[…],"createdWall":"…","startedWall":null,"completedWall":null,"errorCode":null,"errorMessage":null}}`. The source cannot be running or have an active advance/replay operation. Creation pins the exact source tick and logical state hash.

**GET `/exports/{exportId}`** — poll the restart-safe job. A completed response includes one content-addressed relative artifact per dataset, for example `{"dataset":"events","format":"jsonl","path":"exports/xpt_0000000100000001/events-{sha256}.jsonl","bytes":10485760,"rows":50000,"sha256":"…"}`, plus a checksummed `exports/{exportId}/manifest.json`. JSONL uses canonical LF-delimited values; CSV quotes every cell and uses canonical JSON for nested payload/leg cells. Audit events are gapless, versioned, and causally linked. Errors: 404; `status:"failed"` carries `errorCode` and `errorMessage`. Export paths are run-local artifact paths, not arbitrary filesystem paths.

## 3. Real-time contract

### 3.1 Transport evaluation

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **SSE** | one-way fits sim→UI updates; plain HTTP; deterministic `Last-Event-ID` resume; trivial through proxies; stream can carry auth headers via `fetch` | one-directional; custom parser/retry loop; HTTP/1.1 connection cap | **✅ MVP choice** |
| WebSockets | bidirectional; binary | needless complexity — all client→server traffic is comfortable as REST commands (which must be journaled anyway); manual reconnect/heartbeat | revisit only if bidirectional needs appear (e.g. collaborative admin) |
| Polling | dead simple | latency/overhead; still needed as degraded fallback | documented fallback: `GET /status` + explorers support `fromTick` deltas |

**Decision (ADR-0012):** SSE for MVP. Commands go over REST (journaled as engine input events); SSE carries a **per-tick digest** plus subscribed lifecycle frames — never one public frame per raw event at scale.

### 3.2 SSE endpoint

**GET `/simulations/{simId}/stream?topics=digest,lifecycle&runId?=…`** — `text/event-stream`. Auth: read. The v0 server accepts only `digest` and `lifecycle`. The browser uses a `fetch`/`ReadableStream` client so it can attach both `Authorization` and `Last-Event-ID`; every delivered frame is validated by the shared discriminated-union schema. The server writes `:connected` immediately after establishing the response so a proxy does not wait for the first event or heartbeat; the comment has no event ID and is ignored by the frame parser.

Frame format: `id:` = event `seq`; `event:` = topic; `data:` = JSON payload.

**Topic `digest`** — exactly one frame per completed tick:
```json
{ "v":1, "tick":12, "simDate":"Y0001-M01-D12", "indicators": {"gdpProxy":"12500","cpi":"1000","m1":"508000000","averageWage":"4235000","unemploymentRate":"649","creditOutstanding":"24166662","defaultRate":"0","businessCount":"14","treasuryBalance":"18000000","sentimentIndex":"-30"},
  "counts": {"events":2,"transactions":0,"decisions":0,"llmCalls":0,"rejectedIntents":0},
  "notable": [], "spend": {"budgetPct":0} }
```
**Topic `lifecycle`:** `{v,eventId,type,simulationId,runId,status,tick,simDate,wallTime,correlationId,causationId?}` for committed lifecycle facts.

Heartbeat: comment frame `:hb` every 15s by default. Backpressure: when raw backlog exceeds `WORLDTANGLE_SSE_MAX_BACKLOG_EVENTS`, the client receives `event: gap` with `{fromSeq,toSeq}` and refreshes status, detail, simulation-list, and event-ledger REST queries. The first connection resumes from durable `status.activity.latestEventSeq`; later reconnects resume from the last delivered sequence with bounded exponential retry. Terminal runs disable the live stream and render the durable status digest. A 401 enters `auth-required` state without retrying. Future owning modules may add `news`, `errors`, `market`, and `policy` topics.

## 4. Event envelope & catalog

### 4.1 Envelope (schemaVersion 1)

```ts
interface EventEnvelope<T> {
  eventId: string;            // evt_<base36seq> — unique per run
  type: string;               // e.g. "loan.approved"
  schemaVersion: number;      // per-type payload version, starts at 1
  simulationId: string; runId: string;
  seq: number;                // per-run monotonic, gapless — SSE id + cursor basis
  tick: number; simDate: string;
  wallTime: string;           // ISO-8601 (informational; excluded from hashes)
  actor: { kind: "agent"|"institution"|"system"|"admin"; id: string };
  correlationId: string;      // workflow chain (e.g. one loan application end-to-end)
  causationId?: string;       // the eventId that directly caused this one
  payload: T;                 // typed per event type (JSON Schema published)
}
```

Rules: payloads are validated at append time; money as string-cents; **no free text in payloads except explicitly-marked `*Text` fields** (rationales, headlines) which the UI treats as inert data; envelope fields never change meaning within v1 — payload evolution bumps that type's `schemaVersion` with additive-preferred changes.

### 4.2 Catalog (MVP unless tagged)

| Type | Emitted when | Payload (key fields) |
|---|---|---|
| `simulation.created/started/paused/resumed/stopped` | lifecycle | `{status, byCommandEventId?}` |
| `simulation.tick.started` | phase 1 begins | `{tick}` |
| `simulation.tick.completed` | commit done | `{tick, indicators:{gdpProxy,cpi,m1,averageWage,unemploymentRate,creditOutstanding,defaultRate,businessCount,treasuryBalance,sentimentIndex}, counts:{events,transactions,decisions,llmCalls}, durationMs}` |
| `simulation.snapshot.created` | periodic/manual | `{snapshotId, tick, stateHash}` |
| `simulation.statehash.computed` | every N ticks | `{tick, stateHash}` |
| `admin.command.received` | any control/API mutation | `{command, params, requestId}` — journaled **before** effect |
| `world.event.injected` | injection accepted | `{worldEventId, type, params, scheduledTick, source}` |
| `world.event.applied` | scheduled boundary reached | `{worldEventId, type, params, scheduledTick, appliedTick, effectCount}` |
| `market.row_reference_price.changed` | ROW shift applied | `{worldEventId, sku, oldPriceCents, newPriceCents, changeBp}` |
| `market.demand.changed` | bounded demand shock applied | `{worldEventId, sku, changeBp, priorMultiplierBp, nextMultiplierBp, effectiveTick, expiresTick}` |
| `company.capacity.disrupted` | bounded business disaster applied | `{worldEventId, companyId, capacityReductionBp, priorMultiplierBp, nextMultiplierBp, effectiveTick, expiresTick}` |
| `agent.created` | world-gen | `{agentId, occupation, householdId}` |
| `llm.call.recorded` | immutable provider/fallback evidence reserved inside the tick | `{schemaVersion,callId,decisionId,agentId,moduleId,purpose,provider,model,requestHash,promptHash,status,effectiveTier,fallbackReason?,cached,attempts}` |
| `agent.decision.recorded` | bounded choice resolved | `{schemaVersion,decisionId,agentId,tier,kind,chosenActionId,llmCallId?,validationFailureCount}` |
| `agent.action.started` | intent validated, execution begins | `{actionId, actorId, type, params, decisionId?}` |
| `agent.action.completed` | executor done | `{actionId, resultSummary, resultEventIds}` |
| `agent.action.rejected` | validation failed | `{actorId, type, params, code, reasonText, decisionId?}` |
| `agent.opinions.updated` | bounded attributed drift batch applied | `{opinionBatchId,tick,updates:[{opinionUpdateId,agentId,axis,previousValue,delta,value,causeStoryIds,causeContributionIds,sourceSentimentUpdateIds,sourceSentimentEventIds}],perAgentAxisTickDeltaCap,rulesetVersion}` |
| `agent.quarantined` | failure ladder tripped | `{agentId, untilTick, reason}` |
| `conversation.started` | opened | `{conversationId, participants, topic, triggerEventId}` |
| `conversation.message.created` | each turn | `{conversationId, messageId, senderId, turn, contentText, structuredTerms?}` |
| `conversation.ended` | closed | `{conversationId, outcome:{kind, structuredTerms?}, turns, reason}` |
| `employment.created` | two-sided choice validated and contract signed | `{employmentContractId,legalContractId,jobId,employerId,employeeAgentId,annualWageCents,startTick,noticeDays,score,founderDecisionId?,applicantDecisionId?}` |
| `employment.terminated` | any end | `{contractId, reason: quit\|layoff\|company_failure\|fired, noticeTicks}` |
| `payroll.due` | each D15/D30 obligation | `{contractId, employerId, employeeAgentId, grossCents}` |
| `payroll.executed` | funded D15/D30 obligation | `{contractId, employeeAgentId, transactionId, grossCents, withholdingCents, netCents}` |
| `payroll.missed` | employer cannot fund gross | `{contractId, employerId, employeeAgentId, grossCents, reason}` |
| `company.created` | registered→active | `{companyId, name, sector, founderId, foundingCapital, capTable}` |
| `company.failed` | wind-down complete | `{companyId, causeChain:[eventIds], creditorRecoveries:[{claimId,creditorId,creditorKind,amountCents}], liquidationProceedsCents, salvageProceedsCents, writtenOffCents, employeesTerminated, contractsTerminated, jobsWithdrawn, offeringsDeactivated, accountsClosed}` |
| `account.opened` | new account | `{accountId, bankId, ownerKind, ownerId, type}` |
| `transaction.posted` | every posting | `{transactionId, kind, legs:[{accountId,direction,amount}], reason, sourceEventId}` |
| `loan.application.created` | submitted | `{applicationId, applicantKind, applicantId, bankId, purpose, amountCents, termMonths, scoreAssessmentId, modelVersion}` |
| `loan.score.computed` | immutable model-v1 assessment | `{assessmentId, applicationId, applicantKind, applicantId, modelVersion, inputs:{annualIncomeCents,annualDebtServiceCents,existingDebtCents,requestedAmountCents,termMonths,incomeStabilityBp,debtToIncomeBp,historyScoreBp,completedPayments,missedPayments,defaults,noHistory,incomeEvidenceRefs,debtEvidenceRefs},systemScore,breakdown}` |
| `loan.application.review_started` | immutable officer assignment | `{reviewId,applicationId,assessmentId,bankId,officerAgentId,reviewTier}` |
| `bank.lending.assessed` | every approval/disbursement gate | `{assessmentId,applicationId,decisionId?,stage,bankId,borrowerKind,borrowerId,policyVersion,bankStatusBefore,bankStatusAfter,depositCents,projectedDepositCents,reserveCents,reserveRatioBp,projectedReserveRatioBp,reserveRatioMinBp,effectiveCapitalCents,capitalRatioBp,projectedCapitalRatioBp,capitalRatioMinBp,borrowerExposureCents,projectedBorrowerExposureCents,borrowerExposureCapCents,requestedAmountCents,bankOpen,reservePassed,capitalPassed,exposurePassed,systemicPassed,allowed,failedBreakers,evidence}` |
| `bank.lending.halted` / `bank.lending.resumed` | systemic breaker transition | `{bankId,assessmentId,applicationId,stage,statusBefore,statusAfter,failedBreakers,evidence}` |
| `bank.lending.blocked` | a gate rejects the requested credit | `{bankId,assessmentId,applicationId,decisionId?,stage,scope:bank\|borrower,requestedAmountCents,failedBreakers,bankStatus,evidence}` |
| `loan.approved` | immutable model-v1 decision | `{decisionId,agentDecisionId?,applicationId,assessmentId,reviewId,reviewTier,applicantKind,applicantId,bankId,amountCents,termMonths,scoreInputs,scoreBreakdown,systemScore,officerAgentId,officerAdjustment,finalScore,officerRationale,policyVersion,policyChecks,failedChecks:[],offeredRateBp,circuitBreakerAssessment}` |
| `loan.rejected` | immutable model-v1 decision | same complete decision payload; `failedChecks` is nonempty, `offeredRateBp:null`, and `circuitBreakerAssessment` identifies any bank gate failure |
| `loan.disbursement.blocked` | an approved application fails its fresh pre-mutation gate | `{applicationId,decisionId,bankId,borrowerKind,borrowerId,requestedAmountCents,assessmentId,failedBreakers,evidence}` |
| `loan.disbursed` | approved funds created atomically | `{loanId,applicationId,decisionId,borrowerKind,borrowerId,bankId,principalCents,annualRateBp,termMonths,disbursedTick,maturityTick,bankAssetAccountId,borrowerDepositAccountId,disbursementTransactionId,scheduleDigest,circuitBreakerAssessment,evidence}` |
| `loan.schedule.created` | immutable 30/360 terms fixed | `{loanId,applicationId,decisionId,scheduleDigest,convention,installments:[{id,installmentNumber,dueTick,openingPrincipalCents,principalDueCents,interestDueCents,totalDueCents}],evidence}` |
| `loan.payment.due` | an originated installment reaches its exact due tick | `{loanId,borrowerKind,borrowerId,bankId,currentInstallmentId,installmentIds,principalCents,interestCents,totalCents,consecutiveMisses,evidence}` |
| `loan.payment.completed` | one current or arrears installment settles in full | `{loanId,installmentId,installmentNumber,wasInArrears,principalCents,interestCents,totalCents,transactionId,evidence}` |
| `loan.collection.updated` | the loan aggregate advances after an atomic collection set | `{loanId,outstandingPrincipalCents,consecutiveMisses,status,collectedInstallmentIds,evidence}` |
| `loan.payment.missed` | complete arrears cannot be funded | `{loanId,installmentId,installmentNumber,requiredCents,availableCents,consecutiveMisses,defaultThreshold,missedInstallmentIds,evidence}` |
| `loan.defaulted` | 3rd consecutive miss | `{defaultId,loanId,borrowerKind,borrowerId,bankId,defaultTick,outstandingPrincipalCents,consecutiveMisses,missedInstallmentIds,writeDownTransactionId,lossAccountId,creditScoreBefore,creditScorePenaltyPoints,creditScoreAfter,evidence}` |
| `agent.credit_score.penalized` | a personal-loan default applies the bounded persisted penalty | `{agentId,loanId,defaultId,scoreBefore,penaltyPoints,scoreAfter,floor,evidence}` |
| `venture.firm.created` [V1] | Riverbend VC firm seeded | `{firmId,name,status,evidence}` |
| `venture.fund.created` [V1] | immutable fund opened | `{fundId,firmId,name,fundSizeCents,bankAccountId,evidence}` |
| `venture.fund.deployed` [V1] | capital commitment advances | `{deploymentId,fundId,targetCompanyId,referenceId,amountCents,deployedBeforeCents,deployedAfterCents,remainingCents,evidence}` |
| `investment.proposed` [V1] | bounded pitch accepted for negotiation | `{proposalId,companyId,founderAgentId,firmId,fundId,vcPartnerAgentId,askAmountCents,preMoneyValuationCents,equityBasisPoints,proposedTick,expiresTick,evidence}` |
| `investment.proposal.agreed` [V1] | bounded terms accepted, awaiting atomic close | `{proposalId,companyId,negotiationConversationId,finalTerms:{kind,referenceId,amountCents,preMoneyValuationCents,equityBasisPoints},evidence}` |
| `investment.completed` [V1] | exact priced round closes atomically | `{investmentId,proposalId,companyId,investorId,firmId,amountCents,preMoneyValuationCents,sharesIssued,pricePerShareCents,transactionId,capitalCallTransactionId,contractId,ownershipStakeId,completedTick,capTableBefore,capTableAfter,evidence}` |
| `investment.rejected` [V1] | negotiation failed or expired | `{proposalId,companyId,negotiationConversationId,reason,status:rejected|expired,evidence}` |
| `investment.distribution.requested` [V1] | exact owner allocation accepted | `{distributionId,companyId,amountCents,totalShares,referenceId,allocations,evidence}` |
| `investment.distribution.completed` [V1] | dividend transaction and allocation journal commit | `{distributionId,companyId,amountCents,totalShares,companyAccountId,transactionId,referenceId,distributedTick,allocations,requestEventId,evidence}` |
| `contract.drafted` | law firm output | `{contractId, type, parties, fee, drafterId}` |
| `contract.signed` | all parties signed | `{contractId, type, effectiveTick}` |
| `contract.terminated` | ended | `{contractId, reason, byPartyId?}` |
| `contract.breached` | predicate hit | `{contractId, obligationRef, breachKind, remedy}` |
| `news.story.published` | editor passes | `{storyId, orgId, authorId, headline, topic, stance, citedEventIds}` |
| `sentiment.updated` | story effect or nonzero decay | `{updateId, topic, tick, previousTick, previousValue, decayedValue, storyDelta, value, contributingStories:[{contributionId,storyId,storyTopic,stance,reach,outcomeScore,stanceDelta,outcomeDelta,delta,citedEventIds}], caps, rulesetVersion}` |
| `policy.changed` | effective at boundary | `{key, old, new, effectiveTick, source, causeEventId}` |
| `tax.collected` | assessment settled | `{taxId, payerId, baseCents, rateBp, amountCents, transactionId}` |
| `benefit.due/paid/suspended` | unemployment benefit evaluated | `{agentId, amountCents, transactionId?|reason?}` |
| `household.purchase.requested/completed` | daily basket item evaluated/settled | `{householdId, category, requestedCents?|amountCents?, transactionId?}` |
| `financial_stress.triggered` | essential demand cannot be funded | `{householdId, category, requestedCents, paidCents, shortfallCents}` |
| `economic.metrics.updated` | metrics phase commits | `{rulesetVersion,indicators:{gdp_proxy_cents,cpi_index,m1_cents,average_wage_cents,unemployment_rate_bp,credit_outstanding_cents,default_rate_bp,active_business_count,treasury_balance_cents,sentiment_index_bp},evidence:{[indicatorKey]:{formulaVersion,inputsDigest}}}` |
| `security.listed` [V1] | IPO | `{securityId, companyId, symbol, sharesListed, referencePrice}` |
| `market.order.created` [V1] | order accepted | `{orderId, securityId, side, limitPrice, quantity, escrowRef}` |
| `market.order.cancelled` [V1] | cancel/expire | `{orderId, reason}` |
| `market.trade.executed` [V1] | auction match | `{tradeId, securityId, price, quantity, buyOrderId, sellOrderId, settlementTransactionId}` |
| `market.price.updated` | goods rule/decision or auction | `{sku?|securityId?, old, new, source: rule\|decision:{id}\|auction}` |
| `llm.budget.threshold` | 80%/100% | `{runId, pct, spend, action: warn\|auto_pause}` |
| `system.error.raised` | engine error | `{code, message, module, tick, correlationId}` |

### 4.3 Compatibility & testing

- Implemented request/response and SSE schemas live in `packages/shared`; catalog payload schemas are added with their owning modules. The Phase 0 core contracts have a versioned, golden-hashed JSON Schema bundle; the HTTP JSON Schema catalog and OpenAPI document are not implemented yet.
- Contract tests validate current server responses, and the frontend imports the same Zod schemas for runtime validation and inferred types — drift fails tests or at the client boundary.
- Deprecation: event types are never renamed in v1; superseded types keep emitting for ≥1 minor release alongside replacements.
