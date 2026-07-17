import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdFactory,
  canonicalStringify,
  companyDetailResponseSchema,
  jobDetailResponseSchema,
} from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import { SimulationService } from "./simulation-service";
import {
  openWorldDatabase,
  SqliteEnergyStore,
  SqliteFinanceStore,
  SqliteMarketStore,
  SqlitePhase4ReadStore,
  SqlitePhase4Store,
  SqliteRunRepository,
  SqliteSnapshotStore,
  SqliteWorldEventStore,
  type WorldDatabase,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";
import { readRunCheckpoint } from "./persistence/tick-committer";

const directories: string[] = [];

function withPhase4Mutation<T>(
  dataDir: string,
  simulationId: string,
  runId: string,
  mutate: (db: WorldDatabase, store: SqlitePhase4Store, ids: IdFactory) => T,
): T {
  const db = openWorldDatabase(dataDir, simulationId, runId);
  try {
    return db.transaction(() => {
      const ids = IdFactory.restore(readRunCheckpoint(db, runId).idState);
      const result = mutate(db, new SqlitePhase4Store(db, runId), ids);
      db.prepare(`
        UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), runId);
      return result;
    })();
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Phase 4 release gate", () => {
  it("explains a 360-tick company economy, energy shock, and wind-down", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-phase4-gate-"));
    directories.push(dataDir);
    let service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      snapshotIntervalTicks: 120,
      tickIntervalMs: 60_000,
    });
    const created = service.createSimulation({
      name: "phase-4-formation-labor-gate",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 403,
        llmMode: "off",
        budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
        policyOverrides: {},
        endTick: 360,
      },
    }, "phase4-gate-create");
    const simulationId = created.simulation.id;
    const runId = created.run.id;
    service.close();

    const { companyId, fragileCompanyId } = withPhase4Mutation(
      dataDir,
      simulationId,
      runId,
      (db, store, ids) => {
      const finance = new SqliteFinanceStore(db, runId);
      const lawFirmAccount = finance.listAccounts().find((account) => (
        account.ownerKind === "company" && account.type === "checking"
      ));
      if (lawFirmAccount === undefined) throw new Error("Riverbend law-firm account is missing");
      const formation = store.requestCompanyFormation({
        name: "Threadline Services",
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
      const fragileFormation = store.requestCompanyFormation({
        name: "Candlewick Dispatch",
        sector: "logistics",
        founderAgentId: "agt_00000002",
        jurisdiction: "Riverbend",
        foundingCapitalCents: "1",
        totalShares: "1000",
        lawFirmAccountId: lawFirmAccount.id,
        incorporationFeeCents: "10000",
        tick: 0,
        ids,
      });
      for (const party of fragileFormation.contract.parties) {
        store.signContract(
          fragileFormation.contract.id,
          { kind: party.kind, id: party.id },
          0,
          ids,
        );
      }
      return {
        companyId: formation.company.id,
        fragileCompanyId: fragileFormation.company.id,
      };
    },
    );

    service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      snapshotIntervalTicks: 120,
      tickIntervalMs: 60_000,
    });
    service.controlSimulation(simulationId, "start", { runId }, "phase4-gate-start");
    service.controlSimulation(simulationId, "pause", { runId }, "phase4-gate-pause");
    expect((await service.advanceSimulation(
      simulationId,
      { runId, ticks: 5 },
      "phase4-gate-formation",
    )).statusCode).toBe(200);
    service.close();

    const { jobId, expectedAgentId, offeringId, fragileJobId, fragileWorkerId } = withPhase4Mutation(
      dataDir,
      simulationId,
      runId,
      (db, store, ids) => {
        expect(store.getCompany(companyId)).toMatchObject({
          status: "active",
          formationStage: "active",
          activatedTick: 5,
        });
        expect(store.getCompany(fragileCompanyId)).toMatchObject({
          status: "active",
          formationStage: "active",
          activatedTick: 5,
        });
        const job = store.postJob({
          employerId: companyId,
          occupationCode: "bookkeeper",
          title: "Bookkeeper",
          annualWageCents: "3000000",
          requirements: [],
          openings: 1,
          tick: 6,
          ids,
        });
        const candidates = db.prepare<[string], { id: string }>(`
          SELECT id FROM agents
          WHERE run_id = ? AND employment_status != 'employed'
          ORDER BY id LIMIT 3
        `).all(runId).map((row) => row.id);
        expect(candidates).toHaveLength(3);
        for (const agentId of [candidates[1]!, candidates[0]!]) {
          store.submitJobApplication({
            jobId: job.id,
            agentId,
            reservationWageCents: "2500000",
            tick: 6,
            ids,
          });
        }
        const fragileJob = store.postJob({
          employerId: fragileCompanyId,
          occupationCode: "dispatcher",
          title: "Overextended dispatcher",
          annualWageCents: "36000000",
          requirements: [],
          openings: 1,
          tick: 6,
          ids,
        });
        store.submitJobApplication({
          jobId: fragileJob.id,
          agentId: candidates[2]!,
          reservationWageCents: "2500000",
          tick: 6,
          ids,
        });
        const offering = new SqliteMarketStore(db, runId).createProductionOffering({
          companyId,
          sku: "groceries",
          postedPriceCents: "400",
          unitCostCents: "300",
          laborHoursPerWorker: 8,
          productivityMilliunitsPerLaborHour: 25_000,
          capacityUnitsPerTick: 200,
          tick: 6,
          ids,
        });
        return {
          jobId: job.id,
          expectedAgentId: candidates[0]!,
          offeringId: offering.offering.id,
          fragileJobId: fragileJob.id,
          fragileWorkerId: candidates[2]!,
        };
      },
    );

    service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      snapshotIntervalTicks: 120,
      tickIntervalMs: 60_000,
    });
    const injected = service.injectWorldEvent(simulationId, {
      runId,
      type: "energy.fuel_price_shock",
      params: { deltaPct: 100 },
      scheduleTick: 8,
    }, "phase4-gate-energy-shock");
    let remaining = 355;
    while (remaining > 0) {
      const ticks = Math.min(50, remaining);
      const result = await service.advanceSimulation(
        simulationId,
        { runId, ticks },
        `phase4-gate-advance-${360 - remaining + ticks}`,
      );
      expect(result.statusCode).toBe(200);
      remaining -= ticks;
    }
    service.close();

    const db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      expect(new SqliteRunRepository(db).getRun(runId)).toMatchObject({
        currentTick: 360,
        status: "completed",
      });
      expect(new SqlitePhase4Store(db, runId).getCompany(companyId)).toMatchObject({
        status: "active",
        formationStage: "active",
      });
      expect(new SqlitePhase4Store(db, runId).getCompany(fragileCompanyId)).toMatchObject({
        status: "closed",
        failureReason: "sustained_cash_shortfall",
      });
      expect(db.prepare<[string, string], { status: string; filled_count: bigint }>(`
        SELECT status, filled_count FROM jobs WHERE run_id = ? AND id = ?
      `).get(runId, jobId)).toEqual({ status: "filled", filled_count: 1n });
      const employment = db.prepare<[string, string, string], {
        employee_agent_id: string;
        legal_status: string;
        unsigned_parties: bigint;
      }>(`
        SELECT ec.employee_agent_id, lc.status AS legal_status,
          SUM(CASE WHEN lp.signed_tick IS NULL THEN 1 ELSE 0 END) AS unsigned_parties
        FROM employment_contracts ec
        JOIN legal_contracts lc
          ON lc.run_id = ec.run_id AND lc.id = ec.legal_contract_id
        JOIN legal_contract_parties lp
          ON lp.run_id = lc.run_id AND lp.contract_id = lc.id
        WHERE ec.run_id = ? AND ec.employer_id = ? AND ec.employee_agent_id = ?
        GROUP BY ec.id, lc.id
      `).get(runId, companyId, expectedAgentId);
      expect(employment).toEqual({
        employee_agent_id: expectedAgentId,
        legal_status: "active",
        unsigned_parties: 0n,
      });
      expect(db.prepare<[string, string], { status: string }>(`
        SELECT status FROM jobs WHERE run_id = ? AND id = ?
      `).get(runId, fragileJobId)?.status).toBe("filled");
      const fragileWorkerStatus = db.prepare<[string, string], { employment_status: string }>(`
        SELECT employment_status FROM agents WHERE run_id = ? AND id = ?
      `).get(runId, fragileWorkerId)?.employment_status;
      expect(["employed", "unemployed"]).toContain(fragileWorkerStatus);
      expect(db.prepare<[string, string, string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM employment_contracts ec
        JOIN legal_contracts lc
          ON lc.run_id = ec.run_id AND lc.id = ec.legal_contract_id
        WHERE ec.run_id = ? AND ec.employer_id = ? AND ec.employee_agent_id = ?
          AND lc.status = 'active'
      `).get(runId, fragileCompanyId, fragileWorkerId)?.count).toBe(0n);
      if (fragileWorkerStatus === "employed") {
        expect(db.prepare<[string, string, string], { count: bigint }>(`
          SELECT COUNT(*) AS count
          FROM employment_contracts ec
          JOIN legal_contracts lc
            ON lc.run_id = ec.run_id AND lc.id = ec.legal_contract_id
          WHERE ec.run_id = ? AND ec.employee_agent_id = ? AND ec.employer_id != ?
            AND lc.status = 'active'
        `).get(runId, fragileWorkerId, fragileCompanyId)?.count).toBe(1n);
      }
      const market = new SqliteMarketStore(db, runId);
      const productionRuns = market.listProductionRuns();
      expect(productionRuns.length).toBeGreaterThan(0);
      expect(productionRuns.every((production) => BigInt(production.unitCostCents) >= 350n))
        .toBe(true);
      expect(market.listOrders().some((order) => (
        order.offeringId === offeringId && order.status === "filled"
      ))).toBe(true);
      expect(market.listStockouts().some((stockout) => stockout.offeringId === offeringId))
        .toBe(true);
      expect(market.getInventory(companyId, "groceries").quantity).toBeGreaterThanOrEqual(0);
      const priceHistory = market.listPriceHistory(offeringId);
      expect(priceHistory.length).toBeGreaterThan(0);
      expect(priceHistory.every((entry) => (
        entry.source === "rule" &&
        entry.decisionId === null &&
        entry.tick > 6 &&
        (entry.tick - 6) % 7 === 0 &&
        BigInt(entry.newPriceCents) >= BigInt(entry.unitCostCents) &&
        BigInt(entry.newPriceCents) * 2n <= BigInt(entry.unitCostCents) * 3n
      ))).toBe(true);
      expect(market.listActiveOfferings("groceries", 31)[0]?.offering.postedPriceCents)
        .toBe(priceHistory.at(-1)?.newPriceCents);
      const energy = new SqliteEnergyStore(db, runId);
      expect(energy.system()).toMatchObject({
        utilityId: "inst_riverbend_power",
        billingIntervalTicks: 30,
        passThroughBp: 6_000,
      });
      expect(BigInt(energy.tariff("household", 30).priceCents)).toBeGreaterThan(15_000n);
      expect(BigInt(energy.tariff("business", 30).priceCents)).toBeGreaterThan(50n);
      expect(energy.listFuelPrices()).toHaveLength(2);
      const energyBills = energy.listBills();
      expect(energyBills.some((bill) => (
        bill.customerClass === "business" &&
        bill.customerId === companyId &&
        bill.evidenceRefs.some((reference) => reference.startsWith("prod_"))
      ))).toBe(true);
      expect(energyBills.some((bill) => bill.customerClass === "household" && bill.tick === 30))
        .toBe(true);
      expect(energy.listFuelPurchases().length).toBeGreaterThan(0);
      expect(new SqliteWorldEventStore(db, runId).get(injected.worldEvent.id)).toMatchObject({
        status: "applied",
        appliedTick: 8,
      });
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM energy_bills b
        JOIN events e ON e.run_id = b.run_id AND e.event_id = b.source_event_id
        LEFT JOIN ledger_transactions t
          ON t.run_id = b.run_id AND t.id = b.transaction_id
        WHERE b.run_id = ? AND e.type IN ('energy.bill.posted', 'energy.bill.rejected')
          AND (
            (b.status = 'paid' AND t.kind = 'purchase')
            OR (b.status = 'rejected' AND t.id IS NULL)
          )
      `).get(runId)?.count).toBe(BigInt(energyBills.length));
      expect(db.prepare<[string, string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM goods_orders o
        JOIN ledger_transactions t
          ON t.run_id = o.run_id AND t.id = o.settlement_transaction_id
        JOIN inventory_movements m
          ON m.run_id = o.run_id AND m.source_ref = o.id AND m.kind = 'sale'
        WHERE o.run_id = ? AND o.offering_id = ? AND o.status = 'filled'
          AND t.kind = 'purchase' AND m.quantity_delta = -o.filled_quantity
      `).get(runId, offeringId)?.count).toBeGreaterThan(0n);
      expect(new SqliteFinanceStore(db, runId).reconcile()).toEqual([]);
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM ledger_transactions t
        LEFT JOIN events e
          ON e.run_id = t.run_id AND e.event_id = t.source_event_id
        WHERE t.run_id = ? AND (t.source_event_id IS NULL OR e.event_id IS NULL)
      `).get(runId)?.count).toBe(0n);
      expect(db.prepare<[string, string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM market_price_history h
        JOIN events e ON e.run_id = h.run_id AND e.event_id = h.source_event_id
        WHERE h.run_id = ? AND h.offering_id = ? AND e.type = 'market.price.updated'
      `).get(runId, offeringId)?.count).toBe(BigInt(priceHistory.length));
      const readStore = new SqlitePhase4ReadStore(db, runId);
      const activeView = companyDetailResponseSchema.parse({
        ...readStore.getCompany(companyId),
        meta: { simulated: true, apiVersion: 1 },
      });
      expect(activeView.timeline.map((item) => item.type)).toEqual(expect.arrayContaining([
        "company.activated",
        "employment.created",
        "production.started",
        "market.price.updated",
      ]));
      const failedView = companyDetailResponseSchema.parse({
        ...readStore.getCompany(fragileCompanyId),
        meta: { simulated: true, apiVersion: 1 },
      });
      expect(failedView).toMatchObject({
        company: { status: "closed", failureReason: "sustained_cash_shortfall" },
        solvency: { insolvent: true, consecutiveShortfallDays: 30 },
        windDown: { employeesTerminated: 1 },
      });
      expect(failedView.timeline.map((item) => item.type)).toEqual(expect.arrayContaining([
        "company.insolvency.detected",
        "company.wind_down.started",
        "employment.terminated",
        "company.failed",
      ]));
      const failedJobView = jobDetailResponseSchema.parse({
        ...readStore.getJob(fragileJobId),
        meta: { simulated: true, apiVersion: 1 },
      });
      expect(failedJobView.employmentContracts).toMatchObject([{ status: "ended" }]);
      const report = checkInvariants(readRunInvariantSnapshot(db, runId));
      expect(report.passed, JSON.stringify(report.violations)).toBe(true);
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM events
        WHERE run_id = ? AND type IN (
          'company.incorporation_fee.requested',
          'company.capital.deposit.requested',
          'company.activated',
          'employment.created',
          'production.completed',
          'market.order.filled',
          'market.stockout',
          'market.price.updated',
          'energy.bill.posted',
          'energy.fuel.purchased'
        )
      `).get(runId)?.count).toBeGreaterThan(4n);
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM news_stories
        WHERE run_id = ? AND status = 'published'
      `).get(runId)?.count).toBeGreaterThanOrEqual(12n);
      expect(new SqliteSnapshotStore(db, dataDir, simulationId, runId)
        .list().map((snapshot) => snapshot.tick)).toEqual([360, 240, 120]);
    } finally {
      db.close();
    }
  }, 240_000);
});
