import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BudgetedLlmProvider,
  MockLlmProvider,
  type LlmRequest,
} from "@worldtangle/engine";
import { canonicalStringify } from "@worldtangle/shared";
import {
  openDatabaseFile,
  openWorldDatabase,
} from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteLlmControlStore } from "./llm-control-store";
import { SqliteRunRepository } from "./run-repository";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const choiceSchema = z.object({ actionId: z.literal("wait") }).strict();
const choice = Object.freeze({ actionId: "wait" });
const dataDirectories: string[] = [];
const databases: WorldDatabase[] = [];
const prices = new Map([[
  "mock-priced",
  {
    inputMicrocentsPerToken: 1_000_000n,
    cachedInputMicrocentsPerToken: 250_000n,
    outputMicrocentsPerToken: 1_000_000n,
  },
]]);

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier3.demo",
    tier: 3,
    agentId: "agt_00000001",
    tick: 0,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000000",
    promptParts: { system: "system", observation: "<observation>safe</observation>" },
    schemaKey: "choice@1",
    promptPackVersion: 3,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [choice],
    maxOutputTokens: 32,
    budgetTag: "run_test",
    ...overrides,
  };
}

function createFixture(options: {
  ceiling?: string;
  daily?: number;
  running?: boolean;
} = {}): {
  dataDir: string;
  db: WorldDatabase;
  store: SqliteLlmControlStore;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-llm-controls-"));
  dataDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  new SqliteEventStore(db, TEST_RUN_ID).append({
    eventId: "evt_00000000",
    type: "simulation.created",
    schemaVersion: 1,
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seq: 0,
    tick: 0,
    simDate: "Y0001-M01-D01",
    wallTime: "T0",
    actor: { kind: "admin", id: "api" },
    correlationId: "create_00000001",
    payload: { budgets: { runCostCentsMax: options.ceiling ?? "100" } },
  });
  db.prepare("UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?")
    .run(canonicalStringify({ evt: 1 }), TEST_RUN_ID);
  db.prepare(`
    INSERT INTO households(
      run_id, id, member_ids_canonical, structure, housing_tier, budget_policy_canonical
    ) VALUES (?, ?, ?, 'single', 'modest', ?)
  `).run(
    TEST_RUN_ID,
    "hh_00000001",
    canonicalStringify(["agt_00000001"]),
    canonicalStringify({}),
  );
  db.prepare(`
    INSERT INTO agents(
      run_id, id, persona_id, household_id, occupation_code, employment_status,
      credit_score, quarantine_canonical, alive_flags_canonical,
      annual_income_cents, role_code, organization_id, segment
    ) VALUES (?, ?, ?, ?, 'retail_clerk', 'employed', 700, ?, ?, '5000000',
      'resident', NULL, 'independent')
  `).run(
    TEST_RUN_ID,
    "agt_00000001",
    "per_00000001",
    "hh_00000001",
    canonicalStringify({ mode: "none" }),
    canonicalStringify({ alive: true, canAct: true }),
  );
  const store = new SqliteLlmControlStore(db, TEST_RUN_ID, {
    prices,
    wallClock: () => "T1",
  });
  store.initialize({
    runCostCentsMax: options.ceiling ?? "100",
    perAgentDailyTokens: options.daily ?? 1_000,
    llmEnabled: true,
    sourceEventId: "evt_00000000",
  });
  if (options.running) {
    db.prepare("UPDATE simulations SET status = 'active' WHERE id = ?").run(TEST_SIMULATION_ID);
    db.prepare(`
      UPDATE simulation_runs SET status = 'running', started_wall = 'T0' WHERE id = ?
    `).run(TEST_RUN_ID);
  }
  return { dataDir, db, store };
}

function track(db: WorldDatabase): WorldDatabase {
  databases.push(db);
  return db;
}

function eventTypes(db: WorldDatabase): string[] {
  return db.prepare<[string], { type: string }>(`
    SELECT type FROM events WHERE run_id = ? ORDER BY seq
  `).all(TEST_RUN_ID).map((row) => row.type);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of dataDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteLlmControlStore", () => {
  it("prices, journals, reopens, and restores provider cache-hit input exactly", async () => {
    const fixture = createFixture();
    const input = request();
    const authorization = fixture.store.authorize(input);
    if (authorization.disposition !== "allow") throw new Error("expected LLM authorization");
    const receipt = fixture.store.recordSuccess({
      request: input,
      route: { provider: "kimi", model: "mock-priced" },
      result: {
        ok: true,
        value: choice,
        model: "mock-priced",
        cached: false,
        inputTokens: 10,
        cachedInputTokens: 6,
        outputTokens: 2,
        requestHash: "a".repeat(64),
      },
      authorization,
    });
    expect(receipt.costMicrocents).toBe(7_500_000n);
    expect(fixture.store.status().spend).toEqual({
      inputTokens: 10,
      cachedInputTokens: 6,
      outputTokens: 2,
      costCentsEstimate: "8",
    });
    const usage = new SqliteEventStore(fixture.db, TEST_RUN_ID).list()
      .find((event) => event.type === "llm.usage.recorded");
    expect(usage?.payload).toMatchObject({
      provider: "kimi",
      inputTokens: 10,
      cachedInputTokens: 6,
      outputTokens: 2,
      costMicrocents: "7500000",
    });

    const snapshots = new SqliteSnapshotStore(
      fixture.db,
      fixture.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "snapshot-wall" });
    const restored = track(openDatabaseFile(snapshots.restoreTo(
      snapshot.id,
      join(fixture.dataDir, "cached-restored", "world.db"),
    )));
    expect(new SqliteLlmControlStore(restored, TEST_RUN_ID, { prices }).status())
      .toEqual(fixture.store.status());
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);

    fixture.db.close();
    const reopened = track(openWorldDatabase(
      fixture.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    expect(new SqliteLlmControlStore(reopened, TEST_RUN_ID, { prices }).status().spend)
      .toMatchObject({ inputTokens: 10, cachedInputTokens: 6, outputTokens: 2 });
  });

  it("journals forced-low-budget usage, pauses atomically, and restores equivalently", async () => {
    const fixture = createFixture({ ceiling: "1", running: true });
    const upstream = new MockLlmProvider({ model: "mock-priced", script: () => choice });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: fixture.store });
    const hashBefore = computeLogicalStateHash(fixture.db, TEST_RUN_ID);

    expect(await provider.propose(request())).toMatchObject({ ok: true });
    expect(new SqliteRunRepository(fixture.db).getRun(TEST_RUN_ID).status).toBe("paused");
    expect(fixture.store.status()).toMatchObject({
      effectiveTier: 1,
      autoPaused: true,
      budgetPct: 100,
    });
    expect(eventTypes(fixture.db)).toEqual([
      "simulation.created",
      "llm.usage.recorded",
      "llm.budget.threshold",
      "llm.budget.threshold",
      "simulation.paused",
    ]);
    expect(await provider.propose(request())).toMatchObject({
      ok: false,
      reason: "budget_blocked",
      degradationReason: "run_cost_exhausted",
    });
    expect(upstream.calls).toHaveLength(1);
    expect(computeLogicalStateHash(fixture.db, TEST_RUN_ID)).not.toBe(hashBefore);

    const snapshots = new SqliteSnapshotStore(
      fixture.db,
      fixture.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "snapshot-wall" });
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(fixture.dataDir, "restored", "world.db"),
    );
    const restored = track(openDatabaseFile(restoredPath));
    const restoredStore = new SqliteLlmControlStore(restored, TEST_RUN_ID, { prices });
    expect(restoredStore.status()).toEqual(fixture.store.status());
    expect(restoredStore.authorize(request())).toMatchObject({
      disposition: "block",
      degradationReason: "run_cost_exhausted",
    });
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
  });

  it("journals and reverses all three kill switches without restart", () => {
    const { db, store } = createFixture();
    const hashBefore = computeLogicalStateHash(db, TEST_RUN_ID);

    store.applyControl({ command: "set_llm_enabled", enabled: false }, "ctl_1", "T1");
    expect(store.authorize(request())).toMatchObject({
      disposition: "block",
      degradationReason: "llm_disabled",
    });
    store.applyControl({ command: "set_llm_enabled", enabled: true }, "ctl_2", "T2");
    store.applyControl({
      command: "set_module_frozen",
      moduleId: "agent_decisions",
      frozen: true,
    }, "ctl_3", "T3");
    expect(store.authorize(request())).toMatchObject({ degradationReason: "module_frozen" });
    store.applyControl({
      command: "set_module_frozen",
      moduleId: "agent_decisions",
      frozen: false,
    }, "ctl_4", "T4");
    store.applyControl({
      command: "set_agent_quarantine",
      agentId: "agt_00000001",
      quarantined: true,
      untilTick: 5,
    }, "ctl_5", "T5");
    expect(store.authorize(request())).toMatchObject({ degradationReason: "agent_quarantined" });
    store.applyControl({
      command: "set_agent_quarantine",
      agentId: "agt_00000001",
      quarantined: false,
    }, "ctl_6", "T6");

    expect(store.authorize(request())).toMatchObject({ disposition: "allow", effectiveTier: 3 });
    expect(store.status()).toMatchObject({ enabled: true, frozenModules: [] });
    expect(store.listHistory()).toHaveLength(6);
    expect(store.listHistory().map((item) => item.command)).toEqual([
      "set_llm_enabled",
      "set_llm_enabled",
      "set_module_frozen",
      "set_module_frozen",
      "set_agent_quarantine",
      "set_agent_quarantine",
    ]);
    expect(eventTypes(db).filter((type) => type === "admin.command.received")).toHaveLength(6);
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).not.toBe(hashBefore);
  });

  it("rolls back journal, usage, and checkpoints when persistence fails", async () => {
    const { db, store } = createFixture({ running: true });
    db.exec(`
      CREATE TRIGGER fail_llm_usage BEFORE UPDATE OF cost_microcents ON llm_runtime_budgets
      WHEN NEW.cost_microcents <> OLD.cost_microcents
      BEGIN SELECT RAISE(ABORT, 'injected LLM usage failure'); END;
    `);
    const hashBefore = computeLogicalStateHash(db, TEST_RUN_ID);
    const eventCount = eventTypes(db).length;
    const upstream = new MockLlmProvider({ model: "mock-priced", script: () => choice });

    expect(await new BudgetedLlmProvider({ provider: upstream, controller: store })
      .propose(request())).toMatchObject({
        ok: false,
        reason: "provider_error",
        detail: expect.stringContaining("injected LLM usage failure"),
      });
    expect(eventTypes(db)).toHaveLength(eventCount);
    expect(store.status().spend).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCentsEstimate: "0",
    });
    expect(new SqliteRunRepository(db).getRun(TEST_RUN_ID)).toMatchObject({
      status: "running",
      nextEventSeq: 1,
      idState: { evt: 1 },
    });
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).toBe(hashBefore);
  });

  it("persists per-agent 80 and 100 percent events by simulated day", async () => {
    const { db, store } = createFixture({ ceiling: "1000", daily: 1 });
    const upstream = new MockLlmProvider({ model: "mock-priced", script: () => choice });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: store });

    expect(await provider.propose(request())).toMatchObject({ ok: true });
    expect(store.authorize(request())).toMatchObject({
      disposition: "block",
      degradationReason: "agent_daily_tokens_exhausted",
    });
    expect(eventTypes(db)).toContain("llm.agent_budget.warning");
    expect(eventTypes(db)).toContain("llm.agent_budget.exhausted");
    expect(store.authorize(request({ tick: 1 }))).toMatchObject({ disposition: "allow" });
  });

  it("charges a next-tick pre-commit call against its authorization checkpoint", async () => {
    const { db, store } = createFixture({ ceiling: "1000" });
    const upstream = new MockLlmProvider({ model: "mock-priced", script: () => choice });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: store });

    expect(await provider.propose(request({ tick: 1 }))).toMatchObject({
      ok: true,
      effectiveTier: 3,
    });
    expect(eventTypes(db)).toEqual(["simulation.created", "llm.usage.recorded"]);
    expect(store.status().spend).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(() => store.authorize(request({ tick: 2 }))).toThrow(
      "LLM request must target the current or next simulation tick",
    );
  });

  it("rejects usage if the run advances after authorization", async () => {
    const { db, store } = createFixture({ ceiling: "1000", running: true });
    const upstream = new MockLlmProvider({
      model: "mock-priced",
      script: () => {
        db.prepare("UPDATE simulation_runs SET current_tick = 1 WHERE id = ?")
          .run(TEST_RUN_ID);
        return choice;
      },
    });
    const provider = new BudgetedLlmProvider({ provider: upstream, controller: store });

    expect(await provider.propose(request({ tick: 1 }))).toMatchObject({
      ok: false,
      reason: "provider_error",
      effectiveTier: 3,
      detail: "LLM response crossed a simulation tick boundary",
    });
    expect(eventTypes(db)).toEqual(["simulation.created"]);
    expect(store.status().spend).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCentsEstimate: "0",
    });
  });
});
