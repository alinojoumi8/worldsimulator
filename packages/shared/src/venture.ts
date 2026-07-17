/** Authoritative M10 contracts for venture firms, funds, and deployed capital. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { companyIdSchema } from "./legal";
import { runIdSchema } from "./simulation";

const signedSqliteMaximum = "9223372036854775807";
const withinSignedSqliteRange = (value: string): boolean => (
  value.length < signedSqliteMaximum.length ||
  (value.length === signedSqliteMaximum.length && value <= signedSqliteMaximum)
);
const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/).refine(withinSignedSqliteRange, {
  message: "integer cents exceed the authoritative SQLite range",
});
const nonnegativeCentsSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(withinSignedSqliteRange, {
  message: "integer cents exceed the authoritative SQLite range",
});
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

export const ventureCapitalFirmIdSchema = z.string().regex(/^inst_[0-9a-z_]{3,}$/);
export const ventureFundIdSchema = z.string().regex(/^vfund_[0-9a-z]{8,}$/);
export const ventureFundDeploymentIdSchema = z.string().regex(/^vdep_[0-9a-z]{8,}$/);
export const investmentProposalIdSchema = z.string().regex(/^prop_[0-9a-z]{8,}$/);
export const ventureTargetCompanyIdSchema = z.union([
  companyIdSchema,
  z.string().regex(/^biz_[0-9a-z_]{3,}$/),
]);
export const ventureCapitalFirmStatusSchema = z.enum(["active", "closed"]);
export const ventureFundStatusSchema = z.enum(["open", "fully_deployed", "closed"]);
export const investmentProposalStatusSchema = z.enum([
  "proposed",
  "negotiating",
  "agreed",
  "completed",
  "rejected",
  "expired",
]);
export const investmentProposalRejectionReasonSchema = z.enum([
  "negotiation_declined",
  "negotiation_no_agreement",
  "negotiation_escalated",
  "proposal_expired",
  "terms_invalid",
]);
export type InvestmentProposalRejectionReason = z.infer<
  typeof investmentProposalRejectionReasonSchema
>;

const conversationIdSchema = z.string().regex(/^cnv_[0-9a-z]{8,}$/);
const evidenceSchema = z.array(z.string().trim().min(1).max(160)).max(20);

/** Nearest integer ownership share of post-money value, expressed in basis points. */
export function investmentEquityBasisPoints(
  amountCents: string,
  preMoneyValuationCents: string,
): number {
  const amount = positiveCentsSchema.safeParse(amountCents);
  const preMoney = positiveCentsSchema.safeParse(preMoneyValuationCents);
  if (!amount.success || !preMoney.success) {
    throw new RangeError("investment amount and pre-money valuation must be positive integer cents");
  }
  const amountValue = BigInt(amount.data);
  const postMoneyValue = BigInt(preMoney.data) + amountValue;
  return Number((amountValue * 10_000n + postMoneyValue / 2n) / postMoneyValue);
}

export const investmentTermBoundsSchema = z.object({
  kind: z.literal("investment"),
  referenceId: investmentProposalIdSchema,
  minAmountCents: positiveCentsSchema,
  maxAmountCents: positiveCentsSchema,
  minPreMoneyValuationCents: positiveCentsSchema,
  maxPreMoneyValuationCents: positiveCentsSchema,
}).strict().superRefine((bounds, ctx) => {
  if (BigInt(bounds.minAmountCents) > BigInt(bounds.maxAmountCents)) {
    ctx.addIssue({
      code: "custom",
      path: ["maxAmountCents"],
      message: "maximum investment amount must be at least the minimum",
    });
  }
  if (
    BigInt(bounds.minPreMoneyValuationCents) >
    BigInt(bounds.maxPreMoneyValuationCents)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["maxPreMoneyValuationCents"],
      message: "maximum pre-money valuation must be at least the minimum",
    });
  }
});
export type InvestmentTermBounds = z.infer<typeof investmentTermBoundsSchema>;

export const investmentStructuredTermsSchema = z.object({
  kind: z.literal("investment"),
  referenceId: investmentProposalIdSchema,
  amountCents: positiveCentsSchema,
  preMoneyValuationCents: positiveCentsSchema,
  equityBasisPoints: z.number().int().min(1).max(9_999).safe(),
}).strict().superRefine((terms, ctx) => {
  const expected = investmentEquityBasisPoints(
    terms.amountCents,
    terms.preMoneyValuationCents,
  );
  if (Math.abs(terms.equityBasisPoints - expected) > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["equityBasisPoints"],
      message: "equity basis points are inconsistent with amount and pre-money valuation",
    });
  }
});
export type InvestmentStructuredTerms = z.infer<typeof investmentStructuredTermsSchema>;

export const ventureCapitalFirmSchema = z.object({
  id: ventureCapitalFirmIdSchema,
  runId: runIdSchema,
  name: z.string().trim().min(2).max(120),
  status: ventureCapitalFirmStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict();
export type VentureCapitalFirm = z.infer<typeof ventureCapitalFirmSchema>;

export const ventureFundSchema = z.object({
  id: ventureFundIdSchema,
  runId: runIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  name: z.string().trim().min(2).max(120),
  fundSizeCents: positiveCentsSchema,
  deployedCents: nonnegativeCentsSchema,
  status: ventureFundStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((fund, ctx) => {
  const fundSize = BigInt(fund.fundSizeCents);
  const deployed = BigInt(fund.deployedCents);
  if (deployed > fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["deployedCents"],
      message: "deployedCents cannot exceed fundSizeCents",
    });
  }
  if (fund.status === "fully_deployed" && deployed !== fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "fully_deployed requires the entire fund to be deployed",
    });
  }
  if (fund.status === "open" && deployed === fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "an open fund must retain undeployed capital",
    });
  }
});
export type VentureFund = z.infer<typeof ventureFundSchema>;

export const ventureFundDeploymentSchema = z.object({
  id: ventureFundDeploymentIdSchema,
  runId: runIdSchema,
  fundId: ventureFundIdSchema,
  targetCompanyId: ventureTargetCompanyIdSchema,
  referenceId: z.string().trim().min(1).max(160),
  amountCents: positiveCentsSchema,
  deployedBeforeCents: nonnegativeCentsSchema,
  deployedAfterCents: positiveCentsSchema,
  deployedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((deployment, ctx) => {
  if (
    BigInt(deployment.deployedBeforeCents) + BigInt(deployment.amountCents) !==
    BigInt(deployment.deployedAfterCents)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["deployedAfterCents"],
      message: "deployedAfterCents must equal deployedBeforeCents plus amountCents",
    });
  }
});
export type VentureFundDeployment = z.infer<typeof ventureFundDeploymentSchema>;

export const investmentProposalSchema = z.object({
  id: investmentProposalIdSchema,
  runId: runIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  founderAgentId: agentIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  fundId: ventureFundIdSchema,
  vcPartnerAgentId: agentIdSchema,
  askAmountCents: positiveCentsSchema,
  preMoneyValuationCents: positiveCentsSchema,
  initialEquityBasisPoints: z.number().int().min(1).max(9_999).safe(),
  status: investmentProposalStatusSchema,
  negotiationConversationId: conversationIdSchema.nullable(),
  finalTerms: investmentStructuredTermsSchema.nullable(),
  proposedTick: z.number().int().nonnegative().safe(),
  expiresTick: z.number().int().positive().safe(),
  sourceEventId: eventIdSchema,
  lastTransitionEventId: eventIdSchema,
}).strict().superRefine((proposal, ctx) => {
  if (proposal.founderAgentId === proposal.vcPartnerAgentId) {
    ctx.addIssue({
      code: "custom",
      path: ["vcPartnerAgentId"],
      message: "founder and VC partner must be distinct",
    });
  }
  if (proposal.expiresTick <= proposal.proposedTick) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresTick"],
      message: "investment proposal expiry must follow its proposed tick",
    });
  }
  const expectedEquity = investmentEquityBasisPoints(
    proposal.askAmountCents,
    proposal.preMoneyValuationCents,
  );
  if (Math.abs(proposal.initialEquityBasisPoints - expectedEquity) > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["initialEquityBasisPoints"],
      message: "initial equity basis points are inconsistent with the pitch terms",
    });
  }
  const conversationRequired = proposal.status !== "proposed";
  if (conversationRequired !== (proposal.negotiationConversationId !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["negotiationConversationId"],
      message: conversationRequired
        ? "post-proposal states require a negotiation conversation"
        : "a proposed investment cannot already reference a negotiation conversation",
    });
  }
  const termsRequired = proposal.status === "agreed" || proposal.status === "completed";
  if (termsRequired !== (proposal.finalTerms !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["finalTerms"],
      message: termsRequired
        ? "agreed and completed proposals require final terms"
        : "only agreed or completed proposals may retain final terms",
    });
  }
  if (
    proposal.finalTerms !== null &&
    proposal.finalTerms.referenceId !== proposal.id
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["finalTerms", "referenceId"],
      message: "final investment terms must reference their proposal",
    });
  }
});
export type InvestmentProposal = z.infer<typeof investmentProposalSchema>;

export const ventureFirmCreatedPayloadSchema = z.object({
  firmId: ventureCapitalFirmIdSchema,
  name: ventureCapitalFirmSchema.shape.name,
  status: ventureCapitalFirmStatusSchema,
  evidence: evidenceSchema,
}).strict();

export const ventureFundCreatedPayloadSchema = z.object({
  fundId: ventureFundIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  name: ventureFundSchema.shape.name,
  fundSizeCents: positiveCentsSchema,
  evidence: evidenceSchema,
}).strict();

export const ventureFundDeployedPayloadSchema = z.object({
  deploymentId: ventureFundDeploymentIdSchema,
  fundId: ventureFundIdSchema,
  targetCompanyId: ventureTargetCompanyIdSchema,
  referenceId: z.string().trim().min(1).max(160),
  amountCents: positiveCentsSchema,
  deployedBeforeCents: nonnegativeCentsSchema,
  deployedAfterCents: positiveCentsSchema,
  remainingCents: nonnegativeCentsSchema,
  evidence: evidenceSchema,
}).strict();

export const investmentProposedPayloadSchema = z.object({
  proposalId: investmentProposalIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  founderAgentId: agentIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  fundId: ventureFundIdSchema,
  vcPartnerAgentId: agentIdSchema,
  askAmountCents: positiveCentsSchema,
  preMoneyValuationCents: positiveCentsSchema,
  equityBasisPoints: z.number().int().min(1).max(9_999).safe(),
  proposedTick: z.number().int().nonnegative().safe(),
  expiresTick: z.number().int().positive().safe(),
  evidence: evidenceSchema,
}).strict();

export const investmentProposalAgreedPayloadSchema = z.object({
  proposalId: investmentProposalIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  negotiationConversationId: conversationIdSchema,
  finalTerms: investmentStructuredTermsSchema,
  evidence: evidenceSchema,
}).strict().superRefine((payload, ctx) => {
  if (payload.finalTerms.referenceId !== payload.proposalId) {
    ctx.addIssue({
      code: "custom",
      path: ["finalTerms", "referenceId"],
      message: "agreed terms must reference their proposal",
    });
  }
});

export const investmentRejectedPayloadSchema = z.object({
  proposalId: investmentProposalIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  negotiationConversationId: conversationIdSchema,
  reason: investmentProposalRejectionReasonSchema,
  status: z.enum(["rejected", "expired"]),
  evidence: evidenceSchema,
}).strict().superRefine((payload, ctx) => {
  if ((payload.reason === "proposal_expired") !== (payload.status === "expired")) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "only proposal_expired may use the expired status",
    });
  }
});

export type VentureFirmCreatedPayload = z.infer<typeof ventureFirmCreatedPayloadSchema>;
export type VentureFundCreatedPayload = z.infer<typeof ventureFundCreatedPayloadSchema>;
export type VentureFundDeployedPayload = z.infer<typeof ventureFundDeployedPayloadSchema>;
export type InvestmentProposedPayload = z.infer<typeof investmentProposedPayloadSchema>;
export type InvestmentProposalAgreedPayload = z.infer<
  typeof investmentProposalAgreedPayloadSchema
>;
export type InvestmentRejectedPayload = z.infer<typeof investmentRejectedPayloadSchema>;
