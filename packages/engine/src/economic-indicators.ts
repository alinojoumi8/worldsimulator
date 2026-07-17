/** Deterministic WS-704 macroeconomic indicator formulas. */

import { EngineError, money, mulDiv } from "@worldtangle/shared";

export const ECONOMIC_INDICATOR_RULESET_VERSION = 1;
export const CPI_BASE_INDEX = 1_000n;
export const CPI_BASKET_WEIGHT_TOTAL_BP = 10_000;
export const GDP_PROXY_WINDOW_TICKS = 30;
export const SENTIMENT_INDEX_TOPIC_COUNT = 3;

export interface FixedBasketPrice {
  readonly sku: string;
  readonly weightBp: number;
  readonly basePriceCents: string;
  readonly currentPriceCents: string;
}

export interface FullIndicatorExtensionInputs {
  readonly cpiBasket: readonly FixedBasketPrice[];
  readonly finalDomesticSalesCents: readonly string[];
  readonly activeBusinessIds: readonly string[];
  readonly sentimentTopicValues: readonly number[];
}

export interface FullIndicatorExtensions {
  readonly cpiIndex: bigint;
  readonly gdpProxyCents: bigint;
  readonly activeBusinessCount: bigint;
  readonly sentimentIndex: bigint;
}

function integerString(value: string, field: string, positive: boolean): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be an integer string`);
  }
  const parsed = BigInt(value);
  if (positive ? parsed <= 0n : parsed < 0n) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be ${positive ? "positive" : "non-negative"}`,
    );
  }
  return parsed;
}

/** HALF_EVEN arithmetic mean used for one SKU's active posted-price sample. */
export function representativePostedPriceCents(prices: readonly string[]): bigint {
  if (prices.length === 0) {
    throw new EngineError("VALIDATION_FAILED", "posted-price sample cannot be empty");
  }
  const total = prices.reduce(
    (sum, price, index) => sum + integerString(price, `posted price ${index}`, true),
    0n,
  );
  return mulDiv(money(total), 1n, BigInt(prices.length), "HALF_EVEN");
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  return (left / greatestCommonDivisor(left, right)) * right;
}

/**
 * Laspeyres-style fixed-expenditure basket with tick-0 prices and index base 1000.
 * Basket weights are base-period expenditure shares and must sum to 10,000 bp.
 * Price relatives are combined as one exact rational before HALF_EVEN rounding.
 */
export function fixedBasketCpiIndex(items: readonly FixedBasketPrice[]): bigint {
  if (items.length === 0) {
    throw new EngineError("VALIDATION_FAILED", "CPI basket cannot be empty");
  }
  const seen = new Set<string>();
  let totalWeightBp = 0;
  const parsedItems: {
    readonly weightBp: bigint;
    readonly basePrice: bigint;
    readonly currentPrice: bigint;
  }[] = [];
  let commonBasePrice = 1n;
  for (const item of items) {
    if (item.sku.length === 0 || seen.has(item.sku)) {
      throw new EngineError("VALIDATION_FAILED", "CPI basket SKUs must be unique and non-empty");
    }
    if (!Number.isSafeInteger(item.weightBp) || item.weightBp < 0) {
      throw new EngineError("VALIDATION_FAILED", `invalid CPI weight for ${item.sku}`);
    }
    seen.add(item.sku);
    totalWeightBp += item.weightBp;
    const basePrice = integerString(item.basePriceCents, `${item.sku} base price`, true);
    const currentPrice = integerString(
      item.currentPriceCents,
      `${item.sku} current price`,
      true,
    );
    parsedItems.push({ weightBp: BigInt(item.weightBp), basePrice, currentPrice });
    commonBasePrice = leastCommonMultiple(commonBasePrice, basePrice);
  }
  if (totalWeightBp !== CPI_BASKET_WEIGHT_TOTAL_BP) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `CPI weights must total ${CPI_BASKET_WEIGHT_TOTAL_BP} bp`,
    );
  }
  const weightedRelativeNumerator = parsedItems.reduce(
    (sum, item) => sum + (
      item.currentPrice * item.weightBp * (commonBasePrice / item.basePrice)
    ),
    0n,
  );
  return mulDiv(
    money(weightedRelativeNumerator),
    CPI_BASE_INDEX,
    commonBasePrice * BigInt(CPI_BASKET_WEIGHT_TOTAL_BP),
    "HALF_EVEN",
  );
}

/** Rolling final-expenditure proxy: local household/agent sales plus household energy. */
export function finalExpenditureGdpProxyCents(amounts: readonly string[]): bigint {
  return amounts.reduce(
    (sum, amount, index) => sum + integerString(amount, `final sale ${index}`, false),
    0n,
  );
}

/** Active businesses are unique owners with an active company checking account. */
export function activeBusinessCount(businessIds: readonly string[]): bigint {
  const unique = new Set<string>();
  for (const id of businessIds) {
    if (id.length === 0 || unique.has(id)) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "active business IDs must be unique and non-empty",
      );
    }
    unique.add(id);
  }
  return BigInt(unique.size);
}

/** HALF_EVEN mean of economy, employment, and institutions on the -10,000..10,000 scale. */
export function aggregateSentimentIndex(values: readonly number[]): bigint {
  if (values.length !== SENTIMENT_INDEX_TOPIC_COUNT) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `sentiment index requires ${SENTIMENT_INDEX_TOPIC_COUNT} topic values`,
    );
  }
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < -10_000 || value > 10_000) {
      throw new EngineError("VALIDATION_FAILED", "sentiment topic value is out of bounds");
    }
    total += BigInt(value);
  }
  return mulDiv(money(total), 1n, BigInt(values.length), "HALF_EVEN");
}

export function calculateFullIndicatorExtensions(
  input: FullIndicatorExtensionInputs,
): FullIndicatorExtensions {
  return Object.freeze({
    cpiIndex: fixedBasketCpiIndex(input.cpiBasket),
    gdpProxyCents: finalExpenditureGdpProxyCents(input.finalDomesticSalesCents),
    activeBusinessCount: activeBusinessCount(input.activeBusinessIds),
    sentimentIndex: aggregateSentimentIndex(input.sentimentTopicValues),
  });
}
