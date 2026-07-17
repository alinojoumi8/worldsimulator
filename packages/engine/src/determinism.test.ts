/**
 * The CI determinism gate (ADR-0008): the same seeded simulation, run twice,
 * must produce byte-identical event logs (wall time excluded). This test must
 * stay green forever — if it fails, something nondeterministic leaked into
 * the engine.
 */

import { describe, expect, it } from "vitest";
import { allocate, money } from "@worldtangle/shared";
import { EventBus } from "./bus";
import { InMemoryEventLog } from "./event-log";
import { SimLoop } from "./sim-loop";

function buildDemoSim(seed: number | string, wallClock: () => string) {
  const bus = new EventBus();
  const log = new InMemoryEventLog();
  const loop = new SimLoop({
    simulationId: "sim_demo00001",
    runId: "run_demo00001",
    seed,
    bus,
    log,
    wallClock,
  });

  // Demo "agents": draw from a named stream and emit decisions.
  loop.registerPhase("decisions", {
    module: "demo-agents",
    order: 10,
    run(ctx) {
      const rng = ctx.rng("choices");
      const values = [rng.int(0, 999), rng.int(0, 999), rng.int(0, 999)];
      ctx.emit("demo.decisions_made", { values });
    },
  });

  // Demo "payroll": exact bigint splits flowing through the canonical codec.
  loop.registerPhase("settlement", {
    module: "demo-payroll",
    order: 10,
    run(ctx) {
      const parts = allocate(money(100_000n), [3n, 2n, 1n]);
      ctx.emit(
        "demo.payroll_split",
        { gross: 100_000n, parts },
        { actor: { kind: "institution", id: "bank_demo001" } },
      );
    },
  });

  return { loop, log };
}

describe("determinism gate", () => {
  it("same seed twice → identical event-log hashes", () => {
    const a = buildDemoSim(42, () => "1970-01-01T00:00:00.000Z");
    const b = buildDemoSim(42, () => "1970-01-01T00:00:00.000Z");
    a.loop.advance(10);
    b.loop.advance(10);
    expect(a.log.count()).toBe(b.log.count());
    expect(a.log.logHash()).toBe(b.log.logHash());
  });

  it("wall-clock differences do not affect the hash (informational field)", () => {
    let fakeMillis = 0;
    const a = buildDemoSim(42, () => "1970-01-01T00:00:00.000Z");
    const b = buildDemoSim(42, () => `wall-${fakeMillis++}`);
    a.loop.advance(10);
    b.loop.advance(10);
    expect(a.log.logHash()).toBe(b.log.logHash());
  });

  it("different seeds → different histories", () => {
    const a = buildDemoSim(42, () => "T0");
    const b = buildDemoSim(43, () => "T0");
    a.loop.advance(10);
    b.loop.advance(10);
    expect(a.log.logHash()).not.toBe(b.log.logHash());
  });

  it("payroll splits in the demo world are exact", () => {
    const a = buildDemoSim(42, () => "T0");
    a.loop.tick();
    const split = a.log.list({ type: "demo.payroll_split" })[0]!;
    const payload = split.payload as { gross: bigint; parts: bigint[] };
    expect(payload.parts.reduce((x, y) => x + y, 0n)).toBe(payload.gross);
  });
});
