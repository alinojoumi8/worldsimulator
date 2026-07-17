import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplayRun } from "@worldtangle/shared";
import {
  checkInvariants,
  evaluateRiverbendBaseline,
} from "@worldtangle/engine";
import { SimulationService } from "./simulation-service";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteEventStore,
  SqliteFinanceStore,
  SqliteRunRepository,
  SqliteSnapshotStore,
  type WorldDatabase,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";
import { readRiverbendBaselineObservation } from "./testing/scenario-regression-probe";

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

function scalarCount(db: WorldDatabase, runId: string, sql: string): bigint {
  return db.prepare<[string], { count: bigint }>(sql).get(runId)?.count ?? 0n;
}

async function runDefaultScenario() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-scenario-regression-"));
  directories.push(dataDir);
  const service = new SimulationService({
    dataDir,
    wallClock: () => "2026-07-16T00:00:00.000Z",
    snapshotIntervalTicks: 120,
    tickIntervalMs: 60_000,
  });
  services.push(service);
  const created = service.createSimulation({
    name: "ws-710-seed-42-baseline",
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      llmMode: "mock",
      budgets: { runCostCentsMax: "50000", perAgentDailyTokens: 2_000 },
      policyOverrides: {},
      endTick: 360,
    },
  }, "ws710-create");
  const simulationId = created.simulation.id;
  const runId = created.run.id;
  service.controlSimulation(simulationId, "start", { runId }, "ws710-start");
  service.controlSimulation(simulationId, "pause", { runId }, "ws710-pause");
  let remaining = 360;
  while (remaining > 0) {
    const ticks = Math.min(50, remaining);
    const result = await service.advanceSimulation(
      simulationId,
      { runId, ticks },
      `ws710-advance-${360 - remaining + ticks}`,
    );
    expect(result.statusCode).toBe(200);
    remaining -= ticks;
  }
  return { dataDir, service, simulationId, runId };
}

async function waitForReplay(
  service: SimulationService,
  simulationId: string,
  runId: string,
): Promise<ReplayRun> {
  const deadline = performance.now() + 900_000;
  while (performance.now() < deadline) {
    const status = service.getStatus(simulationId, runId) as { replay: ReplayRun | null };
    if (status.replay !== null && status.replay.status !== "running") return status.replay;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("WS-710 strict replay did not become terminal");
}

describe("WS-709 default-scenario regression", () => {
  it("keeps the seed-42 mock world inside every envelope and replays deterministically", async () => {
    const first = await runDefaultScenario();
    const { dataDir, simulationId, runId } = first;
    let firstStateHash = "";
    let firstEventHash = "";

    const db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      expect(new SqliteRunRepository(db).getRun(runId)).toMatchObject({
        currentTick: 360,
        status: "completed",
      });
      const observation = readRiverbendBaselineObservation(db, runId);
      const report = evaluateRiverbendBaseline(observation);
      expect(report.passed, JSON.stringify({
        violations: report.violations,
        metrics: report.metrics,
      })).toBe(true);
      expect(report.metrics).toMatchObject({
        businessFailures: 0,
        newCompanies: 3,
        loanDefaults: 0,
        benefitSuspensionTicks: 0,
        m1AttributionRateBp: 10_000,
      });
      expect(report.metrics.unemploymentRateBp).toMatchObject({
        pointCount: 361,
        minimum: { valueInteger: "390" },
        maximum: { valueInteger: "649" },
      });
      expect(report.metrics.cpiIndex.pointCount).toBe(361);
      expect(Number(report.metrics.cpiIndex.minimum?.valueInteger)).toBeGreaterThanOrEqual(950);
      expect(Number(report.metrics.cpiIndex.maximum?.valueInteger)).toBeLessThanOrEqual(1_120);
      expect(report.metrics.treasuryBalanceCents.minimum?.valueInteger).toBe("18000000");
      expect(new Set(observation.newCompanyIds).size).toBe(3);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM companies
        WHERE run_id = ? AND founded_tick > 0 AND status = 'active'
      `)).toBe(3n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count
        FROM events formation
        JOIN events goal
          ON goal.run_id = formation.run_id
          AND goal.event_id = formation.causation_id
          AND goal.type = 'agent.goal.achieved'
        WHERE formation.run_id = ?
          AND formation.type = 'company.formation.requested'
      `)).toBe(3n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM events
        WHERE run_id = ? AND type = 'company.activated'
      `)).toBe(3n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM events
        WHERE run_id = ? AND type = 'company.formation.deferred'
      `)).toBe(1n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM events
        WHERE run_id = ? AND type = 'company.launch.completed'
      `)).toBe(2n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM jobs
        WHERE run_id = ? AND title = 'Founding operations associate' AND filled_count = 1
      `)).toBe(2n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM market_offerings o
        JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
        WHERE o.run_id = ? AND c.founded_tick > 0 AND o.active = 1
      `)).toBe(2n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM production_runs p
        JOIN companies c ON c.run_id = p.run_id AND c.id = p.company_id
        WHERE p.run_id = ? AND c.founded_tick > 0
      `)).toBeGreaterThan(0n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(DISTINCT c.id) AS count
        FROM companies c
        JOIN loan_applications a
          ON a.run_id = c.run_id AND a.applicant_kind = 'company' AND a.applicant_id = c.id
        JOIN loans l ON l.run_id = a.run_id AND l.application_id = a.id
        JOIN production_runs p ON p.run_id = c.run_id AND p.company_id = c.id
        WHERE c.run_id = ? AND c.status = 'active'
      `)).toBeGreaterThan(0n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM company_timeline t
        JOIN companies c ON c.run_id = t.run_id AND c.id = t.company_id
        WHERE t.run_id = ? AND c.founded_tick > 0
          AND t.event_type IN (
            'company.launch.completed', 'loan.application.created',
            'loan.approved', 'loan.disbursed'
          )
      `)).toBeGreaterThanOrEqual(4n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count FROM news_stories
        WHERE run_id = ? AND status = 'published'
      `)).toBeGreaterThanOrEqual(12n);
      expect(scalarCount(db, runId, `
        SELECT COUNT(*) AS count
        FROM news_story_citations citation
        LEFT JOIN events event
          ON event.run_id = citation.run_id AND event.event_id = citation.event_id
        WHERE citation.run_id = ? AND event.event_id IS NULL
      `)).toBe(0n);
      expect(new SqliteFinanceStore(db, runId).reconcile()).toEqual([]);
      const invariants = checkInvariants(readRunInvariantSnapshot(db, runId));
      expect(invariants.passed, JSON.stringify(invariants.violations)).toBe(true);
      expect(new SqliteSnapshotStore(db, dataDir, simulationId, runId)
        .list().map((snapshot) => snapshot.tick)).toEqual([360, 240, 120]);
      firstStateHash = computeLogicalStateHash(db, runId);
      firstEventHash = new SqliteEventStore(db, runId).logHash();
      expect(firstStateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(firstEventHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }

    const accepted = first.service.replaySimulation(
      simulationId,
      runId,
      { mode: "strict" },
      "ws710-strict-replay",
    );
    const replay = await waitForReplay(
      first.service,
      simulationId,
      accepted.replayRun.id,
    );
    expect(replay, JSON.stringify(replay)).toMatchObject({
      status: "completed",
      currentTick: 360,
      divergenceCount: 0,
      sourceStateHash: firstStateHash,
      replayStateHash: firstStateHash,
    });

    const second = await runDefaultScenario();
    const secondDb = openWorldDatabase(
      second.dataDir,
      second.simulationId,
      second.runId,
    );
    try {
      expect(computeLogicalStateHash(secondDb, second.runId)).toBe(firstStateHash);
      expect(new SqliteEventStore(secondDb, second.runId).logHash()).toBe(firstEventHash);
    } finally {
      secondDb.close();
    }
  }, 1_800_000);
});
