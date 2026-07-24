import {
  agentLabControllerAssignmentSchema,
  hashValue,
  type AgentLabScenario,
  type RunManifestAgentLab,
} from "@worldtangle/shared";

export interface AgentLabCohortResident {
  readonly agent: Readonly<{
    id: string;
    occupationCode: string;
    employmentStatus: string;
    householdId: string;
  }>;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stratumKey(
  resident: AgentLabCohortResident,
  strata: readonly ("occupation" | "employment_status" | "household")[],
): string {
  return strata.map((stratum) => {
    if (stratum === "occupation") return `occupation:${resident.agent.occupationCode}`;
    if (stratum === "employment_status") {
      return `employment:${resident.agent.employmentStatus}`;
    }
    return `household:${resident.agent.householdId}`;
  }).join("|");
}

export function resolveAgentLabAssignments(
  scenario: AgentLabScenario,
  residents: readonly AgentLabCohortResident[],
  seed: number,
): RunManifestAgentLab["resolvedAssignments"] {
  const residentsById = new Map(residents.map((resident) => [resident.agent.id, resident]));
  if (scenario.controllerAssignments !== undefined) {
    for (const assignment of scenario.controllerAssignments) {
      if (!residentsById.has(assignment.agentId)) {
        throw new RangeError(`Agent Lab assignment references unknown agent ${assignment.agentId}`);
      }
    }
    return [...scenario.controllerAssignments]
      .map((assignment) => agentLabControllerAssignmentSchema.parse(assignment))
      .sort((left, right) => compareCodeUnit(left.agentId, right.agentId));
  }
  if (scenario.cohortSelection === undefined) return [];

  const groups = new Map<string, AgentLabCohortResident[]>();
  for (const resident of residents) {
    const key = stratumKey(resident, scenario.cohortSelection.strata);
    const group = groups.get(key) ?? [];
    group.push(resident);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    group.sort((left, right) => {
      const leftHash = hashValue({ seed, key, agentId: left.agent.id });
      const rightHash = hashValue({ seed, key, agentId: right.agent.id });
      return compareCodeUnit(leftHash, rightHash) ||
        compareCodeUnit(left.agent.id, right.agent.id);
    });
  }

  const selected: AgentLabCohortResident[] = [];
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => compareCodeUnit(left, right));
  let round = 0;
  while (selected.length < scenario.cohortSelection.size) {
    let added = false;
    for (const [, group] of orderedGroups) {
      const resident = group[round];
      if (resident === undefined) continue;
      selected.push(resident);
      added = true;
      if (selected.length === scenario.cohortSelection.size) break;
    }
    if (!added) break;
    round += 1;
  }
  if (selected.length !== scenario.cohortSelection.size) {
    throw new RangeError(
      `Agent Lab cohort requests ${scenario.cohortSelection.size} residents but only ` +
        `${selected.length} are available`,
    );
  }
  return selected.map((resident) => agentLabControllerAssignmentSchema.parse({
    agentId: resident.agent.id,
    controller: scenario.cohortSelection!.controller,
  })).sort((left, right) => compareCodeUnit(left.agentId, right.agentId));
}

export function controllerForAgent(
  config: RunManifestAgentLab,
  agentId: string,
): "native" | "shadow" | "external" {
  return config.resolvedAssignments.find((assignment) => assignment.agentId === agentId)
    ?.controller ?? "native";
}
