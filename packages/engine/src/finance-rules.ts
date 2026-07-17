/** Pure deterministic payroll, tax, benefit, and household spending rules. */

import { allocate, applyRateBp, money } from "@worldtangle/shared";
import type { Money } from "@worldtangle/shared";

export const PAY_PERIODS_PER_YEAR = 24;
export const DAYS_PER_MONTH = 30;

function partAt(total: Money, parts: number, index: number): Money {
  if (!Number.isInteger(index) || index < 0 || index >= parts) {
    throw new RangeError(`allocation index ${index} is outside 0..${parts - 1}`);
  }
  return allocate(total, Array.from({ length: parts }, () => 1n))[index]!;
}

/** Annual wage split into 24 exact semi-monthly payments. */
export function payrollGrossForPeriod(annualWageCents: Money, periodIndex: number): Money {
  return partAt(annualWageCents, PAY_PERIODS_PER_YEAR, periodIndex);
}

export interface PayrollQuote {
  readonly grossCents: Money;
  readonly withholdingCents: Money;
  readonly netCents: Money;
}

export function quotePayroll(
  annualWageCents: Money,
  periodIndex: number,
  withholdingRateBp: number,
): PayrollQuote {
  if (!Number.isInteger(withholdingRateBp) || withholdingRateBp < 0 || withholdingRateBp > 10_000) {
    throw new RangeError("withholding rate must be an integer from 0..10000 basis points");
  }
  const grossCents = payrollGrossForPeriod(annualWageCents, periodIndex);
  const withholdingCents = applyRateBp(
    grossCents,
    BigInt(withholdingRateBp),
    "HALF_EVEN",
  );
  return {
    grossCents,
    withholdingCents,
    netCents: money(grossCents - withholdingCents),
  };
}

export type HouseholdExpenseCategory = "food" | "utilities" | "rent" | "discretionary";

export interface HouseholdExpenseRequest {
  readonly category: HouseholdExpenseCategory;
  readonly requestedCents: Money;
  readonly essential: boolean;
}

export interface HouseholdExpenseAllocation extends HouseholdExpenseRequest {
  readonly approvedCents: Money;
}

const RENT_BY_TIER: Readonly<Record<"modest" | "standard" | "comfortable", Money>> = {
  modest: money("65000"),
  standard: money("90000"),
  comfortable: money("140000"),
};

/** Food/rent are daily; the flat utility tariff is due once per 30-day billing cycle. */
export function householdDailyRequests(input: {
  readonly dayOfMonth: number;
  readonly dayOfYear: number;
  readonly memberCount: number;
  readonly housingTier: "modest" | "standard" | "comfortable";
  readonly foodMonthlyPerPersonCents: Money;
  readonly utilitiesMonthlyCents: Money;
  readonly annualHouseholdIncomeCents: Money;
  readonly discretionaryPropensityBp: number;
}): readonly HouseholdExpenseRequest[] {
  const dayIndex = input.dayOfMonth - 1;
  const yearDayIndex = input.dayOfYear - 1;
  const foodMonthly = money(input.foodMonthlyPerPersonCents * BigInt(input.memberCount));
  const dailyIncome = partAt(input.annualHouseholdIncomeCents, 360, yearDayIndex);
  const requests: HouseholdExpenseRequest[] = [
    {
      category: "food",
      requestedCents: partAt(foodMonthly, DAYS_PER_MONTH, dayIndex),
      essential: true,
    },
  ];
  if (input.dayOfMonth === DAYS_PER_MONTH) {
    requests.push({
      category: "utilities",
      requestedCents: input.utilitiesMonthlyCents,
      essential: true,
    });
  }
  requests.push(
    {
      category: "rent",
      requestedCents: partAt(RENT_BY_TIER[input.housingTier], DAYS_PER_MONTH, dayIndex),
      essential: true,
    },
    {
      category: "discretionary",
      requestedCents: applyRateBp(
        dailyIncome,
        BigInt(input.discretionaryPropensityBp),
        "HALF_EVEN",
      ),
      essential: false,
    },
  );
  return requests;
}

/** Allocate available checking funds strictly in the supplied priority order. */
export function allocateHouseholdSpending(
  availableCents: Money,
  requests: readonly HouseholdExpenseRequest[],
): readonly HouseholdExpenseAllocation[] {
  let remaining = availableCents;
  return requests.map((request) => {
    const approvedCents = request.category === "utilities" && request.requestedCents > remaining
      ? money(0n)
      : request.requestedCents <= remaining
      ? request.requestedCents
      : money(remaining < 0n ? 0n : remaining);
    remaining = money(remaining - approvedCents);
    return { ...request, approvedCents };
  });
}
