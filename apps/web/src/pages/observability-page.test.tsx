// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  errorListResponseSchema,
  llmCallListResponseSchema,
  simulationStatusResponseSchema,
} from "@worldtangle/shared";
import { ConversationTranscript, ObservabilityDashboard } from "./observability-page";

const meta = { simulated: true, apiVersion: 1 } as const;

const status = simulationStatusResponseSchema.parse({
  run: { id: "run_00000001", status: "paused", currentTick: 8, simDate: "Y0001-M01-D09", endTick: 360 },
  tickRate: { ticksPerSec: 0 },
  llm: {
    mode: "mock",
    spend: {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 24,
      costCentsEstimate: "25",
    },
    budgetPct: 25,
    cacheHitRate: 0.5,
    enabled: true,
    effectiveTier: 2,
    autoPaused: false,
    frozenModules: ["news"],
    limits: { runCostCentsMax: "100", perAgentDailyTokens: 2_000 },
  },
  errors: { last24Ticks: 2 },
  activity: { committedEvents: 12, latestEventSeq: 11, latestDigest: null },
  task: null,
  meta,
});

const callItem = {
  id: "llm_00000001",
  decisionId: "dec_00000001",
  agent: { id: "agt_00000001", name: "Ada Reed" },
  tick: 8,
  moduleId: "conversations" as const,
  purpose: "conversation.message",
  requestedTier: 3 as const,
  effectiveTier: 2 as const,
  provider: "anthropic",
  model: "claude-test",
  promptPackKey: "conversation.message",
  promptVersion: 1,
  promptHash: "a".repeat(64),
  schemaKey: "conversation.message@1",
  schemaVersion: 1,
  requestHash: "b".repeat(64),
  status: "fallback" as const,
  fallbackReason: "schema_invalid" as const,
  providerErrorCode: "malformed_response" as const,
  detail: "response did not match the menu",
  cached: false,
  attempts: 2,
  inputTokens: 120,
  cachedInputTokens: 20,
  outputTokens: 24,
  latencyMs: 87,
  costMicrocents: "25000000",
  costCentsEstimate: "25",
  sourceEventId: "evt_00000001",
};

const calls = llmCallListResponseSchema.parse({
  items: [callItem],
  nextCursor: null,
  totals: {
    calls: 1,
    success: 0,
    fallback: 1,
    cacheHits: 0,
    providerAttempts: 2,
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 24,
    costMicrocents: "25000000",
  },
  meta,
});

const errors = errorListResponseSchema.parse({
  items: [{
    eventId: "evt_00000001",
    seq: 4,
    at: "2026-07-15T12:00:00.000Z",
    tick: 8,
    kind: "schema",
    code: "malformed_response",
    message: "response did not match the menu",
    actor: { kind: "agent", id: "agt_00000001" },
    agent: { id: "agt_00000001", name: "Ada Reed" },
    correlationId: "dec_00000001",
    causationId: "evt_00000002",
  }],
  nextCursor: null,
  summary: {
    counts: { engine: 0, intentRejected: 1, llm: 0, schema: 1 },
    perAgent: [{ agent: { id: "agt_00000001", name: "Ada Reed" }, failures: 2 }],
    activeQuarantines: [{
      agent: { id: "agt_00000001", name: "Ada Reed" },
      quarantine: { mode: "tier1_only", untilTick: 12, consecutiveFailures: 3 },
    }],
  },
  meta,
});

const conversations = conversationListResponseSchema.parse({
  items: [{
    id: "cnv_00000001",
    participants: [
      { id: "agt_00000001", name: "Ada Reed" },
      { id: "agt_00000002", name: "Bea Moss" },
    ],
    topic: "purchase",
    status: "active",
    turns: 1,
    startTick: 8,
    endTick: null,
    outcome: null,
    binding: null,
  }],
  nextCursor: null,
  meta,
});

afterEach(cleanup);

describe("WS-608 observability UI", () => {
  it("shows budget, call receipts, error health, quarantines, and conversations", () => {
    render(
      <MemoryRouter>
        <ObservabilityDashboard
          simulationId="sim_00000001"
          status={status}
          calls={calls}
          errors={errors}
          conversations={conversations}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("progressbar", { name: "Run LLM budget used" })
      .getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("Cached input").nextElementSibling?.textContent).toBe("20");
    expect(screen.getByText("120 in (20 cached) / 24 out")).toBeTruthy();
    expect(screen.getByText("claude-test")).toBeTruthy();
    expect(screen.getByText("malformed_response")).toBeTruthy();
    expect(screen.getByText(/Tier 1 through tick 12/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ada Reed to Bea Moss/ }).getAttribute("href"))
      .toBe("/simulations/sim_00000001/observability/conversations/cnv_00000001");
  });

  it("renders hostile transcript text as inert text beside structured terms", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const detail = conversationDetailResponseSchema.parse({
      conversation: {
        ...conversations.items[0],
        initiatingTriggerEventId: "evt_00000002",
        termBounds: { kind: "purchase", referenceId: "off_00000001", minQuantity: 1, maxQuantity: 2, minUnitPriceCents: "100", maxUnitPriceCents: "150" },
        maxTurns: 6,
        outputTokenBudget: 4_096,
        outputTokensUsed: 12,
        closeReason: null,
        sourceEventId: "evt_00000003",
      },
      messages: [{
        id: "msg_00000001",
        turn: 1,
        sender: { id: "agt_00000001", name: "Ada Reed" },
        recipient: { id: "agt_00000002", name: "Bea Moss" },
        kind: "offer",
        content: hostile,
        structuredTerms: { kind: "purchase", referenceId: "off_00000001", quantity: 1, unitPriceCents: "125" },
        tick: 8,
        deliveryTick: 9,
        decisionId: "dec_00000001",
        llmCallId: "llm_00000001",
        outputTokens: 12,
        sourceEventId: "evt_00000004",
      }],
      outcome: null,
      binding: null,
      meta,
    });
    const rendered = render(<ConversationTranscript detail={detail} />);
    expect(screen.getByTestId("transcript-content").textContent).toBe(hostile);
    expect(rendered.container.querySelector("img")).toBeNull();
    expect(screen.getByText(/unitPriceCents/)).toBeTruthy();
  });
});
