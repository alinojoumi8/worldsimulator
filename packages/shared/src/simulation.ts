/** Persisted simulation and run records shared by M01, M20, and M22. */

import { z } from "zod";
import { runManifestSchema } from "./envelope";

const idSuffix = "[0-9a-z]{8}";

export const simulationIdSchema = z.string().regex(new RegExp(`^sim_${idSuffix}$`));
export const runIdSchema = z.string().regex(new RegExp(`^run_${idSuffix}$`));

export const SIMULATION_STATUSES = ["created", "active", "archived"] as const;
export const simulationStatusSchema = z.enum(SIMULATION_STATUSES);
export type SimulationStatus = z.infer<typeof simulationStatusSchema>;

export const RUN_STATUSES = [
  "created",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const idFactoryStateSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9]*$/),
  z.number().int().nonnegative().safe(),
);
export type IdFactoryState = z.infer<typeof idFactoryStateSchema>;

export const simulationSchema = z.object({
  id: simulationIdSchema,
  name: z.string().trim().min(1).max(120),
  status: simulationStatusSchema,
  scenarioVersion: z.number().int().positive().safe(),
  scenario: z.record(z.string(), z.unknown()),
  createdWall: z.string().min(1),
});
export type Simulation = z.infer<typeof simulationSchema>;

const simulationRunBaseSchema = z.object({
  id: runIdSchema,
  simulationId: simulationIdSchema,
  status: runStatusSchema,
  currentTick: z.number().int().nonnegative().safe(),
  nextEventSeq: z.number().int().nonnegative().safe(),
  endTick: z.number().int().positive().safe(),
  manifest: runManifestSchema,
  idState: idFactoryStateSchema,
  startedWall: z.string().min(1).nullable(),
  endedWall: z.string().min(1).nullable(),
});

export const simulationRunSchema = simulationRunBaseSchema.superRefine((run, ctx) => {
  if (run.id !== run.manifest.runId) {
    ctx.addIssue({ code: "custom", path: ["manifest", "runId"], message: "run IDs differ" });
  }
  if (run.simulationId !== run.manifest.simulationId) {
    ctx.addIssue({
      code: "custom",
      path: ["manifest", "simulationId"],
      message: "simulation IDs differ",
    });
  }
  if (run.currentTick > run.endTick) {
    ctx.addIssue({
      code: "custom",
      path: ["currentTick"],
      message: "current tick exceeds end tick",
    });
  }
  if (run.status === "completed" && run.currentTick !== run.endTick) {
    ctx.addIssue({
      code: "custom",
      path: ["currentTick"],
      message: "completed run must be at its end tick",
    });
  }
  if ((run.idState["evt"] ?? 0) !== run.nextEventSeq) {
    ctx.addIssue({
      code: "custom",
      path: ["idState", "evt"],
      message: "event ID checkpoint must equal next event sequence",
    });
  }

  if (run.status === "created") {
    if (run.currentTick !== 0) {
      ctx.addIssue({ code: "custom", path: ["currentTick"], message: "created run is at tick 0" });
    }
    if (run.startedWall !== null || run.endedWall !== null) {
      ctx.addIssue({ code: "custom", path: ["startedWall"], message: "created run has no timestamps" });
    }
  } else if (run.status === "running" || run.status === "paused") {
    if (run.startedWall === null || run.endedWall !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["startedWall"],
        message: "active run needs only a start timestamp",
      });
    }
  } else if (run.startedWall === null || run.endedWall === null) {
    ctx.addIssue({
      code: "custom",
      path: ["endedWall"],
      message: "terminal run needs start and end timestamps",
    });
  }
});
export type SimulationRun = z.infer<typeof simulationRunSchema>;

export const runCheckpointSchema = z
  .object({
    id: runIdSchema,
    currentTick: z.number().int().nonnegative().safe(),
    nextEventSeq: z.number().int().nonnegative().safe(),
    idState: idFactoryStateSchema,
  })
  .superRefine((checkpoint, ctx) => {
    if ((checkpoint.idState["evt"] ?? 0) !== checkpoint.nextEventSeq) {
      ctx.addIssue({
        code: "custom",
        path: ["idState", "evt"],
        message: "event ID checkpoint must equal next event sequence",
      });
    }
  });
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;
