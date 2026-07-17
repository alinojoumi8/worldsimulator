import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { add, allocate, applyRateBp, formatMoney, money, MoneyError, mulDiv, sub } from "./money";
import type { Money } from "./money";

const amountArb = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
const weightsArb = fc
  .array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 12 })
  .filter((ws) => ws.some((w) => w > 0n));

describe("mulDiv", () => {
  it("is exact when the division has no remainder", () => {
    expect(mulDiv(money(1000n), 3n, 4n)).toBe(750n);
  });

  it("HALF_EVEN rounds ties to the even quotient", () => {
    expect(mulDiv(money(5n), 1n, 2n)).toBe(2n); // 2.5 → 2
    expect(mulDiv(money(7n), 1n, 2n)).toBe(4n); // 3.5 → 4
    expect(mulDiv(money(-5n), 1n, 2n)).toBe(-2n); // -2.5 → -2
    expect(mulDiv(money(-7n), 1n, 2n)).toBe(-4n); // -3.5 → -4
  });

  it("HALF_EVEN rounds non-ties to nearest", () => {
    expect(mulDiv(money(2n), 2n, 3n)).toBe(1n); // 1.333 → 1
    expect(mulDiv(money(2n), 5n, 3n)).toBe(3n); // 3.333 → 3
    expect(mulDiv(money(1n), 5n, 3n)).toBe(2n); // 1.666 → 2
  });

  it("FLOOR rounds toward -inf, CEIL toward +inf", () => {
    expect(mulDiv(money(5n), 1n, 2n, "FLOOR")).toBe(2n);
    expect(mulDiv(money(5n), 1n, 2n, "CEIL")).toBe(3n);
    expect(mulDiv(money(-5n), 1n, 2n, "FLOOR")).toBe(-3n);
    expect(mulDiv(money(-5n), 1n, 2n, "CEIL")).toBe(-2n);
  });

  it("normalizes negative denominators", () => {
    expect(mulDiv(money(10n), 1n, -3n, "FLOOR")).toBe(-4n);
    expect(mulDiv(money(10n), -1n, -3n, "FLOOR")).toBe(3n);
  });

  it("throws on zero denominator", () => {
    expect(() => mulDiv(money(1n), 1n, 0n)).toThrow(MoneyError);
  });

  it("is always within one unit of the exact rational value (property)", () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.bigInt({ min: -1000n, max: 1000n }),
        fc.bigInt({ min: 1n, max: 1000n }),
        (amount, num, den) => {
          const result = mulDiv(money(amount), num, den);
          const diff = result * den - amount * num;
          const abs = diff < 0n ? -diff : diff;
          return abs < den;
        },
      ),
    );
  });
});

describe("add/sub", () => {
  it("preserves additive identities across arbitrary cent amounts", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (leftValue, rightValue) => {
        const left = money(leftValue);
        const right = money(rightValue);
        const zero = money(0n);
        return (
          add(left, zero) === left &&
          sub(left, zero) === left &&
          sub(add(left, right), right) === left &&
          add(sub(left, right), right) === left &&
          sub(left, left) === zero
        );
      }),
    );
  });
});

describe("applyRateBp", () => {
  it("applies basis points exactly", () => {
    expect(applyRateBp(money(100_000n), 1800n)).toBe(18_000n); // 18% of $1,000.00
    expect(applyRateBp(money(100_000n), 900n)).toBe(9_000n);
  });
});

describe("allocate", () => {
  it("parts always sum exactly to the amount (property)", () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (amount, weights) => {
        const parts = allocate(money(amount), weights);
        const sum = parts.reduce((a, b) => a + b, 0n);
        return sum === amount && parts.length === weights.length;
      }),
    );
  });

  it("splits with the largest-remainder method", () => {
    expect(allocate(money(100n), [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(money(101n), [1n, 1n, 1n])).toEqual([34n, 34n, 33n]);
  });

  it("breaks remainder ties toward the lowest index (deterministic)", () => {
    expect(allocate(money(1n), [1n, 1n])).toEqual([1n, 0n]);
    expect(allocate(money(3n), [1n, 1n])).toEqual([2n, 1n]);
  });

  it("gives zero-weight entries nothing", () => {
    expect(allocate(money(10n), [0n, 5n])).toEqual([0n, 10n]);
  });

  it("mirrors for negative amounts", () => {
    expect(allocate(money(-100n), [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it("rejects invalid inputs", () => {
    expect(() => allocate(money(10n), [])).toThrow(MoneyError);
    expect(() => allocate(money(10n), [-1n, 2n])).toThrow(MoneyError);
    expect(() => allocate(money(10n), [0n, 0n])).toThrow(MoneyError);
  });
});

describe("money", () => {
  it("accepts bigint and integer strings", () => {
    expect(money(150n)).toBe(150n);
    expect(money("-150")).toBe(-150n);
  });

  it("rejects number inputs at runtime boundaries and malformed strings", () => {
    const untypedMoney = money as (value: unknown) => Money;
    expect(() => untypedMoney(150)).toThrow(MoneyError);
    expect(() => untypedMoney(1.5)).toThrow(MoneyError);
    expect(() => money("1.50")).toThrow(MoneyError);
    expect(() => money("abc")).toThrow(MoneyError);
  });
});

describe("formatMoney", () => {
  it("formats cents for display", () => {
    expect(formatMoney(money(123456n))).toBe("$1234.56");
    expect(formatMoney(money(-12345n))).toBe("-$123.45");
    expect(formatMoney(money(5n))).toBe("$0.05");
    expect(formatMoney(money(0n))).toBe("$0.00");
  });
});

function verifyMoneyTypeBoundary(): void {
  const amount = money(100n);
  const result: Money = add(amount, money(25n));
  void result;

  // @ts-expect-error number cents are forbidden on authoritative money paths
  money(100);
  // @ts-expect-error raw bigint must cross the money() validation boundary
  add(100n, amount);
  // @ts-expect-error basis-point math must not introduce number arithmetic
  applyRateBp(amount, 1800);
}
void verifyMoneyTypeBoundary;
