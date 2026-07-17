import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteScheduler } from "./scheduler";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function createScheduler(): {
  dataDir: string;
  db: WorldDatabase;
  scheduler: SqliteScheduler;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-scheduler-"));
  temporaryDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  openDatabases.push(db);
  insertTestRun(db);
  return { dataDir, db, scheduler: new SqliteScheduler(db, TEST_RUN_ID) };
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

describe("SqliteScheduler", () => {
  it("persists canonical payloads and lists pending tasks in queue order", () => {
    const { db, scheduler } = createScheduler();
    scheduler.schedule({
      id: "task_00000004",
      dueTick: 3,
      order: 0,
      taskRef: "contract.expiry",
      payload: { contractId: "ctr_1" },
    });
    scheduler.schedule({
      id: "task_00000003",
      dueTick: 2,
      order: 10,
      taskRef: "loan.installment",
      payload: { z: 1, cents: 2500n, a: 2 },
    });
    scheduler.schedule({
      id: "task_00000002",
      dueTick: 2,
      order: 10,
      taskRef: "loan.installment",
      payload: { loanId: "lon_2" },
    });
    scheduler.schedule({
      id: "task_00000001",
      dueTick: 2,
      order: 5,
      taskRef: "labor.payroll",
      payload: { employerId: "cmp_1" },
    });

    expect(scheduler.listPending().map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
      "task_00000003",
      "task_00000004",
    ]);
    expect(scheduler.listPending({ throughTick: 2 }).map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
      "task_00000003",
    ]);
    expect(scheduler.listPending()[2]!.payload).toEqual({ a: 2, cents: 2500n, z: 1 });
    expect(Object.isFrozen(scheduler.listPending())).toBe(true);
    expect(Object.isFrozen(scheduler.listPending()[0])).toBe(true);
    expect(
      db.prepare<[string], { payload_canonical: string }>(`
        SELECT payload_canonical FROM scheduled_tasks WHERE id = ?
      `).get("task_00000003")!.payload_canonical,
    ).toBe('{"a":2,"cents":{"$b":"2500"},"z":1}');
  });

  it("orders arbitrary queues by due tick, order, then task ID", () => {
    const { db, scheduler } = createScheduler();
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dueTick: fc.integer({ min: 1, max: 20 }),
            order: fc.integer({ min: -10, max: 10 }),
          }),
          { minLength: 1, maxLength: 16 },
        ),
        (specs) => {
          db.prepare("DELETE FROM scheduled_tasks WHERE run_id = ?").run(TEST_RUN_ID);
          const expected = specs.map((spec, index) => ({
            ...spec,
            id: `task_${(index + 1).toString(36).padStart(8, "0")}`,
          }));
          for (const task of expected) {
            scheduler.schedule({
              ...task,
              taskRef: "test.property",
              payload: {},
            });
          }
          expected.sort(
            (a, b) =>
              a.dueTick - b.dueTick ||
              a.order - b.order ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
          expect(scheduler.listPending().map((task) => task.id)).toEqual(
            expected.map((task) => task.id),
          );
        },
      ),
      { numRuns: 30 },
    );
  });

  it("fires due tasks exactly once and preserves the claim across reopen", () => {
    const { dataDir, db, scheduler } = createScheduler();
    scheduler.schedule({
      id: "task_00000002",
      dueTick: 2,
      order: 1,
      taskRef: "loan.installment",
      payload: { loanId: "lon_1" },
    });
    scheduler.schedule({
      id: "task_00000001",
      dueTick: 1,
      order: 1,
      taskRef: "labor.payroll",
      payload: {},
    });

    const fired: string[] = [];
    expect(scheduler.fireDue(1, (task) => fired.push(task.id))).toMatchObject([
      { id: "task_00000001", firedTick: 1 },
    ]);
    expect(fired).toEqual(["task_00000001"]);
    expect(scheduler.fireDue(1)).toEqual([]);
    expect(scheduler.listPending().map((task) => task.id)).toEqual(["task_00000002"]);

    db.close();
    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    openDatabases.push(reopened);
    const resumed = new SqliteScheduler(reopened, TEST_RUN_ID);
    expect(resumed.fireDue(2)).toMatchObject([
      { id: "task_00000002", firedTick: 2 },
    ]);
    expect(resumed.fireDue(2)).toEqual([]);
    expect(resumed.listPending()).toEqual([]);
  });

  it("rolls back every claim when a fire handler fails", () => {
    const { scheduler } = createScheduler();
    for (const id of ["task_00000001", "task_00000002"]) {
      scheduler.schedule({
        id,
        dueTick: 1,
        order: 1,
        taskRef: "test.callback",
        payload: { id },
      });
    }

    expect(() => scheduler.fireDue(1, (task) => {
      if (task.id === "task_00000002") throw new Error("injected task failure");
    })).toThrow("injected task failure");
    expect(scheduler.listPending().map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
    ]);
    expect(scheduler.fireDue(1).map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
    ]);
  });

  it("rejects invalid tasks, duplicates, past scheduling, and missing runs", () => {
    const { db, scheduler } = createScheduler();
    const valid = {
      id: "task_00000001",
      dueTick: 2,
      order: 0,
      taskRef: "test.task",
      payload: {},
    } as const;

    expectEngineError(() => new SqliteScheduler(db, "../run"), "VALIDATION_FAILED");
    expectEngineError(() => new SqliteScheduler(db, "run_00000002"), "NOT_FOUND");
    expectEngineError(() => scheduler.schedule({ ...valid, id: "bad" }), "VALIDATION_FAILED");
    expectEngineError(() => scheduler.schedule({ ...valid, dueTick: 0 }), "VALIDATION_FAILED");
    expectEngineError(() => scheduler.schedule({ ...valid, order: 0.5 }), "VALIDATION_FAILED");
    expectEngineError(
      () => scheduler.schedule({ ...valid, taskRef: "not a reference" }),
      "VALIDATION_FAILED",
    );
    expectEngineError(
      () => scheduler.schedule({ ...valid, payload: Number.NaN }),
      "VALIDATION_FAILED",
    );

    scheduler.schedule(valid);
    expectEngineError(() => scheduler.schedule(valid), "CONFLICT");
    db.prepare("UPDATE simulation_runs SET current_tick = 2 WHERE id = ?").run(TEST_RUN_ID);
    expectEngineError(
      () => scheduler.schedule({ ...valid, id: "task_00000002", dueTick: 2 }),
      "CONFLICT",
    );
  });

  it("composes with an existing transaction and detects invalid persisted values", () => {
    const { db, scheduler } = createScheduler();
    scheduler.schedule({
      id: "task_00000001",
      dueTick: 1,
      order: 0,
      taskRef: "test.task",
      payload: {},
    });

    expect(() => db.transaction(() => {
      scheduler.fireDue(1);
      throw new Error("outer transaction failed");
    }).immediate()).toThrow("outer transaction failed");
    expect(scheduler.listPending()).toHaveLength(1);

    db.prepare("UPDATE scheduled_tasks SET payload_canonical = ? WHERE id = ?")
      .run('{"z":1,"a":2}', "task_00000001");
    expectEngineError(() => scheduler.listPending(), "INTERNAL");
  });

  it("rolls back a failed fire handler even when an outer transaction catches it", () => {
    const { db, scheduler } = createScheduler();
    for (const id of ["task_00000001", "task_00000002"]) {
      scheduler.schedule({
        id,
        dueTick: 1,
        order: 0,
        taskRef: "test.callback",
        payload: { id },
      });
    }
    db.exec("CREATE TABLE domain_effects(id TEXT PRIMARY KEY)");

    db.transaction(() => {
      try {
        scheduler.fireDue(1, (task) => {
          db.prepare("INSERT INTO domain_effects(id) VALUES (?)").run(task.id);
          if (task.id === "task_00000002") throw new Error("nested handler failed");
        });
      } catch (error) {
        expect(error).toMatchObject({ message: "nested handler failed" });
      }
      db.prepare("INSERT INTO domain_effects(id) VALUES (?)").run("outer_effect");
    }).immediate();

    expect(scheduler.listPending().map((task) => task.id)).toEqual([
      "task_00000001",
      "task_00000002",
    ]);
    expect(
      db.prepare<[], { id: string }>("SELECT id FROM domain_effects ORDER BY id").all(),
    ).toEqual([{ id: "outer_effect" }]);
  });
});
