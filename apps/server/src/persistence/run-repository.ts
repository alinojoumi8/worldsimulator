/** Restart-safe Simulation and SimulationRun persistence (WS-104). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  idFactoryStateSchema,
  runIdSchema,
  runStatusSchema,
  simulationIdSchema,
  simulationRunSchema,
  simulationSchema,
  simulationStatusSchema,
} from "@worldtangle/shared";
import type {
  IdFactoryState,
  RunStatus,
  Simulation,
  SimulationRun,
  SimulationStatus,
} from "@worldtangle/shared";
import {
  isTerminalRunStatus,
  RUN_COMMANDS,
  transitionRunStatus,
} from "@worldtangle/engine";
import type { RunCommand } from "@worldtangle/engine";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

interface SimulationRow {
  id: string;
  name: string;
  status: SimulationStatus;
  scenario_version: bigint;
  scenario_canonical: string;
  created_wall: string;
}

interface SimulationRunRow {
  id: string;
  simulation_id: string;
  status: RunStatus;
  current_tick: bigint;
  next_event_seq: bigint;
  end_tick: bigint;
  manifest_canonical: string;
  id_state_canonical: string;
  started_wall: string | null;
  ended_wall: string | null;
}

interface TransitionCheckpointRow {
  status: RunStatus;
  current_tick: bigint;
  next_event_seq: bigint;
}

export interface SimulationListQuery {
  readonly status?: SimulationStatus;
}

export interface RunListQuery {
  readonly status?: RunStatus;
}

export interface CreatedSimulationRun {
  readonly simulation: Simulation;
  readonly run: SimulationRun;
}

export interface CreateSimulationRunContext {
  readonly simulation: Simulation;
  readonly run: SimulationRun;
}

/** Optional creation journal, invoked after both rows exist but before commit. */
export type CreateSimulationRunJournalHook = (
  context: CreateSimulationRunContext,
) => IdFactoryState;

export interface TransitionRunInput {
  readonly runId: string;
  readonly command: RunCommand;
  /** Injected informational wall time; never used for deterministic ordering. */
  readonly wallTime: string;
  /** Optional caller checkpoint. The SQL update always guards the stored status. */
  readonly expectedStatus?: RunStatus;
}

export interface RunTransitionContext {
  readonly current: SimulationRun;
  readonly command: RunCommand;
  readonly nextStatus: RunStatus;
  readonly wallTime: string;
}

/**
 * Called inside the lifecycle transaction, before the status update. The hook
 * must append at least one event and return the post-journal ID checkpoint.
 */
export type RunTransitionJournalHook = (
  context: RunTransitionContext,
) => IdFactoryState;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseCanonicalField(text: string, field: string): unknown {
  try {
    const value = canonicalParse(text);
    if (canonicalStringify(value) !== text) {
      throw new Error("stored value is not canonical");
    }
    return value;
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${field} is invalid`, {
      field,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function mapSimulation(row: SimulationRow): Simulation {
  const parsed = simulationSchema.safeParse({
    id: row.id,
    name: row.name,
    status: row.status,
    scenarioVersion: toSafeNumber(row.scenario_version, "simulation scenario version"),
    scenario: parseCanonicalField(row.scenario_canonical, "simulation scenario"),
    createdWall: row.created_wall,
  });
  if (!parsed.success) {
    throw new EngineError("INTERNAL", `persisted simulation ${row.id} is invalid`, {
      issues: parsed.error.issues,
    });
  }
  return deepFreeze(parsed.data);
}

function mapRun(row: SimulationRunRow): SimulationRun {
  const parsed = simulationRunSchema.safeParse({
    id: row.id,
    simulationId: row.simulation_id,
    status: row.status,
    currentTick: toSafeNumber(row.current_tick, "run current tick"),
    nextEventSeq: toSafeNumber(row.next_event_seq, "run next event sequence"),
    endTick: toSafeNumber(row.end_tick, "run end tick"),
    manifest: parseCanonicalField(row.manifest_canonical, "run manifest"),
    idState: parseCanonicalField(row.id_state_canonical, "run ID checkpoint"),
    startedWall: row.started_wall,
    endedWall: row.ended_wall,
  });
  if (!parsed.success) {
    throw new EngineError("INTERNAL", `persisted run ${row.id} is invalid`, {
      issues: parsed.error.issues,
    });
  }
  return deepFreeze(parsed.data);
}

function validateSimulation(value: Simulation): Simulation {
  const parsed = simulationSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError("VALIDATION_FAILED", "simulation is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function validateRun(value: SimulationRun): SimulationRun {
  const parsed = simulationRunSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError("VALIDATION_FAILED", "simulation run is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function validateTransitionCandidate(value: SimulationRun): void {
  const parsed = simulationRunSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError("CONFLICT", "run transition violates persisted invariants", {
      issues: parsed.error.issues,
    });
  }
}

function assertSimulationId(value: string): void {
  if (!simulationIdSchema.safeParse(value).success) {
    throw new EngineError("VALIDATION_FAILED", `invalid simulation ID: ${value}`);
  }
}

function assertRunId(value: string): void {
  if (!runIdSchema.safeParse(value).success) {
    throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${value}`);
  }
}

export class SqliteRunRepository {
  constructor(private readonly db: WorldDatabase) {}

  createSimulationWithRun(
    simulationInput: Simulation,
    runInput: SimulationRun,
    journal?: CreateSimulationRunJournalHook,
  ): CreatedSimulationRun {
    const simulation = validateSimulation(simulationInput);
    const run = validateRun(runInput);
    if (run.simulationId !== simulation.id) {
      throw new EngineError("VALIDATION_FAILED", "run belongs to a different simulation");
    }

    return this.db.transaction(() => {
      const insertedSimulation = this.db.prepare(`
        INSERT INTO simulations(
          id, name, status, scenario_version, scenario_canonical, created_wall
        ) VALUES (@id, @name, @status, @scenarioVersion, @scenarioCanonical, @createdWall)
        ON CONFLICT(id) DO NOTHING
      `).run({
        id: simulation.id,
        name: simulation.name,
        status: simulation.status,
        scenarioVersion: simulation.scenarioVersion,
        scenarioCanonical: canonicalStringify(simulation.scenario),
        createdWall: simulation.createdWall,
      });
      if (insertedSimulation.changes !== 1) {
        throw new EngineError("CONFLICT", `simulation ${simulation.id} already exists`);
      }

      const insertedRun = this.db.prepare(`
        INSERT INTO simulation_runs(
          id, simulation_id, status, current_tick, next_event_seq, end_tick,
          manifest_canonical, id_state_canonical, started_wall, ended_wall
        ) VALUES (
          @id, @simulationId, @status, @currentTick, @nextEventSeq, @endTick,
          @manifestCanonical, @idStateCanonical, @startedWall, @endedWall
        )
        ON CONFLICT(id) DO NOTHING
      `).run({
        id: run.id,
        simulationId: run.simulationId,
        status: run.status,
        currentTick: run.currentTick,
        nextEventSeq: run.nextEventSeq,
        endTick: run.endTick,
        manifestCanonical: canonicalStringify(run.manifest),
        idStateCanonical: canonicalStringify(run.idState),
        startedWall: run.startedWall,
        endedWall: run.endedWall,
      });
      if (insertedRun.changes !== 1) {
        throw new EngineError("CONFLICT", `run ${run.id} already exists`);
      }

      let createdRun = this.getRun(run.id);
      if (journal !== undefined) {
        const idStateResult = idFactoryStateSchema.safeParse(
          journal(Object.freeze({ simulation: this.getSimulation(simulation.id), run: createdRun })),
        );
        if (!idStateResult.success) {
          throw new EngineError("CONFLICT", "creation journal returned an invalid ID checkpoint", {
            issues: idStateResult.error.issues,
          });
        }
        const checkpoint = this.db.prepare<[string], TransitionCheckpointRow>(`
          SELECT status, current_tick, next_event_seq FROM simulation_runs WHERE id = ?
        `).get(run.id);
        if (!checkpoint) throw new EngineError("NOT_FOUND", `run ${run.id} does not exist`);
        const postJournalSeq = toSafeNumber(
          checkpoint.next_event_seq,
          "post-creation next event sequence",
        );
        if (postJournalSeq <= createdRun.nextEventSeq) {
          throw new EngineError("CONFLICT", "simulation creation was not journaled");
        }
        if ((idStateResult.data["evt"] ?? 0) !== postJournalSeq) {
          throw new EngineError("CONFLICT", "creation journal and ID checkpoints do not agree");
        }
        const updated = this.db.prepare(`
          UPDATE simulation_runs
          SET id_state_canonical = @idStateCanonical
          WHERE id = @runId
            AND status = @status
            AND current_tick = @currentTick
            AND next_event_seq = @nextEventSeq
        `).run({
          runId: run.id,
          status: createdRun.status,
          currentTick: createdRun.currentTick,
          nextEventSeq: postJournalSeq,
          idStateCanonical: canonicalStringify(idStateResult.data),
        });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", "stale simulation creation checkpoint");
        }
        createdRun = this.getRun(run.id);
      }

      return Object.freeze({
        simulation: this.getSimulation(simulation.id),
        run: createdRun,
      });
    }).immediate();
  }

  getSimulation(simulationId: string): Simulation {
    assertSimulationId(simulationId);
    const row = this.db.prepare<[string], SimulationRow>(`
      SELECT id, name, status, scenario_version, scenario_canonical, created_wall
      FROM simulations WHERE id = ?
    `).get(simulationId);
    if (!row) throw new EngineError("NOT_FOUND", `simulation ${simulationId} does not exist`);
    return mapSimulation(row);
  }

  listSimulations(query: SimulationListQuery = {}): readonly Simulation[] {
    if (query.status !== undefined && !simulationStatusSchema.safeParse(query.status).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid simulation status: ${query.status}`);
    }
    const rows = query.status === undefined
      ? this.db.prepare<[], SimulationRow>(`
          SELECT id, name, status, scenario_version, scenario_canonical, created_wall
          FROM simulations ORDER BY created_wall DESC, id DESC
        `).all()
      : this.db.prepare<[SimulationStatus], SimulationRow>(`
          SELECT id, name, status, scenario_version, scenario_canonical, created_wall
          FROM simulations WHERE status = ? ORDER BY created_wall DESC, id DESC
        `).all(query.status);
    return Object.freeze(rows.map(mapSimulation));
  }

  getRun(runId: string): SimulationRun {
    assertRunId(runId);
    const row = this.db.prepare<[string], SimulationRunRow>(`
      SELECT id, simulation_id, status, current_tick, next_event_seq, end_tick,
             manifest_canonical, id_state_canonical, started_wall, ended_wall
      FROM simulation_runs WHERE id = ?
    `).get(runId);
    if (!row) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
    return mapRun(row);
  }

  listRuns(simulationId: string, query: RunListQuery = {}): readonly SimulationRun[] {
    assertSimulationId(simulationId);
    if (query.status !== undefined && !runStatusSchema.safeParse(query.status).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run status: ${query.status}`);
    }
    const rows = query.status === undefined
      ? this.db.prepare<[string], SimulationRunRow>(`
          SELECT id, simulation_id, status, current_tick, next_event_seq, end_tick,
                 manifest_canonical, id_state_canonical, started_wall, ended_wall
          FROM simulation_runs WHERE simulation_id = ? ORDER BY id ASC
        `).all(simulationId)
      : this.db.prepare<[string, RunStatus], SimulationRunRow>(`
          SELECT id, simulation_id, status, current_tick, next_event_seq, end_tick,
                 manifest_canonical, id_state_canonical, started_wall, ended_wall
          FROM simulation_runs
          WHERE simulation_id = ? AND status = ? ORDER BY id ASC
        `).all(simulationId, query.status);
    return Object.freeze(rows.map(mapRun));
  }

  transitionRun(
    input: TransitionRunInput,
    journal: RunTransitionJournalHook,
  ): SimulationRun {
    assertRunId(input.runId);
    if (!(RUN_COMMANDS as readonly string[]).includes(input.command)) {
      throw new EngineError("VALIDATION_FAILED", `invalid run command: ${input.command}`);
    }
    if (typeof input.wallTime !== "string" || input.wallTime.length === 0) {
      throw new EngineError("VALIDATION_FAILED", "run transition wall time is required");
    }
    if (
      input.expectedStatus !== undefined &&
      !runStatusSchema.safeParse(input.expectedStatus).success
    ) {
      throw new EngineError("VALIDATION_FAILED", `invalid expected status: ${input.expectedStatus}`);
    }

    return this.db.transaction(() => {
      const current = this.getRun(input.runId);
      if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
        throw new EngineError("CONFLICT", "stale run status checkpoint", {
          expected: input.expectedStatus,
          actual: current.status,
        });
      }

      const nextStatus = transitionRunStatus(current.status, input.command);
      const startedWall = input.command === "start" ? input.wallTime : current.startedWall;
      const endedWall = isTerminalRunStatus(nextStatus) ? input.wallTime : current.endedWall;
      validateTransitionCandidate({
        ...current,
        status: nextStatus,
        startedWall,
        endedWall,
      });

      const context = Object.freeze({
        current,
        command: input.command,
        nextStatus,
        wallTime: input.wallTime,
      });
      const idStateResult = idFactoryStateSchema.safeParse(journal(context));
      if (!idStateResult.success) {
        throw new EngineError("CONFLICT", "journal returned an invalid ID checkpoint", {
          issues: idStateResult.error.issues,
        });
      }

      const checkpoint = this.db.prepare<[string], TransitionCheckpointRow>(`
        SELECT status, current_tick, next_event_seq FROM simulation_runs WHERE id = ?
      `).get(input.runId);
      if (!checkpoint) throw new EngineError("NOT_FOUND", `run ${input.runId} does not exist`);
      const postJournalSeq = toSafeNumber(
        checkpoint.next_event_seq,
        "post-journal next event sequence",
      );
      if (postJournalSeq <= current.nextEventSeq) {
        throw new EngineError("CONFLICT", "run lifecycle transition was not journaled");
      }
      if ((idStateResult.data["evt"] ?? 0) !== postJournalSeq) {
        throw new EngineError("CONFLICT", "journal event and ID checkpoints do not agree", {
          nextEventSeq: postJournalSeq,
          eventIdCheckpoint: idStateResult.data["evt"] ?? 0,
        });
      }

      const next: SimulationRun = {
        ...current,
        status: nextStatus,
        nextEventSeq: postJournalSeq,
        idState: idStateResult.data,
        startedWall,
        endedWall,
      };
      validateTransitionCandidate(next);

      const updated = this.db.prepare(`
        UPDATE simulation_runs
        SET status = @nextStatus,
            id_state_canonical = @idStateCanonical,
            started_wall = @startedWall,
            ended_wall = @endedWall
        WHERE id = @runId
          AND status = @currentStatus
          AND current_tick = @currentTick
          AND next_event_seq = @nextEventSeq
      `).run({
        runId: input.runId,
        currentStatus: current.status,
        currentTick: current.currentTick,
        nextEventSeq: postJournalSeq,
        nextStatus,
        idStateCanonical: canonicalStringify(idStateResult.data),
        startedWall,
        endedWall,
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", "stale run lifecycle checkpoint");
      }
      return this.getRun(input.runId);
    }).immediate();
  }
}
