import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "@worldtangle/shared";
import { openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteEvidencePathReadStore } from "./evidence-path-read-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-evidence-path-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  return {
    db,
    store: new SqliteEvidencePathReadStore(db, TEST_RUN_ID),
  };
}

function insertEvent(
  db: WorldDatabase,
  {
    seq,
    eventId,
    type,
    correlationId,
    causationId = null,
  }: {
    readonly seq: number;
    readonly eventId: string;
    readonly type: string;
    readonly correlationId: string;
    readonly causationId?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO events(
      run_id, seq, event_id, type, schema_version, tick, sim_date, wall_time,
      actor_kind, actor_id, correlation_id, causation_id, payload_canonical
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'system', 'test', ?, ?, ?)
  `).run(
    TEST_RUN_ID,
    seq,
    eventId,
    type,
    seq + 1,
    `Y0001-M01-D0${seq + 2}`,
    "2026-07-24T12:00:00.000Z",
    correlationId,
    causationId,
    canonicalStringify({ seq }),
  );
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteEvidencePathReadStore", () => {
  it("separates explicit origin, booked state, and downstream effects", () => {
    const { db, store } = fixture();
    const correlationId = "experiment:fuel-shock";
    insertEvent(db, {
      seq: 0,
      eventId: "evt_00000001",
      type: "world.event.applied",
      correlationId,
    });
    insertEvent(db, {
      seq: 1,
      eventId: "evt_00000002",
      type: "energy.fuel_price.updated",
      correlationId: "world-event:wev_00000001",
      causationId: "evt_00000001",
    });
    db.prepare(`
      INSERT INTO ledger_transactions(
        run_id, id, tick, kind, actor_kind, actor_id, reason, source_event_id,
        correlation_id, idempotency_key, request_hash
      ) VALUES (?, ?, 1, 'transfer', 'system', 'test', ?, ?, ?, ?, ?)
    `).run(
      TEST_RUN_ID,
      "txn_00000001",
      "Explicit test posting",
      "evt_00000001",
      correlationId,
      "evidence-path-test",
      "0".repeat(64),
    );

    const path = store.resolve(correlationId);

    expect(path.origin.state).toBe("booked");
    expect(path.origin.items).toMatchObject([{
      kind: "event",
      id: "evt_00000001",
      tick: 1,
    }]);
    expect(path.booked.state).toBe("booked");
    expect(path.booked.items).toContainEqual(expect.objectContaining({
      kind: "transaction",
      id: "txn_00000001",
      eventId: "evt_00000001",
    }));
    expect(path.downstream.state).toBe("booked");
    expect(path.downstream.items).toContainEqual(expect.objectContaining({
      kind: "event",
      id: "evt_00000002",
      eventId: "evt_00000002",
    }));
  });

  it("reports absent links explicitly instead of inventing a causal path", () => {
    const { store } = fixture();

    const path = store.resolve("missing:correlation");

    expect(path.origin.state).toBe("broken_link");
    expect(path.booked.state).toBe("broken_link");
    expect(path.downstream.state).toBe("broken_link");
    expect(path.origin.items).toEqual([]);
    expect(path.booked.items).toEqual([]);
    expect(path.downstream.items).toEqual([]);
  });

  it("does not treat a shared correlation as downstream causation", () => {
    const { db, store } = fixture();
    const correlationId = "experiment:shared-correlation";
    insertEvent(db, {
      seq: 0,
      eventId: "evt_00000001",
      type: "experiment.started",
      correlationId,
    });
    insertEvent(db, {
      seq: 1,
      eventId: "evt_00000002",
      type: "unrelated.observation",
      correlationId,
    });

    const path = store.resolve(correlationId);

    expect(path.origin.items.map((item) => item.id)).toEqual(["evt_00000001"]);
    expect(path.downstream.state).toBe("pending");
    expect(path.downstream.items).toEqual([]);
  });

  it("distinguishes a terminal no-effect result from a pending result", () => {
    const { db, store } = fixture();
    insertEvent(db, {
      seq: 0,
      eventId: "evt_00000001",
      type: "experiment.started",
      correlationId: "experiment:no-effect",
    });
    db.prepare(`
      UPDATE simulation_runs
      SET status = 'completed', current_tick = end_tick, ended_wall = ?
      WHERE id = ?
    `).run("2026-07-24T12:01:00.000Z", TEST_RUN_ID);

    const path = store.resolve("experiment:no-effect");

    expect(path.origin.state).toBe("booked");
    expect(path.booked.state).toBe("no_effect");
    expect(path.downstream.state).toBe("no_effect");
  });
});
