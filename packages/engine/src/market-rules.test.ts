import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "@worldtangle/shared";
import {
  affordableQuantity,
  assertMarketPriceWithinBounds,
  inventoryAfterProduction,
  inventoryAfterSale,
  inventorySalesRatioBasisPoints,
  linearProductionUnits,
  marketPriceBounds,
  marketPriceReviewDue,
  movingAverageUnitCost,
  postedPriceTotal,
  sortPostedPriceOfferings,
  weeklyMarketPriceAdjustment,
} from "./market-rules";

describe("production and inventory rules", () => {
  it("is linear in labor until the capacity bound", () => {
    expect(linearProductionUnits({
      activeWorkerCount: 3,
      laborHoursPerWorker: 8,
      productivityMilliunitsPerLaborHour: 1_500,
      capacityUnitsPerTick: 100,
    })).toBe(36);
    expect(linearProductionUnits({
      activeWorkerCount: 20,
      laborHoursPerWorker: 8,
      productivityMilliunitsPerLaborHour: 1_500,
      capacityUnitsPerTick: 100,
    })).toBe(100);
  });

  it("never permits a production or sale path to create negative inventory", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (current, produced) => {
        const afterProduction = inventoryAfterProduction(current, produced);
        expect(afterProduction).toBeGreaterThanOrEqual(0);
        const sold = afterProduction === 0 ? 0 : afterProduction % 97 + 1;
        const boundedSold = Math.min(sold, afterProduction);
        if (boundedSold > 0) {
          expect(inventoryAfterSale(afterProduction, boundedSold)).toBeGreaterThanOrEqual(0);
        }
        expect(() => inventoryAfterSale(afterProduction, afterProduction + 1)).toThrow(
          /exceeds available inventory/,
        );
      },
    ));
  });

  it("keeps moving-average cost integral with explicit HALF_EVEN rounding", () => {
    expect(movingAverageUnitCost({
      currentQuantity: 1,
      currentAverageUnitCostCents: money("100"),
      producedQuantity: 1,
      producedUnitCostCents: money("101"),
    })).toBe(100n);
    expect(movingAverageUnitCost({
      currentQuantity: 1,
      currentAverageUnitCostCents: money("101"),
      producedQuantity: 1,
      producedUnitCostCents: money("102"),
    })).toBe(102n);
  });
});

describe("posted-price rules", () => {
  it("quotes only whole affordable units and preserves exact cent totals", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      (budget, price) => {
        const quantity = affordableQuantity(money(BigInt(budget)), money(BigInt(price)));
        const total = quantity === 0 ? 0n : postedPriceTotal(money(BigInt(price)), quantity);
        expect(total).toBeLessThanOrEqual(BigInt(budget));
        expect(BigInt(budget) - total).toBeLessThan(BigInt(price));
      },
    ));
  });

  it("orders sellers by price and then code-unit offering ID", () => {
    expect(sortPostedPriceOfferings([
      { id: "off_b", postedPriceCents: "500" },
      { id: "off_c", postedPriceCents: "400" },
      { id: "off_a", postedPriceCents: "500" },
    ])).toEqual([
      { id: "off_c", postedPriceCents: "400" },
      { id: "off_a", postedPriceCents: "500" },
      { id: "off_b", postedPriceCents: "500" },
    ]);
  });
});

describe("weekly market pricing", () => {
  it("reviews each offering on its own seven-tick cadence", () => {
    expect(marketPriceReviewDue(6, 12)).toBe(false);
    expect(marketPriceReviewDue(6, 13)).toBe(true);
    expect(marketPriceReviewDue(6, 20)).toBe(true);
    expect(marketPriceReviewDue(6, 21)).toBe(false);
  });

  it("uses stable cost bounds and rejects founder prices outside them", () => {
    expect(marketPriceBounds(money(300n))).toEqual({
      minimumCents: 300n,
      maximumCents: 450n,
    });
    expect(marketPriceBounds(money(3n)).maximumCents).toBe(4n);
    expect(assertMarketPriceWithinBounds(money(300n), money(300n))).toBe(300n);
    expect(assertMarketPriceWithinBounds(money(450n), money(300n))).toBe(450n);
    expect(() => assertMarketPriceWithinBounds(money(299n), money(300n))).toThrow(
      /unit cost, unit cost \+ 50%/,
    );
    expect(() => assertMarketPriceWithinBounds(money(451n), money(300n))).toThrow(
      /unit cost, unit cost \+ 50%/,
    );
  });

  it("computes the inventory-to-sales ratio without floating point", () => {
    expect(inventorySalesRatioBasisPoints(5, 10)).toBe(5_000);
    expect(inventorySalesRatioBasisPoints(20, 10)).toBe(20_000);
    expect(inventorySalesRatioBasisPoints(1, 3)).toBe(3_333);
    expect(inventorySalesRatioBasisPoints(10, 0)).toBeNull();
    expect(inventorySalesRatioBasisPoints(Number.MAX_SAFE_INTEGER, 1))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    {
      name: "stockouts raise price even with excess stock",
      input: { inventoryQuantity: 100, unitsSold: 10, unfilledUnits: 1 },
      expectedPrice: 420n,
      signal: "stockout",
    },
    {
      name: "low inventory raises price",
      input: { inventoryQuantity: 4, unitsSold: 10, unfilledUnits: 0 },
      expectedPrice: 420n,
      signal: "low_inventory",
    },
    {
      name: "balanced cover holds price",
      input: { inventoryQuantity: 10, unitsSold: 10, unfilledUnits: 0 },
      expectedPrice: 400n,
      signal: "balanced",
    },
    {
      name: "excess inventory lowers price",
      input: { inventoryQuantity: 21, unitsSold: 10, unfilledUnits: 0 },
      expectedPrice: 380n,
      signal: "excess_inventory",
    },
    {
      name: "unsold inventory lowers price",
      input: { inventoryQuantity: 10, unitsSold: 0, unfilledUnits: 0 },
      expectedPrice: 380n,
      signal: "no_sales",
    },
    {
      name: "no activity holds price",
      input: { inventoryQuantity: 0, unitsSold: 0, unfilledUnits: 0 },
      expectedPrice: 400n,
      signal: "no_activity",
    },
  ])("$name", ({ input, expectedPrice, signal }) => {
    expect(weeklyMarketPriceAdjustment({
      currentPriceCents: money(400n),
      unitCostCents: money(300n),
      ...input,
    })).toMatchObject({ newPriceCents: expectedPrice, signal });
  });

  it("clamps repeated steps and legacy out-of-band prices to the cost envelope", () => {
    expect(weeklyMarketPriceAdjustment({
      currentPriceCents: money(450n),
      unitCostCents: money(300n),
      inventoryQuantity: 0,
      unitsSold: 10,
      unfilledUnits: 2,
    }).newPriceCents).toBe(450n);
    expect(weeklyMarketPriceAdjustment({
      currentPriceCents: money(300n),
      unitCostCents: money(300n),
      inventoryQuantity: 100,
      unitsSold: 0,
      unfilledUnits: 0,
    }).newPriceCents).toBe(300n);
    expect(weeklyMarketPriceAdjustment({
      currentPriceCents: money(500n),
      unitCostCents: money(300n),
      inventoryQuantity: 0,
      unitsSold: 0,
      unfilledUnits: 0,
    })).toMatchObject({ newPriceCents: 450n, signal: "bound_correction" });
  });

  it("keeps every rule result inside the exact integer cost envelope", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 2_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (cost, current, inventory, sold, unfilled) => {
        const result = weeklyMarketPriceAdjustment({
          currentPriceCents: money(BigInt(current)),
          unitCostCents: money(BigInt(cost)),
          inventoryQuantity: inventory,
          unitsSold: sold,
          unfilledUnits: unfilled,
        });
        expect(result.newPriceCents).toBeGreaterThanOrEqual(BigInt(cost));
        expect(result.newPriceCents * 2n).toBeLessThanOrEqual(BigInt(cost) * 3n);
      },
    ));
  });
});
