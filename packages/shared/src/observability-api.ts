/** Strict WS-608 LLM telemetry, error-health, and conversation HTTP contracts. */

import { z } from "zod";
import {
  agentIdSchema,
} from "./agent";
import { apiMetaSchema, eventIdSchema, opaqueCursorSchema } from "./api";
import {
  conversationCloseReasonSchema,
  conversationIdSchema,
  conversationMessageIdSchema,
  conversationMessageKindSchema,
  conversationOutcomeKindSchema,
  conversationOutcomeSchema,
  conversationStatusSchema,
  conversationStructuredTermsSchema,
  conversationTermBoundsSchema,
  conversationTopicSchema,
} from "./conversation";
import { decisionIdSchema } from "./decision";
import {
  llmCallFallbackReasonSchema,
  llmCallIdSchema,
  llmCallStatusSchema,
  llmProviderErrorCodeSchema,
} from "./llm-call";
import { llmModuleIdSchema } from "./llm-control";
import {
  conversationBindingRejectionReasonSchema,
  conversationBindingResultKindSchema,
  conversationBindingSchema,
  conversationBindingStatusSchema,
} from "./negotiation";
import { runIdSchema, simulationIdSchema } from "./simulation";

const limitQuerySchema = z.coerce.number().int().min(1).max(100).safe().default(50);
const tickQuerySchema = z.coerce.number().int().nonnegative().safe();
const nonnegativeDecimalSchema = z.string().regex(/^\d+$/);

export const observabilityAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(160),
}).strict();

export const llmCallListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: limitQuerySchema,
  cursor: z.string().min(1).max(2_048).optional(),
  agentId: agentIdSchema.optional(),
  moduleId: llmModuleIdSchema.optional(),
  status: llmCallStatusSchema.optional(),
  fromTick: tickQuerySchema.optional(),
  toTick: tickQuerySchema.optional(),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined ||
    query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type LlmCallListQuery = z.infer<typeof llmCallListQuerySchema>;

export const llmCallTelemetryItemSchema = z.object({
  id: llmCallIdSchema,
  decisionId: decisionIdSchema,
  agent: observabilityAgentSchema,
  tick: z.number().int().nonnegative().safe(),
  moduleId: llmModuleIdSchema,
  purpose: z.string().regex(/^[a-z][a-z0-9_.-]{0,159}$/),
  requestedTier: z.union([z.literal(2), z.literal(3)]),
  effectiveTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  promptPackKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  promptVersion: z.number().int().positive().safe(),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/),
  schemaKey: z.string().regex(/^[a-z][a-z0-9_.@-]{0,119}$/),
  schemaVersion: z.number().int().positive().safe(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: llmCallStatusSchema,
  fallbackReason: llmCallFallbackReasonSchema.nullable(),
  providerErrorCode: llmProviderErrorCodeSchema.nullable(),
  detail: z.string().trim().min(1).max(2_000).nullable(),
  cached: z.boolean(),
  attempts: z.number().int().min(0).max(2).safe(),
  inputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  latencyMs: z.number().int().nonnegative().safe(),
  costMicrocents: nonnegativeDecimalSchema,
  costCentsEstimate: nonnegativeDecimalSchema,
  sourceEventId: eventIdSchema,
}).strict();

export const llmCallListResponseSchema = z.object({
  items: z.array(llmCallTelemetryItemSchema),
  nextCursor: opaqueCursorSchema,
  totals: z.object({
    calls: z.number().int().nonnegative().safe(),
    success: z.number().int().nonnegative().safe(),
    fallback: z.number().int().nonnegative().safe(),
    cacheHits: z.number().int().nonnegative().safe(),
    providerAttempts: z.number().int().nonnegative().safe(),
    inputTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    costMicrocents: nonnegativeDecimalSchema,
  }).strict(),
  meta: apiMetaSchema,
}).strict();
export type LlmCallTelemetryItem = z.infer<typeof llmCallTelemetryItemSchema>;
export type LlmCallListResponse = z.infer<typeof llmCallListResponseSchema>;

export const observabilityErrorKindSchema = z.enum([
  "engine",
  "intent_rejected",
  "llm",
  "schema",
]);
export type ObservabilityErrorKind = z.infer<typeof observabilityErrorKindSchema>;

export const errorListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: limitQuerySchema,
  cursor: z.string().min(1).max(2_048).optional(),
  kind: observabilityErrorKindSchema.optional(),
}).strict();
export type ErrorListQuery = z.infer<typeof errorListQuerySchema>;

export const observabilityErrorItemSchema = z.object({
  eventId: eventIdSchema,
  seq: z.number().int().nonnegative().safe(),
  at: z.string().trim().min(1),
  tick: z.number().int().nonnegative().safe(),
  kind: observabilityErrorKindSchema,
  code: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2_000),
  actor: z.object({
    kind: z.string().trim().min(1).max(80),
    id: z.string().trim().min(1).max(160),
  }).strict().nullable(),
  agent: observabilityAgentSchema.nullable(),
  correlationId: z.string().trim().min(1).max(160),
  causationId: z.string().trim().min(1).max(160).nullable(),
}).strict();

export const errorListResponseSchema = z.object({
  items: z.array(observabilityErrorItemSchema),
  nextCursor: opaqueCursorSchema,
  summary: z.object({
    counts: z.object({
      engine: z.number().int().nonnegative().safe(),
      intentRejected: z.number().int().nonnegative().safe(),
      llm: z.number().int().nonnegative().safe(),
      schema: z.number().int().nonnegative().safe(),
    }).strict(),
    perAgent: z.array(z.object({
      agent: observabilityAgentSchema,
      failures: z.number().int().positive().safe(),
    }).strict()),
    activeQuarantines: z.array(z.object({
      agent: observabilityAgentSchema,
      quarantine: z.object({
        mode: z.literal("tier1_only"),
        untilTick: z.number().int().nonnegative().safe(),
        consecutiveFailures: z.number().int().nonnegative().safe(),
      }).strict(),
    }).strict()),
  }).strict(),
  meta: apiMetaSchema,
}).strict();
export type ObservabilityErrorItem = z.infer<typeof observabilityErrorItemSchema>;
export type ErrorListResponse = z.infer<typeof errorListResponseSchema>;

export const conversationListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: limitQuerySchema,
  cursor: z.string().min(1).max(2_048).optional(),
  participant: agentIdSchema.optional(),
  topic: conversationTopicSchema.optional(),
  status: conversationStatusSchema.optional(),
  fromTick: tickQuerySchema.optional(),
  toTick: tickQuerySchema.optional(),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined ||
    query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const conversationPathSchema = z.object({
  simId: simulationIdSchema,
  conversationId: conversationIdSchema,
}).strict();

export const conversationHeaderViewSchema = z.object({
  id: conversationIdSchema,
  participants: z.array(observabilityAgentSchema).length(2),
  topic: conversationTopicSchema,
  status: conversationStatusSchema,
  turns: z.number().int().nonnegative().safe(),
  startTick: z.number().int().nonnegative().safe(),
  endTick: z.number().int().nonnegative().safe().nullable(),
  outcome: z.object({ kind: conversationOutcomeKindSchema }).strict().nullable(),
  binding: z.object({
    status: conversationBindingStatusSchema,
    resultKind: conversationBindingResultKindSchema.nullable(),
    rejectionReason: conversationBindingRejectionReasonSchema.nullable(),
  }).strict().nullable(),
}).strict();

export const conversationListResponseSchema = z.object({
  items: z.array(conversationHeaderViewSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

export const conversationDetailResponseSchema = z.object({
  conversation: conversationHeaderViewSchema.extend({
    initiatingTriggerEventId: eventIdSchema,
    termBounds: conversationTermBoundsSchema,
    maxTurns: z.number().int().positive().safe(),
    outputTokenBudget: z.number().int().positive().safe(),
    outputTokensUsed: z.number().int().nonnegative().safe(),
    closeReason: conversationCloseReasonSchema.nullable(),
    sourceEventId: eventIdSchema,
  }).strict(),
  messages: z.array(z.object({
    id: conversationMessageIdSchema,
    turn: z.number().int().positive().safe(),
    sender: observabilityAgentSchema,
    recipient: observabilityAgentSchema,
    kind: conversationMessageKindSchema,
    content: z.string().trim().min(1).max(2_000),
    structuredTerms: conversationStructuredTermsSchema.nullable(),
    tick: z.number().int().nonnegative().safe(),
    deliveryTick: z.number().int().nonnegative().safe(),
    decisionId: decisionIdSchema,
    llmCallId: llmCallIdSchema.nullable(),
    outputTokens: z.number().int().nonnegative().safe(),
    sourceEventId: eventIdSchema,
  }).strict()),
  outcome: conversationOutcomeSchema.nullable(),
  binding: conversationBindingSchema.nullable(),
  meta: apiMetaSchema,
}).strict();
export type ConversationDetailResponse = z.infer<typeof conversationDetailResponseSchema>;
