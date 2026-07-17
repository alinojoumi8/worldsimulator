import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabaseFile,
  openWorldDatabase,
} from "./database";
import {
  computeLogicalStateHash,
  snapshotFilePath,
  SqliteSnapshotStore,
} from "./snapshot-store";
import { SqliteReplayStore } from "./replay-store";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";

const directories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-replay-store-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteReplayStore", () => {
  it("persists hash-neutral metadata and divergences through reopen and snapshot restore", async () => {
    const dataDir = temporaryDirectory();
    const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    insertTestRun(db);
    const stateHashBefore = computeLogicalStateHash(db, TEST_RUN_ID);
    const store = new SqliteReplayStore(db, TEST_RUN_ID);
    store.create({
      runId: TEST_RUN_ID,
      sourceSimulationId: TEST_SIMULATION_ID,
      sourceRunId: TEST_RUN_ID,
      mode: "observe",
      toTick: 0,
      cacheArtifactDigest: "1".repeat(64),
      journalDigest: "2".repeat(64),
      startedWall: "T1",
    });
    store.recordDivergence({
      tick: 0,
      kind: "event_mismatch",
      expectedHash: "3".repeat(64),
      actualHash: "4".repeat(64),
      details: { seq: 7, reason: "injected test mismatch" },
      createdWall: "T2",
    });
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).toBe(stateHashBefore);

    expect(() => db.transaction(() => {
      store.recordDivergence({
        tick: 0,
        kind: "state_hash_mismatch",
        details: { rolledBack: true },
        createdWall: "T3",
      });
      throw new Error("rollback");
    }).immediate()).toThrow("rollback");
    expect(store.require().divergenceCount).toBe(1);

    const snapshotStore = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshotStore.create({ createdWall: "T4" });
    const expectedReplay = store.require();
    db.close();

    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    expect(new SqliteReplayStore(reopened, TEST_RUN_ID).require()).toEqual(expectedReplay);
    reopened.close();

    const restored = openDatabaseFile(snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    ));
    expect(new SqliteReplayStore(restored, TEST_RUN_ID).require()).toEqual(expectedReplay);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    restored.close();
  });
});
