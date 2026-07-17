import { describe, expect, it } from "vitest";
import {
  LOAN_MAXIMUM_DTI_BP,
  LOAN_MAXIMUM_TERM_MONTHS,
  LOAN_MINIMUM_SCORE,
  currentCapitalRatioBasisPoints,
  evaluateLoanPolicy,
  tier1LoanReviewRationale,
  transitionLoanApplicationStatus,
  type LoanPolicyEvaluationInput,
} from "./credit-policy";

function input(overrides: Partial<LoanPolicyEvaluationInput> = {}): LoanPolicyEvaluationInput {
  return {
    systemScore: 720,
    officerAdjustment: 0,
    debtToIncomeBp: 3_000,
    termMonths: 36,
    existingDebtCents: "1000000",
    requestedAmountCents: "2000000",
    bankStatus: "active",
    bankCapitalCents: "73920000",
    bankDepositCents: "528000000",
    bankMinimumCapitalRatioBp: 1_400,
    bankExposureCapCents: "120000000",
    bankBaseLendingRateBp: 500,
    assessmentEvidenceRefs: ["cscore_00000001", "evt_00000001"],
    debtEvidenceRefs: ["loan_00000001"],
    bankEvidenceRefs: ["bank_00000001"],
    ...overrides,
  };
}

describe("WS-502 loan policy", () => {
  it("approves the exact threshold policy and prices the bounded risk spread", () => {
    const result = evaluateLoanPolicy(input());
    expect(result).toMatchObject({
      policyVersion: 1,
      finalScore: 720,
      approved: true,
      offeredRateBp: 650,
    });
    expect(result.policyChecks.map((check) => [check.id, check.passed])).toEqual([
      ["minimum_score", true],
      ["maximum_dti", true],
      ["maximum_term", true],
      ["borrower_exposure", true],
      ["bank_status", true],
      ["minimum_capital_ratio", true],
    ]);
    expect(tier1LoanReviewRationale(result)).toBe(
      "Tier-1 review applied no discretionary adjustment; all policy checks passed.",
    );
    expect(LOAN_MINIMUM_SCORE).toBe(650);
    expect(LOAN_MAXIMUM_DTI_BP).toBe(5_000);
    expect(LOAN_MAXIMUM_TERM_MONTHS).toBe(120);
  });

  it("rejects whenever any stored check fails and explains every failure in stable order", () => {
    const result = evaluateLoanPolicy(input({
      systemScore: 640,
      debtToIncomeBp: 6_000,
      termMonths: 180,
      existingDebtCents: "119000000",
      requestedAmountCents: "2000000",
      bankStatus: "lending_halted",
      bankCapitalCents: "70000000",
    }));
    expect(result.approved).toBe(false);
    expect(result.offeredRateBp).toBeNull();
    expect(result.policyChecks.every((check) => !check.passed)).toBe(true);
    expect(tier1LoanReviewRationale(result)).toBe(
      "Tier-1 review applied no discretionary adjustment; failed checks: " +
      "minimum_score, maximum_dti, maximum_term, borrower_exposure, bank_status, " +
      "minimum_capital_ratio.",
    );
  });

  it("computes current capital ratios with integer floors and a zero-deposit convention", () => {
    expect(currentCapitalRatioBasisPoints("73920000", "528000000")).toBe(1_400);
    expect(currentCapitalRatioBasisPoints("1", "3")).toBe(3_333);
    expect(currentCapitalRatioBasisPoints("0", "0")).toBe(10_000);
  });

  it("enforces the exact application state machine", () => {
    expect(transitionLoanApplicationStatus("submitted", "under_review")).toBe("under_review");
    expect(transitionLoanApplicationStatus("submitted", "withdrawn")).toBe("withdrawn");
    expect(transitionLoanApplicationStatus("under_review", "approved")).toBe("approved");
    expect(transitionLoanApplicationStatus("under_review", "rejected")).toBe("rejected");
    expect(transitionLoanApplicationStatus("under_review", "withdrawn")).toBe("withdrawn");
    expect(() => transitionLoanApplicationStatus("submitted", "approved"))
      .toThrow(/cannot transition from submitted to approved/);
    expect(() => transitionLoanApplicationStatus("approved", "rejected"))
      .toThrow(/cannot transition from approved to rejected/);
  });

  it("keeps every bounded officer adjustment and rate calculation integer-safe", () => {
    for (let score = 300; score <= 850; score += 11) {
      for (let adjustment = -5; adjustment <= 5; adjustment++) {
        const result = evaluateLoanPolicy(input({ systemScore: score, officerAdjustment: adjustment }));
        expect(result.finalScore).toBe(score + adjustment);
        expect(Number.isSafeInteger(result.finalScore)).toBe(true);
        expect(result.offeredRateBp === null || Number.isSafeInteger(result.offeredRateBp)).toBe(true);
      }
    }
    expect(() => evaluateLoanPolicy(input({ officerAdjustment: 6 }))).toThrow(/-5..5/);
  });
});
