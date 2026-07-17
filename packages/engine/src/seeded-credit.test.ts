import { describe, expect, it } from "vitest";
import {
  canonicalParse,
  canonicalStringify,
} from "@worldtangle/shared";
import {
  auditSeededCreditPortfolio,
  generateRiverbendPopulation,
  parseSeedLoan,
} from "./index";

describe("seeded opening credit portfolio", () => {
  it.each([0, 1, 42, 404, "riverbend"])(
    "produces the exact portfolio and internally consistent histories for seed %s",
    (seed) => {
      const loans = generateRiverbendPopulation({ runId: "run_00000001", seed }).loans;
      const report = auditSeededCreditPortfolio(loans);

      expect(report.violations).toEqual([]);
      expect(report.summary).toMatchObject({
        totalLoans: 8,
        businessLoans: 1,
        personalLoans: 7,
        currentPersonalLoans: 6,
        delinquentPersonalLoans: 1,
      });
      const ironvale = loans.find((loan) => loan.borrowerId === "biz_ironvale");
      expect(ironvale).toMatchObject({
        purpose: "working_capital",
        originalPrincipalCents: "30000000",
        outstandingPrincipalCents: "11666662",
        annualRateBp: 650,
        termMonths: 36,
        seasonedMonths: 22,
        status: "current",
      });
      expect(loans.filter((loan) => loan.borrowerKind === "agent").map(
        (loan) => loan.borrowerId,
      )).toHaveLength(7);
    },
  );

  it("detects a history whose stored interest no longer matches exact 30/360 terms", () => {
    const population = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });
    const first = population.loans[0]!;
    const firstInstallment = first.installments[0]!;
    const corrupted = [
      {
        ...first,
        installments: [
          { ...firstInstallment, interestCents: (BigInt(firstInstallment.interestCents) + 1n).toString() },
          ...first.installments.slice(1),
        ],
      },
      ...population.loans.slice(1),
    ];

    expect(auditSeededCreditPortfolio(corrupted).violations).toContainEqual(
      expect.objectContaining({ code: "interest_history_mismatch" }),
    );
  });

  it("round-trips the canonical persistence shape through the strict parser", () => {
    const loan = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 }).loans[0]!;
    expect(parseSeedLoan(canonicalParse(canonicalStringify(loan)))).toEqual(loan);
    expect(() => parseSeedLoan({ ...loan, termMonths: 1.5 })).toThrow(/termMonths must be an integer/);
  });
});
