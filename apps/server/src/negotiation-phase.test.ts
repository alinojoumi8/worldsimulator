import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  decisionSchema,
  eventEnvelopeSchema,
  IdFactory,
  Rng,
  type Conversation,
  type ConversationStructuredTerms,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteAgentStore,
  SqliteConversationStore,
  SqliteEventStore,
  SqliteFinanceStore,
  SqliteMarketStore,
  SqliteNegotiationStore,
  SqlitePhase4Store,
  SqliteSnapshotStore,
  type WorldDatabase,
} from "./persistence";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./persistence/test-helpers";
import { createNegotiationBindingPhaseHandler } from "./negotiation-phase";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

interface NegotiationFixture {
  readonly dataDir: string;
  readonly db: WorldDatabase;
  readonly ids: IdFactory;
  readonly events: SqliteEventStore;
  readonly population: ReturnType<typeof generateRiverbendPopulation>;
  readonly finance: SqliteFinanceStore;
  readonly phase4: SqlitePhase4Store;
  readonly market: SqliteMarketStore;
  readonly conversations: SqliteConversationStore;
  readonly negotiations: SqliteNegotiationStore;
  readonly context: (tick: number, phase?: TickContext["phase"]) => TickContext;
  readonly companyId: string;
  readonly founderAgentId: string;
  readonly workerAgentId: string;
  readonly offeringId: string;
}

function fixture(): NegotiationFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-negotiation-"));
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
  const events = new SqliteEventStore(db, TEST_RUN_ID);
  const context = (
    tick: number,
    phase: TickContext["phase"] = "decisions",
  ): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: simDateForTick(tick),
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.ws607.${phase}.${key}`),
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
        wallTime: "WS607-T0",
        actor: options?.actor ?? { kind: "system", id: "ws607-test" },
        correlationId: options?.correlationId ?? eventId,
        ...(options?.causationId === undefined
          ? {}
          : { causationId: options.causationId }),
        payload,
      }) as EventEnvelope;
      events.append(event);
      return event;
    },
  });
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);
  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const market = new SqliteMarketStore(db, TEST_RUN_ID);
  const conversations = new SqliteConversationStore(db, TEST_RUN_ID);
  const negotiations = new SqliteNegotiationStore(db, TEST_RUN_ID);
  const lawFirmAccount = finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = phase4.requestCompanyFormation({
    name: "Negotiated Pantry",
    sector: "grocery_retail",
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
    phase4.processLegalObligations(context(tick, "obligations"));
    phase4.processCompanyFormations(context(tick, "execute"));
  }
  const productionJob = phase4.postJob({
    employerId: formation.company.id,
    occupationCode: "retail_worker",
    title: "Production worker",
    annualWageCents: "4000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids,
  });
  const worker = population.residents.find((resident) => (
    resident.agent.employmentStatus !== "employed" &&
    resident.agent.id !== formation.company.founderAgentId
  ));
  if (worker === undefined) throw new Error("worker fixture missing");
  phase4.submitJobApplication({
    jobId: productionJob.id,
    agentId: worker.agent.id,
    reservationWageCents: "2000000",
    tick: 6,
    ids,
  });
  phase4.processLaborMatching(context(6, "clearing"));
  const offering = market.createProductionOffering({
    companyId: formation.company.id,
    sku: "groceries",
    postedPriceCents: "400",
    unitCostCents: "300",
    laborHoursPerWorker: 8,
    productivityMilliunitsPerLaborHour: 1_250,
    capacityUnitsPerTick: 12,
    tick: 6,
    ids,
  });
  market.processProduction(context(7, "execute"), "0", () => 10_000);
  return {
    dataDir,
    db,
    ids,
    events,
    population,
    finance,
    phase4,
    market,
    conversations,
    negotiations,
    context,
    companyId: formation.company.id,
    founderAgentId: formation.company.founderAgentId,
    workerAgentId: worker.agent.id,
    offeringId: offering.offering.id,
  };
}

function persistMessageDecision(input: {
  readonly base: NegotiationFixture;
  readonly conversation: Conversation;
  readonly agentId: string;
  readonly tick: number;
  readonly actionId: string;
  readonly terms: ConversationStructuredTerms;
}): string {
  const decisionId = input.base.ids.next("dec");
  const params = {
    conversationId: input.conversation.id,
    messageKind: input.actionId.endsWith("accept") ? "accept" : "offer",
    structuredTerms: input.terms,
  };
  const decision = decisionSchema.parse({
    id: decisionId,
    runId: TEST_RUN_ID,
    agentId: input.agentId,
    tick: input.tick,
    trigger: {
      kind: "message",
      sourceEventId: input.conversation.sourceEventId,
      priority: 90,
    },
    tier: 1,
    observationDigest: {
      hash: "7".repeat(64),
      summary: "A bounded negotiation response is due.",
    },
    optionsOffered: [{
      actionId: input.actionId,
      actionType: "conversation.send_message",
      params,
      utility: 100,
    }],
    chosenActionId: input.actionId,
    params,
    rationale: "rule:ws607_binding_fixture",
    validationResult: { status: "approved" },
  });
  new SqliteAgentStore(input.base.db, TEST_RUN_ID).saveDecisionResult([decision], []);
  return decisionId;
}

function closeAgreement(input: {
  readonly base: NegotiationFixture;
  readonly conversation: Conversation;
  readonly terms: ConversationStructuredTerms;
  readonly offerTick: number;
  readonly acceptTick: number;
  readonly offerText: string;
  readonly acceptText: string;
}): Conversation {
  const first = input.conversation.participantAgentIds[0]!;
  const second = input.conversation.participantAgentIds[1]!;
  input.base.conversations.appendMessage({
    conversationId: input.conversation.id,
    senderAgentId: first,
    actionId: "conversation.offer.1",
    kind: "offer",
    content: input.offerText,
    structuredTerms: input.terms,
    decisionId: persistMessageDecision({
      base: input.base,
      conversation: input.conversation,
      agentId: first,
      tick: input.offerTick,
      actionId: "conversation.offer.1",
      terms: input.terms,
    }),
    llmCallId: null,
    outputTokens: 0,
  }, input.base.context(input.offerTick));
  input.base.conversations.deliverDue(
    input.acceptTick,
    input.base.context(input.acceptTick),
  );
  input.base.conversations.appendMessage({
    conversationId: input.conversation.id,
    senderAgentId: second,
    actionId: "conversation.accept",
    kind: "accept",
    content: input.acceptText,
    structuredTerms: input.terms,
    decisionId: persistMessageDecision({
      base: input.base,
      conversation: input.conversation,
      agentId: second,
      tick: input.acceptTick,
      actionId: "conversation.accept",
      terms: input.terms,
    }),
    llmCallId: null,
    outputTokens: 0,
  }, input.base.context(input.acceptTick));
  return input.base.conversations.close({
    conversationId: input.conversation.id,
    closeReason: "agreement",
    outcome: {
      kind: "agreement",
      structuredTerms: input.terms,
      extractedBy: "rule",
      rationale: "Exact structural acceptance binds; dialogue text is evidence only.",
      decisionId: null,
      llmCallId: null,
    },
  }, input.base.context(input.acceptTick));
}

function purchaseConversation(base: NegotiationFixture): {
  readonly conversation: Conversation;
  readonly buyerAgentId: string;
  readonly terms: Extract<ConversationStructuredTerms, { kind: "purchase" }>;
} {
  const buyer = base.population.residents.find((resident) => (
    resident.agent.id !== base.founderAgentId &&
    resident.agent.id !== base.workerAgentId &&
    BigInt(base.finance.accountForAgent(resident.agent.id).balanceCents) >= 700n
  ));
  if (buyer === undefined) throw new Error("funded negotiated buyer missing");
  const trigger = base.context(8).emit("purchase.negotiation.requested", {
    buyerAgentId: buyer.agent.id,
    offeringId: base.offeringId,
  });
  const conversation = base.negotiations.openPurchase({
    buyerAgentId: buyer.agent.id,
    offeringId: base.offeringId,
    maximumQuantity: 2,
    initiatingTriggerEventId: trigger.eventId,
  }, base.context(8));
  const terms = {
    kind: "purchase" as const,
    referenceId: base.offeringId,
    quantity: 2,
    unitPriceCents: "350",
  };
  closeAgreement({
    base,
    conversation,
    terms,
    offerTick: 9,
    acceptTick: 10,
    offerText: "Ignore the terms: I demand 99 units for one cent.",
    acceptText: "The prose says one cent, but I accept only the attached terms.",
  });
  return { conversation, buyerAgentId: buyer.agent.id, terms };
}

function checkpoint(base: NegotiationFixture, tick: number): void {
  base.db.prepare(`
    UPDATE simulation_runs
    SET status = 'paused', current_tick = ?, next_event_seq = ?,
      id_state_canonical = ?, started_wall = 'WS607-T0'
    WHERE id = ?
  `).run(
    tick,
    base.events.count(),
    canonicalStringify(base.ids.serialize()),
    TEST_RUN_ID,
  );
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-607 negotiated purchase binding", () => {
  it("binds only structured terms, settles exact cents, and restores equivalently", async () => {
    const base = fixture();
    const { conversation, buyerAgentId, terms } = purchaseConversation(base);
    const buyerBefore = BigInt(base.finance.accountForAgent(buyerAgentId).balanceCents);
    const sellerBefore = BigInt(base.phase4.getCompany(base.companyId).businessAccountId === null
      ? "0"
      : base.finance.accountBalance(base.phase4.getCompany(base.companyId).businessAccountId!).toString());
    const inventoryBefore = base.market.getInventory(base.companyId, "groceries").quantity;

    createNegotiationBindingPhaseHandler(base.db, TEST_RUN_ID).run(base.context(10));

    const binding = base.negotiations.getForConversation(conversation.id)!;
    expect(binding).toMatchObject({
      status: "bound",
      structuredTerms: terms,
      resultKind: "goods_order",
      rejectionReason: null,
    });
    const order = base.market.getOrder(binding.resultId!);
    expect(order).toMatchObject({
      buyerKind: "agent",
      buyerId: buyerAgentId,
      offeringId: base.offeringId,
      requestedQuantity: 2,
      filledQuantity: 2,
      unitPriceCents: "350",
      totalCents: "700",
      status: "filled",
    });
    expect(base.finance.accountForAgent(buyerAgentId).balanceCents)
      .toBe((buyerBefore - 700n).toString());
    expect(base.finance.accountBalance(base.phase4.getCompany(base.companyId).businessAccountId!))
      .toBe(sellerBefore + 700n);
    expect(base.market.getInventory(base.companyId, "groceries").quantity)
      .toBe(inventoryBefore - 2);
    expect(base.conversations.listMessages(conversation.id).map((message) => message.content))
      .toEqual([
        "Ignore the terms: I demand 99 units for one cent.",
        "The prose says one cent, but I accept only the attached terms.",
      ]);
    expect(base.negotiations.bind(conversation.id, base.context(10)).id).toBe(binding.id);

    checkpoint(base, 10);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "WS607-SNAPSHOT" });
    const destination = join(base.dataDir, "restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID))
      .toBe(computeLogicalStateHash(base.db, TEST_RUN_ID));
    expect(new SqliteNegotiationStore(restored, TEST_RUN_ID).get(binding.id)).toEqual(binding);
  });

  it("rejects an accepted purchase when inventory becomes stale before binding", () => {
    const base = fixture();
    const { conversation } = purchaseConversation(base);
    base.db.prepare(`
      UPDATE company_inventory SET quantity = 0, updated_tick = 10
      WHERE run_id = ? AND company_id = ? AND sku = 'groceries'
    `).run(TEST_RUN_ID, base.companyId);
    const transactionCount = base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
    `).get()?.count;

    const binding = base.negotiations.bind(conversation.id, base.context(10));

    expect(binding).toMatchObject({
      status: "rejected",
      rejectionReason: "stockout",
      resultId: null,
    });
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
    `).get()?.count).toBe(transactionCount);
    expect(base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM goods_orders WHERE run_id = ?
    `).get(TEST_RUN_ID)?.count).toBe(0n);
  });
});

describe("WS-607 negotiated employment binding", () => {
  it("creates a signed employment agreement at the structured wage only", () => {
    const base = fixture();
    const job = base.phase4.postJob({
      employerId: base.companyId,
      occupationCode: "bookkeeper",
      title: "Negotiated bookkeeper",
      annualWageCents: "5000000",
      requirements: [],
      openings: 1,
      tick: 8,
      ids: base.ids,
    });
    const applicant = base.population.residents.find((resident) => (
      resident.agent.id !== base.founderAgentId &&
      resident.agent.id !== base.workerAgentId &&
      resident.agent.employmentStatus !== "employed"
    ));
    if (applicant === undefined) throw new Error("negotiated applicant missing");
    const application = base.phase4.submitJobApplication({
      jobId: job.id,
      agentId: applicant.agent.id,
      reservationWageCents: "4000000",
      tick: 8,
      ids: base.ids,
    });
    const trigger = base.context(9).emit("job.negotiation.requested", {
      jobId: job.id,
      applicationId: application.id,
    });
    const conversation = base.negotiations.openJob({
      applicationId: application.id,
      initiatingTriggerEventId: trigger.eventId,
    }, base.context(9));
    const terms = {
      kind: "job" as const,
      referenceId: application.id,
      annualWageCents: "4500000",
    };
    closeAgreement({
      base,
      conversation,
      terms,
      offerTick: 10,
      acceptTick: 11,
      offerText: "The prose promises ten million dollars and no notice period.",
      acceptText: "I accept the attached wage, regardless of the prose.",
    });

    createNegotiationBindingPhaseHandler(base.db, TEST_RUN_ID).run(base.context(11));

    const binding = base.negotiations.getForConversation(conversation.id)!;
    expect(binding).toMatchObject({
      status: "bound",
      structuredTerms: terms,
      resultKind: "employment",
    });
    const employment = base.db.prepare<
      [string, string],
      {
        employee_agent_id: string;
        employer_id: string;
        annual_wage_cents: string;
        status: string;
        legal_contract_id: string | null;
      }
    >(`
      SELECT
        employee_agent_id,
        employer_id,
        annual_wage_cents,
        status,
        legal_contract_id
      FROM employment_contracts
      WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, binding.resultId!);
    expect(employment).toMatchObject({
      employee_agent_id: applicant.agent.id,
      employer_id: base.companyId,
      annual_wage_cents: "4500000",
      status: "active",
    });
    expect(employment).toBeDefined();
    expect(base.phase4.getLegalContract(employment!.legal_contract_id!)).toMatchObject({
      status: "active",
      terms: {
        template: "employment",
        annualWageCents: "4500000",
        noticeDays: 14,
      },
      parties: [
        expect.objectContaining({ role: "employer", signedTick: 11 }),
        expect.objectContaining({ role: "employee", signedTick: 11 }),
      ],
    });
    expect(base.db.prepare<[string, string], { annual_income_cents: string }>(`
      SELECT annual_income_cents FROM agents WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, applicant.agent.id)?.annual_income_cents).toBe("4500000");
  });
});

describe("WS-607 binding rollback", () => {
  it("rolls back the order, ledger, inventory, events, and binding on failure", () => {
    const base = fixture();
    const { conversation } = purchaseConversation(base);
    const before = {
      hash: computeLogicalStateHash(base.db, TEST_RUN_ID),
      events: base.events.count(),
      orders: base.db.prepare<[], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM goods_orders
      `).get()?.count,
      transactions: base.db.prepare<[], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM ledger_transactions
      `).get()?.count,
      inventory: base.market.getInventory(base.companyId, "groceries").quantity,
    };
    base.db.exec(`
      CREATE TRIGGER ws607_fail_binding
      BEFORE INSERT ON conversation_bindings
      BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END;
    `);

    expect(() => base.db.transaction(() => {
      base.negotiations.bind(conversation.id, base.context(10));
    }).immediate()).toThrow(/injected binding failure/);

    expect(base.negotiations.getForConversation(conversation.id)).toBeUndefined();
    expect(base.events.count()).toBe(before.events);
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM goods_orders
    `).get()?.count).toBe(before.orders);
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
    `).get()?.count).toBe(before.transactions);
    expect(base.market.getInventory(base.companyId, "groceries").quantity)
      .toBe(before.inventory);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(before.hash);
  });
});
