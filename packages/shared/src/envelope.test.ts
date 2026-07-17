import { describe, expect, it } from "vitest";
import {
  ENGINE_ERROR_CODES,
  EngineError,
  engineErrorCodeSchema,
  eventEnvelopeSchema,
  intentEnvelopeSchema,
  runManifestSchema,
} from "./envelope";

const validEvent = {
  eventId: "evt_00000001",
  type: "simulation.tick.completed",
  schemaVersion: 1,
  simulationId: "sim_00000001",
  runId: "run_00000001",
  seq: 0,
  tick: 1,
  simDate: "Y0001-M01-D01",
  wallTime: "2026-07-14T00:00:00.000Z",
  actor: { kind: "system", id: "engine" },
  correlationId: "evt_00000001",
  payload: { tick: 1 },
};

describe("eventEnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    expect(eventEnvelopeSchema.safeParse(validEvent).success).toBe(true);
  });

  it("accepts an optional causationId", () => {
    const result = eventEnvelopeSchema.safeParse({ ...validEvent, causationId: "evt_00000000" });
    expect(result.success).toBe(true);
  });

  it("rejects malformed type names", () => {
    for (const type of ["Bad.Type", "loan..approved", ".loan", "loan.", "LOAN"]) {
      expect(eventEnvelopeSchema.safeParse({ ...validEvent, type }).success).toBe(false);
    }
  });

  it("rejects invalid sim dates (360-day calendar)", () => {
    for (const simDate of ["Y0001-M13-D01", "Y0001-M01-D31", "Y0001-M00-D01", "2026-01-01"]) {
      expect(eventEnvelopeSchema.safeParse({ ...validEvent, simDate }).success).toBe(false);
    }
    expect(
      eventEnvelopeSchema.safeParse({ ...validEvent, simDate: "Y0001-M12-D30" }).success,
    ).toBe(true);
  });

  it("rejects negative seq/tick and bad actor kinds", () => {
    expect(eventEnvelopeSchema.safeParse({ ...validEvent, seq: -1 }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...validEvent, tick: -1 }).success).toBe(false);
    expect(
      eventEnvelopeSchema.safeParse({ ...validEvent, actor: { kind: "robot", id: "x" } }).success,
    ).toBe(false);
  });
});

describe("intentEnvelopeSchema", () => {
  it("accepts a valid intent", () => {
    const result = intentEnvelopeSchema.safeParse({
      intentId: "int_00000001",
      type: "banking.apply_loan",
      actor: { kind: "agent", id: "agt_00000001" },
      tick: 5,
      params: { amount: "100000" },
      decisionId: "dec_00000001",
      correlationId: "cor_00000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed ids, type names, and negative ticks", () => {
    const validIntent = {
      intentId: "int_00000001",
      type: "banking.apply_loan",
      actor: { kind: "agent", id: "agt_00000001" },
      tick: 5,
      params: { amount: "100000" },
      correlationId: "cor_00000001",
    };
    expect(intentEnvelopeSchema.safeParse({ ...validIntent, intentId: "bad" }).success).toBe(
      false,
    );
    expect(intentEnvelopeSchema.safeParse({ ...validIntent, type: "Bad.Type" }).success).toBe(
      false,
    );
    expect(intentEnvelopeSchema.safeParse({ ...validIntent, tick: -1 }).success).toBe(false);
  });
});

describe("runManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const result = runManifestSchema.safeParse({
      runId: "run_00000001",
      simulationId: "sim_00000001",
      seed: 42,
      engineVersion: "0.1.0",
      rulesetVersion: 1,
      promptPackVersion: 1,
      eventSchemaVersion: 1,
      llmMode: "mock",
      modelRouting: {
        tier2_routine: "claude-haiku-4-5-20251001",
        tier3: "claude-sonnet-5",
      },
      scenarioDigest: "abc123",
      worldSpecDigest: "def456",
      createdWall: "2026-07-14T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown llm modes", () => {
    const result = runManifestSchema.safeParse({
      runId: "r",
      simulationId: "s",
      seed: 1,
      engineVersion: "0.1.0",
      rulesetVersion: 1,
      promptPackVersion: 1,
      eventSchemaVersion: 1,
      llmMode: "hybrid",
      modelRouting: {},
      scenarioDigest: "a",
      worldSpecDigest: "b",
      createdWall: "t",
    });
    expect(result.success).toBe(false);
  });
});

describe("EngineError", () => {
  it("carries a typed code from the taxonomy", () => {
    const error = new EngineError("INSUFFICIENT_FUNDS", "not enough", { needed: 5n });
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
    expect(ENGINE_ERROR_CODES).toContain(error.code);
    expect(error.details).toEqual({ needed: 5n });
    expect(error).toBeInstanceOf(Error);
  });

  it("publishes the same stable code taxonomy through Zod", () => {
    for (const code of ENGINE_ERROR_CODES) {
      expect(engineErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(engineErrorCodeSchema.safeParse("UNKNOWN").success).toBe(false);
  });
});
