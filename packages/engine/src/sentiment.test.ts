import { describe, expect, it } from "vitest";
import {
  SENTIMENT_RULESET_VERSION,
  decisionPriorModifierSchema,
  newsStorySchema,
  sentimentStoryContributionSchema,
} from "@worldtangle/shared";
import type {
  NewsStory,
  NewsTopic,
  SentimentStoryContribution,
} from "@worldtangle/shared";
import {
  buildDecisionPriorModifier,
  calculateSentimentStoryEffect,
  calculateSentimentUpdate,
  decaySentiment,
  decaySentimentAcrossTicks,
  isAgentExposedToSentimentStory,
  opinionDriftFromContributions,
  sentimentOutcomePolarity,
  sentimentTopicForTrigger,
} from "./sentiment";

function story(index: number, input: {
  readonly topic: NewsTopic;
  readonly stance: number;
  readonly reach: number;
  readonly eventType: string;
}): NewsStory {
  const suffix = index.toString(36).padStart(8, "0");
  const eventId = "evt_" + suffix;
  return newsStorySchema.parse({
    id: "nws_" + suffix,
    runId: "run_00000001",
    orgId: "norg_riverbend_ledger",
    authorAgentId: "agt_00000001",
    tick: 8,
    sourceTick: 7,
    reach: input.reach,
    status: "published",
    decisionId: "dec_" + suffix,
    sourceEventId: "evt_00000099",
    headline: "Verified development",
    body: "An exact committed event fact is attached.",
    topic: input.topic,
    entities: [],
    stance: input.stance,
    citedEventIds: [eventId],
    facts: [{
      eventId,
      eventFactHash: index.toString(16).padStart(64, "0"),
      eventType: input.eventType,
      tick: 7,
      simDate: "Y0001-M01-D07",
      actor: { kind: "system", id: "fixture" },
      correlationId: "fixture-" + index,
      payload: { fixture: index },
    }],
  });
}

function contribution(
  index: number,
  rawStory: NewsStory,
): SentimentStoryContribution {
  const effect = calculateSentimentStoryEffect(rawStory);
  const suffix = index.toString(36).padStart(8, "0");
  return sentimentStoryContributionSchema.parse({
    id: "sct_" + suffix,
    runId: rawStory.runId,
    updateId: "snt_" + suffix,
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
    sourceEventId: "evt_00000099",
    rulesetVersion: SENTIMENT_RULESET_VERSION,
  });
}

describe("WS-703 sentiment rules", () => {
  it("uses exact integer stance, reach, outcome, and decay goldens", () => {
    const positive = calculateSentimentStoryEffect(story(1, {
      topic: "economy",
      stance: 2,
      reach: 100_000,
      eventType: "company.formed",
    }));
    const negative = calculateSentimentStoryEffect(story(2, {
      topic: "institutions",
      stance: 0,
      reach: 1_000,
      eventType: "loan.defaulted",
    }));

    expect(positive).toMatchObject({
      topic: "economy",
      outcomeScore: 1_000,
      stanceDelta: 1_800,
      outcomeDelta: 200,
      delta: 2_000,
    });
    expect(negative).toMatchObject({
      topic: "institutions",
      outcomeScore: -1_000,
      stanceDelta: 0,
      outcomeDelta: -200,
      delta: -200,
    });
    expect(decaySentiment(2_000)).toBe(1_990);
    expect(decaySentiment(-2_000)).toBe(-1_990);
    expect(decaySentiment(1)).toBe(0);
    expect(decaySentimentAcrossTicks(2_000, 2)).toBe(1_980);
    expect(decaySentimentAcrossTicks(-2_000, 2)).toBe(-1_980);
    expect(sentimentOutcomePolarity("energy.system.initialized")).toBe(1);
    expect(sentimentOutcomePolarity("company.insolvency.detected")).toBe(-1);
  });

  it("caps aggregate story impact and the public index", () => {
    const effects = [1, 2, 3].map((index) => calculateSentimentStoryEffect(story(index, {
      topic: "economy",
      stance: 2,
      reach: 100_000,
      eventType: "company.formed",
    })));
    expect(calculateSentimentUpdate(8, "economy", null, effects)).toEqual({
      previousTick: null,
      previousValue: 0,
      decayedValue: 0,
      storyDelta: 2_500,
      value: 2_500,
    });
  });

  it("maps story effects into one attributed, five-point-capped drift per axis", () => {
    const employment = contribution(1, story(1, {
      topic: "employment",
      stance: 2,
      reach: 100_000,
      eventType: "employment.hired",
    }));
    const market = contribution(2, story(2, {
      topic: "market",
      stance: 2,
      reach: 100_000,
      eventType: "market.sale.completed",
    }));
    const proposals = opinionDriftFromContributions([employment, market]);

    expect(proposals).toEqual([
      {
        axis: "redistribution",
        delta: -5,
        causeStoryIds: [employment.storyId],
        causeContributionIds: [employment.id],
        sourceSentimentUpdateIds: [employment.updateId],
      },
      {
        axis: "regulation",
        delta: -5,
        causeStoryIds: [market.storyId],
        causeContributionIds: [market.id],
        sourceSentimentUpdateIds: [market.updateId],
      },
      {
        axis: "economicOptimism",
        delta: 5,
        causeStoryIds: [employment.storyId, market.storyId],
        causeContributionIds: [employment.id, market.id],
        sourceSentimentUpdateIds: [employment.updateId, market.updateId],
      },
    ]);
  });

  it("samples story exposure deterministically and monotonically from persisted reach", () => {
    const base = contribution(3, story(3, {
      topic: "economy",
      stance: 0,
      reach: 1_000,
      eventType: "company.formed",
    }));
    const broad = sentimentStoryContributionSchema.parse({ ...base, reach: 50_000 });
    const universal = sentimentStoryContributionSchema.parse({ ...base, reach: 100_000 });
    const agents = Array.from({ length: 100 }, (_, index) =>
      `agt_${(index + 1).toString(36).padStart(8, "0")}`);
    const narrowExposure = agents.filter((agentId) =>
      isAgentExposedToSentimentStory(agentId, base));
    const broadExposure = agents.filter((agentId) =>
      isAgentExposedToSentimentStory(agentId, broad));
    expect(broadExposure.length).toBeGreaterThan(narrowExposure.length);
    expect(narrowExposure.every((agentId) => broadExposure.includes(agentId))).toBe(true);
    expect(agents.every((agentId) => isAgentExposedToSentimentStory(agentId, universal)))
      .toBe(true);
  });

  it("bounds decision-prior deltas and rejects forged inverse values", () => {
    const positive = buildDecisionPriorModifier({
      topic: "economy",
      sentimentValue: 10_000,
      contributingStoryIds: [],
      opinionAxis: "economicOptimism",
      opinionValue: 100,
    });
    const negative = buildDecisionPriorModifier({
      topic: "institutions",
      sentimentValue: -10_000,
      contributingStoryIds: [],
      opinionAxis: "institutionalTrust",
      opinionValue: -100,
    });
    expect(positive).toMatchObject({ respondDelta: 25, noOpDelta: -25 });
    expect(negative).toMatchObject({ respondDelta: -25, noOpDelta: 25 });
    expect(decisionPriorModifierSchema.safeParse({ ...positive, noOpDelta: 25 }).success).toBe(false);
  });

  it("routes trigger kinds to the documented public topics", () => {
    expect(sentimentTopicForTrigger("news", { topic: "market" })).toBe("economy");
    expect(sentimentTopicForTrigger("schedule", {})).toBe("employment");
    expect(sentimentTopicForTrigger("policy", {})).toBe("institutions");
    expect(sentimentTopicForTrigger("goal", {})).toBe("economy");
  });
});
