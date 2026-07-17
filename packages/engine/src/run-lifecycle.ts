/** Pure M01 run-state rules. Persistence and HTTP adapters call this module. */

import { EngineError } from "@worldtangle/shared";
import type { RunStatus } from "@worldtangle/shared";

export const RUN_COMMANDS = ["start", "pause", "resume", "stop", "complete", "fail"] as const;
export type RunCommand = (typeof RUN_COMMANDS)[number];

const transitions: Readonly<
  Partial<Record<RunStatus, Readonly<Partial<Record<RunCommand, RunStatus>>>>>
> = {
  created: { start: "running" },
  running: {
    pause: "paused",
    stop: "stopped",
    complete: "completed",
    fail: "failed",
  },
  paused: { resume: "running", stop: "stopped", complete: "completed" },
};

export function transitionRunStatus(current: RunStatus, command: RunCommand): RunStatus {
  const next = transitions[current]?.[command];
  if (!next) {
    throw new EngineError(
      "CONFLICT",
      `cannot ${command} a run whose status is ${current}`,
      { current, command },
    );
  }
  return next;
}

export function assertCanAdvance(status: RunStatus): void {
  if (status !== "paused") {
    throw new EngineError("CONFLICT", `cannot advance a run whose status is ${status}`, {
      current: status,
      command: "advance",
    });
  }
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}
