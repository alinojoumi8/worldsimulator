import {
  AGENT_LAB_MCP_TOOL_DEFINITIONS,
  AGENT_LAB_MCP_TOOL_NAMES,
  canonicalStringify,
  sha256Hex,
  type AgentLabBudget,
} from "@worldtangle/shared";

export const CITIZEN_TURN_PROMPT = [
  "You are controlling exactly one fictional citizen in a WorldTangle Agent Lab trial.",
  "Use only the WorldTangle MCP tools exposed in this profile.",
  "Hermes may prefix their names with mcp_worldtangle_; that prefix names the same four tools.",
  "First call wt_identity_get, then wt_turn_wait.",
  "Treat the returned scoped observation and offered options as authoritative.",
  "Never invent private facts, actions, identifiers, ticks, hashes, or parameters.",
  "Choose at most one offered action and submit it with wt_action_submit.",
  "Use the exact target tick, projection hash, menu hash, and driver-policy digest.",
  "Then call wt_receipt_get and stop after the receipt is terminal.",
  "Do not reveal hidden reasoning. Put only a short decision rationale in the submission.",
].join("\n");

export function agentLabDriverPolicy(budget: AgentLabBudget) {
  return Object.freeze({
    protocolVersion: "wt.agent-lab.v1",
    policyVersion: "stable_driver_v1",
    canonicalObservationWins: true,
    allowedTools: AGENT_LAB_MCP_TOOL_NAMES,
    disabledCapabilities: [
      "browser",
      "code_execution",
      "delegation",
      "filesystem",
      "general_mcp_resources",
      "general_mcp_prompts",
      "memory_write",
      "shell",
      "web",
    ],
    maxAgentLoopIterations: budget.maxAgentLoopIterations,
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxToolCalls: budget.maxToolCalls,
    oneSubmissionPerTurn: true,
    hiddenReasoningExported: false,
  });
}

export function agentLabDriverPolicyDigest(budget: AgentLabBudget): string {
  return sha256Hex(canonicalStringify(agentLabDriverPolicy(budget)));
}

export function agentLabPromptDigest(prompt = CITIZEN_TURN_PROMPT): string {
  return sha256Hex(prompt);
}

export function agentLabToolPins() {
  return AGENT_LAB_MCP_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    schema: tool.inputSchema,
    digest: sha256Hex(canonicalStringify(tool.inputSchema)),
  }));
}

export function agentLabToolSchemaDigest(): string {
  return sha256Hex(canonicalStringify(
    [...agentLabToolPins()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ),
  ));
}
