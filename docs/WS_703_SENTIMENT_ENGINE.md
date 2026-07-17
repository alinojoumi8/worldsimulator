# WS-703 - Sentiment engine

Status: implemented on 2026-07-16.

WS-703 closes the first perception loop: published stories update bounded
public sentiment, story effects create attributed changes to current agent
opinions, and later Tier-1 decisions receive a small evidence-bearing prior
modifier. Every calculation uses safe integers and explicit rounding toward
zero.

## Public sentiment formula

The authoritative public topics are `economy`, `employment`, and
`institutions`, as required by FR-NWS-2. A `market` story contributes to the
`economy` index while retaining `market` as its immutable story topic.

For topic value `S` at tick `t`:

```text
decayed = trunc(S * 9,950 / 10,000)
stanceDelta = clamp(trunc(stance * reach * 900 / 100,000), -1,800, 1,800)
outcomeDelta = clamp(trunc(meanOutcomeScore * 200 / 1,000), -200, 200)
storyDelta = clamp(stanceDelta + outcomeDelta, -2,000, 2,000)
tickStoryDelta = clamp(sum(storyDelta), -2,500, 2,500)
next = clamp(decayed + tickStoryDelta, -10,000, 10,000)
```

`stance` is the persisted integer in `[-2, 2]`; reach is persisted in
`[1, 100,000]`. Outcome score v1 classifies each cited event type as negative,
neutral, or positive, averages the cited scores on the `[-1,000, 1,000]`
scale, and gives negative tokens precedence. The token table is versioned in
the deterministic engine. It contains economic success/failure outcomes such
as formation, hiring, repayment, initialization, default, insolvency,
termination, disaster, and shock. Payload prose never affects the score.

A sparse update is written only when stories contribute. The engine applies
the decay once for every tick elapsed since the prior persisted update,
truncating after each step, and reads an exact lazily decayed value between
story ticks. Idle ticks therefore write nothing. Each `sentiment.updated`
event contains the previous, elapsed-decayed, story, and next values; every
contribution's story ID, cited event IDs, stance, reach, outcome score, and
component deltas; all caps; and ruleset version 1. `sentiment.*` is excluded
from later newsworthiness ranking so the engine cannot create a media
feedback loop from its own audit events.

## Opinion drift

Seed persona opinions remain immutable. Current values are derived from the
seed plus append-only `agent_opinion_updates`. Published story effects map to
the four existing axes as follows:

| Story topic | Opinion effects |
|---|---|
| economy | economic optimism follows the story sign |
| employment | economic optimism follows; redistribution moves oppositely |
| institutions | institutional trust follows |
| market | economic optimism follows; regulation moves oppositely |

Persisted story reach is also the bounded exposure rate. For each agent/story,
ruleset v1 hashes the canonical `{agentId, storyId, rulesetVersion}` tuple into
one of 100,000 buckets; the story affects that agent exactly when the bucket is
below `reach`. Exposure is therefore deterministic, replay-stable, and
monotonic as reach rises. This is a neutral reach sample, not the preference-
based media diets reserved for V1.

A nonzero story contribution produces one to five opinion points:

```text
magnitude = clamp(max(1, floor(abs(storyDelta) / 400)), 1, 5)
axisTickDelta = clamp(sum(signedMagnitude), -5, 5)
nextOpinion = clamp(previousOpinion + axisTickDelta, -100, 100)
```

Effects are aggregated before persistence, so an agent has at most one update
per axis per tick and the FR-AGT-8 five-point cap applies to the complete tick,
not to each story. Every immutable opinion row names all cause story,
contribution, and sentiment-update IDs. One ordered `agent.opinions.updated`
event per publication tick contains every affected agent/axis transition plus
its causal sentiment event IDs; every row points back to that event. Separate
immutable cause rows enforce the references with foreign keys. This preserves
complete per-change evidence without multiplying journal rows by population.

## Decision priors

The goal-decision path reads only sentiment and opinion state committed before
the current tick. The relevant public topic is selected from the trigger kind;
institutions feed institutional trust and the other current decision topics
feed economic optimism.

```text
respondDelta = clamp(trunc(sentiment / 500) + trunc(opinion / 10), -25, 25)
noOpDelta = -respondDelta
```

The modifier adjusts utility only. It cannot add an action, change an action
type or parameter, bypass capability checks, or mutate state. The complete
validated modifier is stored on the Decision, while each offered option
records its applied delta, sentiment value, opinion value, and ruleset version
in `utilityFactors`. Invalid or forged modifiers are skipped and the original
engine-authored menu remains unchanged.

## Persistence and replay

Migration 27 adds four immutable tables:

- `sentiment_updates`;
- `sentiment_story_contributions`;
- `agent_opinion_updates`; and
- `agent_opinion_causes`.

The store recomputes every contribution from the immutable published story,
checks the prior topic/opinion state, validates complete cause sets, and writes
updates atomically. Database triggers reject update/delete operations. Logical
state-hash version 21 includes every new row. Snapshot restore, database
reopen, invalid-input rollback, and equal deterministic state therefore cover
sentiment and opinions with the rest of the authoritative world.

## Verification

Focused coverage proves:

- exact positive/negative stance, reach, outcome, and decay goldens;
- per-story, per-topic-tick, index, opinion, and decision-prior caps;
- deterministic market-to-economy routing and four-axis opinion mapping;
- complete story/contribution/update/event attribution;
- immutable migration 27 upgrade and reopen behavior;
- forged idempotent contributions do not change persisted state;
- snapshot restore returns identical news, sentiment, contribution, opinion,
  cause, and logical-hash state;
- a real 31-tick Riverbend run stores bounded story-evidenced prior modifiers
  on every Tier-1 goal decision at tick 31; and
- neutral/off-mode stories still use deterministic event-outcome evidence and
  make no provider call.

Run the focused suite with:

```text
pnpm exec vitest run packages/engine/src/sentiment.test.ts packages/engine/src/decision-engine.test.ts apps/server/src/news-phase.test.ts apps/server/src/persistence/database.test.ts
```
