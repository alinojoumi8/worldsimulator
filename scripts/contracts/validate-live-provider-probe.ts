import { readFileSync } from "node:fs";
import {
  ActionRegistry,
  RULE_ONLY_ACTION_TYPES,
  RULE_ONLY_NO_OP_ACTION,
  registerRuleOnlyActionTypes,
  resolveLiveDecision,
} from "../../packages/engine/src/index";
import { hashValue } from "../../packages/shared/src/index";
import type { DecisionOption } from "../../packages/shared/src/index";

interface ProbeInput {
  readonly candidate: unknown;
  readonly negativeControl: unknown;
}

const inputPath = process.argv[2];
if (inputPath === undefined) {
  throw new Error("usage: tsx validate-live-provider-probe.ts <probe-input.json>");
}
const input = JSON.parse(readFileSync(inputPath, "utf8")) as ProbeInput;
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

process.stdout.write(JSON.stringify({
  proposalHash: hashValue(input.candidate),
  live: resolve(input.candidate),
  negativeControl: resolve(input.negativeControl),
}, null, 2) + "\n");
