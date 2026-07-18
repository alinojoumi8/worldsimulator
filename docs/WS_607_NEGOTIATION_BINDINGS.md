# WS-607: Purchase and job negotiation bindings

WS-607 makes a terminal Tier-3 agreement actionable without granting dialogue
or an LLM authority over economic state. The conversation outcome is a proposal;
the binding phase accepts it only when the canonical structured terms still
match the engine-authored bounds and the authoritative purchase or labor state
at the current tick. Free text remains evidence only and never binds.

## Binding boundary

The decisions phase now runs `M05-negotiation-binding` at order 80, after the
bounded conversation handler and before ordinary agent decisions. It scans
terminal, unbound conversations in canonical `(end_tick, id)` order and writes
exactly one immutable binding result for each conversation. Re-running the
handler returns the existing result and cannot duplicate an order, payment, or
employment contract.

Domain-owned openers build the only legal negotiation envelopes:

- purchase bounds identify one active offering and limit quantity to current
  inventory and unit price to current average cost through posted price; and
- job bounds identify the current top-ranked submitted application and limit
  annual wage to the applicant reservation wage through the advertised wage.

The buyer/applicant is participant A and the seller founder/employer founder is
participant B. Both authoritative domain stores independently re-read the
terminal outcome, participant authority, reference ID, exact terms, bounds, and
terminal causal event before they accept a negotiated mutation.

## Purchase revalidation

Immediately before placement and again before settlement, the market rechecks:

- active company and offering identity;
- buyer ownership and account authority;
- seller-founder participation;
- exact offering, quantity, and unit price from structured terms;
- current cost-to-posted-price bounds;
- current inventory; and
- current available funds.

A successful agreement creates one exact-cents purchase transaction, decrements
inventory once, fills the order, and records the complete causal chain. A stale
price, stockout, invalid buyer, insufficient funds, inactive offering, or
participant mismatch produces an immutable rejected binding without partial
economic mutation.

## Job revalidation

Immediately before hiring, the labor store rechecks that the application is
still submitted, remains the deterministic top-ranked candidate, the vacancy is
open and unexpired, the company is active, both participants retain authority,
and the structured wage remains between the current reservation and advertised
wages. A successful agreement atomically creates and signs the legal employment
contract, creates the active employment record at that exact wage, updates the
application/job/agent state, and emits negotiation-linked contract and hiring
events. Stale applications, vacancies, participants, or wages fail closed.

## Persistence and evidence

Migration v23 adds `conversation_bindings`, one immutable row per conversation,
with the canonical terms, domain reference, bound result or rejection reason,
tick, causal evidence IDs, and source event. Update and delete triggers protect
the record. Every success emits `conversation.binding.completed`; every failed
or non-agreement terminal outcome emits `conversation.binding.rejected`. Both
events are versioned and carry actor, correlation, causation, and evidence.

Logical state-hash v18 includes negotiation bindings. The snapshot test restores
the completed purchase, binding, events, ledger, order, and inventory to the
same hash and verifies the same read after reopening. An injected binding-write
failure proves that the order, payment, inventory movement, events, ID state,
and binding all roll back together.

## Acceptance evidence

- misleading purchase prose is ignored while exact structured quantity and
  unit price settle;
- misleading job prose is ignored while the exact structured wage binds;
- stale inventory rejects an otherwise accepted purchase with no order or
  transaction;
- repeated binding is idempotent;
- migration v22 to v23, immutable-row guards, reopen, state hash, snapshot
  restore, and whole-unit rollback are covered;
- existing posted-price market, Phase 4 labor, Tier-2 decision, and bounded
  conversation suites remain green.

Verified on 2026-07-15 with strict type-check, lint, 101 test files (563 tests),
and the production web build.

Follow-on WS-608 is now implemented: LLM telemetry and errors APIs plus the conversation, budget, quarantine, and errors UI. See [WS-608 evidence](WS_608_LLM_OBSERVABILITY.md).
