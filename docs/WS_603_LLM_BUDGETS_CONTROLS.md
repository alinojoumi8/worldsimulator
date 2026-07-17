# WS-603 — Deterministic LLM budgets, degradation, and kill switches

## Outcome

WS-603 puts an authoritative enforcement layer around every routed LLM
provider. A request may proceed at its requested tier, degrade from Tier 3 to
Tier 2 at budget pressure, or return a Tier-1 fallback signal without invoking
the provider. The gateway never mutates simulation state from model output.

This ticket does not add citizen tools, connectors, external accounts, or
arbitrary function execution. `moduleId` is restricted to the approved
simulation modules `agent_decisions`, `conversations`, and `news`.

## Enforcement contract

`BudgetedLlmProvider` is composed outside `CachedLlmProvider`. Consequently:

- global, module, and agent controls apply to both new and cached proposals;
- an allowed cache hit consumes no tokens or money;
- a provider call is charged only after a schema-valid non-cached success;
- an unknown model price or failed usage commit returns a typed
  `provider_error` and the proposal cannot mutate state;
- exact cost uses integer microcents for uncached input, provider-cached input
  and output tokens—never floating point currency. A WorldTangle cache hit is
  still free because it makes no provider request.

At 80% of either the run cost ceiling or an agent's allowance for the current
simulated day, Tier 3 degrades to Tier 2. At 100%, the request becomes a Tier-1
`budget_blocked` fallback with zero provider attempts. A run-cost crossing
journals the warning/exhaustion chain and atomically pauses a running run; no
later request can call the provider while the ceiling remains exhausted.

Operational `tick` and approved `moduleId` fields are deliberately excluded
from the canonical response hash. Simulated facts that shape output remain in
the fenced observation; the new fields govern authorization only.

## Authoritative persistence

Migration v20 adds:

- `llm_runtime_budgets`: immutable scenario limits, exact cumulative tokens and
  microcents, warning/exhaustion flags, auto-pause state, global enable switch,
  revision, tick, and source event;
- `llm_agent_daily_usage`: agent/day token counters and one-shot 80/100 flags;
- `llm_module_controls`: one reversible row for each approved module;
- `llm_control_history`: immutable before/after records tied to the command and
  resulting fact events.

Usage, threshold, pause, and control state commit with the authoritative main
event journal and event-ID checkpoint in one immediate transaction. An
injected write failure rolls back the rows, events, run status, sequence, and
ID factory together. Logical state-hash v15 includes all four tables; SQLite
snapshot restore preserves the same status, next authorization, and hash.

Migration v25 extends the run and per-agent usage rows with cached-input
counters, enforces `cached <= input` and monotonic usage, and includes the new
authoritative counters in logical state-hash v19 and snapshot restore. Existing
databases upgrade without rewriting call evidence.

## Events and API

Usage can emit the causal chain:

```text
request cause → llm.usage.recorded
              → llm.agent_budget.warning / exhausted
              → llm.budget.threshold (80 / 100)
              → simulation.paused
```

`POST /api/v1/simulations/{simId}/admin/llm-controls` accepts exactly one of:

- `set_llm_enabled` with `enabled`;
- `set_module_frozen` with an approved `moduleId` and `frozen`;
- `set_agent_quarantine` with `agentId`, `quarantined`, and a required
  `untilTick` when enabling quarantine.

Every accepted control appends `admin.command.received`, then a versioned
`llm.enabled.changed`, `llm.module_freeze.changed`, or
`agent.quarantine.changed` fact before changing state. Every control is
reversible without restarting the server. `/status` now reports authoritative
token spend, rounded-up integer cost estimate, budget percentage, effective
tier, auto-pause state, frozen modules, and configured limits. Full per-call
telemetry/error read models and UI remain WS-608.

## Acceptance evidence

Coverage proves:

- exact integer cost arithmetic and unpriced-model containment;
- forced-low-budget warning, exhaustion, auto-pause, and zero later calls;
- Tier 3→2→1 degradation and isolated per-agent simulated-day allowances;
- cached responses are not charged;
- all three kill switches take effect and reverse immediately;
- command/fact causality, immutable history, reopen persistence, and strict API
  validation;
- injected-failure rollback of rows, events, status, sequence, and ID state;
- logical-hash change on authoritative control/usage state and exact
  snapshot/restore authorization equivalence.

The real-provider `$2` reference-price demonstration remains WS-609; WS-603
supplies and proves the same hard boundary with deterministic mock accounting.
