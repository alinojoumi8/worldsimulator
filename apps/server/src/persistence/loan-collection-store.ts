/** SQLite collection, arrears, and default workflow for originated loans (WS-504). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  ledgerTransactionSchema,
  loanDefaultRecordSchema,
  runIdSchema,
  type BankAccount,
  type LedgerTransaction,
  type Loan,
  type LoanDefaultRecord,
  type LoanInstallment,
} from "@worldtangle/shared";
import {
  applyLoanDefaultCreditScorePenalty,
  canCollectLoanQuote,
  loanStateAfterCollection,
  loanStateAfterMiss,
  LOAN_DEFAULT_CREDIT_SCORE_PENALTY_POINTS,
  quoteLoanCollection,
  type TickContext,
} from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { toSafeNumber } from "./database";
import { SqliteCreditStore } from "./credit-store";
import { SqliteFinanceStore } from "./finance-store";

interface DueInstallmentRow {
  loan_id: string;
  installment_id: string;
}

interface InternalAccountRow {
  id: string;
  status: "active" | "frozen" | "closed";
}

interface AgentCreditScoreRow {
  credit_score: bigint;
}

interface LoanDefaultRow {
  id: string;
  loan_id: string;
  borrower_kind: "agent" | "company";
  borrower_id: string;
  bank_id: string;
  default_tick: bigint;
  outstanding_principal_cents: string;
  missed_installment_ids_canonical: string;
  write_down_transaction_id: string;
  credit_score_before: bigint | null;
  credit_score_penalty_points: bigint;
  credit_score_after: bigint | null;
  source_event_id: string;
}

export interface LoanCollectionOutcome {
  readonly kind: "collected" | "missed" | "defaulted";
  readonly loan: Loan;
  readonly currentInstallment: LoanInstallment;
  readonly collectedInstallmentIds: readonly string[];
  readonly transactions: readonly LedgerTransaction[];
  readonly defaultRecord: LoanDefaultRecord | null;
}

function parseStringArray(text: string, field: string): readonly string[] {
  const parsed = canonicalParse(text);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new EngineError("INTERNAL", `${field} is not a string array`);
  }
  return Object.freeze([...parsed]);
}

function mapDefault(runId: string, row: LoanDefaultRow): LoanDefaultRecord {
  return loanDefaultRecordSchema.parse({
    id: row.id,
    runId,
    loanId: row.loan_id,
    borrowerKind: row.borrower_kind,
    borrowerId: row.borrower_id,
    bankId: row.bank_id,
    defaultTick: toSafeNumber(row.default_tick, "loan default tick"),
    outstandingPrincipalCents: row.outstanding_principal_cents,
    missedInstallmentIds: parseStringArray(
      row.missed_installment_ids_canonical,
      "loan default miss history",
    ),
    writeDownTransactionId: row.write_down_transaction_id,
    creditScoreBefore: row.credit_score_before === null
      ? null
      : toSafeNumber(row.credit_score_before, "credit score before default"),
    creditScorePenaltyPoints: toSafeNumber(
      row.credit_score_penalty_points,
      "credit score default penalty",
    ),
    creditScoreAfter: row.credit_score_after === null
      ? null
      : toSafeNumber(row.credit_score_after, "credit score after default"),
    sourceEventId: row.source_event_id,
  });
}

function emitTransactionPosted(
  ctx: TickContext,
  transaction: LedgerTransaction,
): ReturnType<TickContext["emit"]> {
  ctx.count("transactions");
  return ctx.emit("transaction.posted", {
    transactionId: transaction.id,
    kind: transaction.kind,
    legs: transaction.legs,
    reason: transaction.reason,
    sourceEventId: transaction.sourceEventId,
    correlationId: transaction.correlationId,
    duplicate: false,
    evidence: transaction.sourceEventId === null ? [] : [transaction.sourceEventId],
  }, {
    actor: { kind: "system", id: "credit" },
    correlationId: transaction.correlationId,
    causationId: transaction.sourceEventId ?? undefined,
  });
}

export class SqliteLoanCollectionStore {
  private readonly credit: SqliteCreditStore;
  private readonly finance: SqliteFinanceStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    this.credit = new SqliteCreditStore(db, runId);
    this.finance = new SqliteFinanceStore(db, runId);
  }

  listDefaults(): readonly LoanDefaultRecord[] {
    return Object.freeze(this.db.prepare<[string], LoanDefaultRow>(`
      SELECT id, loan_id, borrower_kind, borrower_id, bank_id, default_tick,
        outstanding_principal_cents, missed_installment_ids_canonical,
        write_down_transaction_id, credit_score_before,
        credit_score_penalty_points, credit_score_after, source_event_id
      FROM loan_defaults WHERE run_id = ? ORDER BY default_tick, id
    `).all(this.runId).map((row) => mapDefault(this.runId, row)));
  }

  getDefaultForLoan(loanId: string): LoanDefaultRecord | null {
    const row = this.db.prepare<[string, string], LoanDefaultRow>(`
      SELECT id, loan_id, borrower_kind, borrower_id, bank_id, default_tick,
        outstanding_principal_cents, missed_installment_ids_canonical,
        write_down_transaction_id, credit_score_before,
        credit_score_penalty_points, credit_score_after, source_event_id
      FROM loan_defaults WHERE run_id = ? AND loan_id = ?
    `).get(this.runId, loanId);
    return row === undefined ? null : mapDefault(this.runId, row);
  }

  processDueInstallments(ctx: TickContext): readonly LoanCollectionOutcome[] {
    this.assertContext(ctx);
    return this.inTransaction(() => {
      const due = this.db.prepare<[string, number], DueInstallmentRow>(`
        SELECT l.id AS loan_id, i.id AS installment_id
        FROM loans l
        JOIN loan_installments i ON i.run_id = l.run_id AND i.loan_id = l.id
        WHERE l.run_id = ? AND l.status IN ('disbursed', 'repaying')
          AND i.status = 'due' AND i.due_tick = ?
        ORDER BY l.id, i.installment_number
      `).all(this.runId, ctx.tick);
      return Object.freeze(due.map((row) => this.processOne(
        row.loan_id,
        row.installment_id,
        ctx,
      )));
    });
  }

  private processOne(
    loanId: string,
    installmentId: string,
    ctx: TickContext,
  ): LoanCollectionOutcome {
    const loan = this.credit.getLoan(loanId);
    const schedule = this.credit.listLoanInstallments(loan.id);
    const current = schedule.find((installment) => installment.id === installmentId);
    if (current === undefined || current.status !== "due" || current.dueTick !== ctx.tick) {
      throw new EngineError("CONFLICT", `installment ${installmentId} is not due at tick ${ctx.tick}`);
    }
    const arrears = schedule.filter((installment) => (
      installment.status === "missed" &&
      installment.installmentNumber < current.installmentNumber
    ));
    const targets = Object.freeze([...arrears, current]);
    const quote = quoteLoanCollection(targets);
    const correlationId = `loan:${loan.id}`;
    const dueEvent = ctx.emit("loan.payment.due", {
      loanId: loan.id,
      borrowerKind: loan.borrowerKind,
      borrowerId: loan.borrowerId,
      bankId: loan.bankId,
      currentInstallmentId: current.id,
      installmentIds: quote.installmentIds,
      principalCents: quote.principalCents,
      interestCents: quote.interestCents,
      totalCents: quote.totalCents,
      consecutiveMisses: loan.consecutiveMisses,
      evidence: [loan.sourceEventId, ...targets.map((installment) => installment.sourceEventId)],
    }, {
      actor: { kind: "system", id: "credit-collections" },
      correlationId,
      causationId: current.sourceEventId,
    });
    const [borrower] = this.finance.getAccounts(this.runId, [loan.borrowerDepositAccountId]);
    if (borrower === undefined || borrower.status !== "active") {
      throw new EngineError("CONFLICT", `loan ${loan.id} borrower account is not active`);
    }
    if (!canCollectLoanQuote({
      balanceCents: borrower.balanceCents.toString(),
      floorCents: borrower.floorCents.toString(),
      quote,
    })) {
      return this.recordMiss(loan, current, quote.totalCents, borrower, ctx, dueEvent.eventId);
    }
    return this.collect(loan, current, targets, quote.principalCents, ctx, dueEvent.eventId);
  }

  private collect(
    loan: Loan,
    current: LoanInstallment,
    targets: readonly LoanInstallment[],
    principalCollectedCents: string,
    ctx: TickContext,
    dueEventId: string,
  ): LoanCollectionOutcome {
    const correlationId = `loan:${loan.id}`;
    const sourceAccountId = this.internalAccountId(
      loan.bankId,
      `${loan.bankId}:loan_source`,
      "internal_liability",
    );
    const needsIncomeAccount = targets.some((installment) => (
      BigInt(installment.interestDueCents) > 0n
    ));
    const incomeAccount = needsIncomeAccount
      ? this.ensureInternalAccount(
        loan.bankId,
        `${loan.bankId}:interest_income`,
        "internal_income",
        ctx,
        dueEventId,
        correlationId,
      )
      : null;
    const transactions: LedgerTransaction[] = [];
    for (const installment of targets) {
      const principal = BigInt(installment.principalDueCents);
      const interest = BigInt(installment.interestDueCents);
      if (principal <= 0n) {
        throw new EngineError(
          "CONFLICT",
          `installment ${installment.id} has no collectible principal`,
        );
      }
      const transaction = ledgerTransactionSchema.parse({
        id: ctx.ids.next("txn"),
        runId: this.runId,
        tick: ctx.tick,
        kind: "loan_payment",
        actor: { kind: "system", id: "credit" },
        reason: "loan.installment.payment",
        sourceEventId: dueEventId,
        correlationId,
        idempotencyKey: `loan-payment:${loan.id}:${installment.id}`,
        legs: [
          {
            accountId: sourceAccountId,
            direction: "debit",
            amountCents: (principal * 2n).toString(),
          },
          ...(interest === 0n ? [] : [{
            accountId: incomeAccount!.id,
            direction: "debit" as const,
            amountCents: interest.toString(),
          }]),
          {
            accountId: loan.borrowerDepositAccountId,
            direction: "credit",
            amountCents: installment.totalDueCents,
          },
          {
            accountId: loan.bankAssetAccountId,
            direction: "credit",
            amountCents: installment.principalDueCents,
          },
        ],
      });
      const posted = this.finance.post(transaction);
      if (posted.duplicate) {
        throw new EngineError("CONFLICT", `installment ${installment.id} was already collected`);
      }
      const postedEvent = emitTransactionPosted(ctx, transaction);
      const updated = this.db.prepare(`
        UPDATE loan_installments
        SET status = 'completed', paid_tick = ?, transaction_id = ?
        WHERE run_id = ? AND id = ? AND status IN ('due', 'missed')
      `).run(ctx.tick, transaction.id, this.runId, installment.id);
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `installment ${installment.id} could not be completed`);
      }
      ctx.emit("loan.payment.completed", {
        loanId: loan.id,
        installmentId: installment.id,
        installmentNumber: installment.installmentNumber,
        wasInArrears: installment.status === "missed",
        principalCents: installment.principalDueCents,
        interestCents: installment.interestDueCents,
        totalCents: installment.totalDueCents,
        transactionId: transaction.id,
        evidence: [dueEventId, installment.sourceEventId, postedEvent.eventId],
      }, {
        actor: { kind: "system", id: "credit-collections" },
        correlationId,
        causationId: postedEvent.eventId,
      });
      transactions.push(transaction);
    }
    const next = loanStateAfterCollection({
      outstandingPrincipalCents: loan.outstandingPrincipalCents,
      principalCollectedCents,
    });
    const updatedLoan = this.db.prepare(`
      UPDATE loans
      SET outstanding_principal_cents = ?, consecutive_misses = ?, status = ?
      WHERE run_id = ? AND id = ? AND status IN ('disbursed', 'repaying')
    `).run(
      next.outstandingPrincipalCents,
      next.consecutiveMisses,
      next.status,
      this.runId,
      loan.id,
    );
    if (updatedLoan.changes !== 1) {
      throw new EngineError("CONFLICT", `loan ${loan.id} could not advance after collection`);
    }
    const finalLoan = this.credit.getLoan(loan.id);
    const finalCurrent = this.credit.listLoanInstallments(loan.id)
      .find((installment) => installment.id === current.id)!;
    ctx.emit("loan.collection.updated", {
      loanId: loan.id,
      outstandingPrincipalCents: finalLoan.outstandingPrincipalCents,
      consecutiveMisses: finalLoan.consecutiveMisses,
      status: finalLoan.status,
      collectedInstallmentIds: targets.map((installment) => installment.id),
      evidence: [dueEventId, ...transactions.map((transaction) => transaction.id)],
    }, {
      actor: { kind: "system", id: "credit-collections" },
      correlationId,
      causationId: dueEventId,
    });
    return Object.freeze({
      kind: "collected",
      loan: finalLoan,
      currentInstallment: finalCurrent,
      collectedInstallmentIds: Object.freeze(targets.map((installment) => installment.id)),
      transactions: Object.freeze(transactions),
      defaultRecord: null,
    });
  }

  private recordMiss(
    loan: Loan,
    current: LoanInstallment,
    requiredCents: string,
    borrower: { readonly balanceCents: bigint; readonly floorCents: bigint },
    ctx: TickContext,
    dueEventId: string,
  ): LoanCollectionOutcome {
    const correlationId = `loan:${loan.id}`;
    const installmentUpdate = this.db.prepare(`
      UPDATE loan_installments SET status = 'missed'
      WHERE run_id = ? AND id = ? AND status = 'due'
    `).run(this.runId, current.id);
    if (installmentUpdate.changes !== 1) {
      throw new EngineError("CONFLICT", `installment ${current.id} could not be marked missed`);
    }
    const missState = loanStateAfterMiss(loan.consecutiveMisses);
    const loanUpdate = this.db.prepare(`
      UPDATE loans SET consecutive_misses = ?, status = ?
      WHERE run_id = ? AND id = ? AND status IN ('disbursed', 'repaying')
    `).run(missState.consecutiveMisses, missState.status, this.runId, loan.id);
    if (loanUpdate.changes !== 1) {
      throw new EngineError("CONFLICT", `loan ${loan.id} could not record a missed payment`);
    }
    const missHistory = this.credit.listLoanInstallments(loan.id)
      .filter((installment) => installment.status === "missed")
      .map((installment) => installment.id);
    const available = borrower.balanceCents - borrower.floorCents;
    const missedEvent = ctx.emit("loan.payment.missed", {
      loanId: loan.id,
      installmentId: current.id,
      installmentNumber: current.installmentNumber,
      requiredCents,
      availableCents: available.toString(),
      consecutiveMisses: missState.consecutiveMisses,
      defaultThreshold: 3,
      missedInstallmentIds: missHistory,
      evidence: [dueEventId, loan.sourceEventId, current.sourceEventId],
    }, {
      actor: { kind: "system", id: "credit-collections" },
      correlationId,
      causationId: dueEventId,
    });
    if (!missState.defaulted) {
      return Object.freeze({
        kind: "missed",
        loan: this.credit.getLoan(loan.id),
        currentInstallment: this.credit.listLoanInstallments(loan.id)
          .find((installment) => installment.id === current.id)!,
        collectedInstallmentIds: Object.freeze([]),
        transactions: Object.freeze([]),
        defaultRecord: null,
      });
    }
    return this.recordDefault(loan, current, missHistory, ctx, missedEvent.eventId);
  }

  private recordDefault(
    originalLoan: Loan,
    current: LoanInstallment,
    missedInstallmentIds: readonly string[],
    ctx: TickContext,
    missedEventId: string,
  ): LoanCollectionOutcome {
    if (missedInstallmentIds.length < 3) {
      throw new EngineError("CONFLICT", "loan default does not have three missed installments");
    }
    const loan = this.credit.getLoan(originalLoan.id);
    if (loan.status !== "defaulted" || BigInt(loan.outstandingPrincipalCents) <= 0n) {
      throw new EngineError("CONFLICT", `loan ${loan.id} is not eligible for a write-down`);
    }
    const correlationId = `loan:${loan.id}`;
    const lossAccount = this.ensureInternalAccount(
      loan.bankId,
      `${loan.bankId}:credit_loss`,
      "internal_expense",
      ctx,
      missedEventId,
      correlationId,
    );
    const defaultId = ctx.ids.next("ldef");
    const transactionId = ctx.ids.next("txn");
    let creditScoreBefore: number | null = null;
    let creditScoreAfter: number | null = null;
    let creditScorePenaltyPoints = 0;
    if (loan.borrowerKind === "agent") {
      const row = this.db.prepare<[string, string], AgentCreditScoreRow>(`
        SELECT credit_score FROM agents WHERE run_id = ? AND id = ?
      `).get(this.runId, loan.borrowerId);
      if (row === undefined) {
        throw new EngineError("NOT_FOUND", `agent ${loan.borrowerId} does not exist`);
      }
      creditScoreBefore = toSafeNumber(row.credit_score, "agent credit score");
      creditScoreAfter = applyLoanDefaultCreditScorePenalty(creditScoreBefore);
      creditScorePenaltyPoints = LOAN_DEFAULT_CREDIT_SCORE_PENALTY_POINTS;
    }
    const defaultEvent = ctx.emit("loan.defaulted", {
      defaultId,
      loanId: loan.id,
      borrowerKind: loan.borrowerKind,
      borrowerId: loan.borrowerId,
      bankId: loan.bankId,
      defaultTick: ctx.tick,
      outstandingPrincipalCents: loan.outstandingPrincipalCents,
      consecutiveMisses: loan.consecutiveMisses,
      missedInstallmentIds,
      writeDownTransactionId: transactionId,
      lossAccountId: lossAccount.id,
      creditScoreBefore,
      creditScorePenaltyPoints,
      creditScoreAfter,
      evidence: [missedEventId, loan.sourceEventId, ...missedInstallmentIds],
    }, {
      actor: { kind: "institution", id: loan.bankId },
      correlationId,
      causationId: missedEventId,
    });
    const transaction = ledgerTransactionSchema.parse({
      id: transactionId,
      runId: this.runId,
      tick: ctx.tick,
      kind: "loan_payment",
      actor: { kind: "system", id: "credit" },
      reason: "loan.default.write_down",
      sourceEventId: defaultEvent.eventId,
      correlationId,
      idempotencyKey: `loan-default-write-down:${loan.id}`,
      legs: [
        {
          accountId: lossAccount.id,
          direction: "debit",
          amountCents: loan.outstandingPrincipalCents,
        },
        {
          accountId: loan.bankAssetAccountId,
          direction: "credit",
          amountCents: loan.outstandingPrincipalCents,
        },
      ],
    });
    const posted = this.finance.post(transaction);
    if (posted.duplicate) {
      throw new EngineError("CONFLICT", `loan ${loan.id} write-down was already posted`);
    }
    const postedEvent = emitTransactionPosted(ctx, transaction);
    if (loan.borrowerKind === "agent") {
      const scoreUpdate = this.db.prepare(`
        UPDATE agents SET credit_score = ?
        WHERE run_id = ? AND id = ? AND credit_score = ?
      `).run(creditScoreAfter, this.runId, loan.borrowerId, creditScoreBefore);
      if (scoreUpdate.changes !== 1) {
        throw new EngineError("CONFLICT", `agent ${loan.borrowerId} credit score changed concurrently`);
      }
      ctx.emit("agent.credit_score.penalized", {
        agentId: loan.borrowerId,
        loanId: loan.id,
        defaultId,
        scoreBefore: creditScoreBefore,
        penaltyPoints: creditScorePenaltyPoints,
        scoreAfter: creditScoreAfter,
        floor: 300,
        evidence: [defaultEvent.eventId, postedEvent.eventId],
      }, {
        actor: { kind: "system", id: "credit-scoring" },
        correlationId,
        causationId: defaultEvent.eventId,
      });
    }
    const record = loanDefaultRecordSchema.parse({
      id: defaultId,
      runId: this.runId,
      loanId: loan.id,
      borrowerKind: loan.borrowerKind,
      borrowerId: loan.borrowerId,
      bankId: loan.bankId,
      defaultTick: ctx.tick,
      outstandingPrincipalCents: loan.outstandingPrincipalCents,
      missedInstallmentIds,
      writeDownTransactionId: transaction.id,
      creditScoreBefore,
      creditScorePenaltyPoints,
      creditScoreAfter,
      sourceEventId: defaultEvent.eventId,
    });
    this.db.prepare(`
      INSERT INTO loan_defaults(
        run_id, id, loan_id, borrower_kind, borrower_id, bank_id, default_tick,
        outstanding_principal_cents, missed_installment_ids_canonical,
        write_down_transaction_id, credit_score_before,
        credit_score_penalty_points, credit_score_after, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId,
      record.id,
      record.loanId,
      record.borrowerKind,
      record.borrowerId,
      record.bankId,
      record.defaultTick,
      record.outstandingPrincipalCents,
      canonicalStringify(record.missedInstallmentIds),
      record.writeDownTransactionId,
      record.creditScoreBefore,
      record.creditScorePenaltyPoints,
      record.creditScoreAfter,
      record.sourceEventId,
    );
    return Object.freeze({
      kind: "defaulted",
      loan: this.credit.getLoan(loan.id),
      currentInstallment: this.credit.listLoanInstallments(loan.id)
        .find((installment) => installment.id === current.id)!,
      collectedInstallmentIds: Object.freeze([]),
      transactions: Object.freeze([transaction]),
      defaultRecord: record,
    });
  }

  private ensureInternalAccount(
    bankId: string,
    ownerId: string,
    type: "internal_income" | "internal_expense",
    ctx: TickContext,
    causationId: string,
    correlationId: string,
  ): BankAccount {
    const existing = this.db.prepare<[string, string, string, string], InternalAccountRow>(`
      SELECT id, status FROM bank_accounts
      WHERE run_id = ? AND bank_id = ? AND owner_kind = 'bank_internal'
        AND owner_id = ? AND account_type = ?
      ORDER BY id LIMIT 1
    `).get(this.runId, bankId, ownerId, type);
    if (existing !== undefined) {
      if (existing.status !== "active") {
        throw new EngineError("CONFLICT", `internal account ${existing.id} is not active`);
      }
      return this.finance.listAccounts().find((account) => account.id === existing.id)!;
    }
    const account = this.finance.openAccount({
      id: ctx.ids.next("acct"),
      bankId,
      ownerKind: "bank_internal",
      ownerId,
      type,
      floorCents: "0",
      openedTick: ctx.tick,
      actor: { kind: "system", id: "credit" },
    });
    ctx.emit("account.opened", {
      accountId: account.id,
      bankId: account.bankId,
      ownerKind: account.ownerKind,
      ownerId: account.ownerId,
      type: account.type,
      balanceCents: account.balanceCents,
      floorCents: account.floorCents,
      evidence: [causationId],
    }, {
      actor: { kind: "system", id: "credit" },
      correlationId,
      causationId,
    });
    return account;
  }

  private internalAccountId(
    bankId: string,
    ownerId: string,
    type: "internal_liability",
  ): string {
    const row = this.db.prepare<[string, string, string, string], InternalAccountRow>(`
      SELECT id, status FROM bank_accounts
      WHERE run_id = ? AND bank_id = ? AND owner_kind = 'bank_internal'
        AND owner_id = ? AND account_type = ?
      ORDER BY id LIMIT 1
    `).get(this.runId, bankId, ownerId, type);
    if (row === undefined || row.status !== "active") {
      throw new EngineError("INTERNAL", `bank ${bankId} has no active ${type} account ${ownerId}`);
    }
    return row.id;
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "collection context belongs to another run");
    }
  }

  private inTransaction<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }
}
