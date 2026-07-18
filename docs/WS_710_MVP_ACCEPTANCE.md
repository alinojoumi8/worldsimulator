# WS-710 MVP Acceptance Gate

WS-710 closes the WorldTangle MVP against every PRD section 28 criterion. The
authoritative clean-checkout command is:

```bash
pnpm install --frozen-lockfile
pnpm gate:mvp
```

The command runs strict type-checking, lint, the authenticated Phase 6 evidence
validator, the complete Vitest suite, the production web build, and the real
Chromium acceptance path. GitHub Actions repeats the unit/integration and
browser gates on both Windows and Ubuntu without provider credentials.

## Acceptance record

| Criterion | Executable evidence | Result |
|---|---|---|
| AC-1 | `scenario-regression.test.ts` runs the exact 100-agent, seed-42, mock world through tick 360 twice and compares both terminal logical-state and raw event-log hashes. Built-in mock latency is fixed at zero; live/injected providers retain measured telemetry. | Pass |
| AC-2 | `pnpm gate:phase6` validates the immutable WS-609 live $2-budget artifact, exact provider repricing, causal auto-pause, bounded rounding tolerance, and zero attempts after pause. | Pass |
| AC-3 | The persistence-backed 360-tick scenario calls `checkInvariants` and fails on any active INV-1 through INV-10 violation. INV-7 is correctly inactive until the V1 securities market exists; all other invariants pass, finance reconciles, and M1 attribution is exactly 10,000 bp. | Pass |
| AC-4 | The same 360-tick test performs strict manifest/journal/cache replay through tick 360 with zero divergences and the exact source state hash. Replay integration and React stepper tests cover cache-only, strict/observe, missing-cache, and arbitrary target-tick behavior. | Pass |
| AC-5 | The default run proves three goal-caused formations, two completed launch/hire/offering paths, active production, and at least one company with an approved/disbursed loan followed by production. Company and credit API/UI tests cover the complete why chain. | Pass |
| AC-6 | World-event/energy integration tests prove a bounded 30% fuel shock reaches fuel, tariff, CPI, and firm-cost evidence within 30 ticks. Playwright exercises the approved paused-run injector and observes the authoritative CPI series. | Pass |
| AC-7 | The 360-tick gate requires at least 12 published stories, every citation to resolve to a committed event, and no invalid publication. Story/schema tests prove malformed or forged drafts are spiked without reach. | Pass |
| AC-8 | Export integration tests generate checksummed JSONL and CSV, verify every row and digest, and reconstruct authoritative account balances from exported transaction legs. | Pass |
| AC-9 | Action-registry properties plus provider, prompt-fencing, Tier-2, conversation, negotiation, and newsroom adversarial suites cover malformed, illegal, forged, stale, and injection-shaped output. Every rejection is recorded and no rejected proposal reaches a state executor. | Pass |
| AC-10 | The application-level disclaimer wraps matched, loading, error, and unmatched routes; Playwright asserts it in the built app. Strict API-root tests require `simulated: true`, and export manifests carry the exact simulation disclaimer. | Pass |

## Determinism repairs found by the gate

The acceptance run exposed three replay-boundary defects that smaller fixtures
did not reach:

1. LLM expectations were imported by record ID rather than causal event order,
   and prepared calls could advance before their records committed. Expectations
   are now ordered by source event sequence with a persisted/in-memory cursor.
2. Prompt trusted state and news fact hashes retained replay-local run, wall,
   correlation, or latency metadata. Canonical logical projections now remove
   only that operational identity while preserving economic facts such as exact
   provider cost.
3. The built-in mock provider recorded wall-clock latency, making two otherwise
   identical source journals differ. Built-in mock and cache-only replay now
   record deterministic zero latency; live and explicitly injected providers
   remain timed.

Focused regression tests lock each boundary, including causal expectation
ordering, pre-commit cursor behavior, latency-insensitive replay/news hashes,
cost-sensitive news hashes, replay-stable story menus, and identical raw event
hashes for independent mock runs.

## Latest local evidence

On 2026-07-16, Windows completed the full 360-tick source/replay/second-source
gate in 461 seconds with no failure. The source run stayed inside the complete
Riverbend envelope, strict replay reached tick 360 with zero divergences, and
the independent run matched both terminal hashes. The repository-level
`pnpm gate:mvp` result and cross-platform CI run are the release evidence for
this document.

The complete `pnpm gate:mvp` run passed in 687 seconds: 127 Vitest files and
676 tests were green, the Vite production build completed, and the one-worker
Chromium path passed in 30 seconds.

The MVP boundary does not include VC, securities, dynamic government, external
accounts, citizen tools, or connector dependencies. V1 subsequently began at WS-801; current progress is tracked in [PROJECT_STATUS](PROJECT_STATUS.md).
