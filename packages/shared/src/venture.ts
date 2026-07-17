/** Authoritative M10 contracts for venture firms, funds, and deployed capital. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { bankAccountSchema, ledgerTransactionSchema } from "./finance";
import { companyIdSchema, legalContractIdSchema } from "./legal";
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
export const investmentIdSchema = z.string().regex(/^inv_[0-9a-z]{8,}$/);
export const ownershipStakeIdSchema = z.string().regex(/^stk_[0-9a-z]{8,}$/);
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
  bankAccountId: bankAccountSchema.shape.id,
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

const ownershipStakeBaseSchema = z.object({
  id: ownershipStakeIdSchema,
  runId: runIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  holderKind: z.enum(["agent", "venture_fund"]),
  holderId: z.string().trim().min(1).max(120),
  shares: positiveCentsSchema,
  acquiredVia: z.enum(["founding", "investment", "trade"]),
  sinceTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema.nullable(),
}).strict();

function validateOwnershipStake(
  stake: Pick<z.infer<typeof ownershipStakeBaseSchema>,
    "holderKind" | "holderId" | "acquiredVia">,
  ctx: z.RefinementCtx,
): void {
  if (stake.holderKind === "agent" && !agentIdSchema.safeParse(stake.holderId).success) {
    ctx.addIssue({ code: "custom", path: ["holderId"], message: "agent stake requires an agent id" });
  }
  if (
    stake.holderKind === "venture_fund" &&
    !ventureFundIdSchema.safeParse(stake.holderId).success
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["holderId"],
      message: "venture-fund stake requires a venture fund id",
    });
  }
  if (stake.acquiredVia === "founding" && stake.holderKind !== "agent") {
    ctx.addIssue({
      code: "custom",
      path: ["acquiredVia"],
      message: "founding stakes must be held by agents",
    });
  }
  if (stake.acquiredVia === "investment" && stake.holderKind !== "venture_fund") {
    ctx.addIssue({
      code: "custom",
      path: ["acquiredVia"],
      message: "investment stakes must be held by venture funds",
    });
  }
}

export const ownershipStakeSchema = ownershipStakeBaseSchema.superRefine(
  validateOwnershipStake,
);
export type OwnershipStake = z.infer<typeof ownershipStakeSchema>;

const capTableStakeSchema = ownershipStakeBaseSchema
  .omit({ runId: true, sourceEventId: true })
  .superRefine(validateOwnershipStake);

export const capTableSnapshotSchema = z.object({
  companyId: ventureTargetCompanyIdSchema,
  totalShares: positiveCentsSchema,
  stakes: z.array(capTableStakeSchema).max(200),
}).strict().superRefine((capTable, ctx) => {
  const ids = new Set<string>();
  let total = 0n;
  for (const [index, stake] of capTable.stakes.entries()) {
    total += BigInt(stake.shares);
    if (stake.companyId !== capTable.companyId) {
      ctx.addIssue({
        code: "custom",
        path: ["stakes", index, "companyId"],
        message: "every stake must belong to the cap-table company",
      });
    }
    if (ids.has(stake.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["stakes", index, "id"],
        message: "cap-table stake ids must be unique",
      });
    }
    ids.add(stake.id);
  }
  if (total !== BigInt(capTable.totalShares)) {
    ctx.addIssue({
      code: "custom",
      path: ["totalShares"],
      message: "cap-table stake shares must sum exactly to total shares",
    });
  }
});
export type CapTableSnapshot = z.infer<typeof capTableSnapshotSchema>;

export const investmentSchema = z.object({
  id: investmentIdSchema,
  runId: runIdSchema,
  proposalId: investmentProposalIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  investorId: ventureFundIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  amountCents: positiveCentsSchema,
  preMoneyValuationCents: positiveCentsSchema,
  sharesIssued: positiveCentsSchema,
  totalSharesBefore: positiveCentsSchema,
  totalSharesAfter: positiveCentsSchema,
  pricePerShareCents: positiveCentsSchema,
  transactionId: ledgerTransactionSchema.shape.id,
  capitalCallTransactionId: ledgerTransactionSchema.shape.id.nullable(),
  contractId: legalContractIdSchema,
  ownershipStakeId: ownershipStakeIdSchema,
  completedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((investment, ctx) => {
  const price = BigInt(investment.pricePerShareCents);
  const before = BigInt(investment.totalSharesBefore);
  const issued = BigInt(investment.sharesIssued);
  if (price * before !== BigInt(investment.preMoneyValuationCents)) {
    ctx.addIssue({ code: "custom", path: ["pricePerShareCents"], message: "invalid pre-money price identity" });
  }
  if (price * issued !== BigInt(investment.amountCents)) {
    ctx.addIssue({ code: "custom", path: ["sharesIssued"], message: "invalid investment price identity" });
  }
  if (before + issued !== BigInt(investment.totalSharesAfter)) {
    ctx.addIssue({ code: "custom", path: ["totalSharesAfter"], message: "invalid share issuance identity" });
  }
});
export type Investment = z.infer<typeof investmentSchema>;

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
  bankAccountId: bankAccountSchema.shape.id,
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
  validation: z.object({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(500),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
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

export const investmentCompletedPayloadSchema = z.object({
  investmentId: investmentIdSchema,
  proposalId: investmentProposalIdSchema,
  companyId: ventureTargetCompanyIdSchema,
  investorId: ventureFundIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  amountCents: positiveCentsSchema,
  preMoneyValuationCents: positiveCentsSchema,
  sharesIssued: positiveCentsSchema,
  pricePerShareCents: positiveCentsSchema,
  transactionId: ledgerTransactionSchema.shape.id,
  capitalCallTransactionId: ledgerTransactionSchema.shape.id.nullable(),
  contractId: legalContractIdSchema,
  ownershipStakeId: ownershipStakeIdSchema,
  completedTick: z.number().int().nonnegative().safe(),
  capTableBefore: capTableSnapshotSchema,
  capTableAfter: capTableSnapshotSchema,
  evidence: evidenceSchema,
}).strict().superRefine((payload, ctx) => {
  if (payload.capTableBefore.companyId !== payload.companyId ||
      payload.capTableAfter.companyId !== payload.companyId) {
    ctx.addIssue({ code: "custom", path: ["capTableAfter"], message: "cap tables must belong to the invested company" });
  }
  if (
    BigInt(payload.capTableBefore.totalShares) + BigInt(payload.sharesIssued) !==
    BigInt(payload.capTableAfter.totalShares)
  ) {
    ctx.addIssue({ code: "custom", path: ["capTableAfter", "totalShares"], message: "cap-table diff does not match issued shares" });
  }
  const price = BigInt(payload.pricePerShareCents);
  if (price * BigInt(payload.capTableBefore.totalShares) !==
      BigInt(payload.preMoneyValuationCents)) {
    ctx.addIssue({ code: "custom", path: ["pricePerShareCents"], message: "completion price does not match pre-money valuation" });
  }
  if (price * BigInt(payload.sharesIssued) !== BigInt(payload.amountCents)) {
    ctx.addIssue({ code: "custom", path: ["sharesIssued"], message: "completion issuance does not match invested cash" });
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
export type InvestmentCompletedPayload = z.infer<typeof investmentCompletedPayloadSchema>;
