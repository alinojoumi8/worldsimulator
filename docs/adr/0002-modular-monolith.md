# ADR-0002 — Modular monolith, not microservices

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

The system decomposes into ~26 modules (IMPLEMENTATION_PLAN §2). A tick is a tight synchronous loop over many modules with strong consistency requirements (balanced transactions, atomic tick commits). Team size is 1; MVP is a local single-user tool; but the architecture must scale to thousands of agents later.

## Decision

A **modular monolith**: one process and one database transaction per tick. `packages/shared`, `packages/engine`, `apps/server`, and `apps/web` are the physical package boundaries; M01–M26 are logical ownership boundaries implemented by package-local files and injected persistence/provider interfaces. Workspace consumers use package exports, while server-local wiring composes its own adapters directly. The in-process event bus and explicit interfaces preserve deterministic coordination (ADR-0003), and the ownership table in DOMAIN_MODEL §5 defines which module may mutate each record. No network hops exist today.

## Alternatives considered

- **Microservices:** would turn every tick into a distributed transaction across payroll/banking/market services — the worst possible fit for atomic tick semantics; operationally absurd for a single-user local tool.
- **Unstructured monolith:** faster this week, unmaintainable by Phase 5; forbidden by the brief (no tightly-coupled single service).
- **Actor framework (e.g. per-agent actors):** attractive for scale but destroys deterministic ordering guarantees; revisit only for multi-region partitioning (each region a deterministic loop).

## Consequences

- Atomic tick commits are trivial (one SQLite transaction).
- Boundary discipline currently comes from pnpm workspace dependency declarations, strict TypeScript/package exports, ownership-focused tests, and review. ESLint enforces the deterministic-core restrictions, but a dedicated dependency-cruiser/import-boundary rule is not installed and must not be treated as an existing gate.
- Scale-out path documented: extract regions/read-models first; module ownership tables make the split lines explicit.
