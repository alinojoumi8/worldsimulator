import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { money } from "@worldtangle/shared";
import {
  allocateCreditorWaterfall,
  assessCompanySolvency,
  inventorySalvageTotal,
  inventorySalvageUnitPrice,
} from "./insolvency-rules";

describe("WS-407 insolvency rules", () => {
  it("requires 30 consecutive daily shortfalls and resets after recovery", () => {
    let streak = 0;
    for (let day = 1; day <= 29; day++) {
      const result = assessCompanySolvency({
        cashCents: money("99"),
        obligationCents: money("100"),
        priorConsecutiveShortfallDays: streak,
      });
      streak = result.consecutiveShortfallDays;
      expect(result.insolvent).toBe(false);
    }
    expect(assessCompanySolvency({
      cashCents: money("99"),
      obligationCents: money("100"),
      priorConsecutiveShortfallDays: streak,
    })).toMatchObject({
      shortfallCents: 1n,
      consecutiveShortfallDays: 30,
      insolvent: true,
    });
    expect(assessCompanySolvency({
      cashCents: money("100"),
      obligationCents: money("100"),
      priorConsecutiveShortfallDays: 29,
    })).toMatchObject({ consecutiveShortfallDays: 0, insolvent: false });
  });

  it("uses an exact 50% ROW-reference salvage price with floor rounding", () => {
    expect(inventorySalvageUnitPrice(money("501"))).toBe(250n);
    expect(inventorySalvageTotal(money("250"), 7)).toBe(1_750n);
  });

  it("pays strict seniority and stable tie order", () => {
    expect(allocateCreditorWaterfall(money("100"), [
      { id: "clm_z", seniority: 20, registeredTick: 1, amountCents: money("60") },
      { id: "clm_b", seniority: 10, registeredTick: 1, amountCents: money("70") },
      { id: "clm_a", seniority: 10, registeredTick: 1, amountCents: money("40") },
    ])).toEqual([
      { claimId: "clm_a", recoveredCents: 40n, writtenOffCents: 0n },
      { claimId: "clm_b", recoveredCents: 60n, writtenOffCents: 10n },
      { claimId: "clm_z", recoveredCents: 0n, writtenOffCents: 60n },
    ]);
  });

  it("never allocates more than the pool or any claim", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 10_000 }),
      (amounts, pool) => {
        const claims = amounts.map((amount, index) => ({
          id: `clm_${index.toString().padStart(8, "0")}`,
          seniority: (index % 5) + 1,
          registeredTick: index % 3,
          amountCents: money(BigInt(amount)),
        }));
        const allocations = allocateCreditorWaterfall(money(BigInt(pool)), claims);
        const recovered = allocations.reduce((sum, row) => sum + row.recoveredCents, 0n);
        expect(recovered).toBeLessThanOrEqual(BigInt(pool));
        expect(allocations.every((row) => {
          const claim = claims.find((candidate) => candidate.id === row.claimId)!;
          return row.recoveredCents + row.writtenOffCents === claim.amountCents;
        })).toBe(true);
      },
    ));
  });
});
