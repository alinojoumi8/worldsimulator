import { describe, expect, it } from "vitest";
import {
  conversationInboxItemSchema,
  conversationMessageSchema,
  conversationOutcomeSchema,
  conversationSchema,
  conversationTermBoundsSchema,
  openConversationInputSchema,
} from "./conversation";

const EVENT_ID = "evt_00000001";

describe("conversation contracts", () => {
  it("accepts a bounded two-party purchase conversation", () => {
    expect(openConversationInputSchema.parse({
      participantAgentIds: ["agt_00000001", "agt_00000002"],
      topic: "purchase",
      initiatingTriggerEventId: EVENT_ID,
      termBounds: {
        kind: "purchase",
        referenceId: "off_00000001",
        minQuantity: 1,
        maxQuantity: 3,
        minUnitPriceCents: "100",
        maxUnitPriceCents: "200",
      },
      maxTurns: 6,
      outputTokenBudget: 512,
      startTick: 4,
    })).toMatchObject({ maxTurns: 6, outputTokenBudget: 512 });

    expect(conversationSchema.parse({
      id: "cnv_00000001",
      runId: "run_00000001",
      participantAgentIds: ["agt_00000001", "agt_00000002"],
      topic: "purchase",
      initiatingTriggerEventId: EVENT_ID,
      termBounds: {
        kind: "purchase",
        referenceId: "off_00000001",
        minQuantity: 1,
        maxQuantity: 3,
        minUnitPriceCents: "100",
        maxUnitPriceCents: "200",
      },
      maxTurns: 6,
      outputTokenBudget: 512,
      outputTokensUsed: 0,
      turns: 0,
      status: "active",
      outcome: null,
      closeReason: null,
      startTick: 4,
      endTick: null,
      sourceEventId: EVENT_ID,
    }).status).toBe("active");
  });

  it("rejects unsafe participants, caps, bounds, and terminal state", () => {
    const base = {
      participantAgentIds: ["agt_00000001", "agt_00000002"],
      topic: "job",
      initiatingTriggerEventId: EVENT_ID,
      termBounds: {
        kind: "job",
        referenceId: "job_00000001",
        minAnnualWageCents: "4000000",
        maxAnnualWageCents: "6000000",
      },
      maxTurns: 6,
      outputTokenBudget: 512,
      startTick: 4,
    } as const;
    expect(() => openConversationInputSchema.parse({ ...base, maxTurns: 7 })).toThrow();
    expect(() => openConversationInputSchema.parse({
      ...base,
      participantAgentIds: ["agt_00000001", "agt_00000001"],
    })).toThrow();
    expect(() => conversationTermBoundsSchema.parse({
      ...base.termBounds,
      minAnnualWageCents: "7000000",
    })).toThrow();
  });

  it("requires structured terms only on binding-position messages", () => {
    const base = {
      id: "msg_00000001",
      runId: "run_00000001",
      conversationId: "cnv_00000001",
      senderAgentId: "agt_00000001",
      recipientAgentId: "agt_00000002",
      turn: 1,
      actionId: "conversation.offer.1",
      kind: "offer",
      content: "I can buy two at this price.",
      structuredTerms: {
        kind: "purchase",
        referenceId: "off_00000001",
        quantity: 2,
        unitPriceCents: "150",
      },
      tick: 4,
      deliveryTick: 5,
      decisionId: "dec_00000001",
      llmCallId: "llm_00000001",
      outputTokens: 20,
      sourceEventId: EVENT_ID,
    } as const;
    expect(conversationMessageSchema.parse(base).kind).toBe("offer");
    expect(() => conversationMessageSchema.parse({ ...base, structuredTerms: null })).toThrow();
    expect(() => conversationMessageSchema.parse({ ...base, deliveryTick: 4 })).toThrow();
    expect(() => conversationMessageSchema.parse({
      ...base,
      kind: "decline",
    })).toThrow();
  });

  it("requires evidence for extracted outcomes and next-tick inbox order", () => {
    expect(conversationOutcomeSchema.parse({
      kind: "agreement",
      structuredTerms: {
        kind: "job",
        referenceId: "job_00000001",
        annualWageCents: "5000000",
      },
      extractedBy: "tier2",
      rationale: "Both agents accepted the same terms.",
      decisionId: "dec_00000001",
      llmCallId: "llm_00000001",
    }).kind).toBe("agreement");
    expect(() => conversationOutcomeSchema.parse({
      kind: "agreement",
      structuredTerms: null,
      extractedBy: "rule",
      rationale: "invalid",
      decisionId: null,
      llmCallId: null,
    })).toThrow();
    expect(() => conversationInboxItemSchema.parse({
      runId: "run_00000001",
      conversationId: "cnv_00000001",
      messageId: "msg_00000001",
      recipientAgentId: "agt_00000002",
      deliveryTick: 5,
      deliveredTick: 4,
      readTick: null,
      sourceEventId: EVENT_ID,
    })).toThrow();
  });
});
