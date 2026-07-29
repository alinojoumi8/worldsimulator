import { z } from "zod";
import { runIdSchema } from "./simulation";
import { ventureTargetCompanyIdSchema } from "./venture";

const SIGNED_SQLITE_MAXIMUM = 9_223_372_036_854_775_807n;
const SIGNED_SQLITE_MINIMUM = -9_223_372_036_854_775_808n;

function withinSignedSqliteRange(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= SIGNED_SQLITE_MINIMUM && parsed <= SIGNED_SQLITE_MAXIMUM;
  } catch {
    return false;
  }
}

const signedIntegerSchema = z.string().regex(/^(?:0|-?[1-9]\d*)$/)
  .refine(withinSignedSqliteRange, {
    message: "integer exceeds the authoritative SQLite range",
  });
const positiveIntegerSchema = z.string().regex(/^[1-9]\d*$/)
  .refine(withinSignedSqliteRange, {
    message: "integer exceeds the authoritative SQLite range",
  });
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

export const securitiesMarketIdSchema = z.string().regex(/^mkt_[0-9a-z]{8,}$/);
export const securityIdSchema = z.string().regex(/^sec_[0-9a-z]{8,}$/);
export const securitySymbolSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,4}$/);

export const RIVERBEND_SECURITIES_EXCHANGE_ID = "inst_riverbend_exchange";
export const RIVERBEND_SECURITIES_PRICE_BAND_BP = 2_000;
export const RIVERBEND_SECURITIES_AUCTION_SCHEDULE = Object.freeze({
  frequencyTicks: 1,
  offsetTick: 0,
} as const);
export const SECURITIES_LISTING_POLICY_VERSION = "riverbend_listing_v1";

export const securitiesListingPolicySchema = z.object({
  version: z.literal(SECURITIES_LISTING_POLICY_VERSION),
  minimumAgeTicks: z.number().int().positive().safe(),
  minimumProfit30Cents: positiveIntegerSchema,
  minimumCapitalCents: positiveIntegerSchema,
}).strict();

export type SecuritiesListingPolicy = z.infer<
  typeof securitiesListingPolicySchema
>;

export const RIVERBEND_SECURITIES_LISTING_POLICY: SecuritiesListingPolicy =
  Object.freeze({
    version: SECURITIES_LISTING_POLICY_VERSION,
    minimumAgeTicks: 30,
    minimumProfit30Cents: "1",
    minimumCapitalCents: "10000000",
  });

export const SECURITIES_PROFIT_REVENUE_TRANSACTION_KINDS = Object.freeze([
  "purchase",
  "row_settlement",
] as const);

export const SECURITIES_PROFIT_COST_TRANSACTION_KINDS = Object.freeze([
  "payroll",
  "purchase",
  "loan_payment",
  "tax",
  "benefit",
  "fee",
  "dividend",
  "row_settlement",
] as const);

export const securitiesListingEligibilityInputSchema = z.object({
  companyId: ventureTargetCompanyIdSchema,
  assessedTick: z.number().int().nonnegative().safe(),
  foundedTick: z.number().int().nonnegative().safe(),
  companyActive: z.boolean(),
  profit30Cents: signedIntegerSchema,
  capitalCents: signedIntegerSchema,
  totalShares: positiveIntegerSchema,
  requestedShares: positiveIntegerSchema,
}).strict().superRefine((value, ctx) => {
  if (value.foundedTick > value.assessedTick) {
    ctx.addIssue({
      code: "custom",
      path: ["foundedTick"],
      message: "company founding cannot follow the eligibility assessment",
    });
  }
});

type EligibilityBasis = "profitability" | "capital" | "both" | null;

interface EligibilityDerivationInput {
  readonly policy: SecuritiesListingPolicy;
  readonly assessedTick: number;
  readonly foundedTick: number;
  readonly companyActive: boolean;
  readonly profit30Cents: string;
  readonly capitalCents: string;
  readonly totalShares: string;
  readonly requestedShares: string;
}

interface EligibilityDerivation {
  readonly ageTicks: number;
  readonly checks: {
    readonly active: boolean;
    readonly minimumAge: boolean;
    readonly profitability: boolean;
    readonly capital: boolean;
    readonly sharesWithinTotal: boolean;
  };
  readonly eligibilityBasis: EligibilityBasis;
  readonly eligible: boolean;
}

function deriveEligibility(
  input: EligibilityDerivationInput,
): EligibilityDerivation {
  const profitability =
    BigInt(input.profit30Cents) >= BigInt(input.policy.minimumProfit30Cents);
  const capital =
    BigInt(input.capitalCents) >= BigInt(input.policy.minimumCapitalCents);
  const checks = Object.freeze({
    active: input.companyActive,
    minimumAge:
      input.assessedTick - input.foundedTick >= input.policy.minimumAgeTicks,
    profitability,
    capital,
    sharesWithinTotal:
      BigInt(input.requestedShares) <= BigInt(input.totalShares),
  });
  const eligibilityBasis: EligibilityBasis = profitability && capital
    ? "both"
    : profitability
      ? "profitability"
      : capital
        ? "capital"
        : null;
  return {
    ageTicks: input.assessedTick - input.foundedTick,
    checks,
    eligibilityBasis,
    eligible:
      checks.active &&
      checks.minimumAge &&
      (checks.profitability || checks.capital) &&
      checks.sharesWithinTotal,
  };
}

export const securitiesListingEligibilityAssessmentSchema = z.object({
  policy: securitiesListingPolicySchema,
  companyId: ventureTargetCompanyIdSchema,
  assessedTick: z.number().int().nonnegative().safe(),
  foundedTick: z.number().int().nonnegative().safe(),
  ageTicks: z.number().int().nonnegative().safe(),
  companyActive: z.boolean(),
  profit30Cents: signedIntegerSchema,
  capitalCents: signedIntegerSchema,
  totalShares: positiveIntegerSchema,
  requestedShares: positiveIntegerSchema,
  checks: z.object({
    active: z.boolean(),
    minimumAge: z.boolean(),
    profitability: z.boolean(),
    capital: z.boolean(),
    sharesWithinTotal: z.boolean(),
  }).strict(),
  eligibilityBasis: z.enum(["profitability", "capital", "both"]).nullable(),
  eligible: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.foundedTick > value.assessedTick) {
    ctx.addIssue({
      code: "custom",
      path: ["foundedTick"],
      message: "company founding cannot follow the eligibility assessment",
    });
    return;
  }
  const expected = deriveEligibility(value);
  if (value.ageTicks !== expected.ageTicks) {
    ctx.addIssue({
      code: "custom",
      path: ["ageTicks"],
      message: "ageTicks does not match assessedTick and foundedTick",
    });
  }
  if (value.checks.active !== expected.checks.active) {
    ctx.addIssue({
      code: "custom",
      path: ["checks", "active"],
      message: "active check does not match company state",
    });
  }
  if (value.checks.minimumAge !== expected.checks.minimumAge) {
    ctx.addIssue({
      code: "custom",
      path: ["checks", "minimumAge"],
      message: "minimum-age check does not match policy",
    });
  }
  if (value.checks.profitability !== expected.checks.profitability) {
    ctx.addIssue({
      code: "custom",
      path: ["checks", "profitability"],
      message: "profitability check does not match policy",
    });
  }
  if (value.checks.capital !== expected.checks.capital) {
    ctx.addIssue({
      code: "custom",
      path: ["checks", "capital"],
      message: "capital check does not match policy",
    });
  }
  if (value.checks.sharesWithinTotal !== expected.checks.sharesWithinTotal) {
    ctx.addIssue({
      code: "custom",
      path: ["checks", "sharesWithinTotal"],
      message: "share-bound check does not match the cap table",
    });
  }
  if (value.eligibilityBasis !== expected.eligibilityBasis) {
    ctx.addIssue({
      code: "custom",
      path: ["eligibilityBasis"],
      message: "eligibility basis does not match the qualifying checks",
    });
  }
  if (value.eligible !== expected.eligible) {
    ctx.addIssue({
      code: "custom",
      path: ["eligible"],
      message: "eligibility result does not match the policy checks",
    });
  }
});

export type SecuritiesListingEligibilityInput = z.infer<
  typeof securitiesListingEligibilityInputSchema
>;
export type SecuritiesListingEligibilityAssessment = z.infer<
  typeof securitiesListingEligibilityAssessmentSchema
>;

export function assessSecuritiesListingEligibility(
  rawInput: SecuritiesListingEligibilityInput,
  policy: SecuritiesListingPolicy = RIVERBEND_SECURITIES_LISTING_POLICY,
): SecuritiesListingEligibilityAssessment {
  const input = securitiesListingEligibilityInputSchema.parse(rawInput);
  const parsedPolicy = securitiesListingPolicySchema.parse(policy);
  const derived = deriveEligibility({
    policy: parsedPolicy,
    ...input,
  });
  return securitiesListingEligibilityAssessmentSchema.parse({
    policy: parsedPolicy,
    ...input,
    ...derived,
  });
}

export const securitiesMarketSchema = z.object({
  id: securitiesMarketIdSchema,
  runId: runIdSchema,
  kind: z.literal("securities"),
  operatorInstitutionId: z.literal(RIVERBEND_SECURITIES_EXCHANGE_ID),
  auctionSchedule: z.object({
    frequencyTicks: z.literal(
      RIVERBEND_SECURITIES_AUCTION_SCHEDULE.frequencyTicks,
    ),
    offsetTick: z.literal(RIVERBEND_SECURITIES_AUCTION_SCHEDULE.offsetTick),
  }).strict(),
  priceBandBp: z.literal(RIVERBEND_SECURITIES_PRICE_BAND_BP),
  status: z.enum(["open", "halted", "closed"]),
  openedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict();

export const securitySchema = z.object({
  id: securityIdSchema,
  runId: runIdSchema,
  marketId: securitiesMarketIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  symbol: securitySymbolSchema,
  sharesListed: positiveIntegerSchema,
  referencePriceCents: positiveIntegerSchema,
  listedTick: z.number().int().nonnegative().safe(),
  status: z.enum(["listed", "suspended", "delisted"]),
  eligibility: securitiesListingEligibilityAssessmentSchema,
  sourceEventId: eventIdSchema,
}).strict();

export const listSecurityInputSchema = z.object({
  companyId: ventureTargetCompanyIdSchema,
  symbol: securitySymbolSchema,
  sharesListed: positiveIntegerSchema,
  referencePriceCents: positiveIntegerSchema,
}).strict();

export const securitiesMarketOpenedPayloadSchema = z.object({
  marketId: securitiesMarketIdSchema,
  operatorInstitutionId: z.literal(RIVERBEND_SECURITIES_EXCHANGE_ID),
  priceBandBp: z.literal(RIVERBEND_SECURITIES_PRICE_BAND_BP),
  openedTick: z.number().int().nonnegative().safe(),
}).strict();

export const securityListedPayloadSchema = z.object({
  securityId: securityIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  symbol: securitySymbolSchema,
  sharesListed: positiveIntegerSchema,
  // API_CONTRACTS.md freezes this V1 event key as referencePrice.
  referencePrice: positiveIntegerSchema,
}).strict();

export type SecuritiesMarket = z.infer<typeof securitiesMarketSchema>;
export type Security = z.infer<typeof securitySchema>;
export type ListSecurityInput = z.infer<typeof listSecurityInputSchema>;
export type SecuritiesMarketOpenedPayload = z.infer<
  typeof securitiesMarketOpenedPayloadSchema
>;
export type SecurityListedPayload = z.infer<typeof securityListedPayloadSchema>;
