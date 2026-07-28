import { describe, expect, it } from "vitest";
import {
  assessSecuritiesListingEligibility,
  RIVERBEND_SECURITIES_LISTING_POLICY,
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
    ["inactive", { companyActive: false }],
    ["too young", { assessedTick: 29 }],
    ["unprofitable and undercapitalized", {
      profit30Cents: "0",
      capitalCents: "9999999",
    }],
    ["too many listed shares", { requestedShares: "10001" }],
  ])("rejects %s companies", (_label, changes) => {
    expect(assessSecuritiesListingEligibility({
      ...eligibleInput,
      ...changes,
    }).eligible).toBe(false);
  });

  it("rejects an assessment before the company was founded", () => {
    expect(() => assessSecuritiesListingEligibility({
      ...eligibleInput,
      assessedTick: 4,
      foundedTick: 5,
    })).toThrow(/founding cannot follow/);
  });
});
