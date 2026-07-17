/** Persisted deterministic scheduled-task queue (WS-105). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  runIdSchema,
  TYPE_NAME_PATTERN,
} from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

const TASK_ID_PATTERN = /^task_[0-9a-z]{8,}$/;

interface RunTickRow {
  current_tick: bigint;
}

interface ScheduledTaskRow {
  run_id: string;
  id: string;
  due_tick: bigint;
  task_order: bigint;
  task_ref: string;
  payload_canonical: string;
  fired_tick: bigint | null;
}

export interface ScheduleTaskInput {
  readonly id: string;
  readonly dueTick: number;
  readonly order: number;
  readonly taskRef: string;
  readonly payload: unknown;
}

export interface ScheduledTask<TPayload = unknown> {
  readonly runId: string;
  readonly id: string;
  readonly dueTick: number;
  readonly order: number;
  readonly taskRef: string;
  readonly payload: TPayload;
  readonly firedTick: number | null;
}

export interface PendingTaskQuery {
  /** Include only tasks due on or before this tick. */
  readonly throughTick?: number;
}

/**
 * Runs after the task has been marked fired but before the transaction commits.
 * Any durable effect should use the same database connection; throwing rolls
 * back every task claimed by the current `fireDue` call.
 */
export type ScheduledTaskFireHandler = (task: ScheduledTask) => void;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a positive safe integer`);
  }
}

function assertOrder(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("VALIDATION_FAILED", "task order must be a safe integer");
  }
}

function assertNonnegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a nonnegative safe integer`);
  }
}

function assertTaskId(value: string): void {
  if (!TASK_ID_PATTERN.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `invalid scheduled task ID: ${value}`);
  }
}

function assertTaskRef(value: string): void {
  if (!TYPE_NAME_PATTERN.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `invalid scheduled task reference: ${value}`);
  }
}

function canonicalPayload(value: unknown): string {
  try {
    return canonicalStringify(value);
  } catch (error) {
    throw new EngineError("VALIDATION_FAILED", "scheduled task payload is not canonicalizable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parsePayload(value: string, taskId: string): unknown {
  try {
    const parsed = canonicalParse(value);
    if (canonicalStringify(parsed) !== value) throw new Error("stored payload is not canonical");
    return parsed;
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted scheduled task ${taskId} has invalid payload`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function mapTask(row: ScheduledTaskRow): ScheduledTask {
  const dueTick = toSafeNumber(row.due_tick, "scheduled task due tick");
  const order = toSafeNumber(row.task_order, "scheduled task order");
  const firedTick = row.fired_tick === null
    ? null
    : toSafeNumber(row.fired_tick, "scheduled task fired tick");

  if (
    !runIdSchema.safeParse(row.run_id).success ||
    !TASK_ID_PATTERN.test(row.id) ||
    !Number.isSafeInteger(dueTick) ||
    dueTick < 1 ||
    !Number.isSafeInteger(order) ||
    !TYPE_NAME_PATTERN.test(row.task_ref) ||
    (firedTick !== null && (firedTick < dueTick || firedTick < 1))
  ) {
    throw new EngineError("INTERNAL", `persisted scheduled task ${row.id} is invalid`);
  }

  return deepFreeze({
    runId: row.run_id,
    id: row.id,
    dueTick,
    order,
    taskRef: row.task_ref,
    payload: parsePayload(row.payload_canonical, row.id),
    firedTick,
  });
}

/** A run-scoped scheduler backed by the run's authoritative SQLite database. */
export class SqliteScheduler {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    this.getCurrentTick();
  }

  schedule(input: ScheduleTaskInput): ScheduledTask {
    assertTaskId(input.id);
    assertPositiveSafeInteger(input.dueTick, "task due tick");
    assertOrder(input.order);
    assertTaskRef(input.taskRef);
    const payloadCanonical = canonicalPayload(input.payload);
    const currentTick = this.getCurrentTick();
    if (input.dueTick <= currentTick) {
      throw new EngineError(
        "CONFLICT",
        `cannot schedule task ${input.id} at tick ${input.dueTick}; run is at tick ${currentTick}`,
      );
    }

    const inserted = this.db.prepare(`
      INSERT INTO scheduled_tasks(
        run_id, id, due_tick, task_order, task_ref, payload_canonical, fired_tick
      ) VALUES (@runId, @id, @dueTick, @order, @taskRef, @payloadCanonical, NULL)
      ON CONFLICT(run_id, id) DO NOTHING
    `).run({
      runId: this.runId,
      id: input.id,
      dueTick: input.dueTick,
      order: input.order,
      taskRef: input.taskRef,
      payloadCanonical,
    });
    if (inserted.changes !== 1) {
      throw new EngineError("CONFLICT", `scheduled task ${input.id} already exists`);
    }
    return this.getTask(input.id);
  }

  listPending(query: PendingTaskQuery = {}): readonly ScheduledTask[] {
    this.getCurrentTick();
    if (query.throughTick !== undefined) {
      assertNonnegativeSafeInteger(query.throughTick, "pending task through tick");
    }
    const rows = query.throughTick === undefined
      ? this.db.prepare<[string], ScheduledTaskRow>(`
          SELECT run_id, id, due_tick, task_order, task_ref, payload_canonical, fired_tick
          FROM scheduled_tasks
          WHERE run_id = ? AND fired_tick IS NULL
          ORDER BY due_tick ASC, task_order ASC, id ASC
        `).all(this.runId)
      : this.db.prepare<[string, number], ScheduledTaskRow>(`
          SELECT run_id, id, due_tick, task_order, task_ref, payload_canonical, fired_tick
          FROM scheduled_tasks
          WHERE run_id = ? AND fired_tick IS NULL AND due_tick <= ?
          ORDER BY due_tick ASC, task_order ASC, id ASC
        `).all(this.runId, query.throughTick);
    return Object.freeze(rows.map(mapTask));
  }

  /**
   * Atomically marks every task due through `tick` as fired, in queue order.
   * A committed task is never returned by a later call, including after reopen.
   */
  fireDue(
    tick: number,
    handler?: ScheduledTaskFireHandler,
  ): readonly ScheduledTask[] {
    assertPositiveSafeInteger(tick, "scheduler fire tick");

    const fire = (): readonly ScheduledTask[] => {
      this.getCurrentTick();
      const rows = this.db.prepare<[string, number], ScheduledTaskRow>(`
        SELECT run_id, id, due_tick, task_order, task_ref, payload_canonical, fired_tick
        FROM scheduled_tasks
        WHERE run_id = ? AND fired_tick IS NULL AND due_tick <= ?
        ORDER BY due_tick ASC, task_order ASC, id ASC
      `).all(this.runId, tick);
      const tasks = rows.map(mapTask);
      const markFired = this.db.prepare(`
        UPDATE scheduled_tasks
        SET fired_tick = @tick
        WHERE run_id = @runId AND id = @id AND fired_tick IS NULL
      `);
      for (const task of tasks) {
        const updated = markFired.run({ runId: this.runId, id: task.id, tick });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", `scheduled task ${task.id} was claimed concurrently`);
        }
        handler?.(deepFreeze({ ...task, firedTick: tick }));
      }
      return Object.freeze(tasks.map((task) => deepFreeze({ ...task, firedTick: tick })));
    };

    // A nested better-sqlite3 transaction becomes a savepoint. Keep this
    // boundary even inside a caller transaction so catching a handler error
    // cannot commit a prefix of the task claims or their durable effects.
    return this.db.transaction(fire).immediate();
  }

  private getTask(taskId: string): ScheduledTask {
    const row = this.db.prepare<[string, string], ScheduledTaskRow>(`
      SELECT run_id, id, due_tick, task_order, task_ref, payload_canonical, fired_tick
      FROM scheduled_tasks WHERE run_id = ? AND id = ?
    `).get(this.runId, taskId);
    if (!row) throw new EngineError("NOT_FOUND", `scheduled task ${taskId} does not exist`);
    return mapTask(row);
  }

  private getCurrentTick(): number {
    const row = this.db.prepare<[string], RunTickRow>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (!row) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    return toSafeNumber(row.current_tick, "run current tick");
  }
}
