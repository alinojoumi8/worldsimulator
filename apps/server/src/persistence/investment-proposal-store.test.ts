import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  IdFactory,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  conversationTermCandidates,
  deterministicConversationOutcome,
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import {
  INVESTMENT_PITCH_DELAY_TICKS,
  SqliteInvestmentProposalStore,
} from "./investment-proposal-store";
import { SqliteConversationStore } from "./conversation-store";
import { SqlitePhase4Store } from "./phase4-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";
import { FOUNDRY_CAPITAL_ID, SqliteVentureStore } from "./venture-store";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function tracked(db: WorldDatabase): WorldDatabase {
  databases.push(db);
  return db;
}

function context(
  db: WorldDatabase,
  ids: IdFactory,
  tick: number,
  phase: TickContext["phase"] = "decisions",
): TickContext {
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: simDateForTick(tick),
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const events = new SqliteEventStore(db, TEST_RUN_ID);
      const event: EventEnvelope = {
        eventId: ids.next("evt"),
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq: events.count(),
        tick,
        simDate: simDateForTick(tick),
        wallTime: `T${tick}`,
        actor: options?.actor ?? { kind: "system", id: "investment-test" },
        correlationId: options?.correlationId ?? `investment-test:${tick}`,
        ...(options?.causationId === undefined
          ? {}
          : { causationId: options.causationId }),
        payload,
      };
      events.append(event);
      return event;
    },
  };
}

function saveCheckpoint(db: WorldDatabase, ids: IdFactory, tick: number): void {
  const eventCount = new SqliteEventStore(db, TEST_RUN_ID).count();
  db.prepare(`
    UPDATE simulation_runs
    SET current_tick = ?, next_event_seq = ?, id_state_canonical = ?
    WHERE id = ?
  `).run(tick, eventCount, canonicalStringify(ids.serialize()), TEST_RUN_ID);
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-investment-proposal-"));
  directories.push(dataDir);
  const db = tracked(openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID));
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggerEvents);
  const ids = IdFactory.restore(population.idState);
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);

  const firmEventId = ids.next("evt");
  const fundEventId = ids.next("evt");
  const venture = new SqliteVentureStore(db, TEST_RUN_ID);
  const initialized = venture.initializeFoundry({
    ids,
    firmSourceEventId: firmEventId,
    fundSourceEventId: fundEventId,
  });
  const initialEvents = new SqliteEventStore(db, TEST_RUN_ID);
  initialEvents.appendBatch([
    {
      eventId: firmEventId,
      type: "venture.firm.created",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 0,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "system", id: "venture-capital" },
      correlationId: "venture-seed",
      payload: { firmId: initialized.firm.id },
    },
    {
      eventId: fundEventId,
      type: "venture.fund.created",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 1,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "institution", id: initialized.firm.id },
      correlationId: "venture-seed",
      causationId: firmEventId,
      payload: { fundId: initialized.fund.id },
    },
  ]);

  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const lawFirmAccount = finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = phase4.requestCompanyFormation({
    name: "Bounded Ventures",
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
    phase4.signContract(
      formation.contract.id,
      { kind: party.kind, id: party.id },
      0,
      ids,
    );
  }
  for (let tick = 1; tick <= 5; tick++) {
    phase4.processLegalObligations(context(db, ids, tick, "obligations"));
    phase4.processCompanyFormations(context(db, ids, tick, "execute"));
  }
  const company = phase4.getCompany(formation.company.id);
  if (company.activatedTick === null) throw new Error("company did not activate");
  const partner = population.residents.find((resident) => (
    resident.organizationId === FOUNDRY_CAPITAL_ID &&
    resident.roleCode === "vc.partner"
  ));
  if (partner === undefined) throw new Error("VC partner missing");
  return {
    dataDir,
    db,
    ids,
    company,
    partnerAgentId: partner.agent.id,
    fundId: initialized.fund.id,
    store: new SqliteInvestmentProposalStore(db, TEST_RUN_ID),
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("SqliteInvestmentProposalStore", () => {
  it("opens a bounded founder pitch and records an exact negotiated agreement", () => {
    const base = fixture();
    const pitchTick = base.company.activatedTick! + INVESTMENT_PITCH_DELAY_TICKS;
    const opened = base.store.processTick(context(base.db, base.ids, pitchTick));
    expect(opened.proposed).toMatchObject({
      companyId: base.company.id,
      founderAgentId: base.company.founderAgentId,
      fundId: base.fundId,
      vcPartnerAgentId: base.partnerAgentId,
      askAmountCents: "200000",
      preMoneyValuationCents: "800000",
      initialEquityBasisPoints: 2_000,
      status: "negotiating",
      proposedTick: pitchTick,
    });
    const proposal = opened.proposed!;
    const conversations = new SqliteConversationStore(base.db, TEST_RUN_ID);
    const negotiation = conversations.get(proposal.negotiationConversationId!);
    expect(negotiation).toMatchObject({
      topic: "investment",
      participantAgentIds: [base.company.founderAgentId, base.partnerAgentId],
      termBounds: {
        kind: "investment",
        referenceId: proposal.id,
        minAmountCents: "160000",
        maxAmountCents: "200000",
        minPreMoneyValuationCents: "640000",
        maxPreMoneyValuationCents: "800000",
      },
      maxTurns: 6,
      outputTokenBudget: 4_096,
    });

    const terms = conversationTermCandidates(negotiation.termBounds).at(-1)!;
    conversations.close({
      conversationId: negotiation.id,
      closeReason: "agreement",
      outcome: deterministicConversationOutcome(
        "agreement",
        terms,
        "Both parties selected an exact engine-generated term option.",
      ),
    }, context(base.db, base.ids, pitchTick + 1));
    const settled = base.store.processTick(
      context(base.db, base.ids, pitchTick + 1),
    );
    expect(settled.transitioned).toHaveLength(1);
    expect(settled.transitioned[0]).toMatchObject({
      id: proposal.id,
      status: "agreed",
      finalTerms: terms,
    });
    expect(base.store.list()).toHaveLength(1);
    const eventTypes = new SqliteEventStore(base.db, TEST_RUN_ID)
      .list()
      .map((event) => event.type);
    expect(eventTypes).toContain("investment.proposed");
    expect(eventTypes).toContain("conversation.started");
    expect(eventTypes).toContain("conversation.ended");
    expect(eventTypes).toContain("investment.proposal.agreed");
  });

  it("rolls back the proposal chain atomically and expires stalled negotiations", () => {
    const base = fixture();
    const pitchTick = base.company.activatedTick! + INVESTMENT_PITCH_DELAY_TICKS;
    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const eventsBefore = new SqliteEventStore(base.db, TEST_RUN_ID).count();
    expect(() => base.db.transaction(() => {
      base.store.processTick(context(base.db, base.ids, pitchTick));
      throw new Error("rollback investment proposal");
    }).immediate()).toThrow(/rollback investment proposal/);
    expect(base.store.list()).toEqual([]);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventsBefore);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(hashBefore);

    const proposal = base.store.processTick(
      context(base.db, base.ids, pitchTick),
    ).proposed!;
    const expired = base.store.processTick(
      context(base.db, base.ids, proposal.expiresTick),
    ).transitioned[0]!;
    expect(expired).toMatchObject({ id: proposal.id, status: "expired", finalTerms: null });
    const conversation = new SqliteConversationStore(base.db, TEST_RUN_ID)
      .get(proposal.negotiationConversationId!);
    expect(conversation).toMatchObject({
      status: "expired",
      closeReason: "expired",
      outcome: { kind: "no_agreement", extractedBy: "rule" },
    });
    const rejection = new SqliteEventStore(base.db, TEST_RUN_ID)
      .list()
      .find((event) => (
        event.type === "investment.rejected" &&
        (event.payload as { proposalId?: string }).proposalId === proposal.id
      ));
    expect(rejection?.payload).toMatchObject({
      status: "expired",
      reason: "proposal_expired",
    });
  });

  it("reopens and restores to an equivalent expiry transition and state hash", async () => {
    const base = fixture();
    const pitchTick = base.company.activatedTick! + INVESTMENT_PITCH_DELAY_TICKS;
    const proposal = base.store.processTick(
      context(base.db, base.ids, pitchTick),
    ).proposed!;
    saveCheckpoint(base.db, base.ids, pitchTick);
    const hashBeforeReopen = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();

    const reopened = tracked(openWorldDatabase(
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(hashBeforeReopen);
    expect(new SqliteInvestmentProposalStore(reopened, TEST_RUN_ID).get(proposal.id))
      .toEqual(proposal);
    const snapshots = new SqliteSnapshotStore(
      reopened,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "investment-proposal-snapshot" });
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(base.dataDir, "investment-proposal-restored", "world.db"),
    );
    const restored = tracked(openDatabaseFile(restoredPath));
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const store = new SqliteInvestmentProposalStore(db, TEST_RUN_ID);
      const result = store.processTick(context(db, ids, proposal.expiresTick));
      saveCheckpoint(db, ids, proposal.expiresTick);
      return { result, hash: computeLogicalStateHash(db, TEST_RUN_ID) };
    };
    const straight = advance(reopened);
    const replayed = advance(restored);
    expect(replayed.result).toEqual(straight.result);
    expect(replayed.hash).toBe(straight.hash);
  });
});
