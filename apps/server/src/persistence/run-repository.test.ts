import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError, IdFactory } from "@worldtangle/shared";
import type { IdFactoryState } from "@worldtangle/shared";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import {
  SqliteRunRepository,
} from "./run-repository";
import type {
  RunTransitionContext,
  RunTransitionJournalHook,
} from "./run-repository";
import {
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
  testRun,
  testSimulation,
} from "./test-helpers";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function createDatabase(): { dataDir: string; db: WorldDatabase } {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-run-repository-"));
  temporaryDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  openDatabases.push(db);
  return { dataDir, db };
}

function expectEngineError(action: () => unknown, code: EngineError["code"]): void {
  try {
    action();
    throw new Error(`expected EngineError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
  }
}

function appendJournalEvent(
  store: SqliteEventStore,
  context: RunTransitionContext,
): IdFactoryState {
  const ids = IdFactory.restore(context.current.idState);
  const eventId = ids.next("evt");
  store.append({
    eventId,
    type: "admin.command.received",
    schemaVersion: 1,
    simulationId: context.current.simulationId,
    runId: context.current.id,
    seq: context.current.nextEventSeq,
    tick: context.current.currentTick,
    simDate: "Y0001-M01-D01",
    wallTime: context.wallTime,
    actor: { kind: "admin", id: "test-admin" },
    correlationId: eventId,
    payload: { command: context.command, nextStatus: context.nextStatus },
  });
  return ids.serialize();
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteRunRepository", () => {
  it("atomically creates, lists, and reopens a simulation and run", () => {
    const { dataDir, db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    const simulation = testSimulation({
      scenario: { worldSpec: "test@1", runCostCentsMax: 500n },
    });
    const run = testRun();

    const created = repository.createSimulationWithRun(simulation, run);
    expect(created).toEqual({ simulation, run });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.run.manifest)).toBe(true);
    expect(Object.isFrozen(repository.listSimulations())).toBe(true);
    expect(repository.listSimulations()).toEqual([simulation]);
    expect(repository.listRuns(TEST_SIMULATION_ID)).toEqual([run]);
    expect(repository.listRuns(TEST_SIMULATION_ID, { status: "paused" })).toEqual([]);

    simulation.scenario["worldSpec"] = "mutated@2";
    run.manifest.modelRouting["1"] = "mutated-model";
    expect(repository.getSimulation(TEST_SIMULATION_ID).scenario).toEqual({
      worldSpec: "test@1",
      runCostCentsMax: 500n,
    });
    expect(repository.getRun(TEST_RUN_ID).manifest.modelRouting).toEqual({});

    db.close();
    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    openDatabases.push(reopened);
    const reopenedRepository = new SqliteRunRepository(reopened);
    expect(reopenedRepository.getSimulation(TEST_SIMULATION_ID).scenario["runCostCentsMax"])
      .toBe(500n);
    expect(reopenedRepository.getRun(TEST_RUN_ID)).toEqual(testRun());
  });

  it("rolls back the simulation insert when the run ID conflicts", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());

    const simulationId = "sim_00000002";
    const duplicateRun = testRun({
      simulationId,
      manifest: {
        ...testRun().manifest,
        simulationId,
      },
    });
    expectEngineError(
      () => repository.createSimulationWithRun(
        testSimulation({ id: simulationId, name: "second world" }),
        duplicateRun,
      ),
      "CONFLICT",
    );
    expectEngineError(() => repository.getSimulation(simulationId), "NOT_FOUND");
    expect(repository.listSimulations().map((simulation) => simulation.id)).toEqual([
      TEST_SIMULATION_ID,
    ]);
  });

  it("keeps the manifest write-once in memory and at the database boundary", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    const { run } = repository.createSimulationWithRun(testSimulation(), testRun());

    expect(Object.isFrozen(run.manifest)).toBe(true);
    expect(() => {
      run.manifest.modelRouting["1"] = "cannot-write";
    }).toThrow();
    expect(() => db.prepare(`
      UPDATE simulation_runs SET manifest_canonical = '{}' WHERE id = ?
    `).run(TEST_RUN_ID)).toThrow("run manifest is immutable");
    expect(repository.getRun(TEST_RUN_ID).manifest).toEqual(testRun().manifest);
  });

  it("journals before each guarded lifecycle effect and persists timestamps", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    const statusesSeenByJournal: string[] = [];
    const journal: RunTransitionJournalHook = (context) => {
      const status = db.prepare<[string], { status: string }>(
        "SELECT status FROM simulation_runs WHERE id = ?",
      ).get(TEST_RUN_ID)!.status;
      statusesSeenByJournal.push(status);
      return appendJournalEvent(store, context);
    };

    const started = repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1", expectedStatus: "created" },
      journal,
    );
    expect(started).toMatchObject({
      status: "running",
      startedWall: "T1",
      endedWall: null,
      nextEventSeq: 1,
      idState: { evt: 1 },
    });
    const paused = repository.transitionRun(
      { runId: TEST_RUN_ID, command: "pause", wallTime: "T2" },
      journal,
    );
    expect(paused).toMatchObject({ status: "paused", startedWall: "T1", endedWall: null });
    repository.transitionRun(
      { runId: TEST_RUN_ID, command: "resume", wallTime: "T3" },
      journal,
    );
    const stopped = repository.transitionRun(
      { runId: TEST_RUN_ID, command: "stop", wallTime: "T4" },
      journal,
    );

    expect(statusesSeenByJournal).toEqual(["created", "running", "paused", "running"]);
    expect(stopped).toMatchObject({
      status: "stopped",
      startedWall: "T1",
      endedWall: "T4",
      nextEventSeq: 4,
      idState: { evt: 4 },
    });
    expect(store.list().map((event) => event.payload)).toEqual([
      { command: "start", nextStatus: "running" },
      { command: "pause", nextStatus: "paused" },
      { command: "resume", nextStatus: "running" },
      { command: "stop", nextStatus: "stopped" },
    ]);
    expect(repository.getRun(TEST_RUN_ID).manifest).toEqual(testRun().manifest);
  });

  it("rolls back journal events, checkpoints, and status on hook failure", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1" },
      (context) => appendJournalEvent(store, context),
    );

    expect(() => repository.transitionRun(
      { runId: TEST_RUN_ID, command: "pause", wallTime: "T2" },
      (context) => {
        appendJournalEvent(store, context);
        throw new Error("injected journal failure");
      },
    )).toThrow("injected journal failure");

    expect(store.count()).toBe(1);
    expect(repository.getRun(TEST_RUN_ID)).toMatchObject({
      status: "running",
      nextEventSeq: 1,
      idState: { evt: 1 },
    });
  });

  it("rejects missing journals, stale checkpoints, and illegal transitions", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());
    const store = new SqliteEventStore(db, TEST_RUN_ID);

    expectEngineError(() => repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1" },
      (context) => context.current.idState,
    ), "CONFLICT");
    expect(repository.getRun(TEST_RUN_ID).status).toBe("created");

    repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1" },
      (context) => appendJournalEvent(store, context),
    );
    expectEngineError(() => repository.transitionRun(
      {
        runId: TEST_RUN_ID,
        command: "pause",
        wallTime: "T2",
        expectedStatus: "created",
      },
      (context) => appendJournalEvent(store, context),
    ), "CONFLICT");
    expectEngineError(() => repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T2" },
      (context) => appendJournalEvent(store, context),
    ), "CONFLICT");
    expect(store.count()).toBe(1);
  });

  it("rolls back a journal whose ID checkpoint does not match its event sequence", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());
    const store = new SqliteEventStore(db, TEST_RUN_ID);

    expectEngineError(() => repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1" },
      (context) => {
        appendJournalEvent(store, context);
        return context.current.idState;
      },
    ), "CONFLICT");
    expect(store.count()).toBe(0);
    expect(repository.getRun(TEST_RUN_ID)).toMatchObject({
      status: "created",
      nextEventSeq: 0,
      idState: {},
    });
  });

  it("rolls back when the guarded lifecycle checkpoint becomes stale", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    repository.transitionRun(
      { runId: TEST_RUN_ID, command: "start", wallTime: "T1" },
      (context) => appendJournalEvent(store, context),
    );

    expectEngineError(() => repository.transitionRun(
      { runId: TEST_RUN_ID, command: "pause", wallTime: "T2" },
      (context) => {
        const idState = appendJournalEvent(store, context);
        db.prepare("UPDATE simulation_runs SET status = 'paused' WHERE id = ?")
          .run(TEST_RUN_ID);
        return idState;
      },
    ), "CONFLICT");
    expect(store.count()).toBe(1);
    expect(repository.getRun(TEST_RUN_ID)).toMatchObject({
      status: "running",
      nextEventSeq: 1,
      idState: { evt: 1 },
    });
  });

  it("detects unsafe integers and non-canonical persisted values", () => {
    const { db } = createDatabase();
    const repository = new SqliteRunRepository(db);
    repository.createSimulationWithRun(testSimulation(), testRun());

    db.prepare("UPDATE simulation_runs SET end_tick = ? WHERE id = ?")
      .run(9_007_199_254_740_993n, TEST_RUN_ID);
    expectEngineError(() => repository.getRun(TEST_RUN_ID), "INTERNAL");

    db.prepare("UPDATE simulations SET scenario_canonical = ? WHERE id = ?")
      .run('{"z":1,"a":2}', TEST_SIMULATION_ID);
    expectEngineError(() => repository.getSimulation(TEST_SIMULATION_ID), "INTERNAL");
  });
});
