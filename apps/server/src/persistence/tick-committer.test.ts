import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdFactory } from "@worldtangle/shared";
import { EventBus, SimLoop } from "@worldtangle/engine";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint, SqliteTickCommitter } from "./tick-committer";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function createDatabase(): { dataDir: string; db: WorldDatabase } {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-tick-"));
  temporaryDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  openDatabases.push(db);
  insertTestRun(db);
  db.prepare(`
    UPDATE simulation_runs SET status = 'paused', started_wall = 'T0' WHERE id = ?
  `).run(TEST_RUN_ID);
  return { dataDir, db };
}

function buildPersistentLoop(
  store: SqliteEventStore,
  committer: SqliteTickCommitter,
  initialTick = 0,
  nextSeq = 0,
  ids?: IdFactory,
): SimLoop {
  return new SimLoop({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seed: 42,
    bus: new EventBus(),
    log: store,
    tickCommitter: committer,
    tickUnitOfWork: committer,
    initialTick,
    nextSeq,
    ...(ids ? { ids } : {}),
    wallClock: () => "T0",
  });
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteTickCommitter", () => {
  it("rolls back events and checkpoints when failure is injected mid-commit", () => {
    const { db } = createDatabase();
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    let fail = true;
    const committer = new SqliteTickCommitter(db, store, {
      afterEvents: () => {
        expect(db.inTransaction).toBe(true);
        if (fail) throw new Error("injected after event insertion");
      },
    });
    const loop = buildPersistentLoop(store, committer);

    expect(() => loop.tick()).toThrow("injected after event insertion");
    expect(loop.currentTick).toBe(0);
    expect(store.count()).toBe(0);
    expect(readRunCheckpoint(db, TEST_RUN_ID)).toEqual({
      id: TEST_RUN_ID,
      currentTick: 0,
      nextEventSeq: 0,
      idState: {},
    });

    fail = false;
    expect(loop.tick()).toBe(1);
    expect(readRunCheckpoint(db, TEST_RUN_ID)).toEqual({
      id: TEST_RUN_ID,
      currentTick: 1,
      nextEventSeq: 2,
      idState: { evt: 2 },
    });
    expect(store.list().map((event) => event.eventId)).toEqual([
      "evt_00000001",
      "evt_00000002",
    ]);
  });

  it("reopens from a checkpoint and matches a straight-through run", () => {
    const resumedDatabase = createDatabase();
    let resumedStore = new SqliteEventStore(resumedDatabase.db, TEST_RUN_ID);
    let committer = new SqliteTickCommitter(resumedDatabase.db, resumedStore);
    const first = buildPersistentLoop(resumedStore, committer);
    first.advance(2);
    resumedDatabase.db.close();

    const reopened = openWorldDatabase(
      resumedDatabase.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    openDatabases.push(reopened);
    const checkpoint = readRunCheckpoint(reopened, TEST_RUN_ID);
    resumedStore = new SqliteEventStore(reopened, TEST_RUN_ID);
    committer = new SqliteTickCommitter(reopened, resumedStore);
    const resumed = buildPersistentLoop(
      resumedStore,
      committer,
      checkpoint.currentTick,
      checkpoint.nextEventSeq,
      IdFactory.restore(checkpoint.idState),
    );
    resumed.tick();

    const straightDatabase = createDatabase();
    const straightStore = new SqliteEventStore(straightDatabase.db, TEST_RUN_ID);
    const straight = buildPersistentLoop(
      straightStore,
      new SqliteTickCommitter(straightDatabase.db, straightStore),
    );
    straight.advance(3);

    expect(readRunCheckpoint(reopened, TEST_RUN_ID).currentTick).toBe(3);
    expect(resumedStore.logHash()).toBe(straightStore.logHash());
  });

  it("provides a root immediate transaction for domain work", () => {
    const { db } = createDatabase();
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    const committer = new SqliteTickCommitter(db, store);
    db.exec("CREATE TABLE domain_effects(id TEXT PRIMARY KEY)");

    expect(() =>
      committer.execute(() => {
        expect(db.inTransaction).toBe(true);
        db.prepare("INSERT INTO domain_effects(id) VALUES (?)").run("effect_1");
        throw new Error("domain write failed");
      }),
    ).toThrow("domain write failed");

    const row = db.prepare<[], { count: bigint }>(
      "SELECT COUNT(*) AS count FROM domain_effects",
    ).get()!;
    expect(row.count).toBe(0n);
  });

  it("uses a savepoint so a caught nested failure cannot leak partial tick work", () => {
    const { db } = createDatabase();
    const store = new SqliteEventStore(db, TEST_RUN_ID);
    const committer = new SqliteTickCommitter(db, store);
    db.exec("CREATE TABLE domain_effects(id TEXT PRIMARY KEY)");

    db.transaction(() => {
      try {
        committer.execute(() => {
          db.prepare("INSERT INTO domain_effects(id) VALUES (?)").run("tick_effect");
          throw new Error("nested tick failed");
        });
      } catch (error) {
        expect(error).toMatchObject({ message: "nested tick failed" });
      }
      db.prepare("INSERT INTO domain_effects(id) VALUES (?)").run("outer_effect");
    }).immediate();

    expect(
      db.prepare<[], { id: string }>("SELECT id FROM domain_effects ORDER BY id").all(),
    ).toEqual([{ id: "outer_effect" }]);
  });
});
