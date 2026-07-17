import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BudgetedLlmProvider,
  InMemoryLlmBudgetController,
  llmCostMicrocents,
  type LlmModelPrice,
  type LlmRequest,
  type LlmSuccess,
  MockLlmProvider,
} from "./index";

const choiceSchema = z.object({ actionId: z.literal("wait") }).strict();
const choice = Object.freeze({ actionId: "wait" });
const oneCentPerToken: LlmModelPrice = {
  inputMicrocentsPerToken: 1_000_000n,
  outputMicrocentsPerToken: 1_000_000n,
};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier3.demo",
    tier: 3,
    agentId: "agt_00000001",
    tick: 7,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000001",
    promptParts: { system: "system", observation: "<observation>safe</observation>" },
    schemaKey: "choice@1",
    promptPackVersion: 3,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [choice],
    maxOutputTokens: 32,
    budgetTag: "run_test",
    ...overrides,
  };
}

function success(tokens: number, model = "mock-priced"): LlmSuccess {
  return {
    ok: true,
    value: choice,
    model,
    cached: false,
    inputTokens: tokens,
    outputTokens: 0,
    requestHash: "a".repeat(64),
  };
}

function controller(options: {
  ceiling?: bigint;
  daily?: number;
  prices?: ReadonlyMap<string, LlmModelPrice>;
} = {}): InMemoryLlmBudgetController {
  return new InMemoryLlmBudgetController({
    runCostCeilingCents: options.ceiling ?? 100n,
    perAgentDailyTokens: options.daily ?? 1_000,
    prices: options.prices ?? new Map([["mock-priced", oneCentPerToken]]),
  });
}

describe("WS-603 LLM budget gateway", () => {
  it("calculates cost with exact integer microcents", () => {
    expect(llmCostMicrocents(11, 7, {
      inputMicrocentsPerToken: 300n,
      outputMicrocentsPerToken: 1_500n,
    })).toBe(13_800n);
    expect(llmCostMicrocents(10, 2, {
      inputMicrocentsPerToken: 100n,
      cachedInputMicrocentsPerToken: 20n,
      outputMicrocentsPerToken: 1_000n,
    }, 6)).toBe(2_520n);
    expect(() => llmCostMicrocents(10, 0, {
      inputMicrocentsPerToken: 100n,
      outputMicrocentsPerToken: 1_000n,
    }, 1)).toThrow(/cached input token price/);
    expect(() => llmCostMicrocents(10, 0, oneCentPerToken, 11)).toThrow(/within total/);
    expect(() => llmCostMicrocents(-1, 0, oneCentPerToken)).toThrow(/nonnegative/);
  });

  it("auto-pauses at a forced low run ceiling and blocks every later provider call", async () => {
    const budget = controller({ ceiling: 1n });
    const upstream = new MockLlmProvider({
      model: "mock-priced",
      script: new Map([["decision.tier3.demo", choice]]),
    });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: budget });

    expect(await provider.propose(request())).toMatchObject({
      ok: true,
      cached: false,
      costMicrocents: "15000000",
    });
    expect(budget.snapshot()).toMatchObject({
      warningEmitted: true,
      exhaustedEmitted: true,
      autoPauseRequested: true,
    });
    expect(budget.events.map((event) => event.type)).toEqual([
      "llm.usage.recorded",
      "llm.budget.threshold",
      "llm.budget.threshold",
      "simulation.auto_pause.requested",
    ]);

    expect(await provider.propose(request())).toMatchObject({
      ok: false,
      reason: "budget_blocked",
      effectiveTier: 1,
      degradationReason: "run_cost_exhausted",
      attempts: 0,
    });
    expect(upstream.calls).toHaveLength(1);
  });

  it("degrades Tier 3 to Tier 2 at 80 percent before invoking the provider", async () => {
    const budget = controller({ ceiling: 10n });
    const original = request();
    budget.recordSuccess({
      request: original,
      route: { provider: "mock", model: "mock-priced" },
      result: success(8),
      authorization: {
        disposition: "allow",
        requestedTier: 3,
        effectiveTier: 3,
        authorizedRunTick: original.tick,
      },
    });
    const upstream = new MockLlmProvider({
      model: "mock-priced",
      script: (input) => input.tier === 2 ? choice : undefined,
    });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: budget });

    expect(await provider.propose(original)).toMatchObject({
      ok: true,
      requestedTier: 3,
      effectiveTier: 2,
      degradationReason: "run_cost_warning",
    });
    expect(upstream.calls[0]?.tier).toBe(2);
  });

  it("enforces per-agent allowances independently for each simulated day", () => {
    const budget = controller({ ceiling: 1_000n, daily: 10 });
    const first = request();
    budget.recordSuccess({
      request: first,
      route: { provider: "mock", model: "mock-priced" },
      result: success(10),
      authorization: {
        disposition: "allow",
        requestedTier: 3,
        effectiveTier: 3,
        authorizedRunTick: first.tick,
      },
    });

    expect(budget.authorize(first)).toMatchObject({
      disposition: "block",
      degradationReason: "agent_daily_tokens_exhausted",
    });
    expect(budget.authorize(request({ tick: 8 }))).toMatchObject({ disposition: "allow" });
    expect(budget.authorize(request({ agentId: "agt_00000002" }))).toMatchObject({
      disposition: "allow",
    });
    expect(budget.events.map((event) => event.type)).toContain("llm.agent_budget.warning");
    expect(budget.events.map((event) => event.type)).toContain("llm.agent_budget.exhausted");
  });

  it("applies and reverses global, module, and agent kill switches without a restart", async () => {
    const budget = controller();
    const upstream = new MockLlmProvider({ model: "mock-priced", script: () => choice });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: budget });

    budget.setLlmEnabled(false);
    expect(await provider.propose(request())).toMatchObject({
      reason: "llm_off",
      degradationReason: "llm_disabled",
    });
    budget.setLlmEnabled(true);
    budget.setModuleFrozen("agent_decisions", true);
    expect(await provider.propose(request())).toMatchObject({
      reason: "llm_off",
      degradationReason: "module_frozen",
    });
    budget.setModuleFrozen("agent_decisions", false);
    budget.setAgentQuarantine("agt_00000001", 9);
    expect(await provider.propose(request())).toMatchObject({
      reason: "llm_off",
      degradationReason: "agent_quarantined",
    });
    budget.setAgentQuarantine("agt_00000001", undefined);

    expect(await provider.propose(request())).toMatchObject({ ok: true });
    expect(upstream.calls).toHaveLength(1);
  });

  it("does not charge cached responses and fails closed when pricing is absent", async () => {
    const budget = controller();
    const cachedProvider = {
      route: () => ({ provider: "mock", model: "mock-priced" }),
      propose: async (input: LlmRequest) => ({
        ...success(500),
        cached: true as const,
        requestHash: input.purpose.padEnd(64, "0").slice(0, 64),
      }),
    };
    expect(await new BudgetedLlmProvider({
      provider: cachedProvider,
      controller: budget,
    }).propose(request())).toMatchObject({ ok: true, cached: true, costMicrocents: "0" });
    expect(budget.snapshot().costMicrocents).toBe(0n);

    const unpriced = controller({ prices: new Map() });
    const upstream = new MockLlmProvider({ model: "unpriced", script: () => choice });
    expect(await new BudgetedLlmProvider({
      provider: upstream,
      controller: unpriced,
    }).propose(request())).toMatchObject({
      ok: false,
      reason: "provider_error",
      detail: "no exact LLM price for unpriced",
    });
  });
});
