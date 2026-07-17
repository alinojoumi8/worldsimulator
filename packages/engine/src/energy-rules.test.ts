import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "@worldtangle/shared";
import {
  changedFuelPrice,
  energyBillTotal,
  energyBillingCycleDue,
  energyTariffForFuelPrice,
  fuelMilliunitsForDelivery,
  fuelPurchaseTotal,
  nextEnergyBillingTick,
} from "./energy-rules";

describe("energy tariff pass-through", () => {
  it("applies a bounded 60% pass-through at the next 30-tick cycle", () => {
    const shockedFuel = changedFuelPrice({
      currentFuelPriceCents: money("100"),
      referenceFuelPriceCents: money("100"),
      changeBp: 3_000,
    });
    expect(shockedFuel).toBe(130n);
    expect(energyTariffForFuelPrice({
      baseTariffCents: money("15000"),
      referenceFuelPriceCents: money("100"),
      fuelPriceCents: shockedFuel,
    })).toBe(17_700n);
    expect(energyTariffForFuelPrice({
      baseTariffCents: money("50"),
      referenceFuelPriceCents: money("100"),
      fuelPriceCents: shockedFuel,
    })).toBe(59n);
    expect(energyBillingCycleDue(29)).toBe(false);
    expect(energyBillingCycleDue(30)).toBe(true);
    expect(nextEnergyBillingTick(5)).toBe(30);
    expect(nextEnergyBillingTick(30)).toBe(60);
  });

  it("clamps extreme shocks to the configured fuel and tariff envelopes", () => {
    expect(changedFuelPrice({
      currentFuelPriceCents: money("100"),
      referenceFuelPriceCents: money("100"),
      changeBp: 100_000,
    })).toBe(300n);
    expect(energyTariffForFuelPrice({
      baseTariffCents: money("15000"),
      referenceFuelPriceCents: money("100"),
      fuelPriceCents: money("10000"),
    })).toBe(30_000n);
    expect(energyTariffForFuelPrice({
      baseTariffCents: money("15000"),
      referenceFuelPriceCents: money("100"),
      fuelPriceCents: money("1"),
    })).toBe(7_500n);
  });

  it("keeps tariff results inside exact integer bounds for every price", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 3_000_000 }),
      (base, reference, fuel) => {
        const tariff = energyTariffForFuelPrice({
          baseTariffCents: money(BigInt(base)),
          referenceFuelPriceCents: money(BigInt(reference)),
          fuelPriceCents: money(BigInt(fuel)),
        });
        expect(tariff * 2n).toBeGreaterThanOrEqual(BigInt(base));
        expect(tariff).toBeLessThanOrEqual(BigInt(base) * 2n);
      },
    ));
  });
});

describe("energy billing and fuel rules", () => {
  it("quotes exact business bills and corresponding fuel purchases", () => {
    expect(energyBillTotal(money("50"), 40)).toBe(2_000n);
    expect(fuelMilliunitsForDelivery("business", 40)).toBe(10_000);
    expect(fuelPurchaseTotal(money("100"), 10_000)).toBe(1_000n);
    expect(fuelMilliunitsForDelivery("household", 1)).toBe(100_000);
    expect(fuelPurchaseTotal(money("100"), 100_000)).toBe(10_000n);
  });
});
