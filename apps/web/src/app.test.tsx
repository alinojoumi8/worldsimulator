// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";

describe("WorldTangle app shell", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.pushState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
            meta: { simulated: true, apiVersion: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the real-data library with documented create defaults", async () => {
    render(<App />);
    expect(await screen.findByText("No worlds on the ledger yet.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create a simulation" })).toBeTruthy();
    expect((screen.getByLabelText("Simulation name") as HTMLInputElement).value)
      .toBe("Riverbend baseline");
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("42");
    expect((screen.getByLabelText("End tick") as HTMLInputElement).value).toBe("360");
    expect((screen.getByLabelText("LLM mode") as HTMLSelectElement).value).toBe("live");
    expect((screen.getByLabelText("Agent tokens · daily") as HTMLInputElement).value)
      .toBe("128000");
    expect(screen.getByText("Tier-2 decisions call MiniMax M3 and count against the run budget."))
      .toBeTruthy();
    expect(screen.getByText(/not financial, legal, or political advice/i)).toBeTruthy();
  });

  it("submits new Riverbend simulations in live MiniMax mode by default", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await screen.findByText("No worlds on the ledger yet.");

    fireEvent.click(screen.getByRole("button", { name: "Create Riverbend run" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      scenario: { llmMode: "live" },
    });
  });

  it("keeps the simulation disclaimer on unmatched routes", () => {
    window.history.pushState({}, "", "/not-a-worldtangle-route");
    render(<App />);
    expect(screen.getByRole("heading", { name: "This path is not part of the weave." }))
      .toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Simulation disclaimer" }).textContent)
      .toContain("Simulated scenario");
  });

  it("stores an optional API token in session storage only", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "API token" }));
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "local-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for session" }));
    expect(sessionStorage.getItem("worldtangle.api-token")).toBe("local-secret");
    expect(screen.getByRole("button", { name: "API secured" })).toBeTruthy();
  });

  it("renders finance and employment panels from the indicator API contract", async () => {
    window.history.pushState({}, "", "/simulations/sim_00000001");
    const meta = { simulated: true, apiVersion: 1 } as const;
    const spend = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCentsEstimate: "0",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      if (path.includes("/stream")) {
        return new Response("", { status: 401 });
      }
      if (path.includes("/indicators?")) {
        return new Response(JSON.stringify({
          series: [
            { name: "gdpProxy", unit: "cents", points: [[0, "50000"], [2, "75000"]] },
            { name: "cpi", unit: "index", points: [[0, 1000], [2, 1036]] },
            { name: "m1", unit: "cents", points: [[0, "100000"], [2, "125000"]] },
            { name: "averageWage", unit: "cents", points: [[0, "3000000"], [2, "3150000"]] },
            { name: "unemploymentRate", unit: "bp", points: [[0, 800], [2, 725]] },
            { name: "creditOutstanding", unit: "cents", points: [[0, "40000"], [2, "35000"]] },
            { name: "defaultRate", unit: "bp", points: [[0, 0], [2, 125]] },
            { name: "businessCount", unit: "count", points: [[0, 14], [2, 15]] },
            { name: "treasuryBalance", unit: "cents", points: [[0, "900000"], [2, "875000"]] },
            { name: "sentimentIndex", unit: "bp", points: [[0, 0], [2, -300]] },
          ],
          meta,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.includes("/events?")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null, meta }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.includes("/status")) {
        return new Response(JSON.stringify({
          run: {
            id: "run_00000001",
            status: "paused",
            currentTick: 2,
            simDate: "Y0001-M01-D03",
            endTick: 360,
          },
          tickRate: { ticksPerSec: 0 },
          llm: {
            mode: "mock",
            spend,
            budgetPct: 0,
            cacheHitRate: 0,
            enabled: true,
            effectiveTier: 3,
            autoPaused: false,
            frozenModules: [],
            limits: {
              runCostCentsMax: "1000",
              perAgentDailyTokens: 2000,
            },
          },
          errors: { last24Ticks: 0 },
          activity: {
            committedEvents: 8,
            latestEventSeq: 7,
            latestDigest: {
              v: 1,
              tick: 2,
              simDate: "Y0001-M01-D03",
              indicators: {},
              counts: {
                events: 3,
                transactions: 2,
                decisions: 1,
                llmCalls: 0,
                rejectedIntents: 0,
              },
              notable: [],
              spend: { budgetPct: 0 },
            },
          },
          task: null,
          meta,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        simulation: {
          id: "sim_00000001",
          name: "Riverbend indicator gate",
          status: "active",
          scenarioVersion: 1,
          scenario: {
            worldSpec: "riverbend-100@1",
            seed: 42,
            llmMode: "mock",
            budgets: {
              runCostCentsMax: "1000",
              perAgentDailyTokens: 2000,
            },
          },
          createdAt: "2026-07-15T00:00:00.000Z",
        },
        runs: [{
          id: "run_00000001",
          status: "paused",
          currentTick: 2,
          seed: 42,
          startedAt: "2026-07-15T00:00:00.000Z",
          endedAt: null,
          spend,
        }],
        meta,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Finance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Macro" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Employment" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Business" })).toBeTruthy();
    expect(screen.getByText("$1250.00")).toBeTruthy();
    expect(screen.getByText("$31500.00")).toBeTruthy();
    expect(screen.getByText("7.25%")).toBeTruthy();
    expect(screen.getAllByText("Through event #7")).toHaveLength(2);
    expect(screen.getByText("Latest committed tick activity · tick 2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Money supply from tick 0 through tick 2" }))
      .toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes(
        "series=gdpProxy%2Ccpi%2Cm1%2CaverageWage%2CunemploymentRate%2CcreditOutstanding%2CdefaultRate%2CbusinessCount%2CtreasuryBalance%2CsentimentIndex&max=5000",
      )
    ))).toBe(true);
    await waitFor(() => {
      const streamCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/stream"));
      expect(streamCall).toBeDefined();
      expect(new Headers(streamCall?.[1]?.headers).get("Last-Event-ID")).toBe("7");
    });
  });
});
