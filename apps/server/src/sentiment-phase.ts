/** WS-703 tick phase for public sentiment and attributed agent opinion drift. */

import {
  SENTIMENT_RULESET_VERSION,
  SENTIMENT_TOPICS,
  agentOpinionUpdateSchema,
  sentimentStoryContributionSchema,
  sentimentUpdateSchema,
} from "@worldtangle/shared";
import type {
  AgentOpinionUpdate,
  EventEnvelope,
  SentimentStoryContribution,
  SentimentUpdate,
} from "@worldtangle/shared";
import {
  calculateSentimentStoryEffect,
  calculateSentimentUpdate,
  isAgentExposedToSentimentStory,
  opinionDriftFromContributions,
} from "@worldtangle/engine";
import type { PhaseHandler } from "@worldtangle/engine";
import {
  SqliteNewsStore,
  SqliteSentimentStore,
  type WorldDatabase,
} from "./persistence";

const SYSTEM_ACTOR = { kind: "system", id: "sentiment-engine" } as const;

function emittedEventId(value: EventEnvelope | string | void): string {
  const eventId = typeof value === "string" ? value : value?.eventId;
  if (eventId === undefined || !/^evt_[0-9a-z]{8,}$/.test(eventId)) {
    throw new Error("sentiment telemetry lacked an event ID");
  }
  return eventId;
}

function clampOpinion(value: number): number {
  return Math.max(-100, Math.min(100, value));
}

export function createSentimentPhaseHandler(
  db: WorldDatabase,
  runId: string,
): PhaseHandler {
  const news = new SqliteNewsStore(db, runId);
  const store = new SqliteSentimentStore(db, runId);
  return {
    module: "M15-sentiment-engine",
    order: 60,
    run(ctx) {
      const stories = news.listStories({ tick: ctx.tick, status: "published" });
      const effects = stories.map(calculateSentimentStoryEffect);
      const recordedContributions: SentimentStoryContribution[] = [];
      const recordedUpdates = new Map<string, SentimentUpdate>();

      for (const topic of SENTIMENT_TOPICS) {
        const topicEffects = effects.filter((effect) => effect.topic === topic);
        if (topicEffects.length === 0) continue;
        const previous = store.getCurrentSentiment(topic, ctx.tick - 1);
        const calculated = calculateSentimentUpdate(ctx.tick, topic, previous, topicEffects);

        const updateId = ctx.ids.next("snt");
        const contributionIds = topicEffects.map(() => ctx.ids.next("sct"));
        const updateEvent = ctx.emit(
          "sentiment.updated",
          {
            updateId,
            topic,
            tick: ctx.tick,
            previousTick: calculated.previousTick,
            previousValue: calculated.previousValue,
            decayedValue: calculated.decayedValue,
            storyDelta: calculated.storyDelta,
            value: calculated.value,
            contributingStories: topicEffects.map((effect, index) => ({
              contributionId: contributionIds[index]!,
              storyId: effect.storyId,
              storyTopic: effect.storyTopic,
              stance: effect.stance,
              reach: effect.reach,
              outcomeScore: effect.outcomeScore,
              stanceDelta: effect.stanceDelta,
              outcomeDelta: effect.outcomeDelta,
              delta: effect.delta,
              citedEventIds: effect.citedEventIds,
            })),
            caps: {
              index: 10_000,
              perStory: 2_000,
              perTopicTick: 2_500,
            },
            rulesetVersion: SENTIMENT_RULESET_VERSION,
          },
          {
            actor: SYSTEM_ACTOR,
            correlationId: updateId,
            ...(topicEffects[0] === undefined
              ? {}
              : {
                  causationId: stories.find((story) => story.id === topicEffects[0]!.storyId)!
                    .sourceEventId,
                }),
          },
        );
        const sourceEventId = emittedEventId(updateEvent);
        const contributions = topicEffects.map((effect, index) =>
          sentimentStoryContributionSchema.parse({
            id: contributionIds[index],
            runId,
            updateId,
            storyId: effect.storyId,
            storyTopic: effect.storyTopic,
            topic: effect.topic,
            tick: effect.tick,
            stance: effect.stance,
            reach: effect.reach,
            outcomeScore: effect.outcomeScore,
            stanceDelta: effect.stanceDelta,
            outcomeDelta: effect.outcomeDelta,
            delta: effect.delta,
            citedEventIds: effect.citedEventIds,
            sourceEventId,
            rulesetVersion: SENTIMENT_RULESET_VERSION,
          }));
        const update = sentimentUpdateSchema.parse({
          id: updateId,
          runId,
          topic,
          tick: ctx.tick,
          ...calculated,
          contributingStoryIds: contributions.map((value) => value.storyId),
          contributionIds: contributions.map((value) => value.id),
          sourceEventId,
          rulesetVersion: SENTIMENT_RULESET_VERSION,
        });
        store.recordSentimentUpdate(update, contributions);
        recordedContributions.push(...contributions);
        recordedUpdates.set(update.id, update);
      }

      if (recordedContributions.length === 0) return;
      const subjects = store.listOpinionSubjects(ctx.tick - 1);
      const pendingOpinionUpdates: Array<Readonly<{
        id: string;
        agentId: string;
        axis: AgentOpinionUpdate["axis"];
        tick: number;
        previousValue: number;
        delta: number;
        value: number;
        causeStoryIds: readonly string[];
        causeContributionIds: readonly string[];
        sourceSentimentUpdateIds: readonly string[];
        sourceSentimentEventIds: readonly string[];
      }>> = [];
      for (const subject of subjects) {
        const exposedContributions = recordedContributions.filter((contribution) =>
          isAgentExposedToSentimentStory(subject.agentId, contribution));
        const proposals = opinionDriftFromContributions(exposedContributions);
        for (const proposal of proposals) {
          const previousValue = subject.opinions[proposal.axis];
          const value = clampOpinion(previousValue + proposal.delta);
          const delta = value - previousValue;
          if (delta === 0) continue;
          const opinionUpdateId = ctx.ids.next("opu");
          const sentimentEvents = proposal.sourceSentimentUpdateIds.map((id) => {
            const update = recordedUpdates.get(id);
            if (update === undefined) throw new Error(`missing sentiment update ${id}`);
            return update.sourceEventId;
          });
          pendingOpinionUpdates.push(Object.freeze({
            id: opinionUpdateId,
            agentId: subject.agentId,
            axis: proposal.axis,
            tick: ctx.tick,
            previousValue,
            delta,
            value,
            causeStoryIds: proposal.causeStoryIds,
            causeContributionIds: proposal.causeContributionIds,
            sourceSentimentUpdateIds: proposal.sourceSentimentUpdateIds,
            sourceSentimentEventIds: sentimentEvents,
          }));
        }
      }
      if (pendingOpinionUpdates.length === 0) return;
      const opinionBatchId = ctx.ids.next("opb");
      const opinionEvent = ctx.emit(
        "agent.opinions.updated",
        {
          opinionBatchId,
          tick: ctx.tick,
          updates: pendingOpinionUpdates.map((update) => ({
            opinionUpdateId: update.id,
            agentId: update.agentId,
            axis: update.axis,
            previousValue: update.previousValue,
            delta: update.delta,
            value: update.value,
            causeStoryIds: update.causeStoryIds,
            causeContributionIds: update.causeContributionIds,
            sourceSentimentUpdateIds: update.sourceSentimentUpdateIds,
            sourceSentimentEventIds: update.sourceSentimentEventIds,
          })),
          perAgentAxisTickDeltaCap: 5,
          rulesetVersion: SENTIMENT_RULESET_VERSION,
        },
        {
          actor: SYSTEM_ACTOR,
          correlationId: opinionBatchId,
          causationId: pendingOpinionUpdates[0]!.sourceSentimentEventIds[0]!,
        },
      );
      const sourceEventId = emittedEventId(opinionEvent);
      const opinionUpdates = pendingOpinionUpdates.map((update) =>
        agentOpinionUpdateSchema.parse({
          id: update.id,
          runId,
          agentId: update.agentId,
          axis: update.axis,
          tick: update.tick,
          previousValue: update.previousValue,
          delta: update.delta,
          value: update.value,
          causeStoryIds: update.causeStoryIds,
          causeContributionIds: update.causeContributionIds,
          sourceSentimentUpdateIds: update.sourceSentimentUpdateIds,
          sourceEventId,
          rulesetVersion: SENTIMENT_RULESET_VERSION,
        }));
      store.recordOpinionUpdates(opinionUpdates);
    },
  };
}
