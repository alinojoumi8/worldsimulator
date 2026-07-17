import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdFactory,
  Rng,
  canonicalStringify,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { SqliteBankCircuitStore } from "./bank-circuit-store";
import { SqliteCreditStore } from "./credit-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

function context(db: WorldDatabase, ids: IdFactory, tick: number): TickContext {
  const events = new SqliteEventStore(db, TEST_RUN_ID);
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: "Y0001-M01-D01",
    phase: "execute",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.bank-circuit.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const eventId = ids.next("evt");
      const event = eventEnvelopeSchema.parse({
        eventId,
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq: events.count(),
        tick,
        simDate: "Y0001-M01-D01",
        wallTime: "bank-circuit-test-wall",
        actor: options?.actor ?? { kind: "system", id: "test" },
        correlationId: options?.correlationId ?? eventId,
        ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
        payload,
      }) as EventEnvelope;
      events.append(event);
      return event;
    },
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-bank-circuit-"));
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
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);
  const bankId = db.prepare<[string], { id: string }>(`
    SELECT id FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
  `).get(TEST_RUN_ID)?.id;
  if (bankId === undefined) throw new Error("bank circuit fixture bank is missing");
  const borrowerIds = new Set(population.loans.map((loan) => loan.borrowerId));
  const applicants = population.residents.filter((resident) => (
    resident.agent.employmentStatus === "employed" && !borrowerIds.has(resident.agent.id)
  )).map((resident) => resident.agent.id);
  if (applicants.length < 2) throw new Error("bank circuit fixture applicants are missing");
  return { dataDir, db, ids, finance, bankId, applicants };
}

function request(base: ReturnType<typeof fixture>, applicantId = base.applicants[0]!) {
  return {
    applicantKind: "agent" as const,
    applicantId,
    bankId: base.bankId,
    purpose: "Replace essential transport",
    amountCents: "600001",
    termMonths: 12,
  };
}

function submitAndReview(
  base: ReturnType<typeof fixture>,
  applicantId: string,
  ticks: readonly [number, number],
) {
  const credit = new SqliteCreditStore(base.db, TEST_RUN_ID);
  const submitted = credit.submitApplication(
    request(base, applicantId),
    context(base.db, base.ids, ticks[0]),
  );
  credit.beginReview(
    submitted.application.id,
    context(base.db, base.ids, ticks[1]),
  );
  return { credit, submitted };
}

function accountBalance(db: WorldDatabase, accountId: string): bigint {
  return BigInt(db.prepare<[string, string], { balance_cents: string }>(`
    SELECT balance_cents FROM bank_accounts WHERE run_id = ? AND id = ?
  `).get(TEST_RUN_ID, accountId)!.balance_cents);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-505 bank circuit-breaker persistence", () => {
  it("records exact live and pro-forma positions at approval and disbursement", () => {
    const base = fixture();
    const prepared = submitAndReview(base, base.applicants[0]!, [1, 2]);
    const decided = prepared.credit.decideTier1Application(
      prepared.submitted.application.id,
      context(base.db, base.ids, 3),
    );
    expect(decided.decision.outcome).toBe("approved");
    const circuits = new SqliteBankCircuitStore(base.db, TEST_RUN_ID);
    const approval = circuits.getLatestForApplication(
      prepared.submitted.application.id,
      "approval",
    );
    expect(approval).toMatchObject({
      stage: "approval",
      decisionId: null,
      depositCents: "528000000",
      projectedDepositCents: "528600001",
      reserveCents: "95040000",
      reserveRatioBp: 1_800,
      projectedReserveRatioBp: 1_797,
      reserveRatioMinBp: 1_200,
      effectiveCapitalCents: "73920000",
      capitalRatioBp: 1_400,
      projectedCapitalRatioBp: 1_398,
      capitalRatioMinBp: 1_000,
      allowed: true,
      failedBreakers: [],
    });

    const attempt = prepared.credit.tryDisburseApprovedApplication(
      prepared.submitted.application.id,
      context(base.db, base.ids, 4),
    );
    expect(attempt.kind).toBe("disbursed");
    if (attempt.kind !== "disbursed") throw new Error("expected disbursement");
    const disbursement = circuits.getLatestForApplication(
      prepared.submitted.application.id,
      "disbursement",
    );
    expect(disbursement).toMatchObject({
      decisionId: decided.decision.id,
      allowed: true,
      projectedDepositCents: "528600001",
    });
    expect(base.finance.listBanks()[0]).toMatchObject({
      totalDeposits: "528600001",
      reserveRatioBp: 1_797,
      capitalRatioBp: 1_398,
      lendingHalted: false,
    });
    expect(() => base.db.prepare(`
      UPDATE bank_lending_assessments SET allowed = 0
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, approval.id)).toThrow(/immutable/);
  });

  it("blocks only the overexposed borrower without globally halting the bank", () => {
    const base = fixture();
    base.db.prepare(`
      UPDATE banks SET exposure_cap_cents = '1' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, base.bankId);
    const prepared = submitAndReview(base, base.applicants[0]!, [1, 2]);
    const decided = prepared.credit.decideTier1Application(
      prepared.submitted.application.id,
      context(base.db, base.ids, 3),
    );
    const assessment = new SqliteBankCircuitStore(base.db, TEST_RUN_ID)
      .getLatestForApplication(prepared.submitted.application.id, "approval");
    expect(assessment).toMatchObject({
      allowed: false,
      systemicPassed: true,
      exposurePassed: false,
      bankStatusAfter: "active",
      failedBreakers: ["borrower_exposure"],
    });
    expect(decided.decision).toMatchObject({ outcome: "rejected", offeredRateBp: null });
    expect(decided.decision.policyChecks.find((check) => check.id === "borrower_exposure"))
      .toMatchObject({ passed: false, actual: "600001", threshold: "1" });
    expect(base.db.prepare<[string, string], { status: string }>(`
      SELECT status FROM banks WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, base.bankId)?.status).toBe("active");
    const eventTypes = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .map((event) => event.type);
    expect(eventTypes.slice(-3)).toEqual([
      "bank.lending.assessed",
      "bank.lending.blocked",
      "loan.rejected",
    ]);
  });

  it("halts on a systemic breach and resumes only after the projected position recovers", () => {
    const base = fixture();
    base.db.prepare(`
      UPDATE banks SET reserve_cents = '50000000' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, base.bankId);
    const first = submitAndReview(base, base.applicants[0]!, [1, 2]);
    const rejected = first.credit.decideTier1Application(
      first.submitted.application.id,
      context(base.db, base.ids, 3),
    );
    expect(rejected.decision.outcome).toBe("rejected");
    const firstAssessment = new SqliteBankCircuitStore(base.db, TEST_RUN_ID)
      .getLatestForApplication(first.submitted.application.id, "approval");
    expect(firstAssessment).toMatchObject({
      allowed: false,
      reservePassed: false,
      bankStatusAfter: "lending_halted",
      failedBreakers: ["reserve_ratio"],
    });
    expect(base.db.prepare<[string, string], { status: string }>(`
      SELECT status FROM banks WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, base.bankId)?.status).toBe("lending_halted");

    base.db.prepare(`
      UPDATE banks SET reserve_cents = '95040000' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, base.bankId);
    const second = submitAndReview(base, base.applicants[1]!, [4, 5]);
    const approved = second.credit.decideTier1Application(
      second.submitted.application.id,
      context(base.db, base.ids, 6),
    );
    expect(approved.decision.outcome).toBe("approved");
    const secondAssessment = new SqliteBankCircuitStore(base.db, TEST_RUN_ID)
      .getLatestForApplication(second.submitted.application.id, "approval");
    expect(secondAssessment).toMatchObject({
      bankStatusBefore: "lending_halted",
      bankStatusAfter: "active",
      allowed: true,
    });
    const eventTypes = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .map((event) => event.type);
    expect(eventTypes).toContain("bank.lending.halted");
    expect(eventTypes).toContain("bank.lending.resumed");
  });

  it("rechecks stale approvals and commits a blocked attempt without impossible balances", () => {
    const base = fixture();
    const prepared = submitAndReview(base, base.applicants[0]!, [1, 2]);
    const decided = prepared.credit.decideTier1Application(
      prepared.submitted.application.id,
      context(base.db, base.ids, 3),
    );
    expect(decided.decision.outcome).toBe("approved");
    const borrowerAccount = base.finance.listAccounts().find((account) => (
      account.ownerKind === "agent" && account.ownerId === base.applicants[0] &&
      account.type === "checking"
    ));
    if (borrowerAccount === undefined) throw new Error("borrower account is missing");
    const balanceBefore = accountBalance(base.db, borrowerAccount.id);
    const transactionsBefore = base.finance.listTransactions({ limit: 1_000 }).items.length;
    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.prepare(`
      UPDATE banks SET capital_cents = '1' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, base.bankId);

    const attempt = prepared.credit.tryDisburseApprovedApplication(
      prepared.submitted.application.id,
      context(base.db, base.ids, 4),
    );
    expect(attempt).toMatchObject({
      kind: "blocked",
      assessment: {
        stage: "disbursement",
        allowed: false,
        capitalPassed: false,
        failedBreakers: ["capital_ratio"],
      },
    });
    expect(() => prepared.credit.getLoanForApplication(prepared.submitted.application.id))
      .toThrow(/does not exist/);
    expect(accountBalance(base.db, borrowerAccount.id)).toBe(balanceBefore);
    expect(base.finance.listTransactions({ limit: 1_000 }).items).toHaveLength(
      transactionsBefore,
    );
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).not.toBe(hashBefore);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).list().slice(-4)
      .map((event) => event.type)).toEqual([
      "bank.lending.assessed",
      "bank.lending.halted",
      "bank.lending.blocked",
      "loan.disbursement.blocked",
    ]);
  });

  it("rolls back cleanly, reopens exactly, and restores the next assessment equivalently", async () => {
    const base = fixture();
    const prepared = submitAndReview(base, base.applicants[0]!, [1, 2]);
    const assessmentsBefore = base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM bank_lending_assessments WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count;
    const eventsBefore = new SqliteEventStore(base.db, TEST_RUN_ID).count();
    const idStateBeforeRollback = base.ids.serialize();
    expect(() => base.db.transaction(() => {
      prepared.credit.decideTier1Application(
        prepared.submitted.application.id,
        context(base.db, base.ids, 3),
      );
      throw new Error("rollback circuit decision");
    }).immediate()).toThrow(/rollback circuit decision/);
    expect(base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM bank_lending_assessments WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count).toBe(assessmentsBefore);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventsBefore);
    expect(prepared.credit.getApplication(prepared.submitted.application.id).status)
      .toBe("under_review");

    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 2, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(idStateBeforeRollback), TEST_RUN_ID);
    const beforeHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(beforeHash);

    const snapshots = new SqliteSnapshotStore(
      reopened,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "bank-circuit-snapshot-wall" });
    const destination = join(base.dataDir, "bank-circuit-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const credit = new SqliteCreditStore(db, TEST_RUN_ID);
      const result = credit.decideTier1Application(
        prepared.submitted.application.id,
        context(db, ids, 3),
      );
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 3, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return {
        result,
        assessment: new SqliteBankCircuitStore(db, TEST_RUN_ID)
          .getLatestForApplication(prepared.submitted.application.id, "approval"),
        hash: computeLogicalStateHash(db, TEST_RUN_ID),
      };
    };

    const straight = advance(reopened);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    const replayed = advance(restored);
    expect(replayed.result).toEqual(straight.result);
    expect(replayed.assessment).toEqual(straight.assessment);
    expect(replayed.hash).toBe(straight.hash);
  });
});
