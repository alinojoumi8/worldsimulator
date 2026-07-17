import { z } from "zod";
import { agentIdSchema } from "./agent";
import { decisionIdSchema } from "./decision";
import { llmCallIdSchema } from "./llm-call";
import { runIdSchema } from "./simulation";

export const MAX_CONVERSATION_TURNS = 6;
export const MAX_CONVERSATION_OUTPUT_TOKENS = 4_096;
export const MAX_CONVERSATIONS_PER_AGENT_PER_TICK = 1;
export const CONVERSATION_TOPIC_COOLDOWN_TICKS = 7;

export const conversationIdSchema = z.string().regex(/^cnv_[0-9a-z]{8,}$/);
export const conversationMessageIdSchema = z.string().regex(/^msg_[0-9a-z]{8,}$/);
export const conversationTopicSchema = z.enum(["purchase", "job"]);
export const conversationStatusSchema = z.enum([
  "active",
  "concluded",
  "expired",
  "force_closed",
]);
export const conversationCloseReasonSchema = z.enum([
  "agreement",
  "declined",
  "max_turns",
  "token_budget",
  "no_progress",
  "provider_fallback",
  "invalid_proposal",
]);
export const conversationOutcomeKindSchema = z.enum([
  "agreement",
  "no_agreement",
  "escalate",
]);
export const conversationMessageKindSchema = z.enum([
  "offer",
  "counter",
  "accept",
  "decline",
  "clarify",
]);

const referenceIdSchema = z.string().trim().min(1).max(160);
const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

const purchaseTermBoundsShape = z.object({
  kind: z.literal("purchase"),
  referenceId: referenceIdSchema,
  minQuantity: z.number().int().min(1).max(1_000_000).safe(),
  maxQuantity: z.number().int().min(1).max(1_000_000).safe(),
  minUnitPriceCents: positiveCentsSchema,
  maxUnitPriceCents: positiveCentsSchema,
}).strict();

const jobTermBoundsShape = z.object({
  kind: z.literal("job"),
  referenceId: referenceIdSchema,
  minAnnualWageCents: positiveCentsSchema,
  maxAnnualWageCents: positiveCentsSchema,
}).strict();

export const conversationTermBoundsSchema = z.discriminatedUnion("kind", [
  purchaseTermBoundsShape,
  jobTermBoundsShape,
]).superRefine((bounds, ctx) => {
  if (bounds.kind === "purchase") {
    if (bounds.minQuantity > bounds.maxQuantity) {
      ctx.addIssue({
        code: "custom",
        path: ["maxQuantity"],
        message: "maximum quantity must be at least the minimum",
      });
    }
    if (BigInt(bounds.minUnitPriceCents) > BigInt(bounds.maxUnitPriceCents)) {
      ctx.addIssue({
        code: "custom",
        path: ["maxUnitPriceCents"],
        message: "maximum unit price must be at least the minimum",
      });
    }
  } else if (BigInt(bounds.minAnnualWageCents) > BigInt(bounds.maxAnnualWageCents)) {
    ctx.addIssue({
      code: "custom",
      path: ["maxAnnualWageCents"],
      message: "maximum annual wage must be at least the minimum",
    });
  }
});

export const purchaseStructuredTermsSchema = z.object({
  kind: z.literal("purchase"),
  referenceId: referenceIdSchema,
  quantity: z.number().int().min(1).max(1_000_000).safe(),
  unitPriceCents: positiveCentsSchema,
}).strict();

export const jobStructuredTermsSchema = z.object({
  kind: z.literal("job"),
  referenceId: referenceIdSchema,
  annualWageCents: positiveCentsSchema,
}).strict();

export const conversationStructuredTermsSchema = z.discriminatedUnion("kind", [
  purchaseStructuredTermsSchema,
  jobStructuredTermsSchema,
]);

export const conversationOutcomeSchema = z.object({
  kind: conversationOutcomeKindSchema,
  structuredTerms: conversationStructuredTermsSchema.nullable(),
  extractedBy: z.enum(["tier2", "rule"]),
  rationale: z.string().trim().min(1).max(2_000),
  decisionId: decisionIdSchema.nullable(),
  llmCallId: llmCallIdSchema.nullable(),
}).strict().superRefine((outcome, ctx) => {
  if (outcome.kind === "agreement" && outcome.structuredTerms === null) {
    ctx.addIssue({
      code: "custom",
      path: ["structuredTerms"],
      message: "agreement requires structured terms",
    });
  }
  if (outcome.kind !== "agreement" && outcome.structuredTerms !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["structuredTerms"],
      message: "only an agreement may carry structured terms",
    });
  }
  if (outcome.extractedBy === "tier2" && (outcome.decisionId === null || outcome.llmCallId === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["decisionId"],
      message: "Tier-2 extraction requires decision and call evidence",
    });
  }
  if (outcome.extractedBy === "rule" && outcome.llmCallId !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["llmCallId"],
      message: "rule extraction cannot claim an LLM call",
    });
  }
});

export const conversationSchema = z.object({
  id: conversationIdSchema,
  runId: runIdSchema,
  participantAgentIds: z.array(agentIdSchema).length(2),
  topic: conversationTopicSchema,
  initiatingTriggerEventId: eventIdSchema,
  termBounds: conversationTermBoundsSchema,
  maxTurns: z.number().int().min(1).max(MAX_CONVERSATION_TURNS).safe(),
  outputTokenBudget: z.number().int().min(1).max(MAX_CONVERSATION_OUTPUT_TOKENS).safe(),
  outputTokensUsed: z.number().int().nonnegative().max(MAX_CONVERSATION_OUTPUT_TOKENS).safe(),
  turns: z.number().int().min(0).max(MAX_CONVERSATION_TURNS).safe(),
  status: conversationStatusSchema,
  outcome: conversationOutcomeSchema.nullable(),
  closeReason: conversationCloseReasonSchema.nullable(),
  startTick: z.number().int().nonnegative().safe(),
  endTick: z.number().int().nonnegative().safe().nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((conversation, ctx) => {
  const [first, second] = conversation.participantAgentIds;
  if (first === second) {
    ctx.addIssue({
      code: "custom",
      path: ["participantAgentIds"],
      message: "conversation participants must be distinct",
    });
  }
  if (conversation.topic !== conversation.termBounds.kind) {
    ctx.addIssue({
      code: "custom",
      path: ["termBounds", "kind"],
      message: "term bounds must match the conversation topic",
    });
  }
  if (conversation.outputTokensUsed > conversation.outputTokenBudget) {
    ctx.addIssue({
      code: "custom",
      path: ["outputTokensUsed"],
      message: "conversation output-token budget exceeded",
    });
  }
  const active = conversation.status === "active";
  if (active && (conversation.outcome !== null || conversation.closeReason !== null || conversation.endTick !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "active conversation cannot carry terminal state",
    });
  }
  if (!active && (conversation.outcome === null || conversation.closeReason === null || conversation.endTick === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "closed conversation requires outcome, reason, and end tick",
    });
  }
  if (conversation.endTick !== null && conversation.endTick < conversation.startTick) {
    ctx.addIssue({
      code: "custom",
      path: ["endTick"],
      message: "conversation cannot end before it starts",
    });
  }
});

export const conversationMessageSchema = z.object({
  id: conversationMessageIdSchema,
  runId: runIdSchema,
  conversationId: conversationIdSchema,
  senderAgentId: agentIdSchema,
  recipientAgentId: agentIdSchema,
  turn: z.number().int().min(1).max(MAX_CONVERSATION_TURNS).safe(),
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  kind: conversationMessageKindSchema,
  content: z.string().trim().min(1).max(2_000),
  structuredTerms: conversationStructuredTermsSchema.nullable(),
  tick: z.number().int().nonnegative().safe(),
  deliveryTick: z.number().int().nonnegative().safe(),
  decisionId: decisionIdSchema,
  llmCallId: llmCallIdSchema.nullable(),
  outputTokens: z.number().int().nonnegative().max(MAX_CONVERSATION_OUTPUT_TOKENS).safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((message, ctx) => {
  if (message.senderAgentId === message.recipientAgentId) {
    ctx.addIssue({
      code: "custom",
      path: ["recipientAgentId"],
      message: "conversation message recipient must differ from sender",
    });
  }
  const requiresTerms = message.kind === "offer" || message.kind === "counter" || message.kind === "accept";
  if (requiresTerms !== (message.structuredTerms !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["structuredTerms"],
      message: requiresTerms
        ? "offer, counter, and accept messages require structured terms"
        : "decline and clarify messages cannot carry structured terms",
    });
  }
  if (message.deliveryTick !== message.tick + 1) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryTick"],
      message: "conversation messages must be delivered on the next tick",
    });
  }
});

export const conversationInboxItemSchema = z.object({
  runId: runIdSchema,
  conversationId: conversationIdSchema,
  messageId: conversationMessageIdSchema,
  recipientAgentId: agentIdSchema,
  deliveryTick: z.number().int().nonnegative().safe(),
  deliveredTick: z.number().int().nonnegative().safe().nullable(),
  readTick: z.number().int().nonnegative().safe().nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((item, ctx) => {
  if (item.deliveredTick !== null && item.deliveredTick < item.deliveryTick) {
    ctx.addIssue({ code: "custom", path: ["deliveredTick"], message: "message delivered too early" });
  }
  if (item.readTick !== null && (item.deliveredTick === null || item.readTick < item.deliveredTick)) {
    ctx.addIssue({ code: "custom", path: ["readTick"], message: "message read before delivery" });
  }
});

export const openConversationInputSchema = z.object({
  participantAgentIds: z.array(agentIdSchema).length(2),
  topic: conversationTopicSchema,
  initiatingTriggerEventId: eventIdSchema,
  termBounds: conversationTermBoundsSchema,
  maxTurns: z.number().int().min(1).max(MAX_CONVERSATION_TURNS).safe(),
  outputTokenBudget: z.number().int().min(1).max(MAX_CONVERSATION_OUTPUT_TOKENS).safe(),
  startTick: z.number().int().nonnegative().safe(),
}).strict().superRefine((input, ctx) => {
  if (input.participantAgentIds[0] === input.participantAgentIds[1]) {
    ctx.addIssue({ code: "custom", path: ["participantAgentIds"], message: "participants must be distinct" });
  }
  if (input.topic !== input.termBounds.kind) {
    ctx.addIssue({ code: "custom", path: ["termBounds", "kind"], message: "bounds must match topic" });
  }
});

export type ConversationTopic = z.infer<typeof conversationTopicSchema>;
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type ConversationCloseReason = z.infer<typeof conversationCloseReasonSchema>;
export type ConversationOutcomeKind = z.infer<typeof conversationOutcomeKindSchema>;
export type ConversationMessageKind = z.infer<typeof conversationMessageKindSchema>;
export type ConversationTermBounds = z.infer<typeof conversationTermBoundsSchema>;
export type ConversationStructuredTerms = z.infer<typeof conversationStructuredTermsSchema>;
export type ConversationOutcome = z.infer<typeof conversationOutcomeSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationInboxItem = z.infer<typeof conversationInboxItemSchema>;
export type OpenConversationInput = z.infer<typeof openConversationInputSchema>;
