/** Pure deterministic M08 insolvency and liquidation rules. */

import { EngineError, money, mulDiv } from "@worldtangle/shared";
import type { CompanyCreditorKind, Money } from "@worldtangle/shared";

export const INSOLVENCY_RULESET_VERSION = 1;
export const INSOLVENCY_CONSECUTIVE_SHORTFALL_DAYS = 30;
export const INSOLVENCY_OBLIGATION_HORIZON_TICKS = 30;
export const INVENTORY_SALVAGE_RATE_BP = 5_000;

export const CREDITOR_SENIORITY: Readonly<Record<CompanyCreditorKind, number>> = {
  employee_wage: 10,
  secured_debt: 20,
  tax: 30,
  trade: 40,
  unsecured_debt: 50,
  equity_residual: 1_000,
};

export interface SolvencyRuleResult {
  readonly cashCents: Money;
  readonly obligationCents: Money;
  readonly shortfallCents: Money;
  readonly consecutiveShortfallDays: number;
  readonly insolvent: boolean;
}

export interface WaterfallClaim {
  readonly id: string;
  readonly seniority: number;
  readonly registeredTick: number;
  readonly amountCents: Money;
}

export interface WaterfallAllocation {
  readonly claimId: string;
  readonly recoveredCents: Money;
  readonly writtenOffCents: Money;
}

function assertSafeInteger(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assessCompanySolvency(input: {
  readonly cashCents: Money;
  readonly obligationCents: Money;
  readonly priorConsecutiveShortfallDays: number;
  readonly failureThresholdDays?: number;
}): SolvencyRuleResult {
  if (input.cashCents < 0n || input.obligationCents < 0n) {
    throw new EngineError("VALIDATION_FAILED", "cash and obligations must be nonnegative");
  }
  assertSafeInteger(
    input.priorConsecutiveShortfallDays,
    "priorConsecutiveShortfallDays",
  );
  const failureThresholdDays = input.failureThresholdDays ??
    INSOLVENCY_CONSECUTIVE_SHORTFALL_DAYS;
  assertSafeInteger(failureThresholdDays, "failureThresholdDays", 1);
  const shortfallCents = input.obligationCents > input.cashCents
    ? money(input.obligationCents - input.cashCents)
    : money(0n);
  const consecutiveShortfallDays = shortfallCents > 0n
    ? input.priorConsecutiveShortfallDays + 1
    : 0;
  assertSafeInteger(consecutiveShortfallDays, "consecutiveShortfallDays");
  return Object.freeze({
    cashCents: input.cashCents,
    obligationCents: input.obligationCents,
    shortfallCents,
    consecutiveShortfallDays,
    insolvent: consecutiveShortfallDays >= failureThresholdDays,
  });
}

export function inventorySalvageUnitPrice(
  rowReferencePriceCents: Money,
  salvageRateBp = INVENTORY_SALVAGE_RATE_BP,
): Money {
  if (rowReferencePriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "ROW reference price must be positive");
  }
  assertSafeInteger(salvageRateBp, "salvageRateBp", 1);
  if (salvageRateBp > 10_000) {
    throw new EngineError("VALIDATION_FAILED", "salvage rate cannot exceed 10000 bp");
  }
  const price = mulDiv(rowReferencePriceCents, BigInt(salvageRateBp), 10_000n, "FLOOR");
  return price > 0n ? price : money(1n);
}

export function inventorySalvageTotal(unitPriceCents: Money, quantity: number): Money {
  if (unitPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "salvage unit price must be positive");
  }
  assertSafeInteger(quantity, "salvage quantity", 1);
  return money(unitPriceCents * BigInt(quantity));
}

/**
 * Allocates the pool in strict seniority order. Ties use registration tick and
 * then raw code-unit ID order, never locale ordering.
 */
export function allocateCreditorWaterfall(
  poolCents: Money,
  claims: readonly WaterfallClaim[],
): readonly WaterfallAllocation[] {
  if (poolCents < 0n) {
    throw new EngineError("VALIDATION_FAILED", "liquidation pool must be nonnegative");
  }
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.id)) {
      throw new EngineError("VALIDATION_FAILED", `duplicate creditor claim ${claim.id}`);
    }
    seen.add(claim.id);
    assertSafeInteger(claim.seniority, "claim seniority", 1);
    assertSafeInteger(claim.registeredTick, "claim registered tick");
    if (claim.amountCents <= 0n) {
      throw new EngineError("VALIDATION_FAILED", "creditor claim amounts must be positive");
    }
  }
  const ordered = [...claims].sort((left, right) =>
    left.seniority - right.seniority ||
    left.registeredTick - right.registeredTick ||
    compareCodeUnits(left.id, right.id));
  let remaining = poolCents;
  return Object.freeze(ordered.map((claim) => {
    const recoveredCents = remaining > claim.amountCents ? claim.amountCents : remaining;
    remaining = money(remaining - recoveredCents);
    return Object.freeze({
      claimId: claim.id,
      recoveredCents: money(recoveredCents),
      writtenOffCents: money(claim.amountCents - recoveredCents),
    });
  }));
}
