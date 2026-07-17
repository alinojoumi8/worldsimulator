/** Restart-safe durable API task journal for asynchronous run advancement. */

import { EngineError, runIdSchema } from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

const TASK_ID_PATTERN = /^task_[0-9a-z]{8,}$/;

export const API_TASK_KINDS = ["advance"] as const;
export type ApiTaskKind = (typeof API_TASK_KINDS)[number];

export const API_TASK_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type ApiTaskStatus = (typeof API_TASK_STATUSES)[number];

const API_TASK_KIND_SET = new Set<string>(API_TASK_KINDS);
const API_TASK_STATUS_SET = new Set<string>(API_TASK_STATUSES);

interface ApiTaskRow {
  id: string;
  run_id: string;
  kind: string;
  status: string;
  start_tick: bigint;
  target_tick: bigint;
  created_wall: string;
  updated_wall: string;
  error_text: string | null;
}

interface RunProgressRow {
  current_tick: bigint;
  end_tick: bigint;
}

export interface ApiTask {
  readonly id: string;
  readonly runId: string;
  readonly kind: ApiTaskKind;
  readonly status: ApiTaskStatus;
  readonly startTick: number;
  readonly targetTick: number;
  readonly createdWall: string;
  readonly updatedWall: string;
  readonly errorText: string | null;
}

export interface CreateAdvanceTaskInput {
  readonly id: string;
  readonly startTick: number;
  readonly targetTick: number;
  /** Injected informational wall time; never used for deterministic execution. */
  readonly wallTime: string;
}

function assertTaskId(value: string): void {
  if (!TASK_ID_PATTERN.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `invalid API task ID: ${value}`);
  }
}

function assertNonnegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${field} must be a nonnegative safe integer`,
    );
  }
}

function assertWallTime(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("VALIDATION_FAILED", "task wall time must be nonempty");
  }
}

function assertErrorText(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("VALIDATION_FAILED", "task error text must be nonempty");
  }
}

function mapTask(row: ApiTaskRow): ApiTask {
  const startTick = toSafeNumber(row.start_tick, "API task start tick");
  const targetTick = toSafeNumber(row.target_tick, "API task target tick");
  const failed = row.status === "failed";
  if (
    !TASK_ID_PATTERN.test(row.id) ||
    !runIdSchema.safeParse(row.run_id).success ||
    !API_TASK_KIND_SET.has(row.kind) ||
    !API_TASK_STATUS_SET.has(row.status) ||
    startTick < 0 ||
    targetTick <= startTick ||
    row.created_wall.trim().length === 0 ||
    row.updated_wall.trim().length === 0 ||
    (failed
      ? row.error_text === null || row.error_text.trim().length === 0
      : row.error_text !== null)
  ) {
    throw new EngineError("INTERNAL", `persisted API task ${row.id} is invalid`);
  }

  return Object.freeze({
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ApiTaskKind,
    status: row.status as ApiTaskStatus,
    startTick,
    targetTick,
    createdWall: row.created_wall,
    updatedWall: row.updated_wall,
    errorText: row.error_text,
  });
}

/** A run-scoped task store backed by the run's authoritative SQLite file. */
export class SqliteApiTaskStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    this.getRunProgress();
  }

  createAdvanceTask(input: CreateAdvanceTaskInput): ApiTask {
    assertTaskId(input.id);
    assertNonnegativeSafeInteger(input.startTick, "task start tick");
    assertNonnegativeSafeInteger(input.targetTick, "task target tick");
    assertWallTime(input.wallTime);
    if (input.targetTick <= input.startTick) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "task target tick must be greater than its start tick",
      );
    }

    const create = (): ApiTask => {
      const progress = this.getRunProgress();
      if (input.startTick !== progress.currentTick) {
        throw new EngineError(
          "CONFLICT",
          `advance task starts at tick ${input.startTick}, but run is at tick ${progress.currentTick}`,
        );
      }
      if (input.targetTick > progress.endTick) {
        throw new EngineError(
          "CONFLICT",
          `advance task target ${input.targetTick} exceeds run end tick ${progress.endTick}`,
        );
      }

      const inserted = this.db.prepare(`
        INSERT INTO api_tasks(
          id, run_id, kind, status, start_tick, target_tick,
          created_wall, updated_wall, error_text
        ) VALUES (
          @id, @runId, 'advance', 'pending', @startTick, @targetTick,
          @wallTime, @wallTime, NULL
        )
        ON CONFLICT DO NOTHING
      `).run({
        id: input.id,
        runId: this.runId,
        startTick: input.startTick,
        targetTick: input.targetTick,
        wallTime: input.wallTime,
      });
      if (inserted.changes !== 1) {
        throw new EngineError(
          "CONFLICT",
          `API task ${input.id} already exists or run ${this.runId} has an active task`,
        );
      }
      return this.get(input.id);
    };

    return this.db.inTransaction ? create() : this.db.transaction(create).immediate();
  }

  get(taskId: string): ApiTask {
    assertTaskId(taskId);
    const row = this.db.prepare<[string, string], ApiTaskRow>(`
      SELECT
        id, run_id, kind, status, start_tick, target_tick,
        created_wall, updated_wall, error_text
      FROM api_tasks
      WHERE run_id = ? AND id = ?
    `).get(this.runId, taskId);
    if (!row) throw new EngineError("NOT_FOUND", `API task ${taskId} does not exist`);
    return mapTask(row);
  }

  list(): readonly ApiTask[] {
    const rows = this.db.prepare<[string], ApiTaskRow>(`
      SELECT
        id, run_id, kind, status, start_tick, target_tick,
        created_wall, updated_wall, error_text
      FROM api_tasks
      WHERE run_id = ?
      ORDER BY created_wall ASC, id ASC
    `).all(this.runId);
    return Object.freeze(rows.map(mapTask));
  }

  listActive(): readonly ApiTask[] {
    const rows = this.db.prepare<[string], ApiTaskRow>(`
      SELECT
        id, run_id, kind, status, start_tick, target_tick,
        created_wall, updated_wall, error_text
      FROM api_tasks
      WHERE run_id = ? AND status IN ('pending', 'running')
      ORDER BY created_wall ASC, id ASC
    `).all(this.runId);
    return Object.freeze(rows.map(mapTask));
  }

  getActive(): ApiTask | null {
    return this.listActive()[0] ?? null;
  }

  getLatest(): ApiTask | null {
    const row = this.db.prepare<[string], ApiTaskRow>(`
      SELECT
        id, run_id, kind, status, start_tick, target_tick,
        created_wall, updated_wall, error_text
      FROM api_tasks
      WHERE run_id = ?
      ORDER BY created_wall DESC, id DESC
      LIMIT 1
    `).get(this.runId);
    return row ? mapTask(row) : null;
  }

  markRunning(taskId: string, wallTime: string): ApiTask {
    assertTaskId(taskId);
    assertWallTime(wallTime);
    return this.transition(() => {
      const updated = this.db.prepare(`
        UPDATE api_tasks
        SET status = 'running', updated_wall = @wallTime
        WHERE run_id = @runId AND id = @taskId AND status = 'pending'
      `).run({ runId: this.runId, taskId, wallTime });
      if (updated.changes !== 1) this.throwStaleTransition(taskId, "running");
      return this.get(taskId);
    });
  }

  markCompleted(taskId: string, wallTime: string): ApiTask {
    assertTaskId(taskId);
    assertWallTime(wallTime);
    return this.transition(() => {
      const updated = this.db.prepare(`
        UPDATE api_tasks
        SET status = 'completed', updated_wall = @wallTime
        WHERE run_id = @runId
          AND id = @taskId
          AND status = 'running'
          AND target_tick = (
            SELECT current_tick FROM simulation_runs WHERE id = @runId
          )
      `).run({ runId: this.runId, taskId, wallTime });
      if (updated.changes !== 1) this.throwStaleTransition(taskId, "completed");
      return this.get(taskId);
    });
  }

  markFailed(taskId: string, wallTime: string, errorText: string): ApiTask {
    assertTaskId(taskId);
    assertWallTime(wallTime);
    assertErrorText(errorText);
    return this.transition(() => {
      const updated = this.db.prepare(`
        UPDATE api_tasks
        SET status = 'failed', updated_wall = @wallTime, error_text = @errorText
        WHERE run_id = @runId
          AND id = @taskId
          AND status IN ('pending', 'running')
      `).run({ runId: this.runId, taskId, wallTime, errorText });
      if (updated.changes !== 1) this.throwStaleTransition(taskId, "failed");
      return this.get(taskId);
    });
  }

  private transition<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }

  private throwStaleTransition(taskId: string, requestedStatus: ApiTaskStatus): never {
    const task = this.get(taskId);
    const progress = this.getRunProgress();
    throw new EngineError(
      "CONFLICT",
      `cannot transition API task ${taskId} from ${task.status} to ${requestedStatus}`,
      {
        currentTick: progress.currentTick,
        targetTick: task.targetTick,
      },
    );
  }

  private getRunProgress(): { readonly currentTick: number; readonly endTick: number } {
    const row = this.db.prepare<[string], RunProgressRow>(`
      SELECT current_tick, end_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (!row) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    return Object.freeze({
      currentTick: toSafeNumber(row.current_tick, "run current tick"),
      endTick: toSafeNumber(row.end_tick, "run end tick"),
    });
  }
}
