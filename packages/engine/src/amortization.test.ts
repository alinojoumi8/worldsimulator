import { describe, expect, it } from "vitest";
import {
  amortizationScheduleDigest,
  generateAmortizationSchedule,
  interestForThirtyDayPeriod,
} from "./amortization";

describe("WS-503 30/360 amortization", () => {
  it("generates the exact 12-month equal-principal golden schedule", () => {
    const schedule = generateAmortizationSchedule({
      principalCents: "1200000",
      annualRateBp: 1_200,
      termMonths: 12,
      disbursedTick: 0,
    });
    expect(schedule).toHaveLength(12);
    expect(schedule[0]).toEqual({
      installmentNumber: 1,
      dueTick: 30,
      openingPrincipalCents: "1200000",
      principalDueCents: "100000",
      interestDueCents: "12000",
      totalDueCents: "112000",
    });
    expect(schedule[11]).toEqual({
      installmentNumber: 12,
      dueTick: 360,
      openingPrincipalCents: "100000",
      principalDueCents: "100000",
      interestDueCents: "1000",
      totalDueCents: "101000",
    });
    expect(schedule.reduce((sum, row) => sum + BigInt(row.principalDueCents), 0n))
      .toBe(1_200_000n);
    expect(schedule.reduce((sum, row) => sum + BigInt(row.interestDueCents), 0n))
      .toBe(78_000n);
  });

  it("assigns every division residue to the final principal row", () => {
    const schedule = generateAmortizationSchedule({
      principalCents: "100",
      annualRateBp: 0,
      termMonths: 3,
      disbursedTick: 7,
    });
    expect(schedule.map((row) => row.principalDueCents)).toEqual(["33", "33", "34"]);
    expect(schedule.map((row) => row.openingPrincipalCents)).toEqual(["100", "67", "34"]);
    expect(schedule.map((row) => row.dueTick)).toEqual([37, 67, 97]);
  });

  it("uses HALF_EVEN cents for each exact 30-day interest period", () => {
    expect(interestForThirtyDayPeriod("5", 12_000)).toBe(0n);
    expect(interestForThirtyDayPeriod("15", 12_000)).toBe(2n);
    expect(interestForThirtyDayPeriod("100000", 1_200)).toBe(1_000n);
  });

  it("is byte-stable and changes its digest when authoritative terms change", () => {
    const first = generateAmortizationSchedule({
      principalCents: "999999",
      annualRateBp: 725,
      termMonths: 36,
      disbursedTick: 4,
    });
    const second = generateAmortizationSchedule({
      principalCents: "999999",
      annualRateBp: 725,
      termMonths: 36,
      disbursedTick: 4,
    });
    const changed = generateAmortizationSchedule({
      principalCents: "999999",
      annualRateBp: 726,
      termMonths: 36,
      disbursedTick: 4,
    });
    expect(amortizationScheduleDigest(first)).toBe(amortizationScheduleDigest(second));
    expect(amortizationScheduleDigest(first)).not.toBe(amortizationScheduleDigest(changed));
  });

  it("preserves exact principal and monotonic due ticks across bounded terms", () => {
    const principals = ["1", "17", "999", "1000000", "999999999999"];
    const terms = [1, 2, 7, 12, 36, 120, 360];
    for (const principal of principals) {
      for (const termMonths of terms) {
        const schedule = generateAmortizationSchedule({
          principalCents: principal,
          annualRateBp: 937,
          termMonths,
          disbursedTick: 123,
        });
        expect(schedule).toHaveLength(termMonths);
        expect(schedule.reduce((sum, row) => sum + BigInt(row.principalDueCents), 0n))
          .toBe(BigInt(principal));
        expect(schedule.at(-1)?.dueTick).toBe(123 + termMonths * 30);
        for (let index = 1; index < schedule.length; index++) {
          expect(schedule[index]!.dueTick - schedule[index - 1]!.dueTick).toBe(30);
          expect(BigInt(schedule[index]!.openingPrincipalCents)).toBe(
            BigInt(schedule[index - 1]!.openingPrincipalCents) -
              BigInt(schedule[index - 1]!.principalDueCents),
          );
        }
      }
    }
  });
});
