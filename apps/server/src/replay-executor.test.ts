import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@worldtangle/shared";
import {
  firstReplayEventMismatch,
  parseReplayJournalCommand,
  replayEventHash,
  replayJournalDigest,
} from "./replay-executor";

function event(
  seq: number,
  type: string,
  payload: unknown,
  identity: { simulationId: string; runId: string; wallTime: string } = {
    simulationId: "sim_00000001",
    runId: "run_00000001",
    wallTime: "T1",
  },
): EventEnvelope {
  return {
    eventId: `evt_${seq.toString(36).padStart(8, "0")}`,
    type,
    schemaVersion: 1,
    simulationId: identity.simulationId,
    runId: identity.runId,
    seq,
    tick: 0,
    simDate: "Y0001-M01-D01",
    wallTime: identity.wallTime,
    actor: { kind: "admin", id: "api" },
    correlationId: "request-1",
    payload,
  };
}

describe("replay event comparison", () => {
  it("ignores operational run identity but detects the first causal payload divergence", () => {
    const expected = [
      event(0, "admin.command.received", {
        command: "start",
        params: { runId: "run_00000001" },
        requestId: "request-1",
      }),
      event(1, "simulation.started", { status: "running", value: 1 }),
    ];
    const equivalent = expected.map((item) => event(
      item.seq,
      item.type,
      item.payload,
      {
        simulationId: "sim_00000002",
        runId: "run_00000002",
        wallTime: "T2",
      },
    ));
    expect(firstReplayEventMismatch(expected, equivalent)).toBeNull();
    expect(replayJournalDigest(expected)).toBe(replayJournalDigest(equivalent));

    const divergent = [equivalent[0]!, event(1, "simulation.started", {
      status: "running",
      value: 2,
    }, {
      simulationId: "sim_00000002",
      runId: "run_00000002",
      wallTime: "T2",
    })];
    expect(firstReplayEventMismatch(expected, divergent)).toEqual({
      seq: 1,
      tick: 0,
      expectedHash: replayEventHash(expected[1]!),
      actualHash: replayEventHash(divergent[1]!),
      expectedType: "simulation.started",
      actualType: "simulation.started",
      reason: "different",
    });
  });

  it("ignores nondeterministic provider latency but preserves economic call cost", () => {
    const expected = event(0, "llm.call.recorded", {
      callId: "llm_00000001",
      latencyMs: 11,
      costMicrocents: "1250",
    });
    const latencyOnly = event(0, "llm.call.recorded", {
      callId: "llm_00000001",
      latencyMs: 5,
      costMicrocents: "1250",
    });
    const costChanged = event(0, "llm.call.recorded", {
      callId: "llm_00000001",
      latencyMs: 5,
      costMicrocents: "1251",
    });

    expect(firstReplayEventMismatch([expected], [latencyOnly])).toBeNull();
    expect(firstReplayEventMismatch([expected], [costChanged])).not.toBeNull();
  });

  it("extracts a schema-shaped operator journal command", () => {
    expect(parseReplayJournalCommand(event(0, "admin.command.received", {
      command: "advance",
      params: { runId: "run_00000001", ticks: 3 },
      requestId: "request-advance",
    }))).toEqual({
      seq: 0,
      tick: 0,
      command: "advance",
      params: { runId: "run_00000001", ticks: 3 },
      requestId: "request-advance",
    });
  });
});
