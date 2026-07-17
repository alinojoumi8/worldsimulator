import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdFactory, ledgerTransactionSchema } from "@worldtangle/shared";
import { generateRiverbendPopulation } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openWorldDatabase } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-finance-store-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggers = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggers);
  const ids = IdFactory.restore(population.idState);
  const store = new SqliteFinanceStore(db, TEST_RUN_ID);
  const genesis = store.initialize(population, ids);
  return { db, population, store, genesis, ids };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteFinanceStore genesis", () => {
  it("migrates every endowment to balanced mint postings and reconciled account caches", () => {
    const { genesis, store } = fixture();
    const externalBalances = store.listAccounts()
      .filter((account) => account.ownerKind !== "bank_internal" && account.ownerKind !== "system_row")
      .reduce((sum, account) => sum + BigInt(account.balanceCents), 0n);
    const mintDebits = genesis.mintTransactions.reduce((total, transaction) => {
      const debits = transaction.legs
        .filter((leg) => leg.direction === "debit")
        .reduce((sum, leg) => sum + BigInt(leg.amountCents), 0n);
      const credits = transaction.legs
        .filter((leg) => leg.direction === "credit")
        .reduce((sum, leg) => sum + BigInt(leg.amountCents), 0n);
      expect(debits).toBe(credits);
      return total + debits;
    }, 0n);

    expect(mintDebits).toBe(externalBalances);
    expect(externalBalances).toBe(528_000_000n);
    expect(store.reconcile()).toEqual([]);
    expect(store.auditConservation()).toEqual([]);
    expect(genesis.employmentContractIds).toHaveLength(72);
    expect(store.listPayrollObligations()).toHaveLength(72);
    expect(store.recomputeIndicators(0)).toMatchObject({
      gdp_proxy_cents: "0",
      cpi_index: "1000",
      m1_cents: "510000000",
      unemployment_rate_bp: "649",
      active_business_count: "14",
      treasury_balance_cents: "18000000",
      sentiment_index_bp: "0",
    });
  });

  it("persists ten versioned immutable points atomically with exact input digests", () => {
    const { db, store } = fixture();
    const genesisRows = db.prepare<[string], {
      indicator_key: string;
      formula_version: bigint;
      inputs_digest: string;
    }>(`
      SELECT indicator_key, formula_version, inputs_digest FROM indicator_points
      WHERE run_id = ? AND tick = 0 ORDER BY indicator_key
    `).all(TEST_RUN_ID);
    expect(genesisRows).toHaveLength(10);
    expect(genesisRows.every((row) => (
      row.formula_version === 1n && /^[0-9a-f]{64}$/.test(row.inputs_digest)
    ))).toBe(true);
    expect(new Set(genesisRows.map((row) => row.inputs_digest)).size).toBe(10);
    expect(() => db.prepare(`
      UPDATE indicator_points SET value_integer = '1'
      WHERE run_id = ? AND tick = 0 AND indicator_key = 'cpi_index'
    `).run(TEST_RUN_ID)).toThrow(/immutable/);

    db.prepare(`
      INSERT INTO indicator_points(
        run_id, tick, indicator_key, value_integer, formula_version, inputs_digest
      ) VALUES (?, 1, 'sentiment_index_bp', '0', 1, ?)
    `).run(TEST_RUN_ID, "a".repeat(64));
    const snapshot = store.computeIndicatorSnapshot(1);
    expect(() => store.insertIndicatorPoints(1, snapshot)).toThrow(/UNIQUE/);
    expect(db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM indicator_points WHERE run_id = ? AND tick = 1
    `).get(TEST_RUN_ID)?.count).toBe(1n);
  });

  it("enforces immutable ownership, account floors, idempotency, and policy capabilities", () => {
    const { db, store, genesis, ids } = fixture();
    const sender = store.accountForAgent("agt_00000001");
    const recipient = store.accountForAgent("agt_00000002");
    const amount = BigInt(sender.balanceCents) + 1n;
    const tooLarge = ledgerTransactionSchema.parse({
      id: ids.next("txn"),
      runId: TEST_RUN_ID,
      tick: 1,
      kind: "transfer",
      actor: { kind: "agent", id: "agt_00000001" },
      reason: "floor test",
      sourceEventId: null,
      correlationId: "floor-test",
      idempotencyKey: "floor-test",
      legs: [
        { accountId: recipient.id, direction: "debit", amountCents: amount.toString() },
        { accountId: sender.id, direction: "credit", amountCents: amount.toString() },
      ],
    });
    expect(() => store.post(tooLarge)).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_FUNDS" }),
    );
    expect(() => db.prepare(`
      UPDATE bank_accounts SET owner_id = 'agt_00000002'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, sender.id)).toThrow("ownership and identity are immutable");

    const exact = ledgerTransactionSchema.parse({
      ...tooLarge,
      id: ids.next("txn"),
      correlationId: "idempotency-test",
      idempotencyKey: "idempotency-test",
      legs: [
        { accountId: recipient.id, direction: "debit", amountCents: "1" },
        { accountId: sender.id, direction: "credit", amountCents: "1" },
      ],
    });
    expect(store.post(exact).duplicate).toBe(false);
    expect(store.post({ ...exact, id: ids.next("txn") })).toMatchObject({
      duplicate: true,
      warning: "duplicate_idempotency_key_ignored",
    });

    expect(() => store.openAccount({
      id: ids.next("acct"),
      bankId: genesis.bankId,
      ownerKind: "agent",
      ownerId: "agt_00000002",
      type: "checking",
      floorCents: "0",
      openedTick: 1,
      actor: { kind: "agent", id: "agt_00000001" },
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => store.schedulePolicyChange({
      id: ids.next("pol"),
      key: "personal_withholding_rate_bp",
      valueInteger: "1600",
      effectiveTick: 2,
      source: "admin",
      causeEventId: "evt_00000001",
      actor: { kind: "agent", id: "agt_00000001" },
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    store.schedulePolicyChange({
      id: ids.next("pol"),
      key: "personal_withholding_rate_bp",
      valueInteger: "1600",
      effectiveTick: 2,
      source: "admin",
      causeEventId: "evt_00000001",
      actor: { kind: "admin", id: "api" },
    });
    expect(store.policyValue("personal_withholding_rate_bp", 1)).toBe(1_500n);
    expect(store.policyValue("personal_withholding_rate_bp", 2)).toBe(1_600n);
  });
});
