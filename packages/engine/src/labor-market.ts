/** Deterministic WS-403 Tier-1 labor eligibility, scoring, and notice rules. */

import { EngineError, type Job, type JobRequirement } from "@worldtangle/shared";

export const DEFAULT_MINIMUM_ANNUAL_WAGE_CENTS = 3_000_000n;

export interface LaborCandidate {
  readonly agentId: string;
  readonly skills: Readonly<Record<string, number>>;
  readonly reservationWageCents: string;
  readonly employmentStatus: string;
}

export interface ScoredLaborCandidate extends LaborCandidate {
  readonly score: number;
}

export function assertJobPostingAllowed(
  companyStatus: string,
  annualWageCents: string,
  minimumWageCents = DEFAULT_MINIMUM_ANNUAL_WAGE_CENTS,
): void {
  if (companyStatus !== "active") {
    throw new EngineError("CONFLICT", "company must be active before posting jobs");
  }
  if (BigInt(annualWageCents) < minimumWageCents) {
    throw new EngineError("VALIDATION_FAILED", "job wage is below the minimum wage");
  }
}

function meetsRequirement(
  skills: Readonly<Record<string, number>>,
  requirement: JobRequirement,
): boolean {
  return (skills[requirement.skillCode] ?? 0) >= requirement.minimum;
}

export function laborCandidateEligible(job: Job, candidate: LaborCandidate): boolean {
  return candidate.employmentStatus !== "employed" &&
    BigInt(job.annualWageCents) >= BigInt(candidate.reservationWageCents) &&
    job.requirements.every((requirement) => meetsRequirement(candidate.skills, requirement));
}

export function scoreLaborCandidate(job: Job, candidate: LaborCandidate): number {
  if (!laborCandidateEligible(job, candidate)) {
    throw new EngineError("CONFLICT", `candidate ${candidate.agentId} is not eligible for job ${job.id}`);
  }
  const skillScore = job.requirements.reduce(
    (total, requirement) => total + ((candidate.skills[requirement.skillCode] ?? 0) * requirement.weight),
    0,
  );
  const reservation = BigInt(candidate.reservationWageCents);
  const wage = BigInt(job.annualWageCents);
  const wagePremiumBp = reservation === 0n
    ? 10_000
    : Number(((wage - reservation) * 10_000n) / reservation);
  return (skillScore * 10_000) + Math.max(0, Math.min(100_000, wagePremiumBp));
}

export function rankLaborCandidates(
  job: Job,
  candidates: readonly LaborCandidate[],
): readonly ScoredLaborCandidate[] {
  return candidates
    .filter((candidate) => laborCandidateEligible(job, candidate))
    .map((candidate) => ({ ...candidate, score: scoreLaborCandidate(job, candidate) }))
    .sort((left, right) => (
      right.score - left.score ||
      (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
    ));
}

export function noticeEffectiveTick(initiatedTick: number, noticeDays: number): number {
  if (!Number.isSafeInteger(initiatedTick) || initiatedTick < 0) {
    throw new EngineError("VALIDATION_FAILED", "termination tick must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(noticeDays) || noticeDays < 0) {
    throw new EngineError("VALIDATION_FAILED", "notice days must be a nonnegative integer");
  }
  return initiatedTick + noticeDays;
}
