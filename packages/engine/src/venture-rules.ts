/** Pure deterministic M10 fund-accounting rules. */

import { EngineError } from "@worldtangle/shared";

const canonicalNonnegativeInteger = /^(0|[1-9]\d*)$/;
const canonicalPositiveInteger = /^[1-9]\d*$/;
const signedSqliteMaximum = 9_223_372_036_854_775_807n;

function cents(value: string, field: string, positive: boolean): bigint {
  const pattern = positive ? canonicalPositiveInteger : canonicalNonnegativeInteger;
  if (!pattern.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a canonical integer-cent string`);
  }
  return BigInt(value);
}

export interface VentureFundAccountingState {
  readonly fundSizeCents: string;
  readonly deployedCents: string;
}

export interface VentureFundDeploymentQuote {
  readonly amountCents: string;
  readonly deployedBeforeCents: string;
  readonly deployedAfterCents: string;
  readonly remainingCents: string;
  readonly fullyDeployed: boolean;
}

export interface PricedRoundTerms {
  readonly totalSharesBefore: string;
  readonly amountCents: string;
  readonly preMoneyValuationCents: string;
  readonly equityBasisPoints: number;
}

export interface PricedRoundQuote {
  readonly totalSharesBefore: string;
  readonly sharesIssued: string;
  readonly totalSharesAfter: string;
  readonly amountCents: string;
  readonly preMoneyValuationCents: string;
  readonly postMoneyValuationCents: string;
  readonly pricePerShareCents: string;
  readonly equityBasisPoints: number;
}

/**
 * Quote an exact integer-share priced round. Valuation and investment must both
 * be exactly representable at one integer-cent share price; otherwise closing
 * is rejected instead of smuggling fractional cents or shares into state.
 */
export function quotePricedRound(terms: PricedRoundTerms): PricedRoundQuote {
  const totalSharesBefore = cents(terms.totalSharesBefore, "totalSharesBefore", true);
  const amount = cents(terms.amountCents, "amountCents", true);
  const preMoney = cents(terms.preMoneyValuationCents, "preMoneyValuationCents", true);
  if (
    totalSharesBefore > signedSqliteMaximum ||
    amount > signedSqliteMaximum ||
    preMoney > signedSqliteMaximum
  ) {
    throw new EngineError("LIMIT_EXCEEDED", "priced-round inputs exceed the SQLite integer range");
  }
  if (!Number.isSafeInteger(terms.equityBasisPoints) ||
      terms.equityBasisPoints < 1 || terms.equityBasisPoints > 9_999) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "equityBasisPoints must be a safe integer between 1 and 9999",
    );
  }
  if (preMoney % totalSharesBefore !== 0n) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "pre-money valuation is not exactly representable in integer cents per share",
      {
        preMoneyValuationCents: preMoney.toString(),
        totalSharesBefore: totalSharesBefore.toString(),
      },
    );
  }
  const pricePerShare = preMoney / totalSharesBefore;
  if (pricePerShare === 0n || amount % pricePerShare !== 0n) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "investment amount is not exactly representable in integer shares at the round price",
      {
        amountCents: amount.toString(),
        pricePerShareCents: pricePerShare.toString(),
      },
    );
  }
  const sharesIssued = amount / pricePerShare;
  const totalSharesAfter = totalSharesBefore + sharesIssued;
  const postMoney = preMoney + amount;
  if (totalSharesAfter > signedSqliteMaximum || postMoney > signedSqliteMaximum) {
    throw new EngineError("LIMIT_EXCEEDED", "priced-round result exceeds the SQLite integer range");
  }
  const exactEquityBasisPoints = Number(
    (sharesIssued * 10_000n + totalSharesAfter / 2n) / totalSharesAfter,
  );
  if (Math.abs(exactEquityBasisPoints - terms.equityBasisPoints) > 1) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "negotiated equity is inconsistent with the exact post-round cap table",
      {
        negotiatedEquityBasisPoints: terms.equityBasisPoints,
        exactEquityBasisPoints,
      },
    );
  }
  return Object.freeze({
    totalSharesBefore: totalSharesBefore.toString(),
    sharesIssued: sharesIssued.toString(),
    totalSharesAfter: totalSharesAfter.toString(),
    amountCents: amount.toString(),
    preMoneyValuationCents: preMoney.toString(),
    postMoneyValuationCents: postMoney.toString(),
    pricePerShareCents: pricePerShare.toString(),
    equityBasisPoints: exactEquityBasisPoints,
  });
}

/** Apply one deployment exactly or reject it without returning a partial state. */
export function quoteVentureFundDeployment(
  state: VentureFundAccountingState,
  amountCents: string,
): VentureFundDeploymentQuote {
  const fundSize = cents(state.fundSizeCents, "fundSizeCents", true);
  const deployedBefore = cents(state.deployedCents, "deployedCents", false);
  const amount = cents(amountCents, "amountCents", true);
  if (deployedBefore > fundSize) {
    throw new EngineError("CONFLICT", "deployed capital already exceeds fund size");
  }
  const deployedAfter = deployedBefore + amount;
  if (deployedAfter > fundSize) {
    throw new EngineError("INSUFFICIENT_FUNDS", "deployment exceeds undeployed fund capital", {
      fundSizeCents: fundSize.toString(),
      deployedCents: deployedBefore.toString(),
      requestedCents: amount.toString(),
    });
  }
  return Object.freeze({
    amountCents: amount.toString(),
    deployedBeforeCents: deployedBefore.toString(),
    deployedAfterCents: deployedAfter.toString(),
    remainingCents: (fundSize - deployedAfter).toString(),
    fullyDeployed: deployedAfter === fundSize,
  });
}
