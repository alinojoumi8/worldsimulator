import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import type { EventEnvelope } from "@worldtangle/shared";
import { InMemoryEventLog } from "@worldtangle/engine";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

function makeEvent(seq: number, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: `evt_${(seq + 1).toString(36).padStart(8, "0")}`,
    type: seq % 2 === 0 ? "demo.even" : "demo.odd",
    schemaVersion: 1,
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seq,
    tick: Math.floor(seq / 2) + 1,
    simDate: "Y0001-M01-D01",
    wallTime: "T0",
    actor: { kind: "system", id: "engine" },
    correlationId: `cor_${seq.toString(36).padStart(8, "0")}`,
    payload: { seq },
    ...overrides,
  };
}

describe("SqliteEventStore", () => {
  let dataDir: string;
  let db: WorldDatabase;
  let store: SqliteEventStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "worldtangle-events-"));
    db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    insertTestRun(db);
    store = new SqliteEventStore(db, TEST_RUN_ID);
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists complete envelopes and bigint payloads across reopen", () => {
    store.appendBatch([
      makeEvent(0, { payload: { amount: 12_345_678_901_234_567_890n } }),
      makeEvent(1),
    ]);
    expect(store.count()).toBe(2);
    db.close();

    db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    store = new SqliteEventStore(db, TEST_RUN_ID);
    expect(store.list().map((event) => event.seq)).toEqual([0, 1]);
    expect((store.list()[0]!.payload as { amount: bigint }).amount).toBe(
      12_345_678_901_234_567_890n,
    );
  });

  it("validates the whole batch before insertion and enforces gaplessness", () => {
    expect(() => store.appendBatch([makeEvent(0), makeEvent(2)])).toThrow(EngineError);
    expect(store.count()).toBe(0);
    expect(() => store.append(makeEvent(0, { payload: undefined }))).toThrow(EngineError);
    expect(store.count()).toBe(0);

    store.append(makeEvent(0));
    expect(() => store.append(makeEvent(2))).toThrow(EngineError);
    expect(store.count()).toBe(1);
  });

  it("rolls back a duplicate event ID without advancing the checkpoint", () => {
    store.append(makeEvent(0));
    expect(() => store.append(makeEvent(1, { eventId: "evt_00000001" }))).toThrow();
    expect(store.count()).toBe(1);
    store.append(makeEvent(1));
    expect(store.count()).toBe(2);
  });

  it("enforces append-only rows in SQLite itself", () => {
    store.append(makeEvent(0));
    expect(() => db.prepare("UPDATE events SET type = 'demo.changed'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(store.count()).toBe(1);
  });

  it("provides deterministic keyset pages in both directions with filters", () => {
    store.appendBatch(Array.from({ length: 6 }, (_, seq) => makeEvent(seq)));
    const first = store.page({ limit: 2 });
    expect(first.items.map((event) => event.seq)).toEqual([0, 1]);
    expect(first.nextCursor).toBe(1);
    const second = store.page({ afterSeq: first.nextCursor!, limit: 2 });
    expect(second.items.map((event) => event.seq)).toEqual([2, 3]);
    expect(store.page({ beforeSeq: 6, direction: "backward", limit: 2 }).items.map((e) => e.seq)).toEqual([
      5,
      4,
    ]);
    expect(store.page({ type: "demo.even", limit: 10 }).items.map((e) => e.seq)).toEqual([
      0,
      2,
      4,
    ]);
    expect(store.page({ fromTick: 2, toTick: 2, limit: 10 }).items.map((e) => e.seq)).toEqual([
      2,
      3,
    ]);
    expect(store.list({ excludeTypePrefixes: ["demo.e"] }).map((event) => event.seq)).toEqual([
      1,
      3,
      5,
    ]);
    expect(() => store.list({ excludeTypePrefixes: [""] })).toThrow("must not be empty");
    expect(store.page({ actorId: "missing", limit: 10 }).items).toEqual([]);
  });

  it("matches the in-memory deterministic log hash", () => {
    const events = [makeEvent(0), makeEvent(1), makeEvent(2)];
    store.appendBatch(events);
    const memory = new InMemoryEventLog();
    memory.appendBatch(events);
    expect(store.logHash()).toBe(memory.logHash());
  });
});
