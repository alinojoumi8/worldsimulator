/** WS-702 immutable news organizations, digests, stories, and citations. */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  newsDigestRecordSchema,
  newsOrganizationSchema,
  newsStorySchema,
  type NewsDigestRecord,
  type NewsOrganization,
  type NewsStory,
} from "@worldtangle/shared";
import { newsStoryFactFromEvent } from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";

interface CanonicalRow {
  canonical: string;
}

interface CountRow {
  count: bigint;
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

function organizationFromRow(row: CanonicalRow): NewsOrganization {
  return parseCanonicalRecord(row.canonical, "news organization", (value) =>
    newsOrganizationSchema.parse(value));
}

function digestFromRow(row: CanonicalRow): NewsDigestRecord {
  return parseCanonicalRecord(row.canonical, "news digest", (value) =>
    newsDigestRecordSchema.parse(value));
}

function storyFromRow(row: CanonicalRow): NewsStory {
  return parseCanonicalRecord(row.canonical, "news story", (value) =>
    newsStorySchema.parse(value));
}

export class SqliteNewsStore {
  private readonly events: SqliteEventStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    this.events = new SqliteEventStore(db, runId);
  }

  getOrganization(id: string): NewsOrganization | null {
    const row = this.db.prepare<[string, string], CanonicalRow>(`
      SELECT organization_canonical AS canonical
      FROM news_organizations WHERE run_id = ? AND id = ?
    `).get(this.runId, id);
    return row === undefined ? null : organizationFromRow(row);
  }

  ensureOrganization(input: NewsOrganization): NewsOrganization {
    const organization = newsOrganizationSchema.parse(input);
    if (organization.runId !== this.runId) {
      throw new EngineError("CONFLICT", "news organization belongs to another run");
    }
    const existing = this.getOrganization(organization.id);
    if (existing !== null) {
      if (canonicalStringify(existing) !== canonicalStringify(organization)) {
        throw new EngineError("CONFLICT", "news organization identity changed");
      }
      return existing;
    }
    const editor = this.db.prepare<[string, string], { role_code: string; organization_id: string | null }>(`
      SELECT role_code, organization_id FROM agents WHERE run_id = ? AND id = ?
    `).get(this.runId, organization.editorAgentId);
    if (editor?.role_code !== "news.editor" || editor.organization_id !== "inst_riverbend_ledger") {
      throw new EngineError("PERMISSION_DENIED", "news organization editor role is invalid");
    }
    for (const journalistId of organization.journalistAgentIds) {
      const journalist = this.db.prepare<[string, string], { role_code: string; organization_id: string | null }>(`
        SELECT role_code, organization_id FROM agents WHERE run_id = ? AND id = ?
      `).get(this.runId, journalistId);
      if (
        journalist?.role_code !== "news.journalist" ||
        journalist.organization_id !== "inst_riverbend_ledger"
      ) {
        throw new EngineError("PERMISSION_DENIED", `agent ${journalistId} is not a staff journalist`);
      }
    }
    this.db.prepare(`
      INSERT INTO news_organizations(
        run_id, id, name, editor_agent_id, journalist_agent_ids_canonical,
        daily_story_cap, stance_bias, created_tick, organization_canonical, source_event_id
      ) VALUES (
        @runId, @id, @name, @editorAgentId, @journalistAgentIdsCanonical,
        @dailyStoryCap, @stanceBias, @createdTick, @organizationCanonical, @sourceEventId
      )
    `).run({
      runId: organization.runId,
      id: organization.id,
      name: organization.name,
      editorAgentId: organization.editorAgentId,
      journalistAgentIdsCanonical: canonicalStringify(organization.journalistAgentIds),
      dailyStoryCap: organization.dailyStoryCap,
      stanceBias: organization.stanceBias,
      createdTick: organization.createdTick,
      organizationCanonical: canonicalStringify(organization),
      sourceEventId: organization.sourceEventId,
    });
    return organization;
  }

  getDigestForSourceTick(sourceTick: number): NewsDigestRecord | null {
    const row = this.db.prepare<[string, number], CanonicalRow>(`
      SELECT digest_canonical AS canonical
      FROM news_digests WHERE run_id = ? AND source_tick = ?
    `).get(this.runId, sourceTick);
    return row === undefined ? null : digestFromRow(row);
  }

  insertDigest(input: NewsDigestRecord): NewsDigestRecord {
    const digest = newsDigestRecordSchema.parse(input);
    if (digest.runId !== this.runId) {
      throw new EngineError("CONFLICT", "news digest belongs to another run");
    }
    const existing = this.getDigestForSourceTick(digest.sourceTick);
    if (existing !== null) {
      if (canonicalStringify(existing) !== canonicalStringify(digest)) {
        throw new EngineError("CONFLICT", "news digest source tick was already recorded");
      }
      return existing;
    }
    const sourceEvents = new Set(
      this.events.list({ tick: digest.sourceTick }).map((event) => event.eventId),
    );
    if (digest.selectedEventIds.some((eventId) => !sourceEvents.has(eventId))) {
      throw new EngineError("VALIDATION_FAILED", "news digest selected an absent source event");
    }
    this.db.prepare(`
      INSERT INTO news_digests(
        run_id, id, source_tick, publication_tick, scoring_version, digest_hash,
        total_candidate_count, selected_event_ids_canonical, digest_canonical, source_event_id
      ) VALUES (
        @runId, @id, @sourceTick, @publicationTick, @scoringVersion, @digestHash,
        @totalCandidateCount, @selectedEventIdsCanonical, @digestCanonical, @sourceEventId
      )
    `).run({
      runId: digest.runId,
      id: digest.id,
      sourceTick: digest.sourceTick,
      publicationTick: digest.publicationTick,
      scoringVersion: digest.scoringVersion,
      digestHash: digest.digestHash,
      totalCandidateCount: digest.totalCandidateCount,
      selectedEventIdsCanonical: canonicalStringify(digest.selectedEventIds),
      digestCanonical: canonicalStringify(digest),
      sourceEventId: digest.sourceEventId,
    });
    return digest;
  }

  getStory(id: string): NewsStory | null {
    const row = this.db.prepare<[string, string], CanonicalRow>(`
      SELECT story_canonical AS canonical FROM news_stories WHERE run_id = ? AND id = ?
    `).get(this.runId, id);
    return row === undefined ? null : storyFromRow(row);
  }

  listStories(input: {
    readonly tick?: number;
    readonly status?: NewsStory["status"];
  } = {}): readonly NewsStory[] {
    const conditions = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId };
    if (input.tick !== undefined) {
      conditions.push("tick = @tick");
      params["tick"] = input.tick;
    }
    if (input.status !== undefined) {
      conditions.push("status = @status");
      params["status"] = input.status;
    }
    return Object.freeze(this.db.prepare<Record<string, string | number>, CanonicalRow>(`
      SELECT story_canonical AS canonical FROM news_stories
      WHERE ${conditions.join(" AND ")} ORDER BY tick, id
    `).all(params).map(storyFromRow));
  }

  insertStory(input: NewsStory): NewsStory {
    const story = newsStorySchema.parse(input);
    if (story.runId !== this.runId) {
      throw new EngineError("CONFLICT", "news story belongs to another run");
    }
    const organization = this.getOrganization(story.orgId);
    if (organization === null) {
      throw new EngineError("NOT_FOUND", `news organization ${story.orgId} does not exist`);
    }
    if (!organization.journalistAgentIds.includes(story.authorAgentId)) {
      throw new EngineError("PERMISSION_DENIED", "story author is not assigned to the organization");
    }
    if (story.status === "published") {
      const published = this.db.prepare<[string, string, number], CountRow>(`
        SELECT COUNT(*) AS count FROM news_stories
        WHERE run_id = ? AND org_id = ? AND tick = ? AND status = 'published'
      `).get(this.runId, story.orgId, story.tick)!.count;
      if (published >= BigInt(organization.dailyStoryCap)) {
        throw new EngineError("LIMIT_EXCEEDED", "news organization daily story cap reached");
      }
    }
    const sourceEvents = new Map(
      this.events.list({ tick: story.sourceTick }).map((event) => [event.eventId, event]),
    );
    for (const fact of story.facts) {
      const source = sourceEvents.get(fact.eventId);
      if (source === undefined) {
        throw new EngineError("VALIDATION_FAILED", `cited event ${fact.eventId} does not exist`);
      }
      const expected = newsStoryFactFromEvent(source);
      if (canonicalStringify(expected) !== canonicalStringify(fact)) {
        throw new EngineError("VALIDATION_FAILED", `cited facts for ${fact.eventId} were altered`);
      }
    }
    const persist = (): void => {
      this.db.prepare(`
        INSERT INTO news_stories(
          run_id, id, org_id, author_agent_id, tick, source_tick, topic, status,
          decision_id, llm_call_id, story_canonical, source_event_id
        ) VALUES (
          @runId, @id, @orgId, @authorAgentId, @tick, @sourceTick, @topic, @status,
          @decisionId, @llmCallId, @storyCanonical, @sourceEventId
        )
      `).run({
        runId: story.runId,
        id: story.id,
        orgId: story.orgId,
        authorAgentId: story.authorAgentId,
        tick: story.tick,
        sourceTick: story.sourceTick,
        topic: story.topic,
        status: story.status,
        decisionId: story.decisionId,
        llmCallId: story.llmCallId ?? null,
        storyCanonical: canonicalStringify(story),
        sourceEventId: story.sourceEventId,
      });
      const insertCitation = this.db.prepare(`
        INSERT INTO news_story_citations(
          run_id, story_id, org_id, source_tick, event_id, event_fact_hash
        ) VALUES (@runId, @storyId, @orgId, @sourceTick, @eventId, @eventFactHash)
      `);
      for (const fact of story.facts) {
        insertCitation.run({
          runId: story.runId,
          storyId: story.id,
          orgId: story.orgId,
          sourceTick: story.sourceTick,
          eventId: fact.eventId,
          eventFactHash: fact.eventFactHash,
        });
      }
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
    return story;
  }
}
