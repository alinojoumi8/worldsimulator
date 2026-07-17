/** Immutable run-scoped LLM call evidence for Tier-2 decisions. */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  llmCallRecordSchema,
  type LlmCallRecord,
} from "@worldtangle/shared";
import { toSafeNumber, type WorldDatabase } from "./database";

interface LlmCallRow {
  record_canonical: string;
  latency_ms: bigint;
  cost_microcents: string;
}

export interface LlmCallTelemetry {
  readonly latencyMs: number;
  readonly costMicrocents: string;
}

export interface LlmCallRecordWithTelemetry extends LlmCallTelemetry {
  readonly record: LlmCallRecord;
}

export interface LlmCallTelemetrySummary {
  readonly totalCalls: number;
  readonly cacheableCalls: number;
  readonly cacheHits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: string;
}

const ZERO_TELEMETRY: LlmCallTelemetry = Object.freeze({
  latencyMs: 0,
  costMicrocents: "0",
});

function parseTelemetry(input: LlmCallTelemetry): LlmCallTelemetry {
  if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0) {
    throw new EngineError("VALIDATION_FAILED", "LLM latency must be a nonnegative safe integer");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.costMicrocents)) {
    throw new EngineError("VALIDATION_FAILED", "LLM cost must be canonical nonnegative microcents");
  }
  return Object.freeze({ ...input });
}

function withTelemetry(row: LlmCallRow): LlmCallRecordWithTelemetry {
  return Object.freeze({
    record: parseRecord(row.record_canonical),
    latencyMs: toSafeNumber(row.latency_ms, "LLM latency"),
    costMicrocents: row.cost_microcents,
  });
}

function parseRecord(text: string): LlmCallRecord {
  try {
    const parsed = canonicalParse(text);
    if (canonicalStringify(parsed) !== text) throw new Error("record is not canonical");
    return llmCallRecordSchema.parse(parsed);
  } catch (error) {
    throw new EngineError("INTERNAL", "persisted LLM call record is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export class SqliteLlmCallStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  insert(
    input: LlmCallRecord,
    telemetry: LlmCallTelemetry = ZERO_TELEMETRY,
  ): LlmCallRecord {
    const record = llmCallRecordSchema.parse(input);
    const parsedTelemetry = parseTelemetry(telemetry);
    if (record.runId !== this.runId) {
      throw new EngineError("CONFLICT", "LLM call record belongs to another run");
    }
    this.db.prepare(`
      INSERT INTO llm_call_records(
        run_id, id, decision_id, agent_id, tick, module_id, purpose, status,
        provider, model, request_hash, record_canonical, source_event_id,
        latency_ms, cost_microcents
      ) VALUES (
        @runId, @id, @decisionId, @agentId, @tick, @moduleId, @purpose, @status,
        @provider, @model, @requestHash, @recordCanonical, @sourceEventId,
        @latencyMs, @costMicrocents
      )
    `).run({
      runId: record.runId,
      id: record.id,
      decisionId: record.decisionId,
      agentId: record.agentId,
      tick: record.tick,
      moduleId: record.moduleId,
      purpose: record.purpose,
      status: record.status,
      provider: record.provider,
      model: record.model,
      requestHash: record.requestHash,
      recordCanonical: canonicalStringify(record),
      sourceEventId: record.sourceEventId,
      latencyMs: parsedTelemetry.latencyMs,
      costMicrocents: parsedTelemetry.costMicrocents,
    });
    return record;
  }

  get(callId: string): LlmCallRecord {
    const row = this.db.prepare<[string, string], LlmCallRow>(`
      SELECT record_canonical, latency_ms, cost_microcents
      FROM llm_call_records WHERE run_id = ? AND id = ?
    `).get(this.runId, callId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `LLM call ${callId} does not exist`);
    return parseRecord(row.record_canonical);
  }

  getWithTelemetry(callId: string): LlmCallRecordWithTelemetry {
    const row = this.db.prepare<[string, string], LlmCallRow>(`
      SELECT record_canonical, latency_ms, cost_microcents
      FROM llm_call_records WHERE run_id = ? AND id = ?
    `).get(this.runId, callId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `LLM call ${callId} does not exist`);
    return withTelemetry(row);
  }

  list(): readonly LlmCallRecord[] {
    return Object.freeze(this.db.prepare<[string], LlmCallRow>(`
      SELECT record_canonical, latency_ms, cost_microcents FROM llm_call_records
      WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map((row) => parseRecord(row.record_canonical)));
  }

  listForReplay(): readonly LlmCallRecord[] {
    return Object.freeze(this.db.prepare<[string], LlmCallRow>(`
      SELECT calls.record_canonical, calls.latency_ms, calls.cost_microcents
      FROM llm_call_records AS calls
      INNER JOIN events AS source_events
        ON source_events.run_id = calls.run_id
        AND source_events.event_id = calls.source_event_id
      WHERE calls.run_id = ?
      ORDER BY calls.tick, source_events.seq, calls.id
    `).all(this.runId).map((row) => parseRecord(row.record_canonical)));
  }

  listWithTelemetry(): readonly LlmCallRecordWithTelemetry[] {
    return Object.freeze(this.db.prepare<[string], LlmCallRow>(`
      SELECT record_canonical, latency_ms, cost_microcents FROM llm_call_records
      WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map(withTelemetry));
  }

  summary(): LlmCallTelemetrySummary {
    let cacheableCalls = 0;
    let cacheHits = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costMicrocents = 0n;
    const calls = this.listWithTelemetry();
    for (const call of calls) {
      const { record } = call;
      if (record.cached || record.attempts > 0) {
        cacheableCalls += 1;
        if (record.cached) cacheHits += 1;
      }
      if (!record.cached) {
        inputTokens += record.inputTokens;
        outputTokens += record.outputTokens;
      }
      costMicrocents += BigInt(call.costMicrocents);
    }
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
      throw new EngineError("INTERNAL", "LLM call token totals exceed the safe integer range");
    }
    return Object.freeze({
      totalCalls: calls.length,
      cacheableCalls,
      cacheHits,
      inputTokens,
      outputTokens,
      costMicrocents: costMicrocents.toString(),
    });
  }
}
