# ADR-0001 — TypeScript on Node 24, pnpm-workspaces monorepo

**Status:** accepted · **Date:** 2026-07-14

## Context

The repository was empty; a stack had to be chosen. The system spans a deterministic simulation engine, an HTTP API, LLM integration with strictly-validated structured output, and a web dashboard. The single most reused artifact is the **schema set**: agent action schemas, event payloads, and API DTOs must be identical for (a) LLM structured-output validation, (b) engine validation, (c) API contracts, (d) frontend types.

## Decision

TypeScript (strict) everywhere on Node 24 (Active LTS), organized as a pnpm-workspaces monorepo:

```
packages/shared   # pure primitives + all Zod schemas (single source of truth)
packages/engine   # deterministic core (no Node APIs, no I/O — ports injected)
apps/server       # Fastify API + persistence wiring
apps/web          # React 19/Vite dashboard
```

pnpm (already installed, v11) over npm: strict node_modules makes undeclared cross-package imports fail — a free enforcement layer for module boundaries. Dev execution via `tsx`; internal-packages pattern (package `exports` point at `./src/*.ts`) so dev/test need no build step; `tsc --noEmit` is the typecheck gate; build-first for CI benchmarks. Node scripts must be cmd.exe-safe (no bashisms) since the primary dev machine is Windows.

## Alternatives considered

- **Python (FastAPI + Pydantic):** excellent validation and data tooling, but splits the codebase in two languages the moment the dashboard exists, and its numeric advantage is irrelevant — financial math here is integer bigint, not ndarray work.
- **Mixed (Python engine + TS front/back):** maximizes schema drift, the exact failure mode we most need to avoid.
- **npm workspaces:** functional, but hoisting silently permits phantom cross-package imports.

## Consequences

- One language, one schema source; contract drift becomes a compile error.
- Engine purity discipline required (enforced by lint + review) to keep the door open for worker-thread/WASM scaling.
- bigint + JSON needs a custom codec (see ADR-0013); accepted cost.
- Contributors need pnpm (`npm i -g pnpm`); pinned via `packageManager` field.
