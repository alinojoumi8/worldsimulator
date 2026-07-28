import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PILOT_FIXTURE_TICKS,
  AGENT_LAB_PROTOCOL_VERSION,
  canonicalStringify,
  EngineError,
  IdFactory,
} from "@worldtangle/shared";
import type {
  AgentLabScenario,
  RunManifestAgentLab,
  SimulationRun,
} from "@worldtangle/shared";
import { createContractFromTemplate, EventBus, SimLoop } from "@worldtangle/engine";
import { createPhase4Handlers } from "../phase4-phase";
import { openDatabaseFile, openWorldDatabase, worldDatabasePath } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteRunRepository } from "./run-repository";
import { SqlitePhase4Store } from "./phase4-store";
import { SqliteScheduler } from "./scheduler";
import {
  computeLogicalStateHash,
  snapshotFilePath,
  SqliteSnapshotStore,
} from "./snapshot-store";
import {
  insertTestRun,
  testRun,
  testSimulation,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";
import { readRunCheckpoint, SqliteTickCommitter } from "./tick-committer";

const temporaryDirectories: string[] = [];
const openDatabases: WorldDatabase[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-snapshot-"));
  temporaryDirectories.push(path);
  return path;
}

function track(db: WorldDatabase): WorldDatabase {
  openDatabases.push(db);
  return db;
}

function createRunDatabase(): { dataDir: string; db: WorldDatabase } {
  const dataDir = temporaryDirectory();
  const db = track(openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID));
  insertTestRun(db);
  db.prepare(`
    UPDATE simulation_runs SET status = 'paused', started_wall = 'T0' WHERE id = ?
  `).run(TEST_RUN_ID);
  return { dataDir, db };
}

function updateScenarioCanonical(
  db: WorldDatabase,
  payload: Record<string, unknown>,
): void {
  db.prepare(`
    UPDATE simulations SET scenario_canonical = ? WHERE id = ?
  `).run(canonicalStringify(payload), TEST_SIMULATION_ID);
}

function buildLoop(db: WorldDatabase): { loop: SimLoop; eventStore: SqliteEventStore } {
  const checkpoint = readRunCheckpoint(db, TEST_RUN_ID);
  const eventStore = new SqliteEventStore(db, TEST_RUN_ID);
  const committer = new SqliteTickCommitter(db, eventStore);
  const loop = new SimLoop({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seed: 42,
    bus: new EventBus(),
    log: eventStore,
    tickCommitter: committer,
    tickUnitOfWork: committer,
    initialTick: checkpoint.currentTick,
    nextSeq: checkpoint.nextEventSeq,
    ids: IdFactory.restore(checkpoint.idState),
    wallClock: () => "T0",
  });
  for (const phase4 of createPhase4Handlers(db, TEST_RUN_ID)) {
    loop.registerPhase(phase4.phase, phase4.handler);
  }
  return { loop, eventStore };
}

function logicalAgentLabFixture(
  agentLabMode: "native" | "shadow",
  fixtureTicks: readonly number[] | null = AGENT_LAB_PILOT_FIXTURE_TICKS,
  resolvedAgentId = "agt_00000001",
): RunManifestAgentLab {
  return {
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: "logical-state-provenance",
    trialId: `logical-state-${agentLabMode}`,
    experimentManifestDigest: "a".repeat(64),
    mode: agentLabMode,
    controllerAssignments: [{
      agentId: "agt_00000001",
      controller: agentLabMode,
    }],
    ...(fixtureTicks === null
      ? {}
      : {
          opportunityFixture: {
            version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
            ticks: [...fixtureTicks],
          },
        }),
    decisionDeadlineMs: 5_000,
    budget: {
      maxAgentLoopIterations: 8,
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      maxToolCalls: 8,
    },
    driverPolicyDigest: "b".repeat(64),
    promptDigest: "c".repeat(64),
    toolSchemaDigest: "d".repeat(64),
    resolvedAssignments: [{
      agentId: resolvedAgentId,
      controller: agentLabMode,
    }],
  };
}

function logicalAgentLabScenario(
  agentLabMode: "native" | "shadow",
  fixtureTicks: readonly number[] | null = AGENT_LAB_PILOT_FIXTURE_TICKS,
): AgentLabScenario {
  const {
    resolvedAssignments,
    ...scenario
  } = logicalAgentLabFixture(agentLabMode, fixtureTicks);
  if (resolvedAssignments.length === 0) {
    throw new Error("logical Agent Lab fixture must include a resolved assignment");
  }
  return scenario;
}

function insertRunWithWallTime(
  db: WorldDatabase,
  wallTime: string,
  agentLabMode?: "native" | "shadow",
  fixtureTicks: readonly number[] | null = AGENT_LAB_PILOT_FIXTURE_TICKS,
  resolvedAgentId?: string,
  worldSpec = "test@1",
): void {
  const baseRun = testRun();
  const agentLab = agentLabMode === undefined
    ? undefined
    : logicalAgentLabFixture(agentLabMode, fixtureTicks, resolvedAgentId);
  const run: SimulationRun = {
    ...baseRun,
    manifest: {
      ...baseRun.manifest,
      createdWall: wallTime,
      ...(agentLab === undefined
        ? {}
        : {
            agentLab,
            scenarioDigest: (agentLabMode === "native" ? "1" : "2").repeat(64),
          }),
    },
  };
  new SqliteRunRepository(db).createSimulationWithRun(
    testSimulation({
      createdWall: wallTime,
      scenario: {
        worldSpec,
        ...(agentLabMode === undefined
          ? {}
          : { agentLab: logicalAgentLabScenario(agentLabMode, fixtureTicks) }),
      },
    }),
    run,
  );
}

function insertStandardRunWithScenarioDigest(
  db: WorldDatabase,
  wallTime: string,
  scenarioDigest: string,
): void {
  const baseRun = testRun();
  new SqliteRunRepository(db).createSimulationWithRun(
    testSimulation({
      createdWall: wallTime,
      scenario: { worldSpec: "test@1" },
    }),
    {
      ...baseRun,
      manifest: {
        ...baseRun.manifest,
        createdWall: wallTime,
        scenarioDigest,
      },
    },
  );
}

function captureError(callback: () => unknown): EngineError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    if (!(error instanceof EngineError)) throw error;
    return error;
  }
  throw new Error("expected callback to throw");
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) if (db.open) db.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SqliteSnapshotStore", () => {
  it("separates Agent Lab runs from standard runs into distinct hash families", () => {
    const standard = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const agentLab = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(standard, "wall-one");
    insertRunWithWallTime(agentLab, "wall-one", "native");

    expect(computeLogicalStateHash(agentLab, TEST_RUN_ID)).not.toBe(
      computeLogicalStateHash(standard, TEST_RUN_ID),
    );
  });

  it("backs up the current committed tick and records a stable logical hash", async () => {
    const { dataDir, db } = createRunDatabase();
    buildLoop(db).loop.advance(2);
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const before = store.stateHash();

    const snapshot = await store.create({ createdWall: "snapshot-wall-1" });

    expect(snapshot).toEqual({
      id: "snap_00000002",
      runId: TEST_RUN_ID,
      tick: 2,
      stateHash: store.stateHash(),
      relativePath: `${TEST_SIMULATION_ID}/${TEST_RUN_ID}/snapshots/snap_00000002.db`,
      createdWall: "snapshot-wall-1",
    });
    expect(store.list()).toEqual([snapshot]);
    expect(store.stateHash()).not.toBe(before);
    const snapshotEvents = new SqliteEventStore(db, TEST_RUN_ID).list({
      fromSeq: 4,
    });
    expect(snapshotEvents).toMatchObject([
      {
        eventId: "evt_00000005",
        type: "simulation.statehash.computed",
        seq: 4,
        tick: 2,
        actor: { kind: "system", id: "snapshot-store" },
        correlationId: snapshot.id,
        payload: { tick: 2, stateHash: snapshot.stateHash },
      },
      {
        eventId: "evt_00000006",
        type: "simulation.snapshot.created",
        seq: 5,
        tick: 2,
        actor: { kind: "system", id: "snapshot-store" },
        correlationId: snapshot.id,
        payload: {
          snapshotId: snapshot.id,
          tick: 2,
          stateHash: snapshot.stateHash,
        },
      },
    ]);
    expect(existsSync(snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    ))).toBe(true);
    expect(existsSync(`${snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    )}.tmp`)).toBe(false);
  });

  it("restores and advances equivalently to the straight-through run", async () => {
    const { dataDir, db } = createRunDatabase();
    buildLoop(db).loop.advance(2);
    const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
    const contractIds = new IdFactory();
    const contract = createContractFromTemplate({
      id: "ctr_00000001",
      runId: TEST_RUN_ID,
      type: "service",
      parties: [
        { kind: "institution", id: "provider", role: "provider" },
        { kind: "institution", id: "client", role: "client" },
      ],
      terms: {
        template: "service",
        providerId: "provider",
        clientId: "client",
        scope: "Snapshot equivalence service",
        feeCents: "1000",
        dueTick: 3,
      },
      draftedBy: { kind: "system", id: "engine" },
      createdTick: 2,
      effectiveTick: 3,
      ids: contractIds,
    });
    phase4.insertLegalContract(contract);
    phase4.signContract(contract.id, { kind: "institution", id: "provider" }, 2);
    phase4.signContract(contract.id, { kind: "institution", id: "client" }, 2);
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await store.create({ createdWall: "snapshot-wall" });
    const snapshotLogHash = new SqliteEventStore(db, TEST_RUN_ID).logHash();
    buildLoop(db).loop.tick();
    expect(readRunCheckpoint(db, TEST_RUN_ID).currentTick).toBe(3);
    const straightStateHash = computeLogicalStateHash(db, TEST_RUN_ID);
    const straightLogHash = new SqliteEventStore(db, TEST_RUN_ID).logHash();

    const destination = join(dataDir, "restored", "world.db");
    expect(store.restoreTo(snapshot.id, destination)).toBe(destination);
    let restored = track(openDatabaseFile(destination));
    expect(readRunCheckpoint(restored, TEST_RUN_ID).currentTick).toBe(2);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(snapshotLogHash);

    buildLoop(restored).loop.tick();
    expect(readRunCheckpoint(restored, TEST_RUN_ID).currentTick).toBe(3);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(straightStateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(straightLogHash);

    restored.close();
    restored = track(openDatabaseFile(destination));
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(straightStateHash);
    expect(new SqliteEventStore(restored, TEST_RUN_ID).logHash()).toBe(straightLogHash);
  });

  it("cleans temporary and renamed files when creation fails before metadata commit", async () => {
    const { dataDir, db } = createRunDatabase();
    const finalPath = snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      "snap_00000000",
    );
    const failing = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      { afterRename: () => { throw new Error("injected after rename"); } },
    );

    await expect(failing.create({ createdWall: "snapshot-wall" })).rejects.toThrow(
      "snapshot creation failed",
    );
    expect(existsSync(finalPath)).toBe(false);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
    expect(db.prepare<[], { count: bigint }>(
      "SELECT COUNT(*) AS count FROM snapshots",
    ).get()?.count).toBe(0n);

    // Simulate residue left by a hard process exit after rename and during a
    // later backup. With no immutable metadata row, both files are recoverable orphans.
    writeFileSync(finalPath, "orphaned-final");
    writeFileSync(`${finalPath}.tmp`, "orphaned-temporary");

    const retry = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    await expect(retry.create({ createdWall: "retry-wall" })).resolves.toMatchObject({
      id: "snap_00000000",
      tick: 0,
    });
  });

  it("excludes wall-time and migration metadata while hashing logical state", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(first, "wall-one", "native");
    insertRunWithWallTime(second, "wall-two", "native");
    second.prepare(`
      UPDATE schema_migrations SET name = 'non_authoritative', checksum = 'ignored'
    `).run();

    const expected = computeLogicalStateHash(first, TEST_RUN_ID);
    expect(computeLogicalStateHash(second, TEST_RUN_ID)).toBe(expected);

    new SqliteScheduler(second, TEST_RUN_ID).schedule({
      id: "task_00000001",
      dueTick: 10,
      order: 0,
      taskRef: "demo.task",
      payload: { amount: 10n },
    });
    expect(computeLogicalStateHash(second, TEST_RUN_ID)).not.toBe(expected);
  });

  it("hashes matched native and shadow Agent Lab arms identically", () => {
    const native = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const shadow = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(native, "same-wall", "native", [10, 30, 50]);
    insertRunWithWallTime(shadow, "same-wall", "shadow", [10, 30, 50]);

    expect(computeLogicalStateHash(shadow, TEST_RUN_ID)).toBe(
      computeLogicalStateHash(native, TEST_RUN_ID),
    );
  });

  it("hashes identically configured Agent Lab runs stably", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(first, "same-wall", "native", [10, 30, 50]);
    insertRunWithWallTime(second, "same-wall", "native", [10, 30, 50]);

    expect(computeLogicalStateHash(second, TEST_RUN_ID)).toBe(
      computeLogicalStateHash(first, TEST_RUN_ID),
    );
  });

  it("excludes resolved assignments from Agent Lab provenance hashes", () => {
    const aligned = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const independentlyResolved = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(aligned, "same-wall", "native", [10, 30, 50]);
    insertRunWithWallTime(
      independentlyResolved,
      "same-wall",
      "native",
      [10, 30, 50],
      "agt_00000002",
    );

    expect(computeLogicalStateHash(independentlyResolved, TEST_RUN_ID)).toBe(
      computeLogicalStateHash(aligned, TEST_RUN_ID),
    );
  });

  it("hashes fixture-less Agent Lab runs in the Agent Lab state family", () => {
    const native = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const shadow = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const fixtured = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const standard = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(native, "same-wall", "native", null);
    insertRunWithWallTime(shadow, "same-wall", "shadow", null);
    insertRunWithWallTime(fixtured, "same-wall", "native", [10, 30, 50]);
    insertRunWithWallTime(standard, "same-wall");

    const fixturelessHash = computeLogicalStateHash(native, TEST_RUN_ID);
    expect(computeLogicalStateHash(shadow, TEST_RUN_ID)).toBe(fixturelessHash);
    expect(fixturelessHash).not.toBe(
      computeLogicalStateHash(fixtured, TEST_RUN_ID),
    );
    expect(fixturelessHash).not.toBe(
      computeLogicalStateHash(standard, TEST_RUN_ID),
    );
  });

  it("retains Agent Lab fixture schedules in logical state hashes", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(first, "same-wall", "native", [10, 30, 50]);
    insertRunWithWallTime(second, "same-wall", "native", [11, 30, 50]);

    expect(computeLogicalStateHash(second, TEST_RUN_ID)).not.toBe(
      computeLogicalStateHash(first, TEST_RUN_ID),
    );
  });

  it("retains scenario digests in standard-run logical state hashes", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertStandardRunWithScenarioDigest(first, "same-wall", "1".repeat(64));
    insertStandardRunWithScenarioDigest(second, "same-wall", "2".repeat(64));

    expect(computeLogicalStateHash(second, TEST_RUN_ID)).not.toBe(
      computeLogicalStateHash(first, TEST_RUN_ID),
    );
  });

  it("retains Agent Lab scenario bodies when scenarioDigest is excluded", () => {
    const first = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    const second = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(
      first,
      "same-wall",
      "native",
      [10, 30, 50],
      undefined,
      "test@1",
    );
    insertRunWithWallTime(
      second,
      "same-wall",
      "native",
      [10, 30, 50],
      undefined,
      "test@2",
    );

    expect(computeLogicalStateHash(second, TEST_RUN_ID)).not.toBe(
      computeLogicalStateHash(first, TEST_RUN_ID),
    );
  });

  it("rejects Agent Lab presence disagreement between manifest and scenario", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native");
    updateScenarioCanonical(db, { worldSpec: "test@1" });

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted run manifest and simulation scenario disagree on Agent Lab presence",
      details: {
        manifestHasAgentLab: true,
        scenarioHasAgentLab: false,
      },
    });
  });

  it("rejects a scenario Agent Lab configuration missing from the run manifest", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native");
    const run = new SqliteRunRepository(db).getRun(TEST_RUN_ID);
    const {
      agentLab,
      ...manifestWithoutAgentLab
    } = run.manifest;
    expect(agentLab).toBeDefined();
    db.exec("DROP TRIGGER simulation_runs_manifest_immutable");
    db.prepare(`
      UPDATE simulation_runs SET manifest_canonical = ? WHERE id = ?
    `).run(
      canonicalStringify(manifestWithoutAgentLab),
      TEST_RUN_ID,
    );

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted run manifest and simulation scenario disagree on Agent Lab presence",
      details: {
        manifestHasAgentLab: false,
        scenarioHasAgentLab: true,
      },
    });
  });

  it("rejects divergent persisted Agent Lab provenance", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native", [10, 30, 50]);
    const scenarioAgentLab = logicalAgentLabScenario("native", [11, 30, 50]);
    updateScenarioCanonical(db, {
      worldSpec: "test@1",
      agentLab: scenarioAgentLab,
    });

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted run manifest and simulation scenario disagree on Agent Lab provenance content",
      details: {
        manifestAgentLabProvenance: logicalAgentLabScenario(
          "native",
          [10, 30, 50],
        ),
        scenarioAgentLabProvenance: scenarioAgentLab,
      },
    });
  });

  it("reports the malformed persisted Agent Lab value and its source", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native", [10, 30, 50]);
    updateScenarioCanonical(db, {
      worldSpec: "test@1",
      agentLab: null,
    });

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted simulation scenario Agent Lab configuration is not an object",
      details: {
        field: "simulation scenario",
        source: "scenario",
        value: null,
      },
    });
  });

  it("reports a malformed persisted run manifest Agent Lab value and its source", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native", [10, 30, 50]);
    const run = new SqliteRunRepository(db).getRun(TEST_RUN_ID);
    // Emulate on-disk corruption that bypassed the normal immutable write path.
    db.exec("DROP TRIGGER simulation_runs_manifest_immutable");
    db.prepare(`
      UPDATE simulation_runs SET manifest_canonical = ? WHERE id = ?
    `).run(
      canonicalStringify({ ...run.manifest, agentLab: null }),
      TEST_RUN_ID,
    );

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted run manifest Agent Lab configuration is not an object",
      details: {
        field: "run manifest",
        source: "manifest",
        value: null,
      },
    });
  });

  it("rejects changed controller assignments even when the fixture is unchanged", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native", [10, 30, 50]);
    const scenarioAgentLab = logicalAgentLabScenario("native", [10, 30, 50]);
    updateScenarioCanonical(db, {
      worldSpec: "test@1",
      agentLab: {
        ...scenarioAgentLab,
        controllerAssignments: [{
          agentId: "agt_00000002",
          controller: "native",
        }],
      },
    });

    expect(() => computeLogicalStateHash(db, TEST_RUN_ID)).toThrow(
      /manifest and simulation scenario disagree on Agent Lab provenance content/,
    );
  });

  it("rejects a malformed persisted Agent Lab fixture", () => {
    const db = track(openWorldDatabase(
      temporaryDirectory(),
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    insertRunWithWallTime(db, "wall-one", "native", [10, 30, 50]);
    updateScenarioCanonical(db, {
      worldSpec: "test@1",
      agentLab: {
        ...logicalAgentLabScenario("native", [10, 30, 50]),
        opportunityFixture: {
          version: "unknown_fixture",
          ticks: [10, 30, 50],
        },
      },
    });

    expect(captureError(
      () => computeLogicalStateHash(db, TEST_RUN_ID),
    )).toMatchObject({
      code: "INTERNAL",
      message:
        "persisted simulation scenario Agent Lab configuration is invalid",
      details: {
        field: "simulation scenario",
        source: "scenario",
        cause: expect.stringContaining("opportunityFixture"),
      },
    });
  });

  it("keeps snapshot rows/files immutable, rejects duplicate ticks, and validates restore paths", async () => {
    const { dataDir, db } = createRunDatabase();
    const store = new SqliteSnapshotStore(
      db,
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await store.create({ createdWall: "snapshot-wall" });
    const filePath = snapshotFilePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
      snapshot.id,
    );
    const originalBytes = readFileSync(filePath);

    await expect(store.create({ createdWall: "duplicate" })).rejects.toThrow(EngineError);
    expect(readFileSync(filePath).equals(originalBytes)).toBe(true);
    expect(() => db.prepare("UPDATE snapshots SET tick = tick + 1").run()).toThrow(
      /snapshots are immutable/,
    );
    expect(() => db.prepare("DELETE FROM snapshots").run()).toThrow(
      /snapshots are immutable/,
    );
    expect(() => db.prepare(`
      INSERT INTO snapshots(id, run_id, tick, state_hash, relative_path, created_wall)
      VALUES ('snap_00000001', ?, ?, ?, 'other.db', 'wall')
    `).run(TEST_RUN_ID, snapshot.tick, snapshot.stateHash)).toThrow(/UNIQUE/);

    expect(() => store.restoreTo(snapshot.id, worldDatabasePath(
      dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ))).toThrow(/live database/);
    expect(() => store.restoreTo(snapshot.id, join(dataDir, "..", "outside.db"))).toThrow(
      EngineError,
    );
    expect(() => snapshotFilePath(
      dataDir,
      "../outside",
      TEST_RUN_ID,
      snapshot.id,
    )).toThrow(EngineError);
  });
});
