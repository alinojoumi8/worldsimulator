# WS-604: Observation Builder and Prompt Packs

WS-604 establishes the deterministic prompt boundary used by later live decisions, conversations, and news generation. It does not make provider calls or change decision tier routing; WS-605 owns the first live Tier-2 application.

## Versioned registry

`PromptPackRegistry` is an immutable exact-version registry. A caller supplies both the pack key and the run-manifest-pinned version; an absent version fails closed instead of silently selecting a newer template. The first registered pack is `agent.decision@1`, aligned with `PROMPT_PACK_VERSION = 1`. It owns the response schema, schema version, module, tier, output-token cap, and stable system instructions.

The stable system prefix contains only the pack instructions and scenario-authored Persona projection. It explicitly states that the model has no tools or state authority, may select only an engine-offered action, and must treat the untrusted fence as quoted data. Volatile tick state is never placed in this prefix, preserving provider prompt-cache locality.

## Observation and SAF-3 boundary

`AgentObservationBuilder` renders the final volatile message in this order:

1. canonical trusted engine state and strict trigger;
2. one uniquely named untrusted-data fence;
3. canonical engine-authored action menu after the closing fence.

Memory, message, and news prose are the only accepted untrusted item kinds. Each item is strictly bounded, the item count and total text have hard caps, duplicate identities fail, references are deduplicated and code-unit sorted, and the complete observation has a final size cap. The fence token is derived from the canonical payload plus a bounded collision counter. A hostile payload cannot close the real fence by inserting generic XML, Markdown, fake system messages, or guessed marker text.

The menu is built solely from strict `DecisionOption` records, sorted by `actionId`, and rejects duplicates. Untrusted text never contributes an option, parameter, purpose, schema, module, or system instruction. Provider output still passes the structured proposal schema and engine action registry; fencing is defense in depth, not state authority.

## Canonical identity and Decisions

`buildAgentDecisionPrompt` returns the complete `LlmRequest` plus:

- prompt-pack key and version;
- canonical prompt SHA-256 over pack identity, response-schema identity, stable system prefix, and volatile observation;
- canonical observation hash and bounded summary;
- the exact unique fence metadata.

Tier-2/3 `Decision` records now require `llmCallId`, `promptPackKey`, `promptVersion`, and `promptHash`. Tier-1 records reject all LLM prompt metadata. The agent decision API exposes the same key/version/hash tuple for prompt inspection.

No migration or state-hash bump is needed: Decisions were already persisted as immutable canonical records inside the authoritative `decisions` table, which state-hash v15 and SQLite snapshots already include. The Riverbend integration test builds a prompt from a generated Persona and persisted memory, stores its Tier-2 Decision, serves the prompt identity through HTTP, verifies the snapshot hash, restores the same record, and reopens it unchanged.

## Acceptance evidence

- exact stable-prefix and volatile-observation snapshots;
- hard-coded prompt, observation, and complete LLM-request hash goldens;
- canonical object, evidence-reference, and menu-order equivalence;
- exact-version lookup, missing-version rejection, and duplicate registration rejection;
- red-team memory/message/news fixtures containing fake system messages, fake fence endings, XML closure, Markdown system blocks, tool demands, illegal actions, and state-mutation demands;
- forged agent/tick boundaries, duplicate actions, noncanonical state, item-count, text-total, and rendered-size limits fail closed;
- Decision schema, canonical SQLite persistence, state-hash/reopen, API, snapshot, and restore coverage.

External connectors, accounts, arbitrary functions, and citizen tools are not part of this boundary.
