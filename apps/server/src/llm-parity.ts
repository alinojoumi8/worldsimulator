/** Provider-neutral evidence projection for WS-610 mock/live parity checks. */

import {
  canonicalStringify,
  hashValue,
  type AgentAction,
  type Decision,
  type EventEnvelope,
  type LlmCallRecord,
} from "@worldtangle/shared";
import {
  SqliteAgentStore,
  SqliteEventStore,
  SqliteLlmCallStore,
  type WorldDatabase,
} from "./persistence";

const CALL_EVENT_OPERATIONAL_FIELDS = new Set([
  "provider",
  "model",
  "cached",
  "attempts",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "latencyMs",
  "costMicrocents",
]);

const USAGE_EVENT_OPERATIONAL_FIELDS = new Set([
  "provider",
  "model",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "costMicrocents",
  "cumulativeCostMicrocents",
]);

export const LLM_PARITY_SECTIONS = [
  "calls",
  "decisions",
  "actions",
  "events",
  "agentState",
] as const;

export type LlmParitySection = typeof LLM_PARITY_SECTIONS[number];

export interface LlmParityCallShape {
  readonly id: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly agentId: string;
  readonly tick: number;
  readonly moduleId: string;
  readonly purpose: string;
  readonly requestedTier: 2 | 3;
  readonly effectiveTier: 1 | 2 | 3;
  readonly promptPackKey: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly requestHash: string;
  readonly status: "success" | "fallback";
  readonly fallbackReason: LlmCallRecord["fallbackReason"] | null;
  readonly providerErrorCode: LlmCallRecord["providerErrorCode"] | null;
  readonly sourceEventId: string;
  readonly response?: unknown;
}

export interface LlmParityProviderReceipt {
  readonly callId: string;
  readonly provider: string;
  readonly model: string;
  readonly requestHash: string;
  readonly cached: boolean;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface LlmParityEventShape {
  readonly eventId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly simulationId: string;
  readonly runId: string;
  readonly seq: number;
  readonly tick: number;
  readonly simDate: string;
  readonly actor: EventEnvelope["actor"];
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: unknown;
}

export interface LlmParityAgentState {
  readonly agentId: string;
  readonly goals: readonly unknown[];
  readonly memories: readonly unknown[];
}

export interface LlmParityProjection {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly tick: number;
  readonly calls: readonly LlmParityCallShape[];
  readonly decisions: readonly Decision[];
  readonly actions: readonly AgentAction[];
  readonly events: readonly LlmParityEventShape[];
  readonly agentState: readonly LlmParityAgentState[];
}

export interface LlmParityCapture {
  readonly projection: LlmParityProjection;
  readonly digest: string;
  readonly providerReceipts: readonly LlmParityProviderReceipt[];
}

export interface LlmParitySectionComparison {
  readonly section: LlmParitySection;
  readonly leftDigest: string;
  readonly rightDigest: string;
  readonly equal: boolean;
}

export interface LlmParityComparison {
  readonly status: "passed" | "failed";
  readonly leftDigest: string;
  readonly rightDigest: string;
  readonly sections: readonly LlmParitySectionComparison[];
  readonly mismatches: readonly LlmParitySection[];
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordPayload(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function omitFields(
  input: Readonly<Record<string, unknown>>,
  omitted: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(input).filter(([key]) => !omitted.has(key)),
  ));
}

function normalizedEventPayload(event: EventEnvelope): unknown {
  const payload = recordPayload(event.payload);
  if (payload === undefined) return event.payload;
  if (event.type === "llm.call.recorded") {
    return omitFields(payload, CALL_EVENT_OPERATIONAL_FIELDS);
  }
  if (event.type === "llm.usage.recorded") {
    return omitFields(payload, USAGE_EVENT_OPERATIONAL_FIELDS);
  }
  if (event.type === "simulation.tick.completed") {
    const counts = recordPayload(payload["counts"]);
    return counts === undefined
      ? payload
      : Object.freeze({ ...payload, counts: omitFields(counts, new Set(["llmCalls"])) });
  }
  return payload;
}

function callShape(call: LlmCallRecord): LlmParityCallShape {
  return Object.freeze({
    id: call.id,
    runId: call.runId,
    decisionId: call.decisionId,
    agentId: call.agentId,
    tick: call.tick,
    moduleId: call.moduleId,
    purpose: call.purpose,
    requestedTier: call.requestedTier,
    effectiveTier: call.effectiveTier,
    promptPackKey: call.promptPackKey,
    promptVersion: call.promptVersion,
    promptHash: call.promptHash,
    schemaKey: call.schemaKey,
    schemaVersion: call.schemaVersion,
    requestHash: call.requestHash,
    status: call.status,
    fallbackReason: call.fallbackReason ?? null,
    providerErrorCode: call.providerErrorCode ?? null,
    sourceEventId: call.sourceEventId,
    ...(call.response === undefined ? {} : { response: call.response }),
  });
}

function eventShape(event: EventEnvelope): LlmParityEventShape {
  return Object.freeze({
    eventId: event.eventId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    simulationId: event.simulationId,
    runId: event.runId,
    seq: event.seq,
    tick: event.tick,
    simDate: event.simDate,
    actor: event.actor,
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    payload: normalizedEventPayload(event),
  });
}

/**
 * Read the engine-visible Tier-2 flow for one committed tick. Provider/model,
 * request-route identity, usage, cost, cache and latency remain available in
 * providerReceipts but are deliberately excluded from the parity digest.
 */
export function captureLlmParity(
  db: WorldDatabase,
  runId: string,
  tick: number,
): LlmParityCapture {
  const callStore = new SqliteLlmCallStore(db, runId);
  const calls = callStore.list().filter((call) => call.tick === tick);
  if (calls.length === 0) {
    throw new Error(`WS-610 parity capture found no LLM calls at tick ${tick}`);
  }
  const decisionIds = new Set(calls.map((call) => call.decisionId));
  const agentIds = [...new Set(calls.map((call) => call.agentId))].sort(compareCodeUnit);
  const agentStore = new SqliteAgentStore(db, runId);
  const decisions = agentIds.flatMap((agentId) => agentStore.listDecisions(agentId, {
    limit: 100,
    fromTick: tick,
    toTick: tick,
  })).filter((decision) => decisionIds.has(decision.id)).sort((left, right) => (
    compareCodeUnit(left.id, right.id)
  ));
  if (decisions.length !== decisionIds.size) {
    throw new Error(
      `WS-610 parity capture found ${decisions.length} decisions for ${decisionIds.size} calls`,
    );
  }
  const actions = agentStore.listActions().filter((action) => (
    action.decisionId !== undefined && decisionIds.has(action.decisionId)
  )).sort((left, right) => compareCodeUnit(left.id, right.id));
  const events = new SqliteEventStore(db, runId).list({ tick }).map(eventShape);
  const agentState = agentIds.map((agentId) => Object.freeze({
    agentId,
    goals: agentStore.listByAgent(agentId),
    memories: agentStore.list(agentId),
  }));
  const projection: LlmParityProjection = Object.freeze({
    schemaVersion: 1,
    runId,
    tick,
    calls: Object.freeze(calls.map(callShape)),
    decisions: Object.freeze(decisions),
    actions: Object.freeze(actions),
    events: Object.freeze(events),
    agentState: Object.freeze(agentState),
  });
  const providerReceipts = Object.freeze(calls.map((call) => Object.freeze({
    callId: call.id,
    provider: call.provider,
    model: call.model,
    requestHash: call.requestHash,
    cached: call.cached,
    attempts: call.attempts,
    inputTokens: call.inputTokens,
    cachedInputTokens: call.cachedInputTokens,
    outputTokens: call.outputTokens,
  })));
  return Object.freeze({
    projection,
    digest: hashValue(projection),
    providerReceipts,
  });
}

export function compareLlmParity(
  left: LlmParityCapture,
  right: LlmParityCapture,
): LlmParityComparison {
  const sections = LLM_PARITY_SECTIONS.map((section) => {
    const leftValue = left.projection[section];
    const rightValue = right.projection[section];
    return Object.freeze({
      section,
      leftDigest: hashValue(leftValue),
      rightDigest: hashValue(rightValue),
      equal: canonicalStringify(leftValue) === canonicalStringify(rightValue),
    });
  });
  const mismatches = sections.filter((section) => !section.equal).map((section) => section.section);
  return Object.freeze({
    status: mismatches.length === 0 ? "passed" : "failed",
    leftDigest: left.digest,
    rightDigest: right.digest,
    sections: Object.freeze(sections),
    mismatches: Object.freeze(mismatches),
  });
}

/** Acceptance-only setup: create exactly one tick-1 dormant-goal choice. */
export function prepareSingleGoalParityFixture(db: WorldDatabase, runId: string): string {
  const selected = db.prepare<[string], { agent_id: string }>(`
    SELECT agent_id FROM goals WHERE run_id = ? ORDER BY agent_id LIMIT 1
  `).get(runId);
  if (selected === undefined) throw new Error("WS-610 parity fixture has no seeded goals");
  const updated = db.prepare(`
    UPDATE goals SET status = 'dormant', activated_tick = NULL, terminal_tick = NULL
    WHERE run_id = ? AND agent_id = ?
  `).run(runId, selected.agent_id);
  if (updated.changes < 1) throw new Error("WS-610 parity fixture did not update a seeded goal");
  return selected.agent_id;
}
