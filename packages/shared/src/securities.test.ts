import { describe, expect, it } from "vitest";
import {
  assessSecuritiesListingEligibility,
  RIVERBEND_SECURITIES_LISTING_POLICY,
  SECURITIES_PROFIT_COST_TRANSACTION_KINDS,
  SECURITIES_PROFIT_REVENUE_TRANSACTION_KINDS,
  securitiesListingEligibilityAssessmentSchema,
  securitiesListingEligibilityInputSchema,
} from "./securities";

const eligibleInput = {
  companyId: "biz_riverbend_grocery",
  assessedTick: 30,
  foundedTick: 0,
  companyActive: true,
  profit30Cents: "1",
  capitalCents: "0",
  totalShares: "10000",
  requestedShares: "2500",
} as const;

describe("securities listing eligibility", () => {
  it("pins the transaction kinds used by the version-1 profit policy", () => {
    expect(SECURITIES_PROFIT_REVENUE_TRANSACTION_KINDS).toEqual([
      "purchase",
      "row_settlement",
    ]);
    expect(SECURITIES_PROFIT_COST_TRANSACTION_KINDS).toEqual([
      "payroll",
      "purchase",
      "loan_payment",
      "tax",
      "benefit",
      "fee",
      "dividend",
      "row_settlement",
    ]);
  });

  it("accepts the profitability or capital path after the minimum age", () => {
    const profitable = assessSecuritiesListingEligibility(eligibleInput);
    expect(profitable).toMatchObject({
      eligible: true,
      eligibilityBasis: "profitability",
      checks: {
        active: true,
        minimumAge: true,
        profitability: true,
        capital: false,
        sharesWithinTotal: true,
      },
    });

    const capitalized = assessSecuritiesListingEligibility({
      ...eligibleInput,
      profit30Cents: "0",
      capitalCents: RIVERBEND_SECURITIES_LISTING_POLICY.minimumCapitalCents,
    });
    expect(capitalized).toMatchObject({
      eligible: true,
      eligibilityBasis: "capital",
    });
  });

  it.each([
    {
      label: "inactive",
      changes: { companyActive: false },
      expectedChecks: {
        active: false,
        minimumAge: true,
        profitability: true,
        capital: false,
        sharesWithinTotal: true,
      },
    },
    {
      label: "too young",
      changes: { assessedTick: 29 },
      expectedChecks: {
        active: true,
        minimumAge: false,
        profitability: true,
        capital: false,
        sharesWithinTotal: true,
      },
    },
    {
      label: "unprofitable and undercapitalized",
      changes: {
        profit30Cents: "0",
        capitalCents: "9999999",
      },
      expectedChecks: {
        active: true,
        minimumAge: true,
        profitability: false,
        capital: false,
        sharesWithinTotal: true,
      },
    },
    {
      label: "too many listed shares",
      changes: { requestedShares: "10001" },
      expectedChecks: {
        active: true,
        minimumAge: true,
        profitability: true,
        capital: false,
        sharesWithinTotal: false,
      },
    },
  ])("rejects $label companies", ({ changes, expectedChecks }) => {
    const input = {
      ...eligibleInput,
      ...changes,
    };
    const first = assessSecuritiesListingEligibility(input);
    const replayed = assessSecuritiesListingEligibility(input);
    expect(first).toMatchObject({
      eligible: false,
      checks: expectedChecks,
    });
    expect(replayed).toEqual(first);
  });

  it("rejects an assessment before the company was founded", () => {
    expect(() => assessSecuritiesListingEligibility({
      ...eligibleInput,
      assessedTick: 4,
      foundedTick: 5,
    })).toThrow(/founding cannot follow/);
  });

  it("fails closed on malformed integers and contradictory assessments", () => {
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      profit30Cents: "1e2",
    }).success).toBe(false);
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      profit30Cents: "-0",
    }).success).toBe(false);

    const valid = assessSecuritiesListingEligibility(eligibleInput);
    expect(securitiesListingEligibilityAssessmentSchema.safeParse({
      ...valid,
      checks: {
        ...valid.checks,
        active: false,
      },
    }).success).toBe(false);
    expect(securitiesListingEligibilityAssessmentSchema.safeParse({
      ...valid,
      eligible: false,
    }).success).toBe(false);
  });
});
