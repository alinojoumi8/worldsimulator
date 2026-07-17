import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { auditM1Attribution, checkInvariants } from "@worldtangle/engine";
import { SimulationService } from "./simulation-service";
import {
  openWorldDatabase,
  SqliteFinanceStore,
  SqliteRunRepository,
  SqliteSnapshotStore,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";
import { readRunM1AttributionInput } from "./testing/m1-attribution-probe";

const directories: string[] = [];
const services: SimulationService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("Phase 3 release gate", () => {
  it("completes a 360-day economy with balanced books and zero active invariant violations", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-phase3-gate-"));
    directories.push(dataDir);
    const service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      snapshotIntervalTicks: 120,
      tickIntervalMs: 60_000,
      // This historical phase gate isolates finance; Phase 4 owns the complete news/sentiment run.
      enableNewsPipeline: false,
    });
    services.push(service);
    const created = service.createSimulation({
      name: "phase-3-360-day-gate",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 309,
        llmMode: "off",
        budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
        policyOverrides: {},
        endTick: 360,
      },
    }, "phase3-gate-create");
    const simulationId = created.simulation.id;
    const runId = created.run.id;
    service.controlSimulation(simulationId, "start", { runId }, "phase3-gate-start");
    service.controlSimulation(simulationId, "pause", { runId }, "phase3-gate-pause");
    let remaining = 360;
    while (remaining > 0) {
      const ticks = Math.min(50, remaining);
      const result = await service.advanceSimulation(
        simulationId,
        { runId, ticks },
        `phase3-gate-advance-${360 - remaining + ticks}`,
      );
      expect(result.statusCode).toBe(200);
      remaining -= ticks;
      await yieldToEventLoop();
    }
    service.close();

    const db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      const run = new SqliteRunRepository(db).getRun(runId);
      expect(run).toMatchObject({ currentTick: 360, status: "completed" });
      const finance = new SqliteFinanceStore(db, runId);
      expect(finance.reconcile()).toEqual([]);
      expect(finance.auditConservation()).toEqual([]);
      const m1Attribution = auditM1Attribution(readRunM1AttributionInput(db, runId));
      expect(m1Attribution.complete, JSON.stringify(m1Attribution.issues)).toBe(true);
      expect(m1Attribution).toMatchObject({
        throughTick: 360,
        attributionRateBp: 10_000,
        ticksAudited: 361,
        unattributedM1DeltaCents: "0",
        grossUnattributedM1ChangeCents: "0",
      });
      expect(m1Attribution.transactionsAudited).toBeGreaterThan(0);
      expect(m1Attribution.transactionEventsAudited)
        .toBe(m1Attribution.transactionsAudited);
      expect(m1Attribution.eventedMaterialSupplyTransactions)
        .toBe(m1Attribution.materialSupplyTransactions);
      expect(BigInt(m1Attribution.channelTotalsCents.mint)).toBeGreaterThan(0n);
      expect(BigInt(m1Attribution.channelTotalsCents.row)).not.toBe(0n);
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count
        FROM ledger_transactions t
        LEFT JOIN events e
          ON e.run_id = t.run_id AND e.event_id = t.source_event_id
        WHERE t.run_id = ? AND (t.source_event_id IS NULL OR e.event_id IS NULL)
      `).get(runId)?.count).toBe(0n);
      const indicators = finance.latestIndicators();
      expect(m1Attribution.finalM1Cents).toBe(indicators.m1_cents);
      expect(m1Attribution.finalTreasuryBalanceCents)
        .toBe(indicators.treasury_balance_cents);
      expect(BigInt(indicators.m1_cents)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(indicators.treasury_balance_cents)).toBeGreaterThanOrEqual(0n);
      const unemploymentRateBp = Number(indicators.unemployment_rate_bp);
      expect(unemploymentRateBp).toBeGreaterThanOrEqual(300);
      expect(unemploymentRateBp).toBeLessThanOrEqual(1_200);
      expect(finance.listIndicatorPoints({
        series: [
          "m1_cents",
          "average_wage_cents",
          "unemployment_rate_bp",
          "treasury_balance_cents",
        ],
        step: 1,
        max: 2_000,
      })).toHaveLength(1_444);
      const report = checkInvariants(readRunInvariantSnapshot(db, runId));
      expect(report.passed, JSON.stringify(report.violations)).toBe(true);
      expect(report.active).toEqual([
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
      expect(db.prepare<[string], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM events
        WHERE run_id = ? AND type = 'simulation.tick.completed'
      `).get(runId)?.count).toBe(360n);
      expect(new SqliteSnapshotStore(db, dataDir, simulationId, runId)
        .list().map((snapshot) => snapshot.tick)).toEqual([360, 240, 120]);
    } finally {
      db.close();
    }
  }, 600_000);
});
