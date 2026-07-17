# ADR-0007 — LLM gateway: provider abstraction, tier routing, budgets, mock provider

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-16

## Context

LLM usage must be swappable (provider risk), affordable (thousands of decisions per run), testable (CI without a provider), and reproducible-as-possible (ADR-0009).

## Decision

A single gateway module (M21) owns all model access:

- **Interface:** `propose(request) → proposal | fallback-signal`; adapters: **MiniMax**, **Kimi**, **Anthropic** (legacy), and **Mock** (scripted responses + hash-based deterministic choice for tests). No other module may import a provider SDK.
- **Routing by decision tier** (config, pinned in run manifest): Tier 2 → MiniMax `MiniMax-M3`; Tier 3 → Kimi `kimi-k2.6` by default or `kimi-k2.7-code` by explicit configuration. `KIMI_API_KEY` selects Kimi Code Token Plan (`kimi-for-coding` on the wire; thinking off/on selects K2.6/K2.7), while `MOONSHOT_API_KEY` selects the explicit Open Platform K2.6 route. Legacy manifests may retain Anthropic routes, but new live runs do not select them.
- **Structured output:** Kimi and Anthropic use provider-native JSON-schema mode; MiniMax receives the schema in a strict prompt contract. Every adapter parses exactly one JSON value and performs Zod re-validation. Schema-invalid → one repair retry → typed fallback signal (caller runs Tier 1). The gateway never throws into the engine.
- **Prompt layout:** stable persona/system prefix first (provider prompt-cache friendly), volatile observation last; prompt packs versioned; prompt hash stored per call.
- **Cache:** response cache keyed `(provider, model, promptPackVersion, schemaVersion, canonicalRequestHash)` — replay's reproducibility boundary.
- **Budgets:** per-agent daily tokens, per-run cost ceiling; degradation ladder Tier 3→2→1 under pressure; 80% warn / 100% auto-pause events. Rate limiting with bounded backoff (jitter from a seeded stream).
- **Tick barrier:** opportunities are sorted by a stable domain key and provider calls currently issue sequentially so cache/budget threshold writes remain canonical. Prepared results are applied synchronously in the same sorted order inside the tick transaction. WS-1103 may batch provider transport, but it may not change decision ordering or the apply barrier.
- **Modes:** `off | mock | live` per run.

## Alternatives considered

- **Direct SDK calls from modules:** untestable, unbudgetable, unswappable.
- **LangChain-style framework:** heavy abstraction we'd fight; our needs (structured call + cache + budget) are narrow and deterministic-critical.
- **Sampling-parameter pinning for determinism:** not sufficient across providers; the immutable response cache is the only honest determinism boundary for live runs.

## Consequences

- CI is provider-free and deterministic (mock).
- Cost is governable and observable per run/agent/purpose.
- Cache keys are forever: canonical request hashing lives in `packages/shared` codec from day 0.
- Cache rows are immutable run artifacts. Hit/miss/storage/import facts use a separate causal audit sequence so loading replay metadata never consumes authoritative simulation event IDs or changes the world hash.
- Budget and control state is different from cache metadata: it changes which future decisions may call a model, so counters, thresholds, approved module freezes, global enable state, agent quarantine changes, and auto-pause facts use the authoritative simulation journal and logical state hash. Exact input, cached-input and output prices are integer microcents per token; partial or unpriced routes fail closed. Provider-reported cached input is charged at its configured rate, while a WorldTangle response-cache hit performs no provider call and is never charged.
- The budget gateway wraps the cache gateway. Controls therefore apply to cached proposals, while an allowed cache hit is never charged.
- Prompt packs live in an immutable exact-version registry. The manifest-pinned version must exist; callers do not silently fall forward. Agent prompts put a scenario-authored Persona and stable authority rules in the system prefix, then canonical trusted state, a unique bounded fence for all memory/message/news prose, and the engine-only menu in the volatile observation. Prompt hashes bind the pack key/version, response schema key/version, and both prompt parts, and are mandatory on Tier 2/3 Decisions.
- Provider output never determines an executable type or parameter freely. The Tier-2 action registry accepts only an exact canonical match to one engine-authored menu entry, then rechecks current actor/domain authority. A schema-valid but unauthorized proposal becomes an evidenced `validation_failed` Tier-1 fallback and cannot mutate the requested target.
- Immutable per-call rows link request/prompt/schema identity, usage, result or typed fallback, Decision, and source event. They commit with the Decision, AgentAction, domain effects, outcome memory, and tick checkpoint; their event foreign key is deferred only within that transaction.
- Model/prompt/schema versions must be pinned in run manifests or old runs silently stop replaying (R3).
