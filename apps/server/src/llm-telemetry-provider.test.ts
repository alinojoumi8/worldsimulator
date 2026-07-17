import type { LlmRequest, RoutedLlmProvider } from "@worldtangle/engine";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimedLlmProvider } from "./llm-telemetry-provider";

const request: LlmRequest = {
  purpose: "decision.tier2.wait",
  tier: 2,
  tick: 1,
  moduleId: "agent_decisions",
  correlationId: "cor_1",
  causationId: "evt_1",
  promptParts: { system: "system", observation: "<observation />" },
  schemaKey: "wait@1",
  promptPackVersion: 1,
  schemaVersion: 1,
  schema: z.object({ actionId: z.literal("wait") }),
  options: [{ actionId: "wait" }],
  budgetTag: "test",
};

describe("TimedLlmProvider", () => {
  it("records bounded integer latency without changing the proposal", async () => {
    const provider: RoutedLlmProvider = {
      route: () => ({ provider: "mock", model: "mock-v1" }),
      propose: async () => ({
        ok: true,
        value: { actionId: "wait" },
        model: "mock-v1",
        cached: false,
        inputTokens: 4,
        outputTokens: 2,
        requestHash: "a".repeat(64),
        costMicrocents: "42",
      }),
    };
    const readings = [10.25, 12.01];
    const timed = new TimedLlmProvider(provider, () => readings.shift() ?? 0);

    await expect(timed.propose(request)).resolves.toMatchObject({
      ok: true,
      latencyMs: 2,
      costMicrocents: "42",
    });
    expect(timed.route(request)).toEqual({ provider: "mock", model: "mock-v1" });
  });

  it("uses zero when the operational clock is invalid", async () => {
    const provider: RoutedLlmProvider = {
      route: () => ({ provider: "mock", model: "mock-v1" }),
      propose: async () => ({
        ok: false,
        reason: "provider_error",
        requestHash: "b".repeat(64),
        attempts: 0,
        costMicrocents: "0",
      }),
    };
    const timed = new TimedLlmProvider(provider, () => Number.NaN);

    await expect(timed.propose(request)).resolves.toMatchObject({
      ok: false,
      latencyMs: 0,
    });
  });
});
