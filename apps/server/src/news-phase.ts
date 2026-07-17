/** WS-702 deterministic journalist selection, story publication, and spiking. */

import {
  agentActionSchema,
  canonicalStringify,
  decisionSchema,
  EngineError,
  hashValue,
  newsDigestRecordSchema,
  newsOrganizationSchema,
  newsStorySchema,
  type AgentAction,
  type Decision,
  type EventEnvelope,
  type LlmMode,
  type NewsOrganization,
  type NewsStorySpikeReason,
} from "@worldtangle/shared";
import {
  buildAgentDecisionPrompt,
  buildNewsStoryMenu,
  buildNewsworthinessDigest,
  llmRequestHash,
  NEWS_OPERATIONAL_EVENT_PREFIXES,
  NEWS_STORY_PROMPT_PACK_KEY,
  newsLogicalProjection,
  newsStoryReach,
  newsTopicForEvent,
  resolveNewsStorySelection,
  simDateForTick,
  templateNewsStorySelection,
  type BuiltAgentDecisionPrompt,
  type LlmProviderRoute,
  type LlmResult,
  type NewsStoryMenuOption,
  type NewsworthinessDigest,
  type PhaseHandler,
  type RoutedLlmProvider,
  type TickContext,
} from "@worldtangle/engine";
import {
  buildLlmCallRecordEvidence,
  buildLlmCallTelemetryEvidence,
} from "./llm-call-evidence";
import {
  SqliteAgentStore,
  SqliteEventStore,
  SqliteLlmCallStore,
  SqliteNewsStore,
  type WorldDatabase,
} from "./persistence";

export const RIVERBEND_NEWS_ORGANIZATION_ID = "norg_riverbend_ledger";
export const NEWS_STORY_PUBLICATION_INTERVAL_TICKS = 30;
const RIVERBEND_NEWS_INSTITUTION_ID = "inst_riverbend_ledger";

interface NewsStaffRow {
  readonly id: string;
  readonly role_code: string;
}

interface NewsTypeOccurrenceRow {
  readonly type: string;
  readonly occurrences: bigint;
}

export interface NewsStoryOpportunity {
  readonly key: string;
  readonly event: EventEnvelope;
  readonly candidate: NewsworthinessDigest["candidates"][number];
  readonly authorAgentId: string;
  readonly menu: readonly NewsStoryMenuOption[];
}

export interface NewsStoryWork {
  readonly tick: number;
  readonly sourceTick: number;
  readonly organization: NewsOrganization;
  readonly digest: NewsworthinessDigest;
  readonly opportunities: readonly NewsStoryOpportunity[];
}

export interface PreparedNewsStoryEntry {
  readonly opportunity: NewsStoryOpportunity;
  readonly prompt: BuiltAgentDecisionPrompt;
  readonly route: LlmProviderRoute;
  readonly result: LlmResult;
  readonly requestHashMismatch: boolean;
}

export interface PreparedNewsStoryBatch extends NewsStoryWork {
  readonly entries: readonly PreparedNewsStoryEntry[];
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logicalDigestCandidate(
  candidate: NewsworthinessDigest["candidates"][number],
): Omit<NewsworthinessDigest["candidates"][number], "correlationId"> {
  const logical = { ...candidate } as { correlationId?: string } & Record<string, unknown>;
  delete logical.correlationId;
  return logical as Omit<NewsworthinessDigest["candidates"][number], "correlationId">;
}

export function isNewsStoryPublicationSourceTick(sourceTick: number): boolean {
  if (!Number.isSafeInteger(sourceTick) || sourceTick < 0) {
    throw new EngineError("VALIDATION_FAILED", "news source tick must be nonnegative");
  }
  return sourceTick % NEWS_STORY_PUBLICATION_INTERVAL_TICKS === 0;
}

function discoverOrganization(
  db: WorldDatabase,
  runId: string,
  tick: number,
  events: SqliteEventStore,
  news: SqliteNewsStore,
): NewsOrganization {
  const existing = news.getOrganization(RIVERBEND_NEWS_ORGANIZATION_ID);
  if (existing !== null) return existing;
  const staff = db.prepare<[string, string], NewsStaffRow>(`
    SELECT id, role_code FROM agents
    WHERE run_id = ? AND organization_id = ?
      AND role_code IN ('news.editor', 'news.journalist')
      AND employment_status = 'employed'
    ORDER BY role_code, id
  `).all(runId, RIVERBEND_NEWS_INSTITUTION_ID);
  const editors = staff.filter((row) => row.role_code === "news.editor");
  const journalists = staff
    .filter((row) => row.role_code === "news.journalist")
    .map((row) => row.id)
    .sort(compareCodeUnit);
  if (editors.length !== 1 || journalists.length < 1 || journalists.length > 3) {
    throw new EngineError("CONFLICT", "Riverbend Ledger staffing is invalid");
  }
  const evidenceEvent = events.list({ toTick: Math.max(0, tick - 1) })[0];
  if (evidenceEvent === undefined) {
    throw new EngineError("NOT_FOUND", "news organization requires committed world evidence");
  }
  return newsOrganizationSchema.parse({
    id: RIVERBEND_NEWS_ORGANIZATION_ID,
    runId,
    name: "The Riverbend Ledger",
    editorAgentId: editors[0]!.id,
    journalistAgentIds: journalists,
    dailyStoryCap: 3,
    stanceBias: 0,
    createdTick: tick,
    sourceEventId: evidenceEvent.eventId,
  });
}

export function discoverNewsStoryOpportunities(
  db: WorldDatabase,
  runId: string,
  tick: number,
): NewsStoryWork {
  if (!Number.isSafeInteger(tick) || tick < 1) {
    throw new EngineError("VALIDATION_FAILED", "news publication tick must be positive");
  }
  const sourceTick = tick - 1;
  const events = new SqliteEventStore(db, runId);
  const news = new SqliteNewsStore(db, runId);
  const organization = discoverOrganization(db, runId, tick, events, news);
  const lookbackStart = Math.max(0, sourceTick - 29);
  const sourceEvents = events.list({
    tick: sourceTick,
    excludeTypePrefixes: NEWS_OPERATIONAL_EVENT_PREFIXES,
  });
  const simulationId = sourceEvents[0]?.simulationId;
  if (simulationId === undefined) {
    throw new EngineError("NOT_FOUND", `news digest source tick ${sourceTick} has no events`);
  }
  const windowTypeOccurrences = db.prepare<
    [string, number, number],
    NewsTypeOccurrenceRow
  >(`
    SELECT type, COUNT(*) AS occurrences
    FROM events
    WHERE run_id = ? AND tick >= ? AND tick <= ?
    GROUP BY type ORDER BY type
  `).all(runId, lookbackStart, sourceTick).map((row) => {
    const count = Number(row.occurrences);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new EngineError("INTERNAL", `invalid news occurrence count for ${row.type}`);
    }
    return Object.freeze({ eventType: row.type, count });
  });
  const digest = buildNewsworthinessDigest({
    simulationId,
    runId,
    tick: sourceTick,
    events: sourceEvents,
    windowTypeOccurrences,
  });
  const byId = new Map(sourceEvents.map((event) => [event.eventId, event]));
  const selectedTopics = new Set<string>();
  const selected: Array<Readonly<{
    event: EventEnvelope;
    candidate: NewsworthinessDigest["candidates"][number];
  }>> = [];
  if (isNewsStoryPublicationSourceTick(sourceTick)) {
    for (const candidate of digest.candidates) {
      if (candidate.eventType.startsWith("news.")) continue;
      const event = byId.get(candidate.eventId);
      if (event === undefined) {
        throw new EngineError("INTERNAL", `digest candidate ${candidate.eventId} is absent`);
      }
      const topic = newsTopicForEvent(event.type);
      if (selectedTopics.has(topic)) continue;
      selectedTopics.add(topic);
      selected.push(Object.freeze({ event, candidate }));
      if (selected.length >= organization.dailyStoryCap) break;
    }
  }
  const opportunities = selected.map((selection, index): NewsStoryOpportunity => {
    const authorAgentId = organization.journalistAgentIds[
      (sourceTick + index) % organization.journalistAgentIds.length
    ]!;
    const menu = buildNewsStoryMenu({
      organization,
      candidate: selection.candidate,
      event: selection.event,
    });
    return Object.freeze({
      key: `news:${sourceTick}:${selection.candidate.eventId}:${authorAgentId}`,
      event: selection.event,
      candidate: selection.candidate,
      authorAgentId,
      menu,
    });
  });
  return Object.freeze({
    tick,
    sourceTick,
    organization,
    digest,
    opportunities: Object.freeze(opportunities),
  });
}

function providerFailure(
  requestHash: string,
  route: LlmProviderRoute,
  error: unknown,
): LlmResult {
  return {
    ok: false,
    reason: "provider_error",
    requestHash,
    detail: error instanceof Error ? error.message : "LLM provider threw",
    providerError: {
      provider: route.provider,
      code: "unknown",
      retryable: false,
    },
    attempts: 0,
    requestedTier: 2,
    effectiveTier: 1,
  };
}

export async function prepareNewsStoryBatch(input: {
  readonly db: WorldDatabase;
  readonly runId: string;
  readonly tick: number;
  readonly provider: RoutedLlmProvider;
  readonly promptPackVersion: number;
  readonly work?: NewsStoryWork;
}): Promise<PreparedNewsStoryBatch> {
  const work = input.work ?? discoverNewsStoryOpportunities(input.db, input.runId, input.tick);
  if (work.tick !== input.tick) {
    throw new EngineError("CONFLICT", "news work belongs to another tick");
  }
  const agents = new SqliteAgentStore(input.db, input.runId);
  const entries: PreparedNewsStoryEntry[] = [];
  // Sequential calls preserve canonical budget and cache event ordering.
  for (const opportunity of work.opportunities) {
    const persona = agents.getProfile(opportunity.authorAgentId, 0).persona;
    const options = opportunity.menu.map((entry) => entry.option);
    const sourcePayload = canonicalStringify(newsLogicalProjection(opportunity.event.payload));
    const prompt = buildAgentDecisionPrompt({
      persona,
      tick: input.tick,
      simDate: simDateForTick(input.tick),
      trigger: {
        kind: "news",
        agentId: opportunity.authorAgentId,
        sourceEventId: opportunity.event.eventId,
        tick: input.tick,
        priority: Math.min(100, Math.floor(opportunity.candidate.totalPoints / 100)),
        payload: {
          storyId: `candidate:${opportunity.event.eventId}`,
          relevanceScore: Math.min(100, Math.floor(opportunity.candidate.totalPoints / 100)),
        },
      },
      trustedState: {
        organization: {
          id: work.organization.id,
          name: work.organization.name,
          stanceBias: work.organization.stanceBias,
        },
        digestCandidate: logicalDigestCandidate(opportunity.candidate),
        sourceEvent: {
          eventId: opportunity.event.eventId,
          type: opportunity.event.type,
          tick: opportunity.event.tick,
          simDate: opportunity.event.simDate,
          actor: opportunity.event.actor,
          eventFactHash: opportunity.candidate.eventFactHash,
        },
        draftChoices: opportunity.menu.map((entry) => ({
          actionId: entry.option.actionId,
          params: entry.option.params,
          headline: entry.draft.headline,
          body: entry.draft.body,
          topic: entry.draft.topic,
          stance: entry.draft.stance,
        })),
      },
      untrustedItems: [{
        source: "news",
        id: opportunity.event.eventId,
        content: sourcePayload.length <= 4_000
          ? sourcePayload
          : sourcePayload.slice(0, 3_980) + "...[truncated]",
        references: [opportunity.event.eventId],
      }],
      options,
      purpose: "news.story.select",
      correlationId: opportunity.key,
      budgetTag: "news",
      promptPackKey: NEWS_STORY_PROMPT_PACK_KEY,
      promptPackVersion: input.promptPackVersion,
    });
    let route: LlmProviderRoute;
    try {
      route = input.provider.route(prompt.request);
    } catch {
      route = { provider: "unavailable", model: "unavailable" };
    }
    const expectedRequestHash = llmRequestHash(prompt.request);
    let result: LlmResult;
    try {
      result = await input.provider.propose(prompt.request);
    } catch (error) {
      result = providerFailure(expectedRequestHash, route, error);
    }
    const requestHashMismatch = result.requestHash !== expectedRequestHash;
    if (requestHashMismatch) {
      result = {
        ok: false,
        reason: "provider_error",
        requestHash: expectedRequestHash,
        detail: "LLM provider returned a mismatched canonical request hash",
        providerError: { provider: route.provider, code: "conflict", retryable: false },
        attempts: result.attempts ?? (result.ok && !result.cached ? 1 : 0),
        requestedTier: 2,
        effectiveTier: 1,
      };
    }
    entries.push(Object.freeze({
      opportunity,
      prompt,
      route,
      result,
      requestHashMismatch,
    }));
  }
  return Object.freeze({
    ...work,
    entries: Object.freeze(entries),
  });
}

function ensureOrganization(
  store: SqliteNewsStore,
  organization: NewsOrganization,
  ctx: TickContext,
): NewsOrganization {
  const existing = store.getOrganization(organization.id);
  if (existing !== null) return existing;
  const seeded = ctx.emit("news.organization.seeded", {
    schemaVersion: 1,
    organizationId: organization.id,
    name: organization.name,
    editorAgentId: organization.editorAgentId,
    journalistAgentIds: organization.journalistAgentIds,
    dailyStoryCap: organization.dailyStoryCap,
    stanceBias: organization.stanceBias,
  }, {
    actor: { kind: "institution", id: RIVERBEND_NEWS_INSTITUTION_ID },
    correlationId: organization.id,
    causationId: organization.sourceEventId,
  });
  return store.ensureOrganization({
    ...organization,
    createdTick: ctx.tick,
    sourceEventId: seeded.eventId,
  });
}

function providerAttempts(result: LlmResult): number {
  if (result.ok && result.cached) return 0;
  return result.attempts ?? (result.ok ? 1 : 0);
}

function spikeReason(
  entry: PreparedNewsStoryEntry,
  resolved: ReturnType<typeof resolveNewsStorySelection>,
): NewsStorySpikeReason {
  if (entry.requestHashMismatch) return "request_hash_mismatch";
  if (!entry.result.ok) {
    return entry.result.reason === "schema_invalid" ? "schema_invalid" : "provider_error";
  }
  return resolved.reason === "schema_invalid" ? "schema_invalid" : "menu_mismatch";
}

function persistDigest(
  store: SqliteNewsStore,
  work: NewsStoryWork,
  ctx: TickContext,
): void {
  const digestId = ctx.ids.next("ndg");
  const selectedEventIds = work.opportunities.map((item) => item.event.eventId);
  const digestEvent = ctx.emit("news.digest.created", {
    schemaVersion: 1,
    digestId,
    sourceTick: work.sourceTick,
    scoringVersion: work.digest.scoringVersion,
    digestHash: work.digest.digestHash,
    totalCandidateCount: work.digest.totalCandidateCount,
    selectedEventIds,
  }, {
    actor: { kind: "institution", id: RIVERBEND_NEWS_INSTITUTION_ID },
    correlationId: digestId,
    ...(selectedEventIds[0] === undefined ? {} : { causationId: selectedEventIds[0] }),
  });
  store.insertDigest(newsDigestRecordSchema.parse({
    id: digestId,
    runId: ctx.runId,
    sourceTick: work.sourceTick,
    publicationTick: ctx.tick,
    scoringVersion: work.digest.scoringVersion,
    digestHash: work.digest.digestHash,
    totalCandidateCount: work.digest.totalCandidateCount,
    selectedEventIds,
    sourceEventId: digestEvent.eventId,
  }));
}

function applyWork(
  db: WorldDatabase,
  runId: string,
  mode: LlmMode,
  work: NewsStoryWork,
  preparedEntries: readonly PreparedNewsStoryEntry[],
  ctx: TickContext,
): void {
  if (work.tick !== ctx.tick || work.sourceTick !== ctx.tick - 1) {
    throw new EngineError("CONFLICT", "news work belongs to another tick");
  }
  const news = new SqliteNewsStore(db, runId);
  const agents = new SqliteAgentStore(db, runId);
  const calls = new SqliteLlmCallStore(db, runId);
  ensureOrganization(news, work.organization, ctx);
  persistDigest(news, work, ctx);
  const preparedByKey = new Map(
    preparedEntries.map((entry) => [entry.opportunity.key, entry]),
  );
  if (preparedByKey.size !== preparedEntries.length) {
    throw new EngineError("CONFLICT", "prepared news entries are duplicated");
  }

  for (const opportunity of work.opportunities) {
    const options = opportunity.menu.map((entry) => entry.option);
    const fallbackProposal = templateNewsStorySelection(options);
    const prepared = preparedByKey.get(opportunity.key);
    if (mode === "off" && prepared !== undefined) {
      throw new EngineError("CONFLICT", "LLM-off news work cannot contain provider results");
    }
    if (mode !== "off" && prepared === undefined) {
      throw new EngineError("CONFLICT", "LLM news work is missing a provider result");
    }
    const resolved = prepared === undefined
      ? resolveNewsStorySelection(fallbackProposal, options)
      : resolveNewsStorySelection(
          prepared.result.ok ? prepared.result.value : undefined,
          options,
        );
    const publish = prepared === undefined || (prepared.result.ok && resolved.ok);
    const proposal = publish ? (resolved.proposal ?? fallbackProposal) : fallbackProposal;
    const selectedMenu = opportunity.menu.find(
      (entry) => entry.option.actionId === proposal.actionId,
    );
    if (selectedMenu === undefined) {
      throw new EngineError("INTERNAL", "resolved news option has no engine draft");
    }

    const decisionId = ctx.ids.next("dec");
    const actionId = ctx.ids.next("act");
    const storyId = ctx.ids.next("nws");
    const callId = prepared === undefined ? undefined : ctx.ids.next("llm");
    const validationDetail = prepared !== undefined && prepared.result.ok && !resolved.ok
      ? resolved.detail ?? "provider story proposal was not an exact engine menu choice"
      : undefined;
    const providerDetail = prepared !== undefined && !prepared.result.ok
      ? prepared.result.detail
      : undefined;
    const tier = publish && prepared !== undefined ? 2 as const : 1 as const;
    const observationDigest = prepared?.prompt.observationDigest ?? Object.freeze({
      hash: hashValue({
        format: "worldtangle.news-template-observation.v1",
        candidate: logicalDigestCandidate(opportunity.candidate),
        options,
      }),
      summary: `Template journalist considered ${opportunity.event.eventId} at tick ${ctx.tick}.`,
    });
    const decision: Decision = decisionSchema.parse({
      id: decisionId,
      runId,
      agentId: opportunity.authorAgentId,
      tick: ctx.tick,
      trigger: {
        kind: "news",
        sourceEventId: opportunity.event.eventId,
        priority: Math.min(100, Math.floor(opportunity.candidate.totalPoints / 100)),
      },
      tier,
      observationDigest,
      optionsOffered: options,
      ...(publish ? { chosenActionId: proposal.actionId, params: proposal.params } : {}),
      rationale: publish
        ? proposal.rationale
        : validationDetail ?? providerDetail ?? "news story proposal rejected",
      ...(tier === 2 && callId !== undefined && prepared !== undefined
        ? {
            llmCallId: callId,
            promptPackKey: prepared.prompt.promptPackKey,
            promptVersion: prepared.prompt.promptPackVersion,
            promptHash: prepared.prompt.promptHash,
          }
        : {}),
      validationResult: publish
        ? { status: "approved" }
        : {
            status: "rejected",
            code: "VALIDATION_FAILED",
            message: validationDetail ?? providerDetail ?? "story proposal rejected",
          },
    });
    agents.saveDecisionResult([decision], []);

    let callEventId: string | undefined;
    if (prepared !== undefined && callId !== undefined) {
      const callEvent = ctx.emit("llm.call.recorded", {
        schemaVersion: 2,
        callId,
        decisionId,
        agentId: opportunity.authorAgentId,
        moduleId: prepared.prompt.request.moduleId,
        purpose: prepared.prompt.request.purpose,
        provider: prepared.route.provider,
        model: prepared.result.ok ? prepared.result.model : prepared.route.model,
        requestHash: prepared.result.requestHash,
        promptHash: prepared.prompt.promptHash,
        status: publish ? "success" : "fallback",
        effectiveTier: tier,
        ...(publish
          ? {}
          : {
              fallbackReason: validationDetail === undefined
                ? prepared.result.ok ? "validation_failed" : prepared.result.reason
                : "validation_failed",
            }),
        cached: prepared.result.ok ? prepared.result.cached : false,
        attempts: providerAttempts(prepared.result),
        inputTokens: prepared.result.ok ? prepared.result.inputTokens : 0,
        outputTokens: prepared.result.ok ? prepared.result.outputTokens : 0,
        ...buildLlmCallTelemetryEvidence(prepared.result),
      }, {
        actor: { kind: "agent", id: opportunity.authorAgentId },
        correlationId: decisionId,
        causationId: opportunity.event.eventId,
      });
      callEventId = callEvent.eventId;
      const callRecord = buildLlmCallRecordEvidence({
        prompt: prepared.prompt,
        result: prepared.result,
        route: prepared.route,
        agentId: opportunity.authorAgentId,
        runId,
        tick: ctx.tick,
        callId,
        decisionId,
        sourceEventId: callEvent.eventId,
        ...(validationDetail === undefined ? {} : { validationFallbackDetail: validationDetail }),
      });
      calls.insert(callRecord, buildLlmCallTelemetryEvidence(prepared.result));
      ctx.count("llmCalls", providerAttempts(prepared.result));
    }

    const decisionEvent = ctx.emit("agent.decision.recorded", {
      schemaVersion: 1,
      decisionId,
      agentId: opportunity.authorAgentId,
      tier,
      kind: "news_story",
      chosenActionId: publish ? proposal.actionId : null,
      llmCallId: tier === 2 ? callId : null,
      validationFailureCount: publish ? 0 : 1,
    }, {
      actor: { kind: "agent", id: opportunity.authorAgentId },
      correlationId: decisionId,
      causationId: callEventId ?? opportunity.event.eventId,
    });

    let action: AgentAction;
    if (publish) {
      ctx.emit("agent.action.started", {
        actionId,
        decisionId,
        type: "news.story.publish",
      }, {
        actor: { kind: "agent", id: opportunity.authorAgentId },
        correlationId: decisionId,
        causationId: decisionEvent.eventId,
      });
      const published = ctx.emit("news.story.published", {
        schemaVersion: 1,
        storyId,
        organizationId: work.organization.id,
        authorAgentId: opportunity.authorAgentId,
        topic: selectedMenu.draft.topic,
        headline: selectedMenu.draft.headline,
        citedEventIds: selectedMenu.draft.citedEventIds,
        eventFactHashes: selectedMenu.draft.facts.map((fact) => fact.eventFactHash),
        reach: newsStoryReach(opportunity.candidate.totalPoints),
        decisionId,
      }, {
        actor: { kind: "agent", id: opportunity.authorAgentId },
        correlationId: storyId,
        causationId: opportunity.event.eventId,
      });
      news.insertStory(newsStorySchema.parse({
        ...selectedMenu.draft,
        id: storyId,
        runId,
        orgId: work.organization.id,
        authorAgentId: opportunity.authorAgentId,
        tick: ctx.tick,
        sourceTick: work.sourceTick,
        reach: newsStoryReach(opportunity.candidate.totalPoints),
        status: "published",
        decisionId,
        ...(callId === undefined ? {} : { llmCallId: callId }),
        sourceEventId: published.eventId,
      }));
      const completed = ctx.emit("agent.action.completed", {
        actionId,
        decisionId,
        type: "news.story.publish",
        resultEventIds: [published.eventId],
      }, {
        actor: { kind: "agent", id: opportunity.authorAgentId },
        correlationId: decisionId,
        causationId: published.eventId,
      });
      action = agentActionSchema.parse({
        id: actionId,
        runId,
        decisionId,
        actorId: opportunity.authorAgentId,
        type: "news.story.publish",
        params: proposal.params,
        status: "applied",
        resultEventIds: [published.eventId, completed.eventId],
      });
    } else {
      const reason = spikeReason(prepared!, resolved);
      const rejected = ctx.emit("agent.action.rejected", {
        actionId,
        decisionId,
        type: "news.story.publish",
        stage: "validation",
        code: "VALIDATION_FAILED",
        message: decision.validationResult.status === "rejected"
          ? decision.validationResult.message
          : "story proposal rejected",
      }, {
        actor: { kind: "agent", id: opportunity.authorAgentId },
        correlationId: decisionId,
        causationId: decisionEvent.eventId,
      });
      const spiked = ctx.emit("news.story.spiked", {
        schemaVersion: 1,
        storyId,
        organizationId: work.organization.id,
        authorAgentId: opportunity.authorAgentId,
        topic: selectedMenu.draft.topic,
        citedEventIds: selectedMenu.draft.citedEventIds,
        reason,
        decisionId,
        llmCallId: callId,
      }, {
        actor: { kind: "institution", id: RIVERBEND_NEWS_INSTITUTION_ID },
        correlationId: storyId,
        causationId: rejected.eventId,
      });
      news.insertStory(newsStorySchema.parse({
        ...selectedMenu.draft,
        id: storyId,
        runId,
        orgId: work.organization.id,
        authorAgentId: opportunity.authorAgentId,
        tick: ctx.tick,
        sourceTick: work.sourceTick,
        reach: 0,
        status: "spiked",
        spikeReason: reason,
        decisionId,
        ...(callId === undefined ? {} : { llmCallId: callId }),
        sourceEventId: spiked.eventId,
      }));
      action = agentActionSchema.parse({
        id: actionId,
        runId,
        decisionId,
        actorId: opportunity.authorAgentId,
        type: "news.story.publish",
        params: fallbackProposal.params,
        status: "failed",
        resultEventIds: [rejected.eventId, spiked.eventId],
        error: { code: "VALIDATION_FAILED", message: "story proposal was spiked" },
      });
    }
    agents.saveDecisionResult([], [action]);
    ctx.count("decisions", 1);
  }
}

export function createNewsStoryPhaseHandler(
  db: WorldDatabase,
  runId: string,
  input: Readonly<{
    mode: LlmMode;
    batch?: PreparedNewsStoryBatch;
  }>,
): PhaseHandler {
  return {
    module: "M14-news-story-pipeline",
    order: 50,
    run(ctx) {
      const work = input.mode === "off"
        ? discoverNewsStoryOpportunities(db, runId, ctx.tick)
        : input.batch;
      if (work === undefined) {
        throw new EngineError("CONFLICT", "LLM news phase requires a prepared batch");
      }
      applyWork(
        db,
        runId,
        input.mode,
        work,
        input.mode === "off" ? [] : input.batch!.entries,
        ctx,
      );
    },
  };
}
