import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus, SimLoop } from "@worldtangle/engine";
import { openWorldDatabase } from "./persistence/database";
import type { WorldDatabase } from "./persistence/database";
import { SqliteEventStore } from "./persistence/event-store";
import { SqliteScheduler } from "./persistence/scheduler";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./persistence/test-helpers";
import { readRunCheckpoint, SqliteTickCommitter } from "./persistence/tick-committer";
import {
  createSchedulerPhaseHandler,
  RegisteredScheduledTaskDispatcher,
} from "./scheduler-phase";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function createFixture(afterEvents?: () => void): {
  db: WorldDatabase;
  eventStore: SqliteEventStore;
  scheduler: SqliteScheduler;
  dispatcher: RegisteredScheduledTaskDispatcher;
  loop: SimLoop;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-scheduler-phase-"));
  temporaryDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  openDatabases.push(db);
  insertTestRun(db);
  db.prepare(`
    UPDATE simulation_runs SET status = 'paused', started_wall = 'T0' WHERE id = ?
  `).run(TEST_RUN_ID);
  db.exec("CREATE TABLE domain_effects(id TEXT PRIMARY KEY, task_order INTEGER NOT NULL)");

  const eventStore = new SqliteEventStore(db, TEST_RUN_ID);
  const committer = new SqliteTickCommitter(
    db,
    eventStore,
    afterEvents === undefined ? {} : { afterEvents },
  );
  const scheduler = new SqliteScheduler(db, TEST_RUN_ID);
  const dispatcher = new RegisteredScheduledTaskDispatcher();
  const loop = new SimLoop({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seed: 42,
    bus: new EventBus(),
    log: eventStore,
    wallClock: () => "T0",
    tickCommitter: committer,
    tickUnitOfWork: committer,
  });
  loop.registerPhase("obligations", createSchedulerPhaseHandler(scheduler, dispatcher));
  return { db, eventStore, scheduler, dispatcher, loop };
}

function schedule(
  scheduler: SqliteScheduler,
  id: string,
  order: number,
  taskRef = "test.effect",
): void {
  scheduler.schedule({ id, dueTick: 1, order, taskRef, payload: { id } });
}

function domainEffectCount(db: WorldDatabase): bigint {
  return db.prepare<[], { count: bigint }>(
    "SELECT COUNT(*) AS count FROM domain_effects",
  ).get()!.count;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("scheduler obligations phase", () => {
  it("is M01 order zero and fires due tasks in deterministic queue order", () => {
    const fixture = createFixture();
    const phase = createSchedulerPhaseHandler(fixture.scheduler, fixture.dispatcher);
    expect(phase).toMatchObject({ module: "M01-scheduler", order: 0 });

    schedule(fixture.scheduler, "task_00000003", 10);
    schedule(fixture.scheduler, "task_00000002", 10);
    schedule(fixture.scheduler, "task_00000001", 5);
    const dispatched: string[] = [];
    fixture.dispatcher.register("test.effect", (task, ctx) => {
      expect(ctx.phase).toBe("obligations");
      expect(task.firedTick).toBe(1);
      dispatched.push(task.id);
      ctx.emit("scheduler.task.fired", { taskId: task.id });
    });

    expect(fixture.loop.tick()).toBe(1);
    expect(dispatched).toEqual([
      "task_00000001",
      "task_00000002",
      "task_00000003",
    ]);
    expect(fixture.scheduler.listPending()).toEqual([]);
    expect(fixture.eventStore.list().map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(readRunCheckpoint(fixture.db, TEST_RUN_ID)).toEqual({
      id: TEST_RUN_ID,
      currentTick: 1,
      nextEventSeq: 5,
      idState: { evt: 5 },
    });
  });

  it("rolls back task claims, domain writes, events, and checkpoints after a later phase fails", () => {
    const fixture = createFixture();
    schedule(fixture.scheduler, "task_00000002", 10);
    schedule(fixture.scheduler, "task_00000001", 5);
    fixture.dispatcher.register("test.effect", (task, ctx) => {
      fixture.db.prepare(
        "INSERT INTO domain_effects(id, task_order) VALUES (?, ?)",
      ).run(task.id, task.order);
      ctx.emit("scheduler.task.fired", { taskId: task.id });
    });
    let fail = true;
    fixture.loop.registerPhase("settlement", {
      module: "test-later-write",
      order: 0,
      run: () => {
        fixture.db.prepare(
          "INSERT INTO domain_effects(id, task_order) VALUES (?, ?)",
        ).run("effect_later", 99);
        if (fail) throw new Error("later phase failed");
      },
    });

    expect(() => fixture.loop.tick()).toThrow("later phase failed");
    expect(fixture.scheduler.listPending().map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
    ]);
    expect(domainEffectCount(fixture.db)).toBe(0n);
    expect(fixture.eventStore.count()).toBe(0);
    expect(fixture.loop.currentTick).toBe(0);
    expect(fixture.loop.nextEventSeq).toBe(0);
    expect(fixture.loop.idState).toEqual({});
    expect(readRunCheckpoint(fixture.db, TEST_RUN_ID).currentTick).toBe(0);

    fail = false;
    expect(fixture.loop.tick()).toBe(1);
    expect(fixture.scheduler.listPending()).toEqual([]);
    expect(domainEffectCount(fixture.db)).toBe(3n);
    expect(fixture.eventStore.list().map((event) => event.eventId)).toEqual([
      "evt_00000001",
      "evt_00000002",
      "evt_00000003",
      "evt_00000004",
    ]);
  });

  it("keeps an unknown or throwing task pending for a gapless retry", () => {
    const fixture = createFixture();
    schedule(fixture.scheduler, "task_00000001", 0, "test.unknown");

    expect(() => fixture.loop.tick()).toThrow(
      "no handler registered for scheduled task reference test.unknown",
    );
    expect(fixture.scheduler.listPending()).toHaveLength(1);
    expect(fixture.eventStore.count()).toBe(0);

    let shouldThrow = true;
    fixture.dispatcher.register("test.unknown", (task, ctx) => {
      fixture.db.prepare(
        "INSERT INTO domain_effects(id, task_order) VALUES (?, ?)",
      ).run(task.id, task.order);
      ctx.emit("scheduler.task.fired", { taskId: task.id });
      if (shouldThrow) throw new Error("task handler failed");
    });
    expect(() => fixture.loop.tick()).toThrow("task handler failed");
    expect(fixture.scheduler.listPending()).toHaveLength(1);
    expect(domainEffectCount(fixture.db)).toBe(0n);
    expect(fixture.eventStore.count()).toBe(0);

    shouldThrow = false;
    expect(fixture.loop.tick()).toBe(1);
    expect(fixture.scheduler.listPending()).toEqual([]);
    expect(fixture.eventStore.list().map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(fixture.eventStore.list().map((event) => event.eventId)).toEqual([
      "evt_00000001",
      "evt_00000002",
      "evt_00000003",
    ]);
  });

  it("rolls back scheduler and domain effects when persistence fails after event insertion", () => {
    let failAfterEvents = true;
    const fixture = createFixture(() => {
      if (failAfterEvents) throw new Error("failed after event insertion");
    });
    schedule(fixture.scheduler, "task_00000001", 0);
    fixture.dispatcher.register("test.effect", (task, ctx) => {
      fixture.db.prepare(
        "INSERT INTO domain_effects(id, task_order) VALUES (?, ?)",
      ).run(task.id, task.order);
      ctx.emit("scheduler.task.fired", { taskId: task.id });
    });

    expect(() => fixture.loop.tick()).toThrow("failed after event insertion");
    expect(fixture.scheduler.listPending()).toHaveLength(1);
    expect(domainEffectCount(fixture.db)).toBe(0n);
    expect(fixture.eventStore.count()).toBe(0);
    expect(readRunCheckpoint(fixture.db, TEST_RUN_ID)).toEqual({
      id: TEST_RUN_ID,
      currentTick: 0,
      nextEventSeq: 0,
      idState: {},
    });

    failAfterEvents = false;
    expect(fixture.loop.tick()).toBe(1);
    expect(fixture.scheduler.listPending()).toEqual([]);
    expect(domainEffectCount(fixture.db)).toBe(1n);
    expect(fixture.eventStore.list().map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it("does nothing when the queue is empty", () => {
    const fixture = createFixture();
    expect(fixture.loop.tick()).toBe(1);
    expect(fixture.eventStore.list().map((event) => event.type)).toEqual([
      "simulation.tick.started",
      "simulation.tick.completed",
    ]);
  });
});
