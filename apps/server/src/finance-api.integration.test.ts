import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentFinancesResponseSchema,
  bankDetailResponseSchema,
  bankListResponseSchema,
  INDICATOR_KEYS,
  indicatorSeriesResponseSchema,
  transactionListResponseSchema,
} from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import { buildApp } from "./app";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteEventStore,
  SqliteFinanceStore,
  SqliteSnapshotStore,
  worldDatabasePath,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createBody = {
  name: "phase-3-riverbend",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 301,
    llmMode: "mock",
    budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
    policyOverrides: { income_tax_rate_bp: 1_800 },
    endTick: 360,
  },
};

describe("Phase 3 financial API", () => {
  it("serves balanced genesis books and executes day-15 economics atomically", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-finance-api-"));
    directories.push(dataDir);
    const app = buildApp({
      dataDir,
      webRoot: false,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      snapshotIntervalTicks: 15,
    });

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: createBody,
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    const simulationId = created.simulation.id as string;
    const runId = created.run.id as string;

    const bankResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/banks?runId=${runId}`,
    });
    const banks = bankListResponseSchema.parse(bankResponse.json());
    expect(banks.items).toHaveLength(1);
    expect(banks.items[0]).toMatchObject({
      name: "First Ledger Bank",
      totalDeposits: "528000000",
      reserveRatioBp: 1800,
      lendingHalted: false,
    });
    const bankDetail = bankDetailResponseSchema.parse((await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/banks/${banks.items[0]!.id}?runId=${runId}`,
    })).json());
    expect(bankDetail.bank).toMatchObject({
      accounts: { count: expect.any(Number) },
      loanBook: { active: 8, defaulted: 0, writtenOff: 0 },
    });

    const openingTransactionsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/transactions?runId=${runId}&kind=mint&limit=200`,
    });
    const openingTransactions = transactionListResponseSchema.parse(
      openingTransactionsResponse.json(),
    );
    expect(openingTransactions.items).toHaveLength(107);
    for (const transaction of openingTransactions.items) {
      const debits = transaction.legs
        .filter((leg) => leg.direction === "debit")
        .reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
      const credits = transaction.legs
        .filter((leg) => leg.direction === "credit")
        .reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
      expect(debits).toBe(credits);
    }

    const indicatorResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=m1,unemploymentRate,treasuryBalance`,
    });
    const genesisIndicators = indicatorSeriesResponseSchema.parse(indicatorResponse.json());
    expect(genesisIndicators.series).toEqual([
      { name: "m1", unit: "cents", points: [[0, "510000000"]] },
      { name: "unemploymentRate", unit: "bp", points: [[0, 649]] },
      { name: "treasuryBalance", unit: "cents", points: [[0, "18000000"]] },
    ]);
    const completeIndicatorResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=gdpProxy,cpi,m1,averageWage,unemploymentRate,creditOutstanding,defaultRate,businessCount,treasuryBalance,sentimentIndex`,
    });
    const completeIndicators = indicatorSeriesResponseSchema.parse(
      completeIndicatorResponse.json(),
    );
    expect(completeIndicators.series).toHaveLength(10);
    expect(completeIndicators.series.map((series) => series.name)).toEqual([
      "gdpProxy",
      "cpi",
      "m1",
      "averageWage",
      "unemploymentRate",
      "creditOutstanding",
      "defaultRate",
      "businessCount",
      "treasuryBalance",
      "sentimentIndex",
    ]);
    expect(completeIndicators.series.find((series) => series.name === "gdpProxy"))
      .toEqual({ name: "gdpProxy", unit: "cents", points: [[0, "0"]] });
    expect(completeIndicators.series.find((series) => series.name === "cpi"))
      .toEqual({ name: "cpi", unit: "index", points: [[0, 1000]] });
    expect(completeIndicators.series.find((series) => series.name === "businessCount"))
      .toEqual({ name: "businessCount", unit: "count", points: [[0, 14]] });
    expect(completeIndicators.series.find((series) => series.name === "sentimentIndex"))
      .toEqual({ name: "sentimentIndex", unit: "bp", points: [[0, 0]] });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/start`,
      payload: { runId },
    })).statusCode).toBe(202);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/pause`,
      payload: { runId },
    })).statusCode).toBe(202);
    const advance = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/advance`,
      payload: { runId, ticks: 15 },
    });
    expect(advance.statusCode).toBe(200);
    expect(advance.json()).toMatchObject({ run: { currentTick: 15 } });

    const payrollResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/transactions?runId=${runId}&kind=payroll&fromTick=15&toTick=15&limit=200`,
    });
    const payroll = transactionListResponseSchema.parse(payrollResponse.json());
    expect(payroll.items.length).toBeGreaterThan(60);
    for (const transaction of payroll.items) {
      expect(transaction.legs.length).toBeGreaterThanOrEqual(2);
      const debit = transaction.legs
        .filter((leg) => leg.direction === "debit")
        .reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
      const credit = transaction.legs
        .filter((leg) => leg.direction === "credit")
        .reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
      expect(debit).toBe(credit);
    }

    const financesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents/agt_00000001/finances?runId=${runId}`,
    });
    const finances = agentFinancesResponseSchema.parse(financesResponse.json());
    expect(finances.employment?.wage).toMatch(/^\d+$/);
    expect(BigInt(finances.income.last30Ticks.salary)).toBeGreaterThan(0n);
    expect(finances.expenses.last30Ticks.subsistence).toMatch(/^\d+$/);

    const finalIndicatorsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=m1,averageWage,unemploymentRate,treasuryBalance&fromTick=15&toTick=15`,
    });
    const finalIndicators = indicatorSeriesResponseSchema.parse(finalIndicatorsResponse.json());
    expect(finalIndicators.series.every((series) => series.points.length === 1)).toBe(true);

    const db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      const store = new SqliteFinanceStore(db, runId);
      expect(store.policyValue("personal_withholding_rate_bp", 15)).toBe(1_800n);
      expect(store.reconcile()).toEqual([]);
      expect(store.auditConservation()).toEqual([]);
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM ledger_transactions t
        LEFT JOIN events e
          ON e.run_id = t.run_id AND e.event_id = t.source_event_id
        WHERE t.run_id = ? AND (t.source_event_id IS NULL OR e.event_id IS NULL)
      `).get(runId)?.count).toBe(0n);
      expect(store.latestIndicators()).toEqual(store.recomputeIndicators(15));
      const metricEvents = new SqliteEventStore(db, runId).list().filter(
        (event) => event.type === "economic.metrics.updated",
      );
      expect(metricEvents).toHaveLength(16);
      const metricPayload = metricEvents.at(-1)?.payload as {
        rulesetVersion: number;
        indicators: Record<string, string>;
        evidence: Record<string, { formulaVersion: number; inputsDigest: string }>;
      };
      expect(metricPayload.rulesetVersion).toBe(1);
      expect(Object.keys(metricPayload.indicators).sort()).toEqual([...INDICATOR_KEYS].sort());
      expect(Object.keys(metricPayload.evidence).sort()).toEqual([...INDICATOR_KEYS].sort());
      expect(Object.values(metricPayload.evidence).every((item) => (
        item.formulaVersion === 1 && /^[0-9a-f]{64}$/.test(item.inputsDigest)
      ))).toBe(true);
      expect(store.accountBalance(store.systemAccount(
        "government",
        "inst_town_riverbend",
      ).id)).toBeGreaterThanOrEqual(0n);
      const invariantReport = checkInvariants(readRunInvariantSnapshot(db, runId));
      expect(invariantReport.active).toEqual([
        "INV-1",
        "INV-2",
        "INV-3",
        "INV-4",
        "INV-5",
        "INV-6",
        "INV-8",
        "INV-9",
        "INV-10",
      ]);
      expect(invariantReport.passed).toBe(true);
      const snapshotStore = new SqliteSnapshotStore(db, dataDir, simulationId, runId);
      const snapshot = snapshotStore.getAtTick(15);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.stateHash).toBe(computeLogicalStateHash(db, runId));
      const restoredPath = join(dataDir, "restored-phase3.db");
      snapshotStore.restoreTo(snapshot!.id, restoredPath);
      const restored = openDatabaseFile(restoredPath);
      try {
        expect(computeLogicalStateHash(restored, runId)).toBe(snapshot!.stateHash);
        expect(new SqliteFinanceStore(restored, runId).reconcile()).toEqual([]);
        expect(new SqliteFinanceStore(restored, runId).auditConservation()).toEqual([]);
        const indicatorQuery = `
          SELECT tick, indicator_key, value_integer, formula_version, inputs_digest
          FROM indicator_points WHERE run_id = ? ORDER BY tick, indicator_key
        `;
        const liveIndicators = db.prepare<[string]>(indicatorQuery).all(runId);
        const restoredIndicators = restored.prepare<[string]>(indicatorQuery).all(runId);
        expect(restoredIndicators).toEqual(liveIndicators);
        expect(restoredIndicators).toHaveLength(160);
        expect(restoredIndicators.every((row) => (
          (row as { formula_version: bigint }).formula_version === 1n &&
          /^[0-9a-f]{64}$/.test((row as { inputs_digest: string }).inputs_digest)
        ))).toBe(true);
      } finally {
        restored.close();
      }
    } finally {
      db.close();
    }
    expect(worldDatabasePath(dataDir, simulationId, runId)).toContain(runId);
    await app.close();
  }, 30_000);
});
