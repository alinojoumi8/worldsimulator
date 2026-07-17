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
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openDatabaseFile, openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteEnergyStore } from "./energy-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import {
  appendTestTickEvent,
  insertTestRun,
  testSimDate,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";
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
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-energy-"));
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
  const energy = new SqliteEnergyStore(db, TEST_RUN_ID);
  const genesisEventId = "evt_energygenesis";
  energy.initialize({
    ids,
    householdBaseTariffCents: "15000",
    sourceEventId: genesisEventId,
  });
  const events: RecordedEvent[] = [];
  const context = (tick: number, phase: TickContext["phase"]): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: testSimDate(tick),
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const event = appendTestTickEvent(db, {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        ids,
        tick,
        simDate: testSimDate(tick),
        phase,
        type,
        payload,
        options,
      });
      events.push({ eventId: event.eventId, type, payload, options });
      return event;
    },
  });
  return { dataDir, db, ids, finance, energy, events, context, population };
}

function addProducingCompany(base: ReturnType<typeof fixture>) {
  const phase4 = new SqlitePhase4Store(base.db, TEST_RUN_ID);
  const market = new SqliteMarketStore(base.db, TEST_RUN_ID);
  const lawFirmAccount = base.finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = phase4.requestCompanyFormation({
    name: "Powered Pantry",
    sector: "grocery_retail",
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
    phase4.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, base.ids);
  }
  for (let tick = 1; tick <= 5; tick++) {
    phase4.processLegalObligations(base.context(tick, "obligations"));
    phase4.processCompanyFormations(base.context(tick, "execute"));
  }
  const job = phase4.postJob({
    employerId: formation.company.id,
    occupationCode: "retail_worker",
    title: "Powered pantry worker",
    annualWageCents: "4000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids: base.ids,
  });
  const worker = base.population.residents.find((resident) => (
    resident.agent.employmentStatus !== "employed" &&
    resident.agent.id !== formation.company.founderAgentId
  ));
  if (worker === undefined) throw new Error("worker fixture missing");
  phase4.submitJobApplication({
    jobId: job.id,
    agentId: worker.agent.id,
    reservationWageCents: "2000000",
    tick: 6,
    ids: base.ids,
  });
  phase4.processLaborMatching(base.context(6, "clearing"));
  market.createProductionOffering({
    companyId: formation.company.id,
    sku: "groceries",
    postedPriceCents: "400",
    unitCostCents: "300",
    laborHoursPerWorker: 8,
    productivityMilliunitsPerLaborHour: 1_250,
    capacityUnitsPerTick: 12,
    tick: 6,
    ids: base.ids,
  });
  const businessTariff = base.energy.tariff("business", 7);
  const production = market.processProduction(
    base.context(7, "execute"),
    businessTariff.priceCents,
  );
  return { companyId: formation.company.id, production, market };
}

function fundedHousehold(base: ReturnType<typeof fixture>) {
  const household = base.finance.listHouseholdFinances().find((candidate) => (
    candidate.memberAccounts.reduce(
      (sum, account) => sum + BigInt(account.balanceCents),
      0n,
    ) >= 15_000n
  ));
  if (household === undefined) throw new Error("funded household missing");
  return {
    household,
    accountIds: household.memberAgentIds.map(
      (agentId) => base.finance.accountForAgent(agentId).id,
    ),
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteEnergyStore tariff schedule", () => {
  it("propagates a +30% fuel shock into both tariffs at the next cycle", () => {
    const base = fixture();
    const shock = base.energy.applyFuelShock(base.context(5, "execute"), {
      changeBp: 3_000,
      source: "test",
      causeEventId: null,
    });
    expect(shock).toMatchObject({
      oldPriceCents: "100",
      newPriceCents: "130",
      nextTariffTick: 30,
    });
    expect(base.energy.processTariffCycle(base.context(29, "obligations"))).toEqual([]);
    expect(base.energy.tariff("household", 29).priceCents).toBe("15000");

    expect(base.energy.processTariffCycle(base.context(30, "obligations"))).toMatchObject([
      { customerClass: "household", priceCents: "17700", effectiveTick: 30 },
      { customerClass: "business", priceCents: "59", effectiveTick: 30 },
    ]);
    expect(base.energy.listTariffs()).toHaveLength(4);
    const tariffEvents = base.events.filter((event) => event.type === "market.price.updated");
    expect(tariffEvents).toHaveLength(2);
    expect(tariffEvents[0]).toMatchObject({
      payload: {
        sku: "electricity",
        cause: "fuel_pass_through",
        causeEventId: shock.sourceEventId,
      },
      options: { causationId: shock.sourceEventId },
    });
  });

  it("persists immutable tariff and fuel history across reopen", () => {
    const base = fixture();
    base.energy.applyFuelShock(base.context(5, "execute"), {
      changeBp: 3_000,
      source: "test",
      causeEventId: null,
    });
    base.energy.processTariffCycle(base.context(30, "obligations"));
    const expected = base.energy.listTariffs();
    expect(() => base.db.prepare(`
      UPDATE energy_tariff_history SET price_cents = '1' WHERE run_id = ?
    `).run(TEST_RUN_ID)).toThrow(/immutable/);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    expect(new SqliteEnergyStore(reopened, TEST_RUN_ID).listTariffs()).toEqual(expected);
  });
});

describe("SqliteEnergyStore balanced billing", () => {
  it("bills actual firm production and household service, then purchases fuel from ROW", () => {
    const base = fixture();
    const { companyId, production } = addProducingCompany(base);
    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({ unitCostCents: "350" });
    const businessBills = base.energy.billBusinessProduction(base.context(7, "settlement"));
    expect(businessBills).toMatchObject([{
      customerClass: "business",
      customerId: companyId,
      units: production[0]!.unitsProduced,
      unitPriceCents: "50",
      status: "paid",
      evidenceRefs: [production[0]!.id],
    }]);
    const businessFuel = base.energy.purchaseFuelForTick(base.context(7, "settlement"));
    expect(businessFuel).toMatchObject({
      fuelMilliunits: production[0]!.unitsProduced * 250,
      unitPriceCents: "100",
    });

    const household = fundedHousehold(base);
    const householdBill = base.energy.settleHouseholdBill(base.context(30, "settlement"), {
      householdId: household.household.householdId,
      accountIds: household.accountIds,
    });
    expect(householdBill).toMatchObject({
      customerClass: "household",
      units: 1,
      unitPriceCents: "15000",
      amountCents: "15000",
      fuelMilliunits: 100_000,
      status: "paid",
    });
    expect(base.energy.purchaseFuelForTick(base.context(30, "settlement"))).toMatchObject({
      fuelMilliunits: 100_000,
      totalCents: "10000",
    });
    const transactionIds = [
      businessBills[0]!.transactionId!,
      businessFuel!.transactionId,
      householdBill.transactionId!,
      base.energy.listFuelPurchases().at(-1)!.transactionId,
    ];
    for (const transactionId of transactionIds) {
      const legs = base.db.prepare<[string, string], {
        direction: "debit" | "credit";
        amount_cents: string;
      }>(`
        SELECT direction, amount_cents FROM ledger_transaction_legs
        WHERE run_id = ? AND transaction_id = ? ORDER BY leg_index
      `).all(TEST_RUN_ID, transactionId);
      const debits = legs.filter((leg) => leg.direction === "debit")
        .reduce((sum, leg) => sum + BigInt(leg.amount_cents), 0n);
      const credits = legs.filter((leg) => leg.direction === "credit")
        .reduce((sum, leg) => sum + BigInt(leg.amount_cents), 0n);
      expect(debits).toBe(credits);
    }
    expect(base.finance.auditConservation()).toEqual([]);
    expect(base.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "energy.bill.posted",
      "energy.fuel.purchased",
      "transaction.posted",
    ]));
  });

  it("records an all-or-nothing rejection without a transaction", () => {
    const base = fixture();
    const household = fundedHousehold(base);
    for (const accountId of household.accountIds) {
      base.db.prepare(`
        UPDATE bank_accounts SET balance_cents = '0' WHERE run_id = ? AND id = ?
      `).run(TEST_RUN_ID, accountId);
    }
    const transactionsBefore = base.finance.listTransactions({ limit: 200 }).items.length;
    const bill = base.energy.settleHouseholdBill(base.context(30, "settlement"), {
      householdId: household.household.householdId,
      accountIds: household.accountIds,
    });
    expect(bill).toMatchObject({
      status: "rejected",
      rejectionReason: "insufficient_funds",
      transactionId: null,
    });
    expect(base.finance.listTransactions({ limit: 200 }).items).toHaveLength(transactionsBefore);
    expect(base.energy.purchaseFuelForTick(base.context(30, "settlement"))).toBeNull();
  });

  it("rolls ledger balances and bill records back together", () => {
    const base = fixture();
    const household = fundedHousehold(base);
    const balancesBefore = household.accountIds.map((id) => base.finance.accountBalance(id));
    expect(() => base.db.transaction(() => {
      base.energy.settleHouseholdBill(base.context(30, "settlement"), {
        householdId: household.household.householdId,
        accountIds: household.accountIds,
      });
      throw new Error("inject energy rollback");
    }).immediate()).toThrow(/inject energy rollback/);
    expect(base.energy.listBills()).toEqual([]);
    expect(household.accountIds.map((id) => base.finance.accountBalance(id))).toEqual(balancesBefore);
  });
});

describe("WS-406 snapshot equivalence", () => {
  it("restores energy state and reproduces the next shock state hash", async () => {
    const base = fixture();
    const household = fundedHousehold(base);
    base.energy.applyFuelShock(base.context(5, "execute"), {
      changeBp: 3_000,
      source: "test",
      causeEventId: null,
    });
    base.energy.processTariffCycle(base.context(30, "obligations"));
    base.energy.settleHouseholdBill(base.context(30, "settlement"), {
      householdId: household.household.householdId,
      accountIds: household.accountIds,
    });
    base.energy.purchaseFuelForTick(base.context(30, "settlement"));
    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 30, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "energy-snapshot-wall" });
    const destination = join(base.dataDir, "energy-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advanceShock = (db: WorldDatabase): string => {
      const checkpoint = readRunCheckpoint(db, TEST_RUN_ID);
      const ids = IdFactory.restore(checkpoint.idState);
      const energy = new SqliteEnergyStore(db, TEST_RUN_ID);
      const context: TickContext = {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        tick: 35,
        simDate: "Y0001-M02-D06",
        phase: "execute",
        ids,
        rng: (key) => Rng.root(42).fork(`35.execute.${key}`),
        count: () => undefined,
        setDigestIndicators: () => undefined,
        emit: () => ({ eventId: "evt_energyequiv01" }) as EventEnvelope,
      };
      energy.applyFuelShock(context, {
        changeBp: -1_000,
        source: "test",
        causeEventId: null,
      });
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 35, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(db, TEST_RUN_ID);
    };

    const straightHash = advanceShock(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteEnergyStore(restored, TEST_RUN_ID).listBills())
      .toEqual(base.energy.listBills().slice(0, 1));
    expect(advanceShock(restored)).toBe(straightHash);
  });
});
