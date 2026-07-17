import { describe, expect, it } from "vitest";
import {
  replayRequestSchema,
  replayRunSchema,
} from "./replay";

describe("replay contracts", () => {
  it("defaults requests to strict mode and rejects unsafe targets", () => {
    expect(replayRequestSchema.parse({ toTick: 12 })).toEqual({
      toTick: 12,
      mode: "strict",
    });
    expect(() => replayRequestSchema.parse({ toTick: -1, mode: "observe" })).toThrow();
    expect(() => replayRequestSchema.parse({ mode: "best_effort" })).toThrow();
  });

  it("requires internally consistent terminal and divergence summaries", () => {
    const base = {
      id: "run_00000002",
      replayOf: "run_00000001",
      sourceSimulationId: "sim_00000001",
      mode: "strict",
      toTick: 10,
      status: "completed",
      currentTick: 10,
      lastComparedSeq: 42,
      divergenceCount: 0,
      firstDivergence: null,
      sourceStateHash: "1".repeat(64),
      replayStateHash: "1".repeat(64),
      cacheArtifactDigest: "2".repeat(64),
      journalDigest: "3".repeat(64),
      startedWall: "T1",
      completedWall: "T2",
      errorCode: null,
      errorMessage: null,
    } as const;
    expect(replayRunSchema.parse(base)).toEqual(base);
    expect(() => replayRunSchema.parse({
      ...base,
      divergenceCount: 1,
    })).toThrow(/divergence summary/);
    expect(() => replayRunSchema.parse({
      ...base,
      status: "failed",
    })).toThrow(/error code/);
  });
});
