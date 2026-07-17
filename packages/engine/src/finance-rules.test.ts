import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "@worldtangle/shared";
import {
  allocateHouseholdSpending,
  householdDailyRequests,
  payrollGrossForPeriod,
  quotePayroll,
} from "./finance-rules";

describe("payroll and withholding rules", () => {
  it("allocates every annual wage exactly across 24 periods", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 100_000_000 }),
      (annual) => {
        const payments = Array.from(
          { length: 24 },
          (_, index) => payrollGrossForPeriod(money(BigInt(annual)), index),
        );
        expect(payments.reduce((sum, payment) => sum + payment, 0n)).toBe(BigInt(annual));
      },
    ));
  });

  it("uses HALF_EVEN tax math and keeps gross equal to withholding plus net", () => {
    expect(quotePayroll(money("100"), 0, 50)).toEqual({
      grossCents: 5n,
      withholdingCents: 0n,
      netCents: 5n,
    });
    fc.assert(fc.property(
      fc.integer({ min: 24, max: 100_000_000 }),
      fc.integer({ min: 0, max: 10_000 }),
      (annual, rate) => {
        const quote = quotePayroll(money(BigInt(annual)), 0, rate);
        expect(quote.netCents + quote.withholdingCents).toBe(quote.grossCents);
      },
    ));
  });
});

describe("household spending rules", () => {
  it("prioritizes essentials and never approves more than available", () => {
    const requests = householdDailyRequests({
      dayOfMonth: 1,
      dayOfYear: 1,
      memberCount: 2,
      housingTier: "standard",
      foodMonthlyPerPersonCents: money("30000"),
      utilitiesMonthlyCents: money("15000"),
      annualHouseholdIncomeCents: money("7200000"),
      discretionaryPropensityBp: 2_000,
    });
    const allocations = allocateHouseholdSpending(money("2200"), requests);
    expect(allocations.map((allocation) => allocation.category)).toEqual([
      "food",
      "rent",
      "discretionary",
    ]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.approvedCents, 0n))
      .toBeLessThanOrEqual(2_200n);
    expect(allocations.at(-1)?.approvedCents).toBe(0n);
  });

  it("charges the flat utility tariff once per cycle and rejects partial payment", () => {
    const requests = householdDailyRequests({
      dayOfMonth: 30,
      dayOfYear: 30,
      memberCount: 1,
      housingTier: "modest",
      foodMonthlyPerPersonCents: money("30000"),
      utilitiesMonthlyCents: money("15000"),
      annualHouseholdIncomeCents: money("3600000"),
      discretionaryPropensityBp: 1_000,
    });
    expect(requests.map((request) => request.category)).toEqual([
      "food",
      "utilities",
      "rent",
      "discretionary",
    ]);
    const utility = allocateHouseholdSpending(money("14999"), [requests[1]!])[0]!;
    expect(utility.approvedCents).toBe(0n);
  });
});
