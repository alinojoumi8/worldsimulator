/** Stored-data API contracts for the WS-507 credit explorer. */

import { z } from "zod";
import { agentIdSchema, loanIdSchema } from "./agent";
import {
  bankLendingAssessmentSchema,
  creditScoreAssessmentSchema,
  loanApplicationDecisionSchema,
  loanApplicationReviewSchema,
  loanApplicationSchema,
  loanDefaultRecordSchema,
  loanStatusSchema,
} from "./credit";
import { bankSchema } from "./finance";
import { companyIdSchema } from "./legal";
import { runIdSchema, simulationIdSchema } from "./simulation";

const nonnegativeCentsSchema = z.string().regex(/^\d+$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const transactionIdSchema = z.string().regex(/^txn_[0-9a-z]{8,}$/);
const accountIdSchema = z.string().regex(/^acct_[0-9a-z]{8,}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const apiMetaSchema = z.object({ simulated: z.literal(true), apiVersion: z.literal(1) });

export const loanOriginSchema = z.enum(["opening_seed", "originated"]);
export const loanBorrowerKindSchema = z.enum(["agent", "company", "business"]);
export const loanBorrowerIdSchema = z.union([
  agentIdSchema,
  companyIdSchema,
  z.string().regex(/^biz_[a-z0-9_]+$/),
]);
export const loanViewStatusSchema = z.union([
  z.enum(["current", "delinquent"]),
  loanStatusSchema,
]);

export const loanListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  origin: loanOriginSchema.optional(),
  status: loanViewStatusSchema.optional(),
  bankId: bankSchema.shape.id.optional(),
  borrowerKind: loanBorrowerKindSchema.optional(),
  borrowerId: loanBorrowerIdSchema.optional(),
}).strict().superRefine((query, ctx) => {
  if (query.borrowerId === undefined || query.borrowerKind === undefined) return;
  const prefix = query.borrowerKind === "agent"
    ? "agt_"
    : query.borrowerKind === "company"
      ? "co_"
      : "biz_";
  if (!query.borrowerId.startsWith(prefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["borrowerId"],
      message: `borrowerId does not match ${query.borrowerKind}`,
    });
  }
});
export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

export const loanPathSchema = z.object({
  simId: simulationIdSchema,
  loanId: loanIdSchema,
}).strict();

export const loanListItemSchema = z.object({
  id: loanIdSchema,
  origin: loanOriginSchema,
  borrower: z.object({
    kind: loanBorrowerKindSchema,
    id: loanBorrowerIdSchema,
    name: z.string().trim().min(1).max(120),
  }).strict(),
  bank: z.object({
    id: bankSchema.shape.id,
    name: z.string().trim().min(1).max(120),
  }).strict(),
  purpose: z.string().trim().min(1).max(500),
  principalCents: nonnegativeCentsSchema,
  outstandingPrincipalCents: nonnegativeCentsSchema,
  annualRateBp: z.number().int().min(0).max(100_000).safe(),
  termMonths: z.number().int().min(1).max(360).safe(),
  status: loanViewStatusSchema,
  openedTick: z.number().int().nonnegative().safe(),
  progress: z.object({
    completedInstallments: z.number().int().nonnegative().safe(),
    missedInstallments: z.number().int().nonnegative().safe(),
    totalInstallments: z.number().int().positive().safe(),
    nextDueTick: z.number().int().nonnegative().safe().nullable(),
  }).strict(),
  sourceEventId: eventIdSchema,
}).strict();
export type LoanListItem = z.infer<typeof loanListItemSchema>;

export const loanListResponseSchema = z.object({
  items: z.array(loanListItemSchema),
  nextCursor: z.string().min(1).nullable(),
  meta: apiMetaSchema,
}).strict();
export type LoanListResponse = z.infer<typeof loanListResponseSchema>;

const loanScheduleItemSchema = z.object({
  installmentNumber: z.number().int().positive().safe(),
  dueTick: z.number().int().nonnegative().safe().nullable(),
  principalDueCents: nonnegativeCentsSchema,
  interestDueCents: nonnegativeCentsSchema,
  totalDueCents: nonnegativeCentsSchema,
  status: z.enum(["paid", "scheduled", "missed", "due", "completed"]),
  paidTick: z.number().int().nonnegative().safe().nullable(),
  transactionId: transactionIdSchema.nullable(),
  sourceEventId: eventIdSchema.nullable(),
}).strict().refine(
  (item) => BigInt(item.totalDueCents) ===
    BigInt(item.principalDueCents) + BigInt(item.interestDueCents),
  { path: ["totalDueCents"], message: "schedule total must equal principal plus interest" },
);

const openingSeedWhySchema = z.object({
  kind: z.literal("opening_seed"),
  explanation: z.string().trim().min(1).max(1_000),
  seasonedMonths: z.number().int().nonnegative().safe(),
  missedPayments: z.number().int().nonnegative().safe(),
  recognitionTransactionId: transactionIdSchema,
  bankAssetAccountId: accountIdSchema,
  borrowerDepositAccountId: accountIdSchema,
  scheduleDigest: digestSchema,
  sourceEventId: eventIdSchema,
  causationId: eventIdSchema,
  correlationId: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1).max(100),
}).strict();

const underwrittenWhySchema = z.object({
  kind: z.literal("underwritten"),
  explanation: z.string().trim().min(1).max(1_000),
  application: loanApplicationSchema,
  assessment: creditScoreAssessmentSchema,
  review: loanApplicationReviewSchema,
  decision: loanApplicationDecisionSchema,
  circuitAssessments: z.array(bankLendingAssessmentSchema).min(1).max(20),
  default: loanDefaultRecordSchema.nullable(),
  evidence: z.array(z.string().min(1)).min(1).max(200),
}).strict();

export const loanDetailResponseSchema = z.object({
  loan: loanListItemSchema.extend({
    disbursedTick: z.number().int().nonnegative().safe().nullable(),
    maturityTick: z.number().int().nonnegative().safe().nullable(),
    scheduleDigest: digestSchema,
    bankAssetAccountId: accountIdSchema,
    borrowerDepositAccountId: accountIdSchema,
    recognitionTransactionId: transactionIdSchema,
  }).strict(),
  schedule: z.array(loanScheduleItemSchema).min(1).max(360),
  why: z.discriminatedUnion("kind", [openingSeedWhySchema, underwrittenWhySchema]),
  meta: apiMetaSchema,
}).strict();
export type LoanDetailResponse = z.infer<typeof loanDetailResponseSchema>;
