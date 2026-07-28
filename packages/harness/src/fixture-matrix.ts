import {
  agentLabFixtureScheduleKey,
  compareCodeUnit,
} from "@worldtangle/shared";

export interface FixtureMatrixCoordinate {
  readonly agentId: string;
  readonly targetTick: number;
}

export function expectedFixtureMatrixKeys(
  ticks: readonly number[],
  cohortAgentIds: readonly string[],
): readonly string[] {
  const canonicalCohort = [...new Set(cohortAgentIds)].sort(compareCodeUnit);
  return [...new Set(ticks)]
    .sort((left, right) => left - right)
    .flatMap((targetTick) =>
      canonicalCohort.map((agentId) =>
        agentLabFixtureScheduleKey(targetTick, agentId)
      )
    );
}

/**
 * Preserves input order. The schedule must already satisfy the canonical
 * target-tick/agent ordering enforced by `trialArtifactSchema`.
 */
export function observedFixtureMatrixKeys(
  schedule: readonly FixtureMatrixCoordinate[],
): readonly string[] {
  for (let index = 1; index < schedule.length; index += 1) {
    const previous = schedule[index - 1]!;
    const current = schedule[index]!;
    if (
      current.targetTick < previous.targetTick ||
      (
        current.targetTick === previous.targetTick &&
        compareCodeUnit(current.agentId, previous.agentId) <= 0
      )
    ) {
      throw new Error("fixture schedule is not canonically ordered");
    }
  }
  return schedule.map((entry) =>
    agentLabFixtureScheduleKey(entry.targetTick, entry.agentId)
  );
}
