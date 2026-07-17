/** Checksummed simulation export contracts (WS-706). */

import { z } from "zod";
import { actorRefSchema } from "./envelope";
import { runIdSchema, simulationIdSchema } from "./simulation";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const relativeExportPathSchema = z.string().regex(
  /^exports\/xpt_[0-9a-z]{16}\/[^/]+$/,
);

export const EXPORT_DISCLAIMER =
  "Simulated scenario data - not a prediction and not financial, legal, or political advice.";

export const EXPORT_DATASETS = ["events", "transactions", "indicators"] as const;
export const exportDatasetSchema = z.enum(EXPORT_DATASETS);
export type ExportDataset = z.infer<typeof exportDatasetSchema>;

export const EXPORT_FORMATS = ["jsonl", "csv"] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const EXPORT_STATUSES = ["queued", "running", "completed", "failed"] as const;
export const exportStatusSchema = z.enum(EXPORT_STATUSES);
export type ExportStatus = z.infer<typeof exportStatusSchema>;

export const EXPORT_EVENT_TYPES = [
  "export.job.queued",
  "export.job.started",
  "export.job.completed",
  "export.job.failed",
] as const;
export const exportEventTypeSchema = z.enum(EXPORT_EVENT_TYPES);

export const exportIdSchema = z.string().regex(/^xpt_[0-9a-z]{16}$/);

export const createExportRequestSchema = z.object({
  runId: runIdSchema,
  datasets: z.array(exportDatasetSchema).min(1).max(EXPORT_DATASETS.length),
  format: exportFormatSchema,
}).strict().superRefine((request, ctx) => {
  if (new Set(request.datasets).size !== request.datasets.length) {
    ctx.addIssue({
      code: "custom",
      path: ["datasets"],
      message: "export datasets must be unique",
    });
  }
});
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportPathSchema = z.object({ exportId: exportIdSchema }).strict();

export const exportFileSchema = z.object({
  dataset: exportDatasetSchema,
  format: exportFormatSchema,
  path: relativeExportPathSchema,
  bytes: z.number().int().nonnegative().safe(),
  rows: z.number().int().nonnegative().safe(),
  sha256: sha256Schema,
}).strict();
export type ExportFile = z.infer<typeof exportFileSchema>;

export const exportManifestFileSchema = z.object({
  path: relativeExportPathSchema,
  bytes: z.number().int().positive().safe(),
  sha256: sha256Schema,
}).strict();
export type ExportManifestFile = z.infer<typeof exportManifestFileSchema>;

export const exportAuditEventSchema = z.object({
  id: z.string().regex(/^xev_[0-9a-z]{24}$/),
  sequence: z.number().int().positive().safe(),
  schemaVersion: z.literal(1),
  type: exportEventTypeSchema,
  tick: z.number().int().nonnegative().safe(),
  actor: actorRefSchema,
  correlationId: z.string().min(1),
  causationId: z.string().min(1).nullable(),
  evidence: z.record(z.string(), z.unknown()),
  wallTime: z.string().min(1),
}).strict();
export type ExportAuditEvent = z.infer<typeof exportAuditEventSchema>;

export const exportJobSchema = z.object({
  id: exportIdSchema,
  simulationId: simulationIdSchema,
  runId: runIdSchema,
  format: exportFormatSchema,
  datasets: z.array(exportDatasetSchema).min(1).max(EXPORT_DATASETS.length),
  status: exportStatusSchema,
  sourceTick: z.number().int().nonnegative().safe(),
  sourceStateHash: sha256Schema,
  disclaimer: z.literal(EXPORT_DISCLAIMER),
  files: z.array(exportFileSchema),
  manifest: exportManifestFileSchema.nullable(),
  auditEvents: z.array(exportAuditEventSchema).min(1).max(3),
  createdWall: z.string().min(1),
  startedWall: z.string().min(1).nullable(),
  completedWall: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
}).strict().superRefine((job, ctx) => {
  if (new Set(job.datasets).size !== job.datasets.length) {
    ctx.addIssue({ code: "custom", path: ["datasets"], message: "datasets must be unique" });
  }
  const terminal = job.status === "completed" || job.status === "failed";
  if (terminal !== (job.completedWall !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["completedWall"],
      message: "terminal export status and completion time must agree",
    });
  }
  const failed = job.status === "failed";
  if (failed !== (job.errorCode !== null && job.errorMessage !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "failed exports require an error code and message",
    });
  }
  const completed = job.status === "completed";
  if (completed !== (job.manifest !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["manifest"],
      message: "completed exports require a manifest",
    });
  }
  if (completed && job.files.length !== job.datasets.length) {
    ctx.addIssue({
      code: "custom",
      path: ["files"],
      message: "completed exports require exactly one file per dataset",
    });
  }
  if (!completed && job.files.length !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["files"],
      message: "non-completed exports cannot expose files",
    });
  }
  const started = job.status === "running" || job.status === "completed" ||
    (job.status === "failed" && job.auditEvents.some((event) => event.type === "export.job.started"));
  if (started !== (job.startedWall !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["startedWall"],
      message: "started export state and start time must agree",
    });
  }
  const expectedLastEvent = {
    queued: "export.job.queued",
    running: "export.job.started",
    completed: "export.job.completed",
    failed: "export.job.failed",
  }[job.status];
  if (job.auditEvents.at(-1)?.type !== expectedLastEvent) {
    ctx.addIssue({
      code: "custom",
      path: ["auditEvents"],
      message: "the final audit event must agree with export status",
    });
  }
  for (const [index, event] of job.auditEvents.entries()) {
    const previous = job.auditEvents[index - 1];
    if (
      event.sequence !== index + 1 ||
      event.tick !== job.sourceTick ||
      event.causationId !== (previous?.id ?? null) ||
      (previous !== undefined && event.correlationId !== previous.correlationId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["auditEvents", index],
        message: "export audit events must form one ordered causal chain",
      });
    }
  }
  const remainingFileDatasets = new Set(job.datasets);
  for (const [index, file] of job.files.entries()) {
    const expectedPath = `exports/${job.id}/${file.dataset}-${file.sha256}.${file.format}`;
    if (
      file.path !== expectedPath ||
      file.format !== job.format ||
      !remainingFileDatasets.delete(file.dataset)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "export file path must be content-addressed and use the job format",
      });
    }
  }
  if (completed && remainingFileDatasets.size !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["files"],
      message: "completed export files must exactly match requested datasets",
    });
  }
  if (job.manifest !== null && job.manifest.path !== `exports/${job.id}/manifest.json`) {
    ctx.addIssue({
      code: "custom",
      path: ["manifest", "path"],
      message: "export manifest path must belong to the job",
    });
  }
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const exportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  exportId: exportIdSchema,
  simulationId: simulationIdSchema,
  runId: runIdSchema,
  sourceTick: z.number().int().nonnegative().safe(),
  sourceStateHash: sha256Schema,
  format: exportFormatSchema,
  datasets: z.array(exportDatasetSchema).min(1).max(EXPORT_DATASETS.length),
  disclaimer: z.literal(EXPORT_DISCLAIMER),
  files: z.array(exportFileSchema).min(1).max(EXPORT_DATASETS.length),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.datasets).size !== manifest.datasets.length) {
    ctx.addIssue({ code: "custom", path: ["datasets"], message: "datasets must be unique" });
  }
  const remaining = new Set(manifest.datasets);
  for (const [index, file] of manifest.files.entries()) {
    const expectedPath =
      `exports/${manifest.exportId}/${file.dataset}-${file.sha256}.${manifest.format}`;
    if (
      file.format !== manifest.format ||
      file.path !== expectedPath ||
      !remaining.delete(file.dataset)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index],
        message: "manifest files must exactly match its datasets, format, and checksums",
      });
    }
  }
  if (manifest.files.length !== manifest.datasets.length || remaining.size !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["files"],
      message: "manifest requires exactly one file for every dataset",
    });
  }
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;
