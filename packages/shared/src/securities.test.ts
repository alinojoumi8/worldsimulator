import { describe, expect, it } from "vitest";
import {
  assessSecuritiesListingEligibility,
  listSecurityInputSchema,
  RIVERBEND_SECURITIES_AUCTION_SCHEDULE,
  RIVERBEND_SECURITIES_EXCHANGE_ID,
  RIVERBEND_SECURITIES_LISTING_POLICY,
  RIVERBEND_SECURITIES_PRICE_BAND_BP,
  SECURITIES_PROFIT_COST_TRANSACTION_KINDS,
  SECURITIES_PROFIT_REVENUE_TRANSACTION_KINDS,
  securitiesListingEligibilityAssessmentSchema,
  securitiesListingEligibilityInputSchema,
  securitiesMarketOpenedPayloadSchema,
  securitiesMarketSchema,
  securityListedPayloadSchema,
  securitySchema,
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
  it("pins the version-1 policy thresholds and transaction kinds", () => {
    // Migration 36 pins the matching SQL bytes and checksum independently.
    expect(RIVERBEND_SECURITIES_LISTING_POLICY).toEqual({
      version: "riverbend_listing_v1",
      minimumAgeTicks: 30,
      minimumProfit30Cents: "1",
      minimumCapitalCents: "10000000",
    });
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

    const both = assessSecuritiesListingEligibility({
      ...eligibleInput,
      capitalCents: RIVERBEND_SECURITIES_LISTING_POLICY.minimumCapitalCents,
    });
    expect(both).toMatchObject({
      eligible: true,
      eligibilityBasis: "both",
      checks: {
        profitability: true,
        capital: true,
      },
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

  it("enforces the authoritative signed SQLite integer range", () => {
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      capitalCents: "9223372036854775807",
    }).success).toBe(true);
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      capitalCents: "-9223372036854775808",
    }).success).toBe(true);
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      capitalCents: "9223372036854775808",
    }).success).toBe(false);
    expect(securitiesListingEligibilityInputSchema.safeParse({
      ...eligibleInput,
      capitalCents: "-9223372036854775809",
    }).success).toBe(false);
  });
});

describe("securities public schemas", () => {
  const market = {
    id: "mkt_00000001",
    runId: "run_00000001",
    kind: "securities",
    operatorInstitutionId: RIVERBEND_SECURITIES_EXCHANGE_ID,
    auctionSchedule: RIVERBEND_SECURITIES_AUCTION_SCHEDULE,
    priceBandBp: RIVERBEND_SECURITIES_PRICE_BAND_BP,
    status: "open",
    openedTick: 30,
    sourceEventId: "evt_00000001",
  } as const;
  const listInput = {
    companyId: eligibleInput.companyId,
    symbol: "RBG",
    sharesListed: "2500",
    referencePriceCents: "1250",
  } as const;
  const marketOpenedPayload = {
    marketId: market.id,
    operatorInstitutionId: market.operatorInstitutionId,
    priceBandBp: market.priceBandBp,
    openedTick: market.openedTick,
  } as const;
  const listedPayload = {
    securityId: "sec_00000001",
    companyId: eligibleInput.companyId,
    symbol: listInput.symbol,
    sharesListed: listInput.sharesListed,
    referencePrice: listInput.referencePriceCents,
  } as const;

  it("parses only the frozen Riverbend market shape", () => {
    expect(securitiesMarketSchema.parse(market)).toEqual(market);
    expect(securitiesMarketSchema.safeParse({
      ...market,
      auctionSchedule: { frequencyTicks: 2, offsetTick: 0 },
    }).success).toBe(false);
  });

  it("parses security records with validated eligibility evidence", () => {
    const security = {
      id: listedPayload.securityId,
      runId: market.runId,
      marketId: market.id,
      companyId: listedPayload.companyId,
      symbol: listedPayload.symbol,
      sharesListed: listedPayload.sharesListed,
      referencePriceCents: listedPayload.referencePrice,
      listedTick: market.openedTick,
      status: "listed",
      eligibility: assessSecuritiesListingEligibility(eligibleInput),
      sourceEventId: "evt_00000002",
    } as const;
    expect(securitySchema.parse(security)).toEqual(security);
    expect(securitySchema.safeParse({
      ...security,
      status: "trading",
    }).success).toBe(false);
  });

  it("parses strict listing inputs", () => {
    expect(listSecurityInputSchema.parse(listInput)).toEqual(listInput);
    expect(listSecurityInputSchema.safeParse({
      ...listInput,
      sharesListed: "0",
    }).success).toBe(false);
  });

  it("parses the exact market-opened event payload", () => {
    expect(securitiesMarketOpenedPayloadSchema.parse(marketOpenedPayload))
      .toEqual(marketOpenedPayload);
    expect(securitiesMarketOpenedPayloadSchema.safeParse({
      ...marketOpenedPayload,
      priceBandBp: 2_001,
    }).success).toBe(false);
  });

  it("keeps the frozen referencePrice listing-event key", () => {
    expect(securityListedPayloadSchema.parse(listedPayload)).toEqual(listedPayload);
    expect(securityListedPayloadSchema.safeParse({
      securityId: listedPayload.securityId,
      companyId: listedPayload.companyId,
      symbol: listedPayload.symbol,
      sharesListed: listedPayload.sharesListed,
      referencePriceCents: listedPayload.referencePrice,
    }).success).toBe(false);
  });
});
