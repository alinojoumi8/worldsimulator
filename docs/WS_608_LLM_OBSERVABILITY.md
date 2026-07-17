# WS-608: LLM telemetry, errors, and conversation observability

WS-608 makes the complete provider boundary inspectable without allowing
operational measurements to affect simulation behavior. Operators can reconcile
spend, diagnose provider/schema/intent failures, inspect quarantines, and read a
bounded conversation alongside its authoritative structured outcome and binding.

## Immutable call receipts

Migration v24 extends `llm_call_records` with nonnegative `latency_ms` and exact
integer `cost_microcents`. Every Tier-2 or Tier-3 attempt records its provider,
model, prompt and schema identities, request hash, requested/effective tier,
status, fallback reason, attempts, token counts, cache state, latency, price and
source event. `llm.call.recorded` payload version 2 carries the same causal
evidence in the main committed journal.

Migration v25 adds authoritative cached-input counters to run and per-agent
daily budget rows, rebuilds monotonic triggers with `cached <= input`, and
advances the logical state hash to v19. Cost now reconciles uncached input,
provider-reported cached input and output independently. A WorldTangle response-
cache hit remains a separate zero-attempt, zero-charge case.

The complete cache-and-budget provider is wrapped by `TimedLlmProvider`, which
uses an injected monotonic clock and converts invalid measurements to zero.
Latency and price are operational observations: SQLite backup snapshots restore
them exactly, while the canonical logical state hash intentionally excludes
them. Two otherwise identical runs therefore retain the same replay identity
even when their wall-clock latency differs.

## Strict read surfaces

The server exposes three opaque-cursor, run-bound projections:

- `/api/v1/simulations/:simId/llm-calls` lists call receipts and exact filtered
  totals for success/fallback counts, cache hits, attempts, tokens and cost;
- `/api/v1/simulations/:simId/errors` classifies committed engine errors,
  rejected intents, provider failures, and schema/validation failures while
  preserving actor, agent, correlation and causation links; and
- conversation list/detail endpoints expose participant names, all bounded
  messages, separately typed terms, terminal outcome, and negotiation binding.

The status projection now reports authoritative budget-store spend, the actual
cache-hit ratio over cacheable provider calls, and the total committed errors in
the inclusive trailing 24-tick window. Error summaries also expose complete-run
counts, per-agent failure totals, and active Tier-1 quarantines.

## World Explorer

The observability route adds:

- an accessible budget meter with input, cached-input, output, spend and cache figures and visible
  auto-pause or module-freeze state;
- an error dashboard with typed totals, recent causal events, per-agent health,
  and active quarantines;
- a call ledger showing provider, model, status, attempts, input/cached-input/output tokens, latency,
  exact microcent price and cache state; and
- a conversation browser with turn limits, token use, structured terms, outcome
  and final binding.

Transcript prose is interpolated as ordinary React text. It is never passed to
HTML or markdown rendering, and a hostile tag remains visible text rather than
an executable element. Structured terms and bindings are presented separately
so dialogue cannot be mistaken for authority.

## Acceptance evidence

- strict shared response/query contracts reject unknown or malformed fields;
- cursors are bound to their run and endpoint and reject stale filtered rows;
- exact configured input/cached-input/output pricing reconciles the budget store, call records and
  status token totals, with whole-cent presentation error below one cent;
- provider-cached tokens use their configured rate, while WorldTangle cache
  hits have zero price and do not double-charge token budgets;
- migration v23 to v24, append-only guards, reopen and snapshot restore preserve
  telemetry;
- different latency/cost observations leave the logical state hash unchanged;
- provider, schema and validation failures retain causal evidence and surface in
  the correct dashboard categories; and
- hostile transcript markup is rendered inert while authoritative structured
  terms and binding results remain visible.

WS-609 is next: run and record the MiniMax/Kimi live-mode reference-budget
acceptance script. Its explicit credentials and consent are not present in the
current environment, so no live result is claimed here.
