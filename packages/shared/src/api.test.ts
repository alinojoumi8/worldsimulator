import { describe, expect, it } from "vitest";
import {
  advanceSimulationRequestSchema,
  apiRootResponseSchema,
  agentDecisionListResponseSchema,
  agentDecisionListQuerySchema,
  agentListQuerySchema,
  createSimulationRequestSchema,
  eventListQuerySchema,
  relationshipListQuerySchema,
  simulationListQuerySchema,
} from "./api";

const createRequest = {
  name: "baseline-riverbend",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: { income_tax_rate_bp: 1_800 },
    endTick: 360,
  },
};

describe("API request schemas", () => {
  it("pins the simulated API-root metadata contract", () => {
    expect(apiRootResponseSchema.parse({
      name: "WorldTangle",
      simulated: true,
      apiVersion: 1,
      engineVersion: "0.1.0",
      eventSchemaVersion: 1,
      rulesetVersion: 1,
      promptPackVersion: 1,
      links: {
        health: "/api/v1/health",
        version: "/api/v1/version",
        simulations: "/api/v1/simulations",
      },
    }).simulated).toBe(true);
  });

  it("accepts the documented simulation request", () => {
    expect(createSimulationRequestSchema.parse(createRequest)).toEqual(createRequest);
  });

  it("rejects unknown fields and malformed scenario inputs", () => {
    expect(
      createSimulationRequestSchema.safeParse({ ...createRequest, ignored: true }).success,
    ).toBe(false);
    expect(
      createSimulationRequestSchema.safeParse({
        ...createRequest,
        scenario: { ...createRequest.scenario, endTick: 0 },
      }).success,
    ).toBe(false);
  });

  it("bounds manual advance to 1..1000 ticks", () => {
    expect(advanceSimulationRequestSchema.parse({ ticks: 1 })).toEqual({ ticks: 1 });
    expect(advanceSimulationRequestSchema.safeParse({ ticks: 1_001 }).success).toBe(false);
  });

  it("coerces bounded pagination values from query strings", () => {
    expect(simulationListQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(simulationListQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("validates event filters and tick ranges", () => {
    expect(
      eventListQuerySchema.parse({ fromTick: "2", toTick: "4", type: "simulation.paused" }),
    ).toMatchObject({ fromTick: 2, toTick: 4, limit: 50 });
    expect(eventListQuerySchema.safeParse({ fromTick: "4", toTick: "2" }).success).toBe(false);
  });

  it("validates agent filters and deterministic feed ranges", () => {
    expect(agentListQuerySchema.parse({
      limit: "25",
      occupation: "nurse",
      employmentStatus: "employed",
      search: "  Rivera  ",
    })).toEqual({
      limit: 25,
      occupation: "nurse",
      employmentStatus: "employed",
      search: "Rivera",
    });
    expect(relationshipListQuerySchema.parse({ limit: "2", type: "friend" }))
      .toMatchObject({ limit: 2, type: "friend" });
    expect(agentDecisionListQuerySchema.parse({ tier: "1", fromTick: "1", toTick: "31" }))
      .toMatchObject({ tier: 1, fromTick: 1, toTick: 31, limit: 50 });
    expect(agentDecisionListQuerySchema.safeParse({ fromTick: "31", toTick: "1" }).success)
      .toBe(false);
  });

  it("exposes complete prompt identity for inspectable LLM decisions", () => {
    const response = agentDecisionListResponseSchema.parse({
      items: [{
        id: "dec_00000001",
        tick: 7,
        trigger: { kind: "goal", sourceEventId: "evt_00000001" },
        tier: 2,
        observation: { hash: "a".repeat(64), summary: "Fenced goal observation." },
        optionsOffered: [{ actionId: "goal.respond", summary: "advance utility=100" }],
        chosen: { actionId: "goal.respond", params: { goalId: "gol_00000001" } },
        rationale: "The offered action best advances the goal.",
        validation: { result: "approved" },
        llm: {
          callId: "llm_00000001",
          promptPackKey: "agent.decision",
          promptVersion: 1,
          promptHash: "b".repeat(64),
        },
      }],
      nextCursor: null,
      meta: { simulated: true, apiVersion: 1 },
    });
    expect(response.items[0]?.llm?.promptHash).toBe("b".repeat(64));
    expect(agentDecisionListResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], llm: { callId: "llm_00000001" } }],
    }).success).toBe(false);
  });
});
