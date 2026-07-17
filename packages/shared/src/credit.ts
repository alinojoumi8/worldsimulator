/** Authoritative M09 credit-scoring and loan-application contracts. */

import { z } from "zod";
import { agentIdSchema, loanIdSchema } from "./agent";
import { bankSchema, bankStatusSchema } from "./finance";
import { companyIdSchema } from "./legal";
import { decisionIdSchema } from "./decision";
import { runIdSchema } from "./simulation";

const nonnegativeCentsSchema = z.string().regex(/^\d+$/);
const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const evidenceReferenceSchema = z.string().trim().min(1).max(160);

export const CREDIT_SCORE_MODEL_VERSION = 1 as const;
export const LOAN_POLICY_VERSION = 1 as const;
export const loanApplicationIdSchema = z.string().regex(/^loanapp_[0-9a-z]{8,}$/);
export const creditScoreAssessmentIdSchema = z.string().regex(/^cscore_[0-9a-z]{8,}$/);
export const loanApplicationReviewIdSchema = z.string().regex(/^loanrev_[0-9a-z]{8,}$/);
export const loanApplicationDecisionIdSchema = z.string().regex(/^loandec_[0-9a-z]{8,}$/);
export const loanInstallmentIdSchema = z.string().regex(/^pay_[0-9a-z]{8,}$/);
export const loanDefaultRecordIdSchema = z.string().regex(/^ldef_[0-9a-z]{8,}$/);
export const bankLendingAssessmentIdSchema = z.string().regex(/^bca_[0-9a-z]{8,}$/);
export const creditApplicantKindSchema = z.enum(["agent", "company"]);
export const loanApplicationStatusSchema = z.enum([
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "withdrawn",
]);

export const submitLoanApplicationInputSchema = z.object({
  applicantKind: creditApplicantKindSchema,
  applicantId: z.union([agentIdSchema, companyIdSchema]),
  bankId: bankSchema.shape.id,
  purpose: z.string().trim().min(1).max(500),
  amountCents: positiveCentsSchema,
  termMonths: z.number().int().min(1).max(360).safe(),
}).strict().superRefine((application, ctx) => {
  const expectedPrefix = application.applicantKind === "agent" ? "agt_" : "co_";
  if (!application.applicantId.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["applicantId"],
      message: `applicantId does not match ${application.applicantKind}`,
    });
  }
});

export const creditScoreInputsSchema = z.object({
  modelVersion: z.literal(CREDIT_SCORE_MODEL_VERSION),
  annualIncomeCents: nonnegativeCentsSchema,
  annualDebtServiceCents: nonnegativeCentsSchema,
  existingDebtCents: nonnegativeCentsSchema,
  requestedAmountCents: positiveCentsSchema,
  termMonths: z.number().int().min(1).max(360).safe(),
  incomeStabilityBp: z.number().int().min(0).max(10_000).safe(),
  debtToIncomeBp: z.number().int().min(0).max(100_000).safe(),
  historyScoreBp: z.number().int().min(0).max(10_000).safe(),
  completedPayments: z.number().int().nonnegative().safe(),
  missedPayments: z.number().int().nonnegative().safe(),
  defaults: z.number().int().nonnegative().safe(),
  noHistory: z.boolean(),
  incomeEvidenceRefs: z.array(evidenceReferenceSchema).max(200),
  debtEvidenceRefs: z.array(evidenceReferenceSchema).max(200),
}).strict().superRefine((inputs, ctx) => {
  const observations = inputs.completedPayments + inputs.missedPayments + inputs.defaults;
  if (inputs.noHistory !== (observations === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["noHistory"],
      message: "noHistory must exactly reflect the payment/default observations",
    });
  }
});

export const creditScoreBreakdownSchema = z.object({
  basePoints: z.literal(300),
  incomeStabilityPoints: z.number().int().min(0).max(200).safe(),
  debtToIncomePoints: z.number().int().min(0).max(200).safe(),
  historyPoints: z.number().int().min(0).max(150).safe(),
  totalPoints: z.number().int().min(300).max(850).safe(),
}).strict().refine(
  (breakdown) => breakdown.totalPoints === breakdown.basePoints +
    breakdown.incomeStabilityPoints + breakdown.debtToIncomePoints +
    breakdown.historyPoints,
  { path: ["totalPoints"], message: "credit-score point components do not sum" },
);

export const loanApplicationSchema = z.object({
  id: loanApplicationIdSchema,
  runId: runIdSchema,
  applicantKind: creditApplicantKindSchema,
  applicantId: z.union([agentIdSchema, companyIdSchema]),
  bankId: bankSchema.shape.id,
  purpose: z.string().trim().min(1).max(500),
  amountCents: positiveCentsSchema,
  termMonths: z.number().int().min(1).max(360).safe(),
  status: loanApplicationStatusSchema,
  submittedTick: z.number().int().nonnegative().safe(),
  decidedTick: z.number().int().nonnegative().safe().nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((application, ctx) => {
  const expectedPrefix = application.applicantKind === "agent" ? "agt_" : "co_";
  if (!application.applicantId.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["applicantId"],
      message: `applicantId does not match ${application.applicantKind}`,
    });
  }
  const terminal = application.status === "approved" || application.status === "rejected" ||
    application.status === "withdrawn";
  if (terminal !== (application.decidedTick !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["decidedTick"],
      message: "terminal loan applications require exactly one decided tick",
    });
  }
});

export const creditScoreAssessmentSchema = z.object({
  id: creditScoreAssessmentIdSchema,
  runId: runIdSchema,
  applicationId: loanApplicationIdSchema,
  modelVersion: z.literal(CREDIT_SCORE_MODEL_VERSION),
  inputs: creditScoreInputsSchema,
  systemScore: z.number().int().min(300).max(850).safe(),
  breakdown: creditScoreBreakdownSchema,
  computedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((assessment, ctx) => {
  if (assessment.systemScore !== assessment.breakdown.totalPoints) {
    ctx.addIssue({
      code: "custom",
      path: ["systemScore"],
      message: "system score does not match its breakdown",
    });
  }
});

export const loanReviewTierSchema = z.enum(["tier1", "tier2"]);
export const loanPolicyCheckIdSchema = z.enum([
  "minimum_score",
  "maximum_dti",
  "maximum_term",
  "borrower_exposure",
  "bank_status",
  "minimum_capital_ratio",
]);

export const loanPolicyCheckSchema = z.object({
  id: loanPolicyCheckIdSchema,
  comparator: z.enum(["gte", "lte", "eq"]),
  actual: z.string().min(1).max(80),
  threshold: z.string().min(1).max(80),
  passed: z.boolean(),
  evidenceRefs: z.array(evidenceReferenceSchema).max(200),
}).strict();

export const loanApplicationReviewSchema = z.object({
  id: loanApplicationReviewIdSchema,
  runId: runIdSchema,
  applicationId: loanApplicationIdSchema,
  officerAgentId: agentIdSchema,
  reviewTier: loanReviewTierSchema,
  startedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict();

export const loanApplicationDecisionSchema = z.object({
  id: loanApplicationDecisionIdSchema,
  runId: runIdSchema,
  applicationId: loanApplicationIdSchema,
  assessmentId: creditScoreAssessmentIdSchema,
  reviewId: loanApplicationReviewIdSchema,
  officerAgentId: agentIdSchema,
  reviewTier: loanReviewTierSchema,
  agentDecisionId: decisionIdSchema.nullable(),
  policyVersion: z.literal(LOAN_POLICY_VERSION),
  systemScore: z.number().int().min(300).max(850).safe(),
  officerAdjustment: z.number().int().min(-5).max(5).safe(),
  finalScore: z.number().int().min(295).max(855).safe(),
  rationale: z.string().trim().min(1).max(1_000),
  policyChecks: z.array(loanPolicyCheckSchema).length(6),
  outcome: z.enum(["approved", "rejected"]),
  offeredRateBp: z.number().int().min(0).max(100_000).safe().nullable(),
  decidedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((decision, ctx) => {
  if (decision.finalScore !== decision.systemScore + decision.officerAdjustment) {
    ctx.addIssue({
      code: "custom",
      path: ["finalScore"],
      message: "final score must equal system score plus officer adjustment",
    });
  }
  if (decision.reviewTier === "tier1" && decision.officerAdjustment !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["officerAdjustment"],
      message: "Tier-1 loan review cannot apply a discretionary adjustment",
    });
  }
  if (decision.reviewTier === "tier1" && decision.agentDecisionId !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["agentDecisionId"],
      message: "Tier-1 loan review cannot link a Tier-2 agent decision",
    });
  }
  if (decision.reviewTier === "tier2" && decision.agentDecisionId === null) {
    ctx.addIssue({
      code: "custom",
      path: ["agentDecisionId"],
      message: "Tier-2 loan review requires its bounded agent decision",
    });
  }
  const ids = new Set(decision.policyChecks.map((check) => check.id));
  if (ids.size !== loanPolicyCheckIdSchema.options.length ||
    loanPolicyCheckIdSchema.options.some((id) => !ids.has(id))) {
    ctx.addIssue({
      code: "custom",
      path: ["policyChecks"],
      message: "decision must contain each policy check exactly once",
    });
  }
  const checksApprove = decision.policyChecks.every((check) => check.passed);
  if ((decision.outcome === "approved") !== checksApprove) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "decision outcome must exactly reflect its policy checks",
    });
  }
  if ((decision.outcome === "approved") !== (decision.offeredRateBp !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["offeredRateBp"],
      message: "only approved decisions have an offered rate",
    });
  }
});

export const loanStatusSchema = z.enum([
  "disbursed",
  "repaying",
  "paid_off",
  "defaulted",
  "written_off",
  "collected",
]);

export const loanSchema = z.object({
  id: loanIdSchema,
  runId: runIdSchema,
  applicationId: loanApplicationIdSchema,
  decisionId: loanApplicationDecisionIdSchema,
  borrowerKind: creditApplicantKindSchema,
  borrowerId: z.union([agentIdSchema, companyIdSchema]),
  bankId: bankSchema.shape.id,
  principalCents: positiveCentsSchema,
  annualRateBp: z.number().int().min(0).max(100_000).safe(),
  termMonths: z.number().int().min(1).max(360).safe(),
  disbursedTick: z.number().int().nonnegative().safe(),
  maturityTick: z.number().int().nonnegative().safe(),
  outstandingPrincipalCents: nonnegativeCentsSchema,
  consecutiveMisses: z.number().int().nonnegative().safe(),
  status: loanStatusSchema,
  bankAssetAccountId: z.string().regex(/^acct_[0-9a-z]{8,}$/),
  borrowerDepositAccountId: z.string().regex(/^acct_[0-9a-z]{8,}$/),
  disbursementTransactionId: z.string().regex(/^txn_[0-9a-z]{8,}$/),
  scheduleDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sourceEventId: eventIdSchema,
}).strict().superRefine((loan, ctx) => {
  const expectedPrefix = loan.borrowerKind === "agent" ? "agt_" : "co_";
  if (!loan.borrowerId.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["borrowerId"],
      message: `borrowerId does not match ${loan.borrowerKind}`,
    });
  }
  if (loan.maturityTick !== loan.disbursedTick + loan.termMonths * 30) {
    ctx.addIssue({
      code: "custom",
      path: ["maturityTick"],
      message: "loan maturity must equal disbursement plus 30 days per term month",
    });
  }
});

export const loanInstallmentStatusSchema = z.enum(["due", "completed", "missed"]);
export const loanInstallmentSchema = z.object({
  id: loanInstallmentIdSchema,
  runId: runIdSchema,
  loanId: loanIdSchema,
  installmentNumber: z.number().int().min(1).max(360).safe(),
  dueTick: z.number().int().nonnegative().safe(),
  openingPrincipalCents: nonnegativeCentsSchema,
  principalDueCents: nonnegativeCentsSchema,
  interestDueCents: nonnegativeCentsSchema,
  totalDueCents: nonnegativeCentsSchema,
  status: loanInstallmentStatusSchema,
  paidTick: z.number().int().nonnegative().safe().nullable(),
  transactionId: z.string().regex(/^txn_[0-9a-z]{8,}$/).nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((installment, ctx) => {
  if (BigInt(installment.totalDueCents) !==
    BigInt(installment.principalDueCents) + BigInt(installment.interestDueCents)) {
    ctx.addIssue({
      code: "custom",
      path: ["totalDueCents"],
      message: "installment total must equal principal plus interest",
    });
  }
  const completed = installment.status === "completed";
  if (completed !== (installment.paidTick !== null && installment.transactionId !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["paidTick"],
      message: "completed installment requires payment tick and transaction",
    });
  }
  if (!completed && (installment.paidTick !== null || installment.transactionId !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["transactionId"],
      message: "uncompleted installment cannot reference a payment transaction",
    });
  }
});

export const BANK_CIRCUIT_BREAKER_IDS = [
  "bank_closed",
  "reserve_ratio",
  "capital_ratio",
  "borrower_exposure",
] as const;
export const bankCircuitBreakerIdSchema = z.enum(BANK_CIRCUIT_BREAKER_IDS);
export const bankLendingAssessmentStageSchema = z.enum(["approval", "disbursement"]);

export const bankLendingAssessmentSchema = z.object({
  id: bankLendingAssessmentIdSchema,
  runId: runIdSchema,
  bankId: bankSchema.shape.id,
  applicationId: loanApplicationIdSchema,
  decisionId: loanApplicationDecisionIdSchema.nullable(),
  stage: bankLendingAssessmentStageSchema,
  borrowerKind: creditApplicantKindSchema,
  borrowerId: z.union([agentIdSchema, companyIdSchema]),
  assessedTick: z.number().int().nonnegative().safe(),
  policyVersion: z.literal(1),
  bankStatusBefore: bankStatusSchema,
  bankStatusAfter: bankStatusSchema,
  depositCents: nonnegativeCentsSchema,
  projectedDepositCents: positiveCentsSchema,
  reserveCents: nonnegativeCentsSchema,
  reserveRatioBp: z.number().int().min(0).max(100_000).safe(),
  projectedReserveRatioBp: z.number().int().min(0).max(100_000).safe(),
  reserveRatioMinBp: z.number().int().min(0).max(10_000).safe(),
  effectiveCapitalCents: nonnegativeCentsSchema,
  capitalRatioBp: z.number().int().min(0).max(100_000).safe(),
  projectedCapitalRatioBp: z.number().int().min(0).max(100_000).safe(),
  capitalRatioMinBp: z.number().int().min(0).max(10_000).safe(),
  borrowerExposureCents: nonnegativeCentsSchema,
  projectedBorrowerExposureCents: positiveCentsSchema,
  borrowerExposureCapCents: nonnegativeCentsSchema,
  requestedAmountCents: positiveCentsSchema,
  bankOpen: z.boolean(),
  reservePassed: z.boolean(),
  capitalPassed: z.boolean(),
  exposurePassed: z.boolean(),
  systemicPassed: z.boolean(),
  allowed: z.boolean(),
  failedBreakers: z.array(bankCircuitBreakerIdSchema).max(BANK_CIRCUIT_BREAKER_IDS.length),
  sourceEventId: eventIdSchema,
}).strict().superRefine((assessment, ctx) => {
  const expectedPrefix = assessment.borrowerKind === "agent" ? "agt_" : "co_";
  if (!assessment.borrowerId.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["borrowerId"],
      message: `borrowerId does not match ${assessment.borrowerKind}`,
    });
  }
  const hasDecision = assessment.decisionId !== null;
  if ((assessment.stage === "disbursement") !== hasDecision) {
    ctx.addIssue({
      code: "custom",
      path: ["decisionId"],
      message: "only disbursement assessments reference an approved decision",
    });
  }
  if (BigInt(assessment.projectedDepositCents) !==
    BigInt(assessment.depositCents) + BigInt(assessment.requestedAmountCents)) {
    ctx.addIssue({
      code: "custom",
      path: ["projectedDepositCents"],
      message: "projected deposits must include the requested credit creation",
    });
  }
  if (BigInt(assessment.projectedBorrowerExposureCents) !==
    BigInt(assessment.borrowerExposureCents) + BigInt(assessment.requestedAmountCents)) {
    ctx.addIssue({
      code: "custom",
      path: ["projectedBorrowerExposureCents"],
      message: "projected exposure must include the requested principal",
    });
  }
  const systemicPassed = assessment.bankOpen && assessment.reservePassed &&
    assessment.capitalPassed;
  if (assessment.systemicPassed !== systemicPassed ||
    assessment.allowed !== (systemicPassed && assessment.exposurePassed)) {
    ctx.addIssue({
      code: "custom",
      path: ["allowed"],
      message: "assessment outcome must exactly reflect every breaker",
    });
  }
  const expectedStatus = !assessment.bankOpen
    ? "closed"
    : systemicPassed
      ? "active"
      : "lending_halted";
  if (assessment.bankStatusAfter !== expectedStatus) {
    ctx.addIssue({
      code: "custom",
      path: ["bankStatusAfter"],
      message: "bank status does not reflect the systemic breaker result",
    });
  }
  const expectedFailures = BANK_CIRCUIT_BREAKER_IDS.filter((id) => {
    if (id === "bank_closed") return !assessment.bankOpen;
    if (id === "reserve_ratio") return !assessment.reservePassed;
    if (id === "capital_ratio") return !assessment.capitalPassed;
    return !assessment.exposurePassed;
  });
  if (assessment.failedBreakers.length !== expectedFailures.length ||
    assessment.failedBreakers.some((id, index) => id !== expectedFailures[index])) {
    ctx.addIssue({
      code: "custom",
      path: ["failedBreakers"],
      message: "failed breakers must be complete, unique, and canonically ordered",
    });
  }
});

export const loanDefaultRecordSchema = z.object({
  id: loanDefaultRecordIdSchema,
  runId: runIdSchema,
  loanId: loanIdSchema,
  borrowerKind: creditApplicantKindSchema,
  borrowerId: z.union([agentIdSchema, companyIdSchema]),
  bankId: bankSchema.shape.id,
  defaultTick: z.number().int().nonnegative().safe(),
  outstandingPrincipalCents: positiveCentsSchema,
  missedInstallmentIds: z.array(loanInstallmentIdSchema).min(3).max(360),
  writeDownTransactionId: z.string().regex(/^txn_[0-9a-z]{8,}$/),
  creditScoreBefore: z.number().int().min(300).max(850).safe().nullable(),
  creditScorePenaltyPoints: z.number().int().min(0).max(550).safe(),
  creditScoreAfter: z.number().int().min(300).max(850).safe().nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((record, ctx) => {
  const expectedPrefix = record.borrowerKind === "agent" ? "agt_" : "co_";
  if (!record.borrowerId.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      path: ["borrowerId"],
      message: `borrowerId does not match ${record.borrowerKind}`,
    });
  }
  if (new Set(record.missedInstallmentIds).size !== record.missedInstallmentIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["missedInstallmentIds"],
      message: "default miss history cannot contain duplicates",
    });
  }
  if (record.borrowerKind === "agent") {
    if (record.creditScoreBefore === null || record.creditScoreAfter === null ||
      record.creditScorePenaltyPoints < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["creditScoreAfter"],
        message: "agent defaults require before, penalty, and after credit scores",
      });
    } else if (record.creditScoreAfter !== Math.max(
      300,
      record.creditScoreBefore - record.creditScorePenaltyPoints,
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["creditScoreAfter"],
        message: "agent default score does not match the bounded penalty",
      });
    }
  } else if (record.creditScoreBefore !== null || record.creditScoreAfter !== null ||
    record.creditScorePenaltyPoints !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["creditScorePenaltyPoints"],
      message: "company defaults do not mutate an agent credit score",
    });
  }
});

export type CreditApplicantKind = z.infer<typeof creditApplicantKindSchema>;
export type SubmitLoanApplicationInput = z.infer<typeof submitLoanApplicationInputSchema>;
export type CreditScoreInputs = z.infer<typeof creditScoreInputsSchema>;
export type CreditScoreBreakdown = z.infer<typeof creditScoreBreakdownSchema>;
export type LoanApplication = z.infer<typeof loanApplicationSchema>;
export type LoanApplicationStatus = z.infer<typeof loanApplicationStatusSchema>;
export type CreditScoreAssessment = z.infer<typeof creditScoreAssessmentSchema>;
export type LoanReviewTier = z.infer<typeof loanReviewTierSchema>;
export type LoanPolicyCheckId = z.infer<typeof loanPolicyCheckIdSchema>;
export type LoanPolicyCheck = z.infer<typeof loanPolicyCheckSchema>;
export type LoanApplicationReview = z.infer<typeof loanApplicationReviewSchema>;
export type LoanApplicationDecision = z.infer<typeof loanApplicationDecisionSchema>;
export type LoanStatus = z.infer<typeof loanStatusSchema>;
export type Loan = z.infer<typeof loanSchema>;
export type LoanInstallmentStatus = z.infer<typeof loanInstallmentStatusSchema>;
export type LoanInstallment = z.infer<typeof loanInstallmentSchema>;
export type BankCircuitBreakerId = z.infer<typeof bankCircuitBreakerIdSchema>;
export type BankLendingAssessmentStage = z.infer<typeof bankLendingAssessmentStageSchema>;
export type BankLendingAssessment = z.infer<typeof bankLendingAssessmentSchema>;
export type LoanDefaultRecord = z.infer<typeof loanDefaultRecordSchema>;
