// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventListResponseSchema } from "@worldtangle/shared";
import { MemoryRouter } from "react-router-dom";
import { RunHandoff } from "./run-handoff";

const meta = { simulated: true, apiVersion: 1 } as const;
const baseEvent = {
  eventId: "evt_00000001",
  type: "world.event.injected",
  schemaVersion: 1,
  simulationId: "sim_00000001",
  runId: "run_00000001",
  seq: 1,
  tick: 0,
  simDate: "Y0001-M01-D01",
  wallTime: "2026-07-24T00:00:00.000Z",
  actor: { kind: "admin", id: "api" },
  correlationId: "request:fuel-shock",
  causationId: "evt_00000000",
  payload: {
    worldEventId: "wev_00000001",
    type: "energy.fuel_price_shock",
    scheduledTick: 1,
    catalogVersion: 1,
  },
} as const;
const events = eventListResponseSchema.parse({
  items: [
    {
      ...baseEvent,
      eventId: "evt_00000004",
      type: "unrelated.observation",
      seq: 4,
      tick: 2,
      correlationId: "world-event:wev_00000001",
      causationId: "evt_00000099",
      payload: { note: "Shared correlation is not causal proof." },
    },
    {
      ...baseEvent,
      eventId: "evt_00000003",
      type: "energy.fuel_price.updated",
      seq: 3,
      tick: 1,
      correlationId: "world-event:wev_00000001",
      causationId: "evt_00000002",
      payload: { worldEventId: "wev_00000001" },
    },
    {
      ...baseEvent,
      eventId: "evt_00000002",
      type: "world.event.applied",
      seq: 2,
      tick: 1,
      correlationId: "world-event:wev_00000001",
      causationId: baseEvent.eventId,
      payload: { worldEventId: "wev_00000001", appliedTick: 1 },
    },
    baseEvent,
  ],
  nextCursor: null,
  meta,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RunHandoff", () => {
  it("computes one safe first action when no intervention exists", () => {
    render(
      <MemoryRouter>
        <RunHandoff
          simulationId="sim_00000001"
          runId="run_00000001"
          runStatus="created"
          mode="mock"
          seed="42"
          currentTick={0}
          endTick={360}
          latestEventSeq={0}
          events={[]}
          cpiObserved={false}
          guided
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Schedule the 30% fuel shock" })
      .getAttribute("href")).toBe("#intervention");
    expect(screen.getByText("Intervention pending")).toBeTruthy();
    expect(screen.getByText(/mock · simulated/i)).toBeTruthy();
  });

  it("recovers completed evidence from events and copies a reproducibility receipt", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <MemoryRouter>
        <RunHandoff
          simulationId="sim_00000001"
          runId="run_00000001"
          runStatus="paused"
          mode="mock"
          seed="42"
          currentTick={4}
          endTick={360}
          latestEventSeq={12}
          events={events.items}
          cpiObserved
          guided
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: /Open the causal record/i })
      .getAttribute("href")).toContain("correlation=world-event%3Awev_00000001");
    expect(screen.getByText("Intervention booked")).toBeTruthy();
    expect(screen.getByText("State effect booked")).toBeTruthy();
    expect(screen.getByText("CPI observation booked")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy reproducibility receipt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("Mode: mock");
    expect(writeText.mock.calls[0]?.[0]).toContain("Intervention ID: wev_00000001");
    expect(writeText.mock.calls[0]?.[0]).toContain("Catalog version: 1");
    expect(writeText.mock.calls[0]?.[0]).toContain("Causal event range: 1-3");
    expect(screen.getByRole("status").textContent).toBe("Receipt copied.");
  });

  it("hands a custom completed run to the world explorer without prescribing a shock", () => {
    render(
      <MemoryRouter>
        <RunHandoff
          simulationId="sim_00000001"
          runId="run_00000001"
          runStatus="completed"
          mode="mock"
          seed="42"
          currentTick={360}
          endTick={360}
          latestEventSeq={1_992}
          events={[]}
          cpiObserved={false}
          guided={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Review the completed world's evidence")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Explore the completed world" })
      .getAttribute("href")).toBe("/simulations/sim_00000001/world/companies");
    expect(screen.getByText("No intervention scheduled")).toBeTruthy();
    expect(screen.queryByText("Schedule the approved intervention")).toBeNull();
  });
});
