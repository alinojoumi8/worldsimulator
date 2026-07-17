/** Pure deterministic M17 tariff, billing, and fuel rules. */

import { EngineError, money, mulDiv } from "@worldtangle/shared";
import type { EnergyCustomerClass, Money } from "@worldtangle/shared";

export const ENERGY_RULESET_VERSION = 1;
export const ENERGY_BILLING_INTERVAL_TICKS = 30;
export const ENERGY_PASS_THROUGH_BP = 6_000;
export const ENERGY_MINIMUM_TARIFF_BP = 5_000;
export const ENERGY_MAXIMUM_TARIFF_BP = 20_000;
export const ENERGY_MINIMUM_FUEL_PRICE_BP = 5_000;
export const ENERGY_MAXIMUM_FUEL_PRICE_BP = 30_000;
export const ENERGY_REFERENCE_FUEL_PRICE_CENTS = money("100");
export const ENERGY_BUSINESS_BASE_TARIFF_CENTS = money("50");
export const ENERGY_HOUSEHOLD_FUEL_MILLIUNITS_PER_BILL = 100_000;
export const ENERGY_BUSINESS_FUEL_MILLIUNITS_PER_UNIT = 250;

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

function clamp(value: Money, minimum: Money, maximum: Money): Money {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function energyBillingCycleDue(
  tick: number,
  intervalTicks = ENERGY_BILLING_INTERVAL_TICKS,
): boolean {
  assertSafeInteger(tick, "tick");
  assertSafeInteger(intervalTicks, "intervalTicks", 1);
  return tick > 0 && tick % intervalTicks === 0;
}

export function nextEnergyBillingTick(
  tick: number,
  intervalTicks = ENERGY_BILLING_INTERVAL_TICKS,
): number {
  assertSafeInteger(tick, "tick");
  assertSafeInteger(intervalTicks, "intervalTicks", 1);
  const remainder = tick % intervalTicks;
  return remainder === 0 ? tick + intervalTicks : tick + intervalTicks - remainder;
}

export function energyTariffForFuelPrice(input: {
  readonly baseTariffCents: Money;
  readonly referenceFuelPriceCents: Money;
  readonly fuelPriceCents: Money;
  readonly passThroughBp?: number;
  readonly minimumTariffBp?: number;
  readonly maximumTariffBp?: number;
}): Money {
  if (input.baseTariffCents <= 0n || input.referenceFuelPriceCents <= 0n ||
    input.fuelPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "energy prices and tariffs must be positive");
  }
  const passThroughBp = input.passThroughBp ?? ENERGY_PASS_THROUGH_BP;
  const minimumTariffBp = input.minimumTariffBp ?? ENERGY_MINIMUM_TARIFF_BP;
  const maximumTariffBp = input.maximumTariffBp ?? ENERGY_MAXIMUM_TARIFF_BP;
  assertSafeInteger(passThroughBp, "passThroughBp");
  assertSafeInteger(minimumTariffBp, "minimumTariffBp", 1);
  assertSafeInteger(maximumTariffBp, "maximumTariffBp", 1);
  if (passThroughBp > 10_000 || minimumTariffBp > maximumTariffBp) {
    throw new EngineError("VALIDATION_FAILED", "invalid energy tariff rule bounds");
  }
  const fuelDeltaCents = input.fuelPriceCents - input.referenceFuelPriceCents;
  const adjustment = mulDiv(
    input.baseTariffCents,
    fuelDeltaCents * BigInt(passThroughBp),
    input.referenceFuelPriceCents * 10_000n,
    "HALF_EVEN",
  );
  const roundedMinimum = mulDiv(
    input.baseTariffCents,
    BigInt(minimumTariffBp),
    10_000n,
    "CEIL",
  );
  const maximum = mulDiv(
    input.baseTariffCents,
    BigInt(maximumTariffBp),
    10_000n,
    "FLOOR",
  );
  const minimum = roundedMinimum > 0n ? roundedMinimum : money(1n);
  return clamp(money(input.baseTariffCents + adjustment), minimum, maximum);
}

export function changedFuelPrice(input: {
  readonly currentFuelPriceCents: Money;
  readonly referenceFuelPriceCents: Money;
  readonly changeBp: number;
  readonly minimumFuelPriceBp?: number;
  readonly maximumFuelPriceBp?: number;
}): Money {
  if (input.currentFuelPriceCents <= 0n || input.referenceFuelPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "fuel prices must be positive");
  }
  if (!Number.isSafeInteger(input.changeBp) || input.changeBp <= -10_000) {
    throw new EngineError("VALIDATION_FAILED", "fuel-price change must be above -10000 bp");
  }
  const minimumFuelPriceBp = input.minimumFuelPriceBp ?? ENERGY_MINIMUM_FUEL_PRICE_BP;
  const maximumFuelPriceBp = input.maximumFuelPriceBp ?? ENERGY_MAXIMUM_FUEL_PRICE_BP;
  assertSafeInteger(minimumFuelPriceBp, "minimumFuelPriceBp", 1);
  assertSafeInteger(maximumFuelPriceBp, "maximumFuelPriceBp", 1);
  if (minimumFuelPriceBp > maximumFuelPriceBp) {
    throw new EngineError("VALIDATION_FAILED", "invalid fuel-price bounds");
  }
  const candidate = mulDiv(
    input.currentFuelPriceCents,
    BigInt(10_000 + input.changeBp),
    10_000n,
    "HALF_EVEN",
  );
  const minimum = mulDiv(
    input.referenceFuelPriceCents,
    BigInt(minimumFuelPriceBp),
    10_000n,
    "HALF_EVEN",
  );
  const maximum = mulDiv(
    input.referenceFuelPriceCents,
    BigInt(maximumFuelPriceBp),
    10_000n,
    "HALF_EVEN",
  );
  return clamp(candidate, minimum, maximum);
}

export function energyBillTotal(unitTariffCents: Money, units: number): Money {
  if (unitTariffCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "energy tariff must be positive");
  }
  assertSafeInteger(units, "energy units", 1);
  return money(unitTariffCents * BigInt(units));
}

export function fuelMilliunitsForDelivery(
  customerClass: EnergyCustomerClass,
  units: number,
): number {
  assertSafeInteger(units, "energy units", 1);
  const perUnit = customerClass === "household"
    ? ENERGY_HOUSEHOLD_FUEL_MILLIUNITS_PER_BILL
    : ENERGY_BUSINESS_FUEL_MILLIUNITS_PER_UNIT;
  return safeNumber(BigInt(units) * BigInt(perUnit), "fuel milliunits");
}

export function fuelPurchaseTotal(fuelPriceCents: Money, fuelMilliunits: number): Money {
  if (fuelPriceCents <= 0n) {
    throw new EngineError("VALIDATION_FAILED", "fuel price must be positive");
  }
  assertSafeInteger(fuelMilliunits, "fuelMilliunits", 1);
  const total = mulDiv(fuelPriceCents, BigInt(fuelMilliunits), 1_000n, "HALF_EVEN");
  return total > 0n ? total : money(1n);
}
