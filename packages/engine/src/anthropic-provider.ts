/**
 * Anthropic Messages API adapter for the M21 LLM gateway.
 *
 * The provider accepts only native JSON-schema output, re-validates the parsed
 * value with the request's Zod schema, retries one repairable output failure,
 * and converts every other failure into an `LlmFallback`. It never returns raw
 * provider text and never exposes a state-mutation or tool-execution surface.
 */

import { canonicalStringify } from "@worldtangle/shared";
import { z } from "zod";
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

export const ANTHROPIC_API_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MODELS = Object.freeze({
  tier2: "claude-haiku-4-5-20251001",
  tier3: "claude-sonnet-5",
});

const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 128_000;
const REPAIR_SYSTEM_SUFFIX = [
  "[WORLDTANGLE_GATEWAY_REPAIR]",
  "The previous structured response failed strict local validation.",
  "Generate a fresh response that matches the supplied JSON schema exactly.",
  "Do not add prose, tool calls, or fields outside that schema.",
].join(" ");

type JsonObject = Readonly<Record<string, unknown>>;

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: readonly {
    role: "user";
    content: string;
  }[];
  output_config: {
    format: {
      type: "json_schema";
      schema: JsonObject;
    };
  };
}

/** The transport returns untrusted JSON; the provider owns all validation. */
export interface AnthropicTransport {
  createMessage(request: AnthropicMessageRequest): Promise<unknown>;
}

export interface AnthropicFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface AnthropicFetchInit {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type AnthropicFetch = (
  url: string,
  init: AnthropicFetchInit,
) => Promise<AnthropicFetchResponse>;

export interface AnthropicTransportErrorOptions {
  status?: number;
  errorType?: string;
  requestId?: string;
}

export class AnthropicTransportError extends Error {
  readonly status?: number;
  readonly errorType?: string;
  readonly requestId?: string;

  constructor(message: string, options: AnthropicTransportErrorOptions = {}) {
    super(message);
    this.name = "AnthropicTransportError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.requestId = options.requestId;
  }
}

export interface AnthropicFetchTransportOptions {
  apiKey: string;
  endpoint?: string;
  apiVersion?: string;
  fetch?: AnthropicFetch;
}

const anthropicErrorEnvelopeSchema = z
  .object({
    error: z.object({
      type: z.string().min(1),
      message: z.string().min(1),
    }),
    request_id: z.string().min(1).optional(),
  })
  .passthrough();

function defaultFetch(url: string, init: AnthropicFetchInit): Promise<AnthropicFetchResponse> {
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

/** Minimal dependency-free HTTP transport; retries belong to the gateway. */
export class AnthropicFetchTransport implements AnthropicTransport {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly apiVersion: string;
  private readonly fetch: AnthropicFetch;

  constructor(options: AnthropicFetchTransportOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0 || /[\r\n]/.test(apiKey)) {
      throw new RangeError("Anthropic API key must be a non-empty single-line value");
    }
    const endpoint = (options.endpoint ?? ANTHROPIC_API_ENDPOINT).trim();
    if (endpoint.length === 0) throw new RangeError("Anthropic endpoint must not be empty");
    const apiVersion = (options.apiVersion ?? ANTHROPIC_API_VERSION).trim();
    if (apiVersion.length === 0 || /[\r\n]/.test(apiVersion)) {
      throw new RangeError("Anthropic API version must be a non-empty single-line value");
    }
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.apiVersion = apiVersion;
    this.fetch = options.fetch ?? defaultFetch;
  }

  async createMessage(request: AnthropicMessageRequest): Promise<unknown> {
    let response: AnthropicFetchResponse;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "anthropic-version": this.apiVersion,
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: canonicalStringify(request),
      });
    } catch (error) {
      throw new AnthropicTransportError(
        error instanceof Error ? boundedMessage(error.message) : "Anthropic network request failed",
        { errorType: "network_error" },
      );
    }

    const headerRequestId = response.headers.get("request-id") ?? undefined;
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new AnthropicTransportError(
        error instanceof Error ? boundedMessage(error.message) : "Anthropic response read failed",
        {
          status: response.status,
          errorType: "network_error",
          requestId: headerRequestId,
        },
      );
    }
    const decoded = parseJson(body);

    if (!response.ok) {
      const envelope = anthropicErrorEnvelopeSchema.safeParse(decoded);
      throw new AnthropicTransportError(
        envelope.success
          ? boundedMessage(envelope.data.error.message)
          : `Anthropic request failed with HTTP ${response.status}`,
        {
          status: response.status,
          ...(envelope.success ? { errorType: envelope.data.error.type } : {}),
          requestId: envelope.success
            ? (envelope.data.request_id ?? headerRequestId)
            : headerRequestId,
        },
      );
    }
    if (decoded === undefined) {
      throw new AnthropicTransportError("Anthropic returned a non-JSON success response", {
        status: response.status,
        errorType: "malformed_response",
        requestId: headerRequestId,
      });
    }
    return decoded;
  }
}

const anthropicMessageResponseSchema = z
  .object({
    model: z.string().min(1),
    stop_reason: z.string().nullable(),
    content: z.array(
      z
        .object({
          type: z.string().min(1),
          text: z.string().optional(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .passthrough(),
  })
  .passthrough();

const anthropicErrorCodeByType: Readonly<Record<string, LlmProviderErrorCode>> = Object.freeze({
  invalid_request_error: "invalid_request",
  authentication_error: "authentication",
  billing_error: "billing",
  permission_error: "permission",
  not_found_error: "not_found",
  conflict_error: "conflict",
  request_too_large: "request_too_large",
  rate_limit_error: "rate_limited",
  api_error: "api",
  timeout_error: "timeout",
  overloaded_error: "overloaded",
  malformed_response: "malformed_response",
  network_error: "transport",
});

function retryableProviderCode(code: LlmProviderErrorCode, status?: number): boolean {
  if (
    code === "conflict" ||
    code === "rate_limited" ||
    code === "api" ||
    code === "timeout" ||
    code === "overloaded" ||
    code === "transport" ||
    code === "truncated"
  ) {
    return true;
  }
  return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

/** Map provider-specific failures without relying on message text. */
export function mapAnthropicProviderError(error: unknown): LlmProviderError {
  if (error instanceof AnthropicTransportError) {
    const code = error.errorType === undefined
      ? (error.status === undefined ? "transport" : "unknown")
      : (anthropicErrorCodeByType[error.errorType] ?? "unknown");
    return {
      provider: "anthropic",
      code,
      retryable: retryableProviderCode(code, error.status),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.errorType === undefined ? {} : { upstreamType: error.errorType }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return {
    provider: "anthropic",
    code: "transport",
    retryable: true,
  };
}

export interface AnthropicLlmProviderOptions {
  transport: AnthropicTransport;
  models?: {
    tier2?: string;
    tier3?: string;
  };
  defaultMaxOutputTokens?: number;
}

interface CandidateSuccess {
  ok: true;
  value: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface CandidateFailure {
  ok: false;
  reason: "schema_invalid" | "provider_error";
  detail: string;
  repairable: boolean;
  inputTokens: number;
  outputTokens: number;
  providerError?: LlmProviderError;
}

type CandidateResult = CandidateSuccess | CandidateFailure;

function fixedProviderError(code: LlmProviderErrorCode, retryable: boolean): LlmProviderError {
  return { provider: "anthropic", code, retryable };
}

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

function buildMessageRequest(
  request: LlmRequest,
  model: string,
  maxOutputTokens: number,
  schema: JsonObject,
  repair: boolean,
): AnthropicMessageRequest {
  return {
    model,
    max_tokens: maxOutputTokens,
    system: repair
      ? request.promptParts.system + "\n\n" + REPAIR_SYSTEM_SUFFIX
      : request.promptParts.system,
    messages: [{ role: "user", content: request.promptParts.observation }],
    output_config: {
      format: {
        type: "json_schema",
        schema,
      },
    },
  };
}

function decodeCandidate(raw: unknown, request: LlmRequest): CandidateResult {
  const response = anthropicMessageResponseSchema.safeParse(raw);
  if (!response.success) {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Anthropic response envelope failed validation",
      repairable: false,
      inputTokens: 0,
      outputTokens: 0,
      providerError: fixedProviderError("malformed_response", false),
    };
  }
  const inputTokens = response.data.usage.input_tokens;
  const outputTokens = response.data.usage.output_tokens;
  if (response.data.stop_reason === "refusal") {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Anthropic refused the structured-output request",
      repairable: false,
      inputTokens,
      outputTokens,
      providerError: fixedProviderError("refusal", false),
    };
  }
  if (response.data.stop_reason === "max_tokens") {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Anthropic structured output reached the token limit",
      repairable: false,
      inputTokens,
      outputTokens,
      providerError: fixedProviderError("truncated", true),
    };
  }
  if (response.data.stop_reason !== "end_turn") {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Anthropic structured output ended with an unexpected stop reason",
      repairable: false,
      inputTokens,
      outputTokens,
      providerError: fixedProviderError("malformed_response", false),
    };
  }
  if (
    response.data.content.length !== 1 ||
    response.data.content[0]?.type !== "text" ||
    typeof response.data.content[0].text !== "string"
  ) {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Anthropic structured output did not contain exactly one text block",
      repairable: false,
      inputTokens,
      outputTokens,
      providerError: fixedProviderError("malformed_response", false),
    };
  }

  const candidate = parseJson(response.data.content[0].text);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: "Anthropic output was not one valid JSON value",
      repairable: true,
      inputTokens,
      outputTokens,
    };
  }
  const parsed = request.schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: `Anthropic output failed ${request.schemaKey} with ${parsed.error.issues.length} issue(s)`,
      repairable: true,
      inputTokens,
      outputTokens,
    };
  }
  return {
    ok: true,
    value: parsed.data,
    model: response.data.model,
    inputTokens,
    outputTokens,
  };
}

/** Anthropic adapter with strict output validation and a single repair retry. */
export class AnthropicLlmProvider implements RoutedLlmProvider {
  private readonly transport: AnthropicTransport;
  private readonly tier2Model: string;
  private readonly tier3Model: string;
  private readonly defaultMaxOutputTokens: number;

  constructor(options: AnthropicLlmProviderOptions) {
    this.transport = options.transport;
    this.tier2Model = options.models?.tier2?.trim() || ANTHROPIC_DEFAULT_MODELS.tier2;
    this.tier3Model = options.models?.tier3?.trim() || ANTHROPIC_DEFAULT_MODELS.tier3;
    this.defaultMaxOutputTokens = validatedTokenLimit(
      options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    );
  }

  route(request: LlmRequest): LlmProviderRoute {
    return {
      provider: "anthropic",
      model: request.tier === 2 ? this.tier2Model : this.tier3Model,
    };
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
        providerError: fixedProviderError("invalid_request", false),
        attempts: 0,
      } satisfies LlmFallback;
    }

    const model = this.route(request).model;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let raw: unknown;
      try {
        raw = await this.transport.createMessage(
          buildMessageRequest(request, model, maxOutputTokens, schema, attempt === 2),
        );
      } catch (error) {
        const mapped = mapAnthropicProviderError(error);
        return {
          ok: false,
          reason: "provider_error",
          requestHash,
          detail: error instanceof Error ? boundedMessage(error.message) : "Anthropic transport failed",
          providerError: mapped,
          attempts: attempt,
        } satisfies LlmFallback;
      }

      const candidate = decodeCandidate(raw, request);
      inputTokens += candidate.inputTokens;
      outputTokens += candidate.outputTokens;
      if (candidate.ok) {
        return {
          ok: true,
          value: candidate.value,
          model: candidate.model,
          cached: false,
          inputTokens,
          cachedInputTokens: 0,
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
      detail: "Anthropic repair ladder exhausted unexpectedly",
      providerError: fixedProviderError("unknown", false),
      attempts: 2,
    } satisfies LlmFallback;
  }
}
