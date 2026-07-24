// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldEventInjector } from "./world-event-injector";

afterEach(cleanup);

describe("WorldEventInjector", () => {
  it("submits only the selected approved catalog shape", () => {
    const onInject = vi.fn();
    render(
      <WorldEventInjector
        runId="run_00000001"
        runStatus="paused"
        pending={false}
        onInject={onInject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Schedule event" }));
    expect(onInject).toHaveBeenLastCalledWith({
      runId: "run_00000001",
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30 },
    });

    fireEvent.change(screen.getByLabelText("World event"), {
      target: { value: "market.demand_shock" },
    });
    fireEvent.change(screen.getByLabelText("Product"), {
      target: { value: "meals" },
    });
    fireEvent.change(screen.getByLabelText("Change (%)"), { target: { value: "-20" } });
    fireEvent.change(screen.getByLabelText("Duration (ticks)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule event" }));
    expect(onInject).toHaveBeenLastCalledWith({
      runId: "run_00000001",
      type: "market.demand_shock",
      params: { sku: "meals", deltaPct: -20, durationTicks: 12 },
    });
  });

  it("allows created or paused runs and exposes typed success evidence", () => {
    const { rerender } = render(
      <WorldEventInjector
        runId="run_00000001"
        runStatus="running"
        pending={false}
        onInject={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Schedule event" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText("Create or pause the run before scheduling an intervention."))
      .toBeTruthy();

    rerender(
      <WorldEventInjector
        runId="run_00000001"
        runStatus="created"
        pending={false}
        onInject={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Schedule event" }) as HTMLButtonElement).disabled)
      .toBe(false);

    rerender(
      <WorldEventInjector
        runId="run_00000001"
        runStatus="paused"
        pending={false}
        receipt={{
          worldEvent: {
            id: "wev_00000001",
            runId: "run_00000001",
            type: "energy.fuel_price_shock",
            params: { deltaPct: 30 },
            source: "admin",
            status: "scheduled",
            createdTick: 0,
            scheduledTick: 1,
            appliedTick: null,
            taskId: "task_00000001",
            commandEventId: "evt_00000001",
            injectedEventId: "evt_00000002",
            appliedEventId: null,
            effectEventIds: [],
            catalogVersion: 1,
          },
          commandEventId: "evt_00000001",
          meta: { simulated: true, apiVersion: 1 },
        }}
        onInject={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toContain("energy.fuel_price_shock scheduled for tick 1");
  });

  it("locks the guided fixture to the approved 30% fuel shock", () => {
    const onInject = vi.fn();
    render(
      <WorldEventInjector
        runId="run_00000001"
        runStatus="created"
        guided
        pending={false}
        onInject={onInject}
      />,
    );

    expect((screen.getByLabelText("World event") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Fuel price change (%)") as HTMLInputElement).readOnly)
      .toBe(true);
    expect(screen.getByText("Applied event · fuel price · CPI")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Schedule event" }));
    expect(onInject).toHaveBeenCalledWith({
      runId: "run_00000001",
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30 },
    });
  });
});
