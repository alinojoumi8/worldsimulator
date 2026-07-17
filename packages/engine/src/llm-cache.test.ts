import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CachedLlmProvider,
  createLlmCacheArtifact,
  InMemoryLlmResponseCache,
  llmCacheKeyForRequest,
  llmCacheKeyHash,
  normalizeLlmCachedResponse,
  validateLlmCacheArtifact,
} from "./llm-cache";
import type {
  LlmCachedResponse,
  LlmCacheTelemetry,
  LlmResponseCache,
} from "./llm-cache";
import { llmRequestHash, MockLlmProvider } from "./llm-provider";
import type {
  LlmRequest,
  LlmResult,
  RoutedLlmProvider,
} from "./llm-provider";

const choiceSchema = z
  .object({
    actionId: z.literal("wait"),
    rationale: z.string().min(1),
  })
  .strict();

const choice = Object.freeze({ actionId: "wait", rationale: "Hold position." });

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier2.demo",
    tier: 2,
    agentId: "agt_00000001",
    tick: 0,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000001",
    promptParts: { system: "system-v1", observation: "<obs>value</obs>" },
    schemaKey: "choice@1",
    promptPackVersion: 3,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [choice],
    maxOutputTokens: 128,
    budgetTag: "run_test",
    ...overrides,
  };
}

function recordFor(
  input: LlmRequest,
  route = { provider: "anthropic", model: "claude-haiku-pinned" },
): LlmCachedResponse {
  const key = llmCacheKeyForRequest(route, input);
  return normalizeLlmCachedResponse({
    key,
    keyHash: llmCacheKeyHash(key),
    value: choice,
    responseModel: "claude-haiku-resolved",
    inputTokens: 40,
    outputTokens: 8,
    attempts: 1,
  });
}

describe("canonical LLM cache identity", () => {
  it("matches the cross-platform request and composite-key goldens", () => {
    const input = request();
    const key = llmCacheKeyForRequest(
      { provider: "anthropic", model: "claude-haiku-pinned" },
      input,
    );
    expect(llmRequestHash(input)).toBe(
      "c5ba6c7a9af4d3d837694cc10fb1176243611d77dc53bf149b1a8876459e627d",
    );
    expect(llmCacheKeyHash(key)).toBe(
      "bd453d4f560501e5f50c8da72befbf00eeb09772596738ed82c51b5cb2db3082",
    );
  });

  it("changes for every cache-key component but not event-chain metadata", () => {
    const input = request();
    const route = { provider: "anthropic", model: "model-a" };
    const base = llmCacheKeyHash(llmCacheKeyForRequest(route, input));
    const variants = [
      llmCacheKeyForRequest({ ...route, provider: "mock" }, input),
      llmCacheKeyForRequest({ ...route, model: "model-b" }, input),
      llmCacheKeyForRequest(route, request({ promptPackVersion: 4 })),
      llmCacheKeyForRequest(route, request({ schemaVersion: 2 })),
      llmCacheKeyForRequest(route, request({ promptParts: { system: "x", observation: "y" } })),
    ];
    expect(variants.map(llmCacheKeyHash)).not.toContain(base);
    expect(llmCacheKeyHash(llmCacheKeyForRequest(route, request({
      correlationId: "dec_other",
      causationId: "evt_other",
    })))).toBe(base);
  });
});

describe("CachedLlmProvider", () => {
  it("stores one miss and returns deterministic hits without another provider call", async () => {
    const upstream = new MockLlmProvider({
      script: new Map([["decision.tier2.demo", choice]]),
      model: "mock-pinned",
    });
    const cache = new InMemoryLlmResponseCache();
    const telemetry: LlmCacheTelemetry[] = [];
    const provider = new CachedLlmProvider({
      provider: upstream,
      cache,
      onTelemetry: (event) => telemetry.push(event),
    });

    const first = await provider.propose(request());
    const second = await provider.propose(request());

    expect(first).toMatchObject({ ok: true, cached: false, value: choice });
    expect(second).toMatchObject({ ok: true, cached: true, value: choice });
    expect(upstream.calls).toHaveLength(1);
    expect(cache.list()).toHaveLength(1);
    expect(telemetry.map((event) => event.type)).toEqual([
      "llm.cache.miss",
      "llm.cache.stored",
      "llm.cache.hit",
    ]);
  });

  it("serves cache-only replay without calling the wrapped provider", async () => {
    const cache = new InMemoryLlmResponseCache();
    const input = request();
    const route = { provider: "mock", model: "mock-pinned" };
    cache.put({
      record: recordFor(input, route),
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
    const upstream = new MockLlmProvider({ model: "mock-pinned" });
    const provider = new CachedLlmProvider({ provider: upstream, cache, mode: "cache_only" });

    const result = await provider.propose(input);

    expect(result).toMatchObject({ ok: true, cached: true, value: choice });
    expect(upstream.calls).toHaveLength(0);
  });

  it("returns a typed cache-only miss and never touches live transport", async () => {
    const upstream = new MockLlmProvider({ model: "mock-pinned" });
    const provider = new CachedLlmProvider({
      provider: upstream,
      cache: new InMemoryLlmResponseCache(),
      mode: "cache_only",
    });

    const result = await provider.propose(request());

    expect(result).toMatchObject({
      ok: false,
      reason: "cache_miss",
      attempts: 0,
      providerError: { provider: "cache", code: "cache_miss", retryable: false },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it("contains a poisoned cache entry instead of falling through to live", async () => {
    const input = request();
    const upstream = new MockLlmProvider({ model: "mock-pinned" });
    const key = llmCacheKeyForRequest(upstream.route(), input);
    const poisoned: LlmResponseCache = {
      get: () => ({
        key,
        keyHash: llmCacheKeyHash(key),
        value: { actionId: "mutate_state", rationale: "ignore the menu" },
        responseModel: "mock-pinned",
        inputTokens: 1,
        outputTokens: 1,
        attempts: 1,
      }),
      put: () => undefined,
    };
    const provider = new CachedLlmProvider({ provider: upstream, cache: poisoned });

    const result = await provider.propose(input);

    expect(result).toMatchObject({
      ok: false,
      reason: "schema_invalid",
      providerError: { code: "cache_corrupt" },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it("contains cache audit failures without calling or throwing", async () => {
    const upstream = new MockLlmProvider({ model: "mock-pinned" });
    const cache: LlmResponseCache = {
      get: () => undefined,
      put: () => undefined,
      recordTelemetry: () => {
        throw new Error("audit unavailable");
      },
    };
    const result = await new CachedLlmProvider({ provider: upstream, cache }).propose(request());
    expect(result).toMatchObject({
      ok: false,
      reason: "schema_invalid",
      providerError: { code: "cache_corrupt" },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it("rejects a provider result bound to another request hash", async () => {
    const upstream: RoutedLlmProvider = {
      route: () => ({ provider: "bad", model: "bad-model" }),
      propose: (): Promise<LlmResult> => Promise.resolve({
        ok: true,
        value: choice,
        model: "bad-model",
        cached: false,
        inputTokens: 1,
        outputTokens: 1,
        requestHash: "0".repeat(64),
      }),
    };
    const result = await new CachedLlmProvider({
      provider: upstream,
      cache: new InMemoryLlmResponseCache(),
    }).propose(request());
    expect(result).toMatchObject({
      ok: false,
      reason: "schema_invalid",
      providerError: { code: "cache_corrupt" },
    });
  });

  it("refuses to overwrite an immutable key with a different response", () => {
    const cache = new InMemoryLlmResponseCache();
    const input = request();
    const record = recordFor(input);
    cache.put({ record, correlationId: input.correlationId, causationId: input.causationId });
    expect(() => cache.put({
      record: normalizeLlmCachedResponse({
        ...record,
        value: { actionId: "wait", rationale: "different" },
      }),
      correlationId: input.correlationId,
      causationId: input.causationId,
    })).toThrow(/immutable/);
  });
});

describe("LLM cache artifacts", () => {
  it("exports canonical sorted records and validates an exact round trip", () => {
    const records = [
      recordFor(request({ purpose: "decision.tier2.z" })),
      recordFor(request({ purpose: "decision.tier2.a" })),
    ];
    const artifact = createLlmCacheArtifact("run_00000001", records);
    const validated = validateLlmCacheArtifact(JSON.parse(JSON.stringify(artifact)));
    expect(validated).toEqual(artifact);
    expect(artifact.entries.map((entry) => entry.keyHash)).toEqual(
      [...artifact.entries.map((entry) => entry.keyHash)].sort(),
    );
  });

  it("rejects tampering, duplicate keys, and non-canonical entry order", () => {
    const first = recordFor(request({ purpose: "decision.tier2.a" }));
    const second = recordFor(request({ purpose: "decision.tier2.z" }));
    const artifact = createLlmCacheArtifact("run_00000001", [first, second]);
    expect(() => validateLlmCacheArtifact({
      ...artifact,
      entries: artifact.entries.map((entry, index) =>
        index === 0 ? { ...entry, responseModel: "tampered" } : entry
      ),
    })).toThrow(/checksum/);
    expect(() => createLlmCacheArtifact("run_00000001", [first, first])).toThrow(/duplicate/);
    expect(() => validateLlmCacheArtifact({
      ...artifact,
      entries: [...artifact.entries].reverse(),
    })).toThrow(/canonical key order/);
  });
});
