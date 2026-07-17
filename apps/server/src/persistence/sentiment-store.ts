/** WS-703 immutable sentiment indices, story attribution, and agent opinion history. */

import {
  OPINION_AXES,
  agentOpinionUpdateSchema,
  canonicalParse,
  canonicalStringify,
  EngineError,
  opinionAxesSchema,
  sentimentStoryContributionSchema,
  sentimentTopicSchema,
  sentimentUpdateSchema,
} from "@worldtangle/shared";
import type {
  AgentOpinionUpdate,
  OpinionAxes,
  OpinionAxis,
  SentimentStoryContribution,
  SentimentTopic,
  SentimentUpdate,
} from "@worldtangle/shared";
import {
  calculateSentimentStoryEffect,
  calculateSentimentUpdate,
  sentimentValueAtTick,
  sentimentTopicForNewsTopic,
} from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { SqliteNewsStore } from "./news-store";

interface CanonicalRow {
  canonical: string;
}

interface OpinionSeedRow {
  opinions_canonical: string;
}

interface OpinionSubjectRow extends OpinionSeedRow {
  agent_id: string;
}

interface LatestOpinionRow extends CanonicalRow {
  agent_id: string;
  axis: OpinionAxis;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCanonicalRecord<T>(
  text: string,
  label: string,
  parse: (value: unknown) => T,
): T {
  try {
    const value = canonicalParse(text);
    if (canonicalStringify(value) !== text) throw new Error("value is not canonical");
    return parse(value);
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${label} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function sentimentFromRow(row: CanonicalRow): SentimentUpdate {
  return parseCanonicalRecord(row.canonical, "sentiment update", (value) =>
    sentimentUpdateSchema.parse(value));
}

function contributionFromRow(row: CanonicalRow): SentimentStoryContribution {
  return parseCanonicalRecord(row.canonical, "sentiment contribution", (value) =>
    sentimentStoryContributionSchema.parse(value));
}

function opinionFromRow(row: CanonicalRow): AgentOpinionUpdate {
  return parseCanonicalRecord(row.canonical, "agent opinion update", (value) =>
    agentOpinionUpdateSchema.parse(value));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export interface CurrentOpinion {
  readonly value: number;
  readonly update: AgentOpinionUpdate | null;
}

export interface EffectiveSentiment {
  readonly value: number;
  readonly update: SentimentUpdate;
}

export interface OpinionSubject {
  readonly agentId: string;
  readonly opinions: OpinionAxes;
}

export class SqliteSentimentStore {
  private readonly news: SqliteNewsStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    this.news = new SqliteNewsStore(db, runId);
  }

  getSentimentUpdate(id: string): SentimentUpdate | null {
    const row = this.db.prepare<[string, string], CanonicalRow>(`
      SELECT update_canonical AS canonical
      FROM sentiment_updates WHERE run_id = ? AND id = ?
    `).get(this.runId, id);
    return row === undefined ? null : sentimentFromRow(row);
  }

  getCurrentSentiment(topic: SentimentTopic, throughTick?: number): SentimentUpdate | null {
    sentimentTopicSchema.parse(topic);
    const row = throughTick === undefined
      ? this.db.prepare<[string, string], CanonicalRow>(`
          SELECT update_canonical AS canonical FROM sentiment_updates
          WHERE run_id = ? AND topic = ? ORDER BY tick DESC, id DESC LIMIT 1
        `).get(this.runId, topic)
      : this.db.prepare<[string, string, number], CanonicalRow>(`
          SELECT update_canonical AS canonical FROM sentiment_updates
          WHERE run_id = ? AND topic = ? AND tick <= ?
          ORDER BY tick DESC, id DESC LIMIT 1
        `).get(this.runId, topic, throughTick);
    return row === undefined ? null : sentimentFromRow(row);
  }

  getEffectiveSentiment(topic: SentimentTopic, throughTick: number): EffectiveSentiment | null {
    if (!Number.isSafeInteger(throughTick) || throughTick < 0) {
      throw new EngineError("VALIDATION_FAILED", "effective sentiment tick must be nonnegative");
    }
    const update = this.getCurrentSentiment(topic, throughTick);
    return update === null
      ? null
      : Object.freeze({ update, value: sentimentValueAtTick(update, throughTick) });
  }

  listSentimentUpdates(input: {
    readonly topic?: SentimentTopic;
    readonly tick?: number;
  } = {}): readonly SentimentUpdate[] {
    const conditions = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId };
    if (input.topic !== undefined) {
      sentimentTopicSchema.parse(input.topic);
      conditions.push("topic = @topic");
      params["topic"] = input.topic;
    }
    if (input.tick !== undefined) {
      conditions.push("tick = @tick");
      params["tick"] = input.tick;
    }
    return Object.freeze(this.db.prepare<Record<string, string | number>, CanonicalRow>(`
      SELECT update_canonical AS canonical FROM sentiment_updates
      WHERE ${conditions.join(" AND ")} ORDER BY tick, topic, id
    `).all(params).map(sentimentFromRow));
  }

  getContribution(id: string): SentimentStoryContribution | null {
    const row = this.db.prepare<[string, string], CanonicalRow>(`
      SELECT contribution_canonical AS canonical
      FROM sentiment_story_contributions WHERE run_id = ? AND id = ?
    `).get(this.runId, id);
    return row === undefined ? null : contributionFromRow(row);
  }

  listContributions(input: {
    readonly topic?: SentimentTopic;
    readonly tick?: number;
  } = {}): readonly SentimentStoryContribution[] {
    const conditions = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId };
    if (input.topic !== undefined) {
      sentimentTopicSchema.parse(input.topic);
      conditions.push("topic = @topic");
      params["topic"] = input.topic;
    }
    if (input.tick !== undefined) {
      conditions.push("tick = @tick");
      params["tick"] = input.tick;
    }
    return Object.freeze(this.db.prepare<Record<string, string | number>, CanonicalRow>(`
      SELECT contribution_canonical AS canonical FROM sentiment_story_contributions
      WHERE ${conditions.join(" AND ")} ORDER BY tick, topic, story_id, id
    `).all(params).map(contributionFromRow));
  }

  listRecentContributingStoryIds(topic: SentimentTopic, limit = 3): readonly string[] {
    sentimentTopicSchema.parse(topic);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 3) {
      throw new EngineError("VALIDATION_FAILED", "sentiment evidence limit must be 0..3");
    }
    return Object.freeze(this.db.prepare<
      { runId: string; topic: string; limit: number },
      { story_id: string }
    >(`
      SELECT story_id FROM sentiment_story_contributions
      WHERE run_id = @runId AND topic = @topic
      ORDER BY tick DESC, story_id DESC LIMIT @limit
    `).all({ runId: this.runId, topic, limit }).map((row) => row.story_id));
  }

  recordSentimentUpdate(
    rawUpdate: SentimentUpdate,
    rawContributions: readonly SentimentStoryContribution[],
  ): SentimentUpdate {
    const update = sentimentUpdateSchema.parse(rawUpdate);
    const contributions = rawContributions.map((value) =>
      sentimentStoryContributionSchema.parse(value));
    if (update.runId !== this.runId || contributions.some((value) => value.runId !== this.runId)) {
      throw new EngineError("CONFLICT", "sentiment record belongs to another run");
    }
    const existing = this.db.prepare<[string, string, number], CanonicalRow>(`
      SELECT update_canonical AS canonical FROM sentiment_updates
      WHERE run_id = ? AND topic = ? AND tick = ?
    `).get(this.runId, update.topic, update.tick);
    if (existing !== undefined) {
      const persisted = sentimentFromRow(existing);
      const persistedContributions = this.db.prepare<[string, string], CanonicalRow>(`
        SELECT contribution_canonical AS canonical
        FROM sentiment_story_contributions
        WHERE run_id = ? AND update_id = ? ORDER BY story_id, id
      `).all(this.runId, persisted.id).map(contributionFromRow);
      if (
        !sameCanonical(persisted, update) ||
        !sameCanonical(persistedContributions, contributions)
      ) {
        throw new EngineError("CONFLICT", "sentiment topic tick was already recorded");
      }
      return persisted;
    }
    if (
      !sameCanonical(update.contributingStoryIds, contributions.map((value) => value.storyId)) ||
      !sameCanonical(update.contributionIds, contributions.map((value) => value.id))
    ) {
      throw new EngineError("VALIDATION_FAILED", "sentiment update contribution lists do not match");
    }
    const previous = this.getCurrentSentiment(update.topic, update.tick - 1);
    const calculated = calculateSentimentUpdate(update.tick, update.topic, previous, contributions);
    if (
      update.previousTick !== calculated.previousTick ||
      update.previousValue !== calculated.previousValue ||
      update.decayedValue !== calculated.decayedValue ||
      update.storyDelta !== calculated.storyDelta ||
      update.value !== calculated.value
    ) {
      throw new EngineError("VALIDATION_FAILED", "sentiment update does not match ruleset v1");
    }
    for (const contribution of contributions) {
      if (
        contribution.updateId !== update.id ||
        contribution.topic !== update.topic ||
        contribution.tick !== update.tick ||
        contribution.sourceEventId !== update.sourceEventId
      ) {
        throw new EngineError("CONFLICT", "sentiment contribution is detached from its update");
      }
      const story = this.news.getStory(contribution.storyId);
      if (story === null || story.status !== "published") {
        throw new EngineError("NOT_FOUND", `published story ${contribution.storyId} does not exist`);
      }
      const effect = calculateSentimentStoryEffect(story);
      if (
        contribution.tick !== effect.tick ||
        contribution.storyTopic !== effect.storyTopic ||
        contribution.topic !== sentimentTopicForNewsTopic(story.topic) ||
        contribution.stance !== effect.stance ||
        contribution.reach !== effect.reach ||
        contribution.outcomeScore !== effect.outcomeScore ||
        contribution.stanceDelta !== effect.stanceDelta ||
        contribution.outcomeDelta !== effect.outcomeDelta ||
        contribution.delta !== effect.delta ||
        !sameCanonical(contribution.citedEventIds, effect.citedEventIds)
      ) {
        throw new EngineError("VALIDATION_FAILED", "sentiment contribution altered story facts");
      }
    }

    const persist = (): void => {
      this.db.prepare(`
        INSERT INTO sentiment_updates(
          run_id, id, topic, tick, previous_tick, previous_value, decayed_value,
          story_delta, value, contributing_story_ids_canonical,
          contribution_ids_canonical, update_canonical, source_event_id
        ) VALUES (
          @runId, @id, @topic, @tick, @previousTick, @previousValue, @decayedValue,
          @storyDelta, @value, @contributingStoryIdsCanonical,
          @contributionIdsCanonical, @updateCanonical, @sourceEventId
        )
      `).run({
        runId: update.runId,
        id: update.id,
        topic: update.topic,
        tick: update.tick,
        previousTick: update.previousTick,
        previousValue: update.previousValue,
        decayedValue: update.decayedValue,
        storyDelta: update.storyDelta,
        value: update.value,
        contributingStoryIdsCanonical: canonicalStringify(update.contributingStoryIds),
        contributionIdsCanonical: canonicalStringify(update.contributionIds),
        updateCanonical: canonicalStringify(update),
        sourceEventId: update.sourceEventId,
      });
      const insertContribution = this.db.prepare(`
        INSERT INTO sentiment_story_contributions(
          run_id, id, update_id, story_id, story_topic, topic, tick, stance, reach,
          outcome_score, stance_delta, outcome_delta, delta, cited_event_ids_canonical,
          contribution_canonical, source_event_id
        ) VALUES (
          @runId, @id, @updateId, @storyId, @storyTopic, @topic, @tick, @stance, @reach,
          @outcomeScore, @stanceDelta, @outcomeDelta, @delta, @citedEventIdsCanonical,
          @contributionCanonical, @sourceEventId
        )
      `);
      for (const contribution of contributions) {
        insertContribution.run({
          ...contribution,
          citedEventIdsCanonical: canonicalStringify(contribution.citedEventIds),
          contributionCanonical: canonicalStringify(contribution),
        });
      }
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
    return update;
  }

  getOpinionUpdate(id: string): AgentOpinionUpdate | null {
    const row = this.db.prepare<[string, string], CanonicalRow>(`
      SELECT update_canonical AS canonical
      FROM agent_opinion_updates WHERE run_id = ? AND id = ?
    `).get(this.runId, id);
    return row === undefined ? null : opinionFromRow(row);
  }

  getCurrentOpinion(
    agentId: string,
    axis: OpinionAxis,
    throughTick?: number,
  ): CurrentOpinion {
    if (!OPINION_AXES.includes(axis)) {
      throw new EngineError("VALIDATION_FAILED", `unknown opinion axis ${axis}`);
    }
    const row = throughTick === undefined
      ? this.db.prepare<[string, string, string], CanonicalRow>(`
          SELECT update_canonical AS canonical FROM agent_opinion_updates
          WHERE run_id = ? AND agent_id = ? AND axis = ?
          ORDER BY tick DESC, id DESC LIMIT 1
        `).get(this.runId, agentId, axis)
      : this.db.prepare<[string, string, string, number], CanonicalRow>(`
          SELECT update_canonical AS canonical FROM agent_opinion_updates
          WHERE run_id = ? AND agent_id = ? AND axis = ? AND tick <= ?
          ORDER BY tick DESC, id DESC LIMIT 1
        `).get(this.runId, agentId, axis, throughTick);
    if (row !== undefined) {
      const update = opinionFromRow(row);
      return Object.freeze({ value: update.value, update });
    }
    const seed = this.db.prepare<[string, string], OpinionSeedRow>(`
      SELECT p.opinions_canonical
      FROM agents a JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? AND a.id = ?
    `).get(this.runId, agentId);
    if (seed === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
    const opinions = parseCanonicalRecord(seed.opinions_canonical, "seed opinions", (value) =>
      opinionAxesSchema.parse(value));
    return Object.freeze({ value: opinions[axis], update: null });
  }

  listOpinionSubjects(throughTick?: number): readonly OpinionSubject[] {
    const rows = this.db.prepare<[string], OpinionSubjectRow>(`
      SELECT a.id AS agent_id, p.opinions_canonical
      FROM agents a JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? ORDER BY a.id
    `).all(this.runId);
    const latest = this.db.prepare<
      { runId: string; throughTick: number },
      LatestOpinionRow
    >(`
      SELECT agent_id, axis, canonical FROM (
        SELECT agent_id, axis, update_canonical AS canonical,
          ROW_NUMBER() OVER (
            PARTITION BY agent_id, axis ORDER BY tick DESC, id DESC
          ) AS opinion_rank
        FROM agent_opinion_updates
        WHERE run_id = @runId AND tick <= @throughTick
      ) WHERE opinion_rank = 1
      ORDER BY agent_id, axis
    `).all({
      runId: this.runId,
      throughTick: throughTick ?? Number.MAX_SAFE_INTEGER,
    });
    const latestByAgentAxis = new Map(latest.map((row) => [
      row.agent_id + ":" + row.axis,
      opinionFromRow(row),
    ]));
    return Object.freeze(rows.map((row) => {
      const seed = parseCanonicalRecord(row.opinions_canonical, "seed opinions", (value) =>
        opinionAxesSchema.parse(value));
      const opinions = { ...seed };
      for (const axis of OPINION_AXES) {
        opinions[axis] = latestByAgentAxis.get(row.agent_id + ":" + axis)?.value ?? seed[axis];
      }
      return Object.freeze({ agentId: row.agent_id, opinions: opinionAxesSchema.parse(opinions) });
    }));
  }

  listOpinionUpdates(input: {
    readonly agentId?: string;
    readonly axis?: OpinionAxis;
    readonly tick?: number;
  } = {}): readonly AgentOpinionUpdate[] {
    const conditions = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId };
    if (input.agentId !== undefined) {
      conditions.push("agent_id = @agentId");
      params["agentId"] = input.agentId;
    }
    if (input.axis !== undefined) {
      conditions.push("axis = @axis");
      params["axis"] = input.axis;
    }
    if (input.tick !== undefined) {
      conditions.push("tick = @tick");
      params["tick"] = input.tick;
    }
    return Object.freeze(this.db.prepare<Record<string, string | number>, CanonicalRow>(`
      SELECT update_canonical AS canonical FROM agent_opinion_updates
      WHERE ${conditions.join(" AND ")} ORDER BY tick, agent_id, axis, id
    `).all(params).map(opinionFromRow));
  }

  recordOpinionUpdate(rawUpdate: AgentOpinionUpdate): AgentOpinionUpdate {
    return this.recordOpinionUpdates([rawUpdate])[0]!;
  }

  recordOpinionUpdates(rawUpdates: readonly AgentOpinionUpdate[]): readonly AgentOpinionUpdate[] {
    if (rawUpdates.length === 0) return Object.freeze([]);
    const updates = rawUpdates.map((value) => agentOpinionUpdateSchema.parse(value));
    if (updates.some((update) => update.runId !== this.runId)) {
      throw new EngineError("CONFLICT", "opinion update belongs to another run");
    }
    const ticks = new Set(updates.map((update) => update.tick));
    const keys = updates.map((update) => update.agentId + ":" + update.axis);
    if (ticks.size !== 1 || new Set(keys).size !== keys.length) {
      throw new EngineError("CONFLICT", "opinion batch must contain one unique axis update per tick");
    }
    const tick = updates[0]!.tick;
    const existingRows = this.db.prepare<[string, number], CanonicalRow>(`
      SELECT update_canonical AS canonical FROM agent_opinion_updates
      WHERE run_id = ? AND tick = ? ORDER BY agent_id, axis, id
    `).all(this.runId, tick).map(opinionFromRow);
    const existingByKey = new Map(existingRows.map((update) => [
      update.agentId + ":" + update.axis,
      update,
    ]));
    const existingCount = keys.filter((key) => existingByKey.has(key)).length;
    if (existingCount > 0) {
      if (existingCount !== updates.length || updates.some((update) =>
        !sameCanonical(existingByKey.get(update.agentId + ":" + update.axis), update)
      )) {
        throw new EngineError("CONFLICT", "agent opinion axis tick was already recorded");
      }
      return Object.freeze(updates);
    }

    const subjects = new Map(this.listOpinionSubjects(tick - 1).map((subject) => [
      subject.agentId,
      subject,
    ]));
    const contributionById = new Map(
      this.listContributions({ tick }).map((contribution) => [contribution.id, contribution]),
    );
    const contributionsByUpdate = new Map<string, readonly SentimentStoryContribution[]>();
    for (const update of updates) {
      const subject = subjects.get(update.agentId);
      if (subject === undefined) {
        throw new EngineError("NOT_FOUND", `agent ${update.agentId} does not exist`);
      }
      if (subject.opinions[update.axis] !== update.previousValue) {
        throw new EngineError("CONFLICT", "opinion update previous value is stale");
      }
      const contributions = update.causeContributionIds.map((id) => {
        const contribution = contributionById.get(id);
        if (contribution === undefined) {
          throw new EngineError("NOT_FOUND", `sentiment contribution ${id} does not exist`);
        }
        return contribution;
      });
      const storyIds = [...new Set(contributions.map((value) => value.storyId))]
        .sort(compareCodeUnit);
      const sentimentUpdateIds = [...new Set(contributions.map((value) => value.updateId))]
        .sort(compareCodeUnit);
      if (
        !sameCanonical(storyIds, [...update.causeStoryIds].sort(compareCodeUnit)) ||
        !sameCanonical(
          sentimentUpdateIds,
          [...update.sourceSentimentUpdateIds].sort(compareCodeUnit),
        )
      ) {
        throw new EngineError("VALIDATION_FAILED", "opinion cause attribution is incomplete");
      }
      contributionsByUpdate.set(update.id, contributions);
    }

    const insertUpdate = this.db.prepare(`
        INSERT INTO agent_opinion_updates(
          run_id, id, agent_id, axis, tick, previous_value, delta, value,
          cause_story_ids_canonical, cause_contribution_ids_canonical,
          source_sentiment_update_ids_canonical, update_canonical, source_event_id
        ) VALUES (
          @runId, @id, @agentId, @axis, @tick, @previousValue, @delta, @value,
          @causeStoryIdsCanonical, @causeContributionIdsCanonical,
          @sourceSentimentUpdateIdsCanonical, @updateCanonical, @sourceEventId
        )
      `);
    const insertCause = this.db.prepare(`
        INSERT INTO agent_opinion_causes(
          run_id, opinion_update_id, story_id, contribution_id, sentiment_update_id
        ) VALUES (@runId, @opinionUpdateId, @storyId, @contributionId, @sentimentUpdateId)
      `);
    const persist = (): void => {
      for (const update of updates) {
        insertUpdate.run({
          ...update,
          causeStoryIdsCanonical: canonicalStringify(update.causeStoryIds),
          causeContributionIdsCanonical: canonicalStringify(update.causeContributionIds),
          sourceSentimentUpdateIdsCanonical: canonicalStringify(update.sourceSentimentUpdateIds),
          updateCanonical: canonicalStringify(update),
        });
        for (const contribution of contributionsByUpdate.get(update.id)!) {
          insertCause.run({
            runId: this.runId,
            opinionUpdateId: update.id,
            storyId: contribution.storyId,
            contributionId: contribution.id,
            sentimentUpdateId: contribution.updateId,
          });
        }
      }
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
    return Object.freeze(updates);
  }
}
