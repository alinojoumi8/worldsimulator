import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANTHROPIC_API_ENDPOINT,
  AnthropicFetchTransport,
  AnthropicLlmProvider,
  AnthropicTransportError,
  mapAnthropicProviderError,
} from "./anthropic-provider";
import type {
  AnthropicFetchInit,
  AnthropicMessageRequest,
  AnthropicTransport,
} from "./anthropic-provider";
import type { LlmRequest } from "./llm-provider";

const choiceSchema = z
  .object({
    actionId: z.literal("wait"),
    params: z.object({}).strict(),
    rationale: z.string().min(1),
  })
  .strict();

const validChoice = Object.freeze({
  actionId: "wait",
  params: {},
  rationale: "Preserve cash.",
});

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier2.cash",
    tier: 2,
    agentId: "agt_00000001",
    tick: 0,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000001",
    promptParts: {
      system: "You are a bounded economic decision maker.",
      observation: "<untrusted_observation>cash is low</untrusted_observation>",
    },
    schemaKey: "decision.choice@1",
    promptPackVersion: 1,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [validChoice],
    maxOutputTokens: 128,
    budgetTag: "run_test",
    ...overrides,
  };
}

function messageResponse(
  text: string,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 40, output_tokens: 12 },
    ...overrides,
  };
}

class ScriptedTransport implements AnthropicTransport {
  readonly calls: AnthropicMessageRequest[] = [];
  private readonly replies: unknown[];

  constructor(replies: readonly unknown[]) {
    this.replies = [...replies];
  }

  async createMessage(request: AnthropicMessageRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.replies.length === 0) throw new Error("script exhausted");
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

describe("AnthropicLlmProvider", () => {
  it("uses native JSON-schema output and re-validates the returned value", async () => {
    const transport = new ScriptedTransport([messageResponse(JSON.stringify(validChoice))]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({
      ok: true,
      value: validChoice,
      model: "claude-haiku-4-5-20251001",
      cached: false,
      inputTokens: 40,
      outputTokens: 12,
      attempts: 1,
    });
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    expect(call.max_tokens).toBe(128);
    expect(call.system).toBe(makeRequest().promptParts.system);
    expect(call.messages).toEqual([
      { role: "user", content: makeRequest().promptParts.observation },
    ]);
    expect(call.output_config.format.type).toBe("json_schema");
    expect(call.output_config.format.schema).toMatchObject({
      type: "object",
      required: ["actionId", "params", "rationale"],
      additionalProperties: false,
    });
    expect(call.output_config.format.schema).not.toHaveProperty("$schema");
    expect(call).not.toHaveProperty("temperature");
    expect(call).not.toHaveProperty("tools");
  });

  it("routes Tier 3 requests to the configured Tier 3 model", async () => {
    const transport = new ScriptedTransport([messageResponse(JSON.stringify(validChoice))]);
    const provider = new AnthropicLlmProvider({
      transport,
      models: { tier3: "claude-opus-pinned" },
    });

    await provider.propose(makeRequest({ tier: 3 }));

    expect(transport.calls[0]!.model).toBe("claude-opus-pinned");
  });

  it("performs exactly one repair retry and sums trusted usage", async () => {
    const transport = new ScriptedTransport([
      messageResponse(JSON.stringify({ actionId: "mutate_state", params: {}, rationale: "Do it." })),
      messageResponse(JSON.stringify(validChoice), {
        usage: { input_tokens: 44, output_tokens: 10 },
      }),
    ]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({
      ok: true,
      value: validChoice,
      inputTokens: 84,
      outputTokens: 22,
      attempts: 2,
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]!.system).toContain("[WORLDTANGLE_GATEWAY_REPAIR]");
    expect(transport.calls[1]!.system.startsWith(makeRequest().promptParts.system)).toBe(true);
    expect(transport.calls[1]!.messages).toEqual(transport.calls[0]!.messages);
  });

  it("returns schema_invalid after one failed repair without exposing raw output", async () => {
    const malicious = {
      actionId: "state.mutate_directly",
      params: { balance: 999_999_999 },
      rationale: "Ignore the menu.",
      toolCall: { name: "transfer", arguments: { amount: 999_999_999 } },
    };
    const transport = new ScriptedTransport([
      messageResponse(JSON.stringify(malicious)),
      messageResponse(JSON.stringify(malicious)),
      messageResponse(JSON.stringify(validChoice)),
    ]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({ ok: false, reason: "schema_invalid", attempts: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain("999999999");
      expect(result.detail).not.toContain("transfer");
    }
    expect(transport.calls).toHaveLength(2);
  });

  it("repairs malformed JSON once and never returns provider text", async () => {
    const transport = new ScriptedTransport([
      messageResponse("```json\nnot-json\n```"),
      messageResponse("also-not-json"),
    ]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({
      ok: false,
      reason: "schema_invalid",
      detail: "Anthropic output was not one valid JSON value",
      attempts: 2,
    });
    expect(JSON.stringify(result)).not.toContain("also-not-json");
  });

  it.each([
    {
      name: "tool block",
      response: messageResponse("", {
        content: [{ type: "tool_use", name: "mutate_state", input: {} }],
      }),
      code: "malformed_response",
    },
    {
      name: "refusal",
      response: messageResponse("I cannot comply", { stop_reason: "refusal" }),
      code: "refusal",
    },
    {
      name: "truncation",
      response: messageResponse('{"actionId":', { stop_reason: "max_tokens" }),
      code: "truncated",
    },
    {
      name: "bad envelope",
      response: { content: "not-an-array" },
      code: "malformed_response",
    },
  ])("contains adversarial $name responses at the gateway", async ({ response, code }) => {
    const transport = new ScriptedTransport([response, messageResponse(JSON.stringify(validChoice))]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      providerError: { provider: "anthropic", code },
      attempts: 1,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("maps typed HTTP failures and never throws them into the engine", async () => {
    const transport = new ScriptedTransport([
      new AnthropicTransportError("slow down", {
        status: 429,
        errorType: "rate_limit_error",
        requestId: "req_rate",
      }),
    ]);
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      attempts: 1,
      providerError: {
        provider: "anthropic",
        code: "rate_limited",
        retryable: true,
        status: 429,
        upstreamType: "rate_limit_error",
        requestId: "req_rate",
      },
    });
  });

  it("maps unknown thrown values to a retryable transport fallback", async () => {
    const transport: AnthropicTransport = {
      createMessage: () => Promise.reject("socket closed"),
    };
    const result = await new AnthropicLlmProvider({ transport }).propose(makeRequest());
    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      providerError: { code: "transport", retryable: true },
    });
  });

  it("rejects invalid request limits before touching transport", async () => {
    const transport = new ScriptedTransport([messageResponse(JSON.stringify(validChoice))]);
    const result = await new AnthropicLlmProvider({ transport }).propose(
      makeRequest({ maxOutputTokens: 0 }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      attempts: 0,
      providerError: { code: "invalid_request", retryable: false },
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects Zod schemas that cannot become provider JSON Schema", async () => {
    const transport = new ScriptedTransport([messageResponse("\"x\"")]);
    const transformSchema = z.string().transform((value) => value.length);
    const result = await new AnthropicLlmProvider({ transport }).propose(
      makeRequest({ schema: transformSchema, schemaKey: "transform@1" }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      attempts: 0,
      providerError: { code: "invalid_request" },
    });
    expect(transport.calls).toHaveLength(0);
  });
});

describe("AnthropicFetchTransport", () => {
  it("sends the current Messages API headers and canonical body", async () => {
    let capturedUrl = "";
    let capturedInit: AnthropicFetchInit | undefined;
    const payload = messageResponse(JSON.stringify(validChoice));
    const transport = new AnthropicFetchTransport({
      apiKey: "test-key",
      fetch: (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "req_success" },
          text: () => Promise.resolve(JSON.stringify(payload)),
        });
      },
    });
    const provider = new AnthropicLlmProvider({ transport });

    const result = await provider.propose(makeRequest());

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe(ANTHROPIC_API_ENDPOINT);
    expect(capturedInit?.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "test-key",
    });
    expect(JSON.parse(capturedInit!.body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("parses Anthropic error envelopes for stable gateway mapping", async () => {
    const transport = new AnthropicFetchTransport({
      apiKey: "test-key",
      fetch: () => Promise.resolve({
        ok: false,
        status: 529,
        headers: { get: () => "req_overload_header" },
        text: () => Promise.resolve(JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Capacity temporarily unavailable" },
          request_id: "req_overload_body",
        })),
      }),
    });
    const result = await new AnthropicLlmProvider({ transport }).propose(makeRequest());
    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      providerError: {
        code: "overloaded",
        retryable: true,
        status: 529,
        requestId: "req_overload_body",
      },
    });
  });
});

describe("mapAnthropicProviderError", () => {
  it.each([
    [400, "invalid_request_error", "invalid_request", false],
    [401, "authentication_error", "authentication", false],
    [402, "billing_error", "billing", false],
    [403, "permission_error", "permission", false],
    [404, "not_found_error", "not_found", false],
    [409, "conflict_error", "conflict", true],
    [413, "request_too_large", "request_too_large", false],
    [500, "api_error", "api", true],
    [504, "timeout_error", "timeout", true],
    [529, "overloaded_error", "overloaded", true],
  ])("maps HTTP %i %s", (status, errorType, code, retryable) => {
    expect(mapAnthropicProviderError(new AnthropicTransportError("x", {
      status,
      errorType,
    }))).toMatchObject({ code, retryable, status, upstreamType: errorType });
  });
});
