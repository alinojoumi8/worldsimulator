import { describe, expect, it } from "vitest";
import { AGENT_LAB_PROTOCOL_VERSION, type AgentLabScenario } from "@worldtangle/shared";
import { resolveAgentLabAssignments } from "./agent-lab-cohort";

const digest = "a".repeat(64);

function config(seed: number): { scenario: AgentLabScenario; seed: number } {
  return {
    seed,
    scenario: {
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      studyId: "cohort-test",
      trialId: `seed-${seed}`,
      experimentManifestDigest: digest,
      mode: "external",
      cohortSelection: {
        strategy: "stable_stratified_v1",
        size: 4,
        controller: "external",
        strata: ["occupation"],
      },
      decisionDeadlineMs: 1_000,
      budget: {
        maxAgentLoopIterations: 8,
        maxInputTokens: 4_000,
        maxOutputTokens: 500,
        maxToolCalls: 8,
      },
      driverPolicyDigest: digest,
      promptDigest: digest,
      toolSchemaDigest: digest,
    },
  };
}

const residents = [
  { agent: { id: "agt_00000001", occupationCode: "cook", employmentStatus: "employed", householdId: "hh_1" } },
  { agent: { id: "agt_00000002", occupationCode: "cook", employmentStatus: "employed", householdId: "hh_2" } },
  { agent: { id: "agt_00000003", occupationCode: "teacher", employmentStatus: "employed", householdId: "hh_3" } },
  { agent: { id: "agt_00000004", occupationCode: "teacher", employmentStatus: "employed", householdId: "hh_4" } },
  { agent: { id: "agt_00000005", occupationCode: "nurse", employmentStatus: "employed", householdId: "hh_5" } },
  { agent: { id: "agt_00000006", occupationCode: "nurse", employmentStatus: "employed", householdId: "hh_6" } },
];

describe("stable_stratified_v1", () => {
  it("is deterministic, balanced across strata, and canonically ordered", () => {
    const input = config(42);
    const first = resolveAgentLabAssignments(input.scenario, residents, input.seed);
    const second = resolveAgentLabAssignments(input.scenario, [...residents].reverse(), input.seed);
    expect(second).toEqual(first);
    expect(first).toHaveLength(4);
    expect(first.map((assignment) => assignment.agentId)).toEqual(
      [...first.map((assignment) => assignment.agentId)].sort(),
    );
    const selectedOccupations = first.map((assignment) =>
      residents.find((resident) => resident.agent.id === assignment.agentId)!.agent.occupationCode
    );
    expect(new Set(selectedOccupations).size).toBe(3);
  });

  it("fails closed for unknown explicit agents", () => {
    const input = config(42);
    expect(() => resolveAgentLabAssignments({
      ...input.scenario,
      cohortSelection: undefined,
      controllerAssignments: [{
        agentId: "agt_99999999",
        controller: "external",
      }],
    }, residents, input.seed)).toThrow(/unknown agent/);
  });
});
