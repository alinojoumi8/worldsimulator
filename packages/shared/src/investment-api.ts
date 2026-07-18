/** Contract-backed Phase 8 proposal, investment, cap-table, and distribution reads. */

import { z } from "zod";
import {
  apiMetaSchema,
  eventIdSchema,
  opaqueCursorSchema,
} from "./api";
import { agentIdSchema } from "./agent";
import {
  conversationCloseReasonSchema,
  conversationOutcomeKindSchema,
  conversationStatusSchema,
} from "./conversation";
import { actorRefSchema } from "./envelope";
import { ledgerTransactionSchema } from "./finance";
import { legalContractIdSchema } from "./legal";
import { runIdSchema, simulationIdSchema } from "./simulation";
import {
  investmentDistributionIdSchema,
  investmentIdSchema,
  investmentProposalIdSchema,
  investmentProposalRejectionReasonSchema,
  investmentProposalStatusSchema,
  investmentStructuredTermsSchema,
  ownershipStakeIdSchema,
  ventureCapitalFirmIdSchema,
  ventureFundIdSchema,
  ventureTargetCompanyIdSchema,
} from "./venture";

const positiveIntegerQuery = z.coerce.number().int().min(1).safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);
const nonnegativeIntegerString = z.string().regex(/^(0|[1-9]\d*)$/);
const signedIntegerString = z.string().regex(/^-?(0|[1-9]\d*)$/);

export const investmentRunQuerySchema = z.object({
  runId: runIdSchema.optional(),
}).strict();

export const investmentProposalListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  status: investmentProposalStatusSchema.optional(),
  companyId: ventureTargetCompanyIdSchema.optional(),
}).strict();

export const investmentListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  companyId: ventureTargetCompanyIdSchema.optional(),
  fundId: ventureFundIdSchema.optional(),
}).strict();

export const investmentDistributionListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  companyId: ventureTargetCompanyIdSchema.optional(),
}).strict();

export const investmentProposalPathSchema = z.object({
  simId: simulationIdSchema,
  proposalId: investmentProposalIdSchema,
}).strict();

export const investmentPathSchema = z.object({
  simId: simulationIdSchema,
  investmentId: investmentIdSchema,
}).strict();

export const investmentDistributionPathSchema = z.object({
  simId: simulationIdSchema,
  distributionId: investmentDistributionIdSchema,
}).strict();

export const investmentCapTablePathSchema = z.object({
  simId: simulationIdSchema,
  companyId: ventureTargetCompanyIdSchema,
}).strict();

export const investmentNamedAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(120),
}).strict();

export const investmentCompanyRefSchema = z.object({
  id: ventureTargetCompanyIdSchema,
  name: z.string().trim().min(1).max(120),
}).strict();

export const investmentFirmRefSchema = z.object({
  id: ventureCapitalFirmIdSchema,
  name: z.string().trim().min(1).max(120),
}).strict();

export const investmentFundRefSchema = z.object({
  id: ventureFundIdSchema,
  name: z.string().trim().min(1).max(120),
}).strict();

export const investmentProposalListItemSchema = z.object({
  id: investmentProposalIdSchema,
  company: investmentCompanyRefSchema,
  founder: investmentNamedAgentSchema,
  firm: investmentFirmRefSchema,
  fund: investmentFundRefSchema,
  vcPartner: investmentNamedAgentSchema,
  askAmountCents: positiveIntegerString,
  preMoneyValuationCents: positiveIntegerString,
  initialEquityBasisPoints: z.number().int().min(1).max(9_999).safe(),
  status: investmentProposalStatusSchema,
  conversationId: z.string().regex(/^cnv_[0-9a-z]{8,}$/).nullable(),
  finalTerms: investmentStructuredTermsSchema.nullable(),
  proposedTick: nonnegativeInteger,
  expiresTick: z.number().int().positive().safe(),
  investmentId: investmentIdSchema.nullable(),
  sourceEventId: eventIdSchema,
  lastTransitionEventId: eventIdSchema,
}).strict();

export const investmentProposalListResponseSchema = z.object({
  items: z.array(investmentProposalListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const investmentTermsViewSchema = z.object({
  amountCents: positiveIntegerString,
  preMoneyValuationCents: positiveIntegerString,
  equityBasisPoints: z.number().int().min(1).max(9_999).safe(),
}).strict();

export const investmentTermsDiffSchema = z.object({
  initial: investmentTermsViewSchema,
  final: investmentTermsViewSchema.nullable(),
  amountDeltaCents: signedIntegerString.nullable(),
  preMoneyDeltaCents: signedIntegerString.nullable(),
  equityDeltaBasisPoints: z.number().int().min(-9_998).max(9_998).safe().nullable(),
}).strict();

export const investmentConversationSummarySchema = z.object({
  id: z.string().regex(/^cnv_[0-9a-z]{8,}$/),
  status: conversationStatusSchema,
  turns: z.number().int().min(0).max(6).safe(),
  maxTurns: z.number().int().min(1).max(6).safe(),
  closeReason: conversationCloseReasonSchema.nullable(),
  outcomeKind: conversationOutcomeKindSchema.nullable(),
  startTick: nonnegativeInteger,
  endTick: nonnegativeInteger.nullable(),
  sourceEventId: eventIdSchema,
}).strict();

export const investmentDecisionEvidenceSchema = z.object({
  status: investmentProposalStatusSchema,
  rejectionReason: investmentProposalRejectionReasonSchema.nullable(),
  validation: z.object({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(500),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict().nullable(),
  eventId: eventIdSchema.nullable(),
  causationId: eventIdSchema.nullable(),
  evidenceEventIds: z.array(eventIdSchema).max(40),
}).strict();

export const investmentTimelineItemSchema = z.object({
  eventId: eventIdSchema,
  tick: nonnegativeInteger,
  type: z.string().trim().min(1).max(160),
  actor: actorRefSchema,
  correlationId: z.string().trim().min(1).max(160),
  causationId: eventIdSchema.nullable(),
  evidenceEventIds: z.array(eventIdSchema).max(40),
}).strict();

export const investmentProposalDetailResponseSchema = z.object({
  proposal: investmentProposalListItemSchema,
  conversation: investmentConversationSummarySchema.nullable(),
  termsDiff: investmentTermsDiffSchema,
  decision: investmentDecisionEvidenceSchema,
  timeline: z.array(investmentTimelineItemSchema).max(200),
  meta: apiMetaSchema,
}).strict();

export const investmentListItemSchema = z.object({
  id: investmentIdSchema,
  proposalId: investmentProposalIdSchema,
  company: investmentCompanyRefSchema,
  firm: investmentFirmRefSchema,
  investor: investmentFundRefSchema,
  amountCents: positiveIntegerString,
  preMoneyValuationCents: positiveIntegerString,
  sharesIssued: positiveIntegerString,
  totalSharesBefore: positiveIntegerString,
  totalSharesAfter: positiveIntegerString,
  pricePerShareCents: positiveIntegerString,
  ownershipBasisPoints: z.number().int().min(1).max(9_999).safe(),
  completedTick: nonnegativeInteger,
  sourceEventId: eventIdSchema,
}).strict();

export const investmentListResponseSchema = z.object({
  items: z.array(investmentListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const investmentCapTableStakeSchema = z.object({
  id: ownershipStakeIdSchema,
  holder: z.object({
    kind: z.enum(["agent", "venture_fund"]),
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
  }).strict(),
  shares: positiveIntegerString,
  ownershipBasisPoints: z.number().int().min(0).max(10_000).safe(),
  acquiredVia: z.enum(["founding", "investment", "trade"]),
  sinceTick: nonnegativeInteger,
}).strict().superRefine((stake, ctx) => {
  if (stake.holder.kind === "agent" && !agentIdSchema.safeParse(stake.holder.id).success) {
    ctx.addIssue({ code: "custom", path: ["holder", "id"], message: "agent holder requires an agent id" });
  }
  if (
    stake.holder.kind === "venture_fund" &&
    !ventureFundIdSchema.safeParse(stake.holder.id).success
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["holder", "id"],
      message: "venture-fund holder requires a venture fund id",
    });
  }
});

export const investmentCapTableViewSchema = z.object({
  company: investmentCompanyRefSchema,
  totalShares: positiveIntegerString,
  stakes: z.array(investmentCapTableStakeSchema).max(200),
}).strict().superRefine((capTable, ctx) => {
  const sum = capTable.stakes.reduce((total, stake) => total + BigInt(stake.shares), 0n);
  if (sum !== BigInt(capTable.totalShares)) {
    ctx.addIssue({
      code: "custom",
      path: ["totalShares"],
      message: "resolved cap-table stakes must sum exactly to total shares",
    });
  }
});

export const investmentCapTableResponseSchema = z.object({
  capTable: investmentCapTableViewSchema,
  meta: apiMetaSchema,
}).strict();

export const investmentDistributionListItemSchema = z.object({
  id: investmentDistributionIdSchema,
  company: investmentCompanyRefSchema,
  amountCents: positiveIntegerString,
  totalShares: positiveIntegerString,
  referenceId: z.string().trim().min(1).max(160),
  distributedTick: nonnegativeInteger,
  transactionId: ledgerTransactionSchema.shape.id,
  allocationCount: z.number().int().positive().max(200).safe(),
  requestEventId: eventIdSchema,
  sourceEventId: eventIdSchema,
}).strict();

export const investmentDistributionListResponseSchema = z.object({
  items: z.array(investmentDistributionListItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();

export const investmentDistributionAllocationViewSchema = z.object({
  allocationIndex: nonnegativeInteger.max(199),
  holder: investmentCapTableStakeSchema.shape.holder,
  shares: positiveIntegerString,
  amountCents: nonnegativeIntegerString,
  accountId: z.string().trim().min(1).max(120),
  ownershipBasisPoints: z.number().int().min(0).max(10_000).safe(),
}).strict();

export const investmentDistributionDetailResponseSchema = z.object({
  distribution: investmentDistributionListItemSchema.extend({
    companyAccountId: z.string().trim().min(1).max(120),
    allocations: z.array(investmentDistributionAllocationViewSchema).min(1).max(200),
  }).strict(),
  meta: apiMetaSchema,
}).strict();

export const investmentDetailResponseSchema = z.object({
  investment: investmentListItemSchema.extend({
    transactionId: ledgerTransactionSchema.shape.id,
    capitalCallTransactionId: ledgerTransactionSchema.shape.id.nullable(),
    contractId: legalContractIdSchema,
    ownershipStakeId: ownershipStakeIdSchema,
  }).strict(),
  proposal: investmentProposalListItemSchema,
  capTableBefore: investmentCapTableViewSchema,
  capTableAfter: investmentCapTableViewSchema,
  distributions: z.array(investmentDistributionListItemSchema).max(200),
  why: z.object({
    sourceEventId: eventIdSchema,
    causationId: eventIdSchema,
    evidenceEventIds: z.array(eventIdSchema).max(40),
    contractId: legalContractIdSchema,
    transactionId: ledgerTransactionSchema.shape.id,
    capitalCallTransactionId: ledgerTransactionSchema.shape.id.nullable(),
    ownershipStakeId: ownershipStakeIdSchema,
  }).strict(),
  timeline: z.array(investmentTimelineItemSchema).max(200),
  meta: apiMetaSchema,
}).strict();

export type InvestmentRunQuery = z.infer<typeof investmentRunQuerySchema>;
export type InvestmentProposalListQuery = z.infer<typeof investmentProposalListQuerySchema>;
export type InvestmentListQuery = z.infer<typeof investmentListQuerySchema>;
export type InvestmentDistributionListQuery = z.infer<
  typeof investmentDistributionListQuerySchema
>;
export type InvestmentProposalListItem = z.infer<typeof investmentProposalListItemSchema>;
export type InvestmentProposalListResponse = z.infer<
  typeof investmentProposalListResponseSchema
>;
export type InvestmentProposalDetailResponse = z.infer<
  typeof investmentProposalDetailResponseSchema
>;
export type InvestmentTimelineItem = z.infer<typeof investmentTimelineItemSchema>;
export type InvestmentListItem = z.infer<typeof investmentListItemSchema>;
export type InvestmentListResponse = z.infer<typeof investmentListResponseSchema>;
export type InvestmentCapTableView = z.infer<typeof investmentCapTableViewSchema>;
export type InvestmentCapTableResponse = z.infer<typeof investmentCapTableResponseSchema>;
export type InvestmentDistributionListItem = z.infer<
  typeof investmentDistributionListItemSchema
>;
export type InvestmentDistributionListResponse = z.infer<
  typeof investmentDistributionListResponseSchema
>;
export type InvestmentDistributionDetailResponse = z.infer<
  typeof investmentDistributionDetailResponseSchema
>;
export type InvestmentDetailResponse = z.infer<typeof investmentDetailResponseSchema>;
