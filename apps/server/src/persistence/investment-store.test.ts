import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  IdFactory,
  investmentEquityBasisPoints,
  investmentStructuredTermsSchema,
  Rng,
  type EventEnvelope,
  type InvestmentStructuredTerms,
} from "@worldtangle/shared";
import {
  checkInvariants,
  deterministicConversationOutcome,
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import { readRunInvariantSnapshot } from "../testing/run-invariant-probe";
import { SqliteAgentStore } from "./agent-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteConversationStore } from "./conversation-store";
import { SqliteInvestmentProposalStore } from "./investment-proposal-store";
import { SqliteInvestmentStore } from "./investment-store";
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

function appendSeedEvents(
  db: WorldDatabase,
  firmId: string,
  fundId: string,
  fundAccountId: string,
  firmEventId: string,
  fundAccountEventId: string,
  fundEventId: string,
  triggerEventId: string,
  companyId: string,
): void {
  new SqliteEventStore(db, TEST_RUN_ID).appendBatch([
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
      payload: { firmId },
    },
    {
      eventId: fundAccountEventId,
      type: "account.opened",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 1,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "system", id: "venture-capital" },
      correlationId: "venture-seed",
      causationId: firmEventId,
      payload: { accountId: fundAccountId },
    },
    {
      eventId: fundEventId,
      type: "venture.fund.created",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 2,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "institution", id: firmId },
      correlationId: "venture-seed",
      causationId: fundAccountEventId,
      payload: { fundId },
    },
    {
      eventId: triggerEventId,
      type: "company.investment_pitch.ready",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 3,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "system", id: "investment-test" },
      correlationId: companyId,
      payload: { companyId },
    },
  ]);
}

function fixture(options: { readonly invalidAmount?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-investment-close-"));
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
  const fundAccountEventId = ids.next("evt");
  const fundEventId = ids.next("evt");
  const triggerEventId = ids.next("evt");
  const venture = new SqliteVentureStore(db, TEST_RUN_ID);
  const initialized = venture.initializeFoundry({
    ids,
    firmSourceEventId: firmEventId,
    fundAccountSourceEventId: fundAccountEventId,
    fundSourceEventId: fundEventId,
  });
  const company = db.prepare<[], {
    company_id: string;
    owner_agent_id: string;
  }>(`
    SELECT equity.company_id, stake.owner_agent_id
    FROM opening_company_equity equity
    JOIN opening_company_equity_stakes stake
      ON stake.run_id = equity.run_id AND stake.company_id = equity.company_id
    WHERE equity.run_id = '${TEST_RUN_ID}'
    ORDER BY equity.company_id LIMIT 1
  `).get();
  if (company === undefined) throw new Error("opening company missing");
  appendSeedEvents(
    db,
    initialized.firm.id,
    initialized.fund.id,
    initialized.fundAccount.id,
    firmEventId,
    fundAccountEventId,
    fundEventId,
    triggerEventId,
    company.company_id,
  );
  const partner = population.residents.find((resident) => (
    resident.organizationId === FOUNDRY_CAPITAL_ID &&
    resident.roleCode === "vc.partner"
  ));
  if (partner === undefined) throw new Error("VC partner missing");
  const proposals = new SqliteInvestmentProposalStore(db, TEST_RUN_ID);
  const proposal = proposals.propose({
    companyId: company.company_id,
    founderAgentId: company.owner_agent_id,
    fundId: initialized.fund.id,
    vcPartnerAgentId: partner.agent.id,
    askAmountCents: "200000",
    preMoneyValuationCents: "800000",
    triggerEventId,
  }, context(db, ids, 1));
  const amountCents = options.invalidAmount === true ? "199999" : "200000";
  const terms: InvestmentStructuredTerms = investmentStructuredTermsSchema.parse({
    kind: "investment",
    referenceId: proposal.id,
    amountCents,
    preMoneyValuationCents: "800000",
    equityBasisPoints: investmentEquityBasisPoints(amountCents, "800000"),
  });
  const conversations = new SqliteConversationStore(db, TEST_RUN_ID);
  conversations.close({
    conversationId: proposal.negotiationConversationId!,
    closeReason: "agreement",
    outcome: deterministicConversationOutcome(
      "agreement",
      terms,
      "Both parties selected a bounded priced-round option.",
    ),
  }, context(db, ids, 2));
  const agreed = proposals.processTick(context(db, ids, 2)).transitioned[0];
  if (agreed?.status !== "agreed") throw new Error("proposal did not reach agreement");
  return {
    dataDir,
    db,
    ids,
    finance,
    companyId: company.company_id,
    fund: initialized.fund,
    proposal: agreed,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("SqliteInvestmentStore", () => {
  it("closes an exact priced round atomically across cash, contract, fund, and cap table", () => {
    const base = fixture();
    const companyAccount = base.finance.listAccounts().find((account) => (
      account.ownerKind === "company" && account.ownerId === base.companyId &&
      account.type === "checking"
    ));
    if (companyAccount === undefined) throw new Error("company account missing");
    const companyBalanceBefore = base.finance.accountBalance(companyAccount.id);
    const result = new SqliteInvestmentStore(base.db, TEST_RUN_ID)
      .processTick(context(base.db, base.ids, 3));

    expect(result.rejected).toEqual([]);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      proposalId: base.proposal.id,
      companyId: base.companyId,
      investorId: base.fund.id,
      amountCents: "200000",
      preMoneyValuationCents: "800000",
      totalSharesBefore: "10000",
      sharesIssued: "2500",
      totalSharesAfter: "12500",
      pricePerShareCents: "80",
      completedTick: 3,
    });
    expect(result.completed[0]?.capitalCallTransactionId).not.toBeNull();
    expect(base.finance.accountBalance(base.fund.bankAccountId)).toBe(0n);
    expect(base.finance.accountBalance(companyAccount.id)).toBe(
      companyBalanceBefore + 200_000n,
    );
    expect(new SqliteVentureStore(base.db, TEST_RUN_ID).getFund(base.fund.id))
      .toMatchObject({ deployedCents: "200000" });
    expect(new SqliteInvestmentProposalStore(base.db, TEST_RUN_ID).get(base.proposal.id))
      .toMatchObject({ status: "completed" });
    expect(new SqlitePhase4Store(base.db, TEST_RUN_ID)
      .getLegalContract(result.completed[0]!.contractId)).toMatchObject({
        type: "investment",
        status: "signed",
      });

    const capTable = new SqliteInvestmentStore(base.db, TEST_RUN_ID)
      .capTable(base.companyId);
    expect(capTable.totalShares).toBe("12500");
    expect(capTable.stakes.reduce((sum, stake) => sum + BigInt(stake.shares), 0n))
      .toBe(12_500n);
    expect(capTable.stakes).toContainEqual(expect.objectContaining({
      holderKind: "venture_fund",
      holderId: base.fund.id,
      shares: "2500",
      acquiredVia: "investment",
    }));
    const invariants = checkInvariants(readRunInvariantSnapshot(base.db, TEST_RUN_ID));
    expect(invariants.checks.find((check) => check.invariant === "INV-4"))
      .toMatchObject({ status: "passed", violations: [] });

    const events = new SqliteEventStore(base.db, TEST_RUN_ID).list();
    const completed = events.find((event) => event.type === "investment.completed");
    expect(completed).toBeDefined();
    expect(events.find((event) => event.eventId === completed?.causationId)?.type)
      .toBe("venture.fund.deployed");
    expect(completed?.payload).toMatchObject({
      investmentId: result.completed[0]!.id,
      capTableBefore: { totalShares: "10000" },
      capTableAfter: { totalShares: "12500" },
    });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "venture.fund.capital_call.requested",
      "investment.cash_transfer.requested",
      "contract.drafted",
      "contract.signed",
      "transaction.posted",
    ]));

    expect(() => base.db.prepare(`
      UPDATE investments SET amount_cents = '1'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.completed[0]!.id)).toThrow(/immutable/);
    expect(() => base.db.prepare(`
      UPDATE company_cap_tables SET total_shares = '12501'
      WHERE run_id = ? AND company_id = ?
    `).run(TEST_RUN_ID, base.companyId)).toThrow(/exact evented share issuance/);

    const invalidStakeId = base.ids.next("stk");
    const invalidEventId = base.ids.next("evt");
    expect(() => base.db.transaction(() => {
      base.db.prepare(`
        INSERT INTO ownership_stakes(
          run_id, id, company_id, holder_kind, holder_id, shares,
          acquired_via, since_tick, source_event_id
        ) VALUES (?, ?, ?, 'venture_fund', ?, '1', 'investment', 4, ?)
      `).run(
        TEST_RUN_ID,
        invalidStakeId,
        base.companyId,
        base.fund.id,
        invalidEventId,
      );
      new SqliteEventStore(base.db, TEST_RUN_ID).append({
        eventId: invalidEventId,
        type: "investment.invalid_source",
        schemaVersion: 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq: new SqliteEventStore(base.db, TEST_RUN_ID).count(),
        tick: 4,
        simDate: simDateForTick(4),
        wallTime: "T4",
        actor: { kind: "system", id: "investment-test" },
        correlationId: base.proposal.id,
        payload: { investmentId: result.completed[0]!.id },
      });
    }).immediate()).toThrow(/source must be its completion event/);
  });

  it("rejects bounded but fractionally unrepresentable terms without partial mutation", () => {
    const base = fixture({ invalidAmount: true });
    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const transactionCountBefore = base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
    `).get()!.count;
    const result = new SqliteInvestmentStore(base.db, TEST_RUN_ID)
      .processTick(context(base.db, base.ids, 3));

    expect(result.completed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      id: base.proposal.id,
      status: "rejected",
      finalTerms: null,
    });
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM investments
    `).get()?.count).toBe(0n);
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM legal_contracts WHERE contract_type = 'investment'
    `).get()?.count).toBe(0n);
    expect(base.db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
    `).get()?.count).toBe(transactionCountBefore);
    expect(new SqliteInvestmentStore(base.db, TEST_RUN_ID).capTable(base.companyId).totalShares)
      .toBe("10000");
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).not.toBe(hashBefore);
    const rejected = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .findLast((event) => event.type === "investment.rejected");
    expect(rejected?.payload).toMatchObject({
      reason: "terms_invalid",
      validation: {
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/integer shares/),
      },
    });
  });

  it("rolls back, reopens, and restores to an equivalent deterministic close", async () => {
    const base = fixture();
    saveCheckpoint(base.db, base.ids, 2);
    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const rollbackIds = IdFactory.restore(base.ids.serialize());
    expect(() => base.db.transaction(() => {
      new SqliteInvestmentStore(base.db, TEST_RUN_ID)
        .processTick(context(base.db, rollbackIds, 3));
      throw new Error("force investment rollback");
    }).immediate()).toThrow(/force investment rollback/);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(hashBefore);
    expect(new SqliteInvestmentProposalStore(base.db, TEST_RUN_ID).get(base.proposal.id))
      .toMatchObject({ status: "agreed" });
    expect(new SqliteInvestmentStore(base.db, TEST_RUN_ID).list()).toEqual([]);

    base.db.close();
    const reopened = tracked(openWorldDatabase(
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(hashBefore);
    const snapshots = new SqliteSnapshotStore(
      reopened,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "investment-close-snapshot" });
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(base.dataDir, "investment-close-restored", "world.db"),
    );
    const restored = tracked(openDatabaseFile(restoredPath));
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const result = new SqliteInvestmentStore(db, TEST_RUN_ID)
        .processTick(context(db, ids, 3));
      saveCheckpoint(db, ids, 3);
      return { result, hash: computeLogicalStateHash(db, TEST_RUN_ID) };
    };
    const straight = advance(reopened);
    const fromSnapshot = advance(restored);
    expect(fromSnapshot).toEqual(straight);
    expect(straight.result.completed).toHaveLength(1);
  });
});
