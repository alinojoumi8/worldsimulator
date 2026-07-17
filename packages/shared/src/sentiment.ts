/** M15 deterministic public sentiment, opinion drift, and decision-prior contracts. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { runIdSchema } from "./simulation";

const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const newsStoryIdSchema = z.string().regex(/^nws_[0-9a-z]{8}$/);
const newsTopicSchema = z.enum(["economy", "employment", "institutions", "market"]);

export const SENTIMENT_RULESET_VERSION = 1;
export const SENTIMENT_VALUE_LIMIT = 10_000;
export const SENTIMENT_STORY_DELTA_LIMIT = 2_000;
export const SENTIMENT_TICK_STORY_DELTA_LIMIT = 2_500;
export const OPINION_TICK_DELTA_LIMIT = 5;
export const DECISION_PRIOR_DELTA_LIMIT = 25;

export const SENTIMENT_TOPICS = ["economy", "employment", "institutions"] as const;
export const sentimentTopicSchema = z.enum(SENTIMENT_TOPICS);
export type SentimentTopic = z.infer<typeof sentimentTopicSchema>;

export const OPINION_AXES = [
  "redistribution",
  "regulation",
  "institutionalTrust",
  "economicOptimism",
] as const;
export const opinionAxisSchema = z.enum(OPINION_AXES);
export type OpinionAxis = z.infer<typeof opinionAxisSchema>;

export const sentimentUpdateIdSchema = z.string().regex(/^snt_[0-9a-z]{8}$/);
export const sentimentContributionIdSchema = z.string().regex(/^sct_[0-9a-z]{8}$/);
export const agentOpinionUpdateIdSchema = z.string().regex(/^opu_[0-9a-z]{8}$/);

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

export const sentimentStoryContributionSchema = z.object({
  id: sentimentContributionIdSchema,
  runId: runIdSchema,
  updateId: sentimentUpdateIdSchema,
  storyId: newsStoryIdSchema,
  storyTopic: newsTopicSchema,
  topic: sentimentTopicSchema,
  tick: z.number().int().positive().safe(),
  stance: z.number().int().min(-2).max(2),
  reach: z.number().int().min(1).max(100_000).safe(),
  outcomeScore: z.number().int().min(-1_000).max(1_000),
  stanceDelta: z.number().int().min(-1_800).max(1_800),
  outcomeDelta: z.number().int().min(-200).max(200),
  delta: z.number().int().min(-SENTIMENT_STORY_DELTA_LIMIT)
    .max(SENTIMENT_STORY_DELTA_LIMIT),
  citedEventIds: z.array(eventIdSchema).min(1).max(8),
  sourceEventId: eventIdSchema,
  rulesetVersion: z.literal(SENTIMENT_RULESET_VERSION),
}).strict().superRefine((contribution, ctx) => {
  if (!unique(contribution.citedEventIds)) {
    ctx.addIssue({
      code: "custom",
      path: ["citedEventIds"],
      message: "cited event IDs must be unique",
    });
  }
  const expected = clamp(
    contribution.stanceDelta + contribution.outcomeDelta,
    SENTIMENT_STORY_DELTA_LIMIT,
  );
  if (contribution.delta !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["delta"],
      message: "story delta must equal the capped stance and outcome sum",
    });
  }
});
export type SentimentStoryContribution = z.infer<typeof sentimentStoryContributionSchema>;

export const sentimentUpdateSchema = z.object({
  id: sentimentUpdateIdSchema,
  runId: runIdSchema,
  topic: sentimentTopicSchema,
  tick: z.number().int().positive().safe(),
  previousTick: z.number().int().nonnegative().safe().nullable(),
  previousValue: z.number().int().min(-SENTIMENT_VALUE_LIMIT).max(SENTIMENT_VALUE_LIMIT),
  decayedValue: z.number().int().min(-SENTIMENT_VALUE_LIMIT).max(SENTIMENT_VALUE_LIMIT),
  storyDelta: z.number().int().min(-SENTIMENT_TICK_STORY_DELTA_LIMIT)
    .max(SENTIMENT_TICK_STORY_DELTA_LIMIT),
  value: z.number().int().min(-SENTIMENT_VALUE_LIMIT).max(SENTIMENT_VALUE_LIMIT),
  contributingStoryIds: z.array(newsStoryIdSchema).max(3),
  contributionIds: z.array(sentimentContributionIdSchema).max(3),
  sourceEventId: eventIdSchema,
  rulesetVersion: z.literal(SENTIMENT_RULESET_VERSION),
}).strict().superRefine((update, ctx) => {
  if (update.previousTick !== null && update.previousTick >= update.tick) {
    ctx.addIssue({
      code: "custom",
      path: ["previousTick"],
      message: "previous sentiment tick must precede the update tick",
    });
  }
  if (
    update.contributingStoryIds.length !== update.contributionIds.length ||
    !unique(update.contributingStoryIds) ||
    !unique(update.contributionIds)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["contributionIds"],
      message: "story and contribution IDs must be unique one-to-one lists",
    });
  }
  const expected = clamp(update.decayedValue + update.storyDelta, SENTIMENT_VALUE_LIMIT);
  if (update.value !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "sentiment value must equal the bounded decay plus story delta",
    });
  }
});
export type SentimentUpdate = z.infer<typeof sentimentUpdateSchema>;

export const agentOpinionUpdateSchema = z.object({
  id: agentOpinionUpdateIdSchema,
  runId: runIdSchema,
  agentId: agentIdSchema,
  axis: opinionAxisSchema,
  tick: z.number().int().positive().safe(),
  previousValue: z.number().int().min(-100).max(100),
  delta: z.number().int().min(-OPINION_TICK_DELTA_LIMIT).max(OPINION_TICK_DELTA_LIMIT)
    .refine((value) => value !== 0, "opinion updates must change the value"),
  value: z.number().int().min(-100).max(100),
  causeStoryIds: z.array(newsStoryIdSchema).min(1).max(3),
  causeContributionIds: z.array(sentimentContributionIdSchema).min(1).max(3),
  sourceSentimentUpdateIds: z.array(sentimentUpdateIdSchema).min(1).max(3),
  sourceEventId: eventIdSchema,
  rulesetVersion: z.literal(SENTIMENT_RULESET_VERSION),
}).strict().superRefine((update, ctx) => {
  if (
    !unique(update.causeStoryIds) ||
    !unique(update.causeContributionIds) ||
    !unique(update.sourceSentimentUpdateIds)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["causeStoryIds"],
      message: "opinion causes must be unique",
    });
  }
  if (update.value !== clamp(update.previousValue + update.delta, 100)) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "opinion value must equal the bounded previous value plus delta",
    });
  }
});
export type AgentOpinionUpdate = z.infer<typeof agentOpinionUpdateSchema>;

export const decisionPriorModifierSchema = z.object({
  rulesetVersion: z.literal(SENTIMENT_RULESET_VERSION),
  topic: sentimentTopicSchema,
  sentimentValue: z.number().int().min(-SENTIMENT_VALUE_LIMIT).max(SENTIMENT_VALUE_LIMIT),
  sentimentUpdateId: sentimentUpdateIdSchema.optional(),
  sentimentSourceEventId: eventIdSchema.optional(),
  contributingStoryIds: z.array(newsStoryIdSchema).max(3),
  opinionAxis: opinionAxisSchema,
  opinionValue: z.number().int().min(-100).max(100),
  opinionUpdateId: agentOpinionUpdateIdSchema.optional(),
  opinionSourceEventId: eventIdSchema.optional(),
  respondDelta: z.number().int().min(-DECISION_PRIOR_DELTA_LIMIT)
    .max(DECISION_PRIOR_DELTA_LIMIT),
  noOpDelta: z.number().int().min(-DECISION_PRIOR_DELTA_LIMIT)
    .max(DECISION_PRIOR_DELTA_LIMIT),
}).strict().superRefine((modifier, ctx) => {
  if ((modifier.sentimentUpdateId === undefined) !== (modifier.sentimentSourceEventId === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["sentimentSourceEventId"],
      message: "sentiment update and event evidence must be supplied together",
    });
  }
  if ((modifier.opinionUpdateId === undefined) !== (modifier.opinionSourceEventId === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["opinionSourceEventId"],
      message: "opinion update and event evidence must be supplied together",
    });
  }
  if (modifier.noOpDelta !== -modifier.respondDelta) {
    ctx.addIssue({
      code: "custom",
      path: ["noOpDelta"],
      message: "no-op prior delta must oppose the response delta",
    });
  }
});
export type DecisionPriorModifier = z.infer<typeof decisionPriorModifierSchema>;
