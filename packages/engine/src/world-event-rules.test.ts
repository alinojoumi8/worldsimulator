import { describe, expect, it } from "vitest";
import { money } from "@worldtangle/shared";
import {
  changedReferencePrice,
  combinedCapacityMultiplierBp,
  combinedDemandMultiplierBp,
  percentageToBasisPoints,
  scaleCapacity,
  scaleMoneyByBasisPoints,
} from "./world-event-rules";

describe("world-event rules", () => {
  it("converts approved integer percentages and changes reference prices exactly", () => {
    expect(percentageToBasisPoints(30)).toBe(3_000);
    expect(changedReferencePrice(money("400"), 3_000)).toBe(520n);
    expect(changedReferencePrice(money("1"), -9_000)).toBe(1n);
  });

  it("combines overlapping demand shocks within the approved envelope", () => {
    expect(combinedDemandMultiplierBp([3_000, -1_000])).toBe(12_000);
    expect(combinedDemandMultiplierBp([-9_000, -9_000])).toBe(1_000);
    expect(combinedDemandMultiplierBp([50_000, 50_000])).toBe(50_000);
    expect(scaleMoneyByBasisPoints(money("12500"), 12_000)).toBe(15_000n);
  });

  it("combines disasters without allowing negative production capacity", () => {
    expect(combinedCapacityMultiplierBp([2_500, 3_000])).toBe(4_500);
    expect(combinedCapacityMultiplierBp([7_500, 7_500])).toBe(0);
    expect(scaleCapacity(12, 7_500)).toBe(9);
    expect(scaleCapacity(1, 9_999)).toBe(0);
  });

  it("rejects unbounded or nonsensical rule inputs", () => {
    expect(() => changedReferencePrice(money("100"), -10_000)).toThrow(/above -10000/);
    expect(() => combinedCapacityMultiplierBp([10_001])).toThrow(/outside/);
    expect(() => scaleMoneyByBasisPoints(money("1"), -1)).toThrow(/cannot be negative/);
  });
});
