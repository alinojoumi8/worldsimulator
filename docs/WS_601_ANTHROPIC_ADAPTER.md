# WS-601 — Anthropic adapter and strict structured output

> Historical adapter note: Anthropic remains supported for legacy manifests,
> but the active live routing is MiniMax M3 for Tier 2 and Kimi K2.x for Tier 3.
> See [WS-601 provider suite](WS_601_MINIMAX_KIMI_PROVIDERS.md).

## Outcome

WS-601 adds the live Anthropic implementation behind the existing `LlmProvider` boundary. The gateway can now make a native JSON-schema Messages API request, parse only the expected response envelope, re-validate the JSON with the request's Zod schema, make at most one repair attempt, and return a typed fallback instead of throwing.

The adapter remains a proposal source only. It has no state reference, action executor, arbitrary tool surface, or account connector. A later decision stage must still match the proposal to the engine-authored menu and pass `ActionRegistry.prepare` before any mutation is possible.

## Components

- `AnthropicLlmProvider` owns schema conversion, model routing, response-envelope checks, JSON parsing, Zod validation, the single repair attempt, usage accumulation, and fallback construction.
- `AnthropicTransport` is the injected untrusted-I/O seam used by deterministic tests.
- `AnthropicFetchTransport` is a dependency-free implementation of `POST /v1/messages`; it sends `x-api-key`, `anthropic-version: 2023-06-01`, and a canonical JSON body.
- `LlmProviderError` is the provider-neutral stable error record carried by `LlmFallback`.

The historical Anthropic route used the dated Tier-2 snapshot `claude-haiku-4-5-20251001` and Tier-3 ID `claude-sonnet-5`. Both names remain configurable for replaying a legacy manifest. New live manifests instead pin the MiniMax/Kimi routes documented in [WS-601 provider suite](WS_601_MINIMAX_KIMI_PROVIDERS.md).

## Native structured request

The adapter converts the registered Zod schema with Zod 4's JSON-schema converter, removes only the dialect annotation, canonicalizes the result, and sends it as:

```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {}
    }
  }
}
```

No sampling options or Anthropic tools are exposed. The stable persona/system prompt remains first, and the volatile fenced observation is the sole user message. On a repair, the original system prefix stays byte-for-byte first and a fixed gateway instruction is appended; raw invalid model text is never echoed into the prompt.

The implementation follows Anthropic's current [structured-output contract](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and [Messages API](https://platform.claude.com/docs/en/api/messages/create).

## Validation and repair ladder

1. Convert and canonicalize the request schema. Invalid limits or unrepresentable schemas return `provider_error / invalid_request` before transport.
2. Make one native structured-output request.
3. Require a valid Messages envelope, `stop_reason: end_turn`, and exactly one text block.
4. Parse exactly one JSON value and Zod-validate it.
5. If JSON or Zod validation fails, make exactly one fresh repair request.
6. If repair validation fails, return `schema_invalid`; no raw provider text leaves the gateway.
7. Refusal, truncation, malformed envelopes/content, HTTP failures, and network failures return typed `provider_error` fallbacks and never throw into the engine.

Only JSON/Zod output failures are repaired. Refusal is terminal, and truncation does not silently exceed the caller's hard output-token ceiling.

## Stable provider taxonomy

Anthropic error types are mapped without message-string control flow:

| Anthropic type or condition | Stable code | Retryable |
|---|---|---:|
| `invalid_request_error` | `invalid_request` | no |
| `authentication_error` | `authentication` | no |
| `billing_error` | `billing` | no |
| `permission_error` | `permission` | no |
| `not_found_error` | `not_found` | no |
| `conflict_error` | `conflict` | yes |
| `request_too_large` | `request_too_large` | no |
| `rate_limit_error` | `rate_limited` | yes |
| `api_error` | `api` | yes |
| `timeout_error` | `timeout` | yes |
| `overloaded_error` | `overloaded` | yes |
| network failure | `transport` | yes |
| refusal | `refusal` | no |
| token-limit stop | `truncated` | yes |
| invalid success envelope/content | `malformed_response` | no |

This matches the current [Anthropic HTTP error taxonomy](https://platform.claude.com/docs/en/api/errors). Retryability is data for the later budget/degradation gateway; WS-601 itself does not add transport backoff.

## Security and determinism

- Provider output is always untrusted and is never returned before local validation.
- Error detail is bounded; schema fallbacks report only the schema key and issue count, not adversarial values.
- The API key exists only in the fetch transport header and is never placed in requests, results, hashes, or logs.
- The provider has no clock or random source and adds no persistence state.
- `maxOutputTokens` now participates in `llmRequestHash` because it can shape the response.
- Live output becomes replayable only after WS-602's response cache; CI continues to use mock or scripted transports.

## Acceptance evidence

`packages/engine/src/anthropic-provider.test.ts` covers:

- native JSON-schema request shape and prompt ordering;
- Tier 2/Tier 3 model routing;
- first-pass success and cumulative usage;
- exactly one successful repair and exactly one failed repair;
- malformed JSON, extra fields, unoffered/mutation-shaped output, tool blocks, refusal, truncation, and malformed envelopes;
- invalid token limits and unrepresentable Zod schemas before I/O;
- every documented Anthropic HTTP error mapping;
- dependency-free fetch headers/body and error-envelope parsing;
- thrown transport failures becoming typed fallbacks.

WS-601 changes no database schema, event catalog, state hash, or snapshot format.
