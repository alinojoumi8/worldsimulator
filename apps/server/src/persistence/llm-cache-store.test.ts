import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CachedLlmProvider,
  MockLlmProvider,
  normalizeLlmCachedResponse,
} from "@worldtangle/engine";
import type { LlmRequest } from "@worldtangle/engine";
import { canonicalStringify, EngineError } from "@worldtangle/shared";
import {
  openDatabaseFile,
  openWorldDatabase,
} from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteLlmResponseCache } from "./llm-cache-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const choiceSchema = z.object({
  actionId: z.literal("wait"),
  rationale: z.string().min(1),
}).strict();

const choice = Object.freeze({ actionId: "wait", rationale: "Hold position." });
const dataDirectories: string[] = [];
const databases: WorldDatabase[] = [];

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: "decision.tier2.demo",
    tier: 2,
    agentId: "agt_00000001",
    tick: 0,
    moduleId: "agent_decisions",
    correlationId: "dec_00000001",
    causationId: "evt_00000001",
    promptParts: { system: "system-v1", observation: "<obs>value</obs>" },
    schemaKey: "choice@1",
    promptPackVersion: 3,
    schemaVersion: 1,
    schema: choiceSchema,
    options: [choice],
    maxOutputTokens: 128,
    budgetTag: "run_test",
    ...overrides,
  };
}

function createDatabase(prefix = "worldtangle-llm-cache-"): {
  dataDir: string;
  db: WorldDatabase;
} {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  dataDirectories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  new SqliteEventStore(db, TEST_RUN_ID).append({
    eventId: "evt_00000001",
    type: "decision.requested",
    schemaVersion: 1,
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seq: 0,
    tick: 0,
    simDate: "Y0001-M01-D01",
    wallTime: "T0",
    actor: { kind: "agent", id: "agt_00000001" },
    correlationId: "dec_00000001",
    payload: { purpose: "decision.tier2.demo" },
  });
  db.prepare(`
    UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?
  `).run(canonicalStringify({ evt: 1 }), TEST_RUN_ID);
  return { dataDir, db };
}

function track(db: WorldDatabase): WorldDatabase {
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of dataDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteLlmResponseCache", () => {
  it("persists miss, storage, and hit causality without consuming simulation IDs", async () => {
    const fixture = createDatabase();
    let store = new SqliteLlmResponseCache(fixture.db, TEST_RUN_ID);
    const upstream = new MockLlmProvider({
      script: new Map([["decision.tier2.demo", choice]]),
      model: "mock-pinned",
    });
    const provider = new CachedLlmProvider({ provider: upstream, cache: store });
    const beforeHash = computeLogicalStateHash(fixture.db, TEST_RUN_ID);

    expect(await provider.propose(request())).toMatchObject({
      ok: true,
      cached: false,
      value: choice,
    });
    expect(await provider.propose(request())).toMatchObject({
      ok: true,
      cached: true,
      value: choice,
    });

    expect(upstream.calls).toHaveLength(1);
    expect(store.count()).toBe(1);
    expect(store.listEvents()).toMatchObject([
      {
        seq: 0,
        eventId: "llmce_00000000",
        type: "llm.cache.miss",
        schemaVersion: 1,
        actor: { kind: "system", id: "llm_gateway" },
        correlationId: "dec_00000001",
        causationId: "evt_00000001",
      },
      {
        seq: 1,
        eventId: "llmce_00000001",
        type: "llm.cache.stored",
        correlationId: "dec_00000001",
        causationId: "llmce_00000000",
      },
      {
        seq: 2,
        eventId: "llmce_00000002",
        type: "llm.cache.hit",
        causationId: "evt_00000001",
      },
    ]);
    expect(computeLogicalStateHash(fixture.db, TEST_RUN_ID)).toBe(beforeHash);
    expect(fixture.db.prepare<[string], { next_event_seq: bigint }>(`
      SELECT next_event_seq FROM simulation_runs WHERE id = ?
    `).get(TEST_RUN_ID)?.next_event_seq).toBe(1n);

    fixture.db.close();
    const reopened = track(openWorldDatabase(
      fixture.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    store = new SqliteLlmResponseCache(reopened, TEST_RUN_ID);
    const replayUpstream = new MockLlmProvider({ model: "mock-pinned" });
    const replay = new CachedLlmProvider({
      provider: replayUpstream,
      cache: store,
      mode: "cache_only",
    });
    expect(await replay.propose(request())).toMatchObject({
      ok: true,
      cached: true,
      value: choice,
    });
    expect(replayUpstream.calls).toHaveLength(0);
    expect(store.listEvents().at(-1)).toMatchObject({
      seq: 3,
      type: "llm.cache.hit",
    });
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(beforeHash);
  });

  it("rejects missing causes and immutable conflicts atomically", async () => {
    const { db } = createDatabase();
    const store = new SqliteLlmResponseCache(db, TEST_RUN_ID);
    const upstream = new MockLlmProvider({
      script: new Map([["decision.tier2.demo", choice]]),
      model: "mock-pinned",
    });
    await new CachedLlmProvider({ provider: upstream, cache: store }).propose(request());
    const record = store.list()[0]!;
    const eventCount = store.listEvents().length;

    expect(() => store.put({
      record: normalizeLlmCachedResponse({
        ...record,
        value: { actionId: "wait", rationale: "Different immutable answer." },
      }),
      correlationId: "dec_00000001",
      causationId: "evt_00000001",
    })).toThrow(EngineError);
    expect(store.count()).toBe(1);
    expect(store.listEvents()).toHaveLength(eventCount);

    expect(() => store.recordTelemetry({
      type: "llm.cache.hit",
      key: record.key,
      keyHash: record.keyHash,
      mode: "cache_only",
      correlationId: "dec_00000001",
      causationId: "evt_missing",
    })).toThrow(/does not exist/);
    expect(store.listEvents()).toHaveLength(eventCount);
    expect(() => db.prepare("UPDATE llm_response_cache SET response_model = 'changed'").run())
      .toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM llm_cache_events").run())
      .toThrow(/append-only/);
  });

  it("rolls back a storage audit event when the cache row cannot commit", async () => {
    const { db } = createDatabase();
    const store = new SqliteLlmResponseCache(db, TEST_RUN_ID);
    db.exec(`
      CREATE TRIGGER llm_response_cache_injected_failure
      BEFORE INSERT ON llm_response_cache
      BEGIN SELECT RAISE(ABORT, 'injected cache write failure'); END;
    `);

    const result = await new CachedLlmProvider({
      provider: new MockLlmProvider({
        script: new Map([["decision.tier2.demo", choice]]),
        model: "mock-pinned",
      }),
      cache: store,
    }).propose(request());

    expect(result).toMatchObject({
      ok: false,
      reason: "schema_invalid",
      providerError: { code: "cache_corrupt" },
    });
    expect(store.count()).toBe(0);
    expect(store.listEvents().map((event) => ({ seq: event.seq, type: event.type })))
      .toEqual([
        { seq: 0, type: "llm.cache.miss" },
        { seq: 1, type: "llm.cache.corrupt" },
      ]);
  });

  it("exports and atomically imports checksummed cache-only replay artifacts", async () => {
    const source = createDatabase("worldtangle-llm-cache-source-");
    const sourceStore = new SqliteLlmResponseCache(source.db, TEST_RUN_ID);
    await new CachedLlmProvider({
      provider: new MockLlmProvider({
        script: new Map([["decision.tier2.demo", choice]]),
        model: "mock-pinned",
      }),
      cache: sourceStore,
    }).propose(request());
    const artifact = sourceStore.exportArtifact();

    const target = createDatabase("worldtangle-llm-cache-target-");
    const targetStore = new SqliteLlmResponseCache(target.db, TEST_RUN_ID);
    expect(() => targetStore.importArtifact(
      { ...artifact, digest: "0".repeat(64) },
      { correlationId: "import_00000001", causationId: "evt_00000001" },
    )).toThrow(/checksum/);
    expect(targetStore.count()).toBe(0);
    expect(targetStore.listEvents()).toHaveLength(0);

    expect(targetStore.importArtifact(artifact, {
      correlationId: "import_00000001",
      causationId: "evt_00000001",
    })).toEqual({ imported: 1, skipped: 0, eventId: "llmce_00000000" });
    expect(targetStore.listEvents()[0]).toMatchObject({
      type: "llm.cache.imported",
      correlationId: "import_00000001",
      causationId: "evt_00000001",
      payload: {
        artifactDigest: artifact.digest,
        sourceRunId: TEST_RUN_ID,
        imported: 1,
      },
    });

    const replayUpstream = new MockLlmProvider({ model: "mock-pinned" });
    expect(await new CachedLlmProvider({
      provider: replayUpstream,
      cache: targetStore,
      mode: "cache_only",
    }).propose(request())).toMatchObject({ ok: true, cached: true, value: choice });
    expect(replayUpstream.calls).toHaveLength(0);

    const eventCount = targetStore.listEvents().length;
    expect(targetStore.importArtifact(artifact, {
      correlationId: "import_00000002",
      causationId: "evt_00000001",
    })).toEqual({ imported: 0, skipped: 1 });
    expect(targetStore.listEvents()).toHaveLength(eventCount);
    expect(targetStore.exportArtifact()).toEqual(artifact);
  });

  it("restores cache rows and audit evidence exactly from a SQLite snapshot", async () => {
    const fixture = createDatabase();
    const store = new SqliteLlmResponseCache(fixture.db, TEST_RUN_ID);
    await new CachedLlmProvider({
      provider: new MockLlmProvider({
        script: new Map([["decision.tier2.demo", choice]]),
        model: "mock-pinned",
      }),
      cache: store,
    }).propose(request());
    const beforeSnapshotArtifact = store.exportArtifact();
    const cacheEvents = store.listEvents();
    const hashBeforeCacheMetadata = computeLogicalStateHash(fixture.db, TEST_RUN_ID);

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
    const restoredDb = track(openDatabaseFile(restoredPath));
    const restoredStore = new SqliteLlmResponseCache(restoredDb, TEST_RUN_ID);

    expect(restoredStore.exportArtifact()).toEqual(beforeSnapshotArtifact);
    expect(restoredStore.listEvents()).toEqual(cacheEvents);
    expect(computeLogicalStateHash(restoredDb, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(snapshot.stateHash).not.toBe(hashBeforeCacheMetadata);

    const replayUpstream = new MockLlmProvider({ model: "mock-pinned" });
    expect(await new CachedLlmProvider({
      provider: replayUpstream,
      cache: restoredStore,
      mode: "cache_only",
    }).propose(request())).toMatchObject({ ok: true, cached: true });
    expect(replayUpstream.calls).toHaveLength(0);
    expect(computeLogicalStateHash(restoredDb, TEST_RUN_ID)).toBe(snapshot.stateHash);
  });
});
