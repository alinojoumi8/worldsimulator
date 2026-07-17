import { describe, expect, it } from "vitest";
import { EngineError, RUN_STATUSES } from "@worldtangle/shared";
import {
  assertCanAdvance,
  isTerminalRunStatus,
  RUN_COMMANDS,
  transitionRunStatus,
} from "./run-lifecycle";

describe("run lifecycle", () => {
  it.each([
    ["created", "start", "running"],
    ["running", "pause", "paused"],
    ["paused", "resume", "running"],
    ["running", "stop", "stopped"],
    ["paused", "stop", "stopped"],
    ["running", "complete", "completed"],
    ["paused", "complete", "completed"],
    ["running", "fail", "failed"],
  ] as const)("transitions %s via %s to %s", (current, command, next) => {
    expect(transitionRunStatus(current, command)).toBe(next);
  });

  it("rejects every unspecified transition with CONFLICT", () => {
    const legal = new Set([
      "created:start",
      "running:pause",
      "paused:resume",
      "running:stop",
      "paused:stop",
      "running:complete",
      "paused:complete",
      "running:fail",
    ]);
    for (const status of RUN_STATUSES) {
      for (const command of RUN_COMMANDS) {
        if (legal.has(`${status}:${command}`)) continue;
        try {
          transitionRunStatus(status, command);
          throw new Error(`expected ${status}:${command} to fail`);
        } catch (error) {
          expect(error).toBeInstanceOf(EngineError);
          expect((error as EngineError).code).toBe("CONFLICT");
        }
      }
    }
  });

  it("only permits manual advance while paused", () => {
    expect(() => assertCanAdvance("paused")).not.toThrow();
    for (const status of RUN_STATUSES.filter((value) => value !== "paused")) {
      expect(() => assertCanAdvance(status)).toThrow(EngineError);
    }
  });

  it("identifies terminal statuses", () => {
    expect(RUN_STATUSES.filter(isTerminalRunStatus)).toEqual(["completed", "failed", "stopped"]);
  });
});
