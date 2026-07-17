// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IndicatorSparkline, formatIndicatorValue, sparklinePoints } from "./indicator-sparkline";

describe("IndicatorSparkline", () => {
  afterEach(cleanup);

  it("plots committed points in tick order and centers a constant series", () => {
    expect(sparklinePoints([[3, "500"], [1, "500"], [2, "500"]]))
      .toBe("8.00,56.00 160.00,56.00 312.00,56.00");
  });

  it("formats every indicator unit without losing large integer cents", () => {
    expect(formatIndicatorValue("900719925474099300", "cents"))
      .toBe("$9007199254740993.00");
    expect(formatIndicatorValue(725, "bp")).toBe("7.25%");
    expect(formatIndicatorValue(1_036, "index")).toBe("1036");
    expect(formatIndicatorValue(15, "count")).toBe("15");
  });

  it("renders an honest empty state", () => {
    render(
      <IndicatorSparkline
        label="Money supply"
        description="Deposits"
        tone="teal"
        series={{ name: "m1", unit: "cents", points: [] }}
      />,
    );
    expect(screen.getByText("No committed observations yet.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("labels the plotted tick range and latest authoritative value", () => {
    render(
      <IndicatorSparkline
        label="Unemployment rate"
        description="Share without active work"
        tone="rust"
        series={{ name: "unemploymentRate", unit: "bp", points: [[4, 825], [8, 750]] }}
      />,
    );
    expect(screen.getByText("7.50%")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Unemployment rate from tick 4 through tick 8" }))
      .toBeTruthy();
  });
});
