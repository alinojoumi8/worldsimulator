# WS-605: Live bounded Tier-2 decisions

WS-605 connects the provider-neutral LLM gateway to authoritative simulation decisions. Provider work happens before the tick transaction; the tick may then apply only an exact engine-authored choice. External tools, connectors, accounts, arbitrary functions, and direct model state mutation remain out of scope.

## Pre-tick barrier

`discoverTier2DecisionOpportunities` builds a canonically sorted menu for five decision kinds:

1. founder weekly pricing;
2. founder hiring response;
3. applicant job-offer response;
4. loan-officer score adjustment;
5. goal activation or deferral.

Each opportunity contains a real agent Persona, causal trigger, trusted state, bounded untrusted memory, and strict `DecisionOption` records. `prepareTier2DecisionBatch` builds the registered `agent.decision@1` prompt and calls the routed provider sequentially in canonical opportunity order. The asynchronous provider boundary is therefore outside the SQLite tick transaction, while budget/cache effects retain deterministic ordering.

The synchronous apply handler verifies the prepared tick and ordering, allocates authoritative IDs, resolves the proposal, and commits the call evidence, immutable Decision, AgentAction, domain events, state changes, checkpoint, and outcome memory in one tick unit of work. A provider exception, request-hash mismatch, schema failure, budget fallback, or validation failure selects the deterministic Tier-1 option instead.

## Exact-menu authority

The provider response is only `{actionId, params, rationale}`. Before dispatch, the action registry requires both the action type and canonical parameters to match one offered option byte-for-byte. A valid action ID with a substituted company, job, application, agent, offering, goal, price, or loan adjustment is rejected and emits `agent.action.rejected`; the rejected proposal never becomes authoritative state.

Founder pricing is limited to the engine-computed integer cost-to-cost-plus-50-percent envelope. Loan officers receive exactly eleven choices from -5 through +5 inclusive. Goal activation accepts only an engine-eligible goal. Employment requires two current persisted choices: the founder must offer and the applicant must accept; an applicant decline is final, while founder deferral leaves a willing application pending for the next weekly review.

## Immutable evidence

Migration v21 adds `llm_call_records`, its append-only triggers, and the loan decision's `agent_decision_id`. Every call record links one Decision and its causal `llm.call.recorded` event and stores:

- purpose, module, provider, model, and requested/effective tier;
- prompt-pack, prompt, response-schema, and canonical request identities;
- success or typed fallback status;
- cache/attempt/token accounting and the validated structured response on success;
- bounded fallback/error detail and the source event.

A schema-valid provider response that fails exact-menu validation is recorded as `validation_failed`, effective Tier 1, while retaining the actual attempt and token counts. The following `agent.decision.recorded`, `agent.action.started`, rejection/domain events, and `agent.action.completed` facts share explicit correlation and causation. Logical state-hash v16 and SQLite snapshots include the immutable call rows and Tier-2 loan link.

Tier-2 loan decisions persist the selected adjustment, written rationale, and agent Decision ID. The existing loan detail why-panel exposes these stored fields without reconstructing model intent.

## Runtime modes

- `off`: no provider preparation; deterministic Tier-1 goals, labor, pricing, and credit remain available.
- `mock`: the same cache, budget, prompt, validation, persistence, and apply path as live mode, using `mock-llm-v1`.
- `live`: Tier 2 routes through MiniMax M3 and Tier 3 through Kimi K2.6 (or explicitly selected K2.7 Code); a missing route credential fails closed to Tier 1.

Model prices are exact integer microcents for input, cached input and output tokens. The pinned MiniMax/Kimi reference table is used unless all three values for a model are explicitly overridden together.

The server reads `MINIMAX_API_KEY` or `MINIMAX_TOKEN_PLAN_KEY`, plus `MOONSHOT_API_KEY` or `KIMI_API_KEY`. `WORLDTANGLE_KIMI_MODEL` accepts only `kimi-k2.6` or `kimi-k2.7-code`. See `.env.example` for complete price-override names; values must be nonnegative integer strings and partial sets fail startup validation. Anthropic credential and price variables remain accepted for legacy manifests only.

## Acceptance evidence

- real tick-committer integration for all five decision kinds;
- production `SimulationService` mock-mode advancement through the pre-tick provider barrier;
- next-tick budget authorization plus rejection when the run genuinely advances during a call;
- founder offer/defer crossed with applicant accept/decline, including two-decision identity and tick checks;
- inclusive loan adjustment boundaries at -5 and +5 and rejection at -6 and +6 before underwriting mutation;
- exact selected-goal activation and ineligible-goal rejection;
- schema-valid forged-parameter proposal, deterministic fallback, `validation_failed` call evidence, and zero forged-domain mutation;
- immutable call-row reopen, logical-state-hash, SQLite snapshot, and restore equivalence;
- v20 to v21 migration repair, deferred in-tick event reference, and immutable triggers;
- Tier-2 loan rationale and Decision link through the public why-panel;
- existing 360-tick Phase 4 economics gate remains green in `off` mode.

Verified on 2026-07-15 with strict type-check, lint, 96 test files (536 tests),
and the production web build. The deterministic-source scan is clean.

WS-606 is the next ticket and adds bounded Tier-3 conversations. It does not broaden model authority.
