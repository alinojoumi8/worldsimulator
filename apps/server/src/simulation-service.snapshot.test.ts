import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdFactory } from "@worldtangle/shared";
import type { CreateSimulationRequest } from "@worldtangle/shared";
import { EventBus, SimLoop } from "@worldtangle/engine";
import {
  openWorldDatabase,
  readRunCheckpoint,
  SqliteEventStore,
  SqliteSnapshotStore,
  SqliteTickCommitter,
} from "./persistence";
import { SimulationService } from "./simulation-service";

const temporaryDirectories: string[] = [];
const services: SimulationService[] = [];

const createRequest: CreateSimulationRequest = {
  name: "snapshot-integration",
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

function createService(snapshotIntervalTicks: number): {
  dataDir: string;
  service: SimulationService;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-service-snapshot-"));
  temporaryDirectories.push(dataDir);
  const service = new SimulationService({
    dataDir,
    wallClock: () => "2026-07-14T12:00:00.000Z",
    tickIntervalMs: 60_000,
    snapshotIntervalTicks,
    enableAgentFramework: false,
  });
  services.push(service);
  service.createSimulation(createRequest, "request-create");
  service.controlSimulation("sim_00000001", "start", {}, "request-start");
  service.controlSimulation("sim_00000001", "pause", {}, "request-pause");
  return { dataDir, service };
}

async function waitForAdvanceTask(service: SimulationService): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = service.getStatus("sim_00000001");
    if (status.task?.status === "completed") return;
    if (status.task?.status === "failed") {
      throw new Error(status.task.errorText ?? "advance task failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("advance task did not complete");
}

describe("SimulationService periodic snapshots", () => {
  it("snapshots each due committed tick and emits paired hash/snapshot events", async () => {
    const { dataDir, service } = createService(2);

    const result = await service.advanceSimulation(
      "sim_00000001",
      { ticks: 5 },
      "request-advance",
    );

    expect(result.statusCode).toBe(200);
    if (!("run" in result.body)) throw new Error("expected synchronous advance result");
    expect(result.body).toEqual({
      run: { currentTick: 5, status: "paused" },
      tickResults: { executed: 5, events: 14 },
    });

    const db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    try {
      const snapshotStore = new SqliteSnapshotStore(
        db,
        dataDir,
        "sim_00000001",
        "run_00000001",
      );
      const snapshots = snapshotStore.list();
      expect(snapshots.map((snapshot) => snapshot.tick)).toEqual([4, 2]);

      const events = new SqliteEventStore(db, "run_00000001").list().filter(
        (event) =>
          event.type === "simulation.statehash.computed" ||
          event.type === "simulation.snapshot.created",
      );
      expect(events.map((event) => [event.type, event.tick])).toEqual([
        ["simulation.statehash.computed", 2],
        ["simulation.snapshot.created", 2],
        ["simulation.statehash.computed", 4],
        ["simulation.snapshot.created", 4],
      ]);
      for (const snapshot of snapshots) {
        const pair = events.filter((event) => event.tick === snapshot.tick);
        expect(pair).toHaveLength(2);
        expect(pair[0]?.payload).toEqual({
          tick: snapshot.tick,
          stateHash: snapshot.stateHash,
        });
        expect(pair[1]?.payload).toEqual({
          snapshotId: snapshot.id,
          tick: snapshot.tick,
          stateHash: snapshot.stateHash,
        });
      }
    } finally {
      db.close();
    }
  });

  it("rejects invalid snapshot intervals", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-service-snapshot-"));
    temporaryDirectories.push(dataDir);
    expect(() => new SimulationService({ dataDir, snapshotIntervalTicks: 0 })).toThrow(
      /snapshot interval/,
    );
  });

  it("repairs a due post-commit snapshot before advancing the next tick", async () => {
    const { dataDir, service } = createService(2);
    let db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    const checkpoint = readRunCheckpoint(db, "run_00000001");
    const eventStore = new SqliteEventStore(db, "run_00000001");
    const committer = new SqliteTickCommitter(db, eventStore);
    const loop = new SimLoop({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      seed: 42,
      bus: new EventBus(),
      log: eventStore,
      ids: IdFactory.restore(checkpoint.idState),
      wallClock: () => "2026-07-14T12:00:00.000Z",
      initialTick: checkpoint.currentTick,
      nextSeq: checkpoint.nextEventSeq,
      tickCommitter: committer,
      tickUnitOfWork: committer,
    });
    loop.advance(2);
    expect(new SqliteSnapshotStore(
      db,
      dataDir,
      "sim_00000001",
      "run_00000001",
    ).list()).toEqual([]);
    db.close();

    const result = await service.advanceSimulation(
      "sim_00000001",
      { ticks: 1 },
      "request-after-recovery",
    );
    expect(result.statusCode).toBe(200);
    if (!("run" in result.body)) throw new Error("expected synchronous advance result");
    expect(result.body).toEqual({
      run: { currentTick: 3, status: "paused" },
      tickResults: { executed: 1, events: 4 },
    });

    db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    try {
      expect(new SqliteSnapshotStore(
        db,
        dataDir,
        "sim_00000001",
        "run_00000001",
      ).list().map((snapshot) => snapshot.tick)).toEqual([2]);
      const orderedTypes = new SqliteEventStore(db, "run_00000001").list()
        .filter((event) => event.tick >= 2)
        .map((event) => event.type);
      expect(orderedTypes.slice(-5)).toEqual([
        "admin.command.received",
        "simulation.statehash.computed",
        "simulation.snapshot.created",
        "simulation.tick.started",
        "simulation.tick.completed",
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps every boundary when a durable async advance spans intervals", async () => {
    const { dataDir, service } = createService(10);
    const queued = await service.advanceSimulation(
      "sim_00000001",
      { ticks: 51 },
      "request-async-advance",
    );
    expect(queued.statusCode).toBe(202);

    await waitForAdvanceTask(service);
    const db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    try {
      expect(new SqliteSnapshotStore(
        db,
        dataDir,
        "sim_00000001",
        "run_00000001",
      ).list().map((snapshot) => snapshot.tick)).toEqual([50, 40, 30, 20, 10]);
      expect(new SqliteEventStore(db, "run_00000001").list({
        type: "simulation.statehash.computed",
      }).map((event) => event.tick)).toEqual([10, 20, 30, 40, 50]);
    } finally {
      db.close();
    }
  }, 15_000);

  it("serializes run mutations while an asynchronous backup is in flight", async () => {
    const { service } = createService(1);
    const firstAdvance = service.advanceSimulation(
      "sim_00000001",
      { ticks: 1 },
      "request-first",
    );

    expect(() => service.controlSimulation(
      "sim_00000001",
      "resume",
      {},
      "request-concurrent-control",
    )).toThrow(/active operation/);
    await expect(service.advanceSimulation(
      "sim_00000001",
      { ticks: 1 },
      "request-concurrent-advance",
    )).rejects.toThrow(/active operation/);

    await expect(firstAdvance).resolves.toMatchObject({
      statusCode: 200,
      body: { run: { currentTick: 1, status: "paused" } },
    });
    await expect(service.advanceSimulation(
      "sim_00000001",
      { ticks: 1 },
      "request-after-release",
    )).resolves.toMatchObject({
      statusCode: 200,
      body: { run: { currentTick: 2, status: "paused" } },
    });
  });
});
