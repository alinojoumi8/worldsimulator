import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import { SqliteApiTaskStore } from "./api-task-store";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function createStore(): {
  dataDir: string;
  db: WorldDatabase;
  store: SqliteApiTaskStore;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-api-task-"));
  temporaryDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  openDatabases.push(db);
  insertTestRun(db);
  return { dataDir, db, store: new SqliteApiTaskStore(db, TEST_RUN_ID) };
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

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteApiTaskStore", () => {
  it("persists an active task across reopen and retains completed history", () => {
    const { dataDir, db, store } = createStore();
    const pending = store.createAdvanceTask({
      id: "task_00000001",
      startTick: 0,
      targetTick: 51,
      wallTime: "2026-07-14T12:00:00.000Z",
    });
    expect(pending).toEqual({
      id: "task_00000001",
      runId: TEST_RUN_ID,
      kind: "advance",
      status: "pending",
      startTick: 0,
      targetTick: 51,
      createdWall: "2026-07-14T12:00:00.000Z",
      updatedWall: "2026-07-14T12:00:00.000Z",
      errorText: null,
    });
    expect(Object.isFrozen(pending)).toBe(true);

    db.close();
    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    openDatabases.push(reopened);
    const resumed = new SqliteApiTaskStore(reopened, TEST_RUN_ID);
    expect(resumed.getActive()).toEqual(pending);
    expect(resumed.markRunning(pending.id, "2026-07-14T12:00:01.000Z").status).toBe(
      "running",
    );
    reopened.prepare("UPDATE simulation_runs SET current_tick = 51 WHERE id = ?")
      .run(TEST_RUN_ID);
    expect(resumed.markCompleted(pending.id, "2026-07-14T12:00:02.000Z")).toMatchObject({
      status: "completed",
      updatedWall: "2026-07-14T12:00:02.000Z",
      errorText: null,
    });
    expect(resumed.listActive()).toEqual([]);

    reopened.close();
    const reopenedAgain = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    openDatabases.push(reopenedAgain);
    const afterRestart = new SqliteApiTaskStore(reopenedAgain, TEST_RUN_ID);
    expect(afterRestart.getLatest()).toMatchObject({
      id: pending.id,
      status: "completed",
      targetTick: 51,
    });
  });

  it("enforces one active task per run and exposes deterministic history reads", () => {
    const { store } = createStore();
    store.createAdvanceTask({
      id: "task_00000001",
      startTick: 0,
      targetTick: 51,
      wallTime: "T1",
    });
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000002",
        startTick: 0,
        targetTick: 52,
        wallTime: "T2",
      }),
      "CONFLICT",
    );

    expect(store.markFailed("task_00000001", "T3", "worker stopped")).toMatchObject({
      status: "failed",
      errorText: "worker stopped",
    });
    store.createAdvanceTask({
      id: "task_00000002",
      startTick: 0,
      targetTick: 52,
      wallTime: "T4",
    });
    expect(store.list().map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
    ]);
    expect(store.listActive().map((task) => task.id)).toEqual(["task_00000002"]);
    expect(store.getActive()?.id).toBe("task_00000002");
    expect(store.getLatest()?.id).toBe("task_00000002");
    expect(Object.isFrozen(store.list())).toBe(true);
  });

  it("rejects stale state transitions and requires the exact target checkpoint", () => {
    const { db, store } = createStore();
    store.createAdvanceTask({
      id: "task_00000001",
      startTick: 0,
      targetTick: 3,
      wallTime: "T0",
    });

    expectEngineError(() => store.markCompleted("task_00000001", "T1"), "CONFLICT");
    store.markRunning("task_00000001", "T2");
    expectEngineError(() => store.markRunning("task_00000001", "T3"), "CONFLICT");
    expectEngineError(() => store.markCompleted("task_00000001", "T4"), "CONFLICT");
    expect(() => db.prepare(`
      UPDATE api_tasks SET status = 'completed' WHERE id = ?
    `).run("task_00000001")).toThrow("advance task has not reached its target tick");

    db.prepare("UPDATE simulation_runs SET current_tick = 4 WHERE id = ?").run(TEST_RUN_ID);
    expectEngineError(() => store.markCompleted("task_00000001", "T5"), "CONFLICT");
    db.prepare("UPDATE simulation_runs SET current_tick = 3 WHERE id = ?").run(TEST_RUN_ID);
    expect(store.markCompleted("task_00000001", "T6").status).toBe("completed");
    expectEngineError(
      () => store.markFailed("task_00000001", "T7", "late worker failure"),
      "CONFLICT",
    );
    expect(() => db.prepare(`
      UPDATE api_tasks SET status = 'running' WHERE id = ?
    `).run("task_00000001")).toThrow("invalid api task status transition");
  });

  it("composes task creation with an outer transaction", () => {
    const { store, db } = createStore();
    expect(() => db.transaction(() => {
      store.createAdvanceTask({
        id: "task_00000001",
        startTick: 0,
        targetTick: 51,
        wallTime: "T0",
      });
      throw new Error("outer transaction failed");
    }).immediate()).toThrow("outer transaction failed");

    expectEngineError(() => store.get("task_00000001"), "NOT_FOUND");
    expect(store.getActive()).toBeNull();
  });

  it("validates identifiers, checkpoints, wall metadata, and failure details", () => {
    const { db, store } = createStore();
    expectEngineError(() => new SqliteApiTaskStore(db, "../run"), "VALIDATION_FAILED");
    expectEngineError(() => new SqliteApiTaskStore(db, "run_00000002"), "NOT_FOUND");
    expectEngineError(
      () => store.createAdvanceTask({
        id: "bad",
        startTick: 0,
        targetTick: 1,
        wallTime: "T0",
      }),
      "VALIDATION_FAILED",
    );
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000001",
        startTick: -1,
        targetTick: 1,
        wallTime: "T0",
      }),
      "VALIDATION_FAILED",
    );
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000001",
        startTick: 0,
        targetTick: 0,
        wallTime: "T0",
      }),
      "VALIDATION_FAILED",
    );
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000001",
        startTick: 0,
        targetTick: 1,
        wallTime: " ",
      }),
      "VALIDATION_FAILED",
    );
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000001",
        startTick: 0,
        targetTick: 361,
        wallTime: "T0",
      }),
      "CONFLICT",
    );

    db.prepare("UPDATE simulation_runs SET current_tick = 2 WHERE id = ?").run(TEST_RUN_ID);
    expectEngineError(
      () => store.createAdvanceTask({
        id: "task_00000001",
        startTick: 0,
        targetTick: 3,
        wallTime: "T0",
      }),
      "CONFLICT",
    );
    expectEngineError(
      () => store.markFailed("task_00000001", "T1", " "),
      "VALIDATION_FAILED",
    );
  });

  it("validates persisted task statuses and protects immutable history fields", () => {
    const { db, store } = createStore();
    store.createAdvanceTask({
      id: "task_00000001",
      startTick: 0,
      targetTick: 51,
      wallTime: "T0",
    });
    expect(() => db.prepare(`
      UPDATE api_tasks SET target_tick = 52 WHERE id = ?
    `).run("task_00000001")).toThrow("api task identity and target are immutable");
    expect(() => db.prepare("DELETE FROM api_tasks WHERE id = ?")
      .run("task_00000001")).toThrow("api task history is append-only");

    db.pragma("ignore_check_constraints = ON");
    db.prepare(`
      INSERT INTO api_tasks(
        id, run_id, kind, status, start_tick, target_tick,
        created_wall, updated_wall, error_text
      ) VALUES (?, ?, 'advance', 'unknown', 0, 52, 'T1', 'T1', NULL)
    `).run("task_00000002", TEST_RUN_ID);
    db.pragma("ignore_check_constraints = OFF");
    expectEngineError(() => store.list(), "INTERNAL");
  });
});
