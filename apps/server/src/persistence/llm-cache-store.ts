/** Durable, run-scoped LLM replay cache and independent audit stream (WS-602). */

import {
  createLlmCacheArtifact,
  llmCacheKey,
  llmCacheKeyHash,
  normalizeLlmCachedResponse,
  validateLlmCacheArtifact,
} from "@worldtangle/engine";
import type {
  LlmCacheArtifact,
  LlmCachedResponse,
  LlmCacheKey,
  LlmCacheTelemetry,
  LlmCacheWrite,
  LlmResponseCache,
} from "@worldtangle/engine";
import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  runIdSchema,
} from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

export const LLM_CACHE_EVENT_SCHEMA_VERSION = 1;

export const LLM_CACHE_AUDIT_TYPES = [
  "llm.cache.hit",
  "llm.cache.miss",
  "llm.cache.stored",
  "llm.cache.corrupt",
  "llm.cache.imported",
] as const;

export type LlmCacheAuditType = (typeof LLM_CACHE_AUDIT_TYPES)[number];

export interface LlmCacheAuditEvent {
  readonly runId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly type: LlmCacheAuditType;
  readonly schemaVersion: typeof LLM_CACHE_EVENT_SCHEMA_VERSION;
  readonly tick: number;
  readonly actor: Readonly<{ kind: "system"; id: "llm_gateway" }>;
  readonly correlationId: string;
  readonly causationId: string;
  readonly payload: unknown;
}

export interface ImportLlmCacheArtifactContext {
  readonly correlationId: string;
  readonly causationId: string;
}

export interface ImportLlmCacheArtifactResult {
  readonly imported: number;
  readonly skipped: number;
  readonly eventId?: string;
}

interface RunTickRow {
  current_tick: bigint;
}

interface NextCacheEventSeqRow {
  next_seq: bigint;
}

interface CacheRow {
  key_hash: string;
  provider: string;
  model: string;
  prompt_pack_version: bigint;
  schema_version: bigint;
  request_hash: string;
  response_canonical: string;
  response_model: string;
  input_tokens: bigint;
  output_tokens: bigint;
  attempts: bigint;
}

interface CacheAuditRow {
  run_id: string;
  seq: bigint;
  event_id: string;
  type: LlmCacheAuditType;
  schema_version: bigint;
  tick: bigint;
  correlation_id: string;
  causation_id: string;
  payload_canonical: string;
}

interface CountRow {
  count: bigint;
}

interface ExistsRow {
  found: bigint;
}

interface AppendedAuditEvent {
  readonly eventId: string;
  readonly tick: number;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be non-empty`);
  }
}

function parseCanonical(text: string, field: string): unknown {
  try {
    const parsed = canonicalParse(text);
    if (canonicalStringify(parsed) !== text) {
      throw new Error("stored value is not canonical");
    }
    return parsed;
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${field} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function sameRecord(left: LlmCachedResponse, right: LlmCachedResponse): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function mapCacheRow(row: CacheRow): LlmCachedResponse {
  const key = llmCacheKey({
    provider: row.provider,
    model: row.model,
    promptPackVersion: toSafeNumber(
      row.prompt_pack_version,
      "LLM cache prompt-pack version",
    ),
    schemaVersion: toSafeNumber(row.schema_version, "LLM cache schema version"),
    requestHash: row.request_hash,
  });
  const record = normalizeLlmCachedResponse({
    key,
    keyHash: row.key_hash,
    value: parseCanonical(row.response_canonical, "LLM cache response"),
    responseModel: row.response_model,
    inputTokens: toSafeNumber(row.input_tokens, "LLM cache input tokens"),
    outputTokens: toSafeNumber(row.output_tokens, "LLM cache output tokens"),
    attempts: toSafeNumber(row.attempts, "LLM cache attempts"),
  });
  if (llmCacheKeyHash(key) !== row.key_hash) {
    throw new EngineError("INTERNAL", "persisted LLM cache key hash is invalid");
  }
  return record;
}

/**
 * Cache metadata is operational replay state. It is snapshotted with SQLite,
 * but has an independent event sequence so importing it cannot perturb the
 * authoritative simulation event IDs or logical world hash.
 */
export class SqliteLlmResponseCache implements LlmResponseCache {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
  }

  get(keyInput: LlmCacheKey): LlmCachedResponse | undefined {
    const key = llmCacheKey(keyInput);
    const keyHash = llmCacheKeyHash(key);
    const row = this.db.prepare<[string, string], CacheRow>(`
      SELECT key_hash, provider, model, prompt_pack_version, schema_version,
        request_hash, response_canonical, response_model, input_tokens,
        output_tokens, attempts
      FROM llm_response_cache
      WHERE run_id = ? AND key_hash = ?
    `).get(this.runId, keyHash);
    if (row === undefined) return undefined;
    const record = mapCacheRow(row);
    if (canonicalStringify(record.key) !== canonicalStringify(key)) {
      throw new EngineError("INTERNAL", "persisted LLM cache record has a different key");
    }
    return record;
  }

  put(write: LlmCacheWrite): void {
    assertNonEmpty(write.correlationId, "LLM cache correlation ID");
    assertNonEmpty(write.causationId, "LLM cache causation ID");
    const record = normalizeLlmCachedResponse(write.record);
    this.inTransaction(() => {
      const existing = this.get(record.key);
      if (existing !== undefined) {
        if (!sameRecord(existing, record)) {
          throw new EngineError(
            "CONFLICT",
            "LLM cache keys are immutable and cannot map to different responses",
          );
        }
        return;
      }
      const audit = this.appendAuditWithinTransaction(
        "llm.cache.stored",
        write.correlationId,
        write.causationId,
        {
          key: record.key,
          keyHash: record.keyHash,
          responseModel: record.responseModel,
          evidence: [
            `request:${record.key.requestHash}`,
            `cache-key:${record.keyHash}`,
          ],
        },
      );
      this.insertRecord(record, this.runId, audit);
    });
  }

  recordTelemetry(telemetry: LlmCacheTelemetry): string {
    assertNonEmpty(telemetry.correlationId, "LLM cache correlation ID");
    assertNonEmpty(telemetry.causationId, "LLM cache causation ID");
    const key = llmCacheKey(telemetry.key);
    const keyHash = llmCacheKeyHash(key);
    if (telemetry.keyHash !== keyHash) {
      throw new EngineError("VALIDATION_FAILED", "LLM cache telemetry key hash is invalid");
    }
    if (telemetry.type === "llm.cache.stored") {
      throw new EngineError(
        "VALIDATION_FAILED",
        "LLM cache storage audit must be emitted atomically by put",
      );
    }
    return this.inTransaction(() => this.appendAuditWithinTransaction(
      telemetry.type,
      telemetry.correlationId,
      telemetry.causationId,
      {
        key,
        keyHash,
        mode: telemetry.mode,
        evidence: [`request:${key.requestHash}`, `cache-key:${keyHash}`],
      },
    ).eventId);
  }

  list(): readonly LlmCachedResponse[] {
    return Object.freeze(this.db.prepare<[string], CacheRow>(`
      SELECT key_hash, provider, model, prompt_pack_version, schema_version,
        request_hash, response_canonical, response_model, input_tokens,
        output_tokens, attempts
      FROM llm_response_cache
      WHERE run_id = ?
      ORDER BY key_hash ASC
    `).all(this.runId).map(mapCacheRow));
  }

  listEvents(): readonly LlmCacheAuditEvent[] {
    return Object.freeze(this.db.prepare<[string], CacheAuditRow>(`
      SELECT run_id, seq, event_id, type, schema_version, tick,
        correlation_id, causation_id, payload_canonical
      FROM llm_cache_events
      WHERE run_id = ?
      ORDER BY seq ASC
    `).all(this.runId).map((row) => {
      const schemaVersion = toSafeNumber(
        row.schema_version,
        "LLM cache event schema version",
      );
      if (schemaVersion !== LLM_CACHE_EVENT_SCHEMA_VERSION) {
        throw new EngineError("INTERNAL", "unsupported persisted LLM cache event version");
      }
      return Object.freeze({
        runId: row.run_id,
        seq: toSafeNumber(row.seq, "LLM cache event sequence"),
        eventId: row.event_id,
        type: row.type,
        schemaVersion: 1 as const,
        tick: toSafeNumber(row.tick, "LLM cache event tick"),
        actor: Object.freeze({ kind: "system" as const, id: "llm_gateway" as const }),
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        payload: parseCanonical(row.payload_canonical, "LLM cache event payload"),
      });
    }));
  }

  count(): number {
    const row = this.db.prepare<[string], CountRow>(`
      SELECT COUNT(*) AS count FROM llm_response_cache WHERE run_id = ?
    `).get(this.runId);
    return toSafeNumber(row?.count ?? 0n, "LLM cache record count");
  }

  exportArtifact(): LlmCacheArtifact {
    return createLlmCacheArtifact(this.runId, this.list());
  }

  importArtifact(
    input: unknown,
    context: ImportLlmCacheArtifactContext,
  ): ImportLlmCacheArtifactResult {
    assertNonEmpty(context.correlationId, "LLM cache import correlation ID");
    assertNonEmpty(context.causationId, "LLM cache import causation ID");
    const artifact = validateLlmCacheArtifact(input);
    return this.inTransaction(() => {
      const pending: LlmCachedResponse[] = [];
      let skipped = 0;
      for (const record of artifact.entries) {
        const existing = this.get(record.key);
        if (existing === undefined) {
          pending.push(record);
        } else if (sameRecord(existing, record)) {
          skipped += 1;
        } else {
          throw new EngineError(
            "CONFLICT",
            `LLM cache artifact conflicts at key ${record.keyHash}`,
          );
        }
      }
      if (pending.length === 0) return { imported: 0, skipped };

      const audit = this.appendAuditWithinTransaction(
        "llm.cache.imported",
        context.correlationId,
        context.causationId,
        {
          artifactFormat: artifact.format,
          artifactVersion: artifact.version,
          artifactDigest: artifact.digest,
          sourceRunId: artifact.sourceRunId,
          imported: pending.length,
          skipped,
          keyHashes: pending.map((record) => record.keyHash),
          evidence: [
            `artifact:${artifact.digest}`,
            `source-run:${artifact.sourceRunId}`,
          ],
        },
      );
      for (const record of pending) this.insertRecord(record, artifact.sourceRunId, audit);
      return { imported: pending.length, skipped, eventId: audit.eventId };
    });
  }

  private insertRecord(
    record: LlmCachedResponse,
    originRunId: string,
    audit: AppendedAuditEvent,
  ): void {
    this.db.prepare(`
      INSERT INTO llm_response_cache(
        run_id, key_hash, provider, model, prompt_pack_version, schema_version,
        request_hash, response_canonical, response_model, input_tokens,
        output_tokens, attempts, stored_tick, origin_run_id, source_event_id
      ) VALUES (
        @runId, @keyHash, @provider, @model, @promptPackVersion, @schemaVersion,
        @requestHash, @responseCanonical, @responseModel, @inputTokens,
        @outputTokens, @attempts, @storedTick, @originRunId, @sourceEventId
      )
    `).run({
      runId: this.runId,
      keyHash: record.keyHash,
      provider: record.key.provider,
      model: record.key.model,
      promptPackVersion: record.key.promptPackVersion,
      schemaVersion: record.key.schemaVersion,
      requestHash: record.key.requestHash,
      responseCanonical: canonicalStringify(record.value),
      responseModel: record.responseModel,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      attempts: record.attempts,
      storedTick: audit.tick,
      originRunId,
      sourceEventId: audit.eventId,
    });
  }

  private appendAuditWithinTransaction(
    type: LlmCacheAuditType,
    correlationId: string,
    causationId: string,
    payload: unknown,
  ): AppendedAuditEvent {
    this.assertCausationExists(causationId);
    const run = this.db.prepare<[string], RunTickRow>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (run === undefined) {
      throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    }
    const next = this.db.prepare<[string], NextCacheEventSeqRow>(`
      SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
      FROM llm_cache_events
      WHERE run_id = ?
    `).get(this.runId);
    const seq = toSafeNumber(next?.next_seq ?? 0n, "next LLM cache event sequence");
    const tick = toSafeNumber(run.current_tick, "run current tick");
    const eventId = `llmce_${seq.toString(36).padStart(8, "0")}`;
    this.db.prepare(`
      INSERT INTO llm_cache_events(
        run_id, seq, event_id, type, schema_version, tick, actor_kind,
        actor_id, correlation_id, causation_id, payload_canonical
      ) VALUES (
        @runId, @seq, @eventId, @type, @schemaVersion, @tick, 'system',
        'llm_gateway', @correlationId, @causationId, @payloadCanonical
      )
    `).run({
      runId: this.runId,
      seq,
      eventId,
      type,
      schemaVersion: LLM_CACHE_EVENT_SCHEMA_VERSION,
      tick,
      correlationId,
      causationId,
      payloadCanonical: canonicalStringify(payload),
    });
    return { eventId, tick };
  }

  private assertCausationExists(causationId: string): void {
    const row = this.db.prepare<[string, string, string, string], ExistsRow>(`
      SELECT 1 AS found FROM events
      WHERE run_id = ? AND event_id = ?
      UNION ALL
      SELECT 1 AS found FROM llm_cache_events
      WHERE run_id = ? AND event_id = ?
      LIMIT 1
    `).get(this.runId, causationId, this.runId, causationId);
    if (row === undefined) {
      throw new EngineError(
        "CONFLICT",
        `LLM cache causation event ${causationId} does not exist in run ${this.runId}`,
      );
    }
  }

  private inTransaction<T>(operation: () => T): T {
    return this.db.inTransaction
      ? operation()
      : this.db.transaction(operation).immediate();
  }
}
