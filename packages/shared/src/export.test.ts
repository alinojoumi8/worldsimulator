import { describe, expect, it } from "vitest";
import {
  createExportRequestSchema,
  EXPORT_DISCLAIMER,
  exportJobSchema,
  exportManifestSchema,
} from "./export";

const exportId = "xpt_0000000100000001";
const stateHash = "a".repeat(64);

function auditEvent(
  sequence: number,
  type: "export.job.queued" | "export.job.started" | "export.job.completed",
  causationId: string | null,
) {
  return {
    id: `xev_0000000100000001${sequence.toString().padStart(8, "0")}`,
    sequence,
    schemaVersion: 1 as const,
    type,
    tick: 4,
    actor: sequence === 1
      ? { kind: "admin" as const, id: "api" }
      : { kind: "system" as const, id: "export_worker" },
    correlationId: "request-1",
    causationId,
    evidence: {},
    wallTime: `T${sequence}`,
  };
}

const queuedEvent = auditEvent(1, "export.job.queued", null);
const startedEvent = auditEvent(2, "export.job.started", queuedEvent.id);
const completedEvent = auditEvent(3, "export.job.completed", startedEvent.id);
const eventFile = {
  dataset: "events" as const,
  format: "jsonl" as const,
  path: `exports/${exportId}/events-${"b".repeat(64)}.jsonl`,
  bytes: 12,
  rows: 1,
  sha256: "b".repeat(64),
};

describe("export contracts", () => {
  it("accepts bounded requests and rejects duplicate datasets", () => {
    expect(createExportRequestSchema.parse({
      runId: "run_00000001",
      datasets: ["events", "indicators"],
      format: "csv",
    })).toEqual({
      runId: "run_00000001",
      datasets: ["events", "indicators"],
      format: "csv",
    });
    expect(createExportRequestSchema.safeParse({
      runId: "run_00000001",
      datasets: ["events", "events"],
      format: "jsonl",
    }).success).toBe(false);
  });

  it("requires terminal files, paths, and audit events to agree", () => {
    const completed = {
      id: exportId,
      simulationId: "sim_00000001",
      runId: "run_00000001",
      format: "jsonl" as const,
      datasets: ["events" as const],
      status: "completed" as const,
      sourceTick: 4,
      sourceStateHash: stateHash,
      disclaimer: EXPORT_DISCLAIMER,
      files: [eventFile],
      manifest: {
        path: `exports/${exportId}/manifest.json`,
        bytes: 100,
        sha256: "c".repeat(64),
      },
      auditEvents: [queuedEvent, startedEvent, completedEvent],
      createdWall: "T1",
      startedWall: "T2",
      completedWall: "T3",
      errorCode: null,
      errorMessage: null,
    };
    expect(exportJobSchema.parse(completed)).toEqual(completed);
    expect(exportJobSchema.safeParse({
      ...completed,
      auditEvents: [queuedEvent, { ...startedEvent, causationId: null }, completedEvent],
    }).success).toBe(false);
    expect(exportJobSchema.safeParse({
      ...completed,
      files: [{ ...eventFile, path: `exports/${exportId}/events.jsonl` }],
    }).success).toBe(false);
  });

  it("binds manifest rows to the declared dataset checksums", () => {
    const manifest = {
      schemaVersion: 1 as const,
      exportId,
      simulationId: "sim_00000001",
      runId: "run_00000001",
      sourceTick: 4,
      sourceStateHash: stateHash,
      format: "jsonl" as const,
      datasets: ["events" as const],
      disclaimer: EXPORT_DISCLAIMER,
      files: [eventFile],
    };
    expect(exportManifestSchema.parse(manifest)).toEqual(manifest);
    expect(exportManifestSchema.safeParse({
      ...manifest,
      files: [{ ...eventFile, sha256: "d".repeat(64) }],
    }).success).toBe(false);
  });
});
