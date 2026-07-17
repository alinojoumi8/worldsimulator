/** Canonical M21 LLM response-cache boundary (ADR-0007/0009). */

import { canonicalParse, canonicalStringify, sha256Hex } from "@worldtangle/shared";
import { z } from "zod";
import type {
  LlmFallback,
  LlmProviderError,
  LlmProviderRoute,
  LlmRequest,
  LlmResult,
  LlmSuccess,
  RoutedLlmProvider,
} from "./llm-provider";
import { llmRequestHash } from "./llm-provider";

export const LLM_CACHE_ARTIFACT_FORMAT = "worldtangle.llm-response-cache";
export const LLM_CACHE_ARTIFACT_VERSION = 1;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const positiveVersionSchema = z.number().int().positive().safe();

export const llmCacheKeySchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    promptPackVersion: positiveVersionSchema,
    schemaVersion: positiveVersionSchema,
    requestHash: sha256Schema,
  })
  .strict();

export type LlmCacheKey = z.infer<typeof llmCacheKeySchema>;

export const llmCachedResponseSchema = z
  .object({
    key: llmCacheKeySchema,
    keyHash: sha256Schema,
    value: z.unknown(),
    responseModel: z.string().trim().min(1).max(200),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    attempts: z.number().int().min(1).max(2),
  })
  .strict();

export type LlmCachedResponse = z.infer<typeof llmCachedResponseSchema>;

export interface LlmCacheWrite {
  record: LlmCachedResponse;
  correlationId: string;
  causationId: string;
}

export const LLM_CACHE_TELEMETRY_TYPES = [
  "llm.cache.hit",
  "llm.cache.miss",
  "llm.cache.stored",
  "llm.cache.corrupt",
] as const;

export type LlmCacheTelemetryType = (typeof LLM_CACHE_TELEMETRY_TYPES)[number];

export interface LlmCacheTelemetry {
  type: LlmCacheTelemetryType;
  key: LlmCacheKey;
  keyHash: string;
  mode: LlmCacheMode;
  correlationId: string;
  causationId: string;
}

export interface LlmResponseCache {
  get(key: LlmCacheKey): LlmCachedResponse | undefined;
  put(write: LlmCacheWrite): void;
  /** Optional durable hit/miss/corruption audit. Returns its event ID. */
  recordTelemetry?(telemetry: LlmCacheTelemetry): string | undefined;
}

export type LlmCacheMode = "read_write" | "cache_only";

export interface CachedLlmProviderOptions {
  provider: RoutedLlmProvider;
  cache: LlmResponseCache;
  mode?: LlmCacheMode;
  onTelemetry?: (telemetry: LlmCacheTelemetry) => void;
}

const llmCacheArtifactEntrySchema = llmCachedResponseSchema;

const llmCacheArtifactBaseSchema = z
  .object({
    format: z.literal(LLM_CACHE_ARTIFACT_FORMAT),
    version: z.literal(LLM_CACHE_ARTIFACT_VERSION),
    sourceRunId: z.string().regex(/^run_[0-9a-z]{8}$/),
    entries: z.array(llmCacheArtifactEntrySchema),
  })
  .strict();

export const llmCacheArtifactSchema = llmCacheArtifactBaseSchema
  .extend({ digest: sha256Schema })
  .strict();

export type LlmCacheArtifact = z.infer<typeof llmCacheArtifactSchema>;

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalClone(value: unknown): unknown {
  return canonicalParse(canonicalStringify(value));
}

export function llmCacheKey(input: LlmCacheKey): LlmCacheKey {
  const parsed = llmCacheKeySchema.parse(input);
  return Object.freeze({ ...parsed });
}

export function llmCacheKeyForRequest(
  route: LlmProviderRoute,
  request: LlmRequest,
): LlmCacheKey {
  return llmCacheKey({
    provider: route.provider,
    model: route.model,
    promptPackVersion: request.promptPackVersion,
    schemaVersion: request.schemaVersion,
    requestHash: llmRequestHash(request),
  });
}

export function llmCacheKeyHash(keyInput: LlmCacheKey): string {
  return sha256Hex(canonicalStringify(llmCacheKey(keyInput)));
}

export function normalizeLlmCachedResponse(input: LlmCachedResponse): LlmCachedResponse {
  const parsed = llmCachedResponseSchema.parse({
    ...input,
    key: llmCacheKey(input.key),
    value: canonicalClone(input.value),
  });
  const expectedHash = llmCacheKeyHash(parsed.key);
  if (parsed.keyHash !== expectedHash) {
    throw new Error("LLM cache record key hash does not match its canonical key");
  }
  return Object.freeze({
    ...parsed,
    key: Object.freeze({ ...parsed.key }),
    value: canonicalClone(parsed.value),
  });
}

function sameCachedResponse(left: LlmCachedResponse, right: LlmCachedResponse): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

/** Deterministic cache used by unit tests and provider-free runs. */
export class InMemoryLlmResponseCache implements LlmResponseCache {
  private readonly records = new Map<string, LlmCachedResponse>();

  get(key: LlmCacheKey): LlmCachedResponse | undefined {
    const record = this.records.get(llmCacheKeyHash(key));
    return record === undefined ? undefined : normalizeLlmCachedResponse(record);
  }

  put(write: LlmCacheWrite): void {
    const record = normalizeLlmCachedResponse(write.record);
    const existing = this.records.get(record.keyHash);
    if (existing !== undefined) {
      if (!sameCachedResponse(existing, record)) {
        throw new Error("LLM cache keys are immutable and cannot map to different responses");
      }
      return;
    }
    this.records.set(record.keyHash, record);
  }

  list(): readonly LlmCachedResponse[] {
    return Object.freeze(
      [...this.records.values()]
        .sort((left, right) => compareCodeUnit(left.keyHash, right.keyHash))
        .map((record) => normalizeLlmCachedResponse(record)),
    );
  }
}

function artifactBase(
  sourceRunId: string,
  records: readonly LlmCachedResponse[],
): z.infer<typeof llmCacheArtifactBaseSchema> {
  const entries = records
    .map((record) => normalizeLlmCachedResponse(record))
    .sort((left, right) => compareCodeUnit(left.keyHash, right.keyHash));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.keyHash === entries[index]!.keyHash) {
      throw new Error(`duplicate LLM cache artifact key ${entries[index]!.keyHash}`);
    }
  }
  return llmCacheArtifactBaseSchema.parse({
    format: LLM_CACHE_ARTIFACT_FORMAT,
    version: LLM_CACHE_ARTIFACT_VERSION,
    sourceRunId,
    entries,
  });
}

export function createLlmCacheArtifact(
  sourceRunId: string,
  records: readonly LlmCachedResponse[],
): LlmCacheArtifact {
  const base = artifactBase(sourceRunId, records);
  return {
    ...base,
    entries: base.entries.map((entry) => normalizeLlmCachedResponse(entry)),
    digest: sha256Hex(canonicalStringify(base)),
  };
}

export function validateLlmCacheArtifact(input: unknown): LlmCacheArtifact {
  const parsed = llmCacheArtifactSchema.parse(input);
  const base = artifactBase(parsed.sourceRunId, parsed.entries);
  const digest = sha256Hex(canonicalStringify(base));
  if (parsed.digest !== digest) throw new Error("LLM cache artifact checksum does not match");
  const suppliedOrder = parsed.entries.map((entry) => entry.keyHash);
  const canonicalOrder = base.entries.map((entry) => entry.keyHash);
  if (canonicalStringify(suppliedOrder) !== canonicalStringify(canonicalOrder)) {
    throw new Error("LLM cache artifact entries are not in canonical key order");
  }
  return createLlmCacheArtifact(parsed.sourceRunId, base.entries);
}

function cacheProviderError(code: "cache_miss" | "cache_corrupt"): LlmProviderError {
  return {
    provider: "cache",
    code,
    retryable: false,
  };
}

function cacheFallback(
  requestHash: string,
  reason: "cache_miss" | "schema_invalid" | "provider_error",
  code: "cache_miss" | "cache_corrupt",
  detail: string,
): LlmFallback {
  return {
    ok: false,
    reason,
    requestHash,
    detail,
    providerError: cacheProviderError(code),
    attempts: 0,
  };
}

/**
 * Read-through cache decorator. In `cache_only` mode it is a hard replay
 * boundary: a miss never calls the wrapped live provider.
 */
export class CachedLlmProvider implements RoutedLlmProvider {
  private readonly provider: RoutedLlmProvider;
  private readonly cache: LlmResponseCache;
  private readonly mode: LlmCacheMode;
  private readonly onTelemetry?: (telemetry: LlmCacheTelemetry) => void;

  constructor(options: CachedLlmProviderOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.mode = options.mode ?? "read_write";
    this.onTelemetry = options.onTelemetry;
  }

  route(request: LlmRequest): LlmProviderRoute {
    return this.provider.route(request);
  }

  private telemetry(
    type: LlmCacheTelemetryType,
    request: LlmRequest,
    key: LlmCacheKey,
    causationId = request.causationId,
  ): string | undefined {
    const telemetry: LlmCacheTelemetry = Object.freeze({
      type,
      key,
      keyHash: llmCacheKeyHash(key),
      mode: this.mode,
      correlationId: request.correlationId,
      causationId,
    });
    const eventId = this.cache.recordTelemetry?.(telemetry);
    try {
      this.onTelemetry?.(telemetry);
    } catch {
      // Observers are non-authoritative; durable cache audit failures still
      // surface through `recordTelemetry` above.
    }
    return eventId;
  }

  private corrupt(
    request: LlmRequest,
    key: LlmCacheKey,
    detail: string,
  ): LlmFallback {
    try {
      this.telemetry("llm.cache.corrupt", request, key);
    } catch {
      // Preserve the original integrity failure.
    }
    return cacheFallback(key.requestHash, "schema_invalid", "cache_corrupt", detail);
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    let key: LlmCacheKey;
    try {
      key = llmCacheKeyForRequest(this.route(request), request);
    } catch (error) {
      return cacheFallback(
        llmRequestHash(request),
        "provider_error",
        "cache_corrupt",
        error instanceof Error ? error.message : "invalid LLM cache key",
      );
    }

    let cached: LlmCachedResponse | undefined;
    try {
      cached = this.cache.get(key);
    } catch (error) {
      return this.corrupt(
        request,
        key,
        error instanceof Error ? error.message : "LLM cache read failed",
      );
    }
    if (cached !== undefined) {
      let normalized: LlmCachedResponse;
      try {
        normalized = normalizeLlmCachedResponse(cached);
      } catch (error) {
        return this.corrupt(
          request,
          key,
          error instanceof Error ? error.message : "LLM cache record is invalid",
        );
      }
      if (canonicalStringify(normalized.key) !== canonicalStringify(key)) {
        return this.corrupt(request, key, "LLM cache returned a record for a different key");
      }
      const parsed = request.schema.safeParse(normalized.value);
      if (!parsed.success) {
        return this.corrupt(
          request,
          key,
          `cached output failed ${request.schemaKey} with ${parsed.error.issues.length} issue(s)`,
        );
      }
      try {
        this.telemetry("llm.cache.hit", request, key);
      } catch (error) {
        return this.corrupt(
          request,
          key,
          error instanceof Error ? error.message : "LLM cache hit audit failed",
        );
      }
      return {
        ok: true,
        value: parsed.data,
        model: normalized.responseModel,
        cached: true,
        inputTokens: normalized.inputTokens,
        cachedInputTokens: 0,
        outputTokens: normalized.outputTokens,
        requestHash: key.requestHash,
        attempts: normalized.attempts,
      } satisfies LlmSuccess;
    }

    let missEventId: string | undefined;
    try {
      missEventId = this.telemetry("llm.cache.miss", request, key);
    } catch (error) {
      return this.corrupt(
        request,
        key,
        error instanceof Error ? error.message : "LLM cache miss audit failed",
      );
    }
    if (this.mode === "cache_only") {
      return cacheFallback(
        key.requestHash,
        "cache_miss",
        "cache_miss",
        "cache-only replay has no response for the canonical request key",
      );
    }

    let result: LlmResult;
    try {
      result = await this.provider.propose(request);
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash: key.requestHash,
        detail: error instanceof Error ? error.message : "wrapped LLM provider threw",
        providerError: {
          provider: key.provider,
          code: "unknown",
          retryable: false,
        },
      } satisfies LlmFallback;
    }
    if (!result.ok) return result;
    if (result.requestHash !== key.requestHash) {
      return this.corrupt(request, key, "provider response request hash does not match its request");
    }
    const parsed = request.schema.safeParse(result.value);
    if (!parsed.success) {
      return this.corrupt(
        request,
        key,
        `provider output failed ${request.schemaKey} before cache storage`,
      );
    }

    const record = normalizeLlmCachedResponse({
      key,
      keyHash: llmCacheKeyHash(key),
      value: parsed.data,
      responseModel: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      attempts: result.attempts ?? 1,
    });
    try {
      this.cache.put({
        record,
        correlationId: request.correlationId,
        causationId: missEventId ?? request.causationId,
      });
    } catch (error) {
      return this.corrupt(
        request,
        key,
        error instanceof Error ? error.message : "LLM cache storage failed",
      );
    }
    try {
      this.onTelemetry?.(Object.freeze({
        type: "llm.cache.stored",
        key,
        keyHash: record.keyHash,
        mode: this.mode,
        correlationId: request.correlationId,
        causationId: missEventId ?? request.causationId,
      }));
    } catch {
      // Non-authoritative observer only.
    }
    return {
      ...result,
      value: parsed.data,
    } satisfies LlmSuccess;
  }
}
