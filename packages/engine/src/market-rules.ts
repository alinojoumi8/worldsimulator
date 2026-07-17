/** Deterministic M08/M12 production, inventory, and posted-price rules. */

import { EngineError, money, mulDiv } from "@worldtangle/shared";
import type { Money } from "@worldtangle/shared";

export const MARKET_PRICE_REVIEW_INTERVAL_TICKS = 7;
export const MARKET_PRICE_ADJUSTMENT_BP = 500;
export const MARKET_PRICE_LOW_INVENTORY_SALES_RATIO_BP = 5_000;
export const MARKET_PRICE_HIGH_INVENTORY_SALES_RATIO_BP = 20_000;
export const MARKET_PRICE_MAX_MARKUP_BP = 5_000;

export type MarketPriceRuleSignal =
  | "bound_correction"
  | "stockout"
  | "low_inventory"
  | "balanced"
  | "excess_inventory"
  | "no_sales"
  | "no_activity";

export interface MarketPriceBounds {
  readonly minimumCents: Money;
  readonly maximumCents: Money;
}

export interface WeeklyMarketPriceResult extends MarketPriceBounds {
  readonly newPriceCents: Money;
  readonly inventorySalesRatioBp: number | null;
  readonly signal: MarketPriceRuleSignal;
}

function assertSafeInteger(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function safeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new EngineError("VALIDATION_FAILED", `${field} exceeds the safe integer range`);
  }
  return result;
}

export function linearProductionUnits(input: {
  readonly activeWorkerCount: number;
  readonly laborHoursPerWorker: number;
  readonly productivityMilliunitsPerLaborHour: number;
  readonly capacityUnitsPerTick: number;
}): number {
  assertSafeInteger(input.activeWorkerCount, "activeWorkerCount");
  assertSafeInteger(input.laborHoursPerWorker, "laborHoursPerWorker", 1);
  assertSafeInteger(
    input.productivityMilliunitsPerLaborHour,
    "productivityMilliunitsPerLaborHour",
    1,
  );
  assertSafeInteger(input.capacityUnitsPerTick, "capacityUnitsPerTick", 1);
  const laborHours = BigInt(input.activeWorkerCount) * BigInt(input.laborHoursPerWorker);
  const laborBound = laborHours * BigInt(input.productivityMilliunitsPerLaborHour) / 1_000n;
  const units = laborBound < BigInt(input.capacityUnitsPerTick)
    ? laborBound
    : BigInt(input.capacityUnitsPerTick);
  return safeNumber(units, "production units");
}

export function inventoryAfterProduction(currentQuantity: number, producedQuantity: number): number {
  assertSafeInteger(currentQuantity, "currentQuantity");
  assertSafeInteger(producedQuantity, "producedQuantity");
  return safeNumber(BigInt(currentQuantity) + BigInt(producedQuantity), "inventory quantity");
}

export function inventoryAfterSale(currentQuantity: number, soldQuantity: number): number {
  assertSafeInteger(currentQuantity, "currentQuantity");
  assertSafeInteger(soldQuantity, "soldQuantity", 1);
  if (soldQuantity > currentQuantity) {
    throw new EngineError("CONFLICT", "sale quantity exceeds available inventory", {
      currentQuantity,
      soldQuantity,
    });
  }
  return currentQuantity - soldQuantity;
}

export function movingAverageUnitCost(input: {
  readonly currentQuantity: number;
  readonly currentAverageUnitCostCents: Money;
  readonly producedQuantity: number;
  readonly producedUnitCostCents: Money;
}): Money {
  assertSafeInteger(input.currentQuantity, "currentQuantity");
  assertSafeInteger(input.producedQuantity, "producedQuantity");
  if (input.currentAverageUnitCostCents < 0n || input.producedUnitCostCents < 0n) {
    throw new EngineError("VALIDATION_FAILED", "unit costs cannot be negative");
  }
  const totalQuantity = input.currentQuantity + input.producedQuantity;
  if (totalQuantity === 0) return money(0n);
  const totalCost = money(
    input.currentAverageUnitCostCents * BigInt(input.currentQuantity) +
      input.producedUnitCostCents * BigInt(input.producedQuantity),
  );
  return mulDiv(totalCost, 1n, BigInt(totalQuantity), "HALF_EVEN");
}

export function postedPriceTotal(unitPriceCents: Money, quantity: number): Money {
  assertSafeInteger(quantity, "quantity", 1);
  if (unitPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "unit price must be positive");
  }
  return money(unitPriceCents * BigInt(quantity));
}

export function affordableQuantity(budgetCents: Money, unitPriceCents: Money): number {
  if (budgetCents < 0n) throw new EngineError("VALIDATION_FAILED", "budget cannot be negative");
  if (unitPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "unit price must be positive");
  }
  return safeNumber(budgetCents / unitPriceCents, "affordable quantity");
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortPostedPriceOfferings<T extends {
  readonly id: string;
  readonly postedPriceCents: string;
}>(offerings: readonly T[]): readonly T[] {
  return [...offerings].sort((left, right) => {
    const priceComparison = BigInt(left.postedPriceCents) - BigInt(right.postedPriceCents);
    return priceComparison < 0n
      ? -1
      : priceComparison > 0n
        ? 1
        : compareCodeUnit(left.id, right.id);
  });
}

export function marketPriceBounds(unitCostCents: Money): MarketPriceBounds {
  if (unitCostCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "unit cost must be positive");
  }
  return Object.freeze({
    minimumCents: unitCostCents,
    maximumCents: money(
      unitCostCents * BigInt(10_000 + MARKET_PRICE_MAX_MARKUP_BP) / 10_000n,
    ),
  });
}

export function assertMarketPriceWithinBounds(
  priceCents: Money,
  unitCostCents: Money,
): Money {
  const bounds = marketPriceBounds(unitCostCents);
  if (priceCents < bounds.minimumCents || priceCents > bounds.maximumCents) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "price must be within [unit cost, unit cost + 50%]",
      {
        priceCents: priceCents.toString(),
        minimumCents: bounds.minimumCents.toString(),
        maximumCents: bounds.maximumCents.toString(),
      },
    );
  }
  return priceCents;
}

export function inventorySalesRatioBasisPoints(
  inventoryQuantity: number,
  unitsSold: number,
): number | null {
  assertSafeInteger(inventoryQuantity, "inventoryQuantity");
  assertSafeInteger(unitsSold, "unitsSold");
  if (unitsSold === 0) return null;
  const ratio = BigInt(inventoryQuantity) * 10_000n / BigInt(unitsSold);
  return ratio > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(ratio);
}

export function marketPriceReviewDue(createdTick: number, tick: number): boolean {
  assertSafeInteger(createdTick, "createdTick");
  assertSafeInteger(tick, "tick");
  return tick > createdTick &&
    (tick - createdTick) % MARKET_PRICE_REVIEW_INTERVAL_TICKS === 0;
}

function clampPrice(priceCents: Money, bounds: MarketPriceBounds): Money {
  return priceCents < bounds.minimumCents
    ? bounds.minimumCents
    : priceCents > bounds.maximumCents
      ? bounds.maximumCents
      : priceCents;
}

function steppedPrice(currentPriceCents: Money, direction: "increase" | "decrease"): Money {
  const factor = direction === "increase"
    ? 10_000 + MARKET_PRICE_ADJUSTMENT_BP
    : 10_000 - MARKET_PRICE_ADJUSTMENT_BP;
  const rounded = mulDiv(currentPriceCents, BigInt(factor), 10_000n, "HALF_EVEN");
  if (direction === "increase" && rounded <= currentPriceCents) return money(currentPriceCents + 1n);
  if (direction === "decrease" && rounded >= currentPriceCents) return money(currentPriceCents - 1n);
  return rounded;
}

export function weeklyMarketPriceAdjustment(input: {
  readonly currentPriceCents: Money;
  readonly unitCostCents: Money;
  readonly inventoryQuantity: number;
  readonly unitsSold: number;
  readonly unfilledUnits: number;
}): WeeklyMarketPriceResult {
  if (input.currentPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "current price must be positive");
  }
  assertSafeInteger(input.inventoryQuantity, "inventoryQuantity");
  assertSafeInteger(input.unitsSold, "unitsSold");
  assertSafeInteger(input.unfilledUnits, "unfilledUnits");
  const bounds = marketPriceBounds(input.unitCostCents);
  const boundedCurrent = clampPrice(input.currentPriceCents, bounds);
  const ratio = inventorySalesRatioBasisPoints(input.inventoryQuantity, input.unitsSold);
  if (boundedCurrent !== input.currentPriceCents) {
    return Object.freeze({
      ...bounds,
      newPriceCents: boundedCurrent,
      inventorySalesRatioBp: ratio,
      signal: "bound_correction",
    });
  }

  let signal: MarketPriceRuleSignal;
  let direction: "increase" | "decrease" | "unchanged";
  if (input.unfilledUnits > 0) {
    signal = "stockout";
    direction = "increase";
  } else if (ratio === null && input.inventoryQuantity > 0) {
    signal = "no_sales";
    direction = "decrease";
  } else if (ratio === null) {
    signal = "no_activity";
    direction = "unchanged";
  } else if (ratio < MARKET_PRICE_LOW_INVENTORY_SALES_RATIO_BP) {
    signal = "low_inventory";
    direction = "increase";
  } else if (ratio > MARKET_PRICE_HIGH_INVENTORY_SALES_RATIO_BP) {
    signal = "excess_inventory";
    direction = "decrease";
  } else {
    signal = "balanced";
    direction = "unchanged";
  }
  const candidate = direction === "unchanged"
    ? input.currentPriceCents
    : steppedPrice(input.currentPriceCents, direction);
  return Object.freeze({
    ...bounds,
    newPriceCents: clampPrice(candidate, bounds),
    inventorySalesRatioBp: ratio,
    signal,
  });
}
