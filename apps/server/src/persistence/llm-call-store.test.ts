import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  decisionSchema,
  errorListResponseSchema,
  llmCallListResponseSchema,
  llmCallRecordSchema,
  type EventEnvelope,
  type LlmCallRecord,
} from "@worldtangle/shared";
import { generateRiverbendPopulation } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openDatabaseFile, openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteLlmCallStore } from "./llm-call-store";
import { SqliteObservabilityReadStore } from "./observability-read-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-llm-call-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(
    population,
    new Map(population.residents.map((resident) => [
      resident.agent.id,
      `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
    ])),
  );
  db.prepare("UPDATE simulation_runs SET current_tick = 1 WHERE id = ?").run(TEST_RUN_ID);
  const decision = decisionSchema.parse({
    id: "dec_00000001",
    runId: TEST_RUN_ID,
    agentId: "agt_00000001",
    tick: 1,
    trigger: { kind: "goal", sourceEventId: "evt_00000001", priority: 50 },
    tier: 2,
    observationDigest: { hash: "1".repeat(64), summary: "bounded test observation" },
    optionsOffered: [{
      actionId: "goal.defer",
      actionType: "agent.defer_goal",
      params: { agentId: "agt_00000001", reason: "defer_activation" },
      utility: 0,
    }],
    chosenActionId: "goal.defer",
    params: { agentId: "agt_00000001", reason: "defer_activation" },
    rationale: "bounded persisted choice",
    llmCallId: "llm_00000001",
    validationResult: { status: "approved" },
    promptPackKey: "agent.decision",
    promptVersion: 1,
    promptHash: "2".repeat(64),
  });
  new SqliteAgentStore(db, TEST_RUN_ID).saveDecisionResult([decision], []);
  const sourceEvent: EventEnvelope = {
    eventId: "evt_zzzzzzzz",
    type: "llm.call.recorded",
    schemaVersion: EVENT_SCHEMA_VERSION,
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seq: 0,
    tick: 1,
    simDate: "Y0001-M01-D02",
    wallTime: "test-wall",
    actor: { kind: "agent", id: decision.agentId },
    correlationId: decision.id,
    causationId: decision.trigger.sourceEventId,
    payload: { callId: decision.llmCallId },
  };
  new SqliteEventStore(db, TEST_RUN_ID).append(sourceEvent);
  const record: LlmCallRecord = {
    id: "llm_00000001",
    runId: TEST_RUN_ID,
    decisionId: decision.id,
    agentId: decision.agentId,
    tick: 1,
    moduleId: "agent_decisions",
    purpose: "decision.tier2.goal_activation",
    requestedTier: 2,
    effectiveTier: 2,
    provider: "mock",
    model: "mock-llm-v1",
    promptPackKey: "agent.decision",
    promptVersion: 1,
    promptHash: "2".repeat(64),
    schemaKey: "tier2_decision_proposal",
    schemaVersion: 1,
    requestHash: "3".repeat(64),
    status: "success",
    cached: false,
    attempts: 1,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    response: {
      actionId: "goal.defer",
      params: { agentId: decision.agentId, reason: "defer_activation" },
      rationale: "bounded persisted choice",
    },
    sourceEventId: sourceEvent.eventId,
  };
  return { dataDir, db, record };
}

describe("WS-605/608 SQLite LLM call evidence", () => {
  it("is immutable, hash-authoritative, reopen-safe, and snapshot-equivalent", async () => {
    const { dataDir, db, record } = fixture();
    const before = computeLogicalStateHash(db, TEST_RUN_ID);
    const store = new SqliteLlmCallStore(db, TEST_RUN_ID);
    expect(store.insert(record, { latencyMs: 17, costMicrocents: "1250" })).toEqual(record);
    expect(store.get(record.id)).toEqual(record);
    expect(store.list()).toEqual([record]);
    expect(store.getWithTelemetry(record.id)).toEqual({
      record,
      latencyMs: 17,
      costMicrocents: "1250",
    });
    expect(store.summary()).toEqual({
      totalCalls: 1,
      cacheableCalls: 1,
      cacheHits: 0,
      inputTokens: 10,
      outputTokens: 5,
      costMicrocents: "1250",
    });
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).not.toBe(before);

    const hashControl = fixture();
    new SqliteLlmCallStore(hashControl.db, TEST_RUN_ID).insert(record);
    expect(computeLogicalStateHash(hashControl.db, TEST_RUN_ID)).toBe(
      computeLogicalStateHash(db, TEST_RUN_ID),
    );
    expect(() => db.prepare(`
      UPDATE llm_call_records SET model = 'mutated' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, record.id)).toThrow(/immutable/);
    expect(() => db.prepare(`
      DELETE FROM llm_call_records WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, record.id)).toThrow(/immutable/);

    const snapshots = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "snapshot-wall" });
    const destination = join(dataDir, "restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteLlmCallStore(restored, TEST_RUN_ID).list()).toEqual([record]);
    expect(new SqliteLlmCallStore(restored, TEST_RUN_ID).getWithTelemetry(record.id)).toEqual({
      record,
      latencyMs: 17,
      costMicrocents: "1250",
    });

    const path = db.name;
    db.close();
    const reopened = openDatabaseFile(path);
    databases.push(reopened);
    expect(new SqliteLlmCallStore(reopened, TEST_RUN_ID).getWithTelemetry(record.id)).toEqual({
      record,
      latencyMs: 17,
      costMicrocents: "1250",
    });
  });

  it("rejects noncanonical or unsafe operational telemetry", () => {
    const { db, record } = fixture();
    const store = new SqliteLlmCallStore(db, TEST_RUN_ID);
    expect(() => store.insert(record, { latencyMs: -1, costMicrocents: "0" })).toThrow(
      /latency/,
    );
    expect(() => store.insert(record, { latencyMs: 0, costMicrocents: "01" })).toThrow(
      /canonical/,
    );
  });

  it("lists replay evidence in causal event order instead of identifier order", () => {
    const { db, record } = fixture();
    const store = new SqliteLlmCallStore(db, TEST_RUN_ID);
    store.insert(record);

    const secondDecision = decisionSchema.parse({
      id: "dec_00000002",
      runId: TEST_RUN_ID,
      agentId: "agt_00000002",
      tick: 1,
      trigger: { kind: "goal", sourceEventId: "evt_00000002", priority: 50 },
      tier: 2,
      observationDigest: { hash: "4".repeat(64), summary: "second bounded observation" },
      optionsOffered: [{
        actionId: "goal.defer",
        actionType: "agent.defer_goal",
        params: { agentId: "agt_00000002", reason: "defer_activation" },
        utility: 0,
      }],
      chosenActionId: "goal.defer",
      params: { agentId: "agt_00000002", reason: "defer_activation" },
      rationale: "second bounded persisted choice",
      llmCallId: "llm_00000000",
      validationResult: { status: "approved" },
      promptPackKey: "agent.decision",
      promptVersion: 1,
      promptHash: "5".repeat(64),
    });
    new SqliteAgentStore(db, TEST_RUN_ID).saveDecisionResult([secondDecision], []);
    const secondSourceEvent: EventEnvelope = {
      eventId: "evt_aaaaaaaa",
      type: "llm.call.recorded",
      schemaVersion: EVENT_SCHEMA_VERSION,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 1,
      tick: 1,
      simDate: "Y0001-M01-D02",
      wallTime: "test-wall",
      actor: { kind: "agent", id: secondDecision.agentId },
      correlationId: secondDecision.id,
      causationId: secondDecision.trigger.sourceEventId,
      payload: { callId: secondDecision.llmCallId },
    };
    new SqliteEventStore(db, TEST_RUN_ID).append(secondSourceEvent);
    const secondRecord = llmCallRecordSchema.parse({
      ...record,
      id: secondDecision.llmCallId,
      decisionId: secondDecision.id,
      agentId: secondDecision.agentId,
      promptHash: secondDecision.promptHash,
      requestHash: "6".repeat(64),
      response: {
        actionId: "goal.defer",
        params: { agentId: secondDecision.agentId, reason: "defer_activation" },
        rationale: secondDecision.rationale,
      },
      sourceEventId: secondSourceEvent.eventId,
    });
    store.insert(secondRecord);

    expect(store.list().map((call) => call.id)).toEqual([
      secondRecord.id,
      record.id,
    ]);
    expect(store.listForReplay().map((call) => call.id)).toEqual([
      record.id,
      secondRecord.id,
    ]);
  });

  it("projects call telemetry, correlated failures, and active quarantines", () => {
    const { db, record } = fixture();
    const fallback = llmCallRecordSchema.parse({
      ...record,
      effectiveTier: 1,
      status: "fallback",
      fallbackReason: "validation_failed",
      detail: "proposal parameters did not match the engine menu",
      response: undefined,
    });
    new SqliteLlmCallStore(db, TEST_RUN_ID).insert(fallback, {
      latencyMs: 9,
      costMicrocents: "1234567",
    });
    new SqliteAgentStore(db, TEST_RUN_ID).setAgentQuarantine(record.agentId, {
      mode: "tier1_only",
      untilTick: 10,
      consecutiveFailures: 3,
    });
    new SqliteEventStore(db, TEST_RUN_ID).append({
      eventId: "evt_yyyyyyyy",
      type: "agent.action.rejected",
      schemaVersion: EVENT_SCHEMA_VERSION,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 1,
      tick: 1,
      simDate: "Y0001-M01-D02",
      wallTime: "test-wall",
      actor: { kind: "agent", id: record.agentId },
      correlationId: record.decisionId,
      causationId: record.sourceEventId,
      payload: { code: "CAPABILITY_DENIED", message: "bounded action was rejected" },
    });

    const store = new SqliteObservabilityReadStore(db, TEST_RUN_ID);
    const calls = store.listLlmCalls({ limit: 50 });
    expect(llmCallListResponseSchema.safeParse({
      items: calls.items,
      nextCursor: null,
      totals: calls.totals,
      meta: { simulated: true, apiVersion: 1 },
    }).success).toBe(true);
    expect(calls.items[0]).toMatchObject({
      status: "fallback",
      fallbackReason: "validation_failed",
      latencyMs: 9,
      costMicrocents: "1234567",
      costCentsEstimate: "2",
    });

    const errors = store.listErrors({ limit: 50 });
    expect(errorListResponseSchema.safeParse({
      items: errors.items,
      nextCursor: null,
      summary: errors.summary,
      meta: { simulated: true, apiVersion: 1 },
    }).success).toBe(true);
    expect(errors.items.map((item) => item.kind)).toEqual(["intent_rejected", "schema"]);
    expect(errors.summary.counts).toEqual({
      engine: 0,
      intentRejected: 1,
      llm: 0,
      schema: 1,
    });
    expect(errors.summary.perAgent).toEqual([{
      agent: expect.objectContaining({ id: record.agentId }),
      failures: 2,
    }]);
    expect(errors.summary.activeQuarantines).toEqual([{
      agent: expect.objectContaining({ id: record.agentId }),
      quarantine: { mode: "tier1_only", untilTick: 10, consecutiveFailures: 3 },
    }]);
    expect(store.errorCountSinceTick(0)).toBe(2);
  });
});
