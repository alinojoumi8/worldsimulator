/** Obligations-phase adapter for the persisted deterministic task queue (WS-105). */

import { EngineError, TYPE_NAME_PATTERN } from "@worldtangle/shared";
import type { PhaseHandler, TickContext } from "@worldtangle/engine";
import type { ScheduledTask, SqliteScheduler } from "./persistence";

export interface ScheduledTaskDispatcher {
  dispatch(task: ScheduledTask, ctx: TickContext): void;
}

export type ScheduledTaskHandler = (task: ScheduledTask, ctx: TickContext) => void;

/** Explicit registry: an unrecognized durable task is an error, never a no-op. */
export class RegisteredScheduledTaskDispatcher implements ScheduledTaskDispatcher {
  private readonly handlers = new Map<string, ScheduledTaskHandler>();

  constructor(handlers: readonly (readonly [string, ScheduledTaskHandler])[] = []) {
    for (const [taskRef, handler] of handlers) this.register(taskRef, handler);
  }

  register(taskRef: string, handler: ScheduledTaskHandler): void {
    if (!TYPE_NAME_PATTERN.test(taskRef)) {
      throw new EngineError("VALIDATION_FAILED", `invalid scheduled task reference: ${taskRef}`);
    }
    if (this.handlers.has(taskRef)) {
      throw new EngineError(
        "CONFLICT",
        `scheduled task handler ${taskRef} is already registered`,
      );
    }
    this.handlers.set(taskRef, handler);
  }

  dispatch(task: ScheduledTask, ctx: TickContext): void {
    const handler = this.handlers.get(task.taskRef);
    if (handler === undefined) {
      throw new EngineError(
        "INTERNAL",
        `no handler registered for scheduled task reference ${task.taskRef}`,
        { taskId: task.id, taskRef: task.taskRef },
      );
    }
    handler(task, ctx);
  }
}

export function createSchedulerPhaseHandler(
  scheduler: SqliteScheduler,
  dispatcher: ScheduledTaskDispatcher,
): PhaseHandler {
  return {
    module: "M01-scheduler",
    order: 0,
    run(ctx) {
      scheduler.fireDue(ctx.tick, (task) => dispatcher.dispatch(task, ctx));
    },
  };
}
