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
import {
  checkInvariants,
  generateRiverbendPopulation,
  type TickContext,
} from "@worldtangle/engine";
import { readRunInvariantSnapshot } from "../testing/run-invariant-probe";
import { SqliteAgentStore } from "./agent-store";
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

function persistentContext(
  db: WorldDatabase,
  ids: IdFactory,
  tick: number,
): TickContext {
  const events = new SqliteEventStore(db, TEST_RUN_ID);
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: "Y0001-M01-D01",
    phase: "execute",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.loan-disbursement.${key}`),
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
        wallTime: "loan-disbursement-test-wall",
        actor: options?.actor ?? { kind: "system", id: "test" },
        correlationId: options?.correlationId ?? eventId,
        ...(options?.causationId === undefined
          ? {}
          : { causationId: options.causationId }),
        payload,
      }) as EventEnvelope;
      events.append(event);
      return event;
    },
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-loan-disbursement-"));
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
  if (bankId === undefined) throw new Error("loan-disbursement bank is missing");
  const borrowerIds = new Set(population.loans.map((loan) => loan.borrowerId));
  const applicant = population.residents.find((resident) => (
    resident.agent.employmentStatus === "employed" && !borrowerIds.has(resident.agent.id)
  ));
  if (applicant === undefined) throw new Error("loan-disbursement applicant is missing");
  return {
    dataDir,
    db,
    ids,
    finance,
    bankId,
    applicantId: applicant.agent.id,
  };
}

function request(base: ReturnType<typeof fixture>) {
  return {
    applicantKind: "agent" as const,
    applicantId: base.applicantId,
    bankId: base.bankId,
    purpose: "Replace a failed vehicle",
    amountCents: "600001",
    termMonths: 12,
  };
}

function approve(
  base: ReturnType<typeof fixture>,
  ticks: readonly [number, number, number],
) {
  const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
  const submitted = store.submitApplication(
    request(base),
    persistentContext(base.db, base.ids, ticks[0]),
  );
  store.beginReview(
    submitted.application.id,
    persistentContext(base.db, base.ids, ticks[1]),
  );
  const decided = store.decideTier1Application(
    submitted.application.id,
    persistentContext(base.db, base.ids, ticks[2]),
  );
  if (decided.decision.outcome !== "approved") {
    throw new Error(
      `loan-disbursement fixture application was not approved: ${canonicalStringify(
        decided.decision.policyChecks,
      )}`,
    );
  }
  return { store, submitted, decided };
}

function balance(db: WorldDatabase, accountId: string): bigint {
  const row = db.prepare<[string, string], { balance_cents: string }>(`
    SELECT balance_cents FROM bank_accounts WHERE run_id = ? AND id = ?
  `).get(TEST_RUN_ID, accountId);
  if (row === undefined) throw new Error(`account ${accountId} is missing`);
  return BigInt(row.balance_cents);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-503 atomic loan disbursement", () => {
  it("creates deposits, the bank asset, an exact schedule, and causal events atomically", () => {
    const base = fixture();
    const approved = approve(base, [1, 2, 3]);
    const borrowerAccount = base.finance.listAccounts().find((account) => (
      account.ownerKind === "agent" && account.ownerId === base.applicantId &&
      account.bankId === base.bankId && account.type === "checking"
    ));
    const loanSource = base.finance.listAccounts().find((account) => (
      account.ownerKind === "bank_internal" &&
      account.ownerId === `${base.bankId}:loan_source`
    ));
    if (borrowerAccount === undefined || loanSource === undefined) {
      throw new Error("loan-disbursement ledger fixture is incomplete");
    }
    const borrowerBefore = balance(base.db, borrowerAccount.id);
    const sourceBefore = balance(base.db, loanSource.id);

    const result = approved.store.disburseApprovedApplication(
      approved.submitted.application.id,
      persistentContext(base.db, base.ids, 4),
    );

    expect(result.loan).toMatchObject({
      applicationId: approved.submitted.application.id,
      decisionId: approved.decided.decision.id,
      principalCents: "600001",
      termMonths: 12,
      disbursedTick: 4,
      maturityTick: 364,
      outstandingPrincipalCents: "600001",
      consecutiveMisses: 0,
      status: "disbursed",
    });
    expect(balance(base.db, borrowerAccount.id) - borrowerBefore).toBe(600001n);
    expect(balance(base.db, result.loan.bankAssetAccountId)).toBe(600001n);
    expect(balance(base.db, loanSource.id) - sourceBefore).toBe(-1200002n);
    const debitTotal = result.transaction.legs
      .filter((leg) => leg.direction === "debit")
      .reduce((sum, leg) => sum + BigInt(leg.amountCents), 0n);
    const creditTotal = result.transaction.legs
      .filter((leg) => leg.direction === "credit")
      .reduce((sum, leg) => sum + BigInt(leg.amountCents), 0n);
    expect(debitTotal).toBe(creditTotal);
    expect(result.transaction).toMatchObject({
      kind: "loan_disbursement",
      actor: { kind: "system", id: "credit" },
      sourceEventId: result.loan.sourceEventId,
    });

    expect(result.installments).toHaveLength(12);
    expect(result.installments.map((row) => row.dueTick)).toEqual(
      Array.from({ length: 12 }, (_, index) => 34 + index * 30),
    );
    expect(result.installments.reduce(
      (sum, row) => sum + BigInt(row.principalDueCents),
      0n,
    )).toBe(600001n);
    expect(result.installments[0]).toMatchObject({
      installmentNumber: 1,
      openingPrincipalCents: "600001",
      principalDueCents: "50000",
      status: "due",
    });
    expect(result.installments.at(-1)).toMatchObject({
      installmentNumber: 12,
      principalDueCents: "50001",
      dueTick: 364,
    });
    expect(approved.store.getLoan(result.loan.id)).toEqual(result.loan);
    expect(approved.store.getLoanForApplication(approved.submitted.application.id))
      .toEqual(result.loan);
    expect(approved.store.listLoanInstallments(result.loan.id)).toEqual(result.installments);

    const events = new SqliteEventStore(base.db, TEST_RUN_ID).list();
    const circuitEvent = events.at(-5);
    expect(circuitEvent?.type).toBe("bank.lending.assessed");
    const disbursementEvents = events.slice(-4);
    expect(disbursementEvents.map((event) => event.type)).toEqual([
      "loan.disbursed",
      "account.opened",
      "loan.schedule.created",
      "transaction.posted",
    ]);
    expect(disbursementEvents[0]).toMatchObject({
      actor: { kind: "institution", id: base.bankId },
      causationId: circuitEvent?.eventId,
    });
    for (const event of disbursementEvents.slice(1)) {
      expect(event.correlationId).toBe(disbursementEvents[0]?.correlationId);
      expect(event.causationId).toBe(disbursementEvents[0]?.eventId);
    }
    expect(disbursementEvents[2]?.payload).toMatchObject({
      loanId: result.loan.id,
      scheduleDigest: result.loan.scheduleDigest,
      convention: "equal_principal_30_360_half_even",
    });

    const report = checkInvariants(readRunInvariantSnapshot(base.db, TEST_RUN_ID));
    expect(report.checks.find((check) => check.invariant === "INV-6"))
      .toMatchObject({ status: "passed", violations: [] });

    const followUp = approved.store.submitApplication(
      request(base),
      persistentContext(base.db, base.ids, 5),
    );
    expect(followUp.assessment.inputs.existingDebtCents).toBe("600001");
    expect(followUp.assessment.inputs.debtEvidenceRefs).toContain(result.loan.id);
  });

  it("blocks duplicate or mutable terms and rolls every linked record back together", () => {
    const base = fixture();
    const first = approve(base, [1, 2, 3]);
    const second = approve(base, [4, 5, 6]);
    const disbursed = first.store.disburseApprovedApplication(
      first.submitted.application.id,
      persistentContext(base.db, base.ids, 7),
    );
    expect(() => first.store.disburseApprovedApplication(
      first.submitted.application.id,
      persistentContext(base.db, base.ids, 8),
    )).toThrow(/already disbursed/);
    expect(() => base.db.prepare(`
      UPDATE loans SET principal_cents = '1' WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, disbursed.loan.id)).toThrow(/immutable/);
    expect(() => base.db.prepare(`
      UPDATE loan_installments SET principal_due_cents = '1'
      WHERE run_id = ? AND loan_id = ? AND installment_number = 1
    `).run(TEST_RUN_ID, disbursed.loan.id)).toThrow(/immutable/);

    const borrowerAccountId = base.finance.listAccounts().find((account) => (
      account.ownerKind === "agent" && account.ownerId === base.applicantId &&
      account.type === "checking"
    ))?.id;
    if (borrowerAccountId === undefined) throw new Error("borrower account is missing");
    const balanceBefore = balance(base.db, borrowerAccountId);
    const loansBefore = base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM loans WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count;
    const transactionsBefore = base.finance.listTransactions({ limit: 1_000 }).items.length;
    const eventsBefore = new SqliteEventStore(base.db, TEST_RUN_ID).count();

    expect(() => base.db.transaction(() => {
      second.store.disburseApprovedApplication(
        second.submitted.application.id,
        persistentContext(base.db, base.ids, 9),
      );
      throw new Error("rollback disbursement");
    }).immediate()).toThrow(/rollback disbursement/);

    expect(() => second.store.getLoanForApplication(second.submitted.application.id))
      .toThrow(/does not exist/);
    expect(balance(base.db, borrowerAccountId)).toBe(balanceBefore);
    expect(base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM loans WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count).toBe(loansBefore);
    expect(base.finance.listTransactions({ limit: 1_000 }).items).toHaveLength(transactionsBefore);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventsBefore);

    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 9, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const expectedHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    const reopenedStore = new SqliteCreditStore(reopened, TEST_RUN_ID);
    expect(reopenedStore.getLoan(disbursed.loan.id)).toEqual(disbursed.loan);
    expect(reopenedStore.listLoanInstallments(disbursed.loan.id)).toEqual(disbursed.installments);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(expectedHash);
  });

  it("restores an approved application and reproduces the next disbursement hash", async () => {
    const base = fixture();
    const approved = approve(base, [1, 2, 3]);
    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 3, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "loan-disbursement-snapshot-wall" });
    const destination = join(base.dataDir, "loan-disbursement-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const store = new SqliteCreditStore(db, TEST_RUN_ID);
      const result = store.disburseApprovedApplication(
        approved.submitted.application.id,
        persistentContext(db, ids, 4),
      );
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 4, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return { result, hash: computeLogicalStateHash(db, TEST_RUN_ID) };
    };

    const straight = advance(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    const replayed = advance(restored);
    expect(replayed.result).toEqual(straight.result);
    expect(replayed.hash).toBe(straight.hash);
  });
});
