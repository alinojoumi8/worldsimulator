# WS-708 — Playwright happy-path acceptance

WS-708 adds a production-shaped browser acceptance boundary for the complete
MVP explanation path. The test drives the built React dashboard and real
Fastify/SQLite server; it does not call application internals or use a live LLM
provider.

## Accepted browser path

The Chromium scenario performs the following user-visible workflow:

1. start the recommended guided mock fixture with seed 42 and end tick 31;
2. schedule the locked 30% fuel-price shock, reload, and recover the handoff;
3. start and pause the run through the cockpit controls;
4. open the citizen directory and inspect a citizen's employment and finances;
5. open the credit explorer, select a real seeded loan, and verify its stored
   why-panel and evidence;
6. return to the cockpit, resume to completion, and observe the authoritative
   CPI series through tick 31; and
7. copy the reproducibility receipt.

The event injector is a bounded admin surface over the existing WS-408 API. It
offers only the four approved catalog entries, exposes the engine's exact input
bounds, accepts a created or paused run, and displays the scheduled tick from
the typed receipt. Guided mode locks the approved intervention and explains its
owner, prerequisites, blast radius, and expected signals. The engine still
validates every request and applies it only at a committed tick boundary.

## Harness and CI contract

`playwright.config.ts` starts `pnpm start` on an isolated loopback port with a
fresh temporary data directory, polls the real health endpoint, and runs one
Desktop Chrome worker. The guided path defaults to mock mode, so the gate needs
no provider credentials and cannot incur live-provider work.

A second Chromium path creates the default seed-42, 360-tick mock world,
advances it through the public lifecycle/advance contracts, and opens a
completed investment through proposal, booked close, exact pre/post cap tables,
causal evidence, and current ownership.

On failure, Playwright retains traces, screenshots, and video. CI installs
Chromium, builds the production dashboard, and runs the acceptance test on both
Ubuntu and Windows. Failure artifacts are uploaded per operating system.

## Verification

Coverage includes:

- component tests for the exact approved event request shapes, created/paused
  authority boundary, guided explanations, handoff recovery, and typed receipt;
- one real Chromium test covering create, lifecycle controls, citizen and loan
  explanation, reload recovery, event scheduling, tick-boundary application,
  CPI rendering, and receipt copying;
- one production-shaped Chromium investment path through a default 360-tick
  world; and
- strict type-check, ESLint, all 125 Vitest files and 659 tests, the production
  web build, and the cross-platform CI Playwright matrix.

Run locally after installing Chromium once:

```text
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

The ticket gate remains:

```text
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
```
