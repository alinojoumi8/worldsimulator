import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@worldtangle/shared";
import { EventBus } from "./bus";

function makeEvent(seq: number, type: string): EventEnvelope {
  return {
    eventId: `evt_${seq.toString(36).padStart(8, "0")}`,
    type,
    schemaVersion: 1,
    simulationId: "sim_test0001",
    runId: "run_test0001",
    seq,
    tick: 1,
    simDate: "Y0001-M01-D01",
    wallTime: "T0",
    actor: { kind: "system", id: "engine" },
    correlationId: "cor_00000001",
    payload: {},
  };
}

describe("EventBus", () => {
  it("runs handlers in registration order, sink first", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.setSink(() => order.push("sink"));
    bus.subscribe("a.b", () => order.push("first"));
    bus.subscribe("a.b", () => order.push("second"));
    bus.subscribe("*", () => order.push("wildcard"));
    bus.publish(makeEvent(0, "a.b"));
    expect(order).toEqual(["sink", "first", "second", "wildcard"]);
  });

  it("queues nested publishes FIFO (no re-entrancy)", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.setSink((e) => order.push(`sink:${e.type}`));
    bus.subscribe("first.event", () => {
      bus.publish(makeEvent(1, "second.event"));
      order.push("handler:first");
    });
    bus.subscribe("second.event", () => order.push("handler:second"));
    bus.publish(makeEvent(0, "first.event"));
    expect(order).toEqual([
      "sink:first.event",
      "handler:first",
      "sink:second.event",
      "handler:second",
    ]);
  });

  it("only delivers to matching type handlers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("x.y", (e) => seen.push(e.type));
    bus.publish(makeEvent(0, "other.type"));
    bus.publish(makeEvent(1, "x.y"));
    expect(seen).toEqual(["x.y"]);
  });

  it("rejects a second sink", () => {
    const bus = new EventBus();
    bus.setSink(() => undefined);
    expect(() => bus.setSink(() => undefined)).toThrow();
  });

  it("discards nested queued events when dispatch fails", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let shouldFail = true;
    bus.setSink((event) => seen.push(event.type));
    bus.subscribe("first.event", () => {
      bus.publish(makeEvent(1, "nested.event"));
      if (shouldFail) throw new Error("injected subscriber failure");
    });

    expect(() => bus.publish(makeEvent(0, "first.event"))).toThrow(
      "injected subscriber failure",
    );
    expect(seen).toEqual(["first.event"]);

    shouldFail = false;
    bus.publish(makeEvent(0, "first.event"));
    expect(seen).toEqual(["first.event", "first.event", "nested.event"]);
  });
});
