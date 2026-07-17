import { describe, expect, it } from "vitest";
import {
  activeBusinessCount,
  aggregateSentimentIndex,
  calculateFullIndicatorExtensions,
  finalExpenditureGdpProxyCents,
  fixedBasketCpiIndex,
  representativePostedPriceCents,
} from "./economic-indicators";

describe("WS-704 deterministic economic indicator formulas", () => {
  it("matches baseline and energy-shock fixture-world goldens", () => {
    const baseline = calculateFullIndicatorExtensions({
      cpiBasket: [
        { sku: "non_energy", weightBp: 8_000, basePriceCents: "500", currentPriceCents: "500" },
        { sku: "electricity", weightBp: 2_000, basePriceCents: "15000", currentPriceCents: "15000" },
      ],
      finalDomesticSalesCents: [],
      activeBusinessIds: Array.from({ length: 15 }, (_, index) => `biz_${index + 1}`),
      sentimentTopicValues: [0, 0, 0],
    });
    expect(baseline).toEqual({
      cpiIndex: 1_000n,
      gdpProxyCents: 0n,
      activeBusinessCount: 15n,
      sentimentIndex: 0n,
    });

    const shocked = calculateFullIndicatorExtensions({
      cpiBasket: [
        { sku: "non_energy", weightBp: 8_000, basePriceCents: "500", currentPriceCents: "500" },
        { sku: "electricity", weightBp: 2_000, basePriceCents: "15000", currentPriceCents: "17700" },
      ],
      finalDomesticSalesCents: ["100", "250", "650"],
      activeBusinessIds: ["biz_1", "biz_2"],
      sentimentTopicValues: [-1_000, 2_000, 3_000],
    });
    expect(shocked).toEqual({
      cpiIndex: 1_036n,
      gdpProxyCents: 1_000n,
      activeBusinessCount: 2n,
      sentimentIndex: 1_333n,
    });
  });

  it("uses HALF_EVEN at every indicator division boundary", () => {
    expect(representativePostedPriceCents(["100", "101"])).toBe(100n);
    expect(representativePostedPriceCents(["101", "102"])).toBe(102n);
    expect(aggregateSentimentIndex([-1, -1, 0])).toBe(-1n);
  });

  it("rejects malformed baskets, duplicate businesses, and invalid values", () => {
    expect(() => fixedBasketCpiIndex([
      { sku: "food", weightBp: 9_999, basePriceCents: "100", currentPriceCents: "100" },
    ])).toThrow(/weights must total/);
    expect(() => activeBusinessCount(["biz_1", "biz_1"])).toThrow(/unique/);
    expect(() => finalExpenditureGdpProxyCents(["-1"])).toThrow(/non-negative/);
    expect(() => aggregateSentimentIndex([0, 0, 10_001])).toThrow(/out of bounds/);
  });
});
