/** Immutable per-attempt LLM evidence records (introduced by WS-605). */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { decisionIdSchema } from "./decision";
import { llmModuleIdSchema } from "./llm-control";
import { runIdSchema } from "./simulation";

export const llmCallIdSchema = z.string().regex(/^llm_[0-9a-z]{8,}$/);

export const LLM_CALL_STATUSES = ["success", "fallback"] as const;
export const llmCallStatusSchema = z.enum(LLM_CALL_STATUSES);

export const LLM_CALL_FALLBACK_REASONS = [
  "llm_off",
  "schema_invalid",
  "budget_blocked",
  "provider_error",
  "cache_miss",
  "validation_failed",
] as const;
export const llmCallFallbackReasonSchema = z.enum(LLM_CALL_FALLBACK_REASONS);

export const LLM_PROVIDER_ERROR_CODES = [
  "invalid_request",
  "authentication",
  "billing",
  "permission",
  "not_found",
  "conflict",
  "request_too_large",
  "rate_limited",
  "api",
  "timeout",
  "overloaded",
  "transport",
  "refusal",
  "truncated",
  "malformed_response",
  "cache_miss",
  "cache_corrupt",
  "unknown",
] as const;
export const llmProviderErrorCodeSchema = z.enum(LLM_PROVIDER_ERROR_CODES);

export const llmCallRecordSchema = z.object({
  id: llmCallIdSchema,
  runId: runIdSchema,
  decisionId: decisionIdSchema,
  agentId: agentIdSchema,
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
  fallbackReason: llmCallFallbackReasonSchema.optional(),
  providerErrorCode: llmProviderErrorCodeSchema.optional(),
  detail: z.string().trim().min(1).max(2_000).optional(),
  cached: z.boolean(),
  attempts: z.number().int().min(0).max(2).safe(),
  inputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe().default(0),
  outputTokens: z.number().int().nonnegative().safe(),
  response: z.unknown().optional(),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
}).strict().superRefine((record, ctx) => {
  if (record.cachedInputTokens > record.inputTokens) {
    ctx.addIssue({
      code: "custom",
      path: ["cachedInputTokens"],
      message: "cached input tokens cannot exceed total input tokens",
    });
  }
  if (record.status === "success") {
    if (record.response === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["response"],
        message: "successful LLM call requires a structured response",
      });
    }
    if (record.fallbackReason !== undefined || record.providerErrorCode !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackReason"],
        message: "successful LLM call cannot carry fallback metadata",
      });
    }
    if (record.effectiveTier === 1) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTier"],
        message: "successful LLM call cannot have effective Tier 1",
      });
    }
  } else {
    if (record.fallbackReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackReason"],
        message: "fallback LLM call requires a reason",
      });
    }
    if (record.response !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["response"],
        message: "fallback LLM call cannot carry a response",
      });
    }
  }
});

export type LlmCallRecord = z.infer<typeof llmCallRecordSchema>;
