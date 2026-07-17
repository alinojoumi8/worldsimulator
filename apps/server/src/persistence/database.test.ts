import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineError,
  IdFactory,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  deterministicConversationOutcome,
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { SqliteConversationStore } from "./conversation-store";
import { SqliteEventStore } from "./event-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  worldDatabasePath,
} from "./database";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-db-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("world database", () => {
  it("builds a safe per-run path and rejects traversal", () => {
    const dataDir = temporaryDirectory();
    expect(worldDatabasePath(dataDir, "sim_00000001", "run_00000001")).toBe(
      join(dataDir, "sim_00000001", "run_00000001", "world.db"),
    );
    expect(() => worldDatabasePath(dataDir, "../outside", "run_00000001")).toThrow(
      EngineError,
    );
    expect(() => worldDatabasePath(dataDir, "sim_00000001", "..\\outside")).toThrow(
      EngineError,
    );
  });

  it("configures WAL, foreign keys, safe integers, and idempotent migrations", () => {
    const dataDir = temporaryDirectory();
    const db = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(
      db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations").get()
        ?.count,
    ).toBe(32n);
    db.close();

    const reopened = openWorldDatabase(dataDir, "sim_00000001", "run_00000001");
    expect(
      reopened
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    reopened.close();
  });

  it("reapplies a missing immutable-snapshot migration", () => {
    const path = join(temporaryDirectory(), "upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TRIGGER snapshots_no_update;
      DROP TRIGGER snapshots_no_delete;
      DELETE FROM schema_migrations WHERE version = 2;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    const triggerNames = upgraded
      .prepare<[], { name: string }>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE 'snapshots_no_%'
        ORDER BY name
      `)
      .all()
      .map((row) => row.name);
    expect(triggerNames).toEqual(["snapshots_no_delete", "snapshots_no_update"]);
    upgraded.close();
  });

  it("upgrades a version-2 database with the durable API task journal", () => {
    const path = join(temporaryDirectory(), "api-task-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE api_tasks;
      DELETE FROM schema_migrations WHERE version = 3;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    expect(
      upgraded.prepare<[], { name: string }>(`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'api_tasks'
      `).get()?.name,
    ).toBe("api_tasks");
    upgraded.close();
  });

  it("upgrades a version-18 database with the immutable LLM replay cache", () => {
    const path = join(temporaryDirectory(), "llm-cache-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE llm_response_cache;
      DROP TABLE llm_cache_events;
      DELETE FROM schema_migrations WHERE version = 19;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'llm_response_cache'
    `).get()?.name).toBe("llm_response_cache");
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'llm_cache_events'
    `).get()?.name).toBe("llm_cache_events");
    upgraded.close();
  });

  it("upgrades a version-19 database with authoritative LLM budgets and controls", () => {
    const path = join(temporaryDirectory(), "llm-control-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE llm_control_history;
      DROP TABLE llm_module_controls;
      DROP TABLE llm_agent_daily_usage;
      DROP TABLE llm_runtime_budgets;
      DELETE FROM schema_migrations WHERE version = 20;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    const names = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'llm_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(names).toEqual([
      "llm_agent_daily_usage",
      "llm_cache_events",
      "llm_call_records",
      "llm_control_history",
      "llm_module_controls",
      "llm_response_cache",
      "llm_runtime_budgets",
    ]);
    upgraded.close();
  });

  it("upgrades a version-20 database with Tier-2 call evidence and loan-decision links", () => {
    const path = join(temporaryDirectory(), "tier2-call-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TRIGGER llm_call_records_no_update;
      DROP TRIGGER llm_call_records_no_delete;
      DROP TABLE llm_call_records;
      DROP INDEX loan_application_decisions_agent_decision;
      ALTER TABLE loan_application_decisions DROP COLUMN agent_decision_id;
      DELETE FROM schema_migrations WHERE version = 21;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'llm_call_records'
    `).get()?.name).toBe("llm_call_records");
    const columns = upgraded.prepare<[], { name: string }>(`
      PRAGMA table_info(loan_application_decisions)
    `).all().map((row) => row.name);
    expect(columns).toContain("agent_decision_id");
    const callTableSql = upgraded.prepare<[], { sql: string }>(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'llm_call_records'
    `).get()?.sql;
    expect(callTableSql).toContain("DEFERRABLE INITIALLY DEFERRED");
    const triggers = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'llm_call_records_no_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(triggers).toEqual([
      "llm_call_records_no_delete",
      "llm_call_records_no_update",
    ]);
    upgraded.close();
  });

  it("upgrades a version-21 database with bounded conversation persistence", () => {
    const path = join(temporaryDirectory(), "conversation-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE conversation_bindings;
      DROP TABLE conversation_relationship_history;
      DROP TABLE conversation_inbox;
      DROP TABLE conversation_messages;
      DROP TABLE conversations;
      DELETE FROM schema_migrations WHERE version IN (22, 23);
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const migrationCount = upgraded
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
      .get()?.count;
    const tableNames = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'conversation%'
      ORDER BY name
    `).all().map((row) => row.name);
    const conversationSql = upgraded.prepare<[], { sql: string }>(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'conversations'
    `).get()?.sql;
    const immutableTriggers = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'conversation_messages_no_update',
        'conversation_messages_no_delete',
        'conversation_relationship_history_no_update',
        'conversation_relationship_history_no_delete'
      )
      ORDER BY name
    `).all().map((row) => row.name);
    upgraded.close();

    expect(migrationCount).toBe(32n);
    expect(tableNames).toEqual([
      "conversation_bindings",
      "conversation_inbox",
      "conversation_messages",
      "conversation_relationship_history",
      "conversations",
    ]);
    expect(conversationSql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(immutableTriggers).toEqual([
      "conversation_messages_no_delete",
      "conversation_messages_no_update",
      "conversation_relationship_history_no_delete",
      "conversation_relationship_history_no_update",
    ]);
  });

  it("upgrades a version-22 database with immutable negotiation bindings", () => {
    const path = join(temporaryDirectory(), "negotiation-binding-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE conversation_bindings;
      DELETE FROM schema_migrations WHERE version = 23;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'conversation_bindings'
    `).get()?.name).toBe("conversation_bindings");
    const triggers = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'conversation_bindings_no_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(triggers).toEqual([
      "conversation_bindings_no_delete",
      "conversation_bindings_no_update",
    ]);
    upgraded.close();
  });

  it("upgrades version 23 call records with non-authoritative observability columns", () => {
    const path = join(temporaryDirectory(), "llm-observability-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP INDEX llm_call_records_observability;
      ALTER TABLE llm_call_records DROP COLUMN latency_ms;
      ALTER TABLE llm_call_records DROP COLUMN cost_microcents;
      DELETE FROM schema_migrations WHERE version = 24;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const columns = upgraded.prepare<[], { name: string }>(`
      PRAGMA table_info(llm_call_records)
    `).all().map((row) => row.name);
    expect(columns).toContain("latency_ms");
    expect(columns).toContain("cost_microcents");
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades version 24 budgets with provider-cache token accounting", () => {
    const path = join(temporaryDirectory(), "llm-provider-cache-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TRIGGER llm_runtime_budget_monotonic;
      DROP TRIGGER llm_agent_daily_monotonic;
      ALTER TABLE llm_runtime_budgets DROP COLUMN cached_input_tokens;
      ALTER TABLE llm_agent_daily_usage DROP COLUMN cached_input_tokens;
      DELETE FROM schema_migrations WHERE version = 25;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const budgetColumns = upgraded.prepare<[], { name: string }>(`
      PRAGMA table_info(llm_runtime_budgets)
    `).all().map((row) => row.name);
    const agentColumns = upgraded.prepare<[], { name: string }>(`
      PRAGMA table_info(llm_agent_daily_usage)
    `).all().map((row) => row.name);
    expect(budgetColumns).toContain("cached_input_tokens");
    expect(agentColumns).toContain("cached_input_tokens");
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades version 25 databases with immutable news pipeline tables", () => {
    const path = join(temporaryDirectory(), "news-story-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE news_story_citations;
      DROP TABLE news_stories;
      DROP TABLE news_digests;
      DROP TABLE news_organizations;
      DELETE FROM schema_migrations WHERE version = 26;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const tables = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'news_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(tables).toEqual([
      "news_digests",
      "news_organizations",
      "news_stories",
      "news_story_citations",
    ]);
    const triggers = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'news_%_no_%'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(triggers).toHaveLength(8);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades version 26 databases with immutable sentiment and opinion ledgers", () => {
    const path = join(temporaryDirectory(), "sentiment-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE agent_opinion_causes;
      DROP TABLE agent_opinion_updates;
      DROP TABLE sentiment_story_contributions;
      DROP TABLE sentiment_updates;
      DELETE FROM schema_migrations WHERE version = 27;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const tables = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'sentiment_updates',
        'sentiment_story_contributions',
        'agent_opinion_updates',
        'agent_opinion_causes'
      )
      ORDER BY name
    `).all().map((row) => row.name);
    expect(tables).toEqual([
      "agent_opinion_causes",
      "agent_opinion_updates",
      "sentiment_story_contributions",
      "sentiment_updates",
    ]);
    const triggers = upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND (
        name LIKE 'sentiment_%_no_%' OR name LIKE 'agent_opinion_%_no_%'
      )
      ORDER BY name
    `).all().map((row) => row.name);
    expect(triggers).toHaveLength(8);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades version 27 indicator history with the full immutable set and evidence", () => {
    const path = join(temporaryDirectory(), "full-indicator-upgrade.db");
    const db = openDatabaseFile(path);
    insertTestRun(db);
    db.prepare(`
      INSERT INTO indicator_points(
        run_id, tick, indicator_key, value_integer, formula_version, inputs_digest
      ) VALUES (?, 0, 'm1_cents', '510000000', 1, ?)
    `).run(TEST_RUN_ID, "f".repeat(64));
    db.exec(`
      DROP TRIGGER indicator_points_no_update;
      DROP TRIGGER indicator_points_no_delete;
      ALTER TABLE indicator_points RENAME TO indicator_points_full_set;

      CREATE TABLE indicator_points (
        run_id TEXT NOT NULL REFERENCES simulation_runs(id),
        tick INTEGER NOT NULL CHECK (tick >= 0),
        indicator_key TEXT NOT NULL CHECK (indicator_key IN (
          'm1_cents', 'average_wage_cents', 'unemployment_rate_bp',
          'treasury_balance_cents', 'credit_outstanding_cents', 'default_rate_bp'
        )),
        value_integer TEXT NOT NULL,
        PRIMARY KEY (run_id, tick, indicator_key)
      );
      INSERT INTO indicator_points(run_id, tick, indicator_key, value_integer)
      SELECT run_id, tick, indicator_key, value_integer FROM indicator_points_full_set;
      DROP TABLE indicator_points_full_set;
      CREATE INDEX indicator_points_series
        ON indicator_points(run_id, indicator_key, tick);
      CREATE TRIGGER indicator_points_no_update BEFORE UPDATE ON indicator_points
      BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
      CREATE TRIGGER indicator_points_no_delete BEFORE DELETE ON indicator_points
      BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
      DELETE FROM schema_migrations WHERE version = 28;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    const columns = upgraded.prepare<[], { name: string }>(`
      PRAGMA table_info(indicator_points)
    `).all().map((row) => row.name);
    expect(columns).toEqual([
      "run_id",
      "tick",
      "indicator_key",
      "value_integer",
      "formula_version",
      "inputs_digest",
    ]);
    const tableSql = upgraded.prepare<[], { sql: string }>(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'indicator_points'
    `).get()?.sql;
    expect(tableSql).toContain("'gdp_proxy_cents'");
    expect(tableSql).toContain("'sentiment_index_bp'");
    expect(upgraded.prepare<[string], {
      formula_version: bigint;
      inputs_digest: string;
    }>(`
      SELECT formula_version, inputs_digest FROM indicator_points
      WHERE run_id = ? AND tick = 0 AND indicator_key = 'm1_cents'
    `).get(TEST_RUN_ID)).toEqual({
      formula_version: 0n,
      inputs_digest: "0".repeat(64),
    });
    expect(() => upgraded.prepare(`
      UPDATE indicator_points SET value_integer = '1'
      WHERE run_id = ? AND indicator_key = 'm1_cents'
    `).run(TEST_RUN_ID)).toThrow(/immutable/);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("round-trips integers larger than Number.MAX_SAFE_INTEGER as bigint", () => {
    const path = join(temporaryDirectory(), "bigint.db");
    const db = openDatabaseFile(path);
    db.exec("CREATE TABLE bigint_probe(value INTEGER NOT NULL)");
    const value = 9_007_199_254_740_993n;
    db.prepare("INSERT INTO bigint_probe(value) VALUES (?)").run(value);
    expect(db.prepare<[], { value: bigint }>("SELECT value FROM bigint_probe").get()?.value).toBe(
      value,
    );
    db.close();
  });

  it("upgrades a version-28 database with replay control-plane tables", () => {
    const path = join(temporaryDirectory(), "replay-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE replay_llm_expectations;
      DROP TABLE replay_divergences;
      DROP TABLE replay_runs;
      DELETE FROM schema_migrations WHERE version = 29;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'replay_%'
      ORDER BY name
    `).all().map((row) => row.name)).toEqual([
      "replay_divergences",
      "replay_llm_expectations",
      "replay_runs",
    ]);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades a version-29 database with restart-safe export tables", () => {
    const path = join(temporaryDirectory(), "export-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE export_events;
      DROP TABLE export_files;
      DROP TABLE export_jobs;
      DELETE FROM schema_migrations WHERE version = 30;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'export_%'
      ORDER BY name
    `).all().map((row) => row.name)).toEqual([
      "export_events",
      "export_files",
      "export_jobs",
    ]);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades a version-30 database with constrained venture fund accounting", () => {
    const path = join(temporaryDirectory(), "venture-fund-upgrade.db");
    const db = openDatabaseFile(path);
    db.exec(`
      DROP TABLE vc_fund_deployments;
      DROP TABLE vc_funds;
      DROP TABLE vc_firms;
      DELETE FROM schema_migrations WHERE version = 31;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'vc_%'
      ORDER BY name
    `).all().map((row) => row.name)).toEqual([
      "vc_firms",
      "vc_fund_deployments",
      "vc_funds",
    ]);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'vc_%'
      ORDER BY name
    `).all().map((row) => row.name)).toContain("vc_fund_deployments_apply_total");
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("upgrades a version-31 database with investment conversations and proposals", () => {
    const path = join(temporaryDirectory(), "investment-proposal-upgrade.db");
    const db = openDatabaseFile(path);
    insertTestRun(db);
    const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
    const agentTriggers = new Map(population.residents.map((resident) => [
      resident.agent.id,
      `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
    ]));
    new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, agentTriggers);
    const ids = IdFactory.restore(population.idState);
    const eventStore = new SqliteEventStore(db, TEST_RUN_ID);
    const triggerEventId = ids.next("evt");
    eventStore.append({
      eventId: triggerEventId,
      type: "migration.conversation.triggered",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 0,
      tick: 0,
      simDate: simDateForTick(0),
      wallTime: "T0",
      actor: { kind: "system", id: "migration-test" },
      correlationId: "migration-conversation",
      payload: { purpose: "preserve-child-foreign-keys" },
    });
    const context = (tick: number): TickContext => ({
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      tick,
      simDate: simDateForTick(tick),
      phase: "decisions",
      ids,
      rng: (key) => Rng.root(42).fork(`${tick}.decisions.${key}`),
      count: () => undefined,
      setDigestIndicators: () => undefined,
      emit: (type, payload, options) => {
        const event: EventEnvelope = {
          eventId: ids.next("evt"),
          type,
          schemaVersion: options?.schemaVersion ?? 1,
          simulationId: TEST_SIMULATION_ID,
          runId: TEST_RUN_ID,
          seq: eventStore.count(),
          tick,
          simDate: simDateForTick(tick),
          wallTime: `T${tick}`,
          actor: options?.actor ?? { kind: "system", id: "migration-test" },
          correlationId: options?.correlationId ?? "migration-conversation",
          ...(options?.causationId === undefined
            ? {}
            : { causationId: options.causationId }),
          payload,
        };
        eventStore.append(event);
        return event;
      },
    });
    const conversations = new SqliteConversationStore(db, TEST_RUN_ID);
    const conversation = conversations.open({
      participantAgentIds: [
        population.residents[0]!.agent.id,
        population.residents[1]!.agent.id,
      ],
      topic: "purchase",
      initiatingTriggerEventId: triggerEventId,
      termBounds: {
        kind: "purchase",
        referenceId: "migration-offer",
        minQuantity: 1,
        maxQuantity: 2,
        minUnitPriceCents: "100",
        maxUnitPriceCents: "200",
      },
      maxTurns: 6,
      outputTokenBudget: 4_096,
      startTick: 0,
    }, context(0));
    conversations.close({
      conversationId: conversation.id,
      closeReason: "declined",
      outcome: deterministicConversationOutcome(
        "declined",
        null,
        "Migration fixture declined without an agreement.",
      ),
    }, context(1));
    const relationshipHistoryCount = db.prepare<
      [string, string],
      { count: bigint }
    >(`
      SELECT COUNT(*) AS count FROM conversation_relationship_history
      WHERE run_id = ? AND conversation_id = ?
    `).get(TEST_RUN_ID, conversation.id)!.count;
    expect(relationshipHistoryCount).toBeGreaterThan(0n);
    db.exec(`
      DROP TABLE investment_proposals;
      DELETE FROM schema_migrations WHERE version = 32;
    `);
    db.close();

    const upgraded = openDatabaseFile(path);
    expect(upgraded.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'investment_proposals'
    `).get()?.name).toBe("investment_proposals");
    const conversationSql = upgraded.prepare<[], { sql: string }>(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversations'
    `).get()?.sql ?? "";
    expect(conversationSql).toContain("'investment'");
    expect(conversationSql).toContain("'expired'");
    expect(new SqliteConversationStore(upgraded, TEST_RUN_ID).get(conversation.id))
      .toMatchObject({ id: conversation.id, topic: "purchase", status: "concluded" });
    expect(upgraded.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM conversation_relationship_history
      WHERE run_id = ? AND conversation_id = ?
    `).get(TEST_RUN_ID, conversation.id)?.count).toBe(relationshipHistoryCount);
    expect(
      upgraded
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
    ).toBe(32n);
    upgraded.close();
  });

  it("refuses to open a database whose applied migration checksum drifted", () => {
    const path = join(temporaryDirectory(), "drift.db");
    const db = openDatabaseFile(path);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    db.close();
    expect(() => openDatabaseFile(path)).toThrow(EngineError);
  });
});
