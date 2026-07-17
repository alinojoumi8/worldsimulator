import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalParse, canonicalStringify, decisionSchema, type LlmMode } from "@worldtangle/shared";
import { MockLlmProvider, newsStoryFactFromEvent } from "@worldtangle/engine";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteEventStore,
  SqliteLlmCallStore,
  SqliteNewsStore,
  SqliteSentimentStore,
  SqliteSnapshotStore,
} from "./persistence";
import { SimulationService } from "./simulation-service";
import {
  isNewsStoryPublicationSourceTick,
  NEWS_STORY_PUBLICATION_INTERVAL_TICKS,
} from "./news-phase";

const directories: string[] = [];
const services: SimulationService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runOneTick(input: {
  readonly llmMode: LlmMode;
  readonly invalidNewsProposal?: boolean;
  readonly snapshots?: boolean;
  readonly ticks?: number;
}) {
  const ticks = input.ticks ?? 1;
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-news-phase-"));
  directories.push(dataDir);
  const provider = input.invalidNewsProposal
    ? new MockLlmProvider({
        script: (request) => request.purpose === "news.story.select"
          ? {
              actionId: "news.story.publish.neutral",
              params: { draftId: "neutral", draftHash: "0".repeat(64) },
              rationale: "attempted fact substitution",
            }
          : undefined,
      })
    : undefined;
  const service = new SimulationService({
    dataDir,
    wallClock: () => "2026-07-16T12:00:00.000Z",
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: input.snapshots ? 1 : 100,
    ...(provider === undefined ? {} : { llmProviderFactory: () => provider }),
  });
  services.push(service);
  const created = service.createSimulation({
    name: `WS-702 ${input.llmMode} story pipeline`,
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      llmMode: input.llmMode,
      budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 100_000 },
      policyOverrides: {},
      endTick: Math.max(5, ticks),
    },
  }, `ws702-create-${input.llmMode}`);
  service.controlSimulation(created.simulation.id, "start", {}, `ws702-start-${input.llmMode}`);
  service.controlSimulation(created.simulation.id, "pause", {}, `ws702-pause-${input.llmMode}`);
  const advanced = await service.advanceSimulation(
    created.simulation.id,
    { runId: created.run.id, ticks },
    `ws702-advance-${input.llmMode}`,
  );
  expect(advanced).toMatchObject({ statusCode: 200, body: { run: { currentTick: ticks } } });
  service.close();
  services.splice(services.indexOf(service), 1);
  return {
    dataDir,
    simulationId: created.simulation.id,
    runId: created.run.id,
  };
}

describe("WS-702 story pipeline", () => {
  it("opens deterministic 30-tick editorial windows while retaining a daily cap", () => {
    expect(NEWS_STORY_PUBLICATION_INTERVAL_TICKS).toBe(30);
    expect(isNewsStoryPublicationSourceTick(0)).toBe(true);
    expect(isNewsStoryPublicationSourceTick(1)).toBe(false);
    expect(isNewsStoryPublicationSourceTick(30)).toBe(true);
    expect(() => isNewsStoryPublicationSourceTick(-1)).toThrow("must be nonnegative");
  });

  it("publishes deterministic LLM-off templates with exact citations and restore equivalence", async () => {
    const run = await runOneTick({ llmMode: "off", snapshots: true });
    const db = openWorldDatabase(run.dataDir, run.simulationId, run.runId);
    const news = new SqliteNewsStore(db, run.runId);
    const stories = news.listStories({ tick: 1 });
    expect(stories.length).toBeGreaterThan(0);
    expect(stories.length).toBeLessThanOrEqual(3);
    expect(stories.every((story) => story.status === "published" && story.llmCallId === undefined))
      .toBe(true);
    const sourceEvents = new Map(
      new SqliteEventStore(db, run.runId).list({ tick: 0 }).map((event) => [event.eventId, event]),
    );
    for (const story of stories) {
      for (const fact of story.facts) {
        const source = sourceEvents.get(fact.eventId);
        expect(source).toBeDefined();
        expect(canonicalStringify(fact)).toBe(canonicalStringify(newsStoryFactFromEvent(source!)));
      }
    }
    const sentiment = new SqliteSentimentStore(db, run.runId);
    const sentimentUpdates = sentiment.listSentimentUpdates({ tick: 1 });
    const contributions = sentiment.listContributions({ tick: 1 });
    const opinionUpdates = sentiment.listOpinionUpdates({ tick: 1 });
    expect(sentimentUpdates.length).toBeGreaterThan(0);
    expect(contributions).toHaveLength(stories.length);
    expect(new Set(contributions.map((value) => value.storyId))).toEqual(
      new Set(stories.map((story) => story.id)),
    );
    expect(opinionUpdates.length).toBeGreaterThan(0);
    expect(opinionUpdates.every((update) =>
      Math.abs(update.delta) <= 5 &&
      update.causeStoryIds.length > 0 &&
      update.causeContributionIds.length > 0 &&
      update.sourceSentimentUpdateIds.length > 0
    )).toBe(true);
    const sentimentEvents = new SqliteEventStore(db, run.runId)
      .list({ type: "sentiment.updated", tick: 1 });
    const opinionEvents = new SqliteEventStore(db, run.runId)
      .list({ type: "agent.opinions.updated", tick: 1 });
    expect(sentimentEvents).toHaveLength(sentimentUpdates.length);
    expect(opinionEvents).toHaveLength(1);
    const opinionPayload = opinionEvents[0]!.payload as {
      updates?: Array<{ opinionUpdateId: string }>;
    };
    expect(new Set((opinionPayload.updates ?? []).map((update) => update.opinionUpdateId)))
      .toEqual(new Set(opinionUpdates.map((update) => update.id)));
    expect(opinionUpdates.every((update) => update.sourceEventId === opinionEvents[0]!.eventId))
      .toBe(true);
    expect(sentimentEvents.every((event) => {
      const payload = event.payload as { contributingStories?: Array<{ storyId: string }> };
      return (payload.contributingStories ?? []).every(({ storyId }) =>
        stories.some((story) => story.id === storyId));
    })).toBe(true);
    const firstUpdate = sentimentUpdates[0]!;
    const firstUpdateContributions = contributions
      .filter((value) => value.updateId === firstUpdate.id);
    const forgedContributions = firstUpdateContributions.map((value, index) => index === 0
      ? { ...value, sourceEventId: stories[0]!.sourceEventId }
      : value);
    expect(() => sentiment.recordSentimentUpdate(firstUpdate, forgedContributions)).toThrow(
      "sentiment topic tick was already recorded",
    );
    expect(sentiment.listContributions({ tick: 1 })).toEqual(contributions);

    const snapshotStore = new SqliteSnapshotStore(
      db,
      run.dataDir,
      run.simulationId,
      run.runId,
    );
    const snapshot = snapshotStore.getAtTick(1);
    expect(snapshot).not.toBeNull();
    const liveHash = computeLogicalStateHash(db, run.runId);
    const restoredPath = join(run.dataDir, run.simulationId, run.runId, "restored-news.db");
    snapshotStore.restoreTo(snapshot!.id, restoredPath);
    const restored = openDatabaseFile(restoredPath);
    expect(computeLogicalStateHash(restored, run.runId)).toBe(liveHash);
    expect(new SqliteNewsStore(restored, run.runId).listStories()).toEqual(stories);
    const restoredSentiment = new SqliteSentimentStore(restored, run.runId);
    expect(restoredSentiment.listSentimentUpdates()).toEqual(sentimentUpdates);
    expect(restoredSentiment.listContributions()).toEqual(contributions);
    expect(restoredSentiment.listOpinionUpdates()).toEqual(opinionUpdates);
    restored.close();

    const duplicate = { ...stories[0]!, id: "nws_zzzzzzzz" };
    expect(() => news.insertStory(duplicate)).toThrow();
    expect(news.getStory(duplicate.id)).toBeNull();
    expect(news.listStories({ tick: 1 })).toEqual(stories);
    expect(() => db.prepare(`
      UPDATE sentiment_updates SET value = value + 1 WHERE run_id = ?
    `).run(run.runId)).toThrow("sentiment updates are immutable");
    expect(() => db.prepare(`
      DELETE FROM agent_opinion_updates WHERE run_id = ?
    `).run(run.runId)).toThrow("opinion updates cannot be deleted");
    db.close();
  });

  it("publishes valid mock menu selections with immutable LLM evidence", async () => {
    const run = await runOneTick({ llmMode: "mock" });
    const db = openWorldDatabase(run.dataDir, run.simulationId, run.runId);
    const stories = new SqliteNewsStore(db, run.runId).listStories({ tick: 1 });
    expect(stories.length).toBeGreaterThan(0);
    expect(stories.every((story) => story.status === "published" && story.llmCallId !== undefined))
      .toBe(true);
    const calls = new SqliteLlmCallStore(db, run.runId).list()
      .filter((call) => call.purpose === "news.story.select");
    expect(calls).toHaveLength(stories.length);
    expect(calls.every((call) => call.status === "success" && call.effectiveTier === 2)).toBe(true);
    db.close();
  });

  it("spikes schema-valid forged menu selections and publishes none", async () => {
    const run = await runOneTick({ llmMode: "mock", invalidNewsProposal: true });
    const db = openWorldDatabase(run.dataDir, run.simulationId, run.runId);
    const news = new SqliteNewsStore(db, run.runId);
    expect(news.listStories({ tick: 1, status: "published" })).toEqual([]);
    const spiked = news.listStories({ tick: 1, status: "spiked" });
    expect(spiked.length).toBeGreaterThan(0);
    expect(spiked.every((story) => story.spikeReason === "menu_mismatch" && story.reach === 0))
      .toBe(true);
    const calls = new SqliteLlmCallStore(db, run.runId).list()
      .filter((call) => call.purpose === "news.story.select");
    expect(calls).toHaveLength(spiked.length);
    expect(calls.every((call) =>
      call.status === "fallback" && call.fallbackReason === "validation_failed"
    )).toBe(true);
    const publicationEvents = new SqliteEventStore(db, run.runId)
      .list({ type: "news.story.published", tick: 1 });
    expect(publicationEvents).toEqual([]);
    db.close();
  });

  it("persists bounded, story-evidenced sentiment priors in later agent decisions", async () => {
    const run = await runOneTick({ llmMode: "off", ticks: 31 });
    const db = openWorldDatabase(run.dataDir, run.simulationId, run.runId);
    const decisions = db.prepare<[string], { decision_canonical: string }>(`
      SELECT decision_canonical FROM decisions
      WHERE run_id = ? AND tick = 31 ORDER BY id
    `).all(run.runId)
      .map((row) => decisionSchema.parse(canonicalParse(row.decision_canonical)))
      .filter((decision) => decision.tier === 1 && decision.trigger.kind === "goal");
    const sentimentStore = new SqliteSentimentStore(db, run.runId);
    const persistedSentimentTicks = new Set(
      sentimentStore.listSentimentUpdates().map((update) => update.tick),
    );
    expect(persistedSentimentTicks).toEqual(new Set([1, 31]));
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((decision) => {
      const prior = decision.priorModifier;
      if (prior === undefined) return false;
      const effective = sentimentStore.getEffectiveSentiment(prior.topic, 30);
      const factors = decision.optionsOffered.map((option) => option.utilityFactors);
      return Math.abs(prior.respondDelta) <= 25 &&
        prior.noOpDelta === -prior.respondDelta &&
        effective !== null &&
        prior.sentimentValue === effective.value &&
        prior.sentimentUpdateId === effective.update.id &&
        prior.sentimentUpdateId !== undefined &&
        prior.sentimentSourceEventId !== undefined &&
        prior.contributingStoryIds.length > 0 &&
        factors.every((value) => value?.["sentimentPriorVersion"] === 1);
    })).toBe(true);
    const eventIds = new Set(new SqliteEventStore(db, run.runId).list().map((event) => event.eventId));
    expect(decisions.every((decision) =>
      decision.priorModifier?.sentimentSourceEventId !== undefined &&
      eventIds.has(decision.priorModifier.sentimentSourceEventId)
    )).toBe(true);
    db.close();
  }, 30_000);
});
