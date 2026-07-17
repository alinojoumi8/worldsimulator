import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  decisionSchema,
  IdFactory,
  ledgerTransactionSchema,
  Rng,
  type EventEnvelope,
  type LedgerTransaction,
} from "@worldtangle/shared";
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openDatabaseFile, openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import {
  appendTestTickEvent,
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function payerCredits(
  accounts: readonly { readonly id: string; readonly balanceCents: string }[],
  amountCents: bigint,
): LedgerTransaction["legs"] {
  const legs: LedgerTransaction["legs"] = [];
  let remaining = amountCents;
  for (const account of accounts) {
    if (remaining === 0n) break;
    const amount = BigInt(account.balanceCents) < remaining
      ? BigInt(account.balanceCents)
      : remaining;
    if (amount > 0n) {
      legs.push({ accountId: account.id, direction: "credit", amountCents: amount.toString() });
      remaining -= amount;
    }
  }
  if (remaining !== 0n) throw new Error("test buyer lacks funds");
  return legs;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-market-"));
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
  const events: { type: string; eventId: string; payload: unknown }[] = [];
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
      const event = appendTestTickEvent(db, {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        ids,
        tick,
        simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
        phase,
        type,
        payload,
        options,
      });
      events.push({ type, eventId: event.eventId, payload });
      return event;
    },
  });

  const lawFirmAccount = finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = phase4.requestCompanyFormation({
    name: "Riverbend Pantry",
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
  const job = phase4.postJob({
    employerId: formation.company.id,
    occupationCode: "retail_worker",
    title: "Pantry worker",
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
    jobId: job.id,
    agentId: worker.agent.id,
    reservationWageCents: "2000000",
    tick: 6,
    ids,
  });
  phase4.processLaborMatching(context(6, "clearing"));
  const created = market.createProductionOffering({
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
  return {
    dataDir,
    db,
    ids,
    finance,
    phase4,
    market,
    events,
    context,
    companyId: formation.company.id,
    founderAgentId: formation.company.founderAgentId,
    offering: created.offering,
  };
}

function persistPriceDecision(input: {
  readonly db: WorldDatabase;
  readonly ids: IdFactory;
  readonly founderAgentId: string;
  readonly offeringId: string;
  readonly tick: number;
  readonly newPriceCents: string;
}): string {
  const id = input.ids.next("dec");
  const params = {
    offeringId: input.offeringId,
    newPriceCents: input.newPriceCents,
  };
  const decision = decisionSchema.parse({
    id,
    runId: TEST_RUN_ID,
    agentId: input.founderAgentId,
    tick: input.tick,
    trigger: {
      kind: "market",
      sourceEventId: "evt_00000001",
      priority: 50,
    },
    tier: 1,
    observationDigest: {
      hash: "0".repeat(64),
      summary: "The founder reviewed the current posted price and cost envelope.",
    },
    optionsOffered: [{
      actionId: "set_price",
      actionType: "market.set_price",
      params,
      utility: 100,
    }],
    chosenActionId: "set_price",
    params,
    rationale: "rule:founder_price_override_v1",
    validationResult: { status: "approved" },
  });
  new SqliteAgentStore(input.db, TEST_RUN_ID).saveDecisionResult([decision], []);
  return id;
}

function householdBuyer(finance: SqliteFinanceStore, minimumCents = 1n) {
  const household = finance.listHouseholdFinances().find((candidate) => (
    candidate.memberAccounts.reduce(
      (sum, account) => sum + BigInt(account.balanceCents),
      0n,
    ) >= minimumCents
  ));
  if (household === undefined) throw new Error("funded household fixture missing");
  const accounts = household.memberAgentIds.map((agentId) => finance.accountForAgent(agentId));
  return { household, accounts };
}

function postPurchase(input: {
  readonly finance: SqliteFinanceStore;
  readonly ids: IdFactory;
  readonly orderId: string;
  readonly tick: number;
  readonly sellerAccountId: string;
  readonly accounts: readonly { readonly id: string; readonly balanceCents: string }[];
  readonly totalCents: string;
  readonly sourceEventId: string;
}) {
  const transaction = ledgerTransactionSchema.parse({
    id: input.ids.next("txn"),
    runId: TEST_RUN_ID,
    tick: input.tick,
    kind: "purchase",
    actor: { kind: "system", id: "market" },
    reason: "household.food",
    sourceEventId: input.sourceEventId,
    correlationId: `market:${input.orderId}`,
    idempotencyKey: `market:${input.orderId}`,
    legs: [
      {
        accountId: input.sellerAccountId,
        direction: "debit",
        amountCents: input.totalCents,
      },
      ...payerCredits(input.accounts, BigInt(input.totalCents)),
    ],
  });
  input.finance.post(transaction);
  return transaction;
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WS-404 production and inventory persistence", () => {
  it("ships the seven-SKU catalog and turns active labor into bounded inventory", () => {
    const { db, market, events, context, companyId } = fixture();
    expect(market.listProducts().map((product) => product.sku)).toEqual([
      "durable_goods",
      "electricity",
      "groceries",
      "healthcare_visit",
      "meals",
      "repair_services",
      "tuition",
    ]);
    const runs = market.processProduction(context(7, "execute"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      companyId,
      sku: "groceries",
      workerCount: 1,
      laborHours: 8,
      unitsProduced: 10,
      inventoryBefore: 0,
      inventoryAfter: 10,
      unitCostCents: "300",
    });
    expect(market.getInventory(companyId, "groceries")).toMatchObject({
      quantity: 10,
      averageUnitCostCents: "300",
    });
    expect(() => market.processProduction(context(7, "execute"))).toThrow(/UNIQUE constraint failed/);
    expect(market.getInventory(companyId, "groceries").quantity).toBe(10);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "production.completed",
      "inventory.increased",
    ]));
    expect(() => db.prepare(`
      UPDATE company_inventory SET quantity = -1 WHERE run_id = ? AND company_id = ?
    `).run(TEST_RUN_ID, companyId)).toThrow(/CHECK constraint failed/);
  });

  it("rejects an initial posted price outside the cost envelope before persistence", () => {
    const { db, ids, market, companyId } = fixture();
    const before = db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM market_offerings WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count;
    expect(() => market.createProductionOffering({
      companyId,
      sku: "durable_goods",
      postedPriceCents: "451",
      unitCostCents: "300",
      laborHoursPerWorker: 8,
      productivityMilliunitsPerLaborHour: 1_000,
      capacityUnitsPerTick: 10,
      tick: 6,
      ids,
    })).toThrow(/unit cost, unit cost \+ 50%/);
    expect(db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM market_offerings WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count).toBe(before);
  });
});

describe("WS-404 posted-price orders", () => {
  it("validates the household, settles exact cents, and decrements inventory once", () => {
    const { ids, finance, market, context, companyId, offering } = fixture();
    market.processProduction(context(7, "execute"));
    const { household, accounts } = householdBuyer(finance, 1_000n);
    const companyAccount = finance.listAccounts().find((account) => (
      account.ownerKind === "company" && account.ownerId === companyId
    ));
    if (companyAccount === undefined) throw new Error("company account missing");
    const companyBefore = BigInt(companyAccount.balanceCents);
    const householdBefore = accounts.reduce((sum, account) => sum + BigInt(account.balanceCents), 0n);
    const placement = market.placeOrder({
      buyerKind: "household",
      buyerId: household.householdId,
      buyerAccountIds: accounts.map((account) => account.id),
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: 2,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: "evt_household_request",
      ids,
    });
    expect(placement.order.status).toBe("placed");
    const sourceEventId = "evt_order_created";
    const settlement = market.settleOrder(placement.order.id, 7, ids, (request) => {
      const refreshed = accounts.map((account) => finance.accountForAgent(account.ownerId));
      const transaction = postPurchase({
        finance,
        ids,
        orderId: request.order.id,
        tick: 7,
        sellerAccountId: request.sellerAccountId,
        accounts: refreshed,
        totalCents: request.totalCents,
        sourceEventId,
      });
      return { transactionId: transaction.id, sourceEventId };
    });
    expect(settlement.order).toMatchObject({
      status: "filled",
      filledQuantity: 2,
      totalCents: "800",
    });
    expect(settlement).toMatchObject({ inventoryBefore: 10, inventoryAfter: 8 });
    expect(market.getInventory(companyId, "groceries").quantity).toBe(8);
    expect(finance.accountBalance(companyAccount.id)).toBe(companyBefore + 800n);
    expect(accounts.reduce(
      (sum, account) => sum + finance.accountBalance(account.id),
      0n,
    )).toBe(householdBefore - 800n);
    expect(finance.reconcile()).toEqual([]);
  });

  it("rejects unauthorized buyers and records stockouts without moving money or stock", () => {
    const { ids, finance, market, context, companyId, offering } = fixture();
    market.processProduction(context(7, "execute"));
    const buyers = finance.listHouseholdFinances().slice(0, 2);
    expect(buyers).toHaveLength(2);
    const wrongAccount = finance.accountForAgent(buyers[1]!.memberAgentIds[0]!);
    const invalid = market.placeOrder({
      buyerKind: "household",
      buyerId: buyers[0]!.householdId,
      buyerAccountIds: [wrongAccount.id],
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: 1,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: "evt_invalid_buyer",
      ids,
    });
    expect(invalid.order).toMatchObject({ status: "rejected", rejectionReason: "invalid_buyer" });

    const { household, accounts } = householdBuyer(finance, 5_500n);
    const stockBefore = market.getInventory(companyId, "groceries").quantity;
    const transactionsBefore = finance.listTransactions({ limit: 200 }).items.length;
    const stockout = market.placeOrder({
      buyerKind: "household",
      buyerId: household.householdId,
      buyerAccountIds: accounts.map((account) => account.id),
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: stockBefore + 1,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: "evt_stockout_request",
      ids,
    });
    expect(stockout.order).toMatchObject({ status: "rejected", rejectionReason: "stockout" });
    expect(stockout.stockout).toMatchObject({
      requestedQuantity: stockBefore + 1,
      availableQuantity: stockBefore,
    });
    expect(market.listStockouts()).toHaveLength(1);
    expect(market.getInventory(companyId, "groceries").quantity).toBe(stockBefore);
    expect(finance.listTransactions({ limit: 200 }).items.length).toBe(transactionsBefore);
  });

  it("rolls back a posted payment when settlement fails after the ledger write", () => {
    const { db, ids, finance, market, context, companyId, offering } = fixture();
    market.processProduction(context(7, "execute"));
    const { household, accounts } = householdBuyer(finance, 500n);
    const placement = market.placeOrder({
      buyerKind: "household",
      buyerId: household.householdId,
      buyerAccountIds: accounts.map((account) => account.id),
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: 1,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: "evt_atomic_request",
      ids,
    });
    const inventoryBefore = market.getInventory(companyId, "groceries").quantity;
    const transactionsBefore = db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count;
    expect(() => market.settleOrder(placement.order.id, 7, ids, (request) => {
      const refreshed = accounts.map((account) => finance.accountForAgent(account.ownerId));
      postPurchase({
        finance,
        ids,
        orderId: request.order.id,
        tick: 7,
        sellerAccountId: request.sellerAccountId,
        accounts: refreshed,
        totalCents: request.totalCents,
        sourceEventId: "evt_atomic_payment",
      });
      throw new Error("injected settlement failure");
    })).toThrow(/injected settlement failure/);
    expect(market.getOrder(placement.order.id).status).toBe("placed");
    expect(market.getInventory(companyId, "groceries").quantity).toBe(inventoryBefore);
    expect(db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count).toBe(transactionsBefore);
    expect(finance.reconcile()).toEqual([]);
  });
});

describe("WS-405 weekly pricing and founder overrides", () => {
  it("raises the weekly price after a stockout and records exact rule evidence", () => {
    const { ids, finance, market, context, companyId, offering, events } = fixture();
    market.processProduction(context(7, "execute"));
    const { household, accounts } = householdBuyer(finance, 4_400n);
    const stockout = market.placeOrder({
      buyerKind: "household",
      buyerId: household.householdId,
      buyerAccountIds: accounts.map((account) => account.id),
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: 11,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: "evt_price_stockout",
      ids,
    });
    expect(stockout.order.status).toBe("rejected");
    expect(market.processWeeklyPricing(context(12, "settlement"))).toEqual([]);

    const updates = market.processWeeklyPricing(context(13, "settlement"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      offeringId: offering.id,
      companyId,
      tick: 13,
      oldPriceCents: "400",
      newPriceCents: "420",
      unitCostCents: "300",
      inventoryQuantity: 10,
      unitsSold: 0,
      unfilledUnits: 1,
      inventorySalesRatioBp: null,
      source: "rule",
      decisionId: null,
      ruleSignal: "stockout",
    });
    expect(market.listActiveOfferings("groceries", 14)[0]?.offering.postedPriceCents).toBe("420");
    expect(market.processWeeklyPricing(context(13, "settlement"))).toEqual([]);
    expect(events.filter((event) => event.type === "market.price.updated")).toHaveLength(1);
    expect(events.find((event) => event.type === "market.price.updated")?.payload).toMatchObject({
      oldPriceCents: "400",
      newPriceCents: "420",
      cause: "rule",
      ruleSignal: "stockout",
    });
  });

  it("accepts only a current founder decision inside the cost-to-50-percent envelope", () => {
    const { db, ids, market, context, founderAgentId, offering, events } = fixture();
    const foreignDecisionId = persistPriceDecision({
      db,
      ids,
      founderAgentId: "agt_00000002",
      offeringId: offering.id,
      tick: 7,
      newPriceCents: "450",
    });
    const decisionId = persistPriceDecision({
      db,
      ids,
      founderAgentId,
      offeringId: offering.id,
      tick: 7,
      newPriceCents: "450",
    });
    expect(() => market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId: "agt_00000002",
      decisionId,
      newPriceCents: "450",
    }, context(7, "decisions"))).toThrow(/only the company founder/);
    expect(() => market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId,
      decisionId: foreignDecisionId,
      newPriceCents: "450",
    }, context(7, "decisions"))).toThrow(/price decision does not belong to the founder/);
    expect(() => market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId,
      decisionId,
      newPriceCents: "451",
    }, context(7, "decisions"))).toThrow(/unit cost, unit cost \+ 50%/);
    expect(() => market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId,
      decisionId,
      newPriceCents: "299",
    }, context(7, "decisions"))).toThrow(/unit cost, unit cost \+ 50%/);

    const update = market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId,
      decisionId,
      newPriceCents: "450",
    }, context(7, "decisions"));
    expect(update).toMatchObject({
      oldPriceCents: "400",
      newPriceCents: "450",
      source: "decision",
      decisionId,
      ruleSignal: null,
    });
    expect(events.find((event) => event.type === "market.price.updated")?.payload).toMatchObject({
      oldPriceCents: "400",
      newPriceCents: "450",
      cause: `decision:${decisionId}`,
    });
    expect(() => db.prepare(`
      UPDATE market_price_history SET new_price_cents = '449' WHERE run_id = ?
    `).run(TEST_RUN_ID)).toThrow(/market price history is immutable/);
  });
});

describe("WS-404/405 snapshot equivalence", () => {
  it("restores filled orders and price history, then reproduces the next state hash", async () => {
    const {
      dataDir,
      db,
      ids,
      finance,
      market,
      context,
      companyId,
      founderAgentId,
      offering,
    } = fixture();
    market.processProduction(context(7, "execute"));
    const { household, accounts } = householdBuyer(finance, 500n);
    const placement = market.placeOrder({
      buyerKind: "household",
      buyerId: household.householdId,
      buyerAccountIds: accounts.map((account) => account.id),
      sellerId: companyId,
      offeringId: offering.id,
      sku: "groceries",
      quantity: 1,
      expectedUnitPriceCents: "400",
      tick: 7,
      requestEventId: ids.next("req"),
      ids,
    });
    const paymentSourceEventId = ids.next("src");
    market.settleOrder(placement.order.id, 7, ids, (request) => {
      const refreshed = accounts.map((account) => finance.accountForAgent(account.ownerId));
      const transaction = postPurchase({
        finance,
        ids,
        orderId: request.order.id,
        tick: 7,
        sellerAccountId: request.sellerAccountId,
        accounts: refreshed,
        totalCents: request.totalCents,
        sourceEventId: paymentSourceEventId,
      });
      return { transactionId: transaction.id, sourceEventId: paymentSourceEventId };
    });
    const priceDecisionId = persistPriceDecision({
      db,
      ids,
      founderAgentId,
      offeringId: offering.id,
      tick: 7,
      newPriceCents: "450",
    });
    market.applyFounderPriceOverride({
      offeringId: offering.id,
      founderAgentId,
      decisionId: priceDecisionId,
      newPriceCents: "450",
    }, context(7, "decisions"));
    db.prepare(`
      UPDATE simulation_runs SET current_tick = 7, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);

    const snapshots = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "snapshot-wall" });
    const destination = join(dataDir, "market-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advanceProduction = (target: WorldDatabase): string => {
      const checkpoint = readRunCheckpoint(target, TEST_RUN_ID);
      const restoredIds = IdFactory.restore(checkpoint.idState);
      const targetMarket = new SqliteMarketStore(target, TEST_RUN_ID);
      let emitted = 0;
      const tickContext: TickContext = {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        tick: 8,
        simDate: "Y0001-M01-D09",
        phase: "execute",
        ids: restoredIds,
        rng: (key) => Rng.root(42).fork(`8.execute.${key}`),
        count: () => undefined,
        setDigestIndicators: () => undefined,
        emit: () => ({
          eventId: `evt_market_equiv_${String(++emitted).padStart(2, "0")}`,
        }) as EventEnvelope,
      };
      expect(targetMarket.processProduction(tickContext)).toHaveLength(1);
      target.prepare(`
        UPDATE simulation_runs SET current_tick = 8, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(restoredIds.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(target, TEST_RUN_ID);
    };

    const straightHash = advanceProduction(db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteMarketStore(restored, TEST_RUN_ID).getOrder(placement.order.id).status)
      .toBe("filled");
    expect(new SqliteMarketStore(restored, TEST_RUN_ID).listPriceHistory(offering.id))
      .toEqual(market.listPriceHistory(offering.id));
    const restoredHash = advanceProduction(restored);
    expect(restoredHash).toBe(straightHash);
    expect(new SqliteMarketStore(restored, TEST_RUN_ID).getInventory(companyId, "groceries"))
      .toEqual(market.getInventory(companyId, "groceries"));
  });
});
