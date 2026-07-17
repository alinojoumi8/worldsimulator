import { describe, expect, it } from "vitest";
import type { DecisionOption } from "@worldtangle/shared";
import { ActionRegistry } from "./action-registry";
import {
  RULE_ONLY_ACTION_TYPES,
  RULE_ONLY_NO_OP_ACTION,
  registerRuleOnlyActionTypes,
} from "./decision-engine";
import { resolveLiveDecision } from "./live-decision-contract";

const agentId = "agt_00000001";
const params = {
  agentId,
  sourceEventId: "evt_00000001",
  triggerKind: "goal",
  payload: {
    goalId: "gol_00000001",
    goalKind: "start_business",
  },
};
const options: readonly DecisionOption[] = [{
  actionId: "goal.respond",
  actionType: RULE_ONLY_ACTION_TYPES.goal,
  params,
  utility: 900,
}, {
  actionId: "goal.no_op",
  actionType: RULE_ONLY_NO_OP_ACTION,
  params: {
    agentId,
    reason: "utility_below_threshold",
    sourceEventId: "evt_00000001",
  },
  utility: 100,
}];

function resolve(candidate: unknown) {
  const registry = new ActionRegistry<Record<string, never>>();
  registerRuleOnlyActionTypes(registry);
  return resolveLiveDecision({
    candidate,
    options,
    registry,
    context: { runId: "run_00000001", tick: 7, state: {} },
    agentId,
    decisionId: "dec_00000001",
    intentId: "int_00000001",
  });
}

describe("live decision contract boundary", () => {
  it("accepts a schema-valid offered proposal without executing it", () => {
    const result = resolve({
      actionId: "goal.respond",
      params,
      rationale: "The active goal is feasible and has the highest utility.",
    });
    expect(result).toMatchObject({
      source: "live",
      actionId: "goal.respond",
      validationFailures: [],
    });
  });

  it("captures schema failure and selects the stable Tier 1 fallback", () => {
    const result = resolve({
      actionId: "state.mutate_directly",
      params: {},
      rationale: "",
      toolCall: "bypass_registry",
    });
    expect(result).toMatchObject({
      source: "tier1_fallback",
      actionId: "goal.respond",
      validationFailures: [{
        stage: "proposal_schema",
        code: "SCHEMA_INVALID",
      }],
    });
  });

  it("rejects an unoffered action and action-specific invalid params", () => {
    expect(resolve({
      actionId: "goal.unoffered",
      params,
      rationale: "Try an unoffered option.",
    })).toMatchObject({
      source: "tier1_fallback",
      validationFailures: [{ stage: "offered_action", code: "PERMISSION_DENIED" }],
    });
    expect(resolve({
      actionId: "goal.respond",
      params: { ...params, agentId: "agt_00000002" },
      rationale: "Attempt to act for another agent.",
    })).toMatchObject({
      source: "tier1_fallback",
      validationFailures: [{ stage: "action_validation", code: "PERMISSION_DENIED" }],
    });
  });
});
