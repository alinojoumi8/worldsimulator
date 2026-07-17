import { EngineError, type BankStatus } from "@worldtangle/shared";

export const BANK_CIRCUIT_POLICY_VERSION = 1 as const;
export const BANK_OPENING_RESERVE_CENTS = "95040000";
export const BANK_MINIMUM_RESERVE_RATIO_BP = 1_200;
export const BANK_MINIMUM_CAPITAL_RATIO_BP = 1_000;

export const BANK_CIRCUIT_BREAKERS = [
  "bank_closed",
  "reserve_ratio",
  "capital_ratio",
  "borrower_exposure",
] as const;

export type BankCircuitBreaker = typeof BANK_CIRCUIT_BREAKERS[number];

export interface BankCircuitEvaluationInput {
  readonly bankStatus: BankStatus;
  readonly depositCents: string;
  readonly reserveCents: string;
  readonly reserveRatioMinBp: number;
  readonly effectiveCapitalCents: string;
  readonly capitalRatioMinBp: number;
  readonly borrowerExposureCents: string;
  readonly borrowerExposureCapCents: string;
  readonly requestedAmountCents: string;
}

export interface BankCircuitEvaluation {
  readonly policyVersion: typeof BANK_CIRCUIT_POLICY_VERSION;
  readonly bankStatusBefore: BankStatus;
  readonly bankStatusAfter: BankStatus;
  readonly depositCents: string;
  readonly projectedDepositCents: string;
  readonly reserveCents: string;
  readonly reserveRatioBp: number;
  readonly projectedReserveRatioBp: number;
  readonly reserveRatioMinBp: number;
  readonly effectiveCapitalCents: string;
  readonly capitalRatioBp: number;
  readonly projectedCapitalRatioBp: number;
  readonly capitalRatioMinBp: number;
  readonly borrowerExposureCents: string;
  readonly projectedBorrowerExposureCents: string;
  readonly borrowerExposureCapCents: string;
  readonly requestedAmountCents: string;
  readonly bankOpen: boolean;
  readonly reservePassed: boolean;
  readonly capitalPassed: boolean;
  readonly exposurePassed: boolean;
  readonly systemicPassed: boolean;
  readonly allowed: boolean;
  readonly failedBreakers: readonly BankCircuitBreaker[];
}

function nonnegativeCents(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be nonnegative cents`);
  }
  return BigInt(value);
}

function basisPoints(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be an integer in 0..10000`,
    );
  }
}

export function bankRatioBasisPoints(
  numeratorCents: string,
  depositCents: string,
): number {
  const numerator = nonnegativeCents(numeratorCents, "ratio numerator");
  const deposits = nonnegativeCents(depositCents, "bank deposits");
  if (deposits === 0n) return 10_000;
  const ratio = numerator * 10_000n / deposits;
  return Number(ratio > 100_000n ? 100_000n : ratio);
}

export function evaluateBankLendingCircuit(
  raw: BankCircuitEvaluationInput,
): BankCircuitEvaluation {
  basisPoints(raw.reserveRatioMinBp, "minimum reserve ratio");
  basisPoints(raw.capitalRatioMinBp, "minimum capital ratio");
  const deposits = nonnegativeCents(raw.depositCents, "bank deposits");
  const reserves = nonnegativeCents(raw.reserveCents, "bank reserves");
  const capital = nonnegativeCents(raw.effectiveCapitalCents, "effective bank capital");
  const exposure = nonnegativeCents(raw.borrowerExposureCents, "borrower exposure");
  const exposureCap = nonnegativeCents(
    raw.borrowerExposureCapCents,
    "borrower exposure cap",
  );
  const request = nonnegativeCents(raw.requestedAmountCents, "requested amount");
  if (request === 0n) {
    throw new EngineError("VALIDATION_FAILED", "requested amount must be positive");
  }

  const projectedDeposits = deposits + request;
  const projectedExposure = exposure + request;
  const reserveRatioBp = bankRatioBasisPoints(reserves.toString(), deposits.toString());
  const projectedReserveRatioBp = bankRatioBasisPoints(
    reserves.toString(),
    projectedDeposits.toString(),
  );
  const capitalRatioBp = bankRatioBasisPoints(capital.toString(), deposits.toString());
  const projectedCapitalRatioBp = bankRatioBasisPoints(
    capital.toString(),
    projectedDeposits.toString(),
  );
  const bankOpen = raw.bankStatus !== "closed";
  const reservePassed = projectedReserveRatioBp >= raw.reserveRatioMinBp;
  const capitalPassed = projectedCapitalRatioBp >= raw.capitalRatioMinBp;
  const exposurePassed = projectedExposure <= exposureCap;
  const systemicPassed = bankOpen && reservePassed && capitalPassed;
  const allowed = systemicPassed && exposurePassed;
  const failedBreakers: BankCircuitBreaker[] = [];
  if (!bankOpen) failedBreakers.push("bank_closed");
  if (!reservePassed) failedBreakers.push("reserve_ratio");
  if (!capitalPassed) failedBreakers.push("capital_ratio");
  if (!exposurePassed) failedBreakers.push("borrower_exposure");
  const bankStatusAfter: BankStatus = !bankOpen
    ? "closed"
    : systemicPassed
      ? "active"
      : "lending_halted";

  return Object.freeze({
    policyVersion: BANK_CIRCUIT_POLICY_VERSION,
    bankStatusBefore: raw.bankStatus,
    bankStatusAfter,
    depositCents: deposits.toString(),
    projectedDepositCents: projectedDeposits.toString(),
    reserveCents: reserves.toString(),
    reserveRatioBp,
    projectedReserveRatioBp,
    reserveRatioMinBp: raw.reserveRatioMinBp,
    effectiveCapitalCents: capital.toString(),
    capitalRatioBp,
    projectedCapitalRatioBp,
    capitalRatioMinBp: raw.capitalRatioMinBp,
    borrowerExposureCents: exposure.toString(),
    projectedBorrowerExposureCents: projectedExposure.toString(),
    borrowerExposureCapCents: exposureCap.toString(),
    requestedAmountCents: request.toString(),
    bankOpen,
    reservePassed,
    capitalPassed,
    exposurePassed,
    systemicPassed,
    allowed,
    failedBreakers: Object.freeze(failedBreakers),
  });
}
