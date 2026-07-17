import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { quoteInvestmentDistribution } from "./investment-distributions";

describe("investment ownership distributions", () => {
  it("allocates every cent exactly for arbitrary ownership weights", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
      fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), {
        minLength: 1,
        maxLength: 40,
      }),
      (amount, weights) => {
        const quote = quoteInvestmentDistribution(
          amount.toString(),
          weights.map((shares, index) => ({
            holderKind: index % 2 === 0 ? "agent" as const : "venture_fund" as const,
            holderId: `${index % 2 === 0 ? "agt" : "vfund"}_${index.toString(36).padStart(8, "0")}`,
            shares: shares.toString(),
          })),
        );
        expect(quote.allocations.reduce(
          (sum, allocation) => sum + BigInt(allocation.amountCents),
          0n,
        )).toBe(amount);
        expect(quote.allocations.reduce(
          (sum, allocation) => sum + BigInt(allocation.shares),
          0n,
        )).toBe(BigInt(quote.totalShares));
        expect(quote.allocations.every((allocation) => BigInt(allocation.amountCents) >= 0n))
          .toBe(true);
      },
    ));
  });

  it("aggregates duplicate stakes and is independent of input ordering", () => {
    const stakes = [
      { holderKind: "venture_fund" as const, holderId: "vfund_00000001", shares: "2" },
      { holderKind: "agent" as const, holderId: "agt_00000001", shares: "3" },
      { holderKind: "venture_fund" as const, holderId: "vfund_00000001", shares: "1" },
    ];
    const forward = quoteInvestmentDistribution("5", stakes);
    const reverse = quoteInvestmentDistribution("5", [...stakes].reverse());

    expect(reverse).toEqual(forward);
    expect(forward).toEqual({
      amountCents: "5",
      totalShares: "6",
      allocations: [
        { holderKind: "agent", holderId: "agt_00000001", shares: "3", amountCents: "3" },
        {
          holderKind: "venture_fund",
          holderId: "vfund_00000001",
          shares: "3",
          amountCents: "2",
        },
      ],
    });
  });

  it("breaks equal remainders by canonical owner order", () => {
    expect(quoteInvestmentDistribution("1", [
      { holderKind: "agent", holderId: "agt_00000002", shares: "1" },
      { holderKind: "agent", holderId: "agt_00000001", shares: "1" },
    ]).allocations).toEqual([
      { holderKind: "agent", holderId: "agt_00000001", shares: "1", amountCents: "1" },
      { holderKind: "agent", holderId: "agt_00000002", shares: "1", amountCents: "0" },
    ]);
  });

  it("rejects malformed amounts, shares, and empty ownership", () => {
    expect(() => quoteInvestmentDistribution("0", [
      { holderKind: "agent", holderId: "agt_00000001", shares: "1" },
    ])).toThrow(/amountCents/);
    expect(() => quoteInvestmentDistribution("1", [
      { holderKind: "agent", holderId: "agt_00000001", shares: "01" },
    ])).toThrow(/shares/);
    expect(() => quoteInvestmentDistribution("1", [])).toThrow(/at least one owner/);
  });
});
