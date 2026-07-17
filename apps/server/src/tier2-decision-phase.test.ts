import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  eventEnvelopeSchema,
  IdFactory,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  EventBus,
  generateRiverbendPopulation,
  GoalLifecycleEngine,
  MockLlmProvider,
  SimLoop,
  simDateForTick,
  type LlmRequest,
  type TickContext,
} from "@worldtangle/engine";
import {
  openWorldDatabase,
  readRunCheckpoint,
  SqliteAgentStore,
  SqliteCreditStore,
  SqliteEventStore,
  SqliteFinanceStore,
  SqliteLlmCallStore,
  SqliteMarketStore,
  SqlitePhase4Store,
  SqliteTickCommitter,
  type WorldDatabase,
} from "./persistence";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./persistence/test-helpers";
import {
  createTier2DecisionPhaseHandler,
  discoverTier2DecisionOpportunities,
  prepareTier2DecisionBatch,
  type Tier2DecisionOpportunity,
} from "./tier2-decision-phase";
import { SimulationService } from "./simulation-service";

const directories: string[] = [];
const databases: WorldDatabase[] = [];
const services: SimulationService[] = [];

interface Tier2Fixture {
  readonly db: WorldDatabase;
  readonly ids: IdFactory;
  readonly events: SqliteEventStore;
  readonly phase4: SqlitePhase4Store;
  readonly founderAgentId: string;
  readonly applicantAgentId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly applicationId: string;
}

type TickFixture = Pick<Tier2Fixture, "db" | "ids" | "events">;

function checkpointFixture(base: TickFixture, currentTick: number): void {
  base.db.prepare(`
    UPDATE simulation_runs
    SET status = 'paused', current_tick = ?, next_event_seq = ?,
      id_state_canonical = ?, started_wall = 'WS605-T0'
    WHERE id = ?
  `).run(
    currentTick,
    base.events.count(),
    canonicalStringify(base.ids.serialize()),
    TEST_RUN_ID,
  );
}

function persistentContext(
  db: WorldDatabase,
  events: SqliteEventStore,
  ids: IdFactory,
  tick: number,
  phase: TickContext["phase"],
): TickContext {
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: simDateForTick(tick),
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.ws605.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const eventId = ids.next("evt");
      const event = eventEnvelopeSchema.parse({
        eventId,
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq: events.count(),
        tick,
        simDate: simDateForTick(tick),
        wallTime: "WS605-T0",
        actor: options?.actor ?? { kind: "system", id: "ws605-test" },
        correlationId: options?.correlationId ?? eventId,
        ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
        payload,
      }) as EventEnvelope;
      events.append(event);
      return event;
    },
  };
}

function fixture(): Tier2Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-tier2-integration-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggers = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggers);
  const ids = IdFactory.restore(population.idState);
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);
  const events = new SqliteEventStore(db, TEST_RUN_ID);
  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const lawFirmAccount = finance.listAccounts()
    .find((account) => account.ownerKind === "company")!;
  const formation = phase4.requestCompanyFormation({
    name: "Tier Two Labor Works",
    sector: "professional_services",
    founderAgentId: "agt_00000001",
    jurisdiction: "Riverbend",
    foundingCapitalCents: "200000",
    totalShares: "1000",
    lawFirmAccountId: lawFirmAccount.id,
    incorporationFeeCents: "10000",
    tick: 0,
    ids,
  });
  for (const party of formation.contract.parties) {
    phase4.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, ids);
  }
  for (let tick = 1; tick <= 5; tick++) {
    phase4.processLegalObligations(persistentContext(db, events, ids, tick, "obligations"));
    phase4.processCompanyFormations(persistentContext(db, events, ids, tick, "execute"));
  }
  const job = phase4.postJob({
    employerId: formation.company.id,
    occupationCode: "bookkeeper",
    title: "Tier Two Bookkeeper",
    annualWageCents: "5000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids,
  });
  const applicantAgentId = population.residents
    .filter((resident) => resident.agent.employmentStatus !== "employed")
    .map((resident) => resident.agent.id)
    .sort()[0]!;
  const application = phase4.submitJobApplication({
    jobId: job.id,
    agentId: applicantAgentId,
    reservationWageCents: "4000000",
    tick: 6,
    ids,
  });
  persistentContext(db, events, ids, 6, "decisions").emit("job.application.submitted", {
    companyId: formation.company.id,
    jobId: job.id,
    applicationId: application.id,
    applicantAgentId,
  });
  const result = {
    db,
    ids,
    events,
    phase4,
    founderAgentId: formation.company.founderAgentId,
    applicantAgentId,
    companyId: formation.company.id,
    jobId: job.id,
    applicationId: application.id,
  };
  checkpointFixture(result, 6);
  return result;
}

function goalFixture(): TickFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-tier2-goal-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggers = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  const agentStore = new SqliteAgentStore(db, TEST_RUN_ID);
  agentStore.insertPopulation(population, triggers);
  const base = {
    db,
    ids: IdFactory.restore(population.idState),
    events: new SqliteEventStore(db, TEST_RUN_ID),
  };
  const selectableAgentId = population.residents
    .map((resident) => resident.agent.id)
    .find((agentId) => agentStore.listByAgent(agentId).some((record) => (
      record.goal.status === "dormant"
    )))!;
  const activeGoal = agentStore.listByAgent(selectableAgentId)
    .find((record) => record.goal.status === "active")!;
  const context = persistentContext(db, base.events, base.ids, 1, "decisions");
  new GoalLifecycleEngine({ repository: agentStore }).abandon(activeGoal.goal.id, {
    tick: 1,
    rationale: "prepare a bounded activation choice",
    emit: context.emit,
  });
  checkpointFixture(base, 90);
  return base;
}

interface OfferedProposal {
  readonly actionId: string;
  readonly params: unknown;
  readonly rationale: string;
}

function optionFor(request: LlmRequest, actionId: string): OfferedProposal {
  const options = request.options as readonly OfferedProposal[] | undefined;
  const selected = options?.find((option) => option.actionId === actionId);
  if (selected === undefined) throw new Error(`missing offered option ${actionId}`);
  return { ...selected, rationale: `mock selected ${actionId}` };
}

async function runPreparedTick(
  base: TickFixture,
  provider: MockLlmProvider,
  input: {
    readonly tick: number;
    readonly expectedKinds: readonly string[];
    readonly select?: (
      opportunities: readonly Tier2DecisionOpportunity[],
    ) => readonly Tier2DecisionOpportunity[];
  },
) {
  const discovered = discoverTier2DecisionOpportunities(base.db, TEST_RUN_ID, input.tick);
  const opportunities = input.select?.(discovered) ?? discovered;
  expect(opportunities.map((opportunity) => opportunity.kind)).toEqual(input.expectedKinds);
  const batch = await prepareTier2DecisionBatch({
    db: base.db,
    runId: TEST_RUN_ID,
    tick: input.tick,
    provider,
    promptPackVersion: 1,
    opportunities,
  });
  const checkpoint = readRunCheckpoint(base.db, TEST_RUN_ID);
  expect(checkpoint.currentTick).toBe(input.tick - 1);
  const committer = new SqliteTickCommitter(base.db, base.events);
  const loop = new SimLoop({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seed: 42,
    bus: new EventBus(),
    log: base.events,
    ids: base.ids,
    initialTick: checkpoint.currentTick,
    nextSeq: checkpoint.nextEventSeq,
    wallClock: () => "WS605-T0",
    tickCommitter: committer,
    tickUnitOfWork: committer,
  });
  loop.registerPhase(
    "decisions",
    createTier2DecisionPhaseHandler(base.db, TEST_RUN_ID, batch),
  );
  expect(loop.tick()).toBe(input.tick);
  return batch;
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-605 prepared Tier-2 decision barrier", () => {
  it("runs the production SimulationService pre-tick provider barrier in mock mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-tier2-service-"));
    directories.push(dataDir);
    let monotonicReading = 0;
    const service = new SimulationService({
      dataDir,
      enableNewsPipeline: false,
      wallClock: () => "2026-07-15T12:00:00.000Z",
      monotonicClock: () => {
        monotonicReading += 0.25;
        return monotonicReading;
      },
      llmModelPrices: new Map([["mock-llm-v1", {
        inputMicrocentsPerToken: 17n,
        outputMicrocentsPerToken: 41n,
      }]]),
      tickIntervalMs: 60_000,
      snapshotIntervalTicks: 100,
    });
    services.push(service);
    const created = service.createSimulation({
      name: "WS-605 production barrier",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 20_000 },
        policyOverrides: {},
        endTick: 60,
      },
    }, "ws605-create");
    service.controlSimulation(created.simulation.id, "start", {}, "ws605-start");
    service.controlSimulation(created.simulation.id, "pause", {}, "ws605-pause");

    const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
    const checkpoint = readRunCheckpoint(db, created.run.id);
    const ids = IdFactory.restore(checkpoint.idState);
    const events = new SqliteEventStore(db, created.run.id);
    const finance = new SqliteFinanceStore(db, created.run.id);
    const phase4 = new SqlitePhase4Store(db, created.run.id);
    const lawFirmAccount = finance.listAccounts()
      .find((account) => account.ownerKind === "company")!;
    const formation = phase4.requestCompanyFormation({
      name: "Service Barrier Works",
      sector: "professional_services",
      founderAgentId: "agt_00000001",
      jurisdiction: "Riverbend",
      foundingCapitalCents: "200000",
      totalShares: "1000",
      lawFirmAccountId: lawFirmAccount.id,
      incorporationFeeCents: "10000",
      tick: 0,
      ids,
    });
    for (const party of formation.contract.parties) {
      phase4.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, ids);
    }
    for (let tick = 1; tick <= 5; tick++) {
      phase4.processLegalObligations(persistentContext(db, events, ids, tick, "obligations"));
      phase4.processCompanyFormations(persistentContext(db, events, ids, tick, "execute"));
    }
    const job = phase4.postJob({
      employerId: formation.company.id,
      occupationCode: "bookkeeper",
      title: "Service Barrier Bookkeeper",
      annualWageCents: "5000000",
      requirements: [],
      openings: 1,
      tick: 6,
      ids,
    });
    const applicantAgentId = db.prepare<[string], { id: string }>(`
      SELECT id FROM agents
      WHERE run_id = ? AND employment_status != 'employed'
      ORDER BY id LIMIT 1
    `).get(created.run.id)!.id;
    const application = phase4.submitJobApplication({
      jobId: job.id,
      agentId: applicantAgentId,
      reservationWageCents: "4000000",
      tick: 6,
      ids,
    });
    persistentContext(db, events, ids, 6, "decisions").emit("job.application.submitted", {
      companyId: formation.company.id,
      jobId: job.id,
      applicationId: application.id,
      applicantAgentId,
    });
    db.prepare(`
      UPDATE simulation_runs
      SET current_tick = 6, next_event_seq = ?, id_state_canonical = ?
      WHERE id = ?
    `).run(events.count(), canonicalStringify(ids.serialize()), created.run.id);
    db.close();

    const advanced = await service.advanceSimulation(
      created.simulation.id,
      { runId: created.run.id, ticks: 1 },
      "ws605-advance",
    );
    expect(advanced).toMatchObject({
      statusCode: 200,
      body: { run: { currentTick: 7 } },
    });

    const verified = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
    databases.push(verified);
    const calls = new SqliteLlmCallStore(verified, created.run.id).list();
    expect(calls.map((call) => call.purpose)).toEqual([
      "decision.tier2.founder_hiring",
      "decision.tier2.job_response",
    ]);
    expect(calls.every((call) => call.provider === "mock" && call.tick === 7)).toBe(true);
    const callsWithTelemetry = new SqliteLlmCallStore(verified, created.run.id)
      .listWithTelemetry();
    expect(callsWithTelemetry.every((call) => call.latencyMs === 0)).toBe(true);
    expect(callsWithTelemetry.every((call) => BigInt(call.costMicrocents) > 0n)).toBe(true);
    const exactCost = callsWithTelemetry.reduce(
      (sum, call) => sum + BigInt(call.costMicrocents),
      0n,
    );
    const status = service.getStatus(created.simulation.id, created.run.id) as {
      llm: {
        spend: { inputTokens: number; outputTokens: number; costCentsEstimate: string };
        cacheHitRate: number;
      };
    };
    expect(status.llm.spend.inputTokens).toBe(
      calls.reduce((sum, call) => sum + call.inputTokens, 0),
    );
    expect(status.llm.spend.outputTokens).toBe(
      calls.reduce((sum, call) => sum + call.outputTokens, 0),
    );
    const roundedStatusMicrocents = BigInt(status.llm.spend.costCentsEstimate) * 1_000_000n;
    expect(roundedStatusMicrocents - exactCost).toBeGreaterThanOrEqual(0n);
    expect(roundedStatusMicrocents - exactCost).toBeLessThan(1_000_000n);
    expect(status.llm.cacheHitRate).toBe(0);
    expect(calls.map((call) => ({
      status: call.status,
      fallbackReason: call.fallbackReason ?? null,
      effectiveTier: call.effectiveTier,
      providerErrorCode: call.providerErrorCode ?? null,
      detail: call.detail ?? null,
    }))).toEqual([
      {
        status: "success",
        fallbackReason: null,
        effectiveTier: 2,
        providerErrorCode: null,
        detail: null,
      },
      {
        status: "success",
        fallbackReason: null,
        effectiveTier: 2,
        providerErrorCode: null,
        detail: null,
      },
    ]);
    const serviceDecisions = [
      ...new SqliteAgentStore(verified, created.run.id)
        .listDecisions(formation.company.founderAgentId, { limit: 10 }),
      ...new SqliteAgentStore(verified, created.run.id)
        .listDecisions(applicantAgentId, { limit: 10 }),
    ].filter((decision) => decision.tick === 7);
    expect(serviceDecisions.map((decision) => ({
      tier: decision.tier,
      action: decision.chosenActionId,
      rationale: decision.rationale,
    }))).toEqual([
      expect.objectContaining({ tier: 2 }),
      expect.objectContaining({ tier: 2 }),
    ]);
    expect(new SqliteEventStore(verified, created.run.id).list().filter((event) => (
      event.type === "llm.call.recorded" && event.tick === 7
    ))).toHaveLength(2);
  });

  it("commits mock founder and applicant choices with calls, actions, effects, and memories", async () => {
    const base = fixture();
    const provider = new MockLlmProvider({
      script: (request) => optionFor(
        request,
        request.purpose === "decision.tier2.founder_hiring" ? "hiring.offer" : "job.accept",
      ),
    });

    await runPreparedTick(base, provider, {
      tick: 7,
      expectedKinds: ["founder_hiring", "job_response"],
    });

    expect(provider.calls).toHaveLength(2);
    const calls = new SqliteLlmCallStore(base.db, TEST_RUN_ID).list();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => (
      call.status === "success" && call.effectiveTier === 2 && call.attempts === 1
    ))).toBe(true);
    const agents = new SqliteAgentStore(base.db, TEST_RUN_ID);
    const decisions = [
      ...agents.listDecisions(base.founderAgentId, { limit: 10 }),
      ...agents.listDecisions(base.applicantAgentId, { limit: 10 }),
    ].filter((decision) => decision.tick === 7);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((decision) => decision.tier === 2 && decision.llmCallId !== undefined))
      .toBe(true);
    expect(agents.listActions().filter((action) => (
      decisions.some((decision) => decision.id === action.decisionId)
    ))).toHaveLength(2);
    expect(base.phase4.listJobApplications(base.jobId)[0]?.status).toBe("selected");
    expect(base.db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM employment_contracts
      WHERE run_id = ? AND employee_agent_id = ? AND status = 'active'
    `).get(TEST_RUN_ID, base.applicantAgentId)?.count).toBe(1n);
    expect(base.events.list().filter((event) => event.type === "llm.call.recorded"))
      .toHaveLength(2);
    expect(base.events.list().filter((event) => event.type === "agent.action.completed"))
      .toHaveLength(2);
    const founderDecision = decisions.find((decision) => decision.agentId === base.founderAgentId)!;
    const founderAction = agents.listActions()
      .find((action) => action.decisionId === founderDecision.id)!;
    expect(agents.list(base.founderAgentId).some((memory) => (
      memory.kind === "outcome" &&
      memory.content.includes(founderDecision.chosenActionId!) &&
      founderAction.resultEventIds.some((eventId) => memory.references.includes(eventId))
    ))).toBe(true);
    expect(readRunCheckpoint(base.db, TEST_RUN_ID)).toMatchObject({
      currentTick: 7,
      nextEventSeq: base.events.count(),
      idState: base.ids.serialize(),
    });
  });

  it("applies a mock founder price only from the engine-authored cost envelope", async () => {
    const base = fixture();
    const market = new SqliteMarketStore(base.db, TEST_RUN_ID);
    const created = market.createProductionOffering({
      companyId: base.companyId,
      sku: "groceries",
      postedPriceCents: "400",
      unitCostCents: "300",
      laborHoursPerWorker: 8,
      productivityMilliunitsPerLaborHour: 1_250,
      capacityUnitsPerTick: 12,
      tick: 6,
      ids: base.ids,
    });
    persistentContext(base.db, base.events, base.ids, 6, "decisions").emit(
      "market.offering.created",
      { companyId: base.companyId, offeringId: created.offering.id },
    );
    checkpointFixture(base, 12);
    const provider = new MockLlmProvider({
      script: (request) => {
        const options = request.options as readonly OfferedProposal[];
        const selected = options.at(-1);
        if (selected === undefined) throw new Error("pricing menu was empty");
        return { ...selected, rationale: "select the bounded upper price" };
      },
    });

    const batch = await runPreparedTick(base, provider, {
      tick: 13,
      expectedKinds: ["founder_pricing"],
      select: (opportunities) => opportunities.filter((entry) => entry.kind === "founder_pricing"),
    });

    const founderDecision = new SqliteAgentStore(base.db, TEST_RUN_ID)
      .listDecisions(base.founderAgentId, { limit: 10 })
      .find((decision) => decision.tick === 13)!;
    const history = market.listPriceHistory(created.offering.id);
    expect(history).toEqual([expect.objectContaining({
      offeringId: created.offering.id,
      oldPriceCents: "400",
      source: "decision",
      decisionId: founderDecision.id,
    })]);
    expect(BigInt(history[0]!.newPriceCents)).toBeGreaterThanOrEqual(300n);
    expect(BigInt(history[0]!.newPriceCents)).toBeLessThanOrEqual(450n);
    expect(founderDecision.params).toEqual(
      batch.entries[0]!.opportunity.options.find((option) => (
        option.actionId === founderDecision.chosenActionId
      ))!.params,
    );
    expect(base.events.list().some((event) => (
      event.type === "market.price.updated" && event.correlationId === founderDecision.id
    ))).toBe(true);
  });

  it("applies the mock loan officer adjustment through the real Tier-2 why record", async () => {
    const base = fixture();
    const credit = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const bankId = base.db.prepare<[string], { id: string }>(`
      SELECT id FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
    `).get(TEST_RUN_ID)!.id;
    const applicantId = base.db.prepare<[string], { id: string }>(`
      SELECT agent.id FROM agents agent
      WHERE agent.run_id = ? AND agent.employment_status = 'employed'
        AND agent.id NOT IN (
          SELECT borrower_id FROM seed_loans
          WHERE run_id = agent.run_id AND borrower_kind = 'agent'
        )
      ORDER BY agent.id LIMIT 1
    `).get(TEST_RUN_ID)!.id;
    const submitted = credit.submitApplication({
      applicantKind: "agent",
      applicantId,
      bankId,
      purpose: "Replace a failed vehicle",
      amountCents: "600001",
      termMonths: 12,
    }, persistentContext(base.db, base.events, base.ids, 5, "decisions"));
    const reviewing = credit.beginReview(
      submitted.application.id,
      persistentContext(base.db, base.events, base.ids, 6, "decisions"),
      undefined,
      "tier2",
    );
    checkpointFixture(base, 6);
    const provider = new MockLlmProvider({
      script: (request) => optionFor(request, "loan.adjust_plus_5"),
    });

    await runPreparedTick(base, provider, {
      tick: 7,
      expectedKinds: ["loan_officer_adjustment"],
      select: (opportunities) => opportunities.filter((entry) => (
        entry.kind === "loan_officer_adjustment"
      )),
    });

    const agentDecision = new SqliteAgentStore(base.db, TEST_RUN_ID)
      .listDecisions(reviewing.review.officerAgentId, { limit: 10 })
      .find((decision) => decision.tick === 7)!;
    expect(credit.getDecisionForApplication(submitted.application.id)).toMatchObject({
      reviewTier: "tier2",
      agentDecisionId: agentDecision.id,
      officerAdjustment: 5,
      rationale: "mock selected loan.adjust_plus_5",
    });
    expect(new SqliteLlmCallStore(base.db, TEST_RUN_ID).list()[0]).toMatchObject({
      decisionId: agentDecision.id,
      status: "success",
      effectiveTier: 2,
    });
  });

  it("activates exactly the mock-selected goal from the eligible menu", async () => {
    const base = goalFixture();
    const provider = new MockLlmProvider({
      script: (request) => {
        const options = request.options as readonly OfferedProposal[];
        const selected = options.find((option) => option.actionId.startsWith("goal.activate_"));
        if (selected === undefined) throw new Error("goal activation menu was empty");
        return { ...selected, rationale: "activate the eligible bounded goal" };
      },
    });

    const batch = await runPreparedTick(base, provider, {
      tick: 91,
      expectedKinds: ["goal_activation"],
      select: (opportunities) => opportunities
        .filter((entry) => entry.kind === "goal_activation")
        .slice(0, 1),
    });

    const opportunity = batch.entries[0]!.opportunity;
    const decision = new SqliteAgentStore(base.db, TEST_RUN_ID)
      .listDecisions(opportunity.agentId, { limit: 10 })
      .find((candidate) => candidate.tick === 91)!;
    const goalId = (decision.params as { goalId: string }).goalId;
    const agentStore = new SqliteAgentStore(base.db, TEST_RUN_ID);
    expect(agentStore.get(goalId)?.goal.status).toBe("active");
    expect(agentStore.listByAgent(opportunity.agentId).filter((record) => (
      record.goal.status === "active"
    )).map((record) => record.goal.id)).toEqual([goalId]);
    expect(base.events.list().some((event) => (
      event.type === "agent.goal.activated" &&
      (event.payload as { goalId?: string }).goalId === goalId
    ))).toBe(true);
  });

  it("rejects forged params, records a validation fallback, and applies only an offered action", async () => {
    const base = fixture();
    const forgedCompanyId = "co_zzzzzzzz";
    const provider = new MockLlmProvider({
      script: (request) => {
        if (request.purpose !== "decision.tier2.founder_hiring") {
          return optionFor(request, "job.accept");
        }
        const offered = optionFor(request, "hiring.offer");
        return {
          ...offered,
          params: { ...(offered.params as Readonly<Record<string, unknown>>), companyId: forgedCompanyId },
          rationale: "attempt to substitute an unauthorized company",
        };
      },
    });

    await runPreparedTick(base, provider, {
      tick: 7,
      expectedKinds: ["founder_hiring", "job_response"],
    });

    const agents = new SqliteAgentStore(base.db, TEST_RUN_ID);
    const founderDecision = agents.listDecisions(base.founderAgentId, { limit: 10 })
      .find((decision) => decision.tick === 7)!;
    expect(founderDecision.tier).toBe(1);
    const chosen = founderDecision.optionsOffered
      .find((option) => option.actionId === founderDecision.chosenActionId)!;
    expect(canonicalStringify(founderDecision.params)).toBe(canonicalStringify(chosen.params));
    expect(canonicalStringify(founderDecision)).not.toContain(forgedCompanyId);
    const founderCall = new SqliteLlmCallStore(base.db, TEST_RUN_ID).list()
      .find((call) => call.decisionId === founderDecision.id)!;
    expect(founderCall).toMatchObject({
      status: "fallback",
      fallbackReason: "validation_failed",
      effectiveTier: 1,
      attempts: 1,
    });
    expect(founderCall.inputTokens).toBeGreaterThan(0);
    expect(founderCall.outputTokens).toBeGreaterThan(0);
    const rejection = base.events.list().find((event) => (
      event.type === "agent.action.rejected" &&
      (event.payload as { proposalRejected?: boolean }).proposalRejected === true
    ));
    expect(rejection).toMatchObject({
      actor: { kind: "agent", id: base.founderAgentId },
      correlationId: founderDecision.id,
    });
    const callEvent = base.events.list().find((event) => (
      event.type === "llm.call.recorded" && event.correlationId === founderDecision.id
    ));
    expect(callEvent?.payload).toMatchObject({
      status: "fallback",
      fallbackReason: "validation_failed",
      effectiveTier: 1,
    });
    expect(base.db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM companies WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, forgedCompanyId)?.count).toBe(0n);
  });
});
