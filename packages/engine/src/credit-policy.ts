import {
  EngineError,
  LOAN_POLICY_VERSION,
  loanPolicyCheckSchema,
  type LoanApplicationStatus,
  type LoanPolicyCheck,
} from "@worldtangle/shared";

export const LOAN_MINIMUM_SCORE = 650;
export const LOAN_MAXIMUM_DTI_BP = 5_000;
export const LOAN_MAXIMUM_TERM_MONTHS = 120;
export const LOAN_OFFICER_ADJUSTMENT_LIMIT = 5;
export const LOAN_RATE_ZERO_SPREAD_SCORE = 750;
export const LOAN_RATE_SPREAD_BP_PER_POINT = 5;

export interface LoanPolicyEvaluationInput {
  readonly systemScore: number;
  readonly officerAdjustment: number;
  readonly debtToIncomeBp: number;
  readonly termMonths: number;
  readonly existingDebtCents: string;
  readonly requestedAmountCents: string;
  readonly bankStatus: "active" | "lending_halted" | "closed";
  readonly bankCapitalCents: string;
  readonly bankDepositCents: string;
  readonly bankMinimumCapitalRatioBp: number;
  readonly bankExposureCapCents: string;
  readonly bankBaseLendingRateBp: number;
  readonly assessmentEvidenceRefs: readonly string[];
  readonly debtEvidenceRefs: readonly string[];
  readonly bankEvidenceRefs: readonly string[];
}

export interface LoanPolicyEvaluation {
  readonly policyVersion: typeof LOAN_POLICY_VERSION;
  readonly finalScore: number;
  readonly policyChecks: readonly LoanPolicyCheck[];
  readonly approved: boolean;
  readonly offeredRateBp: number | null;
}

function assertCents(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be nonnegative cents`);
  }
  return BigInt(value);
}

function assertBasisPoints(value: number, field: string, maximum = 100_000): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be an integer in 0..${maximum}`,
    );
  }
}

function policyCheck(input: LoanPolicyCheck): LoanPolicyCheck {
  return Object.freeze(loanPolicyCheckSchema.parse(input));
}

export function currentCapitalRatioBasisPoints(
  capitalCents: string,
  depositCents: string,
): number {
  const capital = assertCents(capitalCents, "bank capital");
  const deposits = assertCents(depositCents, "bank deposits");
  if (deposits === 0n) return 10_000;
  const ratio = capital * 10_000n / deposits;
  return Number(ratio > 100_000n ? 100_000n : ratio);
}

export function evaluateLoanPolicy(raw: LoanPolicyEvaluationInput): LoanPolicyEvaluation {
  if (!Number.isSafeInteger(raw.systemScore) || raw.systemScore < 300 || raw.systemScore > 850) {
    throw new EngineError("VALIDATION_FAILED", "system score must be in 300..850");
  }
  if (!Number.isSafeInteger(raw.officerAdjustment) ||
    Math.abs(raw.officerAdjustment) > LOAN_OFFICER_ADJUSTMENT_LIMIT) {
    throw new EngineError("VALIDATION_FAILED", "officer adjustment must be in -5..5");
  }
  assertBasisPoints(raw.debtToIncomeBp, "debt-to-income ratio");
  assertBasisPoints(raw.bankMinimumCapitalRatioBp, "minimum capital ratio", 10_000);
  assertBasisPoints(raw.bankBaseLendingRateBp, "base lending rate");
  if (!Number.isSafeInteger(raw.termMonths) || raw.termMonths < 1 || raw.termMonths > 360) {
    throw new EngineError("VALIDATION_FAILED", "loan term must be in 1..360 months");
  }
  const existingDebt = assertCents(raw.existingDebtCents, "existing debt");
  const requestedAmount = assertCents(raw.requestedAmountCents, "requested amount");
  if (requestedAmount === 0n) {
    throw new EngineError("VALIDATION_FAILED", "requested amount must be positive");
  }
  const exposureCap = assertCents(raw.bankExposureCapCents, "bank exposure cap");
  const totalExposure = existingDebt + requestedAmount;
  const capitalRatioBp = currentCapitalRatioBasisPoints(
    raw.bankCapitalCents,
    raw.bankDepositCents,
  );
  const finalScore = raw.systemScore + raw.officerAdjustment;
  const assessmentEvidence = [...raw.assessmentEvidenceRefs];
  const bankEvidence = [...raw.bankEvidenceRefs];
  const policyChecks = Object.freeze([
    policyCheck({
      id: "minimum_score",
      comparator: "gte",
      actual: finalScore.toString(),
      threshold: LOAN_MINIMUM_SCORE.toString(),
      passed: finalScore >= LOAN_MINIMUM_SCORE,
      evidenceRefs: assessmentEvidence,
    }),
    policyCheck({
      id: "maximum_dti",
      comparator: "lte",
      actual: raw.debtToIncomeBp.toString(),
      threshold: LOAN_MAXIMUM_DTI_BP.toString(),
      passed: raw.debtToIncomeBp <= LOAN_MAXIMUM_DTI_BP,
      evidenceRefs: assessmentEvidence,
    }),
    policyCheck({
      id: "maximum_term",
      comparator: "lte",
      actual: raw.termMonths.toString(),
      threshold: LOAN_MAXIMUM_TERM_MONTHS.toString(),
      passed: raw.termMonths <= LOAN_MAXIMUM_TERM_MONTHS,
      evidenceRefs: assessmentEvidence,
    }),
    policyCheck({
      id: "borrower_exposure",
      comparator: "lte",
      actual: totalExposure.toString(),
      threshold: exposureCap.toString(),
      passed: totalExposure <= exposureCap,
      evidenceRefs: [...raw.debtEvidenceRefs, ...bankEvidence],
    }),
    policyCheck({
      id: "bank_status",
      comparator: "eq",
      actual: raw.bankStatus,
      threshold: "active",
      passed: raw.bankStatus === "active",
      evidenceRefs: bankEvidence,
    }),
    policyCheck({
      id: "minimum_capital_ratio",
      comparator: "gte",
      actual: capitalRatioBp.toString(),
      threshold: raw.bankMinimumCapitalRatioBp.toString(),
      passed: capitalRatioBp >= raw.bankMinimumCapitalRatioBp,
      evidenceRefs: bankEvidence,
    }),
  ]);
  const approved = policyChecks.every((check) => check.passed);
  const riskSpread = Math.max(0, LOAN_RATE_ZERO_SPREAD_SCORE - finalScore) *
    LOAN_RATE_SPREAD_BP_PER_POINT;
  const offeredRateBp = approved ? raw.bankBaseLendingRateBp + riskSpread : null;
  if (offeredRateBp !== null && offeredRateBp > 100_000) {
    throw new EngineError("VALIDATION_FAILED", "offered lending rate exceeds 100000 bp");
  }
  return Object.freeze({
    policyVersion: LOAN_POLICY_VERSION,
    finalScore,
    policyChecks,
    approved,
    offeredRateBp,
  });
}

export function tier1LoanReviewRationale(evaluation: LoanPolicyEvaluation): string {
  const failed = evaluation.policyChecks.filter((check) => !check.passed).map((check) => check.id);
  return failed.length === 0
    ? "Tier-1 review applied no discretionary adjustment; all policy checks passed."
    : `Tier-1 review applied no discretionary adjustment; failed checks: ${failed.join(", ")}.`;
}

const LOAN_APPLICATION_TRANSITIONS: Readonly<
  Record<LoanApplicationStatus, readonly LoanApplicationStatus[]>
> = {
  submitted: ["under_review", "withdrawn"],
  under_review: ["approved", "rejected", "withdrawn"],
  approved: [],
  rejected: [],
  withdrawn: [],
};

export function transitionLoanApplicationStatus(
  current: LoanApplicationStatus,
  next: LoanApplicationStatus,
): LoanApplicationStatus {
  if (!LOAN_APPLICATION_TRANSITIONS[current].includes(next)) {
    throw new EngineError(
      "CONFLICT",
      `loan application cannot transition from ${current} to ${next}`,
    );
  }
  return next;
}
