import { z } from "zod";
import { runIdSchema } from "./simulation";
import { ventureTargetCompanyIdSchema } from "./venture";

const SIGNED_SQLITE_MAXIMUM = 9_223_372_036_854_775_807n;
const SIGNED_SQLITE_MINIMUM = -9_223_372_036_854_775_808n;

function withinSignedSqliteRange(value: string): boolean {
  const parsed = BigInt(value);
  return parsed >= SIGNED_SQLITE_MINIMUM && parsed <= SIGNED_SQLITE_MAXIMUM;
}

const signedIntegerSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/)
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
}).strict();

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
  const profitability =
    BigInt(input.profit30Cents) >= BigInt(parsedPolicy.minimumProfit30Cents);
  const capital =
    BigInt(input.capitalCents) >= BigInt(parsedPolicy.minimumCapitalCents);
  const checks = Object.freeze({
    active: input.companyActive,
    minimumAge:
      input.assessedTick - input.foundedTick >= parsedPolicy.minimumAgeTicks,
    profitability,
    capital,
    sharesWithinTotal:
      BigInt(input.requestedShares) <= BigInt(input.totalShares),
  });
  const eligibilityBasis = profitability && capital
    ? "both"
    : profitability
      ? "profitability"
      : capital
        ? "capital"
        : null;
  return securitiesListingEligibilityAssessmentSchema.parse({
    policy: parsedPolicy,
    ...input,
    ageTicks: input.assessedTick - input.foundedTick,
    checks,
    eligibilityBasis,
    eligible:
      checks.active &&
      checks.minimumAge &&
      (checks.profitability || checks.capital) &&
      checks.sharesWithinTotal,
  });
}

export const securitiesMarketSchema = z.object({
  id: securitiesMarketIdSchema,
  runId: runIdSchema,
  kind: z.literal("securities"),
  operatorInstitutionId: z.literal(RIVERBEND_SECURITIES_EXCHANGE_ID),
  auctionSchedule: z.object({
    frequencyTicks: z.number().int().positive().safe(),
    offsetTick: z.number().int().nonnegative().safe(),
  }).strict(),
  priceBandBp: z.number().int().min(1).max(10_000).safe(),
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
  priceBandBp: z.number().int().min(1).max(10_000).safe(),
  openedTick: z.number().int().nonnegative().safe(),
}).strict();

export const securityListedPayloadSchema = z.object({
  securityId: securityIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  symbol: securitySymbolSchema,
  sharesListed: positiveIntegerSchema,
  referencePrice: positiveIntegerSchema,
}).strict();

export type SecuritiesMarket = z.infer<typeof securitiesMarketSchema>;
export type Security = z.infer<typeof securitySchema>;
export type ListSecurityInput = z.infer<typeof listSecurityInputSchema>;
export type SecuritiesMarketOpenedPayload = z.infer<
  typeof securitiesMarketOpenedPayloadSchema
>;
export type SecurityListedPayload = z.infer<typeof securityListedPayloadSchema>;
