import { describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import type { EventEnvelope } from "@worldtangle/shared";
import { InMemoryEventLog } from "./event-log";

function makeEvent(seq: number, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: `evt_${(seq + 1).toString(36).padStart(8, "0")}`,
    type: "demo.event",
    schemaVersion: 1,
    simulationId: "sim_test0001",
    runId: "run_test0001",
    seq,
    tick: 1,
    simDate: "Y0001-M01-D01",
    wallTime: "2026-07-14T00:00:00.000Z",
    actor: { kind: "system", id: "engine" },
    correlationId: "cor_00000001",
    payload: { n: seq },
    ...overrides,
  };
}

describe("InMemoryEventLog", () => {
  it("appends and lists with filters", () => {
    const log = new InMemoryEventLog();
    log.append(makeEvent(0));
    log.append(makeEvent(1, { type: "other.event" }));
    log.append(makeEvent(2));
    expect(log.count()).toBe(3);
    expect(log.list({ type: "demo.event" }).map((e) => e.seq)).toEqual([0, 2]);
    expect(log.list({ fromSeq: 1 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.list({ fromSeq: 1, toSeq: 1 }).map((e) => e.seq)).toEqual([1]);
  });

  it("enforces gapless seq", () => {
    const log = new InMemoryEventLog();
    log.append(makeEvent(0));
    expect(() => log.append(makeEvent(2))).toThrow(EngineError);
    expect(() => log.append(makeEvent(0))).toThrow(EngineError);
    log.append(makeEvent(1));
    expect(log.count()).toBe(2);
  });

  it("validates a batch before appending any of it", () => {
    const log = new InMemoryEventLog();
    expect(() => log.appendBatch([makeEvent(0), makeEvent(2)])).toThrow(EngineError);
    expect(log.count()).toBe(0);

    log.appendBatch([makeEvent(0), makeEvent(1)]);
    expect(log.list().map((event) => event.seq)).toEqual([0, 1]);
  });

  it("validates the envelope schema at append time", () => {
    const log = new InMemoryEventLog();
    expect(() => log.append(makeEvent(0, { type: "Bad Type!" }))).toThrow(EngineError);
    expect(() => log.append(makeEvent(0, { simDate: "2026-01-01" }))).toThrow(EngineError);
    expect(() => log.append(makeEvent(0, { payload: undefined }))).toThrow(EngineError);
  });

  it("rejects mixed run identity and duplicate event IDs", () => {
    const log = new InMemoryEventLog();
    log.append(makeEvent(0));
    expect(() =>
      log.append(makeEvent(1, { runId: "run_other001" })),
    ).toThrow(EngineError);
    expect(() =>
      log.append(makeEvent(1, { eventId: "evt_00000001" })),
    ).toThrow(EngineError);
    expect(log.count()).toBe(1);
  });

  it("stores detached, deeply immutable events", () => {
    const log = new InMemoryEventLog();
    const payload = { nested: { amount: 10n } };
    log.append(makeEvent(0, { payload }));
    payload.nested.amount = 20n;
    const stored = log.list()[0]!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.payload)).toBe(true);
    expect((stored.payload as typeof payload).nested.amount).toBe(10n);
    expect(() => {
      (stored.payload as typeof payload).nested.amount = 30n;
    }).toThrow();
  });

  it("logHash excludes wallTime but covers everything else (ADR-0009)", () => {
    const a = new InMemoryEventLog();
    const b = new InMemoryEventLog();
    a.append(makeEvent(0, { wallTime: "2026-01-01T00:00:00.000Z" }));
    b.append(makeEvent(0, { wallTime: "2030-12-31T23:59:59.999Z" }));
    expect(a.logHash()).toBe(b.logHash());

    const c = new InMemoryEventLog();
    c.append(makeEvent(0, { payload: { n: 999 } }));
    expect(c.logHash()).not.toBe(a.logHash());
  });

  it("hashes bigint payloads via the canonical codec", () => {
    const log = new InMemoryEventLog();
    log.append(makeEvent(0, { payload: { amount: 123456789012345678901234567890n } }));
    expect(log.logHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
