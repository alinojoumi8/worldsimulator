import { EngineError, money, mulDiv, type Money } from "@worldtangle/shared";

export const WORLD_EVENT_CATALOG_VERSION = 1;
export const WORLD_EVENT_MINIMUM_DEMAND_MULTIPLIER_BP = 1_000;
export const WORLD_EVENT_MAXIMUM_DEMAND_MULTIPLIER_BP = 50_000;

function assertBasisPoints(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a safe integer`);
  }
}

export function percentageToBasisPoints(deltaPct: number): number {
  if (!Number.isSafeInteger(deltaPct)) {
    throw new EngineError("VALIDATION_FAILED", "percentage change must be a safe integer");
  }
  const basisPoints = deltaPct * 100;
  if (!Number.isSafeInteger(basisPoints)) {
    throw new EngineError("VALIDATION_FAILED", "percentage change is outside the safe range");
  }
  return basisPoints;
}

export function changedReferencePrice(currentPriceCents: Money, changeBp: number): Money {
  if (currentPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "reference price must be positive");
  }
  assertBasisPoints(changeBp, "reference-price change");
  if (changeBp <= -10_000) {
    throw new EngineError("VALIDATION_FAILED", "reference-price change must be above -10000 bp");
  }
  const changed = mulDiv(
    currentPriceCents,
    BigInt(10_000 + changeBp),
    10_000n,
    "HALF_EVEN",
  );
  return changed < 1n ? money(1n) : changed;
}

export function combinedDemandMultiplierBp(changesBp: readonly number[]): number {
  let total = 10_000;
  for (const changeBp of changesBp) {
    assertBasisPoints(changeBp, "demand change");
    total += changeBp;
  }
  return Math.max(
    WORLD_EVENT_MINIMUM_DEMAND_MULTIPLIER_BP,
    Math.min(WORLD_EVENT_MAXIMUM_DEMAND_MULTIPLIER_BP, total),
  );
}

export function combinedCapacityMultiplierBp(reductionsBp: readonly number[]): number {
  let reduction = 0;
  for (const reductionBp of reductionsBp) {
    assertBasisPoints(reductionBp, "capacity reduction");
    if (reductionBp < 0 || reductionBp > 10_000) {
      throw new EngineError("VALIDATION_FAILED", "capacity reduction is outside 0..10000 bp");
    }
    reduction += reductionBp;
  }
  return Math.max(0, 10_000 - Math.min(10_000, reduction));
}

export function scaleMoneyByBasisPoints(amount: Money, multiplierBp: number): Money {
  if (amount < 0n) throw new EngineError("VALIDATION_FAILED", "scaled amount cannot be negative");
  assertBasisPoints(multiplierBp, "money multiplier");
  if (multiplierBp < 0) {
    throw new EngineError("VALIDATION_FAILED", "money multiplier cannot be negative");
  }
  return mulDiv(amount, BigInt(multiplierBp), 10_000n, "HALF_EVEN");
}

export function scaleCapacity(capacity: number, multiplierBp: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new EngineError("VALIDATION_FAILED", "capacity must be a nonnegative safe integer");
  }
  assertBasisPoints(multiplierBp, "capacity multiplier");
  if (multiplierBp < 0 || multiplierBp > 10_000) {
    throw new EngineError("VALIDATION_FAILED", "capacity multiplier is outside 0..10000 bp");
  }
  return Number((BigInt(capacity) * BigInt(multiplierBp)) / 10_000n);
}
