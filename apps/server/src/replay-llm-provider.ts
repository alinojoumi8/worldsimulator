/** Cache-only LLM provider that preserves source call accounting during replay. */

import { llmRequestHash } from "@worldtangle/engine";
import type {
  LlmProviderRoute,
  LlmRequest,
  LlmResult,
  RoutedLlmProvider,
} from "@worldtangle/engine";
import type { WorldDatabase } from "./persistence";
import { SqliteReplayStore } from "./persistence";

export class ReplayEvidenceLlmProvider implements RoutedLlmProvider {
  private nextExpectationOrdinal: number | undefined;

  constructor(
    private readonly provider: RoutedLlmProvider,
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  route(request: LlmRequest): LlmProviderRoute {
    return this.provider.route(request);
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    const requestHash = llmRequestHash(request);
    const store = new SqliteReplayStore(this.db, this.runId);
    const persistedOrdinal = store.nextLlmExpectationOrdinal();
    // The outer budget controller may commit a short-circuit call without invoking
    // this provider, so resynchronize the prepared-call cursor with persisted evidence.
    const ordinal = Math.max(this.nextExpectationOrdinal ?? persistedOrdinal, persistedOrdinal);
    this.nextExpectationOrdinal = ordinal + 1;
    const expected = store.llmExpectationAt(ordinal);
    if (expected === null || expected.requestHash !== requestHash) {
      return {
        ok: false,
        reason: "cache_miss",
        requestHash,
        detail: expected === null
          ? "replay journal has no LLM expectation for this call"
          : "replay LLM request hash differs from the source call",
        providerError: { provider: "cache", code: "cache_miss", retryable: false },
        attempts: 0,
      };
    }
    const route = this.route(request);
    if (route.provider !== expected.provider || route.model !== expected.model) {
      return {
        ok: false,
        reason: "cache_miss",
        requestHash,
        detail: "replay provider route differs from the source call",
        providerError: { provider: "cache", code: "cache_miss", retryable: false },
        attempts: 0,
      };
    }
    if (expected.status === "fallback" && expected.fallbackReason !== "validation_failed") {
      return {
        ok: false,
        reason: expected.fallbackReason!,
        requestHash,
        ...(expected.detail === undefined ? {} : { detail: expected.detail }),
        ...(expected.providerErrorCode === undefined
          ? {}
          : {
              providerError: {
                provider: expected.provider,
                code: expected.providerErrorCode,
                retryable: false,
              },
            }),
        attempts: expected.attempts,
      };
    }
    const replayed = await this.provider.propose(request);
    if (!replayed.ok) return replayed;
    return {
      ...replayed,
      model: expected.model,
      cached: expected.cached,
      inputTokens: expected.inputTokens,
      cachedInputTokens: expected.cachedInputTokens,
      outputTokens: expected.outputTokens,
      attempts: expected.attempts,
    };
  }
}
