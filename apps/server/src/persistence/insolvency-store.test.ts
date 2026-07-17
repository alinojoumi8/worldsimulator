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
  checkInvariants,
  generateRiverbendPopulation,
  type TickContext,
} from "@worldtangle/engine";
import { readRunInvariantSnapshot } from "../testing/run-invariant-probe";
import { SqliteAgentStore } from "./agent-store";
import { openDatabaseFile, openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteInsolvencyStore } from "./insolvency-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

interface RecordedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly options: unknown;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-insolvency-"));
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
  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const market = new SqliteMarketStore(db, TEST_RUN_ID);
  const insolvency = new SqliteInsolvencyStore(db, TEST_RUN_ID);
  const events: RecordedEvent[] = [];
  const contextWithIds = (
    tick: number,
    phase: TickContext["phase"],
    contextIds: IdFactory,
  ): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: `Y0001-D${String(tick).padStart(3, "0")}`,
    phase,
    ids: contextIds,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const event = {
        eventId: contextIds.next("tevt"),
        type,
        payload,
        options,
      };
      events.push(event);
      return event as unknown as EventEnvelope;
    },
  });
  const context = (tick: number, phase: TickContext["phase"]) =>
    contextWithIds(tick, phase, ids);
  return {
    dataDir,
    db,
    population,
    ids,
    finance,
    phase4,
    market,
    insolvency,
    events,
    context,
    contextWithIds,
  };
}

function addFailingCompany(base: ReturnType<typeof fixture>) {
  const lawFirmAccount = base.finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = base.phase4.requestCompanyFormation({
    name: "Last Thread Grocer",
    sector: "grocery_retail",
    founderAgentId: "agt_00000001",
    jurisdiction: "Riverbend",
    foundingCapitalCents: "300000",
    totalShares: "1000",
    lawFirmAccountId: lawFirmAccount.id,
    incorporationFeeCents: "10000",
    tick: 0,
    ids: base.ids,
  });
  for (const party of formation.contract.parties) {
    base.phase4.signContract(
      formation.contract.id,
      { kind: party.kind, id: party.id },
      0,
      base.ids,
    );
  }
  for (let tick = 1; tick <= 5; tick++) {
    base.phase4.processLegalObligations(base.context(tick, "obligations"));
    base.phase4.processCompanyFormations(base.context(tick, "execute"));
  }
  const company = base.phase4.getCompany(formation.company.id);
  const job = base.phase4.postJob({
    employerId: company.id,
    occupationCode: "retail_worker",
    title: "Last Thread worker",
    annualWageCents: "4800000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids: base.ids,
  });
  const worker = base.population.residents.find((resident) => (
    resident.agent.employmentStatus !== "employed" &&
    resident.agent.id !== company.founderAgentId
  ));
  if (worker === undefined) throw new Error("unemployed worker missing");
  base.phase4.submitJobApplication({
    jobId: job.id,
    agentId: worker.agent.id,
    reservationWageCents: "3000000",
    tick: 6,
    ids: base.ids,
  });
  base.phase4.processLaborMatching(base.context(7, "clearing"));
  const offering = base.market.createProductionOffering({
    companyId: company.id,
    sku: "groceries",
    postedPriceCents: "400",
    unitCostCents: "300",
    laborHoursPerWorker: 8,
    productivityMilliunitsPerLaborHour: 1_250,
    capacityUnitsPerTick: 12,
    tick: 7,
    ids: base.ids,
  });
  base.market.processProduction(base.context(7, "execute"));
  base.db.prepare(`
    UPDATE bank_accounts SET balance_cents = '250000'
    WHERE run_id = ? AND id = ?
  `).run(TEST_RUN_ID, company.businessAccountId);
  const securedCreditor = base.finance.accountForAgent("agt_00000002");
  const tradeCreditor = base.finance.accountForAgent("agt_00000003");
  base.insolvency.registerClaim({
    companyId: company.id,
    creditorKind: "secured_debt",
    creditorId: "agt_00000002",
    creditorAccountId: securedCreditor.id,
    amountCents: "30000",
    originKind: "manual",
    originId: "secured-note-1",
  }, base.context(7, "metrics"));
  base.insolvency.registerClaim({
    companyId: company.id,
    creditorKind: "trade",
    creditorId: "agt_00000003",
    creditorAccountId: tradeCreditor.id,
    amountCents: "30000",
    originKind: "manual",
    originId: "trade-invoice-1",
  }, base.context(7, "metrics"));
  return {
    company,
    job,
    workerId: worker.agent.id,
    offering,
    securedCreditor,
    tradeCreditor,
  };
}

function runShortfallDays(
  store: SqliteInsolvencyStore,
  context: (tick: number, phase: TickContext["phase"]) => TickContext,
  fromTick: number,
  throughTick: number,
): void {
  for (let tick = fromTick; tick <= throughTick; tick++) {
    store.assessAll(context(tick, "metrics"));
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-407 insolvency persistence and wind-down", () => {
  it("terminates relationships, salvages inventory, pays seniority, and closes cleanly", () => {
    const base = fixture();
    const failed = addFailingCompany(base);
    runShortfallDays(base.insolvency, base.context, 8, 37);

    expect(base.insolvency.listAssessments(failed.company.id)).toHaveLength(30);
    expect(base.insolvency.listAssessments(failed.company.id).at(-1)).toMatchObject({
      consecutiveShortfallDays: 30,
      insolvent: true,
      cashCents: "250000",
      obligationCents: "260000",
      shortfallCents: "10000",
    });
    expect(base.phase4.getCompany(failed.company.id)).toMatchObject({
      status: "closed",
      failureReason: "sustained_cash_shortfall",
    });
    const windDown = base.insolvency.getWindDown(failed.company.id);
    expect(windDown).toMatchObject({
      openingCashCents: "250000",
      salvageProceedsCents: "2500",
      liquidationPoolCents: "252500",
      creditorRecoveriesCents: "252500",
      writtenOffCents: "7500",
      employeesTerminated: 1,
      contractsTerminated: 2,
      jobsWithdrawn: 0,
      offeringsDeactivated: 1,
    });
    const claims = base.insolvency.listClaims(failed.company.id);
    expect(claims.map((claim) => [claim.creditorKind, claim.amountCents])).toEqual([
      ["employee_wage", "200000"],
      ["secured_debt", "30000"],
      ["trade", "30000"],
    ]);
    const recoveries = base.insolvency.listRecoveries(failed.company.id);
    expect(recoveries.map((recovery) => recovery.amountCents)).toEqual([
      "200000",
      "30000",
      "22500",
    ]);
    expect(recoveries.reduce((sum, recovery) => sum + BigInt(recovery.amountCents), 0n))
      .toBe(252_500n);
    expect(base.insolvency.listWriteOffs(failed.company.id).map((row) => row.amountCents))
      .toEqual(["7500"]);
    expect(base.insolvency.listSalvages(failed.company.id)).toMatchObject([{
      sku: "groceries",
      quantity: 10,
      unitPriceCents: "250",
      totalCents: "2500",
    }]);
    expect(base.db.prepare<[string, string], { status: string; end_tick: bigint }>(`
      SELECT status, end_tick FROM employment_contracts
      WHERE run_id = ? AND employer_id = ?
    `).get(TEST_RUN_ID, failed.company.id)).toEqual({ status: "ended", end_tick: 37n });
    expect(base.db.prepare<[string, string], { employment_status: string }>(`
      SELECT employment_status FROM agents WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, failed.workerId)?.employment_status).toBe("unemployed");
    expect(base.market.getInventory(failed.company.id, "groceries").quantity).toBe(0);
    expect(base.market.listActiveOfferings("groceries", 38)
      .some((quote) => quote.offering.companyId === failed.company.id)).toBe(false);
    expect(base.db.prepare<[string, string], { balance_cents: string; status: string }>(`
      SELECT balance_cents, status FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company' AND owner_id = ?
    `).get(TEST_RUN_ID, failed.company.id)).toEqual({ balance_cents: "0", status: "closed" });
    const failedEvent = base.events.find((event) => event.type === "company.failed");
    expect(failedEvent).toMatchObject({
      payload: expect.objectContaining({
        companyId: failed.company.id,
        liquidationProceedsCents: "252500",
        employeesTerminated: 1,
      }),
    });
    expect((failedEvent?.payload as { causeChain: string[] }).causeChain.length)
      .toBeGreaterThan(10);

    const invariant = readRunInvariantSnapshot(base.db, TEST_RUN_ID);
    expect(checkInvariants({
      employments: invariant.employments,
      employmentContracts: invariant.employmentContracts,
      companyClosures: invariant.companyClosures,
    }).checks.find((check) => check.invariant === "INV-5")).toMatchObject({
      status: "passed",
      violations: [],
    });

    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    expect(new SqliteInsolvencyStore(reopened, TEST_RUN_ID).getWindDown(failed.company.id))
      .toEqual(windDown);
  });

  it("rolls the complete liquidation back when account closure fails", () => {
    const base = fixture();
    const failed = addFailingCompany(base);
    runShortfallDays(base.insolvency, base.context, 8, 36);
    const inventoryBefore = base.market.getInventory(failed.company.id, "groceries");
    const balanceBefore = base.finance.accountBalance(failed.company.businessAccountId!);
    const failingStore = new SqliteInsolvencyStore(base.db, TEST_RUN_ID, {
      beforeAccountClose: () => {
        throw new Error("inject wind-down rollback");
      },
    });
    expect(() => failingStore.assessAll(base.context(37, "metrics")))
      .toThrow(/inject wind-down rollback/);
    expect(base.phase4.getCompany(failed.company.id).status).toBe("active");
    expect(base.insolvency.listAssessments(failed.company.id)).toHaveLength(29);
    expect(base.insolvency.getWindDown(failed.company.id)).toBeNull();
    expect(base.insolvency.listRecoveries(failed.company.id)).toEqual([]);
    expect(base.insolvency.listSalvages(failed.company.id)).toEqual([]);
    expect(base.market.getInventory(failed.company.id, "groceries")).toEqual(inventoryBefore);
    expect(base.finance.accountBalance(failed.company.businessAccountId!)).toBe(balanceBefore);
  });
});

describe("WS-407 snapshot restore equivalence", () => {
  it("restores a 29-day shortfall and reproduces the complete next-day liquidation", async () => {
    const base = fixture();
    const failed = addFailingCompany(base);
    runShortfallDays(base.insolvency, base.context, 8, 36);
    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 36, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "insolvency-snapshot-wall" });
    const destination = join(base.dataDir, "insolvency-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advance = (db: WorldDatabase): string => {
      const checkpoint = readRunCheckpoint(db, TEST_RUN_ID);
      const ids = IdFactory.restore(checkpoint.idState);
      const context: TickContext = {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        tick: 37,
        simDate: "Y0001-D037",
        phase: "metrics",
        ids,
        rng: (key) => Rng.root(42).fork(`37.metrics.${key}`),
        count: () => undefined,
        setDigestIndicators: () => undefined,
        emit: () => ({ eventId: ids.next("tevt") }) as EventEnvelope,
      };
      new SqliteInsolvencyStore(db, TEST_RUN_ID).assessAll(context);
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 37, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(db, TEST_RUN_ID);
    };

    const straightHash = advance(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteInsolvencyStore(restored, TEST_RUN_ID).listAssessments(failed.company.id))
      .toHaveLength(29);
    expect(advance(restored)).toBe(straightHash);
    expect(new SqliteInsolvencyStore(restored, TEST_RUN_ID).getWindDown(failed.company.id))
      .toEqual(base.insolvency.getWindDown(failed.company.id));
  });
});
