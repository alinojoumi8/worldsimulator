import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdFactory,
  Rng,
  canonicalStringify,
  eventEnvelopeSchema,
  ledgerTransactionSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import { createFinancePhaseHandlers } from "../finance-phase";
import { SqliteAgentStore } from "./agent-store";
import { SqliteCreditStore } from "./credit-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteLoanCollectionStore } from "./loan-collection-store";
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
    simDate: simDateForTick(tick),
    phase: "obligations",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.loan-collections.${key}`),
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
        simDate: simDateForTick(tick),
        wallTime: "loan-collection-test-wall",
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
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-loan-collections-"));
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
  if (bankId === undefined) throw new Error("collection test bank is missing");
  const seedBorrowers = new Set(population.loans.map((loan) => loan.borrowerId));
  const applicant = population.residents.find((resident) => (
    resident.agent.employmentStatus === "employed" && !seedBorrowers.has(resident.agent.id)
  ));
  if (applicant === undefined) throw new Error("collection test applicant is missing");
  return { dataDir, db, population, ids, finance, bankId, applicantId: applicant.agent.id };
}

function originate(base: ReturnType<typeof fixture>) {
  const credit = new SqliteCreditStore(base.db, TEST_RUN_ID);
  const submitted = credit.submitApplication({
    applicantKind: "agent",
    applicantId: base.applicantId,
    bankId: base.bankId,
    purpose: "Replace a failed vehicle",
    amountCents: "600001",
    termMonths: 12,
  }, context(base.db, base.ids, 1));
  credit.beginReview(submitted.application.id, context(base.db, base.ids, 2));
  const decided = credit.decideTier1Application(
    submitted.application.id,
    context(base.db, base.ids, 3),
  );
  if (decided.decision.outcome !== "approved") {
    throw new Error(`collection fixture application was rejected: ${canonicalStringify(
      decided.decision.policyChecks,
    )}`);
  }
  const disbursed = credit.disburseApprovedApplication(
    submitted.application.id,
    context(base.db, base.ids, 4),
  );
  return { credit, submitted, decided, ...disbursed };
}

function balance(db: WorldDatabase, accountId: string): bigint {
  const row = db.prepare<[string, string], { balance_cents: string }>(`
    SELECT balance_cents FROM bank_accounts WHERE run_id = ? AND id = ?
  `).get(TEST_RUN_ID, accountId);
  if (row === undefined) throw new Error(`account ${accountId} is missing`);
  return BigInt(row.balance_cents);
}

function internalAccount(
  base: ReturnType<typeof fixture>,
  ownerId: string,
): { readonly id: string; readonly balance: bigint } | null {
  const row = base.db.prepare<[string, string], { id: string; balance_cents: string }>(`
    SELECT id, balance_cents FROM bank_accounts
    WHERE run_id = ? AND owner_kind = 'bank_internal' AND owner_id = ?
    ORDER BY id LIMIT 1
  `).get(TEST_RUN_ID, ownerId);
  return row === undefined ? null : { id: row.id, balance: BigInt(row.balance_cents) };
}

function moveAcrossRow(
  base: ReturnType<typeof fixture>,
  borrowerAccountId: string,
  amount: bigint,
  direction: "to_row" | "from_row",
  tick: number,
): void {
  if (amount <= 0n) throw new Error("ROW test transfer must be positive");
  const row = base.finance.listAccounts().find((account) => account.ownerKind === "system_row");
  if (row === undefined) throw new Error("ROW account is missing");
  const transaction = ledgerTransactionSchema.parse({
    id: base.ids.next("txn"),
    runId: TEST_RUN_ID,
    tick,
    kind: "row_settlement",
    actor: { kind: "system", id: "test-funding" },
    reason: `test.${direction}`,
    sourceEventId: null,
    correlationId: `test-row:${tick}:${direction}`,
    idempotencyKey: `test-row:${tick}:${direction}`,
    legs: direction === "to_row" ? [
      { accountId: row.id, direction: "debit", amountCents: amount.toString() },
      { accountId: borrowerAccountId, direction: "credit", amountCents: amount.toString() },
    ] : [
      { accountId: borrowerAccountId, direction: "debit", amountCents: amount.toString() },
      { accountId: row.id, direction: "credit", amountCents: amount.toString() },
    ],
  });
  expect(base.finance.post(transaction).duplicate).toBe(false);
}

function persistCheckpoint(base: ReturnType<typeof fixture>, tick: number): void {
  base.db.prepare(`
    UPDATE simulation_runs SET current_tick = ?, id_state_canonical = ? WHERE id = ?
  `).run(tick, canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-504 loan collections", () => {
  it("collects an exact due installment through the obligations handler", () => {
    const base = fixture();
    const originated = originate(base);
    const installment = originated.installments[0]!;
    const source = internalAccount(base, `${base.bankId}:loan_source`)!;
    const borrowerBefore = balance(base.db, originated.loan.borrowerDepositAccountId);
    const assetBefore = balance(base.db, originated.loan.bankAssetAccountId);
    const sourceBefore = source.balance;
    expect(internalAccount(base, `${base.bankId}:interest_income`)).toBeNull();

    const collectionHandler = createFinancePhaseHandlers(base.db, TEST_RUN_ID).find((entry) => (
      entry.phase === "obligations" && entry.handler.module === "M09-credit-collections"
    ));
    expect(collectionHandler?.handler.order).toBe(60);
    collectionHandler!.handler.run(context(base.db, base.ids, installment.dueTick));

    const loan = originated.credit.getLoan(originated.loan.id);
    const paid = originated.credit.listLoanInstallments(loan.id)[0]!;
    const income = internalAccount(base, `${base.bankId}:interest_income`)!;
    const principal = BigInt(installment.principalDueCents);
    const interest = BigInt(installment.interestDueCents);
    expect(loan).toMatchObject({
      status: "repaying",
      consecutiveMisses: 0,
      outstandingPrincipalCents: (600001n - principal).toString(),
    });
    expect(paid).toMatchObject({ status: "completed", paidTick: installment.dueTick });
    expect(paid.transactionId).not.toBeNull();
    expect(borrowerBefore - balance(base.db, loan.borrowerDepositAccountId))
      .toBe(principal + interest);
    expect(assetBefore - balance(base.db, loan.bankAssetAccountId)).toBe(principal);
    expect(balance(base.db, source.id) - sourceBefore).toBe(principal * 2n);
    expect(income.balance).toBe(interest);
    const transaction = base.finance.listTransactions({ limit: 1_000 }).items
      .find((candidate) => candidate.id === paid.transactionId)!;
    expect(transaction).toMatchObject({
      kind: "loan_payment",
      actor: { kind: "system", id: "credit" },
      reason: "loan.installment.payment",
    });
    expect(transaction.legs).toHaveLength(interest === 0n ? 3 : 4);
    const events = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .filter((event) => event.correlationId === `loan:${loan.id}`);
    expect(events.map((event) => event.type)).toEqual([
      "loan.payment.due",
      "account.opened",
      "transaction.posted",
      "loan.payment.completed",
      "loan.collection.updated",
    ]);
    expect(events[3]?.causationId).toBe(events[2]?.eventId);
    expect(events[4]?.payload).toMatchObject({
      outstandingPrincipalCents: loan.outstandingPrincipalCents,
      status: "repaying",
    });
    persistCheckpoint(base, installment.dueTick);
    expect(base.finance.getBank(base.bankId)).toMatchObject({
      incomeStatement30: {
        interestIncome: interest.toString(),
        writeDowns: "0",
      },
    });

    expect(() => base.db.prepare(`
      UPDATE loan_installments SET status = 'missed', paid_tick = NULL, transaction_id = NULL
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, paid.id)).toThrow(/invalid loan installment collection transition/);
    expect(() => base.db.prepare(`
      UPDATE loans SET outstanding_principal_cents = '1'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, loan.id)).toThrow(/loan outstanding principal/);
  });

  it("keeps arrears explicit and cures all missed installments atomically", () => {
    const base = fixture();
    const originated = originate(base);
    const borrowerId = originated.loan.borrowerDepositAccountId;
    moveAcrossRow(base, borrowerId, balance(base.db, borrowerId), "to_row", 5);
    const collections = new SqliteLoanCollectionStore(base.db, TEST_RUN_ID);

    const missed = collections.processDueInstallments(context(base.db, base.ids, 34));
    expect(missed).toMatchObject([{ kind: "missed" }]);
    expect(originated.credit.getLoan(originated.loan.id)).toMatchObject({
      status: "repaying",
      consecutiveMisses: 1,
      outstandingPrincipalCents: "600001",
    });
    expect(originated.credit.listLoanInstallments(originated.loan.id)[0]?.status).toBe("missed");

    const firstTwo = originated.installments.slice(0, 2);
    const arrearsTotal = firstTwo.reduce(
      (sum, installment) => sum + BigInt(installment.totalDueCents),
      0n,
    );
    moveAcrossRow(base, borrowerId, arrearsTotal, "from_row", 63);
    const cured = collections.processDueInstallments(context(base.db, base.ids, 64));
    expect(cured).toHaveLength(1);
    expect(cured[0]).toMatchObject({
      kind: "collected",
      collectedInstallmentIds: firstTwo.map((installment) => installment.id),
    });
    expect(cured[0]?.transactions).toHaveLength(2);
    expect(balance(base.db, borrowerId)).toBe(0n);
    expect(originated.credit.listLoanInstallments(originated.loan.id).slice(0, 2)
      .map((installment) => installment.status)).toEqual(["completed", "completed"]);
    expect(originated.credit.getLoan(originated.loan.id)).toMatchObject({
      status: "repaying",
      consecutiveMisses: 0,
      outstandingPrincipalCents: "500001",
    });
    const completionEvents = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .filter((event) => event.type === "loan.payment.completed");
    expect(completionEvents.map((event) => (event.payload as { wasInArrears: boolean })
      .wasInArrears)).toEqual([true, false]);
  });

  it("defaults on the third miss, writes down the bank asset, and persists the score penalty", () => {
    const base = fixture();
    const originated = originate(base);
    const borrowerId = originated.loan.borrowerDepositAccountId;
    moveAcrossRow(base, borrowerId, balance(base.db, borrowerId), "to_row", 5);
    const scoreBefore = Number(base.db.prepare<[string, string], { credit_score: bigint }>(`
      SELECT credit_score FROM agents WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, base.applicantId)!.credit_score);
    const collections = new SqliteLoanCollectionStore(base.db, TEST_RUN_ID);

    expect(collections.processDueInstallments(context(base.db, base.ids, 34))[0]?.kind)
      .toBe("missed");
    expect(collections.processDueInstallments(context(base.db, base.ids, 64))[0]?.kind)
      .toBe("missed");
    const result = collections.processDueInstallments(context(base.db, base.ids, 94))[0]!;
    expect(result.kind).toBe("defaulted");
    expect(result.loan).toMatchObject({
      status: "defaulted",
      consecutiveMisses: 3,
      outstandingPrincipalCents: "600001",
    });
    expect(result.defaultRecord).toMatchObject({
      loanId: originated.loan.id,
      defaultTick: 94,
      outstandingPrincipalCents: "600001",
      missedInstallmentIds: originated.installments.slice(0, 3)
        .map((installment) => installment.id),
      creditScoreBefore: scoreBefore,
      creditScorePenaltyPoints: 100,
      creditScoreAfter: Math.max(300, scoreBefore - 100),
    });
    expect(collections.getDefaultForLoan(originated.loan.id)).toEqual(result.defaultRecord);
    expect(collections.listDefaults()).toEqual([result.defaultRecord]);
    expect(balance(base.db, originated.loan.bankAssetAccountId)).toBe(0n);
    expect(internalAccount(base, `${base.bankId}:credit_loss`)?.balance).toBe(600001n);
    expect(Number(base.db.prepare<[string, string], { credit_score: bigint }>(`
      SELECT credit_score FROM agents WHERE run_id = ? AND id = ?
    `).get(TEST_RUN_ID, base.applicantId)!.credit_score)).toBe(
      Math.max(300, scoreBefore - 100),
    );
    expect(result.transactions).toMatchObject([{
      kind: "loan_payment",
      reason: "loan.default.write_down",
      legs: [
        expect.objectContaining({ direction: "debit", amountCents: "600001" }),
        expect.objectContaining({ direction: "credit", amountCents: "600001" }),
      ],
    }]);
    const defaultEvent = new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .find((event) => event.type === "loan.defaulted")!;
    expect(defaultEvent.causationId).toBeDefined();
    expect(defaultEvent.payload).toMatchObject({
      missedInstallmentIds: originated.installments.slice(0, 3)
        .map((installment) => installment.id),
      writeDownTransactionId: result.defaultRecord?.writeDownTransactionId,
    });
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).list()
      .some((event) => event.type === "agent.credit_score.penalized")).toBe(true);
    persistCheckpoint(base, 94);
    expect(base.finance.getBank(base.bankId)).toMatchObject({
      incomeStatement30: {
        interestIncome: "0",
        writeDowns: "600001",
      },
    });
    expect(base.finance.recomputeIndicators(94)).toMatchObject({
      default_rate_bp: "1111",
    });

    const followUp = originated.credit.submitApplication({
      applicantKind: "agent",
      applicantId: base.applicantId,
      bankId: base.bankId,
      purpose: "Rebuild after default",
      amountCents: "100000",
      termMonths: 12,
    }, context(base.db, base.ids, 95));
    expect(followUp.assessment.inputs).toMatchObject({ defaults: 1, missedPayments: 3 });
    expect(() => base.db.prepare(`
      UPDATE loan_defaults SET outstanding_principal_cents = '1'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.defaultRecord!.id)).toThrow(/loan defaults are immutable/);
    expect(() => base.db.prepare(`
      DELETE FROM loan_defaults WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.defaultRecord!.id)).toThrow(/cannot be deleted/);
  });

  it("rolls a due cycle back cleanly and preserves collection state across reopen", () => {
    const base = fixture();
    const originated = originate(base);
    const collections = new SqliteLoanCollectionStore(base.db, TEST_RUN_ID);
    const hashBefore = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const eventsBefore = new SqliteEventStore(base.db, TEST_RUN_ID).count();
    const borrowerBefore = balance(base.db, originated.loan.borrowerDepositAccountId);
    expect(() => base.db.transaction(() => {
      collections.processDueInstallments(context(base.db, base.ids, 34));
      throw new Error("rollback collection");
    }).immediate()).toThrow(/rollback collection/);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(hashBefore);
    expect(new SqliteEventStore(base.db, TEST_RUN_ID).count()).toBe(eventsBefore);
    expect(balance(base.db, originated.loan.borrowerDepositAccountId)).toBe(borrowerBefore);
    expect(originated.credit.listLoanInstallments(originated.loan.id)[0]?.status).toBe("due");

    collections.processDueInstallments(context(base.db, base.ids, 34));
    persistCheckpoint(base, 34);
    const expectedHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const expectedLoan = originated.credit.getLoan(originated.loan.id);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(expectedHash);
    expect(new SqliteCreditStore(reopened, TEST_RUN_ID).getLoan(originated.loan.id))
      .toEqual(expectedLoan);
  });
});

describe("WS-504 collection restore equivalence", () => {
  it("restores the tick before payment and reproduces the next collection hash", async () => {
    const base = fixture();
    const originated = originate(base);
    persistCheckpoint(base, 33);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "loan-collection-snapshot-wall" });
    const destination = join(base.dataDir, "loan-collection-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const advance = (db: WorldDatabase) => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const outcome = new SqliteLoanCollectionStore(db, TEST_RUN_ID)
        .processDueInstallments(context(db, ids, 34));
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 34, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return { outcome, hash: computeLogicalStateHash(db, TEST_RUN_ID) };
    };

    const straight = advance(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    const replayed = advance(restored);
    expect(replayed.outcome).toEqual(straight.outcome);
    expect(replayed.hash).toBe(straight.hash);
    expect(new SqliteCreditStore(restored, TEST_RUN_ID)
      .listLoanInstallments(originated.loan.id)[0]?.status).toBe("completed");
  });
});
