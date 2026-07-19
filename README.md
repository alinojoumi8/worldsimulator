# WorldTangle

An AI-driven economic and social world simulator: a deterministic economic engine (double-entry money, credit, contracts, markets, discrete daily ticks) populated by LLM-persona agents who work, spend, borrow, found companies, negotiate, read news, and change their minds.

> **Every output of this system is a simulated scenario from a stylized model — not a prediction of any real economy, and not financial, legal, or political advice.**

## Status

`pnpm gate:phase6` is the authoritative validator for the real WS-609 and
WS-610 acceptance artifacts; it rejects missing, malformed, tampered or
semantically inconsistent evidence.

Phases 0–7 are complete and the MVP is accepted through WS-710. The exact seed-42/mock world runs 360 ticks, stays inside its economic envelopes, replays from manifest/journal/cache with zero divergences, and produces identical terminal logical-state and raw event-log hashes in a second independent run. The product includes deterministic company, labor, production, market, energy, insolvency, credit, news, sentiment, indicator, replay, export, why-panel, budget/control, and browser-acceptance paths. Live mode routes Tier 2 to `MiniMax-M3` and Tier 3 to logical `kimi-k2.6`; `kimi-k2.7-code` is an explicit opt-in, and Anthropic is legacy-only. V1 is active: WS-801 through WS-804 are complete, and WS-805's contract-backed investment read API is in progress; its browser explorer and Phase 8 acceptance gate remain open. See the [project status](docs/PROJECT_STATUS.md), [MVP acceptance evidence](docs/WS_710_MVP_ACCEPTANCE.md), [provider evidence](docs/WS_601_MINIMAX_KIMI_PROVIDERS.md), and [roadmap](docs/IMPLEMENTATION_PLAN.md#3-phased-roadmap). External citizen tools and connector dependencies remain outside the roadmap through WS-1106.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/README.md](docs/README.md) | Complete documentation index, status labels, and document ownership |
| [docs/PRD.md](docs/PRD.md) | Product requirements: vision, use cases, functional/non-functional requirements, MVP definition, acceptance criteria |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | 26-module architecture + phased roadmap (Phases 0–11) |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | REST + SSE contracts, versioned event catalog |
| [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) | Entity catalog, state machines, workflow diagrams |
| [docs/INITIAL_WORLD.md](docs/INITIAL_WORLD.md) | The "Riverbend" 100-agent starter world generation spec |
| [docs/TASK_BACKLOG.md](docs/TASK_BACKLOG.md) | 93 engineering tasks mapped to phases |
| [docs/LIVE_PROVIDER_CONTRACT.md](docs/LIVE_PROVIDER_CONTRACT.md) | Live Tier 2 proposal contract, usage/cost evidence, strict validation, and fallback proof |
| [docs/LOCAL_OPERATIONS.md](docs/LOCAL_OPERATIONS.md) | Local startup, root `.env` loading, live-vs-mock creation, and runtime verification |
| [docs/PHASE_3_FINANCE.md](docs/PHASE_3_FINANCE.md) | Ledger convention, genesis books, payroll/household rules, indicators, and financial APIs |
| [docs/PHASE_4_FOUNDATIONS.md](docs/PHASE_4_FOUNDATIONS.md) | Legal lifecycle, incorporation, labor matching, events, persistence, and release gates |
| [docs/WS_409_WORLD_EXPLORER.md](docs/WS_409_WORLD_EXPLORER.md) | Phase 4 read contracts, API routes, UI routes, why-panels, and acceptance evidence |
| [docs/WS_501_CREDIT_SCORING.md](docs/WS_501_CREDIT_SCORING.md) | Versioned score formula, authoritative evidence, persistence, events, and acceptance evidence |
| [docs/WS_502_APPLICATION_WORKFLOW.md](docs/WS_502_APPLICATION_WORKFLOW.md) | Review state machine, officer authority, policy decisions, why-records, and acceptance evidence |
| [docs/WS_503_AMORTIZATION_DISBURSEMENT.md](docs/WS_503_AMORTIZATION_DISBURSEMENT.md) | Exact 30/360 schedules, atomic credit creation, persistence, events, and acceptance evidence |
| [docs/WS_504_COLLECTIONS_DEFAULT.md](docs/WS_504_COLLECTIONS_DEFAULT.md) | Installment collection, arrears cure, default/write-down accounting, score penalties, and acceptance evidence |
| [docs/WS_505_BANK_CIRCUIT_BREAKERS.md](docs/WS_505_BANK_CIRCUIT_BREAKERS.md) | Live reserve, effective-capital, and borrower-exposure gates with stress and restore evidence |
| [docs/WS_506_SEEDED_CREDIT_STATE.md](docs/WS_506_SEEDED_CREDIT_STATE.md) | Exact opening credit history, recognition ledger links, causal events, and portfolio audit |
| [docs/WS_507_CREDIT_EXPLORER.md](docs/WS_507_CREDIT_EXPLORER.md) | Credit indicators, strict loan reads, bank statements, stored why-panels, and acceptance evidence |
| [docs/WS_508_M1_ATTRIBUTION.md](docs/WS_508_M1_ATTRIBUTION.md) | Per-tick M1 reconstruction, authorized supply channels, treasury bridge, and Phase 5 gate |
| [docs/WS_601_MINIMAX_KIMI_PROVIDERS.md](docs/WS_601_MINIMAX_KIMI_PROVIDERS.md) | MiniMax M3/Kimi K2.x routing, strict output validation, cached-token pricing, configuration, and evidence |
| [docs/WS_601_ANTHROPIC_ADAPTER.md](docs/WS_601_ANTHROPIC_ADAPTER.md) | Native Anthropic structured output, repair ladder, typed errors, and adversarial gateway evidence |
| [docs/WS_604_OBSERVATIONS_PROMPTS.md](docs/WS_604_OBSERVATIONS_PROMPTS.md) | Exact-version prompt registry, stable Persona prefix, SAF-3 observation fencing, and prompt-hash evidence |
| [docs/WS_605_TIER2_DECISIONS.md](docs/WS_605_TIER2_DECISIONS.md) | Pre-tick provider barrier, five bounded choice kinds, immutable call evidence, fallbacks, and acceptance tests |
| [docs/WS_608_LLM_OBSERVABILITY.md](docs/WS_608_LLM_OBSERVABILITY.md) | Per-call spend/latency, error causality, quarantines, strict conversations, and the observability dashboard |
| [docs/WS_609_LIVE_BUDGET_ACCEPTANCE.md](docs/WS_609_LIVE_BUDGET_ACCEPTANCE.md) | Explicitly authorized $2 live run, evidence checks, command, and current execution status |
| [docs/WS_610_LLM_PARITY.md](docs/WS_610_LLM_PARITY.md) | Provider-neutral mock/live parity, one-call live replay, and strict Phase 6 artifact gate |
| [docs/WS_701_NEWSWORTHINESS_DIGEST.md](docs/WS_701_NEWSWORTHINESS_DIGEST.md) | Deterministic notable-event scoring, rarity windows, ranking, and logical hashes |
| [docs/WS_702_STORY_PIPELINE.md](docs/WS_702_STORY_PIPELINE.md) | Bounded newsroom selection, exact citations, immutable stories, and invalid-output containment |
| [docs/WS_703_SENTIMENT_ENGINE.md](docs/WS_703_SENTIMENT_ENGINE.md) | Integer sentiment decay/effects, attributed opinion drift, bounded decision priors, and persistence evidence |
| [docs/WS_704_FULL_INDICATORS.md](docs/WS_704_FULL_INDICATORS.md) | Ten deterministic economic series, exact formulas, evidence digests, API/UI, and restore coverage |
| [docs/WS_705_REPLAY_EXECUTOR.md](docs/WS_705_REPLAY_EXECUTOR.md) | Cache-only manifest/journal replay, strict and observe divergence modes, persistence, recovery, and acceptance evidence |
| [docs/WS_706_EXPORT_JOBS.md](docs/WS_706_EXPORT_JOBS.md) | Restart-safe content-addressed JSONL/CSV jobs, checksummed manifests, causal audit events, and AC-8 reconciliation evidence |
| [docs/WS_707_NEWS_EXPLORER_UI.md](docs/WS_707_NEWS_EXPLORER_UI.md) | Published-news contracts, sentiment sparklines, exact citations, causality explorer, replay stepper, and two-click why evidence |
| [docs/WS_708_PLAYWRIGHT_ACCEPTANCE.md](docs/WS_708_PLAYWRIGHT_ACCEPTANCE.md) | Production-shaped Chromium acceptance, bounded world-event UI, mock-mode isolation, and cross-platform CI evidence |
| [docs/WS_709_SCENARIO_REGRESSION.md](docs/WS_709_SCENARIO_REGRESSION.md) | Versioned seed-42/mock envelopes, measured baseline, invariant repairs, and tuning protocol |
| [docs/WS_710_MVP_ACCEPTANCE.md](docs/WS_710_MVP_ACCEPTANCE.md) | Complete PRD §28 acceptance matrix, deterministic replay repairs, and release evidence |
| [docs/WS_805_INVESTMENT_EXPLORER.md](docs/WS_805_INVESTMENT_EXPLORER.md) | Current WS-805 backend read surface and explicitly remaining UI/Phase 8 gate |
| [docs/adr/](docs/adr/README.md) | 15 architecture decision records |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Current status, assumptions, open questions |

## Quickstart

Prereqs: Node ≥ 22 (24 recommended) and pnpm 11.6.0.

```bash
pnpm install --frozen-lockfile
pnpm dev         # dashboard http://127.0.0.1:5173; API http://127.0.0.1:4000
pnpm test        # unit, component, property, integration, and determinism tests
pnpm test:e2e    # real Chromium happy path against the built app
pnpm test:phase3 # full 360-day financial conservation and invariant gate
pnpm test:phase4 # 360-tick company/shock/failure explanation and invariant gate
pnpm test:scenario # exact seed-42/mock 360-tick INITIAL_WORLD §9 envelope
pnpm smoke:phase2 # real TCP/API, persisted invariant, snapshot, and reopen probe
pnpm acceptance:live-budget # explicitly authorized WS-609 live run
pnpm acceptance:llm-parity  # explicitly authorized WS-610 one-call run
pnpm gate:phase6 # validate the real WS-609 and WS-610 acceptance artifacts
pnpm typecheck
pnpm lint
pnpm build       # type-check and build apps/web into apps/web/dist
pnpm start       # serve the built dashboard and API together on port 4000
```

`pnpm dev`, `pnpm start`, and the two `acceptance:*` commands automatically load
an existing repository-root `.env`. The file is git-ignored, provider keys stay
server-side, and both acceptance commands still require their explicit live-consent
values. Test and gate commands do not auto-load `.env`.

During development, Vite proxies `/api` to port 4000. For production-style local use, run `pnpm build && pnpm start`. Mock runs need no provider configuration. The dashboard create form defaults to live `MiniMax-M3` with a 128,000-token per-agent daily guardrail, but mock mode remains selectable for offline deterministic runs. A live run needs a configured MiniMax key; changing `.env` never changes an already-created run's pinned manifest, so create a new run when switching modes. If `WORLDTANGLE_API_TOKEN` is set, enter it through the dashboard's **API token** control; it is kept in `sessionStorage`, not persistent browser storage. See [local operations](docs/LOCAL_OPERATIONS.md) for the exact verification path.

Create and inspect a short simulation:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/simulations \
  -H "content-type: application/json" \
  -d '{"name":"riverbend","scenario":{"worldSpec":"riverbend-100@1","seed":42,"llmMode":"mock","budgets":{"runCostCentsMax":"500","perAgentDailyTokens":2000},"policyOverrides":{},"endTick":30}}'
curl http://127.0.0.1:4000/api/v1/simulations
curl http://127.0.0.1:4000/api/v1/simulations/sim_00000001/agents?limit=5
```

## Repository layout

```
packages/shared   pure primitives: money (bigint cents), seeded RNG streams,
                  canonical codec + IDs, legal/company/labor schemas
packages/engine   deterministic core: loop/events, Riverbend generator, memory,
                  goals, decisions, contract/labor rules, invariant harness
apps/server       Fastify API, SQLite ledger/contracts/companies/snapshots, SSE
apps/web          React 19 + Vite dashboard with real indicator series
design/brand      GPT Image 2 sources, prompt manifest, and export script
docs/             the documentation suite above
```

Production-ready brand files live in `apps/web/public/brand/`; provenance, prompts, selected masters, and accessibility guidance live in `design/brand/`.

## Determinism rules (short version — see ADR-0008)

- No `Date.now()`, `Math.random()`, `localeCompare`, or argless `new Date()` in `packages/engine` or `packages/shared` (ESLint-enforced). Time and randomness are injected ports.
- All money is integer cents (`bigint`) via `@worldtangle/shared` money utilities — never floats.
- Anything hashed goes through the canonical codec. `.gitattributes` forces LF so hashes survive Windows checkouts.
- The determinism gate test (same seed → identical log hashes, twice, cross-OS in CI) must stay green forever.

## Windows dev notes

- Repo verified not to be under OneDrive sync. Optional: add a Windows Defender exclusion for this folder and the pnpm store to speed up installs/tests.
- npm scripts run under cmd.exe — keep them free of bashisms.
