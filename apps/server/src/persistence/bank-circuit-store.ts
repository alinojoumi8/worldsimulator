/** SQLite M09 live reserve, capital, and borrower-concentration circuit assessments. */

import {
  EngineError,
  bankLendingAssessmentSchema,
  canonicalParse,
  canonicalStringify,
  runIdSchema,
  type BankLendingAssessment,
  type BankLendingAssessmentStage,
  type BankStatus,
  type LoanApplication,
} from "@worldtangle/shared";
import {
  evaluateBankLendingCircuit,
  type TickContext,
} from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";

interface BankCircuitRow {
  readonly capital_cents: string;
  readonly reserve_cents: string;
  readonly reserve_ratio_bp: bigint;
  readonly capital_ratio_min_bp: bigint;
  readonly exposure_cap_cents: string;
  readonly status: BankStatus;
}

interface BalanceRow {
  readonly balance_cents: string;
}

interface IncomeExpenseRow extends BalanceRow {
  readonly account_type: "internal_income" | "internal_expense";
}

interface ExposureRow {
  readonly outstanding_principal_cents: string;
}

interface BankLendingAssessmentRow {
  readonly id: string;
  readonly bank_id: string;
  readonly application_id: string;
  readonly decision_id: string | null;
  readonly stage: BankLendingAssessmentStage;
  readonly borrower_kind: BankLendingAssessment["borrowerKind"];
  readonly borrower_id: string;
  readonly assessed_tick: bigint;
  readonly policy_version: bigint;
  readonly bank_status_before: BankStatus;
  readonly bank_status_after: BankStatus;
  readonly deposit_cents: string;
  readonly projected_deposit_cents: string;
  readonly reserve_cents: string;
  readonly reserve_ratio_bp: bigint;
  readonly projected_reserve_ratio_bp: bigint;
  readonly reserve_ratio_min_bp: bigint;
  readonly effective_capital_cents: string;
  readonly capital_ratio_bp: bigint;
  readonly projected_capital_ratio_bp: bigint;
  readonly capital_ratio_min_bp: bigint;
  readonly borrower_exposure_cents: string;
  readonly projected_borrower_exposure_cents: string;
  readonly borrower_exposure_cap_cents: string;
  readonly requested_amount_cents: string;
  readonly bank_open: bigint;
  readonly reserve_passed: bigint;
  readonly capital_passed: bigint;
  readonly exposure_passed: bigint;
  readonly systemic_passed: bigint;
  readonly allowed: bigint;
  readonly failed_breakers_canonical: string;
  readonly source_event_id: string;
}

export interface BankCircuitAssessmentResult {
  readonly assessment: BankLendingAssessment;
  readonly terminalEventId: string;
}

function boolean(value: bigint, field: string): boolean {
  if (value !== 0n && value !== 1n) {
    throw new EngineError("INTERNAL", `persisted ${field} is not boolean`);
  }
  return value === 1n;
}

function mapAssessment(runId: string, row: BankLendingAssessmentRow): BankLendingAssessment {
  return bankLendingAssessmentSchema.parse({
    id: row.id,
    runId,
    bankId: row.bank_id,
    applicationId: row.application_id,
    decisionId: row.decision_id,
    stage: row.stage,
    borrowerKind: row.borrower_kind,
    borrowerId: row.borrower_id,
    assessedTick: toSafeNumber(row.assessed_tick, "bank assessment tick"),
    policyVersion: toSafeNumber(row.policy_version, "bank circuit policy version"),
    bankStatusBefore: row.bank_status_before,
    bankStatusAfter: row.bank_status_after,
    depositCents: row.deposit_cents,
    projectedDepositCents: row.projected_deposit_cents,
    reserveCents: row.reserve_cents,
    reserveRatioBp: toSafeNumber(row.reserve_ratio_bp, "bank reserve ratio"),
    projectedReserveRatioBp: toSafeNumber(
      row.projected_reserve_ratio_bp,
      "projected bank reserve ratio",
    ),
    reserveRatioMinBp: toSafeNumber(row.reserve_ratio_min_bp, "minimum reserve ratio"),
    effectiveCapitalCents: row.effective_capital_cents,
    capitalRatioBp: toSafeNumber(row.capital_ratio_bp, "bank capital ratio"),
    projectedCapitalRatioBp: toSafeNumber(
      row.projected_capital_ratio_bp,
      "projected bank capital ratio",
    ),
    capitalRatioMinBp: toSafeNumber(row.capital_ratio_min_bp, "minimum capital ratio"),
    borrowerExposureCents: row.borrower_exposure_cents,
    projectedBorrowerExposureCents: row.projected_borrower_exposure_cents,
    borrowerExposureCapCents: row.borrower_exposure_cap_cents,
    requestedAmountCents: row.requested_amount_cents,
    bankOpen: boolean(row.bank_open, "bank-open flag"),
    reservePassed: boolean(row.reserve_passed, "reserve-pass flag"),
    capitalPassed: boolean(row.capital_passed, "capital-pass flag"),
    exposurePassed: boolean(row.exposure_passed, "exposure-pass flag"),
    systemicPassed: boolean(row.systemic_passed, "systemic-pass flag"),
    allowed: boolean(row.allowed, "allowed flag"),
    failedBreakers: canonicalParse(row.failed_breakers_canonical),
    sourceEventId: row.source_event_id,
  });
}

export class SqliteBankCircuitStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    if (db.prepare<[string], { id: string }>(
      "SELECT id FROM simulation_runs WHERE id = ?",
    ).get(runId) === undefined) {
      throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
    }
  }

  listForApplication(applicationId: string): readonly BankLendingAssessment[] {
    return Object.freeze(this.db.prepare<[string, string], BankLendingAssessmentRow>(`
      SELECT * FROM bank_lending_assessments
      WHERE run_id = ? AND application_id = ?
      ORDER BY assessed_tick, stage, id
    `).all(this.runId, applicationId).map((row) => mapAssessment(this.runId, row)));
  }

  getLatestForApplication(
    applicationId: string,
    stage: BankLendingAssessmentStage,
  ): BankLendingAssessment {
    const row = this.db.prepare<[string, string, BankLendingAssessmentStage], BankLendingAssessmentRow>(`
      SELECT * FROM bank_lending_assessments
      WHERE run_id = ? AND application_id = ? AND stage = ?
      ORDER BY assessed_tick DESC, id DESC LIMIT 1
    `).get(this.runId, applicationId, stage);
    if (row === undefined) {
      throw new EngineError(
        "NOT_FOUND",
        `${stage} circuit assessment for application ${applicationId} does not exist`,
      );
    }
    return mapAssessment(this.runId, row);
  }

  assessApplication(
    application: LoanApplication,
    input: {
      readonly stage: BankLendingAssessmentStage;
      readonly decisionId: string | null;
      readonly causationId: string;
      readonly evidenceRefs: readonly string[];
    },
    ctx: TickContext,
  ): BankCircuitAssessmentResult {
    this.assertContext(ctx);
    if (application.runId !== this.runId) {
      throw new EngineError("CONFLICT", "loan application belongs to another run");
    }
    if ((input.stage === "disbursement") !== (input.decisionId !== null)) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "only disbursement assessments may reference a decision",
      );
    }
    return this.inTransaction(() => {
      const bank = this.bank(application.bankId);
      const deposits = this.deposits(application.bankId);
      const effectiveCapital = this.effectiveCapital(application.bankId, bank.capital_cents);
      const borrowerExposure = this.borrowerExposure(
        application.bankId,
        application.applicantId,
      );
      const evaluation = evaluateBankLendingCircuit({
        bankStatus: bank.status,
        depositCents: deposits.toString(),
        reserveCents: bank.reserve_cents,
        reserveRatioMinBp: toSafeNumber(bank.reserve_ratio_bp, "minimum reserve ratio"),
        effectiveCapitalCents: effectiveCapital.toString(),
        capitalRatioMinBp: toSafeNumber(
          bank.capital_ratio_min_bp,
          "minimum capital ratio",
        ),
        borrowerExposureCents: borrowerExposure.toString(),
        borrowerExposureCapCents: bank.exposure_cap_cents,
        requestedAmountCents: application.amountCents,
      });
      const assessmentId = ctx.ids.next("bca");
      const correlationId = `loan-application:${application.id}`;
      const assessedEvent = ctx.emit("bank.lending.assessed", {
        assessmentId,
        applicationId: application.id,
        decisionId: input.decisionId,
        stage: input.stage,
        bankId: application.bankId,
        borrowerKind: application.applicantKind,
        borrowerId: application.applicantId,
        assessedTick: ctx.tick,
        ...evaluation,
        evidence: [...input.evidenceRefs],
      }, {
        actor: { kind: "institution", id: application.bankId },
        correlationId,
        causationId: input.causationId,
      });
      const assessment = bankLendingAssessmentSchema.parse({
        id: assessmentId,
        runId: this.runId,
        bankId: application.bankId,
        applicationId: application.id,
        decisionId: input.decisionId,
        stage: input.stage,
        borrowerKind: application.applicantKind,
        borrowerId: application.applicantId,
        assessedTick: ctx.tick,
        ...evaluation,
        sourceEventId: assessedEvent.eventId,
      });
      this.insert(assessment);

      let terminalEventId = assessedEvent.eventId;
      if (assessment.bankStatusAfter !== assessment.bankStatusBefore) {
        const update = this.db.prepare(`
          UPDATE banks SET status = ? WHERE run_id = ? AND id = ? AND status = ?
        `).run(
          assessment.bankStatusAfter,
          this.runId,
          assessment.bankId,
          assessment.bankStatusBefore,
        );
        if (update.changes !== 1) {
          throw new EngineError("CONFLICT", `bank ${assessment.bankId} status changed concurrently`);
        }
        const transitionType = assessment.bankStatusAfter === "active"
          ? "bank.lending.resumed"
          : "bank.lending.halted";
        const transition = ctx.emit(transitionType, {
          bankId: assessment.bankId,
          assessmentId: assessment.id,
          applicationId: assessment.applicationId,
          stage: assessment.stage,
          statusBefore: assessment.bankStatusBefore,
          statusAfter: assessment.bankStatusAfter,
          failedBreakers: assessment.failedBreakers.filter((breaker) => (
            breaker !== "borrower_exposure"
          )),
          evidence: [assessment.sourceEventId, ...input.evidenceRefs],
        }, {
          actor: { kind: "institution", id: assessment.bankId },
          correlationId,
          causationId: assessment.sourceEventId,
        });
        terminalEventId = transition.eventId;
      }
      if (!assessment.allowed) {
        const blocked = ctx.emit("bank.lending.blocked", {
          bankId: assessment.bankId,
          assessmentId: assessment.id,
          applicationId: assessment.applicationId,
          decisionId: assessment.decisionId,
          stage: assessment.stage,
          scope: assessment.systemicPassed ? "borrower" : "bank",
          requestedAmountCents: assessment.requestedAmountCents,
          failedBreakers: assessment.failedBreakers,
          bankStatus: assessment.bankStatusAfter,
          evidence: [assessment.sourceEventId, terminalEventId, ...input.evidenceRefs],
        }, {
          actor: { kind: "institution", id: assessment.bankId },
          correlationId,
          causationId: terminalEventId,
        });
        terminalEventId = blocked.eventId;
      }
      return Object.freeze({ assessment, terminalEventId });
    });
  }

  private bank(bankId: string): BankCircuitRow {
    const row = this.db.prepare<[string, string], BankCircuitRow>(`
      SELECT capital_cents, reserve_cents, reserve_ratio_bp,
        capital_ratio_min_bp, exposure_cap_cents, status
      FROM banks WHERE run_id = ? AND id = ?
    `).get(this.runId, bankId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `bank ${bankId} does not exist`);
    return row;
  }

  private deposits(bankId: string): bigint {
    return this.db.prepare<[string, string], BalanceRow>(`
      SELECT balance_cents FROM bank_accounts
      WHERE run_id = ? AND bank_id = ? AND account_type = 'checking'
        AND owner_kind IN ('agent', 'company', 'government')
      ORDER BY id
    `).all(this.runId, bankId).reduce((sum, row) => sum + BigInt(row.balance_cents), 0n);
  }

  private effectiveCapital(bankId: string, openingCapitalCents: string): bigint {
    const netIncome = this.db.prepare<[string, string], IncomeExpenseRow>(`
      SELECT account_type, balance_cents FROM bank_accounts
      WHERE run_id = ? AND bank_id = ? AND owner_kind = 'bank_internal'
        AND account_type IN ('internal_income', 'internal_expense')
      ORDER BY id
    `).all(this.runId, bankId).reduce((sum, row) => (
      sum + (row.account_type === "internal_income"
        ? BigInt(row.balance_cents)
        : -BigInt(row.balance_cents))
    ), 0n);
    const effective = BigInt(openingCapitalCents) + netIncome;
    return effective > 0n ? effective : 0n;
  }

  private borrowerExposure(bankId: string, borrowerId: string): bigint {
    const seed = this.db.prepare<[string, string, string], ExposureRow>(`
      SELECT s.outstanding_principal_cents
      FROM seed_loans s
      JOIN seed_loan_ledger_links link
        ON link.run_id = s.run_id AND link.loan_id = s.id
      JOIN bank_accounts asset
        ON asset.run_id = link.run_id AND asset.id = link.bank_asset_account_id
      WHERE s.run_id = ? AND asset.bank_id = ? AND s.borrower_id = ?
      ORDER BY s.id
    `).all(this.runId, bankId, borrowerId).reduce(
      (sum, row) => sum + BigInt(row.outstanding_principal_cents),
      0n,
    );
    const originated = this.db.prepare<[string, string, string], ExposureRow>(`
      SELECT outstanding_principal_cents FROM loans
      WHERE run_id = ? AND bank_id = ? AND borrower_id = ?
        AND CAST(outstanding_principal_cents AS INTEGER) > 0
      ORDER BY id
    `).all(this.runId, bankId, borrowerId).reduce(
      (sum, row) => sum + BigInt(row.outstanding_principal_cents),
      0n,
    );
    return seed + originated;
  }

  private insert(assessment: BankLendingAssessment): void {
    this.db.prepare(`
      INSERT INTO bank_lending_assessments(
        run_id, id, bank_id, application_id, decision_id, stage,
        borrower_kind, borrower_id, assessed_tick, policy_version,
        bank_status_before, bank_status_after, deposit_cents,
        projected_deposit_cents, reserve_cents, reserve_ratio_bp,
        projected_reserve_ratio_bp, reserve_ratio_min_bp,
        effective_capital_cents, capital_ratio_bp, projected_capital_ratio_bp,
        capital_ratio_min_bp, borrower_exposure_cents,
        projected_borrower_exposure_cents, borrower_exposure_cap_cents,
        requested_amount_cents, bank_open, reserve_passed, capital_passed,
        exposure_passed, systemic_passed, allowed, failed_breakers_canonical,
        source_event_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      assessment.runId,
      assessment.id,
      assessment.bankId,
      assessment.applicationId,
      assessment.decisionId,
      assessment.stage,
      assessment.borrowerKind,
      assessment.borrowerId,
      assessment.assessedTick,
      assessment.policyVersion,
      assessment.bankStatusBefore,
      assessment.bankStatusAfter,
      assessment.depositCents,
      assessment.projectedDepositCents,
      assessment.reserveCents,
      assessment.reserveRatioBp,
      assessment.projectedReserveRatioBp,
      assessment.reserveRatioMinBp,
      assessment.effectiveCapitalCents,
      assessment.capitalRatioBp,
      assessment.projectedCapitalRatioBp,
      assessment.capitalRatioMinBp,
      assessment.borrowerExposureCents,
      assessment.projectedBorrowerExposureCents,
      assessment.borrowerExposureCapCents,
      assessment.requestedAmountCents,
      assessment.bankOpen ? 1 : 0,
      assessment.reservePassed ? 1 : 0,
      assessment.capitalPassed ? 1 : 0,
      assessment.exposurePassed ? 1 : 0,
      assessment.systemicPassed ? 1 : 0,
      assessment.allowed ? 1 : 0,
      canonicalStringify(assessment.failedBreakers),
      assessment.sourceEventId,
    );
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("CONFLICT", "tick context belongs to another run");
    }
  }

  private inTransaction<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
