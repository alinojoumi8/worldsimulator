# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm TypeScript monorepo. `packages/shared/src/` contains deterministic primitives and API/SSE schemas. `packages/engine/src/` implements the simulation loop, phases, event system, and injected persistence/LLM seams. `apps/server/src/` contains the Fastify API, SQLite adapters, scheduler, and static delivery. `apps/web/src/` is the React/Vite dashboard; runtime imagery is in `apps/web/public/brand/`, with generated sources and prompts in `design/brand/`. Tests are colocated as `*.test.ts` or `*.test.tsx`. Specifications and ADRs live in `docs/`.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the exact workspace dependencies used by CI.
- `pnpm dev` runs the API at `http://127.0.0.1:4000` and Vite at `http://127.0.0.1:5173`.
- `pnpm build` type-checks and builds the dashboard into `apps/web/dist/`.
- `pnpm start` runs the API and serves an existing dashboard build on port 4000.
- `pnpm typecheck` validates strict TypeScript without emitting build artifacts.
- `pnpm lint` runs ESLint, including determinism restrictions.
- `pnpm test` runs the full Vitest suite once; `pnpm test:watch` supports local iteration.

Run `pnpm typecheck && pnpm lint && pnpm test` before submitting changes.

## Coding Style & Naming Conventions

Use ESM, two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Name classes and types with `PascalCase`, functions and variables with `camelCase`, and source files with descriptive kebab-case names such as `event-log.ts`. Prefer workspace imports (`@worldtangle/shared`) over deep cross-package paths. Keep public exports in each package's `src/index.ts`.

Engine and shared code must remain deterministic: never use `Date.now()`, `Math.random()`, argless `new Date()`, or `localeCompare`. Inject time and randomness, represent money as integer `bigint` cents, and use the canonical codec for hashed data.

## Testing Guidelines

Use Vitest's `describe`/`it` style and name tests `*.test.ts` or `*.test.tsx`. Add unit/component tests beside changed code and property or determinism tests when invariants span many inputs. Persistence changes need rollback and reopen coverage; UI changes need contract-backed loading, error, and interaction coverage. There is no numeric coverage threshold; behavioral coverage and the cross-platform determinism gate are mandatory.

## Commit & Pull Request Guidelines

The repository has no established Git history yet. Use short, imperative commit subjects, optionally scoped, for example `engine: preserve event ordering`. Keep commits focused. Pull requests should explain intent and design impact, link relevant issues or ADRs, identify configuration/API changes, and include screenshots when user-facing output changes. Report the commands run and ensure CI passes on both Windows and Ubuntu.
