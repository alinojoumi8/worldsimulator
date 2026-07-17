import { describe, expect, it } from "vitest";
import type { LoanInstallment } from "@worldtangle/shared";
import {
  applyLoanDefaultCreditScorePenalty,
  canCollectLoanQuote,
  loanStateAfterCollection,
  loanStateAfterMiss,
  quoteLoanCollection,
} from "./loan-collections";

function installment(overrides: Partial<LoanInstallment> = {}): LoanInstallment {
  return {
    id: "pay_00000001",
    runId: "run_00000001",
    loanId: "loan_00000001",
    installmentNumber: 1,
    dueTick: 30,
    openingPrincipalCents: "10001",
    principalDueCents: "3333",
    interestDueCents: "51",
    totalDueCents: "3384",
    status: "due",
    paidTick: null,
    transactionId: null,
    sourceEventId: "evt_00000001",
    ...overrides,
  };
}

describe("WS-504 deterministic collection rules", () => {
  it("quotes the complete ordered arrears set and requires full available cash", () => {
    const quote = quoteLoanCollection([
      installment({ status: "missed" }),
      installment({
        id: "pay_00000002",
        installmentNumber: 2,
        dueTick: 60,
        openingPrincipalCents: "6668",
        principalDueCents: "3333",
        interestDueCents: "34",
        totalDueCents: "3367",
      }),
    ]);
    expect(quote).toEqual({
      installmentIds: ["pay_00000001", "pay_00000002"],
      principalCents: "6666",
      interestCents: "85",
      totalCents: "6751",
    });
    expect(canCollectLoanQuote({ balanceCents: "6851", floorCents: "100", quote })).toBe(true);
    expect(canCollectLoanQuote({ balanceCents: "6850", floorCents: "100", quote })).toBe(false);
  });

  it("resets misses after collection and exhausts principal exactly", () => {
    expect(loanStateAfterCollection({
      outstandingPrincipalCents: "6666",
      principalCollectedCents: "3333",
    })).toEqual({
      outstandingPrincipalCents: "3333",
      consecutiveMisses: 0,
      status: "repaying",
    });
    expect(loanStateAfterCollection({
      outstandingPrincipalCents: "3333",
      principalCollectedCents: "3333",
    })).toEqual({
      outstandingPrincipalCents: "0",
      consecutiveMisses: 0,
      status: "paid_off",
    });
    expect(() => loanStateAfterCollection({
      outstandingPrincipalCents: "1",
      principalCollectedCents: "2",
    })).toThrow(/exceeds outstanding/);
  });

  it("defaults on the third consecutive miss and applies a bounded 100-point penalty", () => {
    expect(loanStateAfterMiss(0)).toEqual({
      consecutiveMisses: 1,
      status: "repaying",
      defaulted: false,
    });
    expect(loanStateAfterMiss(1)).toEqual({
      consecutiveMisses: 2,
      status: "repaying",
      defaulted: false,
    });
    expect(loanStateAfterMiss(2)).toEqual({
      consecutiveMisses: 3,
      status: "defaulted",
      defaulted: true,
    });
    expect(applyLoanDefaultCreditScorePenalty(720)).toBe(620);
    expect(applyLoanDefaultCreditScorePenalty(350)).toBe(300);
  });

  it("rejects duplicate, completed, mixed-loan, unordered, and malformed inputs", () => {
    expect(() => quoteLoanCollection([])).toThrow(/requires an installment/);
    expect(() => quoteLoanCollection([
      installment(),
      installment(),
    ])).toThrow(/unique and ordered/);
    expect(() => quoteLoanCollection([
      installment({
        status: "completed",
        paidTick: 30,
        transactionId: "txn_00000001",
      }),
    ])).toThrow(/already completed/);
    expect(() => quoteLoanCollection([
      installment(),
      installment({
        id: "pay_00000002",
        loanId: "loan_00000002",
        installmentNumber: 2,
      }),
    ])).toThrow(/different loans/);
    expect(() => loanStateAfterMiss(3)).toThrow(/below the default threshold/);
    expect(() => applyLoanDefaultCreditScorePenalty(299)).toThrow(/300\.\.850/);
  });

  it("preserves the collection-state invariant across a bounded cents matrix", () => {
    for (let outstanding = 1n; outstanding <= 200n; outstanding++) {
      for (let collected = 0n; collected <= outstanding; collected++) {
        const next = loanStateAfterCollection({
          outstandingPrincipalCents: outstanding.toString(),
          principalCollectedCents: collected.toString(),
        });
        expect(BigInt(next.outstandingPrincipalCents) + collected).toBe(outstanding);
        expect(next.status === "paid_off").toBe(collected === outstanding);
      }
    }
  });
});
