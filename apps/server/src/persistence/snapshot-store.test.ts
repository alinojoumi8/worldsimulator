import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError, IdFactory } from "@worldtangle/shared";
import type { SimulationRun } from "@worldtangle/shared";
import { createContractFromTemplate, EventBus, SimLoop } from "@worldtangle/engine";
import { createPhase4Handlers } from "../phase4-phase";
import { openDatabaseFile, openWorldDatabase, worldDatabasePath } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteRunRepository } from "./run-repository";
import { SqlitePhase4Store } from "./phase4-store";
import { SqliteScheduler } from "./scheduler";
import {
  computeLogicalStateHash,
  snapshotFilePath,
  SqliteSnapshotStore,
} from "./snapshot-store";
import {
  insertTestRun,
  testRun,
  testSimulation,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";
import { readRunCheckpoint, SqliteTickCommitter } from "./tick-committer";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-snapshot-"));
  temporaryDirectories.push(path);
  return path;
}

function track(db: WorldDatabase): WorldDatabase {
  openDatabases.push(db);
  return db;
}

function createRunDatabase(): { dataDir: string; db: WorldDatabase } {
  const dataDir = temporaryDirectory();
  const db = track(openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID));
  insertTestRun(db);
  db.prepare(`
    UPDATE simulation_runs SET status = 'paused', started_wall = 'T0' WHERE id = ?
  `).run(TEST_RUN_ID);
  return { dataDir, db };
}

function buildLoop(db: WorldDatabase): { loop: SimLoop; eventStore: SqliteEventStore } {
  const checkpoint = readRunCheckpoint(db, TEST_RUN_ID);
  const eventStore = new SqliteEventStore(db, TEST_RUN_ID);
  const committer = new SqliteTickCommitter(db, eventStore);
  const loop = new SimLoop({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seed: 42,
    bus: new EventBus(),
    log: eventStore,
    tickCommitter: committer,
    tickUnitOfWork: committer,
    initialTick: checkpoint.currentTick,
    nextSeq: checkpoint.nextEventSeq,
    ids: IdFactory.restore(checkpoint.idState),
    wallClock: () => "T0",
  });
  for (const phase4 of createPhase4Handlers(db, TEST_RUN_ID)) {
    loop.registerPhase(phase4.phase, phase4.handler);
  }
  return { loop, eventStore };
}

function insertRunWithWallTime(db: WorldDatabase, wallTime: string): void {
  const baseRun = testRun();
  const run: SimulationRun = {
    ...baseRun,
    manifest: { ...baseRun.manifest, createdWall: wallTime },
  };
  new SqliteRunRepository(db).createSimulationWithRun(
    testSimulation({ createdWall: wallTime }),
    run,
  );
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteSnapshotStore", () => {
  it("backs up the current committed tick and records a stable logical hash", async () => {
    const { dataDir, db } = createRunDatabase();
    buildLoop(db).loop.advance(2);
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const before = store.stateHash();

    const snapshot = await store.create({ createdWall: "snapshot-wall-1" });

    expect(snapshot).toEqual({
      id: "snap_00000002",
      runId: TEST_RUN_ID,
      tick: 2,
      stateHash: store.stateHash(),
      relativePath: `${TEST_SIMULATION_ID}/${TEST_RUN_ID}/snapshots/snap_00000002.db`,
      createdWall: "snapshot-wall-1",
    });
    expect(store.list()).toEqual([snapshot]);
    expect(store.stateHash()).not.toBe(before);
    const snapshotEvents = new SqliteEventStore(db, TEST_RUN_ID).list({
      fromSeq: 4,
    });
    expect(snapshotEvents).toMatchObject([
      {
        eventId: "evt_00000005",
        type: "simulation.statehash.computed",
        seq: 4,
        tick: 2,
        actor: { kind: "system", id: "snapshot-store" },
        correlationId: snapshot.id,
        payload: { tick: 2, stateHash: snapshot.stateHash },
      },
      {
        eventId: "evt_00000006",
        type: "simulation.snapshot.created",
        seq: 5,
        tick: 2,
        actor: { kind: "system", id: "snapshot-store" },
        correlationId: snapshot.id,
        payload: {
          snapshotId: snapshot.id,
          tick: 2,
          stateHash: snapshot.stateHash,
        },
      },
    ]);
    expect(existsSync(snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    ))).toBe(true);
    expect(existsSync(`${snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    )}.tmp`)).toBe(false);
  });

  it("restores and advances equivalently to the straight-through run", async () => {
    const { dataDir, db } = createRunDatabase();
    buildLoop(db).loop.advance(2);
    const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
    const contractIds = new IdFactory();
    const contract = createContractFromTemplate({
      id: "ctr_00000001",
      runId: TEST_RUN_ID,
      type: "service",
      parties: [
        { kind: "institution", id: "provider", role: "provider" },
        { kind: "institution", id: "client", role: "client" },
      ],
      terms: {
        template: "service",
        providerId: "provider",
        clientId: "client",
        scope: "Snapshot equivalence service",
        feeCents: "1000",
        dueTick: 3,
      },
      draftedBy: { kind: "system", id: "engine" },
      createdTick: 2,
      effectiveTick: 3,
      ids: contractIds,
    });
    phase4.insertLegalContract(contract);
    phase4.signContract(contract.id, { kind: "institution", id: "provider" }, 2);
    phase4.signContract(contract.id, { kind: "institution", id: "client" }, 2);
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await store.create({ createdWall: "snapshot-wall" });
    const snapshotLogHash = new SqliteEventStore(db, TEST_RUN_ID).logHash();
    buildLoop(db).loop.tick();
    expect(readRunCheckpoint(db, TEST_RUN_ID).currentTick).toBe(3);
    const straightStateHash = computeLogicalStateHash(db, TEST_RUN_ID);
    const straightLogHash = new SqliteEventStore(db, TEST_RUN_ID).logHash();

    const destination = join(dataDir, "restored", "world.db");
    expect(store.restoreTo(snapshot.id, destination)).toBe(destination);
    let restored = track(openDatabaseFile(destination));
    expect(readRunCheckpoint(restored, TEST_RUN_ID).currentTick).toBe(2);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(snapshotLogHash);

    buildLoop(restored).loop.tick();
    expect(readRunCheckpoint(restored, TEST_RUN_ID).currentTick).toBe(3);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(straightStateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(straightLogHash);

    restored.close();
    restored = track(openDatabaseFile(destination));
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(straightStateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(straightLogHash);
  });

  it("cleans temporary and renamed files when creation fails before metadata commit", async () => {
    const { dataDir, db } = createRunDatabase();
    const finalPath = snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      "snap_00000000",
    );
    const failing = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      { afterRename: () => { throw new Error("injected after rename"); } },
    );

    await expect(failing.create({ createdWall: "snapshot-wall" })).rejects.toThrow(
      "snapshot creation failed",
    );
    expect(existsSync(finalPath)).toBe(false);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
    expect(db.prepare<[], { count: bigint }>(
      "SELECT COUNT(*) AS count FROM snapshots",
    ).get()?.count).toBe(0n);

    // Simulate residue left by a hard process exit after rename and during a
    // later backup. With no immutable metadata row, both files are recoverable orphans.
    writeFileSync(finalPath, "orphaned-final");
    writeFileSync(`${finalPath}.tmp`, "orphaned-temporary");

    const retry = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    await expect(retry.create({ createdWall: "retry-wall" })).resolves.toMatchObject({
      id: "snap_00000000",
      tick: 0,
    });
  });

  it("excludes wall-time and migration metadata while hashing logical state", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(first, "wall-one");
    insertRunWithWallTime(second, "wall-two");
    second.prepare(`
      UPDATE schema_migrations SET name = 'non_authoritative', checksum = 'ignored'
    `).run();

    const expected = computeLogicalStateHash(first, TEST_RUN_ID);
    expect(computeLogicalStateHash(second, TEST_RUN_ID)).toBe(expected);

    new SqliteScheduler(second, TEST_RUN_ID).schedule({
      id: "task_00000001",
      dueTick: 10,
      order: 0,
      taskRef: "demo.task",
      payload: { amount: 10n },
    });
    expect(computeLogicalStateHash(second, TEST_RUN_ID)).not.toBe(expected);
  });

  it("keeps snapshot rows/files immutable, rejects duplicate ticks, and validates restore paths", async () => {
    const { dataDir, db } = createRunDatabase();
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await store.create({ createdWall: "snapshot-wall" });
    const filePath = snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    );
    const originalBytes = readFileSync(filePath);

    await expect(store.create({ createdWall: "duplicate" })).rejects.toThrow(EngineError);
    expect(readFileSync(filePath).equals(originalBytes)).toBe(true);
    expect(() => db.prepare("UPDATE snapshots SET tick = tick + 1").run()).toThrow(
      /snapshots are immutable/,
    );
    expect(() => db.prepare("DELETE FROM snapshots").run()).toThrow(
      /snapshots are immutable/,
    );
    expect(() => db.prepare(`
      INSERT INTO snapshots(id, run_id, tick, state_hash, relative_path, created_wall)
      VALUES ('snap_00000001', ?, ?, ?, 'other.db', 'wall')
    `).run(TEST_RUN_ID, snapshot.tick, snapshot.stateHash)).toThrow(/UNIQUE/);

    expect(() => store.restoreTo(snapshot.id, worldDatabasePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ))).toThrow(/live database/);
    expect(() => store.restoreTo(snapshot.id, join(dataDir, "..", "outside.db"))).toThrow(
      EngineError,
    );
    expect(() => snapshotFilePath(
      dataDir,
      "../outside",
      TEST_RUN_ID,
      snapshot.id,
    )).toThrow(EngineError);
  });
});
