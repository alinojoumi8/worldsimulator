# WS-606: Bounded Tier-3 conversations

WS-606 adds a provider-neutral two-party conversation protocol for purchase and
job topics. Provider work remains outside the authoritative tick transaction,
and model output remains a proposal: only an exact engine-authored action and
canonical structured-term tuple can be persisted. External tools, connectors,
accounts, arbitrary functions, and direct model state mutation remain out of
scope.

## Protocol limits

The shared contract enforces four hard limits:

- at most six messages per conversation;
- at most 4,096 provider output tokens across messages and outcome extraction;
- at most one active conversation opportunity per agent per tick; and
- a seven-tick cooldown before the same participants can reopen the same topic.

Participants alternate deterministically. A message is delivered to the other
participant's inbox on the next tick and becomes read when that participant
responds. Repeated same-sender structured terms trigger the no-progress guard.
Decline, agreement, maximum turns, token exhaustion, and no progress all close
through explicit terminal outcomes; no terminal conversation can be reopened or
mutated.

## Structured-term authority

Purchase and job term bounds are validated by shared schemas. The engine builds
only bounded minimum, midpoint, and maximum proposals, plus accept, clarify, and
decline actions when they are legal. Both action identity and canonical params
must match an offered option exactly.

Free-text rationale is stored as non-binding dialogue. It cannot create a term,
change a price, change a wage, substitute an offering or job, or make an
agreement valid. Acceptance must reproduce the other participant's latest
structured terms exactly. Once that structural acceptance exists, outcome
extraction can return only the matching agreement; it cannot reinterpret the
terms. WS-607 owns the separate domain revalidation and binding of accepted
purchase or employment terms.

## Provider and tick boundary

`conversation.message@1` is a Tier-3 prompt pack with a 256-token per-call cap.
`conversation.outcome@1` is a Tier-2 extraction pack with a 128-token cap. Both
use the existing canonical request hash, response cache, budget gateway, kill
switches, call evidence, and deterministic fallback path.

The runtime discovers due conversations in canonical order before the tick and
prepares no more than one for either participant. Transcript text is placed only
inside the untrusted prompt fence; the structured transcript, bounds, turn,
budget, and action menu remain trusted engine state. The synchronous phase then
rechecks the run tick, request hash, response shape, action identity, params,
speaker, alternation, terms, and remaining budget inside the tick unit of work.
Any failure records bounded rejection/call evidence and chooses a deterministic
Tier-1 decline or no-agreement outcome. Invalid output never writes a message or
changes domain state.

## Persistence and causal evidence

Migration v22 adds:

- `conversations` for immutable participants, topic, limits, term bounds, and
  terminal outcome;
- `conversation_messages` for append-only structured terms and non-binding
  text;
- `conversation_inbox` for next-tick delivery and monotonic read state; and
- `conversation_relationship_history` for immutable before/after evidence.

SQL triggers prevent identity changes, invalid lifecycle transitions, update or
deletion of messages/history, and inbox rewinds. Every transition emits a
versioned event with actor, correlation, causation, and evidence, including
conversation start, message creation/rejection/delivery/read, end, and both
directional relationship updates. Each participant also receives a deterministic
conversation outcome memory.

Logical state-hash v17 includes all four conversation tables. Snapshot creation,
restore, reopen, next-step equivalence, and whole-tick rollback are covered.

## Acceptance evidence

- production `SimulationService` mock-mode preparation and transactional apply;
- exact two-turn agreement followed by bounded outcome extraction;
- next-tick inbox delivery and response-driven read transition;
- six-turn and aggregate-token hard boundaries;
- same-sender no-progress closure;
- hostile transcript fencing and forged-parameter rejection;
- LLM-off deterministic fail-closed behavior;
- one-conversation-per-agent-per-tick and seven-tick cooldown enforcement;
- two-way bounded relationship updates, immutable history, and memories;
- migration v21 to v22, reopen, state hash, snapshot restore equivalence, and
  injected whole-tick rollback;
- existing Tier-2, provider, cache, budget, Phase 3, and Phase 4 gates remain
  green.

Verified on 2026-07-15 with strict type-check, lint, 99 test files (555 tests),
and the production web build. Vitest is capped at four workers so the SQLite-heavy
integration and 360-tick suites remain reliable under concurrent execution.

WS-607 is next and binds accepted purchase and job terms only after fresh domain
validation.
