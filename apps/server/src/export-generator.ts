/** Deterministic JSONL/CSV export materialization (WS-706). */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  canonicalStringify,
  EngineError,
  exportFileSchema,
  exportManifestFileSchema,
  exportManifestSchema,
  sha256Hex,
  type EventEnvelope,
  type ExportDataset,
  type ExportFile,
  type ExportFormat,
  type ExportJob,
  type ExportManifestFile,
} from "@worldtangle/shared";
import {
  SqliteEventStore,
  SqliteFinanceStore,
  toSafeNumber,
  type RunLocation,
  type TransactionView,
  type WorldDatabase,
} from "./persistence";

interface IndicatorExportRow {
  readonly runId: string;
  readonly tick: number;
  readonly series: string;
  readonly value: string;
  readonly formulaVersion: number;
  readonly inputsDigest: string;
}

interface DatasetArtifact {
  readonly file: ExportFile;
  readonly absolutePath: string;
}

export interface ExportArtifacts {
  readonly files: readonly ExportFile[];
  readonly manifest: ExportManifestFile;
  readonly absoluteManifestPath: string;
}

interface IndicatorRow {
  tick: bigint;
  indicator_key: string;
  value_integer: string;
  formula_version: bigint;
  inputs_digest: string;
}

function allTransactions(db: WorldDatabase, runId: string): readonly TransactionView[] {
  const store = new SqliteFinanceStore(db, runId);
  const descending: TransactionView[] = [];
  let beforeId: string | undefined;
  while (true) {
    const page = store.listTransactions({
      limit: 1_000,
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    descending.push(...page.items);
    if (page.nextId === null) break;
    beforeId = page.nextId;
  }
  return Object.freeze(descending.reverse());
}

function allIndicators(db: WorldDatabase, runId: string): readonly IndicatorExportRow[] {
  const rows = db.prepare<[string], IndicatorRow>(`
    SELECT tick, indicator_key, value_integer, formula_version, inputs_digest
    FROM indicator_points
    WHERE run_id = ?
    ORDER BY tick, indicator_key
  `).all(runId);
  return Object.freeze(rows.map((row) => Object.freeze({
    runId,
    tick: toSafeNumber(row.tick, "export indicator tick"),
    series: row.indicator_key,
    value: row.value_integer,
    formulaVersion: toSafeNumber(row.formula_version, "export indicator formula version"),
    inputsDigest: row.inputs_digest,
  })));
}

function datasetRows(
  db: WorldDatabase,
  runId: string,
  dataset: ExportDataset,
): readonly unknown[] {
  if (dataset === "events") return new SqliteEventStore(db, runId).list();
  if (dataset === "transactions") return allTransactions(db, runId);
  return allIndicators(db, runId);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : canonicalStringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csvDocument(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

function eventCsv(rows: readonly unknown[]): string {
  const events = rows as readonly EventEnvelope[];
  return csvDocument([
    "eventId",
    "type",
    "schemaVersion",
    "simulationId",
    "runId",
    "seq",
    "tick",
    "simDate",
    "wallTime",
    "actorKind",
    "actorId",
    "correlationId",
    "causationId",
    "payloadCanonical",
  ], events.map((event) => [
    event.eventId,
    event.type,
    event.schemaVersion,
    event.simulationId,
    event.runId,
    event.seq,
    event.tick,
    event.simDate,
    event.wallTime,
    event.actor.kind,
    event.actor.id,
    event.correlationId,
    event.causationId ?? null,
    event.payload,
  ]));
}

function transactionCsv(rows: readonly unknown[]): string {
  const transactions = rows as readonly TransactionView[];
  return csvDocument([
    "id",
    "runId",
    "tick",
    "kind",
    "actorKind",
    "actorId",
    "reason",
    "sourceEventId",
    "correlationId",
    "idempotencyKey",
    "legsCanonical",
  ], transactions.map((transaction) => [
    transaction.id,
    transaction.runId,
    transaction.tick,
    transaction.kind,
    transaction.actor.kind,
    transaction.actor.id,
    transaction.reason,
    transaction.sourceEventId,
    transaction.correlationId,
    transaction.idempotencyKey,
    transaction.legs,
  ]));
}

function indicatorCsv(rows: readonly unknown[]): string {
  const indicators = rows as readonly IndicatorExportRow[];
  return csvDocument([
    "runId",
    "tick",
    "series",
    "value",
    "formulaVersion",
    "inputsDigest",
  ], indicators.map((indicator) => [
    indicator.runId,
    indicator.tick,
    indicator.series,
    indicator.value,
    indicator.formulaVersion,
    indicator.inputsDigest,
  ]));
}

export function serializeExportDataset(
  dataset: ExportDataset,
  format: ExportFormat,
  rows: readonly unknown[],
): string {
  if (format === "jsonl") {
    return rows.map((row) => canonicalStringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  }
  if (dataset === "events") return eventCsv(rows);
  if (dataset === "transactions") return transactionCsv(rows);
  return indicatorCsv(rows);
}

function normalizedRelativePath(...parts: readonly string[]): string {
  return parts.join("/");
}

function absoluteExportPath(runRoot: string, relativePath: string): string {
  const target = resolve(runRoot, ...relativePath.split("/"));
  const relation = relative(runRoot, target);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new EngineError("INTERNAL", `unsafe export path: ${relativePath}`);
  }
  return target;
}

function flushFile(path: string): void {
  // Windows requires a writable handle for FlushFileBuffers/fsync.
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectory(path: string): void {
  try {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Windows cannot fsync directories. File fsync + same-directory rename is
    // still the strongest portable atomic publication boundary available.
  }
}

function writeContentAddressed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== content) {
      throw new EngineError("CONFLICT", `content-addressed export path is occupied: ${path}`);
    }
    return;
  }
  const temporary = `${path}.tmp`;
  if (existsSync(temporary)) unlinkSync(temporary);
  writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  flushFile(temporary);
  renameSync(temporary, path);
  flushDirectory(dirname(path));
}

function materializeDataset(
  db: WorldDatabase,
  location: RunLocation,
  job: ExportJob,
  dataset: ExportDataset,
): DatasetArtifact {
  const rows = datasetRows(db, location.runId, dataset);
  const content = serializeExportDataset(dataset, job.format, rows);
  const sha256 = sha256Hex(content);
  const relativePath = normalizedRelativePath(
    "exports",
    job.id,
    `${dataset}-${sha256}.${job.format}`,
  );
  const runRoot = dirname(location.databasePath);
  const absolutePath = absoluteExportPath(runRoot, relativePath);
  writeContentAddressed(absolutePath, content);
  return Object.freeze({
    file: exportFileSchema.parse({
      dataset,
      format: job.format,
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      rows: rows.length,
      sha256,
    }),
    absolutePath,
  });
}

export function materializeExport(
  db: WorldDatabase,
  location: RunLocation,
  job: ExportJob,
): ExportArtifacts {
  if (job.status !== "running") {
    throw new EngineError("CONFLICT", `export ${job.id} is not running`);
  }
  const artifacts = job.datasets.map((dataset) =>
    materializeDataset(db, location, job, dataset)
  );
  const files = Object.freeze(artifacts.map((artifact) => artifact.file));
  const manifestContent = canonicalStringify(exportManifestSchema.parse({
    schemaVersion: 1,
    exportId: job.id,
    simulationId: job.simulationId,
    runId: job.runId,
    sourceTick: job.sourceTick,
    sourceStateHash: job.sourceStateHash,
    format: job.format,
    datasets: job.datasets,
    disclaimer: job.disclaimer,
    files,
  })) + "\n";
  const manifestPath = normalizedRelativePath("exports", job.id, "manifest.json");
  const absoluteManifestPath = absoluteExportPath(dirname(location.databasePath), manifestPath);
  writeContentAddressed(absoluteManifestPath, manifestContent);
  return Object.freeze({
    files,
    manifest: exportManifestFileSchema.parse({
      path: manifestPath,
      bytes: Buffer.byteLength(manifestContent, "utf8"),
      sha256: sha256Hex(manifestContent),
    }),
    absoluteManifestPath,
  });
}

export function resolveExportArtifactPath(location: RunLocation, relativePath: string): string {
  return absoluteExportPath(dirname(location.databasePath), relativePath);
}
