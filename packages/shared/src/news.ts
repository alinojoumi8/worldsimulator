/** M14 news organization, digest, fact, and story contracts. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { actorRefSchema } from "./envelope";
import { llmCallIdSchema } from "./llm-call";
import { decisionIdSchema } from "./decision";
import { runIdSchema, simulationIdSchema } from "./simulation";

export const newsOrganizationIdSchema = z.string().regex(/^norg_[0-9a-z_]{8,64}$/);
export const newsDigestIdSchema = z.string().regex(/^ndg_[0-9a-z]{8}$/);
export const newsStoryIdSchema = z.string().regex(/^nws_[0-9a-z]{8}$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const NEWS_TOPICS = ["economy", "employment", "institutions", "market"] as const;
export const newsTopicSchema = z.enum(NEWS_TOPICS);
export type NewsTopic = z.infer<typeof newsTopicSchema>;

export const NEWS_STORY_STATUSES = ["published", "spiked"] as const;
export const newsStoryStatusSchema = z.enum(NEWS_STORY_STATUSES);

export const NEWS_STORY_SPIKE_REASONS = [
  "provider_error",
  "schema_invalid",
  "request_hash_mismatch",
  "menu_mismatch",
  "citation_invalid",
  "editor_cap",
  "duplicate",
] as const;
export const newsStorySpikeReasonSchema = z.enum(NEWS_STORY_SPIKE_REASONS);
export type NewsStorySpikeReason = z.infer<typeof newsStorySpikeReasonSchema>;

export const newsOrganizationSchema = z.object({
  id: newsOrganizationIdSchema,
  runId: runIdSchema,
  name: z.string().trim().min(1).max(160),
  editorAgentId: agentIdSchema,
  journalistAgentIds: z.array(agentIdSchema).min(1).max(3),
  dailyStoryCap: z.number().int().min(1).max(3).safe(),
  stanceBias: z.number().int().min(-2).max(2),
  createdTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((organization, ctx) => {
  if (new Set(organization.journalistAgentIds).size !== organization.journalistAgentIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["journalistAgentIds"],
      message: "journalist IDs must be unique",
    });
  }
  if (organization.journalistAgentIds.includes(organization.editorAgentId)) {
    ctx.addIssue({
      code: "custom",
      path: ["editorAgentId"],
      message: "editor cannot also be a staff journalist",
    });
  }
});
export type NewsOrganization = z.infer<typeof newsOrganizationSchema>;

/** Exact immutable source-event facts copied into a story. */
export const newsStoryFactSchema = z.object({
  eventId: eventIdSchema,
  eventFactHash: hashSchema,
  eventType: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  tick: z.number().int().nonnegative().safe(),
  simDate: z.string().regex(/^Y\d{4}-M(?:0[1-9]|1[0-2])-D(?:0[1-9]|[12]\d|30)$/),
  actor: actorRefSchema,
  correlationId: z.string().min(1).max(160),
  causationId: z.string().min(1).max(160).optional(),
  payload: z.unknown(),
}).strict();
export type NewsStoryFact = z.infer<typeof newsStoryFactSchema>;

export const newsStoryDraftSchema = z.object({
  headline: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(4_000),
  topic: newsTopicSchema,
  entities: z.array(z.string().trim().min(1).max(160)).max(64),
  stance: z.number().int().min(-2).max(2),
  citedEventIds: z.array(eventIdSchema).min(1).max(8),
  facts: z.array(newsStoryFactSchema).min(1).max(8),
}).strict().superRefine((draft, ctx) => {
  if (new Set(draft.entities).size !== draft.entities.length) {
    ctx.addIssue({ code: "custom", path: ["entities"], message: "entities must be unique" });
  }
  if (new Set(draft.citedEventIds).size !== draft.citedEventIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["citedEventIds"],
      message: "cited event IDs must be unique",
    });
  }
  const factIds = draft.facts.map((fact) => fact.eventId);
  if (
    factIds.length !== draft.citedEventIds.length ||
    factIds.some((eventId, index) => eventId !== draft.citedEventIds[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["facts"],
      message: "fact IDs must exactly match cited event IDs in order",
    });
  }
});
export type NewsStoryDraft = z.infer<typeof newsStoryDraftSchema>;

/** Strict menu-only Tier-2 response schema for journalist story choices. */
export const newsStoryChoiceParamsSchema = z.object({
  draftId: z.enum(["neutral", "context", "brief"]),
  draftHash: hashSchema,
}).strict();
export type NewsStoryChoiceParams = z.infer<typeof newsStoryChoiceParamsSchema>;

export const newsStorySelectionProposalSchema = z.object({
  actionId: z.string().regex(/^news\.story\.publish\.(neutral|context|brief)$/),
  params: newsStoryChoiceParamsSchema,
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
export type NewsStorySelectionProposal = z.infer<typeof newsStorySelectionProposalSchema>;

export const newsDigestRecordSchema = z.object({
  id: newsDigestIdSchema,
  runId: runIdSchema,
  sourceTick: z.number().int().nonnegative().safe(),
  publicationTick: z.number().int().positive().safe(),
  scoringVersion: z.number().int().positive().safe(),
  digestHash: hashSchema,
  totalCandidateCount: z.number().int().nonnegative().safe(),
  selectedEventIds: z.array(eventIdSchema).max(3),
  sourceEventId: eventIdSchema,
}).strict().superRefine((digest, ctx) => {
  if (digest.publicationTick !== digest.sourceTick + 1) {
    ctx.addIssue({
      code: "custom",
      path: ["publicationTick"],
      message: "news digests publish exactly one tick after their source window",
    });
  }
  if (new Set(digest.selectedEventIds).size !== digest.selectedEventIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["selectedEventIds"],
      message: "selected event IDs must be unique",
    });
  }
});
export type NewsDigestRecord = z.infer<typeof newsDigestRecordSchema>;

export const newsStorySchema = newsStoryDraftSchema.extend({
  id: newsStoryIdSchema,
  runId: runIdSchema,
  orgId: newsOrganizationIdSchema,
  authorAgentId: agentIdSchema,
  tick: z.number().int().positive().safe(),
  sourceTick: z.number().int().nonnegative().safe(),
  reach: z.number().int().min(0).max(100_000).safe(),
  status: newsStoryStatusSchema,
  spikeReason: newsStorySpikeReasonSchema.optional(),
  decisionId: decisionIdSchema,
  llmCallId: llmCallIdSchema.optional(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((story, ctx) => {
  if (story.tick !== story.sourceTick + 1) {
    ctx.addIssue({
      code: "custom",
      path: ["tick"],
      message: "stories publish or spike exactly one tick after their source event",
    });
  }
  if (story.facts.some((fact) => fact.tick !== story.sourceTick)) {
    ctx.addIssue({
      code: "custom",
      path: ["facts"],
      message: "every cited fact must belong to the story source tick",
    });
  }
  if (story.status === "published") {
    if (story.spikeReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["spikeReason"],
        message: "published stories cannot carry a spike reason",
      });
    }
    if (story.reach === 0) {
      ctx.addIssue({ code: "custom", path: ["reach"], message: "published reach must be positive" });
    }
  } else {
    if (story.spikeReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["spikeReason"],
        message: "spiked stories require a reason",
      });
    }
    if (story.reach !== 0) {
      ctx.addIssue({ code: "custom", path: ["reach"], message: "spiked stories have zero reach" });
    }
  }
});
export type NewsStory = z.infer<typeof newsStorySchema>;

const positiveIntegerQuery = z.coerce.number().int().positive().safe();
const nonnegativeIntegerQuery = z.coerce.number().int().nonnegative().safe();
const newsApiMetaSchema = z.object({
  simulated: z.literal(true),
  apiVersion: z.literal(1),
}).strict();

/** Bounded, run-scoped query for the published newsroom feed. */
export const newsListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(100).default(25),
  cursor: z.string().min(1).optional(),
  topic: newsTopicSchema.optional(),
  fromTick: nonnegativeIntegerQuery.optional(),
  toTick: nonnegativeIntegerQuery.optional(),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined || query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type NewsListQuery = z.infer<typeof newsListQuerySchema>;

export const newsStoryPathSchema = z.object({
  simId: simulationIdSchema,
  storyId: newsStoryIdSchema,
}).strict();

export const newsPartySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(160),
}).strict();

export const newsFeedItemSchema = z.object({
  id: newsStoryIdSchema,
  tick: z.number().int().positive().safe(),
  sourceTick: z.number().int().nonnegative().safe(),
  headline: z.string().trim().min(1).max(240),
  topic: newsTopicSchema,
  stance: z.number().int().min(-2).max(2),
  reach: z.number().int().positive().max(100_000).safe(),
  author: newsPartySchema.extend({ id: agentIdSchema }).strict(),
  org: newsPartySchema.extend({ id: newsOrganizationIdSchema }).strict(),
  citedEventIds: z.array(eventIdSchema).min(1).max(8),
  sourceEventId: eventIdSchema,
}).strict().superRefine((item, ctx) => {
  if (item.tick !== item.sourceTick + 1) {
    ctx.addIssue({
      code: "custom",
      path: ["tick"],
      message: "published feed items must follow their source tick",
    });
  }
  if (new Set(item.citedEventIds).size !== item.citedEventIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["citedEventIds"],
      message: "cited event IDs must be unique",
    });
  }
});
export type NewsFeedItem = z.infer<typeof newsFeedItemSchema>;

export const newsSentimentSeriesSchema = z.object({
  topic: z.enum(["economy", "employment", "institutions"]),
  points: z.array(z.tuple([
    z.number().int().positive().safe(),
    z.number().int().min(-10_000).max(10_000),
  ])).superRefine((points, ctx) => {
    for (let index = 1; index < points.length; index += 1) {
      if (points[index]![0] <= points[index - 1]![0]) {
        ctx.addIssue({
          code: "custom",
          path: [index, 0],
          message: "sentiment points must be strictly tick ordered",
        });
      }
    }
  }),
}).strict();

export const newsListResponseSchema = z.object({
  items: z.array(newsFeedItemSchema),
  nextCursor: z.string().min(1).nullable(),
  sentiment: z.array(newsSentimentSeriesSchema).length(3).superRefine((series, ctx) => {
    const topics = series.map((entry) => entry.topic);
    if (
      topics[0] !== "economy" ||
      topics[1] !== "employment" ||
      topics[2] !== "institutions"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "sentiment series must use canonical topic order",
      });
    }
  }),
  meta: newsApiMetaSchema,
}).strict();
export type NewsListResponse = z.infer<typeof newsListResponseSchema>;

export const newsStoryDetailSchema = z.object({
  id: newsStoryIdSchema,
  tick: z.number().int().positive().safe(),
  sourceTick: z.number().int().nonnegative().safe(),
  headline: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(4_000),
  topic: newsTopicSchema,
  stance: z.number().int().min(-2).max(2),
  reach: z.number().int().positive().max(100_000).safe(),
  entities: z.array(z.string().trim().min(1).max(160)).max(64),
  author: newsPartySchema.extend({ id: agentIdSchema }).strict(),
  org: newsPartySchema.extend({ id: newsOrganizationIdSchema }).strict(),
  citedEventIds: z.array(eventIdSchema).min(1).max(8),
  decisionId: decisionIdSchema,
  llmCallId: llmCallIdSchema.optional(),
  sourceEventId: eventIdSchema,
}).strict();

export const newsSentimentImpactSchema = z.object({
  topic: z.enum(["economy", "employment", "institutions"]),
  delta: z.number().int().min(-2_000).max(2_000),
  stanceDelta: z.number().int().min(-1_800).max(1_800),
  outcomeDelta: z.number().int().min(-200).max(200),
  sourceEventId: eventIdSchema,
}).strict().refine(
  (impact) => impact.delta === Math.max(-2_000, Math.min(2_000, impact.stanceDelta + impact.outcomeDelta)),
  { path: ["delta"], message: "sentiment impact must reconcile to its components" },
);

export const newsStoryDetailResponseSchema = z.object({
  story: newsStoryDetailSchema,
  citedEvents: z.array(newsStoryFactSchema).min(1).max(8),
  sentimentImpact: z.array(newsSentimentImpactSchema).max(3),
  meta: newsApiMetaSchema,
}).strict().superRefine((detail, ctx) => {
  const citedIds = detail.citedEvents.map((event) => event.eventId);
  if (
    citedIds.length !== detail.story.citedEventIds.length ||
    citedIds.some((eventId, index) => eventId !== detail.story.citedEventIds[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["citedEvents"],
      message: "detail citations must exactly match the story",
    });
  }
});
export type NewsStoryDetailResponse = z.infer<typeof newsStoryDetailResponseSchema>;
