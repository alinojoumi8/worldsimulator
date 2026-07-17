# ADR-0002 — Modular monolith, not microservices

**Status:** accepted · **Date:** 2026-07-14

## Context

The system decomposes into ~26 modules (IMPLEMENTATION_PLAN §2). A tick is a tight synchronous loop over many modules with strong consistency requirements (balanced transactions, atomic tick commits). Team size is 1; MVP is a local single-user tool; but the architecture must scale to thousands of agents later.

## Decision

A **modular monolith**: one process, one database transaction per tick, modules as folders with enforced public interfaces (`index.ts` only entry, lint-enforced), communicating via the in-process event bus (ADR-0003) and explicit interfaces. Module boundaries are drawn as if they were services (each owns its data exclusively — DOMAIN_MODEL §5) so later extraction is mechanical, but no network hops exist today.

## Alternatives considered

- **Microservices:** would turn every tick into a distributed transaction across payroll/banking/market services — the worst possible fit for atomic tick semantics; operationally absurd for a single-user local tool.
- **Unstructured monolith:** faster this week, unmaintainable by Phase 5; forbidden by the brief (no tightly-coupled single service).
- **Actor framework (e.g. per-agent actors):** attractive for scale but destroys deterministic ordering guarantees; revisit only for multi-region partitioning (each region a deterministic loop).

## Consequences

- Atomic tick commits are trivial (one SQLite transaction).
- Boundary discipline must be enforced by tooling (dependency-cruiser/eslint boundaries + pnpm strictness), not by network topology.
- Scale-out path documented: extract regions/read-models first; module ownership tables make the split lines explicit.
