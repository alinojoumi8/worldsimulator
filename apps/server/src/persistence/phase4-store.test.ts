import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalParse,
  decisionSchema,
  IdFactory,
  ledgerTransactionSchema,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import { checkInvariants, generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { readRunInvariantSnapshot } from "../testing/run-invariant-probe";
import { SqliteAgentStore } from "./agent-store";
import { openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqlitePhase4Store } from "./phase4-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-phase4-"));
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
  const store = new SqlitePhase4Store(db, TEST_RUN_ID);
  const eventTypes: string[] = [];
  const emitted: {
    readonly type: string;
    readonly payload: unknown;
    readonly options: Parameters<TickContext["emit"]>[2];
    readonly eventId: string;
  }[] = [];
  const context = (tick: number, phase: TickContext["phase"]): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      eventTypes.push(type);
      const event = { eventId: ids.next("evt") } as EventEnvelope;
      emitted.push({ type, payload, options, eventId: event.eventId });
      return event;
    },
  });
  return { db, population, ids, finance, store, eventTypes, emitted, context };
}

type Phase4Fixture = ReturnType<typeof fixture>;

function setupTier2LaborScenario(base: Phase4Fixture) {
  const lawFirmAccount = base.finance.listAccounts()
    .find((account) => account.ownerKind === "company")!;
  const formation = base.store.requestCompanyFormation({
    name: "Bounded Labor Works",
    sector: "professional_services",
    founderAgentId: "agt_00000001",
    jurisdiction: "Riverbend",
    foundingCapitalCents: "200000",
    totalShares: "1000",
    lawFirmAccountId: lawFirmAccount.id,
    incorporationFeeCents: "10000",
    tick: 0,
    ids: base.ids,
  });
  for (const party of formation.contract.parties) {
    base.store.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, base.ids);
  }
  for (let tick = 1; tick <= 5; tick++) {
    base.store.processLegalObligations(base.context(tick, "obligations"));
    base.store.processCompanyFormations(base.context(tick, "execute"));
  }
  const job = base.store.postJob({
    employerId: formation.company.id,
    occupationCode: "bookkeeper",
    title: "Bounded Bookkeeper",
    annualWageCents: "5000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids: base.ids,
  });
  const applicantAgentId = base.population.residents
    .filter((resident) => resident.agent.employmentStatus !== "employed")
    .map((resident) => resident.agent.id)
    .sort()[0]!;
  const application = base.store.submitJobApplication({
    jobId: job.id,
    agentId: applicantAgentId,
    reservationWageCents: "4000000",
    tick: 6,
    ids: base.ids,
  });
  expect(base.store.listLaborDecisionCandidates(7)).toEqual([
    expect.objectContaining({
      founderAgentId: formation.company.founderAgentId,
      application: expect.objectContaining({ id: application.id }),
    }),
  ]);
  return {
    application,
    applicantAgentId,
    founderAgentId: formation.company.founderAgentId,
    job,
  };
}

function persistLaborDecision(input: {
  readonly base: Phase4Fixture;
  readonly agentId: string;
  readonly tick: number;
  readonly actionId: string;
  readonly actionType: "company.respond_hiring" | "agent.respond_job_offer";
  readonly params: Readonly<Record<string, unknown>>;
}): string {
  const decisionId = input.base.ids.next("dec");
  const decision = decisionSchema.parse({
    id: decisionId,
    runId: TEST_RUN_ID,
    agentId: input.agentId,
    tick: input.tick,
    trigger: { kind: "schedule", sourceEventId: "evt_00000001", priority: 80 },
    tier: 2,
    observationDigest: {
      hash: "6".repeat(64),
      summary: "A bounded two-sided employment choice is due.",
    },
    optionsOffered: [{
      actionId: input.actionId,
      actionType: input.actionType,
      params: input.params,
      utility: 100,
    }],
    chosenActionId: input.actionId,
    params: input.params,
    rationale: "bounded employment choice",
    llmCallId: input.base.ids.next("llm"),
    validationResult: { status: "approved" },
    promptPackKey: "agent.decision",
    promptVersion: 1,
    promptHash: "7".repeat(64),
  });
  new SqliteAgentStore(input.base.db, TEST_RUN_ID).saveDecisionResult([decision], []);
  return decisionId;
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Phase 4 company and labor workflows", () => {
  it("turns an achieved founder goal into one causally linked signed formation", () => {
    const { db, ids, finance, store, emitted, context } = fixture();
    const goal = db.prepare<[string], {
      id: string;
      agent_id: string;
      params_canonical: string;
      trigger_event_id: string;
    }>(`
      SELECT id, agent_id, params_canonical, trigger_event_id
      FROM goals WHERE run_id = ? AND kind = 'start_business'
      ORDER BY id LIMIT 1
    `).get(TEST_RUN_ID)!;
    const params = canonicalParse(goal.params_canonical);
    expect(params).toEqual(expect.objectContaining({ targetSavingsCents: expect.any(String) }));
    const targetSavingsCents = (params as Record<string, unknown>)["targetSavingsCents"];
    if (typeof targetSavingsCents !== "string") throw new TypeError("founder target is missing");
    const founderAccount = finance.accountForAgent(goal.agent_id);
    const required = BigInt(targetSavingsCents) + 10000n;
    const missing = required - finance.accountBalance(founderAccount.id);
    if (missing > 0n) {
      const treasury = finance.listAccounts()
        .filter((account) => account.ownerKind === "government")
        .sort((left, right) => {
          const leftBalance = BigInt(left.balanceCents);
          const rightBalance = BigInt(right.balanceCents);
          return leftBalance === rightBalance ? 0 : leftBalance > rightBalance ? -1 : 1;
        })[0]!;
      finance.post(ledgerTransactionSchema.parse({
        id: ids.next("txn"),
        runId: TEST_RUN_ID,
        tick: 10,
        kind: "transfer",
        actor: { kind: "system" },
        reason: "founder goal test funding",
        sourceEventId: null,
        correlationId: goal.id,
        idempotencyKey: `test-founder-funding:${goal.id}`,
        legs: [
          { accountId: founderAccount.id, direction: "debit", amountCents: missing.toString() },
          { accountId: treasury.id, direction: "credit", amountCents: missing.toString() },
        ],
      }));
    }
    db.prepare(`
      UPDATE goals SET status = 'achieved', progress_millionths = 1000000,
        activated_tick = 1, terminal_tick = 10
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, goal.id);

    const formed = store.processAchievedFounderGoals(context(10, "execute"));
    expect(formed).toHaveLength(1);
    expect(store.processAchievedFounderGoals(context(10, "execute"))).toEqual([]);
    expect(db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM companies
      WHERE run_id = ? AND founder_agent_id = ?
    `).get(TEST_RUN_ID, goal.agent_id)?.count).toBe(1n);
    const formationEvent = emitted.find((event) => event.type === "company.formation.requested")!;
    expect(formationEvent.payload).toMatchObject({
      companyId: formed[0],
      founderAgentId: goal.agent_id,
      goalId: goal.id,
    });
    expect(formationEvent.options).toMatchObject({
      actor: { kind: "agent", id: goal.agent_id },
      correlationId: goal.id,
      causationId: goal.trigger_event_id,
    });
    const contract = db.prepare<[string], { id: string }>(`
      SELECT id FROM legal_contracts
      WHERE run_id = ? AND status = 'signed' ORDER BY id DESC LIMIT 1
    `).get(TEST_RUN_ID)!;
    expect(store.getLegalContract(contract.id).parties.every((party) => party.signedTick === 10))
      .toBe(true);
    expect(emitted.some((event) => event.type === "contract.signed")).toBe(true);
  });

  it("defers an achieved founder goal without funds and does not duplicate the notice", () => {
    const { db, ids, finance, store, emitted, context } = fixture();
    const goal = db.prepare<[string], { id: string; agent_id: string }>(`
      SELECT id, agent_id FROM goals
      WHERE run_id = ? AND kind = 'start_business' ORDER BY id LIMIT 1
    `).get(TEST_RUN_ID)!;
    const founderAccount = finance.accountForAgent(goal.agent_id);
    const founderBalance = finance.accountBalance(founderAccount.id);
    if (founderBalance > 0n) {
      const treasury = finance.listAccounts().find((account) => account.ownerKind === "government")!;
      finance.post(ledgerTransactionSchema.parse({
        id: ids.next("txn"),
        runId: TEST_RUN_ID,
        tick: 10,
        kind: "transfer",
        actor: { kind: "agent", id: goal.agent_id },
        reason: "founder goal insufficient-funds test",
        sourceEventId: null,
        correlationId: goal.id,
        idempotencyKey: `test-founder-drain:${goal.id}`,
        legs: [
          { accountId: treasury.id, direction: "debit", amountCents: founderBalance.toString() },
          { accountId: founderAccount.id, direction: "credit", amountCents: founderBalance.toString() },
        ],
      }));
    }
    db.prepare(`
      UPDATE goals SET status = 'achieved', progress_millionths = 1000000,
        activated_tick = 1, terminal_tick = 10
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, goal.id);

    expect(store.processAchievedFounderGoals(context(10, "execute"))).toEqual([]);
    expect(store.processAchievedFounderGoals(context(11, "execute"))).toEqual([]);
    expect(emitted.filter((event) => event.type === "company.formation.deferred")).toHaveLength(1);
    expect(db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM companies
      WHERE run_id = ? AND founder_agent_id = ?
    `).get(TEST_RUN_ID, goal.agent_id)?.count).toBe(0n);
  });

  it("runs forming -> registered -> active with fee, account, capital, and founder equity", () => {
    const { db, ids, finance, store, eventTypes, context } = fixture();
    const founderAgentId = "agt_00000001";
    const lawFirmAccount = finance.listAccounts().find((account) => account.ownerKind === "company")!;
    const requested = store.requestCompanyFormation({
      name: "Thread Works",
      sector: "professional_services",
      founderAgentId,
      jurisdiction: "Riverbend",
      foundingCapitalCents: "100000",
      totalShares: "1000",
      lawFirmAccountId: lawFirmAccount.id,
      incorporationFeeCents: "10000",
      tick: 0,
      ids,
    });

    expect(() => store.assertCompanyCanOperate(requested.company.id, "hire")).toThrow(/before activation/);
    expect(() => store.assertCompanyCanOperate(requested.company.id, "trade")).toThrow(/before activation/);
    const filingCounsel = requested.contract.parties.find((party) => party.role === "filing_counsel")!;
    store.signContract(requested.contract.id, { kind: "agent", id: founderAgentId }, 0, ids);
    store.signContract(requested.contract.id, { kind: filingCounsel.kind, id: filingCounsel.id }, 0, ids);

    for (let tick = 1; tick <= 5; tick++) {
      store.processLegalObligations(context(tick, "obligations"));
      store.processCompanyFormations(context(tick, "execute"));
    }

    const active = store.getCompany(requested.company.id);
    expect(active).toMatchObject({
      status: "active",
      formationStage: "active",
      foundingCapitalCents: "100000",
      totalShares: "1000",
      registeredTick: 2,
      activatedTick: 5,
    });
    expect(active.businessAccountId).not.toBeNull();
    expect(finance.accountBalance(active.businessAccountId!)).toBe(100000n);
    expect(db.prepare<[string, string], { shares: string }>(`
      SELECT shares FROM company_equity_stakes WHERE run_id = ? AND company_id = ?
    `).get(TEST_RUN_ID, active.id)?.shares).toBe("1000");
    const ownership = readRunInvariantSnapshot(db, TEST_RUN_ID).ownership;
    expect(checkInvariants({ ownership }).checks.find((check) => check.invariant === "INV-4"))
      .toMatchObject({ status: "passed", violations: [] });
    expect(eventTypes).toEqual(expect.arrayContaining([
      "contract.activated",
      "contract.obligation.fired",
      "company.incorporation_fee.requested",
      "company.incorporation_fee.paid",
      "company.registered",
      "account.opened",
      "company.capital.deposit.requested",
      "company.capital.deposited",
      "company.equity.issued",
      "company.activated",
    ]));
  });

  it("matches deterministically into a signed employment contract and honors quit notice", () => {
    const { db, population, ids, finance, store, eventTypes, context } = fixture();
    const lawFirmAccount = finance.listAccounts().find((account) => account.ownerKind === "company")!;
    const formation = store.requestCompanyFormation({
      name: "Riverbend Books",
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
      store.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, ids);
    }
    for (let tick = 1; tick <= 5; tick++) {
      store.processLegalObligations(context(tick, "obligations"));
      store.processCompanyFormations(context(tick, "execute"));
    }
    const job = store.postJob({
      employerId: formation.company.id,
      occupationCode: "bookkeeper",
      title: "Bookkeeper",
      annualWageCents: "5000000",
      requirements: [],
      openings: 1,
      tick: 6,
      ids,
    });
    const candidates = population.residents
      .filter((resident) => resident.agent.employmentStatus !== "employed")
      .map((resident) => resident.agent.id)
      .sort()
      .slice(0, 2);
    expect(candidates).toHaveLength(2);
    for (const agentId of [...candidates].reverse()) {
      store.submitJobApplication({
        jobId: job.id,
        agentId,
        reservationWageCents: "4000000",
        tick: 6,
        ids,
      });
    }
    store.processLaborMatching(context(7, "clearing"));

    const selected = store.listJobApplications(job.id).find((application) => application.status === "selected")!;
    expect(selected.agentId).toBe(candidates[0]);
    const employment = db.prepare<[string, string], {
      id: string;
      legal_contract_id: string;
      notice_days: bigint;
    }>(`
      SELECT id, legal_contract_id, notice_days FROM employment_contracts
      WHERE run_id = ? AND employee_agent_id = ? AND status = 'active'
    `).get(TEST_RUN_ID, selected.agentId)!;
    const legal = store.getLegalContract(employment.legal_contract_id);
    expect(legal.status).toBe("active");
    expect(legal.parties.every((party) => party.signedTick !== null)).toBe(true);
    expect(eventTypes).toContain("employment.created");
    const invariantSnapshot = readRunInvariantSnapshot(db, TEST_RUN_ID);
    expect(checkInvariants({
      employments: invariantSnapshot.employments,
      employmentContracts: invariantSnapshot.employmentContracts,
    }).checks.find((check) => check.invariant === "INV-5"))
      .toMatchObject({ status: "passed", violations: [] });

    const termination = store.requestEmploymentTermination({
      employmentContractId: employment.id,
      initiatedBy: { kind: "agent", id: selected.agentId },
      reason: "quit",
      tick: 8,
      ids,
    });
    expect(termination.effectiveTick).toBe(22);
    store.processLegalObligations(context(21, "obligations"));
    expect(db.prepare<[string, string], { status: string }>(`
      SELECT status FROM employment_contracts WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, employment.id)?.status).toBe("active");
    store.processLegalObligations(context(22, "obligations"));
    expect(db.prepare<[string, string], { status: string; end_tick: bigint }>(`
      SELECT status, end_tick FROM employment_contracts WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, employment.id)).toEqual({ status: "ended", end_tick: 22n });
    expect(store.getLegalContract(employment.legal_contract_id).status).toBe("terminated");
    expect(eventTypes).toContain("employment.terminated");
  });

  it.each([
    {
      label: "hires only when the founder offers and the applicant accepts",
      founderResponse: "offer" as const,
      applicantResponse: "accept" as const,
      outcome: "hired" as const,
      applicationStatus: "selected",
    },
    {
      label: "honors an applicant decline after a founder offer",
      founderResponse: "offer" as const,
      applicantResponse: "decline" as const,
      outcome: "declined" as const,
      applicationStatus: "declined",
    },
    {
      label: "keeps the application pending when the founder defers an accepted offer",
      founderResponse: "defer" as const,
      applicantResponse: "accept" as const,
      outcome: "deferred" as const,
      applicationStatus: "submitted",
    },
    {
      label: "honors an applicant decline even when the founder defers",
      founderResponse: "defer" as const,
      applicantResponse: "decline" as const,
      outcome: "declined" as const,
      applicationStatus: "declined",
    },
  ])("uses two persisted bounded choices and $label", ({
    founderResponse,
    applicantResponse,
    outcome,
    applicationStatus,
  }) => {
    const base = fixture();
    const scenario = setupTier2LaborScenario(base);
    const founderDecisionId = persistLaborDecision({
      base,
      agentId: scenario.founderAgentId,
      tick: 7,
      actionId: `job.${founderResponse}`,
      actionType: "company.respond_hiring",
      params: {
        applicationId: scenario.application.id,
        founderAgentId: scenario.founderAgentId,
        response: founderResponse,
      },
    });
    const applicantDecisionId = persistLaborDecision({
      base,
      agentId: scenario.applicantAgentId,
      tick: 7,
      actionId: `job.${applicantResponse}`,
      actionType: "agent.respond_job_offer",
      params: {
        applicationId: scenario.application.id,
        agentId: scenario.applicantAgentId,
        response: applicantResponse,
      },
    });
    const sourceEventId = "evt_00000001";
    const result = base.store.applyTier2LaborDecision({
      applicationId: scenario.application.id,
      founderAgentId: scenario.founderAgentId,
      applicantAgentId: scenario.applicantAgentId,
      founderDecisionId,
      applicantDecisionId,
      founderResponse,
      applicantResponse,
      sourceEventId,
    }, base.context(7, "clearing"));

    expect(result.outcome).toBe(outcome);
    expect(base.store.listJobApplications(scenario.job.id)[0]?.status).toBe(applicationStatus);
    const activeEmployment = base.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM employment_contracts
      WHERE run_id = ? AND employee_agent_id = ? AND status = 'active'
    `).get(TEST_RUN_ID, scenario.applicantAgentId);
    expect(activeEmployment !== undefined).toBe(outcome === "hired");

    if (outcome === "hired") {
      const event = base.emitted.find((candidate) => candidate.type === "employment.created")!;
      expect(event.payload).toMatchObject({
        jobId: scenario.job.id,
        employeeAgentId: scenario.applicantAgentId,
        founderDecisionId,
        applicantDecisionId,
      });
      expect(event.options).toMatchObject({
        correlationId: founderDecisionId,
        causationId: sourceEventId,
      });
      expect(result.eventIds).toContain(event.eventId);
    } else if (outcome === "declined") {
      const event = base.emitted.find((candidate) => candidate.type === "job.application.declined")!;
      expect(event.payload).toMatchObject({
        applicationId: scenario.application.id,
        founderDecisionId,
        applicantDecisionId,
      });
      expect(event.options).toMatchObject({
        actor: { kind: "agent", id: scenario.applicantAgentId },
        correlationId: applicantDecisionId,
        causationId: sourceEventId,
      });
      expect(result.eventIds).toEqual([event.eventId]);
    } else {
      expect(result.eventIds).toEqual([]);
    }
  });

  it("rejects missing or cross-agent labor evidence before changing the application", () => {
    const base = fixture();
    const scenario = setupTier2LaborScenario(base);
    const founderDecisionId = persistLaborDecision({
      base,
      agentId: scenario.founderAgentId,
      tick: 7,
      actionId: "job.offer",
      actionType: "company.respond_hiring",
      params: {
        applicationId: scenario.application.id,
        founderAgentId: scenario.founderAgentId,
        response: "offer",
      },
    });
    const common = {
      applicationId: scenario.application.id,
      founderAgentId: scenario.founderAgentId,
      applicantAgentId: scenario.applicantAgentId,
      founderDecisionId,
      founderResponse: "offer" as const,
      applicantResponse: "accept" as const,
      sourceEventId: "evt_00000001",
    };

    expect(() => base.store.applyTier2LaborDecision({
      ...common,
      applicantDecisionId: "dec_zzzzzzzz",
    }, base.context(7, "clearing"))).toThrow(/both persisted decisions/);
    const wrongAgentId = base.population.residents
      .map((resident) => resident.agent.id)
      .find((id) => id !== scenario.founderAgentId && id !== scenario.applicantAgentId)!;
    const wrongApplicantDecisionId = persistLaborDecision({
      base,
      agentId: wrongAgentId,
      tick: 7,
      actionId: "job.accept",
      actionType: "agent.respond_job_offer",
      params: {
        applicationId: scenario.application.id,
        agentId: scenario.applicantAgentId,
        response: "accept",
      },
    });
    expect(() => base.store.applyTier2LaborDecision({
      ...common,
      applicantDecisionId: wrongApplicantDecisionId,
    }, base.context(7, "clearing"))).toThrow(/identity or tick is invalid/);
    expect(base.store.listJobApplications(scenario.job.id)[0]?.status).toBe("submitted");
  });

  it("enforces employer authority and the notice period for layoffs", () => {
    const { db, ids, store, eventTypes, context } = fixture();
    const employment = db.prepare<[string], {
      id: string;
      employer_id: string;
      employee_agent_id: string;
      notice_days: bigint;
    }>(`
      SELECT id, employer_id, employee_agent_id, notice_days
      FROM employment_contracts WHERE run_id = ? AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(TEST_RUN_ID)!;
    expect(() => store.requestEmploymentTermination({
      employmentContractId: employment.id,
      initiatedBy: { kind: "company", id: "wrong-employer" },
      reason: "layoff",
      tick: 3,
      ids,
    })).toThrow(/only the employer/);
    const termination = store.requestEmploymentTermination({
      employmentContractId: employment.id,
      initiatedBy: { kind: "company", id: employment.employer_id },
      reason: "layoff",
      tick: 3,
      ids,
    });
    expect(termination.effectiveTick).toBe(3 + Number(employment.notice_days));
    store.processLegalObligations(context(termination.effectiveTick - 1, "obligations"));
    expect(db.prepare<[string, string], { status: string }>(`
      SELECT status FROM employment_contracts WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, employment.id)?.status).toBe("active");
    store.processLegalObligations(context(termination.effectiveTick, "obligations"));
    expect(db.prepare<[string, string], { status: string }>(`
      SELECT status FROM employment_contracts WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, employment.id)?.status).toBe("ended");
    expect(eventTypes).toContain("employment.terminated");
  });
});
