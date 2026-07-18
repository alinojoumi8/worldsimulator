/** Contract-backed Phase 4 company, labor, institution, and goods-market reads. */

import { z } from "zod";
import {
  apiMetaSchema,
  centsObjectSchema,
  eventIdSchema,
  opaqueCursorSchema,
} from "./api";
import { agentIdSchema } from "./agent";
import { runIdSchema, simulationIdSchema } from "./simulation";
import {
  companyIdSchema,
  companyFormationStageSchema,
  companyStatusSchema,
  jobApplicationSchema,
  jobIdSchema,
  jobSchema,
  legalContractIdSchema,
  legalContractSchema,
  legalContractStatusSchema,
  legalContractTypeSchema,
} from "./legal";
import {
  productCatalogItemSchema,
  productSkuSchema,
} from "./market";
import { ventureFundIdSchema } from "./venture";

const positiveIntegerQuery = z.coerce.number().int().min(1).safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const nonnegativeCents = z.string().regex(/^\d+$/);
const signedCents = z.string().regex(/^-?\d+$/);
const institutionIdSchema = z.string().regex(/^inst_[a-z0-9_]+$/);
const recordSchema = z.record(z.string(), z.unknown());

export const institutionKindSchema = z.enum([
  "bank",
  "vc_firm",
  "law_firm",
  "school",
  "news_org",
  "government",
  "market_operator",
  "energy_co",
]);

export const phase4RunQuerySchema = z.object({
  runId: runIdSchema.optional(),
}).strict();

export const companyListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  status: companyStatusSchema.optional(),
  sector: z.string().trim().min(1).max(80).optional(),
}).strict();

export const companyPathSchema = z.object({
  simId: simulationIdSchema,
  companyId: companyIdSchema,
}).strict();

export const namedAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(120),
}).strict();

export const companyEquityHolderSchema = z.discriminatedUnion("kind", [
  namedAgentSchema.extend({
    kind: z.literal("agent"),
  }).strict(),
  z.object({
    kind: z.literal("venture_fund"),
    id: ventureFundIdSchema,
    name: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const companyListItemSchema = z.object({
  id: companyIdSchema,
  name: z.string().trim().min(2).max(120),
  sector: z.string().trim().min(1).max(80),
  status: companyStatusSchema,
  formationStage: companyFormationStageSchema,
  foundedTick: nonnegativeInteger,
  employees: nonnegativeInteger,
  cash: centsObjectSchema,
  lastProfit: centsObjectSchema.extend({ cents: signedCents }),
  consecutiveShortfallDays: nonnegativeInteger,
}).strict();

export const companyListResponseSchema = z.object({
  items: z.array(companyListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const companyTimelineItemSchema = z.object({
  id: z.string().min(1),
  tick: nonnegativeInteger,
  type: z.string().trim().min(1).max(160),
  sourceEventId: eventIdSchema.nullable(),
  referenceId: z.string().min(1).nullable(),
  details: recordSchema,
}).strict();

export const companyDetailResponseSchema = z.object({
  company: z.object({
    id: companyIdSchema,
    name: z.string().trim().min(2).max(120),
    sector: z.string().trim().min(1).max(80),
    status: companyStatusSchema,
    formationStage: companyFormationStageSchema,
    foundedTick: nonnegativeInteger,
    registeredTick: nonnegativeInteger.nullable(),
    activatedTick: nonnegativeInteger.nullable(),
    incorporationContractId: legalContractIdSchema,
    businessAccountId: z.string().min(1).nullable(),
    failureReason: z.string().min(1).nullable(),
    founder: namedAgentSchema,
  }).strict(),
  capTable: z.array(z.object({
    holder: companyEquityHolderSchema,
    shares: z.string().regex(/^[1-9]\d*$/),
    ownershipBp: z.number().int().min(0).max(10_000),
  }).strict()),
  staff: z.array(z.object({
    employmentId: z.string().min(1),
    agent: namedAgentSchema,
    title: z.string().min(1),
    annualWageCents: nonnegativeCents,
    status: z.enum(["active", "ended"]),
    startTick: nonnegativeInteger,
    endTick: nonnegativeInteger.nullable(),
    legalContractId: legalContractIdSchema.nullable(),
  }).strict()),
  offerings: z.array(z.object({
    id: z.string().regex(/^off_[0-9a-z]{8,}$/),
    sku: productSkuSchema,
    postedPriceCents: nonnegativeCents,
    unitCostCents: nonnegativeCents,
    inventory: nonnegativeInteger.nullable(),
    active: z.boolean(),
    createdTick: nonnegativeInteger,
  }).strict()),
  jobs: z.array(z.object({
    id: jobIdSchema,
    title: z.string().min(1),
    status: jobSchema.shape.status,
    annualWageCents: nonnegativeCents,
    openings: positiveIntegerQuery,
    filledCount: nonnegativeInteger,
  }).strict()),
  financials: z.object({
    cashCents: nonnegativeCents,
    revenue30Cents: nonnegativeCents,
    costs30Cents: nonnegativeCents,
    profit30Cents: signedCents,
  }).strict(),
  solvency: z.object({
    tick: nonnegativeInteger,
    cashCents: nonnegativeCents,
    obligationCents: nonnegativeCents,
    shortfallCents: nonnegativeCents,
    consecutiveShortfallDays: nonnegativeInteger,
    insolvent: z.boolean(),
    sourceEventId: eventIdSchema,
  }).strict().nullable(),
  windDown: z.object({
    completedTick: nonnegativeInteger,
    openingCashCents: nonnegativeCents,
    salvageProceedsCents: nonnegativeCents,
    liquidationPoolCents: nonnegativeCents,
    creditorRecoveriesCents: nonnegativeCents,
    writtenOffCents: nonnegativeCents,
    employeesTerminated: nonnegativeInteger,
    contractsTerminated: nonnegativeInteger,
    jobsWithdrawn: nonnegativeInteger,
    offeringsDeactivated: nonnegativeInteger,
    sourceEventId: eventIdSchema,
  }).strict().nullable(),
  timeline: z.array(companyTimelineItemSchema),
  meta: apiMetaSchema,
}).strict();

export const contractListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  type: legalContractTypeSchema.optional(),
  party: z.string().trim().min(1).max(120).optional(),
  status: legalContractStatusSchema.optional(),
}).strict();

export const contractPathSchema = z.object({
  simId: simulationIdSchema,
  contractId: legalContractIdSchema,
}).strict();

export const contractPartyViewSchema = z.object({
  kind: z.enum(["agent", "company", "institution"]),
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  signedTick: nonnegativeInteger.nullable(),
}).strict();

export const contractListItemSchema = z.object({
  id: legalContractIdSchema,
  type: legalContractTypeSchema,
  parties: z.array(contractPartyViewSchema).min(2),
  status: legalContractStatusSchema,
  effectiveTick: nonnegativeInteger,
  terminalTick: nonnegativeInteger.nullable(),
  feeCents: nonnegativeCents,
}).strict();

export const contractListResponseSchema = z.object({
  items: z.array(contractListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const contractDetailResponseSchema = z.object({
  contract: legalContractSchema,
  partyDetails: z.array(contractPartyViewSchema).min(2),
  timeline: z.array(z.object({
    id: z.string().min(1),
    tick: nonnegativeInteger,
    type: z.string().min(1),
    details: recordSchema,
  }).strict()),
  meta: apiMetaSchema,
}).strict();

export const jobListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  status: jobSchema.shape.status.optional(),
  companyId: companyIdSchema.optional(),
  occupation: jobSchema.shape.occupationCode.optional(),
}).strict();

export const jobPathSchema = z.object({
  simId: simulationIdSchema,
  jobId: jobIdSchema,
}).strict();

export const jobListItemSchema = z.object({
  id: jobIdSchema,
  employer: z.object({ id: companyIdSchema, name: z.string().min(1) }).strict(),
  occupationCode: jobSchema.shape.occupationCode,
  title: z.string().min(1),
  annualWageCents: nonnegativeCents,
  openings: positiveIntegerQuery,
  filledCount: nonnegativeInteger,
  status: jobSchema.shape.status,
  postedTick: nonnegativeInteger,
  expiresTick: nonnegativeInteger.nullable(),
  applicationCount: nonnegativeInteger,
  payrollRisk: z.boolean(),
}).strict();

export const jobListResponseSchema = z.object({
  items: z.array(jobListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const jobDetailResponseSchema = z.object({
  job: jobSchema,
  employer: z.object({ id: companyIdSchema, name: z.string().min(1) }).strict(),
  applications: z.array(z.object({
    application: jobApplicationSchema,
    agent: namedAgentSchema,
  }).strict()),
  employmentContracts: z.array(z.object({
    id: z.string().min(1),
    employee: namedAgentSchema,
    legalContractId: legalContractIdSchema.nullable(),
    startTick: nonnegativeInteger,
    endTick: nonnegativeInteger.nullable(),
    status: z.enum(["active", "ended"]),
  }).strict()),
  meta: apiMetaSchema,
}).strict();

export const institutionListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  kind: institutionKindSchema.optional(),
}).strict();

export const institutionPathSchema = z.object({
  simId: simulationIdSchema,
  institutionId: institutionIdSchema,
}).strict();

export const institutionSummarySchema = z.object({
  id: institutionIdSchema,
  kind: institutionKindSchema,
  name: z.string().min(1),
  staffCount: nonnegativeInteger,
  keyFigures: recordSchema,
}).strict();

export const institutionListResponseSchema = z.object({
  items: z.array(institutionSummarySchema),
  nextCursor: z.null(),
  meta: apiMetaSchema,
}).strict();

export const institutionDetailResponseSchema = z.object({
  institution: institutionSummarySchema,
  officeholders: z.array(z.object({
    role: z.string().min(1),
    agent: namedAgentSchema,
  }).strict()),
  rulebook: recordSchema,
  meta: apiMetaSchema,
}).strict();

export const goodsMarketResponseSchema = z.object({
  market: z.object({
    id: z.literal("goods_riverbend"),
    kind: z.literal("posted_price"),
    tick: nonnegativeInteger,
    catalogVersion: z.literal(1),
  }).strict(),
  products: z.array(z.object({
    product: productCatalogItemSchema,
    currentRowReferencePriceCents: nonnegativeCents,
    demandMultiplierBp: z.number().int().min(1_000).max(50_000),
    offerings: z.array(z.object({
      id: z.string().regex(/^off_[0-9a-z]{8,}$/),
      company: z.object({ id: companyIdSchema, name: z.string().min(1) }).strict(),
      postedPriceCents: nonnegativeCents,
      averageUnitCostCents: nonnegativeCents,
      inventory: nonnegativeInteger.nullable(),
      active: z.boolean(),
    }).strict()),
  }).strict()),
  recentPriceChanges: z.array(z.object({
    id: z.string().min(1),
    offeringId: z.string().min(1),
    companyId: companyIdSchema,
    sku: productSkuSchema,
    tick: nonnegativeInteger,
    oldPriceCents: nonnegativeCents,
    newPriceCents: nonnegativeCents,
    source: z.enum(["rule", "decision"]),
    sourceEventId: eventIdSchema,
  }).strict()),
  energy: z.object({
    householdTariffCents: nonnegativeCents,
    businessTariffCents: nonnegativeCents,
    fuelPriceCents: nonnegativeCents,
  }).strict().nullable(),
  meta: apiMetaSchema,
}).strict();

export type Phase4RunQuery = z.infer<typeof phase4RunQuerySchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;
export type CompanyListItem = z.infer<typeof companyListItemSchema>;
export type CompanyListResponse = z.infer<typeof companyListResponseSchema>;
export type CompanyDetailResponse = z.infer<typeof companyDetailResponseSchema>;
export type ContractListQuery = z.infer<typeof contractListQuerySchema>;
export type ContractListResponse = z.infer<typeof contractListResponseSchema>;
export type ContractDetailResponse = z.infer<typeof contractDetailResponseSchema>;
export type JobListQuery = z.infer<typeof jobListQuerySchema>;
export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
export type InstitutionListQuery = z.infer<typeof institutionListQuerySchema>;
export type InstitutionKind = z.infer<typeof institutionKindSchema>;
export type InstitutionListResponse = z.infer<typeof institutionListResponseSchema>;
export type InstitutionDetailResponse = z.infer<typeof institutionDetailResponseSchema>;
export type GoodsMarketResponse = z.infer<typeof goodsMarketResponseSchema>;
