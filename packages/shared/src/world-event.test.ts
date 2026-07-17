import { describe, expect, it } from "vitest";
import {
  injectWorldEventRequestSchema,
  WORLD_EVENT_TYPES,
  worldEventSpecSchema,
} from "./world-event";

describe("approved world-event catalog", () => {
  it("accepts the four version-1 event shapes", () => {
    const specs = [
      { type: "energy.fuel_price_shock", params: { deltaPct: 30 } },
      { type: "row.reference_price_shift", params: { sku: "groceries", deltaPct: -10 } },
      {
        type: "market.demand_shock",
        params: { sku: "groceries", deltaPct: 20, durationTicks: 30 },
      },
      {
        type: "business.disaster",
        params: {
          companyId: "co_00000001",
          capacityReductionPct: 50,
          durationTicks: 10,
        },
      },
    ];
    expect(specs.map((spec) => worldEventSpecSchema.parse(spec).type)).toEqual(
      WORLD_EVENT_TYPES,
    );
  });

  it("rejects unknown event types and unapproved parameters", () => {
    expect(worldEventSpecSchema.safeParse({
      type: "citizen.external_tool",
      params: { connector: "email" },
    }).success).toBe(false);
    expect(injectWorldEventRequestSchema.safeParse({
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30, arbitraryFunction: "execute" },
    }).success).toBe(false);
  });

  it("enforces percentage, duration, and schedule bounds", () => {
    expect(injectWorldEventRequestSchema.safeParse({
      type: "energy.fuel_price_shock",
      params: { deltaPct: 1_001 },
    }).success).toBe(false);
    expect(injectWorldEventRequestSchema.safeParse({
      type: "market.demand_shock",
      params: { sku: "groceries", deltaPct: 20, durationTicks: 361 },
    }).success).toBe(false);
    expect(injectWorldEventRequestSchema.safeParse({
      type: "row.reference_price_shift",
      params: { sku: "groceries", deltaPct: 10 },
      scheduleTick: 0,
    }).success).toBe(false);
  });
});
