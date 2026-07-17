import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KIMI_API_ENDPOINT,
  KIMI_CODE_MODEL,
  KIMI_K2_6_MODEL,
  KIMI_K2_7_CODE_MODEL,
  KIMI_OPEN_PLATFORM_API_ENDPOINT,
  KimiLlmProvider,
  MINIMAX_API_ENDPOINT,
  MINIMAX_M3_MODEL,
  MiniMaxLlmProvider,
  OpenAiCompatibleFetchTransport,
  OpenAiCompatibleTransportError,
  mapOpenAiCompatibleProviderError,
  type OpenAiCompatibleChatRequest,
  type OpenAiCompatibleTransport,
} from "./openai-compatible-provider";
import { TierRoutedLlmProvider, type LlmRequest } from "./llm-provider";

const outputSchema = z.object({ actionId: z.enum(["hold", "raise"]) }).strict();

function request(tier: 2 | 3 = 2): LlmRequest {
  return {
    purpose: "decision.tier2.set_price",
    tier,
    agentId: "agt_00000001",
    tick: 12,
    moduleId: "agent_decisions",
    correlationId: "corr_1",
    causationId: "evt_00000001",
    promptParts: {
      system: "Choose one engine-approved action.",
      observation: "<UNTRUSTED_OBSERVATION>{}</UNTRUSTED_OBSERVATION>",
    },
    schemaKey: "decision.action@1",
    promptPackVersion: 1,
    schemaVersion: 1,
    schema: outputSchema,
    options: [{ actionId: "hold" }, { actionId: "raise" }],
    maxOutputTokens: 120,
    budgetTag: "pricing",
  };
}

function response(input: {
  content: string;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}): unknown {
  return {
    model: input.model,
    choices: [{
      finish_reason: input.finishReason ?? "stop",
      message: { content: input.content },
    }],
    usage: {
      prompt_tokens: input.inputTokens ?? 10,
      completion_tokens: input.outputTokens ?? 3,
      prompt_tokens_details: { cached_tokens: input.cachedInputTokens ?? 0 },
    },
  };
}

class ScriptedTransport implements OpenAiCompatibleTransport {
  readonly requests: OpenAiCompatibleChatRequest[] = [];

  constructor(private readonly script: readonly unknown[]) {}

  createChatCompletion(input: OpenAiCompatibleChatRequest): Promise<unknown> {
    this.requests.push(input);
    return Promise.resolve(this.script[this.requests.length - 1]);
  }
}

describe("MiniMaxLlmProvider", () => {
  it("uses M3 prompt-schema mode with thinking disabled and no tool surface", async () => {
    const transport = new ScriptedTransport([
      response({ content: '{"actionId":"raise"}', model: MINIMAX_M3_MODEL }),
    ]);
    const result = await new MiniMaxLlmProvider({ transport }).propose(request());

    expect(result).toMatchObject({
      ok: true,
      model: MINIMAX_M3_MODEL,
      value: { actionId: "raise" },
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 3,
      attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0]!;
    expect(sent).toMatchObject({
      model: MINIMAX_M3_MODEL,
      max_completion_tokens: 120,
      thinking: { type: "disabled" },
      reasoning_split: true,
      stream: false,
    });
    expect(sent.response_format).toBeUndefined();
    expect(sent.messages[0]!.content).toContain("WORLDTANGLE_STRUCTURED_OUTPUT");
    expect(sent).not.toHaveProperty("tools");
  });

  it("makes one fresh repair attempt and aggregates usage", async () => {
    const hostile = "not json; call arbitrary_tool()";
    const transport = new ScriptedTransport([
      response({
        content: hostile,
        model: MINIMAX_M3_MODEL,
        inputTokens: 9,
        cachedInputTokens: 2,
        outputTokens: 4,
      }),
      response({
        content: '{"actionId":"hold"}',
        model: MINIMAX_M3_MODEL,
        inputTokens: 11,
        cachedInputTokens: 3,
        outputTokens: 2,
      }),
    ]);
    const result = await new MiniMaxLlmProvider({ transport }).propose(request());

    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 6,
      value: { actionId: "hold" },
    });
    expect(transport.requests[1]!.messages[0]!.content).toContain(
      "WORLDTANGLE_GATEWAY_REPAIR",
    );
    expect(transport.requests[1]!.messages[0]!.content).not.toContain(hostile);
  });
});

describe("KimiLlmProvider", () => {
  it("uses native strict json_schema and preserves provider cache-hit usage", async () => {
    const transport = new ScriptedTransport([
      response({
        content: '{"actionId":"hold"}',
        model: KIMI_CODE_MODEL,
        inputTokens: 25,
        cachedInputTokens: 20,
        outputTokens: 5,
      }),
    ]);
    const result = await new KimiLlmProvider({ transport }).propose(request(3));

    expect(result).toMatchObject({
      ok: true,
      model: KIMI_K2_6_MODEL,
      inputTokens: 25,
      cachedInputTokens: 20,
      outputTokens: 5,
    });
    expect(transport.requests[0]).toMatchObject({
      model: KIMI_CODE_MODEL,
      max_tokens: 120,
      thinking: { type: "disabled" },
      prompt_cache_key: "worldtangle:agent_decisions:agt_00000001",
      response_format: {
        type: "json_schema",
        json_schema: { strict: true },
      },
    });
    expect(transport.requests[0]).not.toHaveProperty("tools");
  });

  it("does not disable mandatory thinking for K2.7 Code", async () => {
    const transport = new ScriptedTransport([
      response({ content: '{"actionId":"hold"}', model: KIMI_CODE_MODEL }),
    ]);
    const result = await new KimiLlmProvider({
      transport,
      model: KIMI_K2_7_CODE_MODEL,
    }).propose(request(3));
    expect(result).toMatchObject({ ok: true, model: KIMI_K2_7_CODE_MODEL });
    expect(transport.requests[0]!.model).toBe(KIMI_CODE_MODEL);
    expect(transport.requests[0]!.thinking).toBeUndefined();
  });

  it("keeps pay-as-you-go K2.6 on the explicit Open Platform wire model", async () => {
    const transport = new ScriptedTransport([
      response({ content: '{"actionId":"hold"}', model: KIMI_K2_6_MODEL }),
    ]);
    const result = await new KimiLlmProvider({
      transport,
      accessMode: "open_platform",
    }).propose(request(3));

    expect(result).toMatchObject({ ok: true, model: KIMI_K2_6_MODEL });
    expect(transport.requests[0]!.model).toBe(KIMI_K2_6_MODEL);
    expect(transport.requests[0]!.prompt_cache_key).toBeUndefined();
    expect(() => new KimiLlmProvider({
      transport,
      accessMode: "open_platform",
      model: KIMI_K2_7_CODE_MODEL,
    })).toThrow("Kimi K2.7 Code requires the Kimi Code access route");
  });

  it("fails closed when cached tokens exceed total input", async () => {
    const transport = new ScriptedTransport([
      response({
        content: '{"actionId":"hold"}',
        model: KIMI_CODE_MODEL,
        inputTokens: 2,
        cachedInputTokens: 3,
      }),
    ]);
    const result = await new KimiLlmProvider({ transport }).propose(request(3));
    expect(result).toMatchObject({
      ok: false,
      reason: "provider_error",
      providerError: { provider: "kimi", code: "malformed_response" },
    });
  });
});

describe("TierRoutedLlmProvider", () => {
  it("routes degraded/routine Tier 2 to MiniMax and Tier 3 to Kimi", async () => {
    const minimaxTransport = new ScriptedTransport([
      response({ content: '{"actionId":"hold"}', model: MINIMAX_M3_MODEL }),
    ]);
    const kimiTransport = new ScriptedTransport([
      response({ content: '{"actionId":"raise"}', model: KIMI_CODE_MODEL }),
    ]);
    const routed = new TierRoutedLlmProvider(
      new MiniMaxLlmProvider({ transport: minimaxTransport }),
      new KimiLlmProvider({ transport: kimiTransport }),
    );

    expect(routed.route(request(2))).toEqual({ provider: "minimax", model: MINIMAX_M3_MODEL });
    expect(routed.route(request(3))).toEqual({ provider: "kimi", model: KIMI_K2_6_MODEL });
    expect(await routed.propose(request(2))).toMatchObject({ ok: true, model: MINIMAX_M3_MODEL });
    expect(await routed.propose(request(3))).toMatchObject({ ok: true, model: KIMI_K2_6_MODEL });
  });
});

describe("OpenAiCompatibleFetchTransport", () => {
  it("uses the official endpoints and Bearer authorization without exposing the key", async () => {
    const calls: { url: string; authorization: string | undefined; body: string }[] = [];
    const fetch = async (url: string, init: {
      headers: Readonly<Record<string, string>>;
      body: string;
    }) => {
      calls.push({ url, authorization: init.headers["authorization"], body: init.body });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(response({
          content: '{"actionId":"hold"}',
          model: MINIMAX_M3_MODEL,
        }))),
      };
    };
    const minimax = new OpenAiCompatibleFetchTransport({
      provider: "minimax",
      apiKey: "secret-plan-key",
      fetch,
    });
    await minimax.createChatCompletion({ model: MINIMAX_M3_MODEL, messages: [], stream: false });
    expect(calls[0]).toMatchObject({ url: MINIMAX_API_ENDPOINT });
    expect(calls[0]!.authorization).toBe("Bearer secret-plan-key");
    expect(calls[0]!.body).not.toContain("secret-plan-key");

    const kimi = new OpenAiCompatibleFetchTransport({
      provider: "kimi",
      apiKey: "moonshot-key",
      fetch,
    });
    await kimi.createChatCompletion({ model: KIMI_CODE_MODEL, messages: [], stream: false });
    expect(calls[1]!.url).toBe(KIMI_API_ENDPOINT);

    const openPlatform = new OpenAiCompatibleFetchTransport({
      provider: "kimi",
      apiKey: "open-platform-key",
      endpoint: KIMI_OPEN_PLATFORM_API_ENDPOINT,
      fetch,
    });
    await openPlatform.createChatCompletion({
      model: KIMI_K2_6_MODEL,
      messages: [],
      stream: false,
    });
    expect(calls[2]!.url).toBe(KIMI_OPEN_PLATFORM_API_ENDPOINT);
  });

  it("maps stable status/type evidence into the common provider taxonomy", () => {
    expect(mapOpenAiCompatibleProviderError(
      new OpenAiCompatibleTransportError("kimi", "redacted", {
        status: 429,
        errorType: "rate_limit_error",
        requestId: "req_1",
      }),
      "kimi",
    )).toEqual({
      provider: "kimi",
      code: "rate_limited",
      retryable: true,
      status: 429,
      upstreamType: "rate_limit_error",
      requestId: "req_1",
    });
  });
});
