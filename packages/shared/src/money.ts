/**
 * Money & fixed-point arithmetic (ADR-0013).
 *
 * Amounts are integer minor units (cents) as native `bigint`; rates are
 * integer basis points (1 bp = 0.01%). No floats ever touch financial paths.
 * `mulDiv` is the single place rational math meets rounding; `allocate`
 * (largest-remainder) is the single way to split an amount so parts always
 * sum exactly.
 */

declare const moneyBrand: unique symbol;

/** Integer minor units. Raw bigint values must cross the `money()` boundary. */
export type Money = bigint & { readonly [moneyBrand]: "Money" };

export type RoundingMode = "HALF_EVEN" | "FLOOR" | "CEIL";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function asMoney(value: bigint): Money {
  return value as Money;
}

/** Parse/validate integer cents. `number` is deliberately not a public input. */
export function money(value: bigint | string): Money;
export function money(value: unknown): Money {
  if (typeof value === "bigint") return asMoney(value);
  if (typeof value !== "string") {
    throw new MoneyError(`not a bigint or integer cent string: ${String(value)}`);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyError(`not an integer cent string: ${JSON.stringify(value)}`);
  }
  return asMoney(BigInt(value));
}

/** Add two cent amounts without leaving the branded money domain. */
export function add(left: Money, right: Money): Money {
  return asMoney(left + right);
}

/** Subtract two cent amounts without leaving the branded money domain. */
export function sub(left: Money, right: Money): Money {
  return asMoney(left - right);
}

/**
 * (amount * num) / den with an explicit rounding mode.
 * FLOOR rounds toward -∞, CEIL toward +∞, HALF_EVEN is banker's rounding.
 */
export function mulDiv(
  amount: Money,
  num: bigint,
  den: bigint,
  mode: RoundingMode = "HALF_EVEN",
): Money {
  if (den === 0n) throw new MoneyError("mulDiv: division by zero");
  if (den < 0n) {
    den = -den;
    num = -num;
  }
  const product = amount * num;
  const quotient = product / den; // bigint division truncates toward zero
  const remainder = product % den; // sign follows the product
  if (remainder === 0n) return asMoney(quotient);
  const negative = product < 0n;
  switch (mode) {
    case "FLOOR":
      return asMoney(negative ? quotient - 1n : quotient);
    case "CEIL":
      return asMoney(negative ? quotient : quotient + 1n);
    case "HALF_EVEN": {
      const twiceAbsRemainder = 2n * (negative ? -remainder : remainder);
      if (twiceAbsRemainder > den) {
        return asMoney(negative ? quotient - 1n : quotient + 1n);
      }
      if (twiceAbsRemainder < den) return asMoney(quotient);
      // exactly half: round so the last digit is even
      if (quotient % 2n === 0n) return asMoney(quotient);
      return asMoney(negative ? quotient - 1n : quotient + 1n);
    }
  }
}

/** Apply a basis-point rate (1 bp = 0.01%) to an amount. */
export function applyRateBp(
  amount: Money,
  rateBp: bigint,
  mode: RoundingMode = "HALF_EVEN",
): Money {
  return mulDiv(amount, rateBp, 10_000n, mode);
}

/**
 * Split an amount proportionally to `weights` using the largest-remainder
 * method. Guarantees: result has the same length as weights, and the parts
 * sum to `amount` EXACTLY. Ties break toward the lowest index (deterministic).
 */
export function allocate(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new MoneyError("allocate: empty weights");
  let total = 0n;
  for (const w of weights) {
    if (w < 0n) throw new MoneyError("allocate: negative weight");
    total += w;
  }
  if (total === 0n) throw new MoneyError("allocate: zero total weight");
  if (amount < 0n) {
    return allocate(asMoney(-amount), weights).map((part) => asMoney(-part));
  }

  const parts: Money[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0n;
  for (let i = 0; i < weights.length; i++) {
    const raw = amount * weights[i]!;
    const part = raw / total;
    parts.push(asMoney(part));
    assigned += part;
    remainders.push({ index: i, remainder: raw % total });
  }
  let leftover = amount - assigned; // 0 <= leftover < weights.length
  remainders.sort((a, b) =>
    b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] = asMoney(parts[index]! + 1n);
    leftover -= 1n;
  }
  return parts;
}

/** Display helper: cents → "$12.34" (UI concern only, never math). */
export function formatMoney(amount: Money): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const dollars = abs / 100n;
  const cents = abs % 100n;
  return `${negative ? "-" : ""}$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}
