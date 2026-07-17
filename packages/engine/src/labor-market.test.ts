import { describe, expect, it } from "vitest";
import { EngineError, type Job } from "@worldtangle/shared";
import {
  assertJobPostingAllowed,
  laborCandidateEligible,
  noticeEffectiveTick,
  rankLaborCandidates,
} from "./labor-market";

const job: Job = {
  id: "job_00000001",
  runId: "run_00000001",
  employerId: "co_00000001",
  occupationCode: "bookkeeper",
  title: "Bookkeeper",
  annualWageCents: "5000000",
  requirements: [{ skillCode: "numeracy", minimum: 50, weight: 2 }],
  openings: 1,
  filledCount: 0,
  status: "open",
  postedTick: 1,
  expiresTick: null,
  payrollRisk: false,
};

describe("labor matching", () => {
  it("orders equal scores by agent ID regardless of input order", () => {
    const candidates = [
      { agentId: "agt_00000003", skills: { numeracy: 75 }, reservationWageCents: "4000000", employmentStatus: "unemployed" },
      { agentId: "agt_00000001", skills: { numeracy: 75 }, reservationWageCents: "4000000", employmentStatus: "unemployed" },
      { agentId: "agt_00000002", skills: { numeracy: 75 }, reservationWageCents: "4000000", employmentStatus: "unemployed" },
    ];
    expect(rankLaborCandidates(job, candidates).map((candidate) => candidate.agentId))
      .toEqual(["agt_00000001", "agt_00000002", "agt_00000003"]);
    expect(rankLaborCandidates(job, [...candidates].reverse()).map((candidate) => candidate.agentId))
      .toEqual(["agt_00000001", "agt_00000002", "agt_00000003"]);
  });

  it("enforces Tier-1 skill, reservation-wage, and employment rules", () => {
    expect(laborCandidateEligible(job, {
      agentId: "agt_00000001",
      skills: { numeracy: 49 },
      reservationWageCents: "4000000",
      employmentStatus: "unemployed",
    })).toBe(false);
    expect(laborCandidateEligible(job, {
      agentId: "agt_00000001",
      skills: { numeracy: 80 },
      reservationWageCents: "5000001",
      employmentStatus: "unemployed",
    })).toBe(false);
    expect(laborCandidateEligible(job, {
      agentId: "agt_00000001",
      skills: { numeracy: 80 },
      reservationWageCents: "4000000",
      employmentStatus: "employed",
    })).toBe(false);
  });

  it("gates postings on active status and minimum wage", () => {
    expect(() => assertJobPostingAllowed("forming", "5000000")).toThrow(EngineError);
    expect(() => assertJobPostingAllowed("active", "2999999")).toThrow(EngineError);
    expect(() => assertJobPostingAllowed("active", "3000000")).not.toThrow();
  });

  it("honors quit and layoff notice periods", () => {
    expect(noticeEffectiveTick(10, 0)).toBe(10);
    expect(noticeEffectiveTick(10, 14)).toBe(24);
  });
});
