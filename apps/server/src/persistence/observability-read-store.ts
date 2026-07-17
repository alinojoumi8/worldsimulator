/** Read-only WS-608 LLM telemetry, error-health, and conversation projections. */

import {
  EngineError,
  type ConversationDetailResponse,
  type ConversationListQuery,
  type ConversationListResponse,
  type ErrorListQuery,
  type ErrorListResponse,
  type LlmCallListQuery,
  type LlmCallListResponse,
  type LlmCallTelemetryItem,
  type ObservabilityErrorItem,
} from "@worldtangle/shared";
import type { EventEnvelope, LlmCallRecord } from "@worldtangle/shared";
import type { ConversationCursor, ErrorCursor, LlmCallCursor } from "../cursor";
import { SqliteAgentStore } from "./agent-store";
import { SqliteConversationStore } from "./conversation-store";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteLlmCallStore, type LlmCallRecordWithTelemetry } from "./llm-call-store";
import { SqliteNegotiationStore } from "./negotiation-store";

type AgentView = Readonly<{ id: string; name: string }>;
type LlmCallBody = Readonly<{
  readonly items: readonly LlmCallTelemetryItem[];
  readonly totals: LlmCallListResponse["totals"];
  readonly next: LlmCallCursor | null;
}>;
type ErrorBody = Readonly<{
  readonly items: readonly ObservabilityErrorItem[];
  readonly summary: Readonly<{
    readonly counts: ErrorListResponse["summary"]["counts"];
    readonly perAgent: readonly ErrorListResponse["summary"]["perAgent"][number][];
    readonly activeQuarantines: readonly ErrorListResponse["summary"]["activeQuarantines"][number][];
  }>;
  readonly next: ErrorCursor | null;
}>;
type ConversationListBody = Readonly<{
  readonly items: readonly ConversationListResponse["items"][number][];
  readonly next: ConversationCursor | null;
}>;
export type ConversationDetailBody = Readonly<{
  readonly conversation: ConversationDetailResponse["conversation"];
  readonly messages: readonly ConversationDetailResponse["messages"][number][];
  readonly outcome: ConversationDetailResponse["outcome"];
  readonly binding: ConversationDetailResponse["binding"];
}>;

interface AgentNameRow {
  id: string;
  name: string;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectPayload(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function boundedString(value: unknown, fallback: string, max = 2_000): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, max)
    : fallback;
}

function centsEstimate(microcents: string): string {
  const value = BigInt(microcents);
  return ((value + 999_999n) / 1_000_000n).toString();
}

function pageAfter<T>(
  items: readonly T[],
  limit: number,
  cursor: T | undefined,
  same: (left: T, right: T) => boolean,
): { readonly items: readonly T[]; readonly hasMore: boolean } {
  let start = 0;
  if (cursor !== undefined) {
    const index = items.findIndex((item) => same(item, cursor));
    if (index < 0) {
      throw new EngineError("VALIDATION_FAILED", "pagination cursor is stale or filtered out");
    }
    start = index + 1;
  }
  const window = items.slice(start, start + limit + 1);
  return Object.freeze({ items: window.slice(0, limit), hasMore: window.length > limit });
}

export class SqliteObservabilityReadStore {
  private readonly calls: SqliteLlmCallStore;
  private readonly conversations: SqliteConversationStore;
  private readonly negotiations: SqliteNegotiationStore;
  private readonly events: SqliteEventStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.calls = new SqliteLlmCallStore(db, runId);
    this.conversations = new SqliteConversationStore(db, runId);
    this.negotiations = new SqliteNegotiationStore(db, runId);
    this.events = new SqliteEventStore(db, runId);
  }

  listLlmCalls(query: LlmCallListQuery, after?: LlmCallCursor): LlmCallBody {
    const names = this.agentNames();
    const filtered = [...this.calls.listWithTelemetry()]
      .filter(({ record }) =>
        (query.agentId === undefined || record.agentId === query.agentId) &&
        (query.moduleId === undefined || record.moduleId === query.moduleId) &&
        (query.status === undefined || record.status === query.status) &&
        (query.fromTick === undefined || record.tick >= query.fromTick) &&
        (query.toTick === undefined || record.tick <= query.toTick))
      .sort((left, right) =>
        right.record.tick - left.record.tick ||
        compareCodeUnit(right.record.id, left.record.id));
    const cursorItem = after === undefined
      ? undefined
      : filtered.find(({ record }) => record.tick === after.tick && record.id === after.callId);
    if (after !== undefined && cursorItem === undefined) {
      throw new EngineError("VALIDATION_FAILED", "pagination cursor is stale or filtered out");
    }
    const page = pageAfter(
      filtered,
      query.limit,
      cursorItem,
      (left, right) => left.record.id === right.record.id && left.record.tick === right.record.tick,
    );
    let success = 0;
    let fallback = 0;
    let cacheHits = 0;
    let providerAttempts = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let totalCost = 0n;
    for (const call of filtered) {
      if (call.record.status === "success") success += 1;
      else fallback += 1;
      if (call.record.cached) cacheHits += 1;
      providerAttempts += call.record.attempts;
      inputTokens += call.record.inputTokens;
      cachedInputTokens += call.record.cachedInputTokens;
      outputTokens += call.record.outputTokens;
      totalCost += BigInt(call.costMicrocents);
    }
    const items = page.items.map((call) => this.callItem(call, names));
    const last = page.hasMore ? page.items.at(-1) : undefined;
    return Object.freeze({
      items: Object.freeze(items),
      next: last === undefined ? null : {
        runId: this.runId,
        tick: last.record.tick,
        callId: last.record.id,
      },
      totals: Object.freeze({
        calls: filtered.length,
        success,
        fallback,
        cacheHits,
        providerAttempts,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costMicrocents: totalCost.toString(),
      }),
    });
  }

  listErrors(query: ErrorListQuery, before?: ErrorCursor): ErrorBody {
    const names = this.agentNames();
    const all = this.errorItems(names);
    const filtered = query.kind === undefined ? all : all.filter((item) => item.kind === query.kind);
    const cursorItem = before === undefined
      ? undefined
      : filtered.find((item) => item.seq === before.seq);
    if (before !== undefined && cursorItem === undefined) {
      throw new EngineError("VALIDATION_FAILED", "pagination cursor is stale or filtered out");
    }
    const page = pageAfter(filtered, query.limit, cursorItem, (left, right) => left.seq === right.seq);
    const counts = { engine: 0, intentRejected: 0, llm: 0, schema: 0 };
    const perAgent = new Map<string, number>();
    for (const item of all) {
      if (item.kind === "engine") counts.engine += 1;
      else if (item.kind === "intent_rejected") counts.intentRejected += 1;
      else if (item.kind === "llm") counts.llm += 1;
      else counts.schema += 1;
      if (item.agent !== null) {
        perAgent.set(item.agent.id, (perAgent.get(item.agent.id) ?? 0) + 1);
      }
    }
    const last = page.hasMore ? page.items.at(-1) : undefined;
    return Object.freeze({
      items: Object.freeze(page.items),
      next: last === undefined ? null : { runId: this.runId, seq: last.seq },
      summary: Object.freeze({
        counts: Object.freeze(counts),
        perAgent: Object.freeze([...perAgent.entries()]
          .map(([agentId, failures]) => ({ agent: this.requireAgent(names, agentId), failures }))
          .sort((left, right) =>
            right.failures - left.failures || compareCodeUnit(left.agent.id, right.agent.id))),
        activeQuarantines: Object.freeze(this.activeQuarantines(names)),
      }),
    });
  }

  errorCountSinceTick(fromTick: number): number {
    if (!Number.isSafeInteger(fromTick) || fromTick < 0) {
      throw new EngineError("VALIDATION_FAILED", "error window tick is invalid");
    }
    return this.errorItems(this.agentNames()).filter((item) => item.tick >= fromTick).length;
  }

  listConversations(
    query: ConversationListQuery,
    after?: ConversationCursor,
  ): ConversationListBody {
    const names = this.agentNames();
    const filtered = [...this.conversations.list()]
      .filter((conversation) =>
        (query.participant === undefined ||
          conversation.participantAgentIds.includes(query.participant)) &&
        (query.topic === undefined || conversation.topic === query.topic) &&
        (query.status === undefined || conversation.status === query.status) &&
        (query.fromTick === undefined || conversation.startTick >= query.fromTick) &&
        (query.toTick === undefined || conversation.startTick <= query.toTick))
      .sort((left, right) =>
        right.startTick - left.startTick || compareCodeUnit(right.id, left.id));
    const cursorItem = after === undefined
      ? undefined
      : filtered.find((item) =>
          item.startTick === after.startTick && item.id === after.conversationId);
    if (after !== undefined && cursorItem === undefined) {
      throw new EngineError("VALIDATION_FAILED", "pagination cursor is stale or filtered out");
    }
    const page = pageAfter(
      filtered,
      query.limit,
      cursorItem,
      (left, right) => left.id === right.id && left.startTick === right.startTick,
    );
    const items = page.items.map((conversation) => this.conversationHeader(conversation, names));
    const last = page.hasMore ? page.items.at(-1) : undefined;
    return Object.freeze({
      items: Object.freeze(items),
      next: last === undefined ? null : {
        runId: this.runId,
        startTick: last.startTick,
        conversationId: last.id,
      },
    });
  }

  getConversation(conversationId: string): ConversationDetailBody {
    const names = this.agentNames();
    const conversation = this.conversations.get(conversationId);
    const binding = this.negotiations.getForConversation(conversationId) ?? null;
    return Object.freeze({
      conversation: Object.freeze({
        ...this.conversationHeader(conversation, names),
        initiatingTriggerEventId: conversation.initiatingTriggerEventId,
        termBounds: conversation.termBounds,
        maxTurns: conversation.maxTurns,
        outputTokenBudget: conversation.outputTokenBudget,
        outputTokensUsed: conversation.outputTokensUsed,
        closeReason: conversation.closeReason,
        sourceEventId: conversation.sourceEventId,
      }),
      messages: Object.freeze(this.conversations.listMessages(conversationId).map((message) => ({
        id: message.id,
        turn: message.turn,
        sender: this.requireAgent(names, message.senderAgentId),
        recipient: this.requireAgent(names, message.recipientAgentId),
        kind: message.kind,
        content: message.content,
        structuredTerms: message.structuredTerms,
        tick: message.tick,
        deliveryTick: message.deliveryTick,
        decisionId: message.decisionId,
        llmCallId: message.llmCallId,
        outputTokens: message.outputTokens,
        sourceEventId: message.sourceEventId,
      }))),
      outcome: conversation.outcome,
      binding,
    });
  }

  private callItem(
    call: LlmCallRecordWithTelemetry,
    names: ReadonlyMap<string, AgentView>,
  ): LlmCallTelemetryItem {
    const { record } = call;
    return Object.freeze({
      id: record.id,
      decisionId: record.decisionId,
      agent: this.requireAgent(names, record.agentId),
      tick: record.tick,
      moduleId: record.moduleId,
      purpose: record.purpose,
      requestedTier: record.requestedTier,
      effectiveTier: record.effectiveTier,
      provider: record.provider,
      model: record.model,
      promptPackKey: record.promptPackKey,
      promptVersion: record.promptVersion,
      promptHash: record.promptHash,
      schemaKey: record.schemaKey,
      schemaVersion: record.schemaVersion,
      requestHash: record.requestHash,
      status: record.status,
      fallbackReason: record.fallbackReason ?? null,
      providerErrorCode: record.providerErrorCode ?? null,
      detail: record.detail ?? null,
      cached: record.cached,
      attempts: record.attempts,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      outputTokens: record.outputTokens,
      latencyMs: call.latencyMs,
      costMicrocents: call.costMicrocents,
      costCentsEstimate: centsEstimate(call.costMicrocents),
      sourceEventId: record.sourceEventId,
    });
  }

  private errorItems(names: ReadonlyMap<string, AgentView>): readonly ObservabilityErrorItem[] {
    const callsByEvent = new Map<string, LlmCallRecord>(
      this.calls.list().filter((record) => record.status === "fallback")
        .map((record) => [record.sourceEventId, record]),
    );
    const result: ObservabilityErrorItem[] = [];
    for (const event of this.events.list()) {
      const payload = objectPayload(event.payload);
      if (event.type === "system.error.raised") {
        result.push(this.errorItem(event, names, "engine",
          boundedString(payload["code"], "INTERNAL", 160),
          boundedString(payload["message"], "Engine error")));
      } else if (event.type === "agent.action.rejected") {
        result.push(this.errorItem(event, names, "intent_rejected",
          boundedString(payload["code"], "ACTION_REJECTED", 160),
          boundedString(payload["message"], "Agent intent rejected")));
      } else if (event.type === "llm.call.recorded") {
        const record = callsByEvent.get(event.eventId);
        if (record === undefined) continue;
        const kind = record.fallbackReason === "schema_invalid" ||
          record.fallbackReason === "validation_failed" ? "schema" : "llm";
        result.push(this.errorItem(
          event,
          names,
          kind,
          record.providerErrorCode ?? record.fallbackReason ?? "llm_fallback",
          record.detail ?? `LLM call fell back: ${record.fallbackReason ?? "unknown"}`,
          record.agentId,
        ));
      }
    }
    return Object.freeze(result.sort((left, right) => right.seq - left.seq));
  }

  private errorItem(
    event: EventEnvelope,
    names: ReadonlyMap<string, AgentView>,
    kind: ObservabilityErrorItem["kind"],
    code: string,
    message: string,
    agentId = event.actor.kind === "agent" ? event.actor.id : undefined,
  ): ObservabilityErrorItem {
    const agent = agentId === undefined ? null : this.requireAgent(names, agentId);
    return Object.freeze({
      eventId: event.eventId,
      seq: event.seq,
      at: event.wallTime,
      tick: event.tick,
      kind,
      code,
      message,
      actor: Object.freeze({ kind: event.actor.kind, id: event.actor.id }),
      agent,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
    });
  }

  private conversationHeader(
    conversation: ReturnType<SqliteConversationStore["get"]>,
    names: ReadonlyMap<string, AgentView>,
  ): ConversationListResponse["items"][number] {
    const binding = this.negotiations.getForConversation(conversation.id);
    return Object.freeze({
      id: conversation.id,
      participants: conversation.participantAgentIds.map((id) => this.requireAgent(names, id)),
      topic: conversation.topic,
      status: conversation.status,
      turns: conversation.turns,
      startTick: conversation.startTick,
      endTick: conversation.endTick,
      outcome: conversation.outcome === null ? null : { kind: conversation.outcome.kind },
      binding: binding === undefined ? null : {
        status: binding.status,
        resultKind: binding.resultKind,
        rejectionReason: binding.rejectionReason,
      },
    });
  }

  private agentNames(): ReadonlyMap<string, AgentView> {
    return new Map(this.db.prepare<[string], AgentNameRow>(`
      SELECT a.id, p.name
      FROM agents a
      JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? ORDER BY a.id
    `).all(this.runId).map((row) => [row.id, Object.freeze({ id: row.id, name: row.name })]));
  }

  private requireAgent(names: ReadonlyMap<string, AgentView>, agentId: string): AgentView {
    const agent = names.get(agentId);
    if (agent === undefined) {
      throw new EngineError("INTERNAL", `observability agent ${agentId} has no persona`);
    }
    return agent;
  }

  private activeQuarantines(names: ReadonlyMap<string, AgentView>) {
    const tickRow = this.db.prepare<[string], { current_tick: bigint }>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (tickRow === undefined) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    const tick = toSafeNumber(tickRow.current_tick, "run current tick");
    return new SqliteAgentStore(this.db, this.runId).listAgentEntities()
      .filter((agent) => agent.quarantine.mode === "tier1_only" && agent.quarantine.untilTick >= tick)
      .map((agent) => ({
        agent: this.requireAgent(names, agent.id),
        quarantine: agent.quarantine.mode === "tier1_only"
          ? agent.quarantine
          : { mode: "tier1_only" as const, untilTick: 0, consecutiveFailures: 0 },
      }))
      .sort((left, right) => compareCodeUnit(left.agent.id, right.agent.id));
  }
}
