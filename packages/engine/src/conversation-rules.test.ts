import { describe, expect, it } from "vitest";
import { canonicalStringify, type Conversation, type ConversationMessage } from "@worldtangle/shared";
import {
  conversationHasNoProgress,
  conversationMessageOptions,
  conversationOutcomeOptions,
  conversationRelationshipStrength,
  conversationTermCandidates,
  deterministicConversationOutcome,
  nextConversationSpeaker,
  planConversationClose,
  resolveConversationMessageProposal,
  resolveConversationOutcomeProposal,
  termsWithinConversationBounds,
} from "./conversation-rules";

const conversation: Conversation = {
  id: "cnv_00000001",
  runId: "run_00000001",
  participantAgentIds: ["agt_00000001", "agt_00000002"],
  topic: "purchase",
  initiatingTriggerEventId: "evt_00000001",
  termBounds: {
    kind: "purchase",
    referenceId: "off_00000001",
    minQuantity: 1,
    maxQuantity: 3,
    minUnitPriceCents: "100",
    maxUnitPriceCents: "200",
  },
  maxTurns: 6,
  outputTokenBudget: 100,
  outputTokensUsed: 0,
  turns: 0,
  status: "active",
  outcome: null,
  closeReason: null,
  startTick: 1,
  endTick: null,
  sourceEventId: "evt_00000002",
};

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "msg_00000001",
    runId: conversation.runId,
    conversationId: conversation.id,
    senderAgentId: conversation.participantAgentIds[0]!,
    recipientAgentId: conversation.participantAgentIds[1]!,
    turn: 1,
    actionId: "conversation.offer.1",
    kind: "offer",
    content: "Bounded offer.",
    structuredTerms: {
      kind: "purchase",
      referenceId: "off_00000001",
      quantity: 2,
      unitPriceCents: "150",
    },
    tick: 2,
    deliveryTick: 3,
    decisionId: "dec_00000001",
    llmCallId: "llm_00000001",
    outputTokens: 10,
    sourceEventId: "evt_00000003",
    ...overrides,
  };
}

describe("bounded conversation rules", () => {
  it("generates only distinct in-bounds term candidates", () => {
    const candidates = conversationTermCandidates(conversation.termBounds);
    expect(candidates).toHaveLength(3);
    expect(candidates.every((terms) =>
      termsWithinConversationBounds(conversation.termBounds, terms)
    )).toBe(true);
    expect(new Set(candidates.map(canonicalStringify))).toHaveLength(3);
    expect(termsWithinConversationBounds(conversation.termBounds, {
      kind: "purchase",
      referenceId: "off_00000001",
      quantity: 4,
      unitPriceCents: "150",
    })).toBe(false);
  });

  it("alternates speakers and accepts only exact engine-menu params", () => {
    const firstOptions = conversationMessageOptions(conversation, []);
    expect(nextConversationSpeaker(conversation, [])).toBe("agt_00000001");
    const selected = firstOptions.find((option) => option.actionId === "conversation.offer.1")!;
    expect(resolveConversationMessageProposal({
      actionId: selected.actionId,
      params: selected.params,
      rationale: "This text is non-binding.",
    }, firstOptions)).toMatchObject({ kind: "offer", content: "This text is non-binding." });
    expect(() => resolveConversationMessageProposal({
      actionId: selected.actionId,
      params: { ...selected.params, structuredTerms: {
        kind: "purchase",
        referenceId: "off_00000001",
        quantity: 999,
        unitPriceCents: "1",
      } },
      rationale: "forged",
    }, firstOptions)).toThrow("not in the offered menu");

    const first = message();
    const afterFirst = { ...conversation, turns: 1 };
    expect(nextConversationSpeaker(afterFirst, [first])).toBe("agt_00000002");
    expect(conversationMessageOptions(afterFirst, [first]).some((option) =>
      option.actionId === "conversation.accept"
    )).toBe(true);
  });

  it("detects repeated same-sender terms without mistaking acceptance for a loop", () => {
    const first = message();
    const reply = message({
      id: "msg_00000002",
      senderAgentId: "agt_00000002",
      recipientAgentId: "agt_00000001",
      turn: 2,
      tick: 3,
      deliveryTick: 4,
      decisionId: "dec_00000002",
      llmCallId: "llm_00000002",
      sourceEventId: "evt_00000004",
    });
    expect(conversationHasNoProgress(
      "agt_00000002",
      reply.structuredTerms,
      [first],
    )).toBe(false);
    expect(conversationHasNoProgress(
      "agt_00000001",
      first.structuredTerms,
      [first, reply],
    )).toBe(true);
  });

  it("hard-closes on acceptance, output budget, turn cap, and no progress", () => {
    const first = message();
    const active = { ...conversation, turns: 1 };
    const options = conversationMessageOptions(active, [first]);
    const acceptOption = options.find((option) => option.actionId === "conversation.accept")!;
    const proposal = resolveConversationMessageProposal({
      actionId: acceptOption.actionId,
      params: acceptOption.params,
      rationale: "Accepted.",
    }, options);
    expect(planConversationClose({
      conversation: active,
      messages: [first],
      senderAgentId: "agt_00000002",
      proposal,
      outputTokens: 5,
    })).toMatchObject({ acceptMessage: true, closeReason: "agreement" });
    expect(planConversationClose({
      conversation: { ...active, outputTokensUsed: 99 },
      messages: [first],
      senderAgentId: "agt_00000002",
      proposal: { ...proposal, kind: "clarify", structuredTerms: null },
      outputTokens: 2,
    })).toEqual({ acceptMessage: false, closeReason: "token_budget", acceptedTerms: null });
  });

  it("extracts only offered outcomes and bounds relationship changes", () => {
    const terms = message().structuredTerms!;
    const options = conversationOutcomeOptions(conversation, "agreement", terms);
    const agreement = options.find((option) => option.actionId === "conversation.outcome.agreement")!;
    expect(resolveConversationOutcomeProposal({
      actionId: agreement.actionId,
      params: agreement.params,
      rationale: "Exact terms were accepted.",
    }, options)).toMatchObject({ kind: "agreement", structuredTerms: terms });
    expect(deterministicConversationOutcome(
      "provider_fallback",
      null,
      "Provider failed closed.",
    )).toMatchObject({ kind: "no_agreement", extractedBy: "rule" });
    expect(conversationRelationshipStrength({ type: "friend", strength: 100 }, "agreement"))
      .toBe(100);
    expect(conversationRelationshipStrength({ type: "adversary", strength: -1 }, "agreement"))
      .toBe(-1);
    expect(conversationRelationshipStrength({ type: "business", strength: 1 }, "escalate"))
      .toBe(0);
  });
});
