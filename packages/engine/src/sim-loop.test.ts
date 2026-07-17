import { describe, expect, it } from "vitest";
import { EngineError, IdFactory } from "@worldtangle/shared";
import { EventBus } from "./bus";
import { InMemoryEventLog } from "./event-log";
import {
  dayOfMonth,
  isPayrollDay,
  PHASES,
  simDateForTick,
  SimLoop,
} from "./sim-loop";

function buildLoop(seed: number | string = 42) {
  const bus = new EventBus();
  const log = new InMemoryEventLog();
  const loop = new SimLoop({
    simulationId: "sim_test0001",
    runId: "run_test0001",
    seed,
    bus,
    log,
    wallClock: () => "1970-01-01T00:00:00.000Z",
  });
  return { loop, log, bus };
}

describe("calendar (360-day year, ADR-0005)", () => {
  it("maps ticks to sim dates", () => {
    expect(simDateForTick(0)).toBe("Y0001-M01-D01"); // genesis
    expect(simDateForTick(1)).toBe("Y0001-M01-D01");
    expect(simDateForTick(15)).toBe("Y0001-M01-D15");
    expect(simDateForTick(30)).toBe("Y0001-M01-D30");
    expect(simDateForTick(31)).toBe("Y0001-M02-D01");
    expect(simDateForTick(360)).toBe("Y0001-M12-D30");
    expect(simDateForTick(361)).toBe("Y0002-M01-D01");
    expect(simDateForTick(720 + 45)).toBe("Y0003-M02-D15");
  });

  it("computes day-of-month and payroll days (D15/D30)", () => {
    expect(dayOfMonth(1)).toBe(1);
    expect(dayOfMonth(30)).toBe(30);
    expect(dayOfMonth(31)).toBe(1);
    expect(isPayrollDay(15)).toBe(true);
    expect(isPayrollDay(30)).toBe(true);
    expect(isPayrollDay(45)).toBe(true); // M2 D15
    expect(isPayrollDay(16)).toBe(false);
  });

  it("rejects invalid ticks", () => {
    expect(() => simDateForTick(-1)).toThrow(EngineError);
    expect(() => simDateForTick(1.5)).toThrow(EngineError);
    expect(() => dayOfMonth(0)).toThrow(EngineError);
  });
});

describe("SimLoop", () => {
  it("runs phases in pipeline order, handlers by (order, module)", () => {
    const { loop } = buildLoop();
    const ran: string[] = [];
    // register deliberately out of order
    loop.registerPhase("settlement", {
      module: "m-b",
      order: 10,
      run: () => void ran.push("settlement:m-b"),
    });
    loop.registerPhase("obligations", {
      module: "m-z",
      order: 5,
      run: () => void ran.push("obligations:m-z"),
    });
    loop.registerPhase("settlement", {
      module: "m-a",
      order: 10,
      run: () => void ran.push("settlement:m-a"),
    });
    loop.registerPhase("settlement", {
      module: "m-c",
      order: 1,
      run: () => void ran.push("settlement:m-c"),
    });
    loop.tick();
    expect(ran).toEqual([
      "obligations:m-z",
      "settlement:m-c",
      "settlement:m-a",
      "settlement:m-b",
    ]);
  });

  it("emits tick.started and tick.completed with event counts", () => {
    const { loop, log } = buildLoop();
    loop.registerPhase("decisions", {
      module: "demo",
      order: 1,
      run: (ctx) => void ctx.emit("demo.thing_happened", { ok: true }),
    });
    loop.tick();
    loop.tick();
    expect(loop.currentTick).toBe(2);

    const started = log.list({ type: "simulation.tick.started" });
    const completed = log.list({ type: "simulation.tick.completed" });
    expect(started.map((e) => e.tick)).toEqual([1, 2]);
    expect(completed.map((e) => e.tick)).toEqual([1, 2]);
    // started + demo event + completed = 3 events per tick
    expect((completed[0]!.payload as { counts: { events: number } }).counts.events).toBe(3);
    expect(completed[0]!.payload).toMatchObject({
      counts: { events: 3, transactions: 0, decisions: 0, llmCalls: 0 },
      durationMs: 0,
    });
    expect(log.count()).toBe(6);
  });

  it("reports best-effort phase timings without affecting authoritative ticks", () => {
    const samples: Array<{ tick: number; phase: string; durationMs: number }> = [];
    let time = 0;
    const loop = new SimLoop({
      simulationId: "sim_test",
      runId: "run_test",
      seed: 1,
      bus: new EventBus(),
      log: new InMemoryEventLog(),
      wallClock: () => "T0",
      monotonicClock: () => time++,
      phaseObserver: (sample) => {
        samples.push(sample);
        if (sample.phase === "decisions") throw new Error("telemetry sink failed");
      },
    });

    expect(loop.tick()).toBe(1);
    expect(samples).toHaveLength(PHASES.length);
    expect(samples.map((sample) => sample.phase)).toEqual(PHASES);
    expect(samples.every((sample) => sample.tick === 1 && sample.durationMs === 1)).toBe(true);
  });

  it("gives handlers tick context with date, ids, and named rng streams", () => {
    const { loop } = buildLoop();
    let seen: { tick: number; simDate: string; phase: string } | undefined;
    loop.registerPhase("metrics", {
      module: "demo",
      order: 1,
      run: (ctx) => {
        seen = { tick: ctx.tick, simDate: ctx.simDate, phase: ctx.phase };
        const a = ctx.rng("stream").nextUint32();
        const b = ctx.rng("stream").nextUint32();
        expect(a).toBe(b); // same named stream, fresh fork each call
      },
    });
    loop.tick();
    expect(seen).toEqual({ tick: 1, simDate: "Y0001-M01-D01", phase: "metrics" });
  });

  it("advance runs N ticks and validates input", () => {
    const { loop } = buildLoop();
    expect(loop.advance(5)).toBe(5);
    expect(loop.currentTick).toBe(5);
    expect(() => loop.advance(0)).toThrow(EngineError);
    expect(() => loop.advance(1.5)).toThrow(EngineError);
  });

  it("rolls back staged events, sequence, IDs, and tick when a handler fails", () => {
    const { loop, log } = buildLoop();
    let shouldFail = true;
    loop.registerPhase("decisions", {
      module: "fallible",
      order: 1,
      run: (ctx) => {
        ctx.emit("demo.before_failure", {});
        if (shouldFail) throw new Error("injected failure");
      },
    });

    expect(() => loop.tick()).toThrow("injected failure");
    expect(loop.currentTick).toBe(0);
    expect(loop.nextEventSeq).toBe(0);
    expect(loop.idState).toEqual({});
    expect(log.count()).toBe(0);

    shouldFail = false;
    expect(loop.tick()).toBe(1);
    expect(log.list().map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(log.list().map((event) => event.eventId)).toEqual([
      "evt_00000001",
      "evt_00000002",
      "evt_00000003",
    ]);
  });

  it("uses an atomic tick committer and rolls back if commit fails", () => {
    const bus = new EventBus();
    const log = new InMemoryEventLog();
    let failCommit = true;
    let insideUnitOfWork = false;
    const loop = new SimLoop({
      simulationId: "sim_test0001",
      runId: "run_test0001",
      seed: 42,
      bus,
      log,
      wallClock: () => "T0",
      tickUnitOfWork: {
        execute(work) {
          insideUnitOfWork = true;
          try {
            work();
          } finally {
            insideUnitOfWork = false;
          }
        },
      },
      tickCommitter: {
        commitTick(commit) {
          expect(insideUnitOfWork).toBe(true);
          if (failCommit) throw new Error("commit failed");
          log.appendBatch(commit.events);
        },
      },
    });

    expect(() => loop.tick()).toThrow("commit failed");
    expect(loop.currentTick).toBe(0);
    expect(log.count()).toBe(0);

    failCommit = false;
    expect(loop.tick()).toBe(1);
    expect(log.count()).toBe(2);
  });

  it("rejects a persisted committer without a tick unit of work", () => {
    expect(() =>
      new SimLoop({
        simulationId: "sim_test0001",
        runId: "run_test0001",
        seed: 42,
        bus: new EventBus(),
        log: new InMemoryEventLog(),
        wallClock: () => "T0",
        tickCommitter: { commitTick: () => undefined },
      }),
    ).toThrow("requires a tick unit of work");
  });

  it("resumes from a persisted tick, event sequence, and ID state", () => {
    const first = buildLoop();
    first.loop.advance(2);
    expect(first.log.count()).toBe(4);

    const resumed = new SimLoop({
      simulationId: "sim_test0001",
      runId: "run_test0001",
      seed: 42,
      bus: new EventBus(),
      log: first.log,
      ids: IdFactory.restore(first.loop.idState as Record<string, number>),
      initialTick: 2,
      nextSeq: 4,
      wallClock: () => "T0",
    });
    expect(resumed.tick()).toBe(3);
    expect(first.log.list().slice(-2).map((event) => [event.seq, event.eventId])).toEqual([
      [4, "evt_00000005"],
      [5, "evt_00000006"],
    ]);
  });

  it("rejects a resumed ID checkpoint inconsistent with the event sequence", () => {
    const first = buildLoop();
    first.loop.tick();
    expect(() =>
      new SimLoop({
        simulationId: "sim_test0001",
        runId: "run_test0001",
        seed: 42,
        bus: new EventBus(),
        log: first.log,
        ids: new IdFactory(),
        initialTick: 1,
        nextSeq: 2,
        wallClock: () => "T0",
      }),
    ).toThrow(EngineError);
  });

  it("exposes the full phase list in fixed order", () => {
    expect(PHASES).toEqual([
      "obligations",
      "perception",
      "decisions",
      "collect",
      "execute",
      "clearing",
      "settlement",
      "news",
      "metrics",
      "commit",
    ]);
  });
});
