// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventListResponseSchema,
  newsListResponseSchema,
  newsStoryDetailResponseSchema,
  replayRunSchema,
  simulationDetailResponseSchema,
  transactionListResponseSchema,
} from "@worldtangle/shared";
import {
  buildCauseChain,
  CausalityExplorer,
  NewsFeed,
  ReplayStepper,
} from "./news-explorer-page";

const meta = { simulated: true, apiVersion: 1 } as const;
const rootEvent = {
  eventId: "evt_00000001",
  type: "admin.command.received",
  schemaVersion: 1,
  simulationId: "sim_00000001",
  runId: "run_00000001",
  seq: 1,
  tick: 0,
  simDate: "Y0001-M01-D01",
  wallTime: "2026-07-16T00:00:00.000Z",
  actor: { kind: "admin", id: "api" },
  correlationId: "formation-1",
  payload: { command: "create" },
} as const;
const childEvent = {
  ...rootEvent,
  eventId: "evt_00000002",
  type: "company.activated",
  seq: 2,
  tick: 1,
  simDate: "Y0001-M01-D02",
  actor: { kind: "institution", id: "co_00000001" },
  causationId: rootEvent.eventId,
  payload: { companyId: "co_00000001" },
} as const;

const news = newsListResponseSchema.parse({
  items: [{
    id: "nws_00000001",
    tick: 2,
    sourceTick: 1,
    headline: "A company joins Riverbend",
    topic: "economy",
    stance: 1,
    reach: 80,
    author: { id: "agt_00000001", name: "Ada Reed" },
    org: { id: "norg_00000001", name: "Riverbend Ledger" },
    citedEventIds: [childEvent.eventId],
    sourceEventId: "evt_00000003",
  }],
  nextCursor: null,
  sentiment: [
    { topic: "economy", points: [[2, 120]] },
    { topic: "employment", points: [] },
    { topic: "institutions", points: [[2, -20]] },
  ],
  meta,
});

const hostileBody = "<img src=x onerror=alert(1)>";
const storyDetail = newsStoryDetailResponseSchema.parse({
  story: {
    id: "nws_00000001",
    tick: 2,
    sourceTick: 1,
    headline: "A company joins Riverbend",
    body: hostileBody,
    topic: "economy",
    stance: 1,
    reach: 80,
    entities: ["co_00000001"],
    author: { id: "agt_00000001", name: "Ada Reed" },
    org: { id: "norg_00000001", name: "Riverbend Ledger" },
    citedEventIds: [childEvent.eventId],
    decisionId: "dec_00000001",
    sourceEventId: "evt_00000003",
  },
  citedEvents: [{
    eventId: childEvent.eventId,
    eventFactHash: "a".repeat(64),
    eventType: childEvent.type,
    tick: childEvent.tick,
    simDate: childEvent.simDate,
    actor: childEvent.actor,
    correlationId: childEvent.correlationId,
    causationId: childEvent.causationId,
    payload: childEvent.payload,
  }],
  sentimentImpact: [{
    topic: "economy",
    delta: 110,
    stanceDelta: 100,
    outcomeDelta: 10,
    sourceEventId: "evt_00000004",
  }],
  meta,
});

const events = eventListResponseSchema.parse({
  items: [childEvent, rootEvent],
  nextCursor: null,
  meta,
});

const transactions = transactionListResponseSchema.parse({
  items: [{
    id: "txn_00000001",
    tick: 1,
    kind: "purchase",
    legs: [
      { accountId: "acct_00000001", owner: { kind: "agent", id: "agt_00000001", name: "Ada Reed" }, direction: "debit", amount: "125" },
      { accountId: "acct_00000002", owner: { kind: "company", id: "co_00000001", name: "River Cafe" }, direction: "credit", amount: "125" },
    ],
    reason: "meal purchase",
    actor: { kind: "agent", id: "agt_00000001" },
    sourceEventId: childEvent.eventId,
    correlationId: childEvent.correlationId,
  }],
  nextCursor: null,
  meta,
});

afterEach(cleanup);

describe("WS-707 news and causality UI", () => {
  it("opens a cited why-panel in one click and keeps hostile story text inert", () => {
    const openStory = vi.fn();
    const trace = vi.fn();
    const rendered = render(
      <NewsFeed
        news={news}
        selectedStoryId="nws_00000001"
        detail={storyDetail}
        onOpenStory={openStory}
        onTraceEvent={trace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Why this story?" }));
    expect(openStory).toHaveBeenCalledWith("nws_00000001");
    expect(screen.getByTestId("story-body").textContent).toBe(hostileBody);
    expect(rendered.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: /economy sentiment from tick 2 through tick 2/i }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Trace ${childEvent.eventId}` }));
    expect(trace).toHaveBeenCalledWith(
      childEvent.eventId,
      childEvent.correlationId,
      childEvent.type,
    );
  });

  it("builds the stored parent chain and exposes Why on both ledgers", () => {
    expect(buildCauseChain(events.items, childEvent.eventId).map((event) => event.eventId))
      .toEqual([rootEvent.eventId, childEvent.eventId]);
    const select = vi.fn();
    render(
      <CausalityExplorer
        events={events}
        transactions={transactions}
        selection={{
          kind: "event",
          id: childEvent.eventId,
          eventId: childEvent.eventId,
          correlationId: childEvent.correlationId,
          label: childEvent.type,
        }}
        causeEvents={events.items}
        onSelect={select}
      />,
    );
    expect(screen.getAllByText("Admin / Command / Received")).toHaveLength(2);
    expect(screen.getAllByText("Company / Activated")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "Transactions" }));
    fireEvent.click(screen.getByRole("button", { name: "Why?" }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      kind: "transaction",
      id: "txn_00000001",
      eventId: childEvent.eventId,
    }));
  });

  it("steps a bounded replay target and displays cache-only progress", () => {
    const simulation = simulationDetailResponseSchema.parse({
      simulation: {
        id: "sim_00000001",
        name: "Riverbend",
        status: "active",
        scenarioVersion: 1,
        scenario: {},
        createdAt: "2026-07-16T00:00:00.000Z",
      },
      runs: [{
        id: "run_00000001",
        status: "completed",
        currentTick: 12,
        seed: 42,
        startedAt: "2026-07-16T00:00:00.000Z",
        endedAt: "2026-07-16T01:00:00.000Z",
        spend: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCentsEstimate: "0" },
      }],
      meta,
    });
    const replay = replayRunSchema.parse({
      id: "run_00000002",
      replayOf: "run_00000001",
      sourceSimulationId: "sim_00000001",
      mode: "strict",
      toTick: 12,
      status: "running",
      currentTick: 4,
      lastComparedSeq: 79,
      divergenceCount: 0,
      firstDivergence: null,
      sourceStateHash: null,
      replayStateHash: null,
      cacheArtifactDigest: "a".repeat(64),
      journalDigest: "b".repeat(64),
      startedWall: "2026-07-16T02:00:00.000Z",
      completedWall: null,
      errorCode: null,
      errorMessage: null,
    });
    const start = vi.fn();
    const rendered = render(
      <ReplayStepper
        runs={simulation.runs}
        pending={false}
        onStart={start}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous target tick" }));
    fireEvent.click(screen.getByRole("button", { name: "Start strict replay" }));
    expect(start).toHaveBeenCalledWith("run_00000001", 11, "strict");
    rendered.rerender(
      <ReplayStepper
        runs={simulation.runs}
        activeReplay={replay}
        pending={false}
        onStart={start}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Replay progress" }).getAttribute("aria-valuenow"))
      .toBe("4");
    expect(screen.getByText("80 event prefixes compared")).toBeTruthy();
  });
});
