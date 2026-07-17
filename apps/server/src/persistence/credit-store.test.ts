import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdFactory,
  Rng,
  canonicalStringify,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  calculateCreditScore,
  generateRiverbendPopulation,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { SqliteCreditStore } from "./credit-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

interface RecordedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly options: unknown;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-credit-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggerEvents);
  const ids = IdFactory.restore(population.idState);
  new SqliteFinanceStore(db, TEST_RUN_ID).initialize(population, ids);
  const bankId = db.prepare<[string], { id: string }>(`
    SELECT id FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
  `).get(TEST_RUN_ID)?.id;
  if (bankId === undefined) throw new Error("credit fixture bank is missing");
  const seededBorrower = population.loans.find((loan) => loan.borrowerKind === "agent");
  if (seededBorrower === undefined) throw new Error("credit fixture loan is missing");
  const borrowerIds = new Set(population.loans.map((loan) => loan.borrowerId));
  const noHistoryAgent = population.residents.find((resident) => (
    resident.agent.employmentStatus === "employed" && !borrowerIds.has(resident.agent.id)
  ));
  if (noHistoryAgent === undefined) throw new Error("no-history borrower is missing");
  return {
    dataDir,
    db,
    population,
    ids,
    bankId,
    seededBorrower,
    noHistoryAgentId: noHistoryAgent.agent.id,
  };
}

function context(
  ids: IdFactory,
  tick: number,
  tag: string,
  events: RecordedEvent[] = [],
): TickContext {
  let sequence = 0;
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: "Y0001-M01-D01",
    phase: "execute",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.credit.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const eventId = `evt_${tag}${String(++sequence).padStart(8, "0")}`;
      events.push({ eventId, type, payload, options });
      return { eventId } as EventEnvelope;
    },
  };
}

function request(base: ReturnType<typeof fixture>, applicantId: string) {
  return {
    applicantKind: "agent" as const,
    applicantId,
    bankId: base.bankId,
    purpose: "Replace a failed vehicle",
    amountCents: "600000",
    termMonths: 12,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-501 credit scoring persistence", () => {
  it("stores the exact authoritative inputs, score breakdown, events, and immutable evidence", () => {
    const base = fixture();
    const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const events: RecordedEvent[] = [];
    const beforeHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const result = store.submitApplication(
      request(base, base.seededBorrower.borrowerId),
      context(base.ids, 0, "credit", events),
    );

    expect(result.application).toMatchObject({
      applicantId: base.seededBorrower.borrowerId,
      status: "submitted",
      amountCents: "600000",
      termMonths: 12,
    });
    expect(result.assessment.inputs).toMatchObject({
      modelVersion: 1,
      requestedAmountCents: "600000",
      noHistory: false,
    });
    expect(BigInt(result.assessment.inputs.existingDebtCents)).toBeGreaterThan(0n);
    expect(result.assessment.inputs.completedPayments).toBeGreaterThan(0);
    expect(result.assessment.inputs.debtEvidenceRefs).toContain(base.seededBorrower.id);
    expect(result.assessment.breakdown).toEqual(calculateCreditScore(result.assessment.inputs));
    expect(store.getApplication(result.application.id)).toEqual(result.application);
    expect(store.getAssessmentForApplication(result.application.id)).toEqual(result.assessment);
    expect(events.map((event) => event.type)).toEqual([
      "loan.application.created",
      "loan.score.computed",
    ]);
    expect(events[1]?.options).toMatchObject({ causationId: events[0]?.eventId });
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).not.toBe(beforeHash);
    expect(() => base.db.prepare(`
      UPDATE loan_applications SET amount_cents = '1' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.application.id)).toThrow(/inputs are immutable/);
    expect(() => base.db.prepare(`
      UPDATE credit_score_assessments SET system_score = 300 WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.assessment.id)).toThrow(/assessments are immutable/);
  });

  it("uses the documented neutral no-history factor and rolls failed units of work back", () => {
    const base = fixture();
    const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const result = store.submitApplication(
      request(base, base.noHistoryAgentId),
      context(base.ids, 0, "neutral"),
    );
    expect(result.assessment.inputs).toMatchObject({
      noHistory: true,
      historyScoreBp: 6_000,
      completedPayments: 0,
      missedPayments: 0,
      defaults: 0,
    });

    const beforeCount = store.listApplications().length;
    expect(() => base.db.transaction(() => {
      store.submitApplication(
        request(base, base.seededBorrower.borrowerId),
        context(base.ids, 1, "rollback"),
      );
      throw new Error("rollback credit application");
    }).immediate()).toThrow(/rollback credit application/);
    expect(store.listApplications()).toHaveLength(beforeCount);

    const freshIds = IdFactory.restore(base.population.idState);
    const idStateBefore = freshIds.serialize();
    expect(() => store.submitApplication(
      request(base, "agt_zzzzzzzz"),
      context(freshIds, 1, "missing"),
    )).toThrow(/does not exist/);
    expect(freshIds.serialize()).toEqual(idStateBefore);
  });

  it("reopens with byte-equivalent stored inputs and the same logical state hash", () => {
    const base = fixture();
    const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const result = store.submitApplication(
      request(base, base.seededBorrower.borrowerId),
      context(base.ids, 0, "reopen"),
    );
    base.db.prepare(`
      UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const expectedHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();

    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    const reopenedStore = new SqliteCreditStore(reopened, TEST_RUN_ID);
    expect(reopenedStore.getApplication(result.application.id)).toEqual(result.application);
    expect(reopenedStore.getAssessmentForApplication(result.application.id)).toEqual(
      result.assessment,
    );
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(expectedHash);
  });

  it("restores a scored application and reproduces the next application hash", async () => {
    const base = fixture();
    new SqliteCreditStore(base.db, TEST_RUN_ID).submitApplication(
      request(base, base.seededBorrower.borrowerId),
      context(base.ids, 1, "snapshot"),
    );
    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 1, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "credit-snapshot-wall" });
    const destination = join(base.dataDir, "credit-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const nextApplicationHash = (db: WorldDatabase): string => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      new SqliteCreditStore(db, TEST_RUN_ID).submitApplication(
        request(base, base.noHistoryAgentId),
        context(ids, 2, "equivalent"),
      );
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 2, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(db, TEST_RUN_ID);
    };

    const straightHash = nextApplicationHash(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(nextApplicationHash(restored)).toBe(straightHash);
  });
});
