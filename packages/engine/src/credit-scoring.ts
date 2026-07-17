import {
  CREDIT_SCORE_MODEL_VERSION,
  EngineError,
  creditScoreInputsSchema,
  type CreditScoreBreakdown,
  type CreditScoreInputs,
} from "@worldtangle/shared";

export const CREDIT_SCORE_BASE_POINTS = 300;
export const CREDIT_SCORE_NO_HISTORY_BP = 6_000;
export const CREDIT_SCORE_DTI_FULL_POINTS_BP = 2_000;
export const CREDIT_SCORE_DTI_ZERO_POINTS_BP = 6_000;

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a nonnegative safe integer`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Exact annual principal represented by the first 12 equal-principal months.
 * The final term row absorbs remainder cents, matching the authoritative schedule.
 */
export function principalDueWithinYear(amountCents: string, termMonths: number): bigint {
  if (!/^[1-9]\d*$/.test(amountCents)) {
    throw new EngineError("VALIDATION_FAILED", "requested principal must be positive cents");
  }
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || termMonths > 360) {
    throw new EngineError("VALIDATION_FAILED", "termMonths must be in 1..360");
  }
  const amount = BigInt(amountCents);
  const term = BigInt(termMonths);
  const months = BigInt(Math.min(12, termMonths));
  const base = amount / term;
  return months === term ? amount : base * months;
}

/** Conservative DTI: ceil(annual debt service / annual income), capped at 1000%. */
export function debtToIncomeBasisPoints(
  annualDebtServiceCents: string,
  annualIncomeCents: string,
): number {
  if (!/^\d+$/.test(annualDebtServiceCents) || !/^\d+$/.test(annualIncomeCents)) {
    throw new EngineError("VALIDATION_FAILED", "DTI inputs must be nonnegative cents");
  }
  const debt = BigInt(annualDebtServiceCents);
  const income = BigInt(annualIncomeCents);
  if (income === 0n) return 100_000;
  const ratio = (debt * 10_000n + income - 1n) / income;
  return Number(ratio > 100_000n ? 100_000n : ratio);
}

/** Version-1 payment-history factor. No history receives a documented neutral 6000 bp. */
export function creditHistoryScoreBasisPoints(input: {
  readonly completedPayments: number;
  readonly missedPayments: number;
  readonly defaults: number;
}): number {
  assertCount(input.completedPayments, "completedPayments");
  assertCount(input.missedPayments, "missedPayments");
  assertCount(input.defaults, "defaults");
  if (input.completedPayments + input.missedPayments + input.defaults === 0) {
    return CREDIT_SCORE_NO_HISTORY_BP;
  }
  return clamp(
    7_000 + Math.min(input.completedPayments, 20) * 150 -
      input.missedPayments * 1_200 - input.defaults * 3_500,
    0,
    10_000,
  );
}

function debtToIncomePoints(debtToIncomeBp: number): number {
  if (debtToIncomeBp <= CREDIT_SCORE_DTI_FULL_POINTS_BP) return 200;
  if (debtToIncomeBp >= CREDIT_SCORE_DTI_ZERO_POINTS_BP) return 0;
  return Math.floor(
    ((CREDIT_SCORE_DTI_ZERO_POINTS_BP - debtToIncomeBp) * 200) /
      (CREDIT_SCORE_DTI_ZERO_POINTS_BP - CREDIT_SCORE_DTI_FULL_POINTS_BP),
  );
}

/**
 * Model v1: 300 base + 200 income-stability + 200 DTI + 150 history points.
 * Every conversion from basis points uses an explicitly documented floor.
 */
export function calculateCreditScore(rawInputs: CreditScoreInputs): CreditScoreBreakdown {
  const inputs = creditScoreInputsSchema.parse(rawInputs);
  if (inputs.modelVersion !== CREDIT_SCORE_MODEL_VERSION) {
    throw new EngineError("VALIDATION_FAILED", "unsupported credit-score model version");
  }
  const expectedDti = debtToIncomeBasisPoints(
    inputs.annualDebtServiceCents,
    inputs.annualIncomeCents,
  );
  if (inputs.debtToIncomeBp !== expectedDti) {
    throw new EngineError("VALIDATION_FAILED", "stored DTI does not match stored cents inputs");
  }
  const expectedHistory = creditHistoryScoreBasisPoints(inputs);
  if (inputs.historyScoreBp !== expectedHistory) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "stored history score does not match stored payment observations",
    );
  }
  const incomeStabilityPoints = Math.floor(inputs.incomeStabilityBp * 200 / 10_000);
  const dtiPoints = debtToIncomePoints(inputs.debtToIncomeBp);
  const historyPoints = Math.floor(inputs.historyScoreBp * 150 / 10_000);
  return Object.freeze({
    basePoints: CREDIT_SCORE_BASE_POINTS,
    incomeStabilityPoints,
    debtToIncomePoints: dtiPoints,
    historyPoints,
    totalPoints: CREDIT_SCORE_BASE_POINTS + incomeStabilityPoints + dtiPoints + historyPoints,
  });
}
