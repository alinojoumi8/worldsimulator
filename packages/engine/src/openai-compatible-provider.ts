/**
 * Strict OpenAI-compatible adapters for MiniMax M3 and Kimi K2.x.
 *
 * Both providers remain proposal-only: requests contain no tools, successful
 * output is parsed as one JSON value and validated against the engine-owned
 * Zod schema, and one bounded repair attempt is allowed. Provider text never
 * becomes executable input or direct state mutation.
 */

import { canonicalStringify } from "@worldtangle/shared";
import { z } from "zod";
import type { LlmModelPrice } from "./llm-budget";
import type {
  LlmFallback,
  LlmProviderError,
  LlmProviderErrorCode,
  LlmProviderRoute,
  LlmRequest,
  LlmResult,
  LlmSuccess,
  RoutedLlmProvider,
} from "./llm-provider";
import { llmRequestHash } from "./llm-provider";

export const MINIMAX_API_ENDPOINT = "https://api.minimax.io/v1/chat/completions";
export const KIMI_CODE_API_ENDPOINT = "https://api.kimi.com/coding/v1/chat/completions";
export const KIMI_OPEN_PLATFORM_API_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
/** Default Kimi endpoint: membership/Token Plan credentials use Kimi Code. */
export const KIMI_API_ENDPOINT = KIMI_CODE_API_ENDPOINT;
export const MINIMAX_M3_MODEL = "MiniMax-M3";
export const KIMI_K2_6_MODEL = "kimi-k2.6";
export const KIMI_K2_7_CODE_MODEL = "kimi-k2.7-code";
export const KIMI_CODE_MODEL = "kimi-for-coding";
export const KIMI_SUPPORTED_MODELS = Object.freeze([
  KIMI_K2_6_MODEL,
  KIMI_K2_7_CODE_MODEL,
] as const);
export type KimiModel = (typeof KIMI_SUPPORTED_MODELS)[number];
export const KIMI_ACCESS_MODES = Object.freeze(["code_plan", "open_platform"] as const);
export type KimiAccessMode = (typeof KIMI_ACCESS_MODES)[number];

/** Pinned reference rates in integer microcents/token; runtime overrides remain supported. */
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES: ReadonlyMap<string, LlmModelPrice> =
  new Map<string, LlmModelPrice>([
    [MINIMAX_M3_MODEL, Object.freeze({
      inputMicrocentsPerToken: 30n,
      cachedInputMicrocentsPerToken: 6n,
      outputMicrocentsPerToken: 120n,
    })],
    [KIMI_K2_6_MODEL, Object.freeze({
      inputMicrocentsPerToken: 95n,
      cachedInputMicrocentsPerToken: 16n,
      outputMicrocentsPerToken: 400n,
    })],
    [KIMI_K2_7_CODE_MODEL, Object.freeze({
      inputMicrocentsPerToken: 95n,
      cachedInputMicrocentsPerToken: 19n,
      outputMicrocentsPerToken: 400n,
    })],
  ]);

const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 131_072;
const REPAIR_SYSTEM_SUFFIX = [
  "[WORLDTANGLE_GATEWAY_REPAIR]",
  "The previous response failed strict local structured-output validation.",
  "Generate a fresh response matching the supplied JSON schema exactly.",
  "Return one JSON value only, with no prose, tools, or additional fields.",
].join(" ");
const PROMPT_SCHEMA_PREFIX = [
  "[WORLDTANGLE_STRUCTURED_OUTPUT]",
  "Return exactly one JSON value matching this JSON Schema.",
  "Do not return Markdown, prose, tool calls, or fields outside the schema.",
].join(" ");

type JsonObject = Readonly<Record<string, unknown>>;
type ProviderId = "minimax" | "kimi";
type StructuredOutputMode = "native_json_schema" | "prompt_json_schema";

export interface OpenAiCompatibleChatRequest {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
  readonly stream: false;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: {
      readonly name: string;
      readonly strict: true;
      readonly schema: JsonObject;
    };
  };
  readonly prompt_cache_key?: string;
  readonly thinking?: { readonly type: "disabled" };
  readonly reasoning_split?: true;
}

/** Transport returns untrusted JSON; adapters own all envelope/output validation. */
export interface OpenAiCompatibleTransport {
  createChatCompletion(request: OpenAiCompatibleChatRequest): Promise<unknown>;
}

export interface OpenAiCompatibleFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface OpenAiCompatibleFetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type OpenAiCompatibleFetch = (
  url: string,
  init: OpenAiCompatibleFetchInit,
) => Promise<OpenAiCompatibleFetchResponse>;

export class OpenAiCompatibleTransportError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  readonly errorType?: string;
  readonly requestId?: string;

  constructor(
    provider: ProviderId,
    message: string,
    options: Readonly<{ status?: number; errorType?: string; requestId?: string }> = {},
  ) {
    super(message);
    this.name = "OpenAiCompatibleTransportError";
    this.provider = provider;
    this.status = options.status;
    this.errorType = options.errorType;
    this.requestId = options.requestId;
  }
}

export interface OpenAiCompatibleFetchTransportOptions {
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetch?: OpenAiCompatibleFetch;
}

const providerErrorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string().min(1).optional(),
    type: z.union([z.string(), z.number()]).optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }).passthrough().optional(),
  base_resp: z.object({
    status_code: z.union([z.string(), z.number()]).optional(),
    status_msg: z.string().min(1).optional(),
  }).passthrough().optional(),
  request_id: z.string().min(1).optional(),
}).passthrough();

function defaultFetch(
  url: string,
  init: OpenAiCompatibleFetchInit,
): Promise<OpenAiCompatibleFetchResponse> {
  return globalThis.fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
  });
}

function boundedMessage(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length <= 500 ? normalized : normalized.slice(0, 500) + "...";
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function endpointFor(provider: ProviderId): string {
  return provider === "minimax" ? MINIMAX_API_ENDPOINT : KIMI_API_ENDPOINT;
}

/** Minimal dependency-free Bearer transport shared by MiniMax and Kimi. */
export class OpenAiCompatibleFetchTransport implements OpenAiCompatibleTransport {
  private readonly provider: ProviderId;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetch: OpenAiCompatibleFetch;

  constructor(options: OpenAiCompatibleFetchTransportOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0 || /[\r\n]/.test(apiKey)) {
      throw new RangeError(`${options.provider} API key must be a non-empty single-line value`);
    }
    const endpoint = (options.endpoint ?? endpointFor(options.provider)).trim();
    if (endpoint.length === 0 || /[\r\n]/.test(endpoint)) {
      throw new RangeError(`${options.provider} endpoint must be a non-empty single-line value`);
    }
    this.provider = options.provider;
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.fetch = options.fetch ?? defaultFetch;
  }

  async createChatCompletion(request: OpenAiCompatibleChatRequest): Promise<unknown> {
    let response: OpenAiCompatibleFetchResponse;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: canonicalStringify(request),
      });
    } catch (error) {
      throw new OpenAiCompatibleTransportError(
        this.provider,
        error instanceof Error ? boundedMessage(error.message) : "provider network request failed",
        { errorType: "network_error" },
      );
    }

    const headerRequestId = response.headers.get("x-request-id") ??
      response.headers.get("request-id") ?? undefined;
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new OpenAiCompatibleTransportError(
        this.provider,
        error instanceof Error ? boundedMessage(error.message) : "provider response read failed",
        { status: response.status, errorType: "network_error", requestId: headerRequestId },
      );
    }
    const decoded = parseJson(body);
    if (!response.ok) {
      const envelope = providerErrorEnvelopeSchema.safeParse(decoded);
      const errorType = envelope.success
        ? String(
            envelope.data.error?.type ??
            envelope.data.error?.code ??
            envelope.data.base_resp?.status_code ??
            "http_error",
          )
        : "http_error";
      const message = envelope.success
        ? envelope.data.error?.message ??
          envelope.data.base_resp?.status_msg ??
          `provider request failed with HTTP ${response.status}`
        : `provider request failed with HTTP ${response.status}`;
      throw new OpenAiCompatibleTransportError(this.provider, boundedMessage(message), {
        status: response.status,
        errorType,
        requestId: envelope.success
          ? envelope.data.request_id ?? headerRequestId
          : headerRequestId,
      });
    }
    if (decoded === undefined) {
      throw new OpenAiCompatibleTransportError(
        this.provider,
        "provider returned a non-JSON success response",
        { status: response.status, errorType: "malformed_response", requestId: headerRequestId },
      );
    }
    return decoded;
  }
}

const chatResponseSchema = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      content: z.string().nullable(),
      refusal: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough()),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().safe(),
    completion_tokens: z.number().int().nonnegative().safe(),
    cached_tokens: z.number().int().nonnegative().safe().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().safe().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

function providerCodeFromStatus(status: number | undefined): LlmProviderErrorCode {
  if (status === undefined) return "transport";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 402) return "billing";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "overloaded";
  if (status >= 500) return "api";
  return "unknown";
}

function providerCodeFromType(type: string | undefined): LlmProviderErrorCode | undefined {
  if (type === undefined) return undefined;
  const normalized = type.toLowerCase();
  const exact: Readonly<Record<string, LlmProviderErrorCode>> = {
    invalid_request_error: "invalid_request",
    authentication_error: "authentication",
    billing_error: "billing",
    permission_error: "permission",
    not_found_error: "not_found",
    conflict_error: "conflict",
    rate_limit_error: "rate_limited",
    timeout_error: "timeout",
    overloaded_error: "overloaded",
    network_error: "transport",
    malformed_response: "malformed_response",
  };
  return exact[normalized];
}

function retryableProviderCode(code: LlmProviderErrorCode): boolean {
  return code === "conflict" || code === "rate_limited" || code === "api" ||
    code === "timeout" || code === "overloaded" || code === "transport" ||
    code === "truncated";
}

/** Stable failure mapping uses only HTTP status and upstream type/code fields. */
export function mapOpenAiCompatibleProviderError(
  error: unknown,
  provider: ProviderId,
): LlmProviderError {
  if (error instanceof OpenAiCompatibleTransportError) {
    const code = providerCodeFromType(error.errorType) ?? providerCodeFromStatus(error.status);
    return {
      provider,
      code,
      retryable: retryableProviderCode(code),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.errorType === undefined ? {} : { upstreamType: error.errorType }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return { provider, code: "transport", retryable: true };
}

interface OpenAiCompatibleProviderOptions {
  readonly provider: ProviderId;
  readonly transport: OpenAiCompatibleTransport;
  /** Stable model identity used for routing, budgets, journals, and replay. */
  readonly model: string;
  /** Provider-facing alias when a subscription gateway hides the logical model. */
  readonly wireModel?: string;
  readonly structuredOutput: StructuredOutputMode;
  readonly thinking: "disabled" | "provider_required";
  readonly promptCache?: boolean;
  readonly defaultMaxOutputTokens?: number;
}

interface CandidateSuccess {
  readonly ok: true;
  readonly value: unknown;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

interface CandidateFailure {
  readonly ok: false;
  readonly reason: "schema_invalid" | "provider_error";
  readonly detail: string;
  readonly repairable: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly providerError?: LlmProviderError;
}

type CandidateResult = CandidateSuccess | CandidateFailure;

function jsonSchemaFor(schema: z.ZodType<unknown>): JsonObject {
  const converted = z.toJSONSchema(schema);
  if (converted === null || typeof converted !== "object" || Array.isArray(converted)) {
    throw new TypeError("Zod schema did not convert to a JSON Schema object");
  }
  const providerSchema: Record<string, unknown> = { ...converted };
  delete providerSchema.$schema;
  const normalized = JSON.parse(canonicalStringify(providerSchema)) as unknown;
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("converted JSON Schema is not an object");
  }
  return normalized as JsonObject;
}

function validatedTokenLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS) {
    throw new RangeError(`maxOutputTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`);
  }
  return value;
}

function schemaName(request: LlmRequest): string {
  const normalized = `${request.schemaKey}_v${request.schemaVersion}`
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 56);
  return `wt_${normalized}`;
}

function promptCacheKey(request: LlmRequest): string {
  return `worldtangle:${request.moduleId}:${request.agentId}`
    .replace(/[^A-Za-z0-9:_-]/g, "_")
    .slice(0, 128);
}

function buildChatRequest(
  request: LlmRequest,
  profile: Readonly<{
    provider: ProviderId;
    model: string;
    structuredOutput: StructuredOutputMode;
    thinking: "disabled" | "provider_required";
    promptCache: boolean;
  }>,
  maxOutputTokens: number,
  schema: JsonObject,
  repair: boolean,
): OpenAiCompatibleChatRequest {
  const schemaInstruction = profile.structuredOutput === "prompt_json_schema"
    ? `\n\n${PROMPT_SCHEMA_PREFIX}\n${canonicalStringify(schema)}`
    : "";
  const repairInstruction = repair ? `\n\n${REPAIR_SYSTEM_SUFFIX}` : "";
  const common = {
    model: profile.model,
    messages: [
      {
        role: "system" as const,
        content: request.promptParts.system + schemaInstruction + repairInstruction,
      },
      { role: "user" as const, content: request.promptParts.observation },
    ],
    stream: false as const,
    ...(profile.promptCache ? { prompt_cache_key: promptCacheKey(request) } : {}),
  };
  if (profile.provider === "minimax") {
    return {
      ...common,
      max_completion_tokens: maxOutputTokens,
      thinking: { type: "disabled" },
      reasoning_split: true,
    };
  }
  return {
    ...common,
    max_tokens: maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName(request), strict: true, schema },
    },
    ...(profile.thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
  };
}

function fixedProviderError(
  provider: ProviderId,
  code: LlmProviderErrorCode,
  retryable: boolean,
): LlmProviderError {
  return { provider, code, retryable };
}

function decodeCandidate(
  raw: unknown,
  request: LlmRequest,
  provider: ProviderId,
): CandidateResult {
  const response = chatResponseSchema.safeParse(raw);
  if (!response.success || response.data.choices.length !== 1) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} response envelope failed validation`,
      repairable: false,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      providerError: fixedProviderError(provider, "malformed_response", false),
    };
  }
  const choice = response.data.choices[0]!;
  const inputTokens = response.data.usage.prompt_tokens;
  const cachedInputTokens = response.data.usage.prompt_tokens_details?.cached_tokens ??
    response.data.usage.cached_tokens ?? 0;
  const outputTokens = response.data.usage.completion_tokens;
  if (cachedInputTokens > inputTokens) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} reported more cached than total input tokens`,
      repairable: false,
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      providerError: fixedProviderError(provider, "malformed_response", false),
    };
  }
  if (choice.message.refusal !== undefined && choice.message.refusal !== null) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} refused the structured-output request`,
      repairable: false,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      providerError: fixedProviderError(provider, "refusal", false),
    };
  }
  if (choice.finish_reason === "length") {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} structured output reached the token limit`,
      repairable: false,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      providerError: fixedProviderError(provider, "truncated", true),
    };
  }
  if (choice.finish_reason !== "stop") {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} structured output ended unexpectedly`,
      repairable: false,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      providerError: fixedProviderError(provider, "malformed_response", false),
    };
  }
  if (choice.message.content === null) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${provider} response contained no structured content`,
      repairable: false,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      providerError: fixedProviderError(provider, "malformed_response", false),
    };
  }
  const candidate = parseJson(choice.message.content);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: `${provider} output was not one valid JSON value`,
      repairable: true,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    };
  }
  const parsed = request.schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: `${provider} output failed ${request.schemaKey} with ${parsed.error.issues.length} issue(s)`,
      repairable: true,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    };
  }
  return {
    ok: true,
    value: parsed.data,
    model: response.data.model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

/** Shared strict adapter; exported mainly for contract testing and future OSS endpoints. */
export class OpenAiCompatibleLlmProvider implements RoutedLlmProvider {
  private readonly provider: ProviderId;
  private readonly transport: OpenAiCompatibleTransport;
  private readonly model: string;
  private readonly wireModel: string;
  private readonly structuredOutput: StructuredOutputMode;
  private readonly thinking: "disabled" | "provider_required";
  private readonly promptCache: boolean;
  private readonly defaultMaxOutputTokens: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    const model = options.model.trim();
    if (model.length === 0 || /[\r\n]/.test(model)) {
      throw new RangeError(`${options.provider} model must be a non-empty single-line value`);
    }
    const wireModel = (options.wireModel ?? model).trim();
    if (wireModel.length === 0 || /[\r\n]/.test(wireModel)) {
      throw new RangeError(`${options.provider} wire model must be a non-empty single-line value`);
    }
    this.provider = options.provider;
    this.transport = options.transport;
    this.model = model;
    this.wireModel = wireModel;
    this.structuredOutput = options.structuredOutput;
    this.thinking = options.thinking;
    this.promptCache = options.promptCache ?? false;
    this.defaultMaxOutputTokens = validatedTokenLimit(
      options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    );
  }

  route(): LlmProviderRoute {
    return { provider: this.provider, model: this.model };
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    const requestHash = llmRequestHash(request);
    let schema: JsonObject;
    let maxOutputTokens: number;
    try {
      schema = jsonSchemaFor(request.schema);
      maxOutputTokens = validatedTokenLimit(
        request.maxOutputTokens ?? this.defaultMaxOutputTokens,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash,
        detail: error instanceof Error ? boundedMessage(error.message) : "invalid LLM request",
        providerError: fixedProviderError(this.provider, "invalid_request", false),
        attempts: 0,
      } satisfies LlmFallback;
    }

    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let raw: unknown;
      try {
        raw = await this.transport.createChatCompletion(buildChatRequest(
          request,
          {
            provider: this.provider,
            model: this.wireModel,
            structuredOutput: this.structuredOutput,
            thinking: this.thinking,
            promptCache: this.promptCache,
          },
          maxOutputTokens,
          schema,
          attempt === 2,
        ));
      } catch (error) {
        return {
          ok: false,
          reason: "provider_error",
          requestHash,
          detail: error instanceof Error ? boundedMessage(error.message) : `${this.provider} transport failed`,
          providerError: mapOpenAiCompatibleProviderError(error, this.provider),
          attempts: attempt,
        } satisfies LlmFallback;
      }
      const candidate = decodeCandidate(raw, request, this.provider);
      inputTokens += candidate.inputTokens;
      cachedInputTokens += candidate.cachedInputTokens;
      outputTokens += candidate.outputTokens;
      if (candidate.ok) {
        return {
          ok: true,
          value: candidate.value,
          model: this.wireModel === this.model ? candidate.model : this.model,
          cached: false,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          requestHash,
          attempts: attempt,
        } satisfies LlmSuccess;
      }
      if (!candidate.repairable || attempt === 2) {
        return {
          ok: false,
          reason: candidate.reason,
          requestHash,
          detail: candidate.detail,
          ...(candidate.providerError === undefined
            ? {}
            : { providerError: candidate.providerError }),
          attempts: attempt,
        } satisfies LlmFallback;
      }
    }
    return {
      ok: false,
      reason: "provider_error",
      requestHash,
      detail: `${this.provider} repair ladder exhausted unexpectedly`,
      providerError: fixedProviderError(this.provider, "unknown", false),
      attempts: 2,
    } satisfies LlmFallback;
  }
}

export interface MiniMaxLlmProviderOptions {
  readonly transport: OpenAiCompatibleTransport;
  readonly model?: string;
  readonly defaultMaxOutputTokens?: number;
}

/** MiniMax M3 uses schema-in-prompt plus strict local validation. */
export class MiniMaxLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(options: MiniMaxLlmProviderOptions) {
    super({
      provider: "minimax",
      transport: options.transport,
      model: options.model ?? MINIMAX_M3_MODEL,
      structuredOutput: "prompt_json_schema",
      thinking: "disabled",
      ...(options.defaultMaxOutputTokens === undefined
        ? {}
        : { defaultMaxOutputTokens: options.defaultMaxOutputTokens }),
    });
  }
}

export interface KimiLlmProviderOptions {
  readonly transport: OpenAiCompatibleTransport;
  readonly model?: KimiModel;
  /** Kimi Code Token Plan by default; Open Platform is an explicit compatibility route. */
  readonly accessMode?: KimiAccessMode;
  readonly defaultMaxOutputTokens?: number;
}

/** Kimi uses native json_schema output with deterministic logical-to-wire routing. */
export class KimiLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(options: KimiLlmProviderOptions) {
    const model = options.model ?? KIMI_K2_6_MODEL;
    if (!(KIMI_SUPPORTED_MODELS as readonly string[]).includes(model)) {
      throw new RangeError(`unsupported Kimi model ${model}`);
    }
    const accessMode = options.accessMode ?? "code_plan";
    if (!(KIMI_ACCESS_MODES as readonly string[]).includes(accessMode)) {
      throw new RangeError(`unsupported Kimi access mode ${accessMode}`);
    }
    if (accessMode === "open_platform" && model !== KIMI_K2_6_MODEL) {
      throw new RangeError("Kimi K2.7 Code requires the Kimi Code access route");
    }
    super({
      provider: "kimi",
      transport: options.transport,
      model,
      wireModel: accessMode === "code_plan" ? KIMI_CODE_MODEL : model,
      structuredOutput: "native_json_schema",
      thinking: model === KIMI_K2_6_MODEL ? "disabled" : "provider_required",
      promptCache: accessMode === "code_plan",
      ...(options.defaultMaxOutputTokens === undefined
        ? {}
        : { defaultMaxOutputTokens: options.defaultMaxOutputTokens }),
    });
  }
}
