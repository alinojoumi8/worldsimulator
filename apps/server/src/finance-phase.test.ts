import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdFactory, Rng } from "@worldtangle/shared";
import type { EventEnvelope } from "@worldtangle/shared";
import { generateRiverbendPopulation, simDateForTick } from "@worldtangle/engine";
import type { TickContext } from "@worldtangle/engine";
import { createFinancePhaseHandlers } from "./finance-phase";
import {
  openWorldDatabase,
  SqliteAgentStore,
  SqliteFinanceStore,
} from "./persistence";
import type { WorldDatabase } from "./persistence";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./persistence/test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("finance obligations phase", () => {
  it("emits missed payroll without partial tax or negative employer cash", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-finance-phase-"));
    directories.push(dataDir);
    const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(db);
    insertTestRun(db);
    const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 44 });
    const triggers = new Map(population.residents.map((resident) => [
      resident.agent.id,
      `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
    ]));
    new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggers);
    const ids = IdFactory.restore(population.idState);
    const store = new SqliteFinanceStore(db, TEST_RUN_ID);
    store.initialize(population, ids);
    const obligation = store.listPayrollObligations()
      .find((candidate) => candidate.employerId.startsWith("biz_"))!;
    db.prepare(`
      UPDATE bank_accounts SET balance_cents = '0'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, obligation.employerAccountId);
    store.schedulePolicyChange({
      id: ids.next("pol"),
      key: "personal_withholding_rate_bp",
      valueInteger: "0",
      effectiveTick: 15,
      source: "admin",
      causeEventId: "evt_00000001",
      actor: { kind: "admin", id: "api" },
    });
    const treasury = store.systemAccount("government", "inst_town_riverbend");
    db.prepare(`
      UPDATE bank_accounts SET balance_cents = '0'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, treasury.id);

    const emitted: EventEnvelope[] = [];
    let transactionCount = 0;
    const ctx: TickContext = {
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      tick: 15,
      simDate: simDateForTick(15),
      phase: "obligations",
      ids,
      rng: (key) => Rng.root(44).fork(key),
      count: (kind, amount = 1) => {
        if (kind === "transactions") transactionCount += amount;
      },
      setDigestIndicators: () => undefined,
      emit: (type, payload, options) => {
        const event: EventEnvelope = {
          eventId: ids.next("evt"),
          type,
          schemaVersion: 1,
          simulationId: TEST_SIMULATION_ID,
          runId: TEST_RUN_ID,
          seq: emitted.length,
          tick: 15,
          simDate: simDateForTick(15),
          wallTime: "T15",
          actor: options?.actor ?? { kind: "system", id: "engine" },
          correlationId: options?.correlationId ?? `test-${emitted.length}`,
          ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
          payload,
        };
        emitted.push(event);
        return event;
      },
    };
    const obligations = createFinancePhaseHandlers(db, TEST_RUN_ID)
      .find((entry) => entry.phase === "obligations")!;
    obligations.handler.run(ctx);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: "payroll.missed",
      payload: expect.objectContaining({
        contractId: obligation.contractId,
        reason: "insufficient_employer_funds",
      }),
    }));
    expect(store.accountBalance(obligation.employerAccountId)).toBe(0n);
    expect(emitted.some((event) => event.type === "benefit.suspended")).toBe(true);
    expect(store.accountBalance(treasury.id)).toBe(0n);
    expect(db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM ledger_transactions
      WHERE run_id = ? AND correlation_id = ?
    `).get(TEST_RUN_ID, `payroll:15:${obligation.contractId}`)?.count).toBe(0n);
    expect(transactionCount).toBeGreaterThan(0);
  });
});
