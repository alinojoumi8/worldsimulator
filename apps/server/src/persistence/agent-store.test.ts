import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentActionSchema,
  decisionSchema,
  IdFactory,
} from "@worldtangle/shared";
import {
  DeterministicMemoryStore,
  generateRiverbendPopulation,
  GoalLifecycleEngine,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { computeLogicalStateHash } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-agent-store-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggers = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  const store = new SqliteAgentStore(db, TEST_RUN_ID);
  store.insertPopulation(population, triggers);
  return { dataDir, db, population, store };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteAgentStore", () => {
  it("persists the complete Riverbend population and serves deterministic directory/profile reads", () => {
    const { population, store } = fixture();
    expect(store.hasPopulation()).toBe(true);
    expect(store.populationReport()).toEqual(population.report);
    expect(store.listAgentEntities()).toHaveLength(100);

    const first = store.listAgents({ limit: 6 });
    const second = store.listAgents({ limit: 6, afterAgentId: first[2]!.id });
    expect(first.map((agent) => agent.id)).toEqual([
      "agt_00000001",
      "agt_00000002",
      "agt_00000003",
      "agt_00000004",
      "agt_00000005",
      "agt_00000006",
    ]);
    expect(second[0]?.id).toBe("agt_00000004");
    expect(first[0]?.netWorth.cents).toMatch(/^-?\d+$/);

    const profile = store.getProfile(first[0]!.id);
    expect(profile.agent.id).toBe(first[0]!.id);
    expect(profile.persona.id).toBe(profile.agent.personaId);
    expect(profile.persona.name).toBe(first[0]!.name);
    expect(profile.goals.length).toBeGreaterThanOrEqual(1);
    expect(store.listAgents({
      limit: 200,
      occupation: profile.agent.occupationCode,
      employmentStatus: profile.agent.employmentStatus,
      search: profile.persona.name.slice(0, 3),
    }).every((item) => item.occupation === profile.agent.occupationCode)).toBe(true);
    expect(store.listRelationships(first[0]!.id, { limit: 200 }).length).toBeGreaterThanOrEqual(2);
  });

  it("provides append-only SQLite memory with deterministic compaction", () => {
    const { db, population, store } = fixture();
    const ids = IdFactory.restore(population.idState);
    const memories = new DeterministicMemoryStore({
      repository: store,
      ids,
      maxActiveMemories: 4,
      compactToMemories: 3,
    });
    const agentId = population.residents[0]!.agent.id;
    for (let tick = 1; tick <= 5; tick++) {
      memories.record({
        runId: TEST_RUN_ID,
        agentId,
        tick,
        kind: "outcome",
        content: `Outcome ${tick}`,
        importance: tick * 10,
        references: [`evt_${tick.toString(36).padStart(8, "0")}`],
      });
    }
    expect(store.list(agentId)).toHaveLength(6);
    expect(store.listActive(agentId)).toHaveLength(3);
    const summary = store.list(agentId).find((memory) => memory.sourceMemoryIds !== undefined)!;
    expect(summary.references).toEqual([
      "evt_00000001",
      "evt_00000002",
      "evt_00000003",
    ]);
    expect(() => db.prepare("UPDATE memories SET content = 'changed' WHERE id = ?").run(summary.id))
      .toThrow("memories are append-only");
  });

  it("persists goal transitions, decisions, and actions and survives reopen", () => {
    const { dataDir, db, population, store } = fixture();
    const agent = population.residents[0]!.agent;
    const activeGoal = store.listByAgent(agent.id).find((record) => record.goal.status === "active")!;
    const lifecycle = new GoalLifecycleEngine({ repository: store });
    const advanced = lifecycle.advance(activeGoal.goal.id, 0.25, {
      tick: 1,
      rationale: "test_progress",
      emit: () => "evt_000000zz",
    });
    expect(advanced.goal.progress).toBe(0.25);

    const decision = decisionSchema.parse({
      id: "dec_00000001",
      runId: TEST_RUN_ID,
      agentId: agent.id,
      tick: 1,
      trigger: { kind: "goal", sourceEventId: "evt_00000001", priority: 80 },
      tier: 2,
      observationDigest: { hash: "a".repeat(64), summary: "memory-backed observation" },
      optionsOffered: [{
        actionId: "goal.respond",
        actionType: "agent.advance_goal",
        params: { agentId: agent.id },
        utility: 100,
      }],
      chosenActionId: "goal.respond",
      params: { agentId: agent.id },
      rationale: "rule:test",
      llmCallId: "llm_00000001",
      validationResult: { status: "approved" },
      promptPackKey: "agent.decision",
      promptVersion: 1,
      promptHash: "b".repeat(64),
    });
    const action = agentActionSchema.parse({
      id: "act_00000001",
      runId: TEST_RUN_ID,
      decisionId: decision.id,
      actorId: agent.id,
      type: "agent.advance_goal",
      params: { agentId: agent.id },
      status: "applied",
      resultEventIds: ["evt_00000002"],
    });
    store.saveDecisionResult([decision], [action]);
    expect(store.listDecisions(agent.id, { limit: 10 })).toEqual([decision]);
    expect(store.listActions()).toEqual([action]);
    expect(store.listDecisions(agent.id, { limit: 10 })[0]?.promptHash).toBe("b".repeat(64));
    expect(() => db.prepare("UPDATE decisions SET tier = 2 WHERE id = ?").run(decision.id))
      .toThrow("decisions are immutable");

    const beforeReopenHash = computeLogicalStateHash(db, TEST_RUN_ID);
    db.close();
    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    const reopenedStore = new SqliteAgentStore(reopened, TEST_RUN_ID);
    expect(reopenedStore.getProfile(agent.id).goals.find((goal) => goal.id === activeGoal.goal.id)?.progress)
      .toBe(0.25);
    expect(reopenedStore.listDecisions(agent.id, { limit: 10 })).toEqual([decision]);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(beforeReopenHash);
  });

  it("rolls back all population rows when an initial trigger is missing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-agent-store-rollback-"));
    directories.push(dataDir);
    const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(db);
    insertTestRun(db);
    const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
    const store = new SqliteAgentStore(db, TEST_RUN_ID);
    expect(() => store.insertPopulation(population, new Map())).toThrow(/missing initial trigger/);
    expect(store.hasPopulation()).toBe(false);
    expect(store.listAgentEntities()).toEqual([]);
  });
});
