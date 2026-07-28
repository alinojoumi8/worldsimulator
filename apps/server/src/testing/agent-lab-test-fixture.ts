import {
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PROTOCOL_VERSION,
  agentLabScenarioSchema,
  sha256Hex,
  type AgentLabCohortStratum,
  type AgentLabMode,
  type AgentLabScenario,
} from "@worldtangle/shared";

export function variantDigest(digest: string, field: string): string {
  return sha256Hex(`${digest}:${field}`);
}

export interface AgentLabTestScenarioOptions {
  readonly studyId: string;
  readonly trialId: string;
  readonly digest: string;
  readonly mode: AgentLabMode;
  readonly agentIds?: readonly string[];
  readonly cohortSize?: number;
  readonly strata?: readonly AgentLabCohortStratum[];
  readonly fixtureTicks?: readonly number[];
  readonly decisionDeadlineMs?: number;
}

export function buildAgentLabTestScenario(
  options: AgentLabTestScenarioOptions,
): AgentLabScenario {
  if (
    options.agentIds !== undefined &&
    (options.cohortSize !== undefined || options.strata !== undefined)
  ) {
    throw new Error("Agent Lab test scenarios use explicit agents or a cohort, not both");
  }
  const controllerSource = options.agentIds === undefined
    ? {
        cohortSelection: {
          strategy: "stable_stratified_v1" as const,
          size: options.cohortSize ?? 8,
          controller: options.mode,
          strata: [...(options.strata ?? [
            "occupation",
            "employment_status",
            "household",
          ])],
        },
      }
    : {
        controllerAssignments: options.agentIds.map((agentId) => ({
          agentId,
          controller: options.mode,
        })),
      };
  return agentLabScenarioSchema.parse({
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: options.studyId,
    trialId: options.trialId,
    experimentManifestDigest: options.digest,
    mode: options.mode,
    ...controllerSource,
    ...(options.fixtureTicks === undefined
      ? {}
      : {
          opportunityFixture: {
            version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
            ticks: [...options.fixtureTicks],
          },
        }),
    decisionDeadlineMs: options.decisionDeadlineMs ?? 5_000,
    budget: {
      maxAgentLoopIterations: 8,
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      maxToolCalls: 8,
    },
    driverPolicyDigest: variantDigest(options.digest, "driver-policy"),
    promptDigest: variantDigest(options.digest, "prompt"),
    toolSchemaDigest: variantDigest(options.digest, "tool-schema"),
  });
}
