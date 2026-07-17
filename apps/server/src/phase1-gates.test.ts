import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { CreateSimulationRequest } from "@worldtangle/shared";
import { createLogger } from "./logger";
import { openWorldDatabase } from "./persistence/database";
import { SqliteScheduler } from "./persistence/scheduler";
import { RegisteredScheduledTaskDispatcher } from "./scheduler-phase";
import { SimulationService } from "./simulation-service";

const temporaryDirectories: string[] = [];
const services: SimulationService[] = [];

const createRequest: CreateSimulationRequest = {
  name: "phase-one-gate",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: {},
    endTick: 3,
  },
};

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-phase1-gate-"));
  temporaryDirectories.push(path);
  return path;
}

function capturedLogger(): {
  logger: Logger;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  return {
    logger: createLogger({
      destination: { write: (message: string) => chunks.push(message) },
    }),
    lines: () =>
      chunks
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function waitForStatus(
  service: SimulationService,
  expected: "paused" | "completed",
): Promise<ReturnType<SimulationService["getStatus"]>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = service.getStatus("sim_00000001");
    if (status.run.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run did not reach ${expected}`);
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Phase 1 lifecycle and crash gates", () => {
  it("rolls back a failed automatic tick, pauses the run, and records full error context", async () => {
    const dataDir = temporaryDirectory();
    const capture = capturedLogger();
    const dispatcher = new RegisteredScheduledTaskDispatcher([
      [
        "test.crash",
        () => {
          throw new Error("injected phase crash");
        },
      ],
    ]);
    const service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      tickIntervalMs: 1,
      enableAgentFramework: false,
      logger: capture.logger,
      scheduledTaskDispatcher: dispatcher,
    });
    services.push(service);
    service.createSimulation(createRequest, "request-create");

    const db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    new SqliteScheduler(db, "run_00000001").schedule({
      id: "task_00000001",
      dueTick: 1,
      order: 0,
      taskRef: "test.crash",
      payload: {},
    });
    db.close();

    service.controlSimulation("sim_00000001", "start", {}, "request-start");
    const status = await waitForStatus(service, "paused");
    expect(status.run).toMatchObject({ status: "paused", currentTick: 0 });

    const reopened = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    expect(new SqliteScheduler(reopened, "run_00000001").listPending()).toHaveLength(1);
    const errorRow = reopened.prepare<[], { type: string; tick: bigint; payload_canonical: string }>(`
      SELECT type, tick, payload_canonical
      FROM events
      WHERE run_id = 'run_00000001' AND type = 'system.error.raised'
    `).get();
    reopened.close();
    expect(errorRow).toBeDefined();
    expect(errorRow?.tick).toBe(0n);
    expect(errorRow?.payload_canonical).toContain("injected phase crash");
    expect(errorRow?.payload_canonical).toContain("simulation.loop");

    const failureLog = capture.lines().find(
      (line) => line["event"] === "simulation.background.failed",
    );
    expect(failureLog).toMatchObject({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      tick: 0,
      correlationId: expect.stringMatching(/^run_00000001:failure:/),
      code: "INTERNAL",
    });
  });

  it("recovers a running run after process-style timer loss and completes exactly once", async () => {
    const dataDir = temporaryDirectory();
    const first = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      tickIntervalMs: 60_000,
      enableAgentFramework: false,
    });
    services.push(first);
    first.createSimulation(createRequest, "request-create");
    first.controlSimulation("sim_00000001", "start", {}, "request-start");
    first.close();

    const capture = capturedLogger();
    const recovered = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:01.000Z",
      tickIntervalMs: 1,
      enableAgentFramework: false,
      logger: capture.logger,
    });
    services.push(recovered);
    const status = await waitForStatus(recovered, "completed");
    expect(status.run).toMatchObject({ status: "completed", currentTick: 3, endTick: 3 });

    const db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    const counts = db.prepare<[], { completed: bigint; ticks: bigint }>(`
      SELECT
        SUM(CASE WHEN type = 'simulation.completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN type = 'simulation.tick.completed' THEN 1 ELSE 0 END) AS ticks
      FROM events WHERE run_id = 'run_00000001'
    `).get()!;
    db.close();
    expect(counts).toEqual({ completed: 1n, ticks: 3n });

    expect(
      capture.lines().find((line) => line["event"] === "simulation.lifecycle.recovered"),
    ).toMatchObject({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      tick: 0,
      correlationId: "run_00000001:startup_recovery",
      status: "running",
    });
  });
});
