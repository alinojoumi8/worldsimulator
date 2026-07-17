import { describe, expect, it } from "vitest";
import {
  conversationDetailResponseSchema,
  conversationListQuerySchema,
  errorListQuerySchema,
  llmCallListQuerySchema,
  llmCallTelemetryItemSchema,
} from "./observability-api";

describe("WS-608 observability API contracts", () => {
  it("coerces bounded list queries and rejects reversed tick windows", () => {
    expect(llmCallListQuerySchema.parse({ limit: "25", fromTick: "2", toTick: "8" }))
      .toMatchObject({ limit: 25, fromTick: 2, toTick: 8 });
    expect(errorListQuerySchema.parse({ kind: "schema" })).toMatchObject({
      limit: 50,
      kind: "schema",
    });
    expect(() => conversationListQuerySchema.parse({ fromTick: "9", toTick: "8" }))
      .toThrow();
  });

  it("requires exact per-call latency and cost telemetry", () => {
    const item = {
      id: "llm_00000001",
      decisionId: "dec_00000001",
      agent: { id: "agt_00000001", name: "Ada Reed" },
      tick: 4,
      moduleId: "conversations",
      purpose: "conversation.message",
      requestedTier: 3,
      effectiveTier: 3,
      provider: "anthropic",
      model: "claude-test",
      promptPackKey: "conversation.message",
      promptVersion: 1,
      promptHash: "a".repeat(64),
      schemaKey: "conversation.message@1",
      schemaVersion: 1,
      requestHash: "b".repeat(64),
      status: "success",
      fallbackReason: null,
      providerErrorCode: null,
      detail: null,
      cached: false,
      attempts: 1,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 24,
      latencyMs: 87,
      costMicrocents: "4321",
      costCentsEstimate: "1",
      sourceEventId: "evt_00000001",
    };
    expect(llmCallTelemetryItemSchema.parse(item)).toEqual(item);
    expect(() => llmCallTelemetryItemSchema.parse({ ...item, latencyMs: -1 })).toThrow();
    expect(() => llmCallTelemetryItemSchema.parse({ ...item, costMicrocents: "1.2" }))
      .toThrow();
  });

  it("keeps transcript text inert data beside authoritative structured terms", () => {
    const response = {
      conversation: {
        id: "cnv_00000001",
        participants: [
          { id: "agt_00000001", name: "Ada Reed" },
          { id: "agt_00000002", name: "Bea Moss" },
        ],
        topic: "purchase",
        status: "concluded",
        turns: 1,
        startTick: 4,
        endTick: 4,
        outcome: { kind: "agreement" },
        binding: { status: "bound", resultKind: "goods_order", rejectionReason: null },
        initiatingTriggerEventId: "evt_00000001",
        termBounds: {
          kind: "purchase",
          referenceId: "off_00000001",
          minQuantity: 1,
          maxQuantity: 2,
          minUnitPriceCents: "100",
          maxUnitPriceCents: "150",
        },
        maxTurns: 6,
        outputTokenBudget: 4096,
        outputTokensUsed: 12,
        closeReason: "agreement",
        sourceEventId: "evt_00000002",
      },
      messages: [{
        id: "msg_00000001",
        turn: 1,
        sender: { id: "agt_00000001", name: "Ada Reed" },
        recipient: { id: "agt_00000002", name: "Bea Moss" },
        kind: "offer",
        content: "<img src=x onerror=alert(1)>",
        structuredTerms: {
          kind: "purchase",
          referenceId: "off_00000001",
          quantity: 1,
          unitPriceCents: "125",
        },
        tick: 4,
        deliveryTick: 5,
        decisionId: "dec_00000001",
        llmCallId: "llm_00000001",
        outputTokens: 12,
        sourceEventId: "evt_00000003",
      }],
      outcome: {
        kind: "agreement",
        structuredTerms: {
          kind: "purchase",
          referenceId: "off_00000001",
          quantity: 1,
          unitPriceCents: "125",
        },
        extractedBy: "tier2",
        rationale: "Exact acceptance.",
        decisionId: "dec_00000002",
        llmCallId: "llm_00000002",
      },
      binding: {
        id: "cnb_00000001",
        runId: "run_00000001",
        conversationId: "cnv_00000001",
        topic: "purchase",
        status: "bound",
        structuredTerms: {
          kind: "purchase",
          referenceId: "off_00000001",
          quantity: 1,
          unitPriceCents: "125",
        },
        domainReferenceId: "off_00000001",
        resultKind: "goods_order",
        resultId: "ord_00000001",
        rejectionReason: null,
        bindingTick: 4,
        evidenceEventIds: ["evt_00000003"],
        sourceEventId: "evt_00000003",
      },
      meta: { simulated: true, apiVersion: 1 },
    };
    expect(conversationDetailResponseSchema.parse(response).messages[0]?.content)
      .toContain("onerror");
  });
});
