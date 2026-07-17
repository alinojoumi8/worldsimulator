import { describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import {
  decodeAgentCursor,
  decodeAgentDecisionCursor,
  decodeEventCursor,
  decodeErrorCursor,
  decodeConversationCursor,
  decodeLlmCallCursor,
  decodeNewsCursor,
  decodePhase4Cursor,
  decodeRelationshipCursor,
  decodeSimulationCursor,
  encodeAgentCursor,
  encodeAgentDecisionCursor,
  encodeEventCursor,
  encodeErrorCursor,
  encodeConversationCursor,
  encodeLlmCallCursor,
  encodeNewsCursor,
  encodePhase4Cursor,
  encodeRelationshipCursor,
  encodeSimulationCursor,
} from "./cursor";

describe("opaque API cursors", () => {
  it("round-trips simulation and event keysets", () => {
    const simulation = { createdWall: "2026-07-14T12:00:00.000Z", simulationId: "sim_00000001" };
    expect(decodeSimulationCursor(encodeSimulationCursor(simulation))).toEqual(simulation);

    const event = { runId: "run_00000001", seq: 41 };
    expect(decodeEventCursor(encodeEventCursor(event), event.runId)).toEqual(event);
  });

  it("rejects malformed, cross-endpoint, and cross-run cursors", () => {
    expect(() => decodeSimulationCursor("not+base64")).toThrow(EngineError);
    const eventCursor = encodeEventCursor({ runId: "run_00000001", seq: 1 });
    expect(() => decodeSimulationCursor(eventCursor)).toThrow(EngineError);
    expect(() => decodeEventCursor(eventCursor, "run_00000002")).toThrow(EngineError);
  });

  it("round-trips run-bound agent, decision, and relationship keysets", () => {
    const runId = "run_00000001";
    const agentId = "agt_00000001";
    expect(decodeAgentCursor(
      encodeAgentCursor({ runId, agentId }),
      runId,
    )).toEqual({ runId, agentId });
    expect(decodeAgentDecisionCursor(
      encodeAgentDecisionCursor({
        runId,
        agentId,
        tick: 12,
        decisionId: "dec_00000001",
      }),
      runId,
      agentId,
    )).toEqual({ runId, agentId, tick: 12, decisionId: "dec_00000001" });
    expect(decodeRelationshipCursor(
      encodeRelationshipCursor({
        runId,
        agentId,
        strength: 40,
        toAgentId: "agt_00000002",
      }),
      runId,
      agentId,
    )).toEqual({ runId, agentId, strength: 40, toAgentId: "agt_00000002" });
    expect(() => decodeAgentDecisionCursor(
      encodeAgentDecisionCursor({
        runId,
        agentId,
        tick: 12,
        decisionId: "dec_00000001",
      }),
      runId,
      "agt_00000002",
    )).toThrow(/does not belong/);
  });

  it("binds Phase 4 cursors to the run, view, order, and entity prefix", () => {
    const cursor = encodePhase4Cursor({
      runId: "run_00000001",
      view: "companies",
      order: 12,
      id: "co_00000001",
    });
    expect(decodePhase4Cursor(cursor, "run_00000001", "companies")).toEqual({
      runId: "run_00000001",
      view: "companies",
      order: 12,
      id: "co_00000001",
    });
    expect(() => decodePhase4Cursor(cursor, "run_00000001", "jobs"))
      .toThrow(/does not belong/);
    expect(() => decodePhase4Cursor(cursor, "run_00000002", "companies"))
      .toThrow(/does not belong/);
  });

  it("binds WS-608 observability cursors to their endpoint and run", () => {
    const runId = "run_00000001";
    const call = { runId, tick: 9, callId: "llm_00000001" };
    const error = { runId, seq: 0 };
    const conversation = { runId, startTick: 4, conversationId: "cnv_00000001" };
    expect(decodeLlmCallCursor(encodeLlmCallCursor(call), runId)).toEqual(call);
    expect(decodeErrorCursor(encodeErrorCursor(error), runId)).toEqual(error);
    expect(decodeConversationCursor(
      encodeConversationCursor(conversation),
      runId,
    )).toEqual(conversation);
    expect(() => decodeErrorCursor(encodeLlmCallCursor(call), runId)).toThrow();
    expect(() => decodeConversationCursor(
      encodeConversationCursor(conversation),
      "run_00000002",
    )).toThrow(/does not belong/);
  });

  it("binds news cursors to the run and story keyset", () => {
    const cursor = {
      runId: "run_00000001",
      tick: 31,
      storyId: "nws_00000001",
    };
    const encoded = encodeNewsCursor(cursor);
    expect(decodeNewsCursor(encoded, cursor.runId)).toEqual(cursor);
    expect(() => decodeNewsCursor(encoded, "run_00000002")).toThrow(/does not belong/);
    expect(() => decodeEventCursor(encoded, cursor.runId)).toThrow(/does not belong/);
  });
});
