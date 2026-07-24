/**
 * LLM gateway seam (ADR-0006/0007). `LlmProvider` is the ONLY interface
 * engine modules may use to reach a model. Providers return structured
 * PROPOSALS; they never touch state. The Anthropic adapter and mock provider
 * both live behind this interface; cache and budget enforcement compose around
 * it in later Phase 6 tickets.
 */

import { canonicalStringify, fnv1a32, sha256Hex } from "@worldtangle/shared";
import type {
  AgentLabController,
  AgentScopedObservation,
  DecisionOption,
  LlmModuleId,
  TriggerSignal,
} from "@worldtangle/shared";
import type { z } from "zod";

export interface LlmRequest {
  /** Stable purpose key, e.g. "decision.tier2.set_price". */
  purpose: string;
  tier: 2 | 3;
  agentId?: string;
  /** Deterministic simulation boundary used for daily allowances and cooldowns. */
  tick: number;
  /** Approved simulation module; this is not an arbitrary tool/function name. */
  moduleId: LlmModuleId;
  /** Event-chain metadata for gateway/cache telemetry; excluded from cache identity. */
  correlationId: string;
  causationId: string;
  /**
   * Stable persona/system prefix first, volatile observation last (prompt-cache
   * friendly, ADR-0007). Observation content is untrusted data and must be
   * fenced by the caller (SAF-3).
   */
  promptParts: { system: string; observation: string };
  /** Registered schema name+version — part of the cache key. */
  schemaKey: string;
  promptPackVersion: number;
  schemaVersion: number;
  schema: z.ZodType<unknown>;
  /** Tier-2 structured choice: the engine-offered action menu. */
  options?: readonly unknown[];
  maxOutputTokens?: number;
  budgetTag: string;
  /**
   * Operational Agent Lab context. It is excluded from the ordinary request
   * hash so native and shadow trials remain byte-identical to their controls.
   */
  agentLab?: Readonly<{
    simulationId: string;
    runId: string;
    studyId: string;
    trialId: string;
    controller: AgentLabController;
    opportunityKey: string;
    trigger: TriggerSignal;
    completedTick: number;
    targetTick: number;
    observation: AgentScopedObservation;
    offeredOptions: readonly DecisionOption[];
    driverPolicyDigest: string;
    promptDigest: string;
    toolSchemaDigest: string;
  }>;
  /** Optional cache salt used only by authoritative external decisions. */
  cacheScope?: string;
}

export interface LlmSuccess {
  ok: true;
  value: unknown;
  model: string;
  cached: boolean;
  inputTokens: number;
  /** Provider-reported cache-hit subset of inputTokens; zero/omitted when unsupported. */
  cachedInputTokens?: number;
  outputTokens: number;
  requestHash: string;
  requestedTier?: 2 | 3;
  effectiveTier?: 2 | 3;
  degradationReason?: string;
  /** One normally, two when the gateway repaired a schema-invalid response. */
  attempts?: number;
  /** Non-authoritative wall-clock telemetry added outside the deterministic gateway. */
  latencyMs?: number;
  /** Exact charge assigned by the budget controller; cached calls are zero. */
  costMicrocents?: string;
}

export type LlmFallbackReason =
  | "llm_off"
  | "schema_invalid"
  | "budget_blocked"
  | "provider_error"
  | "cache_miss";

/** Stable provider taxonomy. Upstream error strings never become control flow. */
export type LlmProviderErrorCode =
  | "invalid_request"
  | "authentication"
  | "billing"
  | "permission"
  | "not_found"
  | "conflict"
  | "request_too_large"
  | "rate_limited"
  | "api"
  | "timeout"
  | "overloaded"
  | "transport"
  | "refusal"
  | "truncated"
  | "malformed_response"
  | "cache_miss"
  | "cache_corrupt"
  | "unknown";

export interface LlmProviderError {
  provider: string;
  code: LlmProviderErrorCode;
  retryable: boolean;
  status?: number;
  upstreamType?: string;
  requestId?: string;
}

export interface LlmFallback {
  ok: false;
  reason: LlmFallbackReason;
  requestHash: string;
  detail?: string;
  providerError?: LlmProviderError;
  requestedTier?: 2 | 3;
  effectiveTier?: 1 | 2 | 3;
  degradationReason?: string;
  /** Zero when request construction failed, otherwise provider calls made. */
  attempts?: number;
  /** Non-authoritative wall-clock telemetry added outside the deterministic gateway. */
  latencyMs?: number;
  /** Exact charge assigned by the budget controller; fallbacks are zero. */
  costMicrocents?: string;
}

/** Providers never throw into the engine — failures are typed fallback signals. */
export type LlmResult = LlmSuccess | LlmFallback;

export interface LlmProvider {
  propose(request: LlmRequest): Promise<LlmResult>;
}

export interface LlmProviderRoute {
  provider: string;
  model: string;
}

/** Cacheable providers reveal the pinned route before making a model call. */
export interface RoutedLlmProvider extends LlmProvider {
  route(request: LlmRequest): LlmProviderRoute;
}

/** Deterministic tier router used to compose different bounded live providers. */
export class TierRoutedLlmProvider implements RoutedLlmProvider {
  constructor(
    private readonly tier2: RoutedLlmProvider,
    private readonly tier3: RoutedLlmProvider,
  ) {}

  route(request: LlmRequest): LlmProviderRoute {
    return (request.tier === 2 ? this.tier2 : this.tier3).route(request);
  }

  propose(request: LlmRequest): Promise<LlmResult> {
    return (request.tier === 2 ? this.tier2 : this.tier3).propose(request);
  }
}

/**
 * Canonical cache/reproducibility key over everything that shapes the output.
 * Tick, module, causal metadata and budget tags are operational policy inputs;
 * the fenced observation carries any simulated facts that should shape output.
 */
export function llmRequestHash(request: LlmRequest): string {
  return sha256Hex(
    canonicalStringify({
      purpose: request.purpose,
      tier: request.tier,
      agentId: request.agentId ?? null,
      system: request.promptParts.system,
      observation: request.promptParts.observation,
      schemaKey: request.schemaKey,
      promptPackVersion: request.promptPackVersion,
      schemaVersion: request.schemaVersion,
      options: request.options ?? null,
      maxOutputTokens: request.maxOutputTokens ?? null,
      ...(request.cacheScope === undefined ? {} : { cacheScope: request.cacheScope }),
    }),
  );
}

export interface MockLlmOptions {
  /** Scripted responses by purpose (checked before hash-choice). */
  script?: ReadonlyMap<string, unknown> | ((request: LlmRequest) => unknown | undefined);
  /** Model name reported in results. */
  model?: string;
}

/**
 * Deterministic provider for tests and `llmMode=mock` runs: scripted response
 * by purpose if present, otherwise a hash-based pick from `request.options`.
 * Output is schema-validated exactly like a live response would be.
 */
export class MockLlmProvider implements RoutedLlmProvider {
  readonly calls: LlmRequest[] = [];
  private readonly script: MockLlmOptions["script"];
  private readonly model: string;

  constructor(options: MockLlmOptions = {}) {
    this.script = options.script;
    this.model = options.model ?? "mock-llm-v1";
  }

  route(): LlmProviderRoute {
    return { provider: "mock", model: this.model };
  }

  propose(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request);
    const requestHash = llmRequestHash(request);

    let candidate: unknown =
      typeof this.script === "function" ? this.script(request) : this.script?.get(request.purpose);

    if (candidate === undefined) {
      if (request.options && request.options.length > 0) {
        candidate = request.options[fnv1a32(requestHash) % request.options.length];
      } else {
        return Promise.resolve({
          ok: false,
          reason: "provider_error",
          requestHash,
          detail: "mock has no script entry for this purpose and no options to choose from",
        } satisfies LlmFallback);
      }
    }

    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) {
      return Promise.resolve({
        ok: false,
        reason: "schema_invalid",
        requestHash,
        detail: parsed.error.message,
      } satisfies LlmFallback);
    }

    const inputTokens = Math.ceil(
      (request.promptParts.system.length + request.promptParts.observation.length) / 4,
    );
    const outputTokens = Math.ceil(canonicalStringify(parsed.data ?? null).length / 4);
    return Promise.resolve({
      ok: true,
      value: parsed.data,
      model: this.model,
      cached: false,
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      requestHash,
    } satisfies LlmSuccess);
  }
}
