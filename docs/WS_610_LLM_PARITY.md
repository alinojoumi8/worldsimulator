# WS-610 mock/live parity

## Status

The provider-neutral parity implementation, strict artifact-v2 contract and CI
suite are complete. The one-call real MiniMax M3 check is executable but has not
run in this environment because neither a MiniMax key nor explicit consent is
present. No live artifact has been fabricated.

Run the CI gate with:

```powershell
pnpm exec vitest run apps/server/src/llm-parity.test.ts
```

Run the manual live gate with:

```dotenv
# repository-root .env (git-ignored and automatically loaded by this command)
MINIMAX_TOKEN_PLAN_KEY=<secret>
WORLDTANGLE_LIVE_PARITY_CONFIRM=LIVE_ONE_CALL
```

```powershell
pnpm acceptance:llm-parity
```

Or set the variables in the current PowerShell process:

```powershell
$env:MINIMAX_TOKEN_PLAN_KEY = "<secret>" # or MINIMAX_API_KEY
$env:WORLDTANGLE_LIVE_PARITY_CONFIRM = "LIVE_ONE_CALL"
pnpm acceptance:llm-parity
```

The command makes exactly one intended live Tier-2 request and writes a strictly
validated, checksummed pass artifact to
`artifacts/ws610-live-parity/latest.json` only after every comparison is green.
The API key is never printed or persisted.

The pinned model is `MiniMax-M3`. The runner defaults to 30/6/120 integer
microcents per input/cached-input/output token. These are reference accounting
rates; a MiniMax Token Plan is subscription quota rather than marginal
pay-as-you-go billing. Recheck the [official MiniMax pricing](https://platform.minimax.io/docs/pricing/overview)
before the request. If needed, override all three values together:

```powershell
$env:WORLDTANGLE_MINIMAX_M3_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_MINIMAX_M3_CACHED_INPUT_MICROCENTS_PER_TOKEN = "<integer>"
$env:WORLDTANGLE_MINIMAX_M3_OUTPUT_MICROCENTS_PER_TOKEN = "<integer>"
```

A partial or all-zero override fails before network access.

## Acceptance fixture

Both runs create fresh seed-42 `riverbend-100@1` worlds. Before tick 1, the
acceptance-only setup marks every goal of the same seeded agent dormant. This
guarantees one bounded goal decision while leaving the rest of the scenario
unchanged.

The live run executes first. Its accepted engine-authored proposal is
reconstructed from the committed Decision and replayed through `MockLlmProvider`
in a fresh mock world. The engine therefore receives the same structured
candidate from genuinely different provider routes.

## Compared contract

`captureLlmParity` hashes five complete provider-neutral sections:

1. Call contract: IDs, purpose, requested/effective tier, canonical request
   hash, prompt/schema identities, status, fallback classification and accepted
   structured response.
2. Full committed Decisions, including offered menu, selected action/params,
   rationale and validation result.
3. Full AgentActions and their result-event receipts.
4. Every committed event at the decision tick, including sequence and causal
   IDs.
5. All goals and memories for every agent involved in the calls.

The event comparison includes the whole economic tick, not only LLM events. A
provider choice that changes a transaction, indicator, event count, decision,
action, goal or memory fails the gate.

Provider/model, cache status, attempts, input/cached-input/output usage, exact
cost and latency remain separate provider receipts. They are excluded from the
parity digest because they describe how the provider produced the candidate,
not what the engine committed. The canonical request hash remains inside the
compared contract and must also match between live and mock receipts. The suite
separately asserts that provider receipts and full logical hashes differ,
proving it compares distinct executions.

The pass artifact carries the complete replayed proposal and its hash. Its
strict validator recomputes that hash, all five section digests, canonical
section order, overall evidence digest, request-hash equality and every
checklist claim. Re-checksumming a semantically false artifact is insufficient.

## CI coverage

The non-network suite covers both boundaries:

- Valid live-shaped output replayed through mock produces identical calls,
  Decisions, AgentActions, 730-event tick flow, goals and memories.
- Schema-invalid output from both shapes deterministically becomes the same
  Tier-1 fallback, and forged content is absent from committed state.

The shared artifact tests also reject stale digests, broken causality,
request/proposal hash drift and reordered parity sections.

## Manual checklist

The live command fails without `LIVE_ONE_CALL` consent and a nonempty MiniMax
key. A passing artifact confirms:

- exactly one successful MiniMax M3 Decision and one mock replay Decision;
- distinct provider receipts and provider-bound logical hashes;
- exact equality for all five provider-neutral sections;
- identical affected-agent goal state; and
- a checksummed proposal and evidence artifact.

Passed on 2026-07-17 UTC. The strict artifact is
`artifacts/ws610-live-parity/latest.json`. Its proposal hash is
`f1ff27bdfa771150636b7e563cb968a4552d370efd01836c218b9d5f12536284`, its
provider-neutral projection digest is
`5246b07d1cf6548ea75d72f81991212c41ce0402510a1c49e7d7fe1a553afdf9`, and its
evidence digest is
`07eaceedf30bdc616ae14c87ac2c1d4fce1bf13bcc5e6f93bedc6b31014f6db0`.
`pnpm gate:phase6` accepts it together with the WS-609 AC-2 artifact, so Phase 6
is complete.
