# WS-601 provider suite — MiniMax M3 and Kimi K2.x

WorldTangle live mode uses two strict proposal-only adapters behind the existing
`LlmProvider` boundary:

| Decision route | Provider | Pinned model |
|---|---|---|
| Tier 2 | MiniMax | `MiniMax-M3` |
| Tier 3 default | Kimi | `kimi-k2.6` |
| Tier 3 opt-in | Kimi | `kimi-k2.7-code` |

The run manifest pins both provider and model identities. `kimi-k2.7-code` is
opt-in through `WORLDTANGLE_KIMI_MODEL`; unsupported values fail during startup.
With a Kimi Code Token Plan key, both logical identities use the official
`kimi-for-coding` wire alias: thinking disabled selects K2.6 and provider-default
thinking selects K2.7 Code. A Moonshot Open Platform key is supported explicitly
for `kimi-k2.6` only.
The older Anthropic adapter remains available only for legacy manifests and is
not the default live route.

## Authority boundary

Both adapters use the providers' OpenAI-compatible chat-completions APIs through
a dependency-free Bearer transport. A request contains only system/user text and
an engine-owned output schema; it never contains tools or executable callbacks.

- Kimi receives native strict `json_schema` response formatting.
- MiniMax receives the canonical schema inside a strict gateway instruction
  because its M3 OpenAI-compatible contract does not expose the same native
  JSON-schema guarantee.
- Every response must be one JSON value, pass the request's Zod schema and then
  exactly match an engine-generated action menu entry.
- A parse or schema failure gets one fresh repair request. The invalid provider
  text is not copied into the repair prompt.
- Refusal, truncation, malformed envelopes, invalid usage, HTTP errors and
  transport failures become typed fallbacks. They never throw into the engine.
- MiniMax M3 and Kimi K2.6 run with thinking disabled. Kimi K2.7 Code retains
  provider-required thinking, while only its final structured content is parsed.

The response cache remains the live replay boundary. A cached WorldTangle
proposal causes no provider attempt and no charge. Provider-reported cached
prompt tokens are different: they remain part of input usage and are charged at
the configured cached-input rate.

## Configuration

Set credentials in the process environment; do not commit them or paste them
into artifacts:

```powershell
$env:MINIMAX_TOKEN_PLAN_KEY = "<secret>" # or MINIMAX_API_KEY
$env:KIMI_API_KEY = "<secret>"           # Kimi Code membership/Token Plan
# Or use MOONSHOT_API_KEY for the pay-as-you-go Open Platform K2.6 route.
$env:WORLDTANGLE_KIMI_MODEL = "kimi-k2.6" # or kimi-k2.7-code
pnpm dev
```

MiniMax uses `https://api.minimax.io/v1/chat/completions`. `KIMI_API_KEY` selects
Kimi Code at `https://api.kimi.com/coding/v1/chat/completions`; `MOONSHOT_API_KEY`
selects Open Platform at `https://api.moonshot.ai/v1/chat/completions`. If both
are set, the Kimi Code credential wins. Subscription quota accounting is
provider-side and is not represented as marginal pay-as-you-go spend inside a
simulation.

## Reference-price accounting

The runtime ships a pinned integer-microcent reference table so budget decisions
remain exact and auditable:

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| `MiniMax-M3` | 30 | 6 | 120 |
| `kimi-k2.6` | 95 | 16 | 400 |
| `kimi-k2.7-code` | 95 | 19 | 400 |

These are reference rates per token, not a prediction of the user's token-plan
invoice. Override all three rates for a model together when the authoritative
provider price changes; a partial or all-zero override fails closed. See
`.env.example` for the exact variable names.

Cost is computed without floating point:

`(input - cached) × inputRate + cached × cachedRate + output × outputRate`

The cached count must be no greater than input tokens. Usage, exact microcent
cost, route, attempts, latency and failure evidence are persisted per call and
projected through the status and observability APIs/UI.

## Verification evidence

The provider suite has mocked-transport coverage for request shape, Bearer-key
isolation, MiniMax prompt-schema mode, Kimi native schema mode, one-repair
behavior, cached usage, K2.7 thinking behavior, stable error mapping and tier
routing. Persistence coverage proves cached-token cost reconciliation across
reopen and snapshot restore. Real-provider acceptance is deliberately separate.
WS-609 and WS-610 produced valid explicit-consent artifacts on 2026-07-16, and
`pnpm gate:phase6` accepts the pair.

Provider references:

- [MiniMax OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [MiniMax Token Plan quickstart](https://platform.minimax.io/docs/token-plan/quickstart)
- [Kimi Code API overview](https://www.kimi.com/code/docs/en/)
- [Kimi chat API](https://platform.kimi.ai/docs/api/chat)
- [Kimi model catalog](https://platform.kimi.ai/docs/models)
