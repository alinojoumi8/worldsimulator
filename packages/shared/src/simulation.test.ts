import { describe, expect, it } from "vitest";
import {
  idFactoryStateSchema,
  runCheckpointSchema,
  runStatusSchema,
  simulationIdSchema,
  simulationRunSchema,
} from "./simulation";

describe("simulation persistence schemas", () => {
  it("validates deterministic simulation IDs and run statuses", () => {
    expect(simulationIdSchema.parse("sim_0000000a")).toBe("sim_0000000a");
    expect(runStatusSchema.parse("paused")).toBe("paused");
    expect(() => simulationIdSchema.parse("../world.db")).toThrow();
    expect(() => runStatusSchema.parse("starting")).toThrow();
  });

  it("validates serializable ID-factory checkpoints", () => {
    expect(idFactoryStateSchema.parse({ evt: 12, task: 3 })).toEqual({ evt: 12, task: 3 });
    expect(() => idFactoryStateSchema.parse({ evt: -1 })).toThrow();
    expect(() => idFactoryStateSchema.parse({ "../evt": 1 })).toThrow();
  });

  it("requires a complete, safe run checkpoint", () => {
    expect(
      runCheckpointSchema.parse({
        id: "run_00000001",
        currentTick: 12,
        nextEventSeq: 28,
        idState: { evt: 28 },
      }),
    ).toEqual({
      id: "run_00000001",
      currentTick: 12,
      nextEventSeq: 28,
      idState: { evt: 28 },
    });
    expect(() =>
      runCheckpointSchema.parse({
        id: "run_00000001",
        currentTick: Number.MAX_SAFE_INTEGER + 1,
        nextEventSeq: 28,
        idState: {},
      }),
    ).toThrow();
  });

  it("rejects contradictory persisted run records", () => {
    const valid = {
      id: "run_00000001",
      simulationId: "sim_00000001",
      status: "paused" as const,
      currentTick: 12,
      nextEventSeq: 28,
      endTick: 360,
      manifest: {
        runId: "run_00000001",
        simulationId: "sim_00000001",
        seed: 42,
        engineVersion: "0.1.0",
        rulesetVersion: 1,
        promptPackVersion: 1,
        eventSchemaVersion: 1,
        llmMode: "mock" as const,
        modelRouting: {},
        scenarioDigest: "scenario",
        worldSpecDigest: "world",
        createdWall: "T0",
      },
      idState: { evt: 28 },
      startedWall: "T1",
      endedWall: null,
    };
    expect(simulationRunSchema.parse(valid).currentTick).toBe(12);
    expect(() =>
      simulationRunSchema.parse({
        ...valid,
        manifest: { ...valid.manifest, runId: "run_00000002" },
      }),
    ).toThrow();
    expect(() => simulationRunSchema.parse({ ...valid, currentTick: 361 })).toThrow();
    expect(() => simulationRunSchema.parse({ ...valid, idState: { evt: 27 } })).toThrow();
    expect(() => simulationRunSchema.parse({ ...valid, startedWall: null })).toThrow();
    expect(() => simulationRunSchema.parse({ ...valid, endedWall: "T2" })).toThrow();
  });
});
