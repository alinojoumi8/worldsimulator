/** Deterministic collection/default rules for originated loans (WS-504). */

import {
  EngineError,
  loanInstallmentSchema,
  type LoanInstallment,
  type LoanStatus,
} from "@worldtangle/shared";

export const LOAN_DEFAULT_CONSECUTIVE_MISSES = 3;
export const LOAN_DEFAULT_CREDIT_SCORE_PENALTY_POINTS = 100;
export const CREDIT_SCORE_FLOOR = 300;

export interface LoanCollectionQuote {
  readonly installmentIds: readonly string[];
  readonly principalCents: string;
  readonly interestCents: string;
  readonly totalCents: string;
}

export interface LoanCollectionState {
  readonly outstandingPrincipalCents: string;
  readonly consecutiveMisses: 0;
  readonly status: Extract<LoanStatus, "repaying" | "paid_off">;
}

export interface LoanMissState {
  readonly consecutiveMisses: number;
  readonly status: Extract<LoanStatus, "repaying" | "defaulted">;
  readonly defaulted: boolean;
}

function nonnegativeCents(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be nonnegative cents`);
  }
  return BigInt(value);
}

function signedCents(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be integer cents`);
  }
  return BigInt(value);
}

/** Sum the complete arrears set. Collections never quote a partial installment. */
export function quoteLoanCollection(
  rawInstallments: readonly LoanInstallment[],
): LoanCollectionQuote {
  if (rawInstallments.length === 0) {
    throw new EngineError("VALIDATION_FAILED", "a collection quote requires an installment");
  }
  const installments = rawInstallments.map((installment) => loanInstallmentSchema.parse(
    installment,
  ));
  const loanId = installments[0]!.loanId;
  const seen = new Set<string>();
  let previousNumber = 0;
  let principal = 0n;
  let interest = 0n;
  for (const installment of installments) {
    if (installment.loanId !== loanId) {
      throw new EngineError("VALIDATION_FAILED", "collection installments belong to different loans");
    }
    if (installment.status !== "due" && installment.status !== "missed") {
      throw new EngineError("CONFLICT", `installment ${installment.id} is already completed`);
    }
    if (seen.has(installment.id) || installment.installmentNumber <= previousNumber) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "collection installments must be unique and ordered by installment number",
      );
    }
    seen.add(installment.id);
    previousNumber = installment.installmentNumber;
    principal += BigInt(installment.principalDueCents);
    interest += BigInt(installment.interestDueCents);
  }
  const total = principal + interest;
  if (total <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "a collectible installment must have a positive total");
  }
  return Object.freeze({
    installmentIds: Object.freeze(installments.map((installment) => installment.id)),
    principalCents: principal.toString(),
    interestCents: interest.toString(),
    totalCents: total.toString(),
  });
}

/** Available cash is balance above the account floor; exact equality can settle. */
export function canCollectLoanQuote(input: {
  readonly balanceCents: string;
  readonly floorCents: string;
  readonly quote: LoanCollectionQuote;
}): boolean {
  const balance = signedCents(input.balanceCents, "account balance");
  const floor = signedCents(input.floorCents, "account floor");
  const total = nonnegativeCents(input.quote.totalCents, "collection total");
  if (balance < floor) {
    throw new EngineError("CONFLICT", "borrower account is already below its floor");
  }
  return balance - floor >= total;
}

export function loanStateAfterCollection(input: {
  readonly outstandingPrincipalCents: string;
  readonly principalCollectedCents: string;
}): LoanCollectionState {
  const outstanding = nonnegativeCents(
    input.outstandingPrincipalCents,
    "outstanding principal",
  );
  const collected = nonnegativeCents(
    input.principalCollectedCents,
    "collected principal",
  );
  if (collected > outstanding) {
    throw new EngineError("CONFLICT", "collected principal exceeds outstanding principal");
  }
  const next = outstanding - collected;
  return Object.freeze({
    outstandingPrincipalCents: next.toString(),
    consecutiveMisses: 0,
    status: next === 0n ? "paid_off" : "repaying",
  });
}

export function loanStateAfterMiss(currentConsecutiveMisses: number): LoanMissState {
  if (!Number.isSafeInteger(currentConsecutiveMisses) || currentConsecutiveMisses < 0 ||
    currentConsecutiveMisses >= LOAN_DEFAULT_CONSECUTIVE_MISSES) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "current consecutive misses must be below the default threshold",
    );
  }
  const consecutiveMisses = currentConsecutiveMisses + 1;
  const defaulted = consecutiveMisses >= LOAN_DEFAULT_CONSECUTIVE_MISSES;
  return Object.freeze({
    consecutiveMisses,
    status: defaulted ? "defaulted" : "repaying",
    defaulted,
  });
}

export function applyLoanDefaultCreditScorePenalty(score: number): number {
  if (!Number.isSafeInteger(score) || score < CREDIT_SCORE_FLOOR || score > 850) {
    throw new EngineError("VALIDATION_FAILED", "credit score must be in 300..850");
  }
  return Math.max(CREDIT_SCORE_FLOOR, score - LOAN_DEFAULT_CREDIT_SCORE_PENALTY_POINTS);
}
