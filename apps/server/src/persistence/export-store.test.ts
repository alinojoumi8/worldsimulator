import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabaseFile,
  openWorldDatabase,
} from "./database";
import { SqliteExportStore } from "./export-store";
import {
  computeLogicalStateHash,
  snapshotFilePath,
  SqliteSnapshotStore,
} from "./snapshot-store";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";

const directories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-export-store-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteExportStore", () => {
  it("persists hash-neutral jobs and causal audit events through reopen and restore", async () => {
    const dataDir = temporaryDirectory();
    const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    insertTestRun(db);
    const stateHashBefore = computeLogicalStateHash(db, TEST_RUN_ID);
    const store = new SqliteExportStore(db, TEST_RUN_ID);
    const queued = store.create({
      simulationId: TEST_SIMULATION_ID,
      format: "jsonl",
      datasets: ["events", "transactions"],
      sourceTick: 0,
      sourceStateHash: stateHashBefore,
      correlationId: "request-1",
      createdWall: "T1",
    });
    expect(queued.id).toBe("xpt_0000000100000001");
    expect(queued.auditEvents.map((event) => event.type)).toEqual(["export.job.queued"]);

    const running = store.markRunning(queued.id, "T2");
    expect(running.auditEvents[1]?.causationId).toBe(running.auditEvents[0]?.id);
    const completed = store.complete(queued.id, {
      files: [
        {
          dataset: "events",
          format: "jsonl",
          path: `exports/${queued.id}/events-${"1".repeat(64)}.jsonl`,
          bytes: 100,
          rows: 2,
          sha256: "1".repeat(64),
        },
        {
          dataset: "transactions",
          format: "jsonl",
          path: `exports/${queued.id}/transactions-${"2".repeat(64)}.jsonl`,
          bytes: 200,
          rows: 3,
          sha256: "2".repeat(64),
        },
      ],
      manifest: {
        path: `exports/${queued.id}/manifest.json`,
        bytes: 300,
        sha256: "3".repeat(64),
      },
      completedWall: "T3",
    });
    expect(completed.status).toBe("completed");
    expect(completed.auditEvents.map((event) => event.type)).toEqual([
      "export.job.queued",
      "export.job.started",
      "export.job.completed",
    ]);
    expect(completed.auditEvents[2]?.causationId).toBe(completed.auditEvents[1]?.id);
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).toBe(stateHashBefore);

    expect(() => db.transaction(() => {
      store.create({
        simulationId: TEST_SIMULATION_ID,
        format: "csv",
        datasets: ["indicators"],
        sourceTick: 0,
        sourceStateHash: stateHashBefore,
        correlationId: "rolled-back",
        createdWall: "T4",
      });
      throw new Error("rollback");
    }).immediate()).toThrow("rollback");
    expect(db.prepare<[], { count: bigint }>(
      "SELECT COUNT(*) AS count FROM export_jobs",
    ).get()?.count).toBe(1n);
    expect(() => db.prepare("UPDATE export_jobs SET status = 'failed'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM export_events").run()).toThrow(/append-only/);

    const snapshotStore = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshotStore.create({ createdWall: "T5" });
    db.close();

    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    expect(new SqliteExportStore(reopened, TEST_RUN_ID).get(queued.id)).toEqual(completed);
    reopened.close();

    const restored = openDatabaseFile(snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    ));
    expect(new SqliteExportStore(restored, TEST_RUN_ID).get(queued.id)).toEqual(completed);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    restored.close();
  });
});
