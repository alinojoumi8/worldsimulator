/** Restart-safe, hash-neutral export job and audit persistence (WS-706). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  EXPORT_DATASETS,
  EXPORT_DISCLAIMER,
  exportAuditEventSchema,
  exportDatasetSchema,
  exportFileSchema,
  exportIdSchema,
  exportJobSchema,
  exportManifestFileSchema,
  runIdSchema,
  simulationIdSchema,
  type ActorRef,
  type ExportAuditEvent,
  type ExportDataset,
  type ExportFile,
  type ExportFormat,
  type ExportJob,
  type ExportManifestFile,
} from "@worldtangle/shared";
import { toSafeNumber, type WorldDatabase } from "./database";

export const EXPORT_EVENT_SCHEMA_VERSION = 1 as const;

interface ExportJobRow {
  id: string;
  run_id: string;
  simulation_id: string;
  format: string;
  datasets_canonical: string;
  status: string;
  source_tick: bigint;
  source_state_hash: string;
  disclaimer: string;
  correlation_id: string;
  created_wall: string;
  started_wall: string | null;
  completed_wall: string | null;
  error_code: string | null;
  error_message: string | null;
  manifest_path: string | null;
  manifest_bytes: bigint | null;
  manifest_sha256: string | null;
}

interface ExportFileRow {
  dataset: string;
  format: string;
  relative_path: string;
  byte_count: bigint;
  row_count: bigint;
  sha256: string;
}

interface ExportEventRow {
  event_id: string;
  sequence: bigint;
  schema_version: bigint;
  type: string;
  tick: bigint;
  actor_kind: string;
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  evidence_canonical: string;
  wall_time: string;
}

interface CreateExportJobInput {
  readonly simulationId: string;
  readonly format: ExportFormat;
  readonly datasets: readonly ExportDataset[];
  readonly sourceTick: number;
  readonly sourceStateHash: string;
  readonly correlationId: string;
  readonly createdWall: string;
}

interface CompleteExportJobInput {
  readonly files: readonly ExportFile[];
  readonly manifest: ExportManifestFile;
  readonly completedWall: string;
}

function assertNonempty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be nonempty`);
  }
}

function canonicalDatasets(values: readonly ExportDataset[]): readonly ExportDataset[] {
  const requested = new Set(values.map((value) => exportDatasetSchema.parse(value)));
  if (requested.size === 0 || requested.size !== values.length) {
    throw new EngineError("VALIDATION_FAILED", "export datasets must be nonempty and unique");
  }
  return Object.freeze(EXPORT_DATASETS.filter((dataset) => requested.has(dataset)));
}

function parseDatasets(value: string): readonly ExportDataset[] {
  let parsed: unknown;
  try {
    parsed = canonicalParse(value);
  } catch (error) {
    throw new EngineError("INTERNAL", "persisted export datasets are malformed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new EngineError("INTERNAL", "persisted export datasets are not an array");
  }
  return canonicalDatasets(parsed.map((value) => exportDatasetSchema.parse(value)));
}

function nextJobId(db: WorldDatabase, runId: string): string {
  const row = db.prepare<[string], { count: bigint }>(`
    SELECT COUNT(*) AS count FROM export_jobs WHERE run_id = ?
  `).get(runId);
  const ordinal = toSafeNumber(row?.count ?? 0n, "export job count") + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new EngineError("INTERNAL", "export job counter overflow");
  }
  return exportIdSchema.parse(
    `xpt_${runId.slice(4)}${ordinal.toString(36).padStart(8, "0")}`,
  );
}

function eventId(jobId: string, sequence: number): string {
  return `xev_${jobId.slice(4)}${sequence.toString(36).padStart(8, "0")}`;
}

/** Run-scoped export metadata. Dataset files remain content-addressed filesystem artifacts. */
export class SqliteExportStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    const row = db.prepare<[string], { id: string }>(`
      SELECT id FROM simulation_runs WHERE id = ?
    `).get(runId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  }

  create(input: CreateExportJobInput): ExportJob {
    if (!simulationIdSchema.safeParse(input.simulationId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid simulation ID: ${input.simulationId}`);
    }
    if (!Number.isSafeInteger(input.sourceTick) || input.sourceTick < 0) {
      throw new EngineError("VALIDATION_FAILED", "export source tick must be nonnegative");
    }
    if (!/^[0-9a-f]{64}$/.test(input.sourceStateHash)) {
      throw new EngineError("VALIDATION_FAILED", "export source state hash is invalid");
    }
    assertNonempty(input.correlationId, "export correlation ID");
    assertNonempty(input.createdWall, "export creation wall time");
    const datasets = canonicalDatasets(input.datasets);

    const operation = (): ExportJob => {
      const id = nextJobId(this.db, this.runId);
      this.db.prepare(`
        INSERT INTO export_jobs(
          id, run_id, simulation_id, format, datasets_canonical, status,
          source_tick, source_state_hash, disclaimer, correlation_id,
          created_wall, started_wall, completed_wall, error_code, error_message,
          manifest_path, manifest_bytes, manifest_sha256
        ) VALUES (
          @id, @runId, @simulationId, @format, @datasets, 'queued',
          @sourceTick, @sourceStateHash, @disclaimer, @correlationId,
          @createdWall, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        )
      `).run({
        id,
        runId: this.runId,
        simulationId: input.simulationId,
        format: input.format,
        datasets: canonicalStringify(datasets),
        sourceTick: input.sourceTick,
        sourceStateHash: input.sourceStateHash,
        disclaimer: EXPORT_DISCLAIMER,
        correlationId: input.correlationId,
        createdWall: input.createdWall,
      });
      this.appendEvent(id, {
        type: "export.job.queued",
        tick: input.sourceTick,
        actor: { kind: "admin", id: "api" },
        correlationId: input.correlationId,
        causationId: null,
        evidence: {
          datasets,
          format: input.format,
          sourceStateHash: input.sourceStateHash,
          sourceTick: input.sourceTick,
        },
        wallTime: input.createdWall,
      });
      return this.get(id);
    };
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }

  has(exportId: string): boolean {
    exportIdSchema.parse(exportId);
    return this.db.prepare<[string, string], { found: bigint }>(`
      SELECT 1 AS found FROM export_jobs WHERE run_id = ? AND id = ?
    `).get(this.runId, exportId) !== undefined;
  }

  get(exportId: string): ExportJob {
    exportIdSchema.parse(exportId);
    const row = this.db.prepare<[string, string], ExportJobRow>(`
      SELECT * FROM export_jobs WHERE run_id = ? AND id = ?
    `).get(this.runId, exportId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `export ${exportId} does not exist`);
    return this.mapJob(row);
  }

  listActive(): readonly ExportJob[] {
    const rows = this.db.prepare<[string], ExportJobRow>(`
      SELECT * FROM export_jobs
      WHERE run_id = ? AND status IN ('queued', 'running')
      ORDER BY created_wall, id
    `).all(this.runId);
    return Object.freeze(rows.map((row) => this.mapJob(row)));
  }

  markRunning(exportId: string, wallTime: string): ExportJob {
    assertNonempty(wallTime, "export start wall time");
    return this.transition(() => {
      const current = this.get(exportId);
      if (current.status !== "queued") {
        throw new EngineError("CONFLICT", `cannot start export ${exportId} from ${current.status}`);
      }
      const updated = this.db.prepare(`
        UPDATE export_jobs SET status = 'running', started_wall = @wallTime
        WHERE run_id = @runId AND id = @exportId AND status = 'queued'
      `).run({ runId: this.runId, exportId, wallTime });
      if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale export start");
      this.appendEvent(exportId, {
        type: "export.job.started",
        tick: current.sourceTick,
        actor: { kind: "system", id: "export_worker" },
        correlationId: current.auditEvents[0]!.correlationId,
        causationId: current.auditEvents.at(-1)!.id,
        evidence: { sourceStateHash: current.sourceStateHash, sourceTick: current.sourceTick },
        wallTime,
      });
      return this.get(exportId);
    });
  }

  complete(exportId: string, input: CompleteExportJobInput): ExportJob {
    assertNonempty(input.completedWall, "export completion wall time");
    const manifest = exportManifestFileSchema.parse(input.manifest);
    const files = input.files.map((file) => exportFileSchema.parse(file));
    return this.transition(() => {
      const current = this.get(exportId);
      if (current.status !== "running") {
        throw new EngineError("CONFLICT", `cannot complete export ${exportId} from ${current.status}`);
      }
      const expected = new Set(current.datasets);
      if (
        files.length !== expected.size ||
        files.some((file) => file.format !== current.format || !expected.delete(file.dataset)) ||
        expected.size !== 0
      ) {
        throw new EngineError("VALIDATION_FAILED", "export files do not match the requested datasets");
      }
      for (const file of files) {
        this.db.prepare(`
          INSERT INTO export_files(
            run_id, export_id, dataset, format, relative_path,
            byte_count, row_count, sha256
          ) VALUES (
            @runId, @exportId, @dataset, @format, @path,
            @bytes, @rows, @sha256
          )
        `).run({ runId: this.runId, exportId, ...file });
      }
      const updated = this.db.prepare(`
        UPDATE export_jobs SET
          status = 'completed', completed_wall = @completedWall,
          manifest_path = @manifestPath, manifest_bytes = @manifestBytes,
          manifest_sha256 = @manifestSha256
        WHERE run_id = @runId AND id = @exportId AND status = 'running'
      `).run({
        runId: this.runId,
        exportId,
        completedWall: input.completedWall,
        manifestPath: manifest.path,
        manifestBytes: manifest.bytes,
        manifestSha256: manifest.sha256,
      });
      if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale export completion");
      this.appendEvent(exportId, {
        type: "export.job.completed",
        tick: current.sourceTick,
        actor: { kind: "system", id: "export_worker" },
        correlationId: current.auditEvents[0]!.correlationId,
        causationId: current.auditEvents.at(-1)!.id,
        evidence: {
          files: files.map((file) => ({
            dataset: file.dataset,
            rows: file.rows,
            sha256: file.sha256,
          })),
          manifestSha256: manifest.sha256,
          sourceStateHash: current.sourceStateHash,
        },
        wallTime: input.completedWall,
      });
      return this.get(exportId);
    });
  }

  fail(exportId: string, input: {
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly completedWall: string;
  }): ExportJob {
    assertNonempty(input.errorCode, "export error code");
    assertNonempty(input.errorMessage, "export error message");
    assertNonempty(input.completedWall, "export failure wall time");
    return this.transition(() => {
      const current = this.get(exportId);
      if (current.status !== "queued" && current.status !== "running") {
        throw new EngineError("CONFLICT", `cannot fail export ${exportId} from ${current.status}`);
      }
      const updated = this.db.prepare(`
        UPDATE export_jobs SET
          status = 'failed', completed_wall = @completedWall,
          error_code = @errorCode, error_message = @errorMessage
        WHERE run_id = @runId AND id = @exportId
          AND status IN ('queued', 'running')
      `).run({ runId: this.runId, exportId, ...input });
      if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale export failure");
      this.appendEvent(exportId, {
        type: "export.job.failed",
        tick: current.sourceTick,
        actor: { kind: "system", id: "export_worker" },
        correlationId: current.auditEvents[0]!.correlationId,
        causationId: current.auditEvents.at(-1)!.id,
        evidence: { errorCode: input.errorCode, errorMessage: input.errorMessage },
        wallTime: input.completedWall,
      });
      return this.get(exportId);
    });
  }

  listEvents(exportId: string): readonly ExportAuditEvent[] {
    exportIdSchema.parse(exportId);
    const rows = this.db.prepare<[string, string], ExportEventRow>(`
      SELECT event_id, sequence, schema_version, type, tick,
        actor_kind, actor_id, correlation_id, causation_id,
        evidence_canonical, wall_time
      FROM export_events
      WHERE run_id = ? AND export_id = ?
      ORDER BY sequence
    `).all(this.runId, exportId);
    return Object.freeze(rows.map((row) => exportAuditEventSchema.parse({
      id: row.event_id,
      sequence: toSafeNumber(row.sequence, "export event sequence"),
      schemaVersion: toSafeNumber(row.schema_version, "export event schema version"),
      type: row.type,
      tick: toSafeNumber(row.tick, "export event tick"),
      actor: { kind: row.actor_kind, id: row.actor_id },
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      evidence: canonicalParse(row.evidence_canonical),
      wallTime: row.wall_time,
    })));
  }

  private appendEvent(exportId: string, input: {
    readonly type: "export.job.queued" | "export.job.started" | "export.job.completed" | "export.job.failed";
    readonly tick: number;
    readonly actor: ActorRef;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly wallTime: string;
  }): void {
    const count = this.db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM export_events WHERE run_id = ? AND export_id = ?
    `).get(this.runId, exportId)?.count ?? 0n;
    const sequence = toSafeNumber(count, "export event count") + 1;
    const id = eventId(exportId, sequence);
    exportAuditEventSchema.parse({ id, sequence, schemaVersion: 1, ...input });
    this.db.prepare(`
      INSERT INTO export_events(
        run_id, export_id, sequence, event_id, schema_version, type, tick,
        actor_kind, actor_id, correlation_id, causation_id,
        evidence_canonical, wall_time
      ) VALUES (
        @runId, @exportId, @sequence, @eventId, 1, @type, @tick,
        @actorKind, @actorId, @correlationId, @causationId,
        @evidence, @wallTime
      )
    `).run({
      runId: this.runId,
      exportId,
      sequence,
      eventId: id,
      type: input.type,
      tick: input.tick,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      correlationId: input.correlationId,
      causationId: input.causationId,
      evidence: canonicalStringify(input.evidence),
      wallTime: input.wallTime,
    });
  }

  private mapJob(row: ExportJobRow): ExportJob {
    const files = this.db.prepare<[string, string], ExportFileRow>(`
      SELECT dataset, format, relative_path, byte_count, row_count, sha256
      FROM export_files WHERE run_id = ? AND export_id = ?
      ORDER BY CASE dataset
        WHEN 'events' THEN 1 WHEN 'transactions' THEN 2 ELSE 3 END
    `).all(this.runId, row.id).map((file) => exportFileSchema.parse({
      dataset: file.dataset,
      format: file.format,
      path: file.relative_path,
      bytes: toSafeNumber(file.byte_count, "export file bytes"),
      rows: toSafeNumber(file.row_count, "export file rows"),
      sha256: file.sha256,
    }));
    const manifest = row.manifest_path === null
      ? null
      : exportManifestFileSchema.parse({
          path: row.manifest_path,
          bytes: toSafeNumber(row.manifest_bytes!, "export manifest bytes"),
          sha256: row.manifest_sha256,
        });
    return exportJobSchema.parse({
      id: row.id,
      simulationId: row.simulation_id,
      runId: row.run_id,
      format: row.format,
      datasets: parseDatasets(row.datasets_canonical),
      status: row.status,
      sourceTick: toSafeNumber(row.source_tick, "export source tick"),
      sourceStateHash: row.source_state_hash,
      disclaimer: row.disclaimer,
      files,
      manifest,
      auditEvents: this.listEvents(row.id),
      createdWall: row.created_wall,
      startedWall: row.started_wall,
      completedWall: row.completed_wall,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    });
  }

  private transition<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }
}
