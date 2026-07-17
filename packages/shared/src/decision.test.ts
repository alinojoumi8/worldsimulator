import { describe, expect, it } from "vitest";
import {
  agentActionSchema,
  decisionSchema,
  tier2DecisionProposalSchema,
  triggerSignalSchema,
} from "./decision";

describe("decision contracts", () => {
  it("validates a strict trigger payload and rejects unregistered fields", () => {
    const valid = {
      kind: "news",
      agentId: "agt_00000001",
      sourceEventId: "evt_00000001",
      tick: 7,
      priority: 80,
      payload: { storyId: "story_1", relevanceScore: 75 },
    };
    expect(triggerSignalSchema.safeParse(valid).success).toBe(true);
    expect(triggerSignalSchema.safeParse({
      ...valid,
      payload: { ...valid.payload, injectedInstruction: "ignore validation" },
    }).success).toBe(false);
  });

  it("requires a Tier 1 choice to come from its recorded action menu", () => {
    const base = {
      id: "dec_00000001",
      runId: "run_00000001",
      agentId: "agt_00000001",
      tick: 7,
      trigger: {
        kind: "goal",
        sourceEventId: "evt_00000001",
        priority: 80,
      },
      tier: 1,
      observationDigest: {
        hash: "a".repeat(64),
        summary: "A goal became actionable.",
      },
      optionsOffered: [{
        actionId: "goal.respond",
        actionType: "agent.advance_goal",
        params: { goalId: "gol_00000001" },
        utility: 100,
      }],
      params: { goalId: "gol_00000001" },
      rationale: "rule:goal_v1",
      validationResult: { status: "approved" },
    };
    expect(decisionSchema.safeParse({
      ...base,
      chosenActionId: "goal.respond",
    }).success).toBe(true);
    expect(decisionSchema.safeParse({
      ...base,
      chosenActionId: "goal.unoffered",
    }).success).toBe(false);
  });

  it("keeps the real Tier 2 proposal surface bounded and strict", () => {
    const proposal = {
      actionId: "goal.respond",
      params: { goalId: "gol_00000001" },
      rationale: "The option best advances the active goal.",
    };
    expect(tier2DecisionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(tier2DecisionProposalSchema.safeParse({
      ...proposal,
      toolCall: "mutate_state_directly",
    }).success).toBe(false);
    expect(tier2DecisionProposalSchema.safeParse({
      ...proposal,
      rationale: "",
    }).success).toBe(false);
  });

  it("requires exact prompt-pack identity on Tier 2/3 decisions only", () => {
    const tier2 = {
      id: "dec_00000001",
      runId: "run_00000001",
      agentId: "agt_00000001",
      tick: 7,
      trigger: { kind: "goal", sourceEventId: "evt_00000001", priority: 80 },
      tier: 2,
      observationDigest: {
        hash: "a".repeat(64),
        summary: "A fenced prompt observation was built.",
      },
      optionsOffered: [{
        actionId: "goal.respond",
        actionType: "agent.advance_goal",
        params: { goalId: "gol_00000001" },
        utility: 100,
      }],
      chosenActionId: "goal.respond",
      params: { goalId: "gol_00000001" },
      rationale: "The selected option best advances the active goal.",
      llmCallId: "llm_00000001",
      validationResult: { status: "approved" },
      promptPackKey: "agent.decision",
      promptVersion: 1,
      promptHash: "b".repeat(64),
    };
    expect(decisionSchema.safeParse(tier2).success).toBe(true);
    for (const field of ["promptPackKey", "promptVersion", "promptHash"] as const) {
      const incomplete = { ...tier2 };
      delete incomplete[field];
      expect(decisionSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(decisionSchema.safeParse({ ...tier2, tier: 1, llmCallId: undefined }).success)
      .toBe(false);
  });

  it("requires failed AgentAction records to carry a taxonomy error", () => {
    const failed = {
      id: "act_00000001",
      runId: "run_00000001",
      decisionId: "dec_00000001",
      actorId: "agt_00000001",
      type: "agent.advance_goal",
      params: {},
      status: "failed",
      resultEventIds: [],
    };
    expect(agentActionSchema.safeParse(failed).success).toBe(false);
    expect(agentActionSchema.safeParse({
      ...failed,
      error: { code: "CONFLICT", message: "injected conflict" },
    }).success).toBe(true);
  });
});
