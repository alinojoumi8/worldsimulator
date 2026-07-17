# ADR-0006 — Deterministic engine; LLMs propose, never apply

**Status:** accepted · **Date:** 2026-07-14

## Context

LLMs make agents believable but are non-deterministic, occasionally wrong, and injectable. Money, law, and time require exactness and auditability. The brief mandates: an LLM must never directly modify the database or world state.

## Decision

The **propose → validate → apply** pattern, uniformly:

1. The engine builds an **observation** (persona block, relevant state, top-k memories) and a **bounded action menu** with typed parameter schemas.
2. The LLM (Tier 2/3) returns a structured proposal: `{actionId, params, rationale}` — schema-validated (provider structured-output + Zod re-check).
3. The engine **validates** the proposal against permissions (capability model), funds, laws/policies, and world state. Invalid → `agent.action.rejected` (recorded), retry ladder → deterministic Tier-1 fallback.
4. Only the engine **applies** approved intents through the module `apply()` choke points; state changes + events commit atomically.

Deterministic systems exclusively own: accounting, balances, ownership math, amortization, taxes, inventory, contract status, market matching, interest, payroll, time, permissions, validation, and all state transitions. LLMs may influence: decisions (from menus), conversations/negotiation text (with structured terms extraction), plans, opinions (bounded deltas), memory text, and news narrative (fact fields copied from events).

Decision tiers keep LLM use scarce: Tier 0 scripted / Tier 1 rules (always-available fallback) / Tier 2 structured choice / Tier 3 bounded dialogue. Agents think only on **triggers** — never every tick.

## Alternatives considered

- **LLM writes state via tools/function-calls:** unauditable, unreplayable, injectable — rejected outright.
- **Pure rule-based agents (no LLM):** loses the research premise (persona-consistent judgment, negotiation, narrative).
- **LLM-as-validator:** circular; validation must be the deterministic boundary.

## Consequences

- The sim runs with LLM off (Tier ≤1) — enabling deterministic CI and a hard cost floor.
- Every consequential choice has a stored decision record with options/rationale → explainability UI is a projection, not archaeology.
- Action menus must be curated per trigger type — deliberate design work, and the lever that keeps agents on-rails.
- Adversarial-output and injection test suites (PRD AC-9, SAF-3) are mandatory, permanent CI citizens.
