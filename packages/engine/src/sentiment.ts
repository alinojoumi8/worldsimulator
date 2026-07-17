/** WS-703 deterministic sentiment, opinion-drift, and prior-modifier rules. */

import {
  DECISION_PRIOR_DELTA_LIMIT,
  EngineError,
  OPINION_AXES,
  SENTIMENT_RULESET_VERSION,
  SENTIMENT_STORY_DELTA_LIMIT,
  SENTIMENT_TICK_STORY_DELTA_LIMIT,
  SENTIMENT_VALUE_LIMIT,
  canonicalStringify,
  decisionPriorModifierSchema,
  newsStorySchema,
  sha256Hex,
  sentimentStoryContributionSchema,
  sentimentTopicSchema,
  sentimentUpdateSchema,
} from "@worldtangle/shared";
import type {
  AgentOpinionUpdate,
  DecisionPriorModifier,
  NewsStory,
  NewsTopic,
  OpinionAxis,
  SentimentStoryContribution,
  SentimentTopic,
  SentimentUpdate,
  TriggerKind,
} from "@worldtangle/shared";

export const SENTIMENT_DECAY_NUMERATOR = 9_950;
export const SENTIMENT_DECAY_DENOMINATOR = 10_000;
export const SENTIMENT_STANCE_DELTA_LIMIT = 1_800;
export const SENTIMENT_OUTCOME_DELTA_LIMIT = 200;
export const OPINION_STORY_POINTS_PER_STEP = 400;
export const SENTIMENT_EXPOSURE_BUCKETS = 100_000;

const POSITIVE_OUTCOME_TOKENS = new Set([
  "approved",
  "completed",
  "created",
  "disbursed",
  "employed",
  "formed",
  "funded",
  "hired",
  "initialized",
  "opened",
  "paid",
  "produced",
  "repaid",
  "restored",
  "sale",
  "seeded",
  "sold",
  "survived",
]);

const NEGATIVE_OUTCOME_TOKENS = new Set([
  "bankrupt",
  "closed",
  "default",
  "defaulted",
  "delinquent",
  "disaster",
  "failed",
  "fired",
  "insolvency",
  "insolvent",
  "missed",
  "rejected",
  "shock",
  "stockout",
  "terminated",
  "writeoff",
  "writedown",
  "winddown",
]);

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareCodeUnit));
}

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a safe integer`);
  }
  return value;
}

function divideTowardZero(numerator: number, denominator: number): number {
  safeInteger(numerator, "integer numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new EngineError("VALIDATION_FAILED", "integer denominator must be positive");
  }
  return Math.trunc(numerator / denominator);
}

export function sentimentTopicForNewsTopic(topic: NewsTopic): SentimentTopic {
  return topic === "market" ? "economy" : sentimentTopicSchema.parse(topic);
}

/** Versioned v1 outcome classifier. Negative terms win if a type contains both. */
export function sentimentOutcomePolarity(eventType: string): -1 | 0 | 1 {
  const tokens = eventType
    .split(".")
    .map((token) => token.replaceAll("_", "").replaceAll("-", "").toLowerCase());
  if (tokens.some((token) => NEGATIVE_OUTCOME_TOKENS.has(token))) return -1;
  if (tokens.some((token) => POSITIVE_OUTCOME_TOKENS.has(token))) return 1;
  return 0;
}

export interface SentimentStoryEffect {
  readonly storyId: string;
  readonly storyTopic: NewsTopic;
  readonly topic: SentimentTopic;
  readonly tick: number;
  readonly stance: number;
  readonly reach: number;
  readonly outcomeScore: number;
  readonly stanceDelta: number;
  readonly outcomeDelta: number;
  readonly delta: number;
  readonly citedEventIds: readonly string[];
}

export function calculateSentimentStoryEffect(rawStory: NewsStory): SentimentStoryEffect {
  const story = newsStorySchema.parse(rawStory);
  if (story.status !== "published" || story.reach <= 0) {
    throw new EngineError("VALIDATION_FAILED", "only published stories can affect sentiment");
  }
  const polaritySum = story.facts.reduce(
    (sum, fact) => sum + sentimentOutcomePolarity(fact.eventType),
    0,
  );
  const outcomeScore = divideTowardZero(polaritySum * 1_000, story.facts.length);
  const stanceDelta = clamp(
    divideTowardZero(story.stance * story.reach * 900, 100_000),
    SENTIMENT_STANCE_DELTA_LIMIT,
  );
  const outcomeDelta = clamp(
    divideTowardZero(outcomeScore * SENTIMENT_OUTCOME_DELTA_LIMIT, 1_000),
    SENTIMENT_OUTCOME_DELTA_LIMIT,
  );
  return Object.freeze({
    storyId: story.id,
    storyTopic: story.topic,
    topic: sentimentTopicForNewsTopic(story.topic),
    tick: story.tick,
    stance: story.stance,
    reach: story.reach,
    outcomeScore,
    stanceDelta,
    outcomeDelta,
    delta: clamp(stanceDelta + outcomeDelta, SENTIMENT_STORY_DELTA_LIMIT),
    citedEventIds: Object.freeze([...story.citedEventIds]),
  });
}

export function decaySentiment(value: number): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > SENTIMENT_VALUE_LIMIT) {
    throw new EngineError("VALIDATION_FAILED", "sentiment value is outside its integer bounds");
  }
  return divideTowardZero(
    value * SENTIMENT_DECAY_NUMERATOR,
    SENTIMENT_DECAY_DENOMINATOR,
  );
}

/** Applies the tick decay exactly, including truncation after every elapsed tick. */
export function decaySentimentAcrossTicks(value: number, elapsedTicks: number): number {
  if (!Number.isSafeInteger(elapsedTicks) || elapsedTicks < 0) {
    throw new EngineError("VALIDATION_FAILED", "sentiment elapsed ticks must be nonnegative");
  }
  let decayed = value;
  for (let elapsed = 0; elapsed < elapsedTicks && decayed !== 0; elapsed += 1) {
    decayed = decaySentiment(decayed);
  }
  return decayed;
}

/** Returns the effective value of a sparse persisted update at a later committed tick. */
export function sentimentValueAtTick(update: SentimentUpdate, throughTick: number): number {
  const persisted = sentimentUpdateSchema.parse(update);
  if (!Number.isSafeInteger(throughTick) || throughTick < persisted.tick) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "effective sentiment tick cannot precede its persisted update",
    );
  }
  return decaySentimentAcrossTicks(persisted.value, throughTick - persisted.tick);
}

export interface SentimentUpdateCalculation {
  readonly previousTick: number | null;
  readonly previousValue: number;
  readonly decayedValue: number;
  readonly storyDelta: number;
  readonly value: number;
}

export function calculateSentimentUpdate(
  tick: number,
  topic: SentimentTopic,
  previous: SentimentUpdate | null,
  effects: readonly SentimentStoryEffect[],
): SentimentUpdateCalculation {
  if (!Number.isSafeInteger(tick) || tick < 1) {
    throw new EngineError("VALIDATION_FAILED", "sentiment tick must be positive");
  }
  sentimentTopicSchema.parse(topic);
  if (previous !== null) {
    sentimentUpdateSchema.parse(previous);
    if (previous.topic !== topic || previous.tick >= tick) {
      throw new EngineError("CONFLICT", "previous sentiment state is not from an earlier topic tick");
    }
  }
  if (effects.length > 3 || new Set(effects.map((effect) => effect.storyId)).size !== effects.length) {
    throw new EngineError("LIMIT_EXCEEDED", "sentiment accepts at most three unique stories per tick");
  }
  for (const effect of effects) {
    if (effect.tick !== tick || effect.topic !== topic) {
      throw new EngineError("CONFLICT", "sentiment story effect belongs to another topic or tick");
    }
  }
  const previousValue = previous?.value ?? 0;
  const elapsedTicks = previous === null ? 1 : tick - previous.tick;
  const decayedValue = decaySentimentAcrossTicks(previousValue, elapsedTicks);
  const storyDelta = clamp(
    effects.reduce((sum, effect) => sum + effect.delta, 0),
    SENTIMENT_TICK_STORY_DELTA_LIMIT,
  );
  return Object.freeze({
    previousTick: previous?.tick ?? null,
    previousValue,
    decayedValue,
    storyDelta,
    value: clamp(decayedValue + storyDelta, SENTIMENT_VALUE_LIMIT),
  });
}

interface OpinionMapping {
  readonly axis: OpinionAxis;
  readonly direction: -1 | 1;
}

function opinionMappings(topic: NewsTopic): readonly OpinionMapping[] {
  switch (topic) {
    case "economy":
      return [{ axis: "economicOptimism", direction: 1 }];
    case "employment":
      return [
        { axis: "redistribution", direction: -1 },
        { axis: "economicOptimism", direction: 1 },
      ];
    case "institutions":
      return [{ axis: "institutionalTrust", direction: 1 }];
    case "market":
      return [
        { axis: "regulation", direction: -1 },
        { axis: "economicOptimism", direction: 1 },
      ];
  }
}

function opinionImpulse(delta: number): number {
  if (delta === 0) return 0;
  const magnitude = Math.min(
    5,
    Math.max(1, Math.floor(Math.abs(delta) / OPINION_STORY_POINTS_PER_STEP)),
  );
  return delta < 0 ? -magnitude : magnitude;
}

export interface OpinionDriftProposal {
  readonly axis: OpinionAxis;
  readonly delta: number;
  readonly causeStoryIds: readonly string[];
  readonly causeContributionIds: readonly string[];
  readonly sourceSentimentUpdateIds: readonly string[];
}

export function opinionDriftFromContributions(
  rawContributions: readonly SentimentStoryContribution[],
): readonly OpinionDriftProposal[] {
  const contributions = rawContributions.map((value) => sentimentStoryContributionSchema.parse(value));
  const proposals: OpinionDriftProposal[] = [];
  for (const axis of OPINION_AXES) {
    const relevant: Array<{ contribution: SentimentStoryContribution; direction: -1 | 1 }> = [];
    let total = 0;
    for (const contribution of contributions) {
      const mapping = opinionMappings(contribution.storyTopic).find((candidate) => candidate.axis === axis);
      if (mapping === undefined || contribution.delta === 0) continue;
      relevant.push({ contribution, direction: mapping.direction });
      total += opinionImpulse(contribution.delta) * mapping.direction;
    }
    const delta = clamp(total, 5);
    if (delta === 0 || relevant.length === 0) continue;
    proposals.push(Object.freeze({
      axis,
      delta,
      causeStoryIds: uniqueSorted(relevant.map(({ contribution }) => contribution.storyId)),
      causeContributionIds: uniqueSorted(relevant.map(({ contribution }) => contribution.id)),
      sourceSentimentUpdateIds: uniqueSorted(relevant.map(({ contribution }) => contribution.updateId)),
    }));
  }
  return Object.freeze(proposals);
}

/** Deterministic reach sampling. It is monotonic for one agent/story as reach rises. */
export function isAgentExposedToSentimentStory(
  agentId: string,
  rawContribution: SentimentStoryContribution,
): boolean {
  if (!/^agt_[0-9a-z]{8}$/.test(agentId)) {
    throw new EngineError("VALIDATION_FAILED", "sentiment exposure requires a valid agent ID");
  }
  const contribution = sentimentStoryContributionSchema.parse(rawContribution);
  if (contribution.reach === SENTIMENT_EXPOSURE_BUCKETS) return true;
  const digest = sha256Hex(canonicalStringify({
    agentId,
    storyId: contribution.storyId,
    rulesetVersion: SENTIMENT_RULESET_VERSION,
  }));
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % SENTIMENT_EXPOSURE_BUCKETS;
  return bucket < contribution.reach;
}

export function sentimentTopicForTrigger(
  kind: TriggerKind,
  payload: Readonly<Record<string, unknown>>,
): SentimentTopic {
  if (kind === "news") {
    const candidate = payload["topic"];
    if (candidate === "market") return "economy";
    const parsed = sentimentTopicSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  switch (kind) {
    case "schedule":
      return "employment";
    case "message":
    case "policy":
      return "institutions";
    case "stress":
    case "news":
    case "goal":
    case "company":
    case "market":
      return "economy";
  }
}

export function opinionAxisForSentimentTopic(topic: SentimentTopic): OpinionAxis {
  return topic === "institutions" ? "institutionalTrust" : "economicOptimism";
}

export interface DecisionPriorEvidence {
  readonly topic: SentimentTopic;
  readonly sentimentValue: number;
  readonly sentimentUpdate?: SentimentUpdate;
  readonly contributingStoryIds: readonly string[];
  readonly opinionAxis: OpinionAxis;
  readonly opinionValue: number;
  readonly opinionUpdate?: AgentOpinionUpdate;
}

export function buildDecisionPriorModifier(input: DecisionPriorEvidence): DecisionPriorModifier {
  const sentimentComponent = divideTowardZero(input.sentimentValue, 500);
  const opinionComponent = divideTowardZero(input.opinionValue, 10);
  const respondDelta = clamp(
    sentimentComponent + opinionComponent,
    DECISION_PRIOR_DELTA_LIMIT,
  );
  return decisionPriorModifierSchema.parse({
    rulesetVersion: SENTIMENT_RULESET_VERSION,
    topic: input.topic,
    sentimentValue: input.sentimentValue,
    ...(input.sentimentUpdate === undefined
      ? {}
      : {
          sentimentUpdateId: input.sentimentUpdate.id,
          sentimentSourceEventId: input.sentimentUpdate.sourceEventId,
        }),
    contributingStoryIds: uniqueSorted(input.contributingStoryIds).slice(0, 3),
    opinionAxis: input.opinionAxis,
    opinionValue: input.opinionValue,
    ...(input.opinionUpdate === undefined
      ? {}
      : {
          opinionUpdateId: input.opinionUpdate.id,
          opinionSourceEventId: input.opinionUpdate.sourceEventId,
        }),
    respondDelta,
    noOpDelta: -respondDelta,
  });
}
