import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CreditScoreInputs } from "@worldtangle/shared";
import {
  calculateCreditScore,
  creditHistoryScoreBasisPoints,
  debtToIncomeBasisPoints,
  principalDueWithinYear,
} from "./credit-scoring";

function inputs(overrides: Partial<CreditScoreInputs> = {}): CreditScoreInputs {
  const completedPayments = overrides.completedPayments ?? 0;
  const missedPayments = overrides.missedPayments ?? 0;
  const defaults = overrides.defaults ?? 0;
  const annualIncomeCents = overrides.annualIncomeCents ?? "6000000";
  const annualDebtServiceCents = overrides.annualDebtServiceCents ?? "1200000";
  return {
    modelVersion: 1,
    annualIncomeCents,
    annualDebtServiceCents,
    existingDebtCents: "0",
    requestedAmountCents: "1200000",
    termMonths: 12,
    incomeStabilityBp: 10_000,
    debtToIncomeBp: debtToIncomeBasisPoints(annualDebtServiceCents, annualIncomeCents),
    historyScoreBp: creditHistoryScoreBasisPoints({
      completedPayments,
      missedPayments,
      defaults,
    }),
    completedPayments,
    missedPayments,
    defaults,
    noHistory: completedPayments + missedPayments + defaults === 0,
    incomeEvidenceRefs: [],
    debtEvidenceRefs: [],
    ...overrides,
  };
}

describe("credit score model v1", () => {
  it("matches stable, medium-risk, and no-income goldens", () => {
    expect(calculateCreditScore(inputs())).toEqual({
      basePoints: 300,
      incomeStabilityPoints: 200,
      debtToIncomePoints: 200,
      historyPoints: 90,
      totalPoints: 790,
    });
    expect(calculateCreditScore(inputs({
      incomeStabilityBp: 7_500,
      annualDebtServiceCents: "2400000",
      debtToIncomeBp: 4_000,
      completedPayments: 8,
      missedPayments: 1,
      noHistory: false,
      historyScoreBp: 7_000,
    }))).toMatchObject({
      incomeStabilityPoints: 150,
      debtToIncomePoints: 100,
      historyPoints: 105,
      totalPoints: 655,
    });
    expect(calculateCreditScore(inputs({
      annualIncomeCents: "0",
      annualDebtServiceCents: "0",
      incomeStabilityBp: 0,
      debtToIncomeBp: 100_000,
    })).totalPoints).toBe(390);
  });

  it("uses a neutral history factor when no payment history exists", () => {
    expect(creditHistoryScoreBasisPoints({
      completedPayments: 0,
      missedPayments: 0,
      defaults: 0,
    })).toBe(6_000);
    expect(creditHistoryScoreBasisPoints({
      completedPayments: 20,
      missedPayments: 0,
      defaults: 0,
    })).toBe(10_000);
    expect(creditHistoryScoreBasisPoints({
      completedPayments: 2,
      missedPayments: 2,
      defaults: 1,
    })).toBe(1_400);
  });

  it("uses conservative DTI ceiling and exact first-year principal", () => {
    expect(debtToIncomeBasisPoints("1", "3")).toBe(3_334);
    expect(debtToIncomeBasisPoints("0", "0")).toBe(100_000);
    expect(principalDueWithinYear("100", 3)).toBe(100n);
    expect(principalDueWithinYear("1000000", 36)).toBe(333_324n);
  });

  it("rejects score inputs whose stored derived factors do not reconcile", () => {
    expect(() => calculateCreditScore(inputs({ debtToIncomeBp: 2_001 })))
      .toThrow(/stored DTI/);
    expect(() => calculateCreditScore(inputs({ historyScoreBp: 5_999 })))
      .toThrow(/stored history score/);
  });

  it("always remains inside the 300..850 score envelope", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 0, max: 10 }),
      fc.integer({ min: 0, max: 3 }),
      (stability, income, debt, completed, missed, defaults) => {
        const scoreInputs = inputs({
          annualIncomeCents: String(income),
          annualDebtServiceCents: String(debt),
          incomeStabilityBp: stability,
          debtToIncomeBp: debtToIncomeBasisPoints(String(debt), String(income)),
          completedPayments: completed,
          missedPayments: missed,
          defaults,
          noHistory: completed + missed + defaults === 0,
          historyScoreBp: creditHistoryScoreBasisPoints({
            completedPayments: completed,
            missedPayments: missed,
            defaults,
          }),
        });
        const score = calculateCreditScore(scoreInputs).totalPoints;
        expect(score).toBeGreaterThanOrEqual(300);
        expect(score).toBeLessThanOrEqual(850);
      },
    ));
  });
});
