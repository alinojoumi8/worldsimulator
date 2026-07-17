import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  IdFactory,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqlitePhase4ReadStore } from "./phase4-read-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";
import {
  FOUNDRY_CAPITAL_ID,
  FOUNDRY_FUND_SIZE_CENTS,
  SqliteVentureStore,
} from "./venture-store";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function tracked(db: WorldDatabase): WorldDatabase {
  databases.push(db);
  return db;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-venture-"));
  directories.push(dataDir);
  const db = tracked(openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID));
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggerEvents);
  const ids = IdFactory.restore(population.idState);
  new SqliteFinanceStore(db, TEST_RUN_ID).initialize(population, ids);
  const firmEventId = ids.next("evt");
  const fundEventId = ids.next("evt");
  const store = new SqliteVentureStore(db, TEST_RUN_ID);
  const initialized = store.initializeFoundry({
    ids,
    firmSourceEventId: firmEventId,
    fundSourceEventId: fundEventId,
  });
  const events = new SqliteEventStore(db, TEST_RUN_ID);
  events.appendBatch([
    {
      eventId: firmEventId,
      type: "venture.firm.created",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 0,
      tick: 0,
      simDate: "Y0001-M01-D01",
      wallTime: "T0",
      actor: { kind: "system", id: "venture-capital" },
      correlationId: "venture-seed",
      payload: { firmId: initialized.firm.id },
    },
    {
      eventId: fundEventId,
      type: "venture.fund.created",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq: 1,
      tick: 0,
      simDate: "Y0001-M01-D01",
      wallTime: "T0",
      actor: { kind: "institution", id: initialized.firm.id },
      correlationId: "venture-seed",
      causationId: firmEventId,
      payload: { fundId: initialized.fund.id },
    },
  ]);
  db.prepare(`
    UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?
  `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
  const targetCompanyId = population.accounts
    .find((account) => account.ownerKind === "business")!.ownerId;

  return { dataDir, db, ids, store, initialized, targetCompanyId };
}

function context(
  db: WorldDatabase,
  ids: IdFactory,
  tick: number,
): TickContext {
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
    phase: "settlement",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.settlement.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const seq = Number(db.prepare<[string], { next_event_seq: bigint }>(`
        SELECT next_event_seq FROM simulation_runs WHERE id = ?
      `).get(TEST_RUN_ID)!.next_event_seq);
      const event: EventEnvelope = {
        eventId: ids.next("evt"),
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq,
        tick,
        simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
        wallTime: `T${tick}`,
        actor: options?.actor ?? { kind: "system", id: "venture-capital" },
        correlationId: options?.correlationId ?? `venture:${tick}`,
        ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
        payload,
      };
      new SqliteEventStore(db, TEST_RUN_ID).append(event);
      return event;
    },
  };
}

function saveCheckpoint(db: WorldDatabase, ids: IdFactory, tick: number): void {
  db.prepare(`
    UPDATE simulation_runs SET current_tick = ?, id_state_canonical = ? WHERE id = ?
  `).run(tick, canonicalStringify(ids.serialize()), TEST_RUN_ID);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("SqliteVentureStore", () => {
  it("initializes Foundry Capital and tracks deployments without exceeding fund size", () => {
    const base = fixture();
    expect(base.store.listFirms()).toEqual([base.initialized.firm]);
    expect(base.initialized.fund).toMatchObject({
      firmId: FOUNDRY_CAPITAL_ID,
      fundSizeCents: FOUNDRY_FUND_SIZE_CENTS,
      deployedCents: "0",
      status: "open",
    });

    const first = base.store.deployCapital({
      fundId: base.initialized.fund.id,
      targetCompanyId: base.targetCompanyId,
      referenceId: "investment:first",
      amountCents: "120000000",
      evidenceRefs: ["proposal:first"],
    }, context(base.db, base.ids, 1));
    expect(first.fund).toMatchObject({ deployedCents: "120000000", status: "open" });
    expect(first.deployment).toMatchObject({
      deployedBeforeCents: "0",
      deployedAfterCents: "120000000",
    });
    const eventCount = new SqliteEventStore(base.db, TEST_RUN_ID).count();
    expect(() => base.store.deployCapital({
      fundId: base.initialized.fund.id,
      targetCompanyId: base.targetCompanyId,
      referenceId: "investment:too-large",
      amountCents: "380000001",
    }, context(base.db, base.ids, 2))).toThrow(/exceeds undeployed/);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventCount);

    const final = base.store.deployCapital({
      fundId: base.initialized.fund.id,
      targetCompanyId: base.targetCompanyId,
      referenceId: "investment:final",
      amountCents: "380000000",
    }, context(base.db, base.ids, 2));
    expect(final.fund).toMatchObject({
      deployedCents: FOUNDRY_FUND_SIZE_CENTS,
      status: "fully_deployed",
    });
    expect(base.store.listDeployments(final.fund.id)).toHaveLength(2);
    expect(() => base.store.deployCapital({
      fundId: final.fund.id,
      targetCompanyId: base.targetCompanyId,
      referenceId: "investment:after-close",
      amountCents: "1",
    }, context(base.db, base.ids, 3))).toThrow(/is not open/);

    const institution = new SqlitePhase4ReadStore(base.db, TEST_RUN_ID)
      .getInstitution(FOUNDRY_CAPITAL_ID);
    expect(institution).toMatchObject({
      institution: {
        keyFigures: {
          initialized: true,
          fundCount: 1,
          deployedCents: FOUNDRY_FUND_SIZE_CENTS,
          availableCents: "0",
        },
      },
      rulebook: {
        accountingUnit: "integer_cents",
        deploymentLimit: "deployed_cents_lte_fund_size_cents",
      },
    });
  });

  it("rejects direct total tampering and rolls deployment rows and events back together", () => {
    const base = fixture();
    expect(() => base.db.prepare(`
      UPDATE vc_funds SET deployed_cents = '1'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, base.initialized.fund.id)).toThrow(/immutable deployment/);

    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const eventsBefore = new SqliteEventStore(base.db, TEST_RUN_ID).count();
    expect(() => base.db.transaction(() => {
      base.store.deployCapital({
        fundId: base.initialized.fund.id,
        targetCompanyId: base.targetCompanyId,
        referenceId: "investment:rollback",
        amountCents: "1000000",
      }, context(base.db, base.ids, 1));
      throw new Error("rollback venture deployment");
    }).immediate()).toThrow(/rollback venture deployment/);

    expect(base.store.getFund(base.initialized.fund.id).deployedCents).toBe("0");
    expect(base.store.listDeployments(base.initialized.fund.id)).toEqual([]);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventsBefore);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(hashBefore);
  });

  it("reopens and restores with an equivalent next deployment and logical hash", async () => {
    const base = fixture();
    saveCheckpoint(base.db, base.ids, 1);
    const hashBeforeReopen = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();
    const reopened = tracked(openWorldDatabase(
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    ));
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(hashBeforeReopen);
    expect(new SqliteVentureStore(reopened, TEST_RUN_ID).getFund(base.initialized.fund.id))
      .toEqual(base.initialized.fund);

    const snapshots = new SqliteSnapshotStore(
      reopened,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "venture-snapshot-wall" });
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(base.dataDir, "venture-restored", "world.db"),
    );
    const restored = tracked(openDatabaseFile(restoredPath));
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const store = new SqliteVentureStore(db, TEST_RUN_ID);
      const result = store.deployCapital({
        fundId: base.initialized.fund.id,
        targetCompanyId: base.targetCompanyId,
        referenceId: "investment:after-snapshot",
        amountCents: "25000000",
      }, context(db, ids, 2));
      saveCheckpoint(db, ids, 2);
      return { result, hash: computeLogicalStateHash(db, TEST_RUN_ID) };
    };

    const straight = advance(reopened);
    const replayed = advance(restored);
    expect(replayed.result).toEqual(straight.result);
    expect(replayed.hash).toBe(straight.hash);
  });
});
