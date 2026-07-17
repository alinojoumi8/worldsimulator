import { describe, expect, it } from "vitest";
import {
  BANK_MINIMUM_CAPITAL_RATIO_BP,
  BANK_MINIMUM_RESERVE_RATIO_BP,
  BANK_OPENING_RESERVE_CENTS,
  bankRatioBasisPoints,
  evaluateBankLendingCircuit,
  type BankCircuitEvaluationInput,
} from "./bank-circuit-breakers";

function input(
  overrides: Partial<BankCircuitEvaluationInput> = {},
): BankCircuitEvaluationInput {
  return {
    bankStatus: "active",
    depositCents: "528000000",
    reserveCents: BANK_OPENING_RESERVE_CENTS,
    reserveRatioMinBp: BANK_MINIMUM_RESERVE_RATIO_BP,
    effectiveCapitalCents: "73920000",
    capitalRatioMinBp: BANK_MINIMUM_CAPITAL_RATIO_BP,
    borrowerExposureCents: "1000000",
    borrowerExposureCapCents: "120000000",
    requestedAmountCents: "2000000",
    ...overrides,
  };
}

describe("WS-505 bank circuit-breaker rules", () => {
  it("evaluates the exact pro-forma reserve, capital, and exposure position", () => {
    const result = evaluateBankLendingCircuit(input());
    expect(result).toMatchObject({
      policyVersion: 1,
      bankStatusBefore: "active",
      bankStatusAfter: "active",
      depositCents: "528000000",
      projectedDepositCents: "530000000",
      reserveRatioBp: 1_800,
      projectedReserveRatioBp: 1_793,
      capitalRatioBp: 1_400,
      projectedCapitalRatioBp: 1_394,
      projectedBorrowerExposureCents: "3000000",
      reservePassed: true,
      capitalPassed: true,
      exposurePassed: true,
      systemicPassed: true,
      allowed: true,
      failedBreakers: [],
    });
  });

  it("halts systemic lending but scopes concentration failures to one borrower", () => {
    const systemic = evaluateBankLendingCircuit(input({
      reserveCents: "50000000",
      effectiveCapitalCents: "50000000",
    }));
    expect(systemic).toMatchObject({
      bankStatusAfter: "lending_halted",
      systemicPassed: false,
      allowed: false,
      failedBreakers: ["reserve_ratio", "capital_ratio"],
    });

    const concentrated = evaluateBankLendingCircuit(input({
      borrowerExposureCents: "119000000",
      requestedAmountCents: "2000000",
    }));
    expect(concentrated).toMatchObject({
      bankStatusAfter: "active",
      systemicPassed: true,
      exposurePassed: false,
      allowed: false,
      failedBreakers: ["borrower_exposure"],
    });
  });

  it("re-evaluates a halted bank and resumes only when the projected position is safe", () => {
    const recovered = evaluateBankLendingCircuit(input({ bankStatus: "lending_halted" }));
    expect(recovered).toMatchObject({
      bankStatusBefore: "lending_halted",
      bankStatusAfter: "active",
      allowed: true,
    });
    const closed = evaluateBankLendingCircuit(input({ bankStatus: "closed" }));
    expect(closed).toMatchObject({
      bankStatusAfter: "closed",
      allowed: false,
      failedBreakers: ["bank_closed"],
    });
  });

  it("allows exact regulatory boundaries and blocks the first cent beyond them", () => {
    const exact = evaluateBankLendingCircuit(input({
      depositCents: "999",
      reserveCents: "120",
      effectiveCapitalCents: "100",
      borrowerExposureCents: "999",
      borrowerExposureCapCents: "1000",
      requestedAmountCents: "1",
    }));
    expect(exact).toMatchObject({
      projectedReserveRatioBp: 1_200,
      projectedCapitalRatioBp: 1_000,
      projectedBorrowerExposureCents: "1000",
      allowed: true,
    });
    const beyond = evaluateBankLendingCircuit(input({
      depositCents: "999",
      reserveCents: "120",
      effectiveCapitalCents: "100",
      borrowerExposureCents: "999",
      borrowerExposureCapCents: "1000",
      requestedAmountCents: "2",
    }));
    expect(beyond).toMatchObject({
      projectedReserveRatioBp: 1_198,
      projectedCapitalRatioBp: 999,
      projectedBorrowerExposureCents: "1001",
      allowed: false,
      failedBreakers: ["reserve_ratio", "capital_ratio", "borrower_exposure"],
    });
  });

  it("uses integer floors and preserves every bounded cents calculation", () => {
    expect(bankRatioBasisPoints("1", "3")).toBe(3_333);
    expect(bankRatioBasisPoints("0", "0")).toBe(10_000);
    for (let deposits = 1n; deposits <= 200n; deposits++) {
      for (let request = 1n; request <= 20n; request++) {
        const result = evaluateBankLendingCircuit(input({
          depositCents: deposits.toString(),
          reserveCents: "100",
          effectiveCapitalCents: "100",
          borrowerExposureCents: "0",
          borrowerExposureCapCents: "1000",
          requestedAmountCents: request.toString(),
        }));
        expect(result.projectedDepositCents).toBe((deposits + request).toString());
        expect(result.projectedBorrowerExposureCents).toBe(request.toString());
        expect(Number.isSafeInteger(result.projectedReserveRatioBp)).toBe(true);
        expect(Number.isSafeInteger(result.projectedCapitalRatioBp)).toBe(true);
      }
    }
  });

  it("rejects malformed or zero-value requests before state can be considered", () => {
    expect(() => evaluateBankLendingCircuit(input({ requestedAmountCents: "0" })))
      .toThrow(/must be positive/);
    expect(() => evaluateBankLendingCircuit(input({ reserveCents: "-1" })))
      .toThrow(/nonnegative cents/);
    expect(() => evaluateBankLendingCircuit(input({ reserveRatioMinBp: 10_001 })))
      .toThrow(/0..10000/);
  });
});
