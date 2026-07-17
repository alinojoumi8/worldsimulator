import { readFileSync } from "node:fs";
import {
  ActionRegistry,
  registerRuleOnlyActionTypes,
  resolveLiveDecision,
} from "../../packages/engine/src/index";
import {
  hashValue,
  tier2DecisionProposalSchema,
} from "../../packages/shared/src/index";
import type { DecisionOption } from "../../packages/shared/src/index";

const contextPath = process.argv[2];
const candidatePath = process.argv[3];
if (contextPath === undefined || candidatePath === undefined) {
  throw new Error("usage: tsx validate-live-riverbend-probe.ts <context.json> <candidate.json>");
}
const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
  options: readonly DecisionOption[];
  negativeControl: unknown;
};
const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as unknown;
const agentId = "agt_00000001";

function resolve(candidateInput: unknown) {
  const registry = new ActionRegistry<Record<string, never>>({
    capabilityCheck: ({ actor, params }) =>
      actor.kind === "agent" && params !== null && typeof params === "object" &&
      (params as Record<string, unknown>)["agentId"] === actor.id
        ? true
        : { code: "PERMISSION_DENIED", message: "agent may act only as itself" },
  });
  registerRuleOnlyActionTypes(registry);
  return resolveLiveDecision({
    candidate: candidateInput,
    options: context.options,
    registry,
    context: { runId: "run_00000001", tick: 1, state: {} },
    agentId,
    decisionId: "dec_00000001",
    intentId: "int_00000001",
  });
}

const parsedCandidate = tier2DecisionProposalSchema.parse(candidate);
process.stdout.write(JSON.stringify({
  proposalHash: hashValue(parsedCandidate),
  live: resolve(parsedCandidate),
  negativeControl: resolve(context.negativeControl),
}, null, 2) + "\n");
