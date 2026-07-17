/** Canonical immutable call-evidence construction shared by live decision phases. */

import {
  llmCallRecordSchema,
  type LlmCallRecord,
} from "@worldtangle/shared";
import {
  type BuiltAgentDecisionPrompt,
  type LlmProviderRoute,
  type LlmResult,
} from "@worldtangle/engine";
import type { LlmCallTelemetry } from "./persistence";

function boundedDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, 2_000);
}

export function buildLlmCallTelemetryEvidence(result: LlmResult): LlmCallTelemetry {
  return Object.freeze({
    latencyMs: result.latencyMs ?? 0,
    costMicrocents: result.costMicrocents ?? "0",
  });
}

export function buildLlmCallRecordEvidence(input: {
  readonly prompt: BuiltAgentDecisionPrompt;
  readonly result: LlmResult;
  readonly route: LlmProviderRoute;
  readonly agentId: string;
  readonly runId: string;
  readonly tick: number;
  readonly callId: string;
  readonly decisionId: string;
  readonly sourceEventId: string;
  readonly validationFallbackDetail?: string;
}): LlmCallRecord {
  const { request } = input.prompt;
  const validationFallback = input.result.ok &&
    input.validationFallbackDetail !== undefined;
  const common = {
    id: input.callId,
    runId: input.runId,
    decisionId: input.decisionId,
    agentId: input.agentId,
    tick: input.tick,
    moduleId: request.moduleId,
    purpose: request.purpose,
    requestedTier: input.result.requestedTier ?? request.tier,
    provider: input.route.provider,
    model: input.result.ok ? input.result.model : input.route.model,
    promptPackKey: input.prompt.promptPackKey,
    promptVersion: input.prompt.promptPackVersion,
    promptHash: input.prompt.promptHash,
    schemaKey: request.schemaKey,
    schemaVersion: request.schemaVersion,
    requestHash: input.result.requestHash,
    sourceEventId: input.sourceEventId,
  } as const;
  if (!input.result.ok) {
    const detail = boundedDetail(input.result.detail);
    return llmCallRecordSchema.parse({
      ...common,
      effectiveTier: 1,
      status: "fallback",
      fallbackReason: input.result.reason,
      ...(input.result.providerError === undefined
        ? {}
        : { providerErrorCode: input.result.providerError.code }),
      ...(detail === undefined ? {} : { detail }),
      cached: false,
      attempts: input.result.attempts ?? 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  }
  if (validationFallback) {
    return llmCallRecordSchema.parse({
      ...common,
      effectiveTier: 1,
      status: "fallback",
      fallbackReason: "validation_failed",
      detail: boundedDetail(input.validationFallbackDetail),
      cached: input.result.cached,
      attempts: input.result.attempts ?? (input.result.cached ? 0 : 1),
      inputTokens: input.result.inputTokens,
      cachedInputTokens: input.result.cachedInputTokens ?? 0,
      outputTokens: input.result.outputTokens,
    });
  }
  return llmCallRecordSchema.parse({
    ...common,
    effectiveTier: input.result.effectiveTier ?? request.tier,
    status: "success",
    cached: input.result.cached,
    attempts: input.result.attempts ?? (input.result.cached ? 0 : 1),
    inputTokens: input.result.inputTokens,
    cachedInputTokens: input.result.cachedInputTokens ?? 0,
    outputTokens: input.result.outputTokens,
    response: input.result.value,
  });
}
