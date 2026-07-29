# Phase 12 — Agent Laboratory and Realism Harness

## Status and release boundary

The Phase 12 implementation foundation is present on the Agent Lab feature branch:

- strict shared contracts and optional run-manifest integration;
- deterministic cohort resolution;
- hash-neutral sidecar storage for shadow evidence;
- bounded external action routing through the existing Tier-2 validation and execution path;
- loopback-only REST and Streamable HTTP MCP;
- offline replay from recorded causal inputs;
- isolated Hermes profiles and persistent citizen sessions;
- manifest, artifact, checksum, taint, vector-scorecard, verification, and report tooling; and
- focused contract, shadow-invariance, external-action, and offline-replay gates.

The real-Hermes, three-seed production pilot has **not** been run by ordinary CI.
Until that explicit gate succeeds, Phase 12 is not release-complete and no result
may be presented as evidence of national calibration or real-world prediction.
Riverbend remains a fictional, stylized simulation.

## Authority model

WorldTangle remains the only writer of authoritative world state.

```mermaid
flowchart LR
  W["WorldTangle tick engine"] --> O["Scoped observation and engine-authored menu"]
  O --> N["Native controller"]
  O -. sidecar only .-> S["Hermes shadow controller"]
  O --> E["Hermes external controller"]
  N --> V["resolveLiveDecision and ActionRegistry"]
  E --> V
  V --> X["Module-owned executor"]
  X --> L["Authoritative events and state"]
  S --> A["Hash-neutral Agent Lab evidence"]
  E --> C["Recorded causal input"]
  C --> L
  C --> R["Offline strict replay"]
```

- `native` preserves the existing decision path.
- `shadow` opens the same scoped turn but immediately keeps the native result.
  Shadow turns, submissions, receipts, and tool calls live in sidecar tables
  excluded from the logical state hash.
- `external` waits only until the manifest-pinned deadline. A valid proposal is
  still an ordinary Tier-2 candidate. It must pass exact menu equality,
  capability checks, `resolveLiveDecision`, `ActionRegistry`, and the owning
  module's executor.
- Timeout, malformed output, revocation, or stale tick/projection/menu hashes
  use the existing deterministic Tier-1 fallback.
- Opportunities are prepared and applied in canonical order, independent of
  network completion order.
- Shadow profiles run concurrently so the matched cohort can meet one shared
  deadline. The harness waits for every profile task before teardown and
  aggregates run statistics in credential order. Sidecar call timing preserves
  what actually happened, but it never orders authoritative work.
- The pinned `stable_driver_v2` policy allows at most 32 shadow turns per
  credential in one tick, independently of the per-turn MCP tool budget. A
  repeated-turn stream beyond that breaker revokes only that credential,
  expires its open turns, and records a failed Hermes run in the artifact.
  Transport and credential failures follow the same evidence-preserving path:
  the native shadow world continues, but the failed trial is not
  release-eligible.

An accepted external submission emits `agent.external_submission.recorded`.
The trial is marked externally influenced, and the standard Riverbend baseline
probe refuses to treat it as a replacement release baseline. Strict replay
imports and validates the full proposal from that causal input event, then
reconstructs it without consulting the generic LLM cache, Hermes, or the
network.

## Contracts

Simulation creation may include `scenario.agentLab`. Omitting the property
preserves pre-Phase-12 manifests and hashes. The configuration pins:

- protocol, study, trial, and experiment-manifest identities;
- `native`, `shadow`, or `external` mode;
- explicit assignments or `stable_stratified_v1` selection;
- an optional byte-pinned laboratory opportunity fixture;
- decision deadline and generation/tool budgets;
- driver-policy, prompt-byte, and tool-schema digests; and
- the resolved assignment list in the immutable run manifest.

The strict public schemas are:

- `AgentTurnEnvelope`
- `AgentActionSubmission`
- `AgentActionReceipt`
- `ExperimentManifest`
- `TrialArtifact`
- `ExperimentScorecard`

Unknown fields fail closed. The observation policy exposes only the citizen's
own stable state, facts with event evidence, delivered messages/news, public
prices when available, and cited memories. Operational run identity is not part
of the citizen projection, so source execution and replay hash the same facts.

## Loopback gateway

All Agent Lab routes reject non-loopback clients.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/agent-lab/me` | Return the credential-bound identity and scopes |
| `GET` | `/api/v1/agent-lab/turn?waitMs=N` | Wait for one owned open turn |
| `POST` | `/api/v1/agent-lab/actions` | Submit one idempotent bounded action |
| `GET` | `/api/v1/agent-lab/actions/{submissionId}` | Read one owned receipt |
| `POST` | `/mcp` | Streamable HTTP MCP request endpoint |

The MCP server exposes exactly:

- `wt_identity_get`
- `wt_turn_wait`
- `wt_action_submit`
- `wt_receipt_get`

Each PAT is generated once and bound to study, trial, run, agent, mode, and
scopes. Only its SHA-256 hash is stored. Credentials can be revoked. Database
constraints permit one turn per opportunity and one accepted submission per
turn; an idempotent retry returns its original receipt. Cross-run/cross-agent
lookups, private-data canaries, unknown fields, unrecognized tools, and
unrecognized event types fail closed.

## Harness operation

Generate a manifest only from the clean checkout that will execute it:

```bash
pnpm lab:init -- --out experiments/phase12-pilot.json \
  --study-id phase12-pilot --model <hermes-provider-model> \
  --provider-env <PROVIDER_API_KEY[,PROVIDER_BASE_URL]> \
  --input-microcents-per-token <integer> \
  --output-microcents-per-token <integer> \
  --hermes-executable <absolute-path-if-not-on-PATH>
```

The generator pins the current commit, Node version, lockfile bytes, exact
citizen prompt, exact MCP schemas, driver policy, three seeds, 60 ticks, an
eight-citizen stratified cohort, one native attempt, three shadow attempts, and
three external attempts per seed. Provider prices are explicit integer
microcents-per-token pins; use `0` only for a genuinely free/local provider.
The production pilot also pins `goal_commitment_choice_v1` at ticks 10, 30, and
50. At each tick, every matched citizen receives the same bounded choice to
reaffirm one existing goal or defer. The engine runs the fixture in all three
arms, including the native control, so shadow comparisons remain matched.
If a pinned citizen is missing, unable to act, quarantined, or has no eligible
goal at a fixture tick, only that fixture slot is omitted; unrelated Tier-2
opportunities still execute. The missing citizen/tick slot makes shadow or
external turn evidence fail the pinned matrix release gate and makes every arm
fail the authoritative fixture-event gate.
Each applied fixture choice emits an authenticated
`agent.goal.commitment_recorded` event containing its fixture version, offered
opportunity key, agent, action, and tick. Artifacts reconstruct a canonical
`authoritativeFixtureSchedule` from those persisted events in all three arms.
Native artifacts remain free of external turn/receipt sidecars, while their
24-slot fixture matrix is independently verifiable from the event log.
The `goal_commitment_choice_v1` fixture is a controlled elicitation and
measurement instrument; it is not evidence that the decision opportunity
emerged naturally from Riverbend. For shadow and external arms, real-agent
participation is established separately by the manifested tool-call trajectory
and terminal provider token evidence for every scheduled citizen/tick turn;
native participation is evidenced by authoritative engine records.
The generator also inspects and pins the Hermes, Python, OpenAI SDK, MCP SDK,
Starlette, and aiohttp versions.
`--provider-env` is a comma-separated allowlist of environment-variable names,
never values. The report computes Hermes cost from the API's terminal token
usage and the pinned prices.

Run, verify, and report:

```bash
pnpm lab:run -- --manifest experiments/phase12-pilot.json
pnpm lab:verify -- --artifact artifacts/agent-lab/phase12-pilot/trials/<trial-id>
pnpm lab:report -- --study artifacts/agent-lab/phase12-pilot
pnpm gate:agent-lab
```

`lab:run` refuses a dirty checkout unless `--allow-dirty` is explicitly supplied,
rejects commit/Node/lockfile/Hermes-runtime drift, requires every allowlisted
provider variable to exist, and refuses a nonempty study directory.
`--allow-dirty` is for development only and does not make a trial
release-eligible.

Hermes is driven through its supported API server. The harness creates one
fresh profile, API port, PAT, and persistent session per citizen. It starts one
`/v1/runs` task per open turn, caps the loop at eight iterations, and configures
only the WorldTangle MCP server. Shell, browser, filesystem, delegation, general
resources/prompts, MCP sampling, and other toolsets are disabled. Startup
queries Hermes' API-server toolset inventory and fails closed if any native or
plugin toolset is enabled. The subprocess inherits only basic OS runtime
variables plus the manifest-allowlisted provider variables; unrelated parent
secrets do not cross the profile boundary. Credential files are ephemeral and
excluded from artifacts.

New experiment manifests use schema v2 and pin `stable_driver_v2`, including the
bounded shadow-turn circuit breaker and the inspected MCP, Starlette, and
aiohttp versions. The normal manifest loader and release reporter require that
current schema and digest. The explicitly named archive verifier migrates a
strict schema-v1 manifest into a verification-only representation, marks its
three unavailable runtime pins, and recognizes the exact historical
`stable_driver_v1` digest. This preserves archived artifact verification and
offline replay without inventing dependency evidence. `lab:run` refuses schema
v1 and `stable_driver_v1`; a new live trial must be regenerated from the
inspected runtime and current policy.

The WorldTangle gateway reserves each MCP call before execution and enforces the
manifest's per-turn tool-call limit. Hermes sets the pinned output-token cap,
records terminal input/output usage, and enforces per-agent daily and whole-run
cost ceilings. Before any network request, the driver synchronously reserves
the manifest-pinned worst-case tokens and cost; terminal accounting replaces
that reservation with valid reported usage. A timeout, failed request, or
terminal response without valid usage charges the pinned worst case instead.
Immediately after Hermes accepts a run, the driver measures the time remaining
until the shared decision deadline and reserves at most half of that value,
capped at one second, for cleanup. Status polling continues until that reserve
begins. A stop request has a separate cleanup grace window capped at one second,
so transport cleanup may finish after the action deadline. If the deadline has
already elapsed, the driver can still use that bounded window to stop the
accepted provider run and capture usage. Cleanup can only cancel and record
evidence: the action deadline stays hard, no late decision is accepted, and
missing usage is charged at the pinned worst case. Terminal poll failures use
the same bounded stop grace.
If a 202 response cannot provide a usable run ID, the harness terminates that
citizen's isolated Hermes profile because the supported stop endpoint cannot
address the accepted run safely.
Transient status transport failures and retryable HTTP statuses (408, 425, 429,
and 5xx) receive at most two retries, each after 100 ms. Unreadable status
bodies and other protocol failures are terminal on the first occurrence. After
any terminal poll failure, the driver makes a best-effort stop request and
records a failed Hermes run charged at the manifest-pinned worst case when
valid usage is unavailable.
A denied reservation revokes the credential and immediately
produces the deterministic fallback; a provider failure or post-call budget
violation disables that controller for later turns and remains visible in the
trial evidence.

The harness stops every Hermes process before requesting strict replay.

## Artifact contract

Each trial preserves:

- canonical manifest and runtime metadata;
- compressed SQLite source database and replay result;
- sanitized turn, submission, receipt, tool-call, and event JSONL;
- event-log, logical-state, LLM-cache, prompt, and artifact hash heads;
- file checksums;
- token, cost, latency, fallback, validity, and tool-call statistics; for
  shadow/external trials, a fixture-turn schedule joins each Hermes run and
  tool-call count to its exact turn ID. Native artifacts keep that sidecar
  schedule empty;
- vector scorecard, taint record, and Markdown report.

It never exports PATs, provider/API keys, Hermes API keys, or hidden model
reasoning. Verification fails on missing or extra files, checksum corruption,
manifest drift, nonterminal turns, failed invariants, replay divergence,
unauthorized applied actions, budget violations, taint, secret-shaped content,
or a corrupt database bundle. Manual or unmanifested admin/world-event input
marks the trial tainted; tainted and invalid trials are excluded from
comparative summaries. Duplicate, orphaned, cross-linked, or malformed fixture
evidence is preserved in the raw bundle, adds an `artifact_corrupt` taint
reason, and remains diagnosable even though the trial cannot pass verification.

The production report additionally fails closed when any trial does not contain
exactly 24 authenticated fixture events, when a non-native trial does not
contain exactly 24 scheduled fixture turns and receipts, when any Agent Lab turn
is nonterminal, when any of the 24 non-native fixture turns lacks a completed
Hermes run, positive terminal input/output usage, or at least one scoped tool
call, when a non-native Hermes run fails or violates a budget, or when a shadow trial changes
the native control's authoritative logical-state hash for the same seed. The
release gate explicitly rejects any native artifact with turn, receipt, tool,
fixture-turn, or Hermes sidecar evidence. Raw event-hash invariance for shadow
sidecar activity remains a separate same-manifest integration gate.
A zero-turn study is never release-eligible.
Existing schema-v1 artifacts remain schema-readable: the newer fixture
counters, fixture turn schedule, authoritative fixture schedule, and per-turn
Hermes evidence schedule default to empty when absent, so no participation is
invented. An authoritative fixture entry that does not reference a scheduled
fixture turn still fails schema parsing.
Artifacts that predate captured runtime Agent Lab configuration remain
release-ineligible and now fail artifact verification because their pinned
cohort and fixture matrix cannot be reconstructed from authenticated evidence.

## Realism program

The first measurable condition is `partial_observation_v1`. Later changes must
be introduced one condition at a time against the frozen arms:

1. daily commitments and availability;
2. non-binding 7/30-day structured plans;
3. weekly reflection proposals supported by cited memories;
4. numeric inflation, job-security, and business expectations; and
5. relationship-mediated information diffusion.

These are not silently enabled by this foundation. A condition must first add a
manifest pin, deterministic implementation, metric definition, counterfactual
fixture, and report evidence. This protects the distinction between
believability and fitness-for-purpose validity.

See [ODD_AGENT_LAB.md](ODD_AGENT_LAB.md) for the required model-description and
study record.

## Release gate

The real-Hermes pilot is eligible only when all of the following are true:

- exactly three frozen seeds, 60 ticks, and eight stratified citizens;
- per seed: one native, three shadow, and three external attempts;
- the pinned three-tick fixture produces exactly 24 authenticated authoritative
  events in every trial, including native controls;
- the pinned three-tick goal-commitment fixture produces exactly 24 turns and
  terminal receipts in every shadow and external trial;
- every one of the 24 non-native fixture turns records a completed Hermes run,
  positive terminal input/output tokens, at least one scoped tool call, and zero
  budget violations, with zero failed Hermes statistics rows outside those 24
  completed fixture turns. Status-poll retries retain the accepted run identity
  and cleanup/stop requests do not create additional Hermes run rows;
- every shadow logical-state hash matches its same-seed native control;
- all external INV-1–10 checks pass;
- no unauthorized proposal applies;
- strict offline replay reports zero divergence;
- no trial included in comparison is tainted or corrupt; and
- the standard repository gates pass.

Required repository commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm gate:agent-lab
```

LLM judging, if separately manifested, must be blinded and can never be the
release oracle. Reports retain structural, behavioral, social, economic, and
operational vectors instead of collapsing them into a single realism score.

## Method and implementation references

- [Buzz architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md)
- [Buzz Harbor benchmark harness](https://github.com/block/buzz/tree/main/benchmarks/harbor-buzz-orchestra)
- [Hermes architecture](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md)
- [Hermes agent loop](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- [Hermes programmatic integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)
- [Generative Agents](https://arxiv.org/abs/2304.03442)
- [ODD protocol update](https://doi.org/10.18564/jasss.4259)
