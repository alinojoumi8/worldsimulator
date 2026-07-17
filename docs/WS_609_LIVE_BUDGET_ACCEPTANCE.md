# WS-609: Live-mode budget acceptance run

WS-609 supplies the manual AC-2 executable and strict evidence contract. It
uses the production Fastify routes, scheduler, MiniMax M3 Tier-2 adapter, Kimi
K2.6 Tier-3 adapter, response cache, budget controller, call ledger and status
projection. The script writes a validated, checksummed JSON artifact only after
every assertion succeeds.

## Safety preflight

The script refuses to create a simulation or contact either provider unless all
of these are present:

- `WORLDTANGLE_LIVE_ACCEPTANCE_CONFIRM=LIVE_USD_2`, explicitly acknowledging a
  real MiniMax/Kimi run, a 200-cent reference-price ceiling and a possible final
  in-flight overshoot;
- `MINIMAX_API_KEY` or `MINIMAX_TOKEN_PLAN_KEY`; and
- `MOONSHOT_API_KEY` or `KIMI_API_KEY`.

Keys are never printed or written to the artifact. Do not paste them into chat,
source files, shell history shared with others or committed environment files.

The executable includes the following calibrated AC-2 reference rates in integer
microcents per token:

| Route | Model | Input | Cached input | Output |
|---|---|---:|---:|---:|
| Tier 2 | `MiniMax-M3` | 165,000 | 33,000 | 660,000 |
| Tier 3 | `kimi-k2.6` | 522,500 | 88,000 | 2,200,000 |

These are the engine's pinned provider ratios multiplied by 5,500. The factor
is anchored to the real seed-42 acceptance receipt (944 input, 128 cached-input
and 100 output tokens), which reprices to 204.864 reference cents. Riverbend
therefore crosses the functional-test ceiling with only a 2.4% final-response
overshoot and without relying on a high decision count.
They make the budget math exact and reproducible, but they are deliberately not
an invoice estimate. A token plan is a subscription/quota arrangement, so the
resulting "$2" is a nonbillable acceptance reference used to exercise the hard
pause boundary. Override all three values for a model together when testing a
different reference table; a partial, malformed or all-zero override fails
before network access.

## PowerShell command

The `pnpm` command automatically loads an existing repository-root `.env` with
Node's `--env-file-if-exists` support. `.env` is git-ignored. A local file is
therefore the simplest handoff for an operator who does not want credentials in
PowerShell history:

```dotenv
MINIMAX_TOKEN_PLAN_KEY=<secret>
KIMI_API_KEY=<secret>
WORLDTANGLE_LIVE_ACCEPTANCE_CONFIRM=LIVE_USD_2
```

Then run:

```powershell
pnpm acceptance:live-budget -- artifacts/ws609-live-acceptance/latest.json
```

Alternatively, set the keys securely in the same PowerShell process and run:

```powershell
$env:MINIMAX_TOKEN_PLAN_KEY = "<secret>" # or MINIMAX_API_KEY
$env:MOONSHOT_API_KEY = "<secret>"       # or KIMI_API_KEY
$env:WORLDTANGLE_LIVE_ACCEPTANCE_CONFIRM = "LIVE_USD_2"
pnpm acceptance:live-budget -- artifacts/ws609-live-acceptance/latest.json
```

Optional price overrides are:

```powershell
$env:WORLDTANGLE_MINIMAX_M3_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_MINIMAX_M3_CACHED_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_MINIMAX_M3_OUTPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_KIMI_K2_6_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_KIMI_K2_6_CACHED_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_KIMI_K2_6_OUTPUT_MICROCENTS_PER_TOKEN = "<integer>"
```

The default timeout is 30 minutes. Set
`WORLDTANGLE_LIVE_ACCEPTANCE_DATA_DIR` to retain a persistent audit database;
otherwise an isolated temporary directory is removed after completion. The
output path can also be supplied through `WORLDTANGLE_LIVE_ACCEPTANCE_OUTPUT`.

## Assertions and artifact

The probe creates the seed-42, 100-agent, 360-tick Riverbend scenario in `live`
mode with `runCostCentsMax: "200"`, uses the shared acceptance-only fixture to
make one seeded agent's dormant goal eligible at tick 1, starts the real
continuous scheduler, and requires all of these facts:

- the run reaches `paused` with `autoPaused: true`, effective Tier 1 and at
  least one real provider attempt before tick 360;
- exact recorded reference cost reaches the 200-cent threshold;
- the committed `llm.budget.threshold` 100% event causally precedes a
  `simulation.paused` event whose reason is `llm_budget_exhausted`;
- status input, cached-input and output tokens exactly equal provider receipts;
- independent repricing differs from stored spend by at most 5% (normally zero
  with the same exact table);
- the status whole-cent estimate is the correct round-up of microcents; and
- provider-attempt count does not increase during the post-pause grace window.

Artifact schema v2 records scenario, provider and model identities, the
nonsecret three-rate price table, run IDs, pause tick, causal event IDs,
token/call totals, exact reconciliation, post-pause proof and a canonical
SHA-256 evidence digest. The shared validator reparses the strict schema and
independently recomputes the digest, price math, basis-point difference,
displayed-cent round-up, pause causality and stable post-pause attempt claim.

## Phase 6 gate

After this artifact and the WS-610 live parity artifact both exist, run:

```powershell
pnpm gate:phase6
```

The default inputs are `artifacts/ws609-live-acceptance/latest.json` and
`artifacts/ws610-live-parity/latest.json`. Custom paths can be supplied in that
order after `--`. Missing, malformed, tampered or cross-field-inconsistent
evidence fails closed.

## Current execution status

Passed on 2026-07-17 UTC after synchronizing the MiniMax and Kimi credentials.
The real seed-42 run made two upstream provider attempts across 28 call
receipts and reported 2,142 input, 882 cached-input and 360 output tokens.
Recorded and independently repriced spend are both exactly 474,606,000
microcents (475 cents rounded up for display), with zero basis-point
difference. The intentionally tiny reference-price ceiling allows one bounded
overshoot: the run auto-paused at tick 301; `evt_000039li` is the 100% threshold
fact and causally precedes pause event `evt_000039lj`. Provider attempts
remained 2 after the two-second grace window.

The strict artifact is
`artifacts/ws609-live-acceptance/latest.json`; its evidence digest is
`913445f696aab6994ec6448a378b1e4f6b6695e14c61be5d7ff9fca440e17b5f`.
`pnpm gate:phase6` accepts it together with the WS-610 artifact.
