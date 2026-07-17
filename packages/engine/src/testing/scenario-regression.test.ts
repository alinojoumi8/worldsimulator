import { describe, expect, it } from "vitest";
import {
  evaluateRiverbendBaseline,
  type BaselineIndicatorKey,
  type BaselineIndicatorPoint,
  type RiverbendBaselineObservation,
} from "./scenario-regression";

function series(key: BaselineIndicatorKey, valueInteger: string): BaselineIndicatorPoint[] {
  return Array.from({ length: 361 }, (_, tick) => ({ tick, key, valueInteger }));
}

function baseline(): RiverbendBaselineObservation {
  return {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    throughTick: 360,
    indicatorPoints: [
      ...series("unemployment_rate_bp", "649"),
      ...series("cpi_index", "1000"),
      ...series("treasury_balance_cents", "18000000"),
    ],
    businessFailureIds: [],
    newCompanyIds: ["co_00000001"],
    loanDefaultIds: [],
    benefitSuspensionTicks: [],
    m1: {
      complete: true,
      attributionRateBp: 10_000,
      unattributedM1DeltaCents: "0",
      grossUnattributedM1ChangeCents: "0",
    },
  };
}

describe("WS-709 Riverbend baseline envelopes", () => {
  it("accepts every inclusive INITIAL_WORLD section 9 boundary", () => {
    const input = baseline();
    const report = evaluateRiverbendBaseline({
      ...input,
      indicatorPoints: [
        ...series("unemployment_rate_bp", "300"),
        ...series("cpi_index", "1200"),
        ...series("treasury_balance_cents", "0"),
      ],
      businessFailureIds: ["co_fail_1", "co_fail_2", "co_fail_3"],
      newCompanyIds: ["co_new_1", "co_new_2", "co_new_3", "co_new_4"],
      loanDefaultIds: ["loan_1", "loan_2", "loan_3", "loan_4"],
      benefitSuspensionTicks: Array.from({ length: 30 }, (_, index) => index + 1),
    });
    expect(report.passed, JSON.stringify(report.violations)).toBe(true);
    expect(report.metrics).toMatchObject({
      businessFailures: 3,
      newCompanies: 4,
      loanDefaults: 4,
      benefitSuspensionTicks: 30,
      m1AttributionRateBp: 10_000,
    });
    expect(report.metrics.unemploymentRateBp).toMatchObject({
      pointCount: 361,
      minimum: { tick: 0, valueInteger: "300" },
      maximum: { tick: 0, valueInteger: "300" },
    });
  });

  it("fails closed on every calibrated macro boundary and evidence gap", () => {
    const input = baseline();
    const points = input.indicatorPoints.filter((point) => !(
      point.key === "unemployment_rate_bp" && point.tick === 10
    )).map((point) => {
      if (point.key === "unemployment_rate_bp" && point.tick === 20) {
        return { ...point, valueInteger: "299" };
      }
      if (point.key === "cpi_index" && point.tick === 30) {
        return { ...point, valueInteger: "1201" };
      }
      if (point.key === "treasury_balance_cents" && point.tick === 40) {
        return { ...point, valueInteger: "-1" };
      }
      return point;
    });

    const report = evaluateRiverbendBaseline({
      ...input,
      indicatorPoints: points,
      businessFailureIds: ["a", "b", "c", "d"],
      newCompanyIds: [],
      loanDefaultIds: ["1", "2", "3", "4", "5"],
      benefitSuspensionTicks: Array.from({ length: 31 }, (_, index) => index + 1),
      m1: {
        complete: false,
        attributionRateBp: 9_999,
        unattributedM1DeltaCents: "1",
        grossUnattributedM1ChangeCents: "1",
      },
    });
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      "indicator.coverage",
      "unemployment.outside_envelope",
      "cpi.outside_envelope",
      "treasury.negative",
      "metric.outside_envelope",
      "benefits.too_many_suspensions",
      "m1.incomplete_attribution",
    ]));
  });

  it("hashes equivalent evidence identically regardless of input order", () => {
    const first = baseline();
    const second = baseline();

    const left = evaluateRiverbendBaseline({
      ...first,
      newCompanyIds: ["co_00000002", "co_00000001"],
    });
    const right = evaluateRiverbendBaseline({
      ...second,
      newCompanyIds: ["co_00000001", "co_00000002"],
      indicatorPoints: [...second.indicatorPoints].reverse(),
    });
    expect(left.passed).toBe(true);
    expect(right.passed).toBe(true);
    expect(left.observationHash).toBe(right.observationHash);
    expect(left.envelopeHash).toBe(right.envelopeHash);
  });
});
