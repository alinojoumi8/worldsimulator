import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateSimulationRequest } from "@worldtangle/shared";
import { openWorldDatabase } from "./persistence/database";
import { SqliteScheduler } from "./persistence/scheduler";
import { readRunCheckpoint } from "./persistence/tick-committer";
import { RegisteredScheduledTaskDispatcher } from "./scheduler-phase";
import { SimulationService } from "./simulation-service";

const temporaryDirectories: string[] = [];
const services: SimulationService[] = [];

const createRequest: CreateSimulationRequest = {
  name: "scheduler-integration",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: {},
    endTick: 360,
  },
};

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SimulationService scheduled obligations", () => {
  it("fires a due task through the injected dispatcher during advance", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-service-scheduler-"));
    temporaryDirectories.push(dataDir);
    const dispatched: string[] = [];
    const dispatcher = new RegisteredScheduledTaskDispatcher([
      [
        "test.service.effect",
        (task, ctx) => {
          dispatched.push(task.id);
          ctx.emit("scheduler.task.fired", { taskId: task.id });
        },
      ],
    ]);
    const service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-14T12:00:00.000Z",
      tickIntervalMs: 60_000,
      enableAgentFramework: false,
      scheduledTaskDispatcher: dispatcher,
    });
    services.push(service);

    service.createSimulation(createRequest, "request-create");
    service.controlSimulation("sim_00000001", "start", {}, "request-start");
    service.controlSimulation("sim_00000001", "pause", {}, "request-pause");

    let db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    new SqliteScheduler(db, "run_00000001").schedule({
      id: "task_00000001",
      dueTick: 1,
      order: 0,
      taskRef: "test.service.effect",
      payload: { source: "integration" },
    });
    db.close();

    const result = await service.advanceSimulation(
      "sim_00000001",
      { ticks: 1 },
      "request-advance",
    );
    expect(result.statusCode).toBe(200);
    if (!("run" in result.body)) throw new Error("expected synchronous advance result");
    expect(result.body.run.currentTick).toBe(1);
    expect(dispatched).toEqual(["task_00000001"]);

    db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    expect(new SqliteScheduler(db, "run_00000001").listPending()).toEqual([]);
    expect(readRunCheckpoint(db, "run_00000001").currentTick).toBe(1);
    const event = db.prepare<[], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM events WHERE type = 'scheduler.task.fired'
    `).get()!;
    expect(event.count).toBe(1n);
    db.close();
  });
});
