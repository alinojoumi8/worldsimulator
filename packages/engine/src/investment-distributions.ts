/** Pure deterministic M10 ownership-distribution rules. */

import { allocate, EngineError, money } from "@worldtangle/shared";

const canonicalPositiveInteger = /^[1-9]\d*$/;
const signedSqliteMaximum = 9_223_372_036_854_775_807n;

export type InvestmentDistributionHolderKind = "agent" | "venture_fund";

export interface InvestmentDistributionStake {
  readonly holderKind: InvestmentDistributionHolderKind;
  readonly holderId: string;
  readonly shares: string;
}

export interface InvestmentDistributionAllocationQuote {
  readonly holderKind: InvestmentDistributionHolderKind;
  readonly holderId: string;
  readonly shares: string;
  readonly amountCents: string;
}

export interface InvestmentDistributionQuote {
  readonly amountCents: string;
  readonly totalShares: string;
  readonly allocations: readonly InvestmentDistributionAllocationQuote[];
}

function positiveInteger(value: string, field: string): bigint {
  if (!canonicalPositiveInteger.test(value)) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be a canonical positive integer string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > signedSqliteMaximum) {
    throw new EngineError("LIMIT_EXCEEDED", `${field} exceeds the SQLite integer range`);
  }
  return parsed;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Aggregate current stakes by beneficial owner and distribute an exact cent
 * amount using largest remainder. Equal remainders break by holder kind/id,
 * making the result independent of database or input ordering.
 */
export function quoteInvestmentDistribution(
  amountCents: string,
  stakes: readonly InvestmentDistributionStake[],
): InvestmentDistributionQuote {
  const amount = positiveInteger(amountCents, "amountCents");
  if (stakes.length === 0) {
    throw new EngineError("VALIDATION_FAILED", "a distribution requires at least one owner");
  }

  const aggregated = new Map<string, {
    readonly holderKind: InvestmentDistributionHolderKind;
    readonly holderId: string;
    shares: bigint;
  }>();
  for (const [index, stake] of stakes.entries()) {
    if (stake.holderId.length === 0 || stake.holderId.trim() !== stake.holderId) {
      throw new EngineError(
        "VALIDATION_FAILED",
        `stakes[${index}].holderId must be a non-empty canonical id`,
      );
    }
    const shares = positiveInteger(stake.shares, `stakes[${index}].shares`);
    const key = `${stake.holderKind}\u0000${stake.holderId}`;
    const prior = aggregated.get(key);
    if (prior === undefined) {
      aggregated.set(key, {
        holderKind: stake.holderKind,
        holderId: stake.holderId,
        shares,
      });
    } else {
      prior.shares += shares;
      if (prior.shares > signedSqliteMaximum) {
        throw new EngineError(
          "LIMIT_EXCEEDED",
          `aggregate shares for ${stake.holderKind}:${stake.holderId} exceed the SQLite range`,
        );
      }
    }
  }
  if (aggregated.size > 200) {
    throw new EngineError("LIMIT_EXCEEDED", "a distribution cannot exceed 200 owners");
  }

  const owners = [...aggregated.values()].sort((left, right) => (
    compareCodeUnit(left.holderKind, right.holderKind) ||
    compareCodeUnit(left.holderId, right.holderId)
  ));
  const totalShares = owners.reduce((sum, owner) => sum + owner.shares, 0n);
  if (totalShares > signedSqliteMaximum) {
    throw new EngineError("LIMIT_EXCEEDED", "total distribution shares exceed the SQLite range");
  }
  const amounts = allocate(money(amount), owners.map((owner) => owner.shares));
  const allocations = owners.map((owner, index) => Object.freeze({
    holderKind: owner.holderKind,
    holderId: owner.holderId,
    shares: owner.shares.toString(),
    amountCents: amounts[index]!.toString(),
  }));

  return Object.freeze({
    amountCents: amount.toString(),
    totalShares: totalShares.toString(),
    allocations: Object.freeze(allocations),
  });
}
