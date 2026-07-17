import { describe, expect, it } from "vitest";
import { llmCallRecordSchema } from "./llm-call";

const base = {
  id: "llm_00000001",
  runId: "run_00000001",
  decisionId: "dec_00000001",
  agentId: "agt_00000001",
  tick: 31,
  moduleId: "agent_decisions" as const,
  purpose: "decision.tier2.founder_pricing",
  requestedTier: 2 as const,
  effectiveTier: 2 as const,
  provider: "mock",
  model: "mock-llm-v1",
  promptPackKey: "agent.decision",
  promptVersion: 1,
  promptHash: "1".repeat(64),
  schemaKey: "tier2_decision_proposal",
  schemaVersion: 1,
  requestHash: "2".repeat(64),
  cached: false,
  attempts: 1,
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 20,
  sourceEventId: "evt_00000001",
};

describe("WS-605 immutable LLM call contract", () => {
  it("accepts strict success and fallback evidence", () => {
    expect(llmCallRecordSchema.parse({
      ...base,
      status: "success",
      response: {
        actionId: "pricing.set_400",
        params: { newPriceCents: "400" },
        rationale: "bounded price choice",
      },
    })).toMatchObject({ status: "success", effectiveTier: 2 });

    expect(llmCallRecordSchema.parse({
      ...base,
      id: "llm_00000002",
      effectiveTier: 1,
      status: "fallback",
      fallbackReason: "budget_blocked",
      cached: false,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
    })).toMatchObject({ status: "fallback", effectiveTier: 1 });
  });

  it("rejects contradictory or open-ended call records", () => {
    expect(llmCallRecordSchema.safeParse({
      ...base,
      status: "success",
      effectiveTier: 1,
      response: {},
    }).success).toBe(false);
    expect(llmCallRecordSchema.safeParse({
      ...base,
      status: "fallback",
      response: {},
    }).success).toBe(false);
    expect(llmCallRecordSchema.safeParse({
      ...base,
      status: "fallback",
      extraToolCall: "forbidden",
    }).success).toBe(false);
    expect(llmCallRecordSchema.safeParse({
      ...base,
      status: "success",
      cachedInputTokens: 101,
      response: {},
    }).success).toBe(false);
  });
});
