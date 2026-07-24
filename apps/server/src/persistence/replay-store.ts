/** Hash-neutral replay control-plane persistence (WS-705). */

import {
  agentLabActionChoiceSchema,
  canonicalParse,
  canonicalStringify,
  EngineError,
  hashValue,
  llmCallRecordSchema,
  replayDivergenceSchema,
  replayRunSchema,
  type ReplayDivergence,
  type ReplayDivergenceKind,
  type ReplayMode,
  type ReplayRun,
  type AgentLabActionChoice,
  type LlmCallRecord,
} from "@worldtangle/shared";
import { toSafeNumber, type WorldDatabase } from "./database";

interface ReplayRunRow {
  run_id: string;
  source_simulation_id: string;
  source_run_id: string;
  mode: ReplayMode;
  to_tick: bigint;
  status: ReplayRun["status"];
  current_tick: bigint;
  last_compared_seq: bigint;
  cache_artifact_digest: string;
  journal_digest: string;
  source_state_hash: string | null;
  replay_state_hash: string | null;
  started_wall: string;
  completed_wall: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ReplayDivergenceRow {
  sequence: bigint;
  tick: bigint;
  kind: ReplayDivergenceKind;
  expected_hash: string | null;
  actual_hash: string | null;
  details_canonical: string;
}

interface CountRow {
  count: bigint;
}

interface ReplayLlmExpectationRow {
  record_canonical: string;
}

interface ReplayAgentLabSubmissionRow {
  request_hash: string;
  source_event_id: string;
  proposal_digest: string;
  proposal_canonical: string;
}

export interface ReplayAgentLabSubmissionInput {
  readonly requestHash: string;
  readonly sourceEventId: string;
  readonly proposalDigest: string;
  readonly proposal: AgentLabActionChoice;
}

export interface ReplayAgentLabSubmissionExpectation
  extends ReplayAgentLabSubmissionInput {
  readonly ordinal: number;
}

export interface CreateReplayRecordInput {
  readonly runId: string;
  readonly sourceSimulationId: string;
  readonly sourceRunId: string;
  readonly mode: ReplayMode;
  readonly toTick: number;
  readonly cacheArtifactDigest: string;
  readonly journalDigest: string;
  readonly startedWall: string;
}

export interface RecordReplayDivergenceInput {
  readonly tick: number;
  readonly kind: ReplayDivergenceKind;
  readonly expectedHash?: string | null;
  readonly actualHash?: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdWall: string;
}

function parseDetails(text: string): Record<string, unknown> {
  try {
    const parsed = canonicalParse(text);
    if (
      canonicalStringify(parsed) !== text ||
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("details are not a canonical object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new EngineError("INTERNAL", "persisted replay divergence details are invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function mapDivergence(row: ReplayDivergenceRow): ReplayDivergence {
  return replayDivergenceSchema.parse({
    sequence: toSafeNumber(row.sequence, "replay divergence sequence"),
    tick: toSafeNumber(row.tick, "replay divergence tick"),
    kind: row.kind,
    expectedHash: row.expected_hash,
    actualHash: row.actual_hash,
    details: parseDetails(row.details_canonical),
  });
}

export class SqliteReplayStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  create(input: CreateReplayRecordInput): ReplayRun {
    if (input.runId !== this.runId) {
      throw new EngineError("CONFLICT", "replay record belongs to another run");
    }
    this.db.prepare(`
      INSERT INTO replay_runs(
        run_id, source_simulation_id, source_run_id, mode, to_tick, status,
        current_tick, last_compared_seq, cache_artifact_digest, journal_digest,
        source_state_hash, replay_state_hash, started_wall, completed_wall,
        error_code, error_message
      ) VALUES (
        @runId, @sourceSimulationId, @sourceRunId, @mode, @toTick, 'running',
        0, -1, @cacheArtifactDigest, @journalDigest,
        NULL, NULL, @startedWall, NULL, NULL, NULL
      )
    `).run(input);
    return this.require();
  }

  get(): ReplayRun | null {
    const row = this.db.prepare<[string], ReplayRunRow>(`
      SELECT run_id, source_simulation_id, source_run_id, mode, to_tick, status,
        current_tick, last_compared_seq, cache_artifact_digest, journal_digest,
        source_state_hash, replay_state_hash, started_wall, completed_wall,
        error_code, error_message
      FROM replay_runs WHERE run_id = ?
    `).get(this.runId);
    if (row === undefined) return null;
    const firstDivergence = this.firstDivergence();
    const divergenceCount = this.divergenceCount();
    return replayRunSchema.parse({
      id: row.run_id,
      replayOf: row.source_run_id,
      sourceSimulationId: row.source_simulation_id,
      mode: row.mode,
      toTick: toSafeNumber(row.to_tick, "replay target tick"),
      status: row.status,
      currentTick: toSafeNumber(row.current_tick, "replay current tick"),
      lastComparedSeq: toSafeNumber(row.last_compared_seq, "replay event sequence"),
      divergenceCount,
      firstDivergence,
      sourceStateHash: row.source_state_hash,
      replayStateHash: row.replay_state_hash,
      cacheArtifactDigest: row.cache_artifact_digest,
      journalDigest: row.journal_digest,
      startedWall: row.started_wall,
      completedWall: row.completed_wall,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    });
  }

  require(): ReplayRun {
    const replay = this.get();
    if (replay === null) {
      throw new EngineError("NOT_FOUND", `run ${this.runId} is not a replay`);
    }
    return replay;
  }

  updateProgress(currentTick: number, lastComparedSeq: number): ReplayRun {
    const updated = this.db.prepare(`
      UPDATE replay_runs
      SET current_tick = @currentTick, last_compared_seq = @lastComparedSeq
      WHERE run_id = @runId AND status = 'running'
        AND current_tick <= @currentTick AND last_compared_seq <= @lastComparedSeq
    `).run({ runId: this.runId, currentTick, lastComparedSeq });
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", "stale replay progress checkpoint");
    }
    return this.require();
  }

  importLlmExpectations(records: readonly LlmCallRecord[]): void {
    const insert = this.db.prepare(`
      INSERT INTO replay_llm_expectations(
        run_id, ordinal, request_hash, record_canonical
      ) VALUES (@runId, @ordinal, @requestHash, @recordCanonical)
    `);
    this.db.transaction(() => {
      for (let index = 0; index < records.length; index++) {
        const record = llmCallRecordSchema.parse(records[index]);
        insert.run({
          runId: this.runId,
          ordinal: index + 1,
          requestHash: record.requestHash,
          recordCanonical: canonicalStringify(record),
        });
      }
    }).immediate();
  }

  importAgentLabSubmissions(records: readonly ReplayAgentLabSubmissionInput[]): void {
    const insert = this.db.prepare(`
      INSERT INTO replay_agent_lab_submissions(
        run_id, ordinal, request_hash, source_event_id,
        proposal_digest, proposal_canonical
      ) VALUES (
        @runId, @ordinal, @requestHash, @sourceEventId,
        @proposalDigest, @proposalCanonical
      )
    `);
    this.db.transaction(() => {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const proposal = agentLabActionChoiceSchema.parse(record.proposal);
        if (hashValue(proposal) !== record.proposalDigest) {
          throw new EngineError(
            "CONFLICT",
            "recorded Agent Lab proposal digest changed before replay import",
          );
        }
        insert.run({
          runId: this.runId,
          ordinal: index + 1,
          requestHash: record.requestHash,
          sourceEventId: record.sourceEventId,
          proposalDigest: record.proposalDigest,
          proposalCanonical: canonicalStringify(proposal),
        });
      }
    }).immediate();
  }

  agentLabSubmissionAt(ordinal: number): ReplayAgentLabSubmissionExpectation | null {
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "replay Agent Lab submission ordinal must be positive",
      );
    }
    const row = this.db.prepare<
      [string, number],
      ReplayAgentLabSubmissionRow
    >(`
      SELECT request_hash, source_event_id, proposal_digest, proposal_canonical
      FROM replay_agent_lab_submissions
      WHERE run_id = ? AND ordinal = ?
    `).get(this.runId, ordinal);
    if (row === undefined) return null;
    try {
      const parsed = canonicalParse(row.proposal_canonical);
      if (canonicalStringify(parsed) !== row.proposal_canonical) {
        throw new Error("proposal is not canonical");
      }
      const proposal = agentLabActionChoiceSchema.parse(parsed);
      if (hashValue(proposal) !== row.proposal_digest) {
        throw new Error("proposal digest does not match");
      }
      return Object.freeze({
        ordinal,
        requestHash: row.request_hash,
        sourceEventId: row.source_event_id,
        proposalDigest: row.proposal_digest,
        proposal,
      });
    } catch (error) {
      throw new EngineError("INTERNAL", "persisted replay Agent Lab submission is invalid", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  nextLlmExpectationOrdinal(): number {
    const count = this.db.prepare<[string], CountRow>(`
      SELECT COUNT(*) AS count FROM llm_call_records WHERE run_id = ?
    `).get(this.runId);
    return toSafeNumber(count?.count ?? 0n, "replay LLM call count") + 1;
  }

  llmExpectationAt(ordinal: number): LlmCallRecord | null {
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      throw new EngineError("VALIDATION_FAILED", "replay LLM expectation ordinal must be positive");
    }
    const row = this.db.prepare<[string, number], ReplayLlmExpectationRow>(`
      SELECT record_canonical FROM replay_llm_expectations
      WHERE run_id = ? AND ordinal = ?
    `).get(this.runId, ordinal);
    if (row === undefined) return null;
    try {
      const parsed = canonicalParse(row.record_canonical);
      if (canonicalStringify(parsed) !== row.record_canonical) {
        throw new Error("record is not canonical");
      }
      return llmCallRecordSchema.parse(parsed);
    } catch (error) {
      throw new EngineError("INTERNAL", "persisted replay LLM expectation is invalid", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordDivergence(input: RecordReplayDivergenceInput): ReplayDivergence {
    return this.db.transaction(() => {
      const replay = this.require();
      if (replay.status !== "running") {
        throw new EngineError("CONFLICT", "cannot append divergence to terminal replay");
      }
      const sequence = this.divergenceCount() + 1;
      const divergence = replayDivergenceSchema.parse({
        sequence,
        tick: input.tick,
        kind: input.kind,
        expectedHash: input.expectedHash ?? null,
        actualHash: input.actualHash ?? null,
        details: input.details,
      });
      this.db.prepare(`
        INSERT INTO replay_divergences(
          run_id, sequence, tick, kind, expected_hash, actual_hash,
          details_canonical, created_wall
        ) VALUES (
          @runId, @sequence, @tick, @kind, @expectedHash, @actualHash,
          @details, @createdWall
        )
      `).run({
        runId: this.runId,
        sequence: divergence.sequence,
        tick: divergence.tick,
        kind: divergence.kind,
        expectedHash: divergence.expectedHash,
        actualHash: divergence.actualHash,
        details: canonicalStringify(divergence.details),
        createdWall: input.createdWall,
      });
      return divergence;
    }).immediate();
  }

  finish(input: {
    readonly status: "completed" | "diverged";
    readonly currentTick: number;
    readonly lastComparedSeq: number;
    readonly sourceStateHash: string | null;
    readonly replayStateHash: string;
    readonly completedWall: string;
  }): ReplayRun {
    const updated = this.db.prepare(`
      UPDATE replay_runs
      SET status = @status, current_tick = @currentTick,
        last_compared_seq = @lastComparedSeq,
        source_state_hash = @sourceStateHash,
        replay_state_hash = @replayStateHash,
        completed_wall = @completedWall
      WHERE run_id = @runId AND status = 'running'
    `).run({ runId: this.runId, ...input });
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", "replay is already terminal");
    }
    return this.require();
  }

  fail(input: {
    readonly currentTick: number;
    readonly lastComparedSeq: number;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly completedWall: string;
  }): ReplayRun {
    const updated = this.db.prepare(`
      UPDATE replay_runs
      SET status = 'failed', current_tick = @currentTick,
        last_compared_seq = @lastComparedSeq,
        completed_wall = @completedWall,
        error_code = @errorCode, error_message = @errorMessage
      WHERE run_id = @runId AND status = 'running'
    `).run({ runId: this.runId, ...input });
    if (updated.changes !== 1) return this.require();
    return this.require();
  }

  listDivergences(): readonly ReplayDivergence[] {
    return Object.freeze(this.db.prepare<[string], ReplayDivergenceRow>(`
      SELECT sequence, tick, kind, expected_hash, actual_hash, details_canonical
      FROM replay_divergences WHERE run_id = ? ORDER BY sequence
    `).all(this.runId).map(mapDivergence));
  }

  private firstDivergence(): ReplayDivergence | null {
    const row = this.db.prepare<[string], ReplayDivergenceRow>(`
      SELECT sequence, tick, kind, expected_hash, actual_hash, details_canonical
      FROM replay_divergences WHERE run_id = ? ORDER BY sequence LIMIT 1
    `).get(this.runId);
    return row === undefined ? null : mapDivergence(row);
  }

  private divergenceCount(): number {
    const row = this.db.prepare<[string], CountRow>(`
      SELECT COUNT(*) AS count FROM replay_divergences WHERE run_id = ?
    `).get(this.runId);
    return toSafeNumber(row?.count ?? 0n, "replay divergence count");
  }
}
