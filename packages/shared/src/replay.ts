/** Deterministic run replay contracts (WS-705). */

import { z } from "zod";
import { runIdSchema, simulationIdSchema } from "./simulation";

const stateHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const REPLAY_MODES = ["strict", "observe"] as const;
export const replayModeSchema = z.enum(REPLAY_MODES);
export type ReplayMode = z.infer<typeof replayModeSchema>;

export const REPLAY_STATUSES = [
  "running",
  "completed",
  "diverged",
  "failed",
] as const;
export const replayStatusSchema = z.enum(REPLAY_STATUSES);
export type ReplayStatus = z.infer<typeof replayStatusSchema>;

export const REPLAY_DIVERGENCE_KINDS = [
  "cache_incomplete",
  "event_mismatch",
  "state_hash_mismatch",
  "unsupported_journal_command",
] as const;
export const replayDivergenceKindSchema = z.enum(REPLAY_DIVERGENCE_KINDS);
export type ReplayDivergenceKind = z.infer<typeof replayDivergenceKindSchema>;

export const replayRequestSchema = z.object({
  toTick: z.number().int().nonnegative().safe().optional(),
  mode: replayModeSchema.default("strict"),
}).strict();
export type ReplayRequest = z.infer<typeof replayRequestSchema>;

export const replayPathSchema = z.object({
  simId: simulationIdSchema,
  runId: runIdSchema,
}).strict();

export const replayDivergenceSchema = z.object({
  sequence: z.number().int().positive().safe(),
  tick: z.number().int().nonnegative().safe(),
  kind: replayDivergenceKindSchema,
  expectedHash: stateHashSchema.nullable(),
  actualHash: stateHashSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
}).strict();
export type ReplayDivergence = z.infer<typeof replayDivergenceSchema>;

export const replayRunSchema = z.object({
  id: runIdSchema,
  replayOf: runIdSchema,
  sourceSimulationId: simulationIdSchema,
  mode: replayModeSchema,
  toTick: z.number().int().nonnegative().safe(),
  status: replayStatusSchema,
  currentTick: z.number().int().nonnegative().safe(),
  lastComparedSeq: z.number().int().min(-1).safe(),
  divergenceCount: z.number().int().nonnegative().safe(),
  firstDivergence: replayDivergenceSchema.nullable(),
  sourceStateHash: stateHashSchema.nullable(),
  replayStateHash: stateHashSchema.nullable(),
  cacheArtifactDigest: stateHashSchema,
  journalDigest: stateHashSchema,
  startedWall: z.string().min(1),
  completedWall: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
}).strict().superRefine((replay, ctx) => {
  if (replay.currentTick > replay.toTick) {
    ctx.addIssue({
      code: "custom",
      path: ["currentTick"],
      message: "replay current tick exceeds target tick",
    });
  }
  if ((replay.divergenceCount === 0) !== (replay.firstDivergence === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["firstDivergence"],
      message: "replay divergence summary is inconsistent",
    });
  }
  const terminal = replay.status !== "running";
  if (terminal !== (replay.completedWall !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["completedWall"],
      message: "terminal replay status and completion time must agree",
    });
  }
  const failed = replay.status === "failed";
  if (failed !== (replay.errorCode !== null && replay.errorMessage !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "failed replay status requires an error code and message",
    });
  }
});
export type ReplayRun = z.infer<typeof replayRunSchema>;
