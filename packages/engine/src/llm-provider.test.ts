import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "./llm-provider";
import { llmRequestHash, MockLlmProvider } from "./llm-provider";

const choiceSchema = z.object({ actionId: z.string(), params: z.record(z.string(), z.unknown()) });

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier2.demo",
    tier: 2,
    agentId: "agt_00000001",
    tick: 0,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000001",
    promptParts: { system: "You are Rosa Fern, a loan officer.", observation: "<obs>payday</obs>" },
    schemaKey: "tier2.choice@1",
    promptPackVersion: 1,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [
      { actionId: "do_nothing", params: {} },
      { actionId: "apply_for_job", params: { jobId: "job_00000001" } },
      { actionId: "buy_groceries", params: { sku: "groceries" } },
    ],
    budgetTag: "run_test0001",
    ...overrides,
  };
}

describe("llmRequestHash", () => {
  it("is stable for identical requests and sensitive to content", () => {
    expect(llmRequestHash(makeRequest())).toBe(llmRequestHash(makeRequest()));
    const other = makeRequest({ promptParts: { system: "x", observation: "y" } });
    expect(llmRequestHash(other)).not.toBe(llmRequestHash(makeRequest()));
    expect(llmRequestHash(makeRequest({ maxOutputTokens: 64 }))).not.toBe(
      llmRequestHash(makeRequest({ maxOutputTokens: 128 })),
    );
  });
});

describe("MockLlmProvider", () => {
  it("picks deterministically from options and validates against the schema", async () => {
    const provider = new MockLlmProvider();
    const first = await provider.propose(makeRequest());
    const second = await provider.propose(makeRequest());
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok) {
      expect(choiceSchema.safeParse(first.value).success).toBe(true);
      expect(first.inputTokens).toBeGreaterThan(0);
      expect(first.outputTokens).toBeGreaterThan(0);
      expect(first.model).toBe("mock-llm-v1");
    }
  });

  it("prefers scripted responses by purpose", async () => {
    const provider = new MockLlmProvider({
      script: new Map([
        ["decision.tier2.demo", { actionId: "scripted", params: { note: "from script" } }],
      ]),
    });
    const result = await provider.propose(makeRequest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ actionId: "scripted", params: { note: "from script" } });
  });

  it("supports script functions", async () => {
    const provider = new MockLlmProvider({
      script: (request) =>
        request.tier === 2 ? { actionId: "fn_choice", params: {} } : undefined,
    });
    const result = await provider.propose(makeRequest());
    expect(result.ok && result.value).toEqual({ actionId: "fn_choice", params: {} });
  });

  it("returns a schema_invalid fallback signal for bad scripted output (never throws)", async () => {
    const provider = new MockLlmProvider({
      script: new Map([["decision.tier2.demo", { wrong: "shape" }]]),
    });
    const result = await provider.propose(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema_invalid");
  });

  it("returns provider_error when it has nothing to answer with", async () => {
    const provider = new MockLlmProvider();
    const result = await provider.propose(makeRequest({ options: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_error");
  });

  it("records calls for test assertions", async () => {
    const provider = new MockLlmProvider();
    await provider.propose(makeRequest());
    await provider.propose(makeRequest({ purpose: "decision.tier2.other" }));
    expect(provider.calls.map((c) => c.purpose)).toEqual([
      "decision.tier2.demo",
      "decision.tier2.other",
    ]);
  });
});
