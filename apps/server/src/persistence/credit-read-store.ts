/** Deterministic stored-data projections for WS-507 loan and why-panel APIs. */

import {
  EngineError,
  loanDetailResponseSchema,
  loanListItemSchema,
  type LoanDetailResponse,
  type LoanListItem,
  type LoanListQuery,
} from "@worldtangle/shared";
import type { SeedLoan } from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { SqliteBankCircuitStore } from "./bank-circuit-store";
import { SqliteCreditStore } from "./credit-store";
import { SqliteLoanCollectionStore } from "./loan-collection-store";
import { SqliteOpeningCreditStore } from "./opening-credit-store";

type LoanDetailBody = Omit<LoanDetailResponse, "meta">;

interface IdRow {
  readonly id: string;
}

interface NameRow {
  readonly name: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export class SqliteCreditReadStore {
  private readonly credit: SqliteCreditStore;
  private readonly opening: SqliteOpeningCreditStore;
  private readonly circuits: SqliteBankCircuitStore;
  private readonly collections: SqliteLoanCollectionStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    this.credit = new SqliteCreditStore(db, runId);
    this.opening = new SqliteOpeningCreditStore(db, runId);
    this.circuits = new SqliteBankCircuitStore(db, runId);
    this.collections = new SqliteLoanCollectionStore(db, runId);
  }

  listLoans(query: LoanListQuery): readonly LoanListItem[] {
    const openingState = this.opening.readState();
    const seeded = openingState.loans.map((loan) => {
      const event = openingState.seedEvents.find((candidate) => candidate.loanId === loan.id);
      if (event === undefined) {
        throw new EngineError("INTERNAL", `seed loan ${loan.id} has no causal seed event`);
      }
      return this.seedListItem(loan, event.eventId);
    });
    const originated = this.db.prepare<[string], IdRow>(`
      SELECT id FROM loans WHERE run_id = ? ORDER BY id
    `).all(this.runId).map((row) => this.originatedListItem(row.id));
    return Object.freeze([...seeded, ...originated]
      .filter((loan) => query.origin === undefined || loan.origin === query.origin)
      .filter((loan) => query.status === undefined || loan.status === query.status)
      .filter((loan) => query.bankId === undefined || loan.bank.id === query.bankId)
      .filter((loan) => (
        query.borrowerKind === undefined || loan.borrower.kind === query.borrowerKind
      ))
      .filter((loan) => query.borrowerId === undefined || loan.borrower.id === query.borrowerId)
      .sort((left, right) => (
        right.openedTick - left.openedTick || compareCodeUnits(right.id, left.id)
      )));
  }

  getLoan(loanId: string): LoanDetailBody {
    const openingState = this.opening.readState();
    const seed = openingState.loans.find((candidate) => candidate.id === loanId);
    if (seed !== undefined) {
      const event = openingState.seedEvents.find((candidate) => candidate.loanId === loanId);
      const link = openingState.links.find((candidate) => candidate.loanId === loanId);
      if (event === undefined || link === undefined || event.causationId === null) {
        throw new EngineError("INTERNAL", `seed loan ${loanId} provenance is incomplete`);
      }
      const parsed = loanDetailResponseSchema.parse({
        loan: {
          ...this.seedListItem(seed, event.eventId),
          disbursedTick: null,
          maturityTick: null,
          scheduleDigest: event.scheduleDigest,
          bankAssetAccountId: link.bankAssetAccountId,
          borrowerDepositAccountId: link.borrowerDepositAccountId,
          recognitionTransactionId: link.recognitionTransactionId,
        },
        schedule: seed.installments.map((installment) => ({
          installmentNumber: installment.installment,
          dueTick: null,
          principalDueCents: installment.principalCents,
          interestDueCents: installment.interestCents,
          totalDueCents: (
            BigInt(installment.principalCents) + BigInt(installment.interestCents)
          ).toString(),
          status: installment.status,
          paidTick: null,
          transactionId: null,
          sourceEventId: null,
        })),
        why: {
          kind: "opening_seed",
          explanation: seed.status === "delinquent"
            ? `Opening credit was imported at tick 0 after ${seed.seasonedMonths} months; ${seed.missedPayments} stored missed payment keeps it delinquent.`
            : `Opening credit was imported at tick 0 after ${seed.seasonedMonths} months with every seasoned payment stored as paid.`,
          seasonedMonths: seed.seasonedMonths,
          missedPayments: seed.missedPayments,
          recognitionTransactionId: link.recognitionTransactionId,
          bankAssetAccountId: link.bankAssetAccountId,
          borrowerDepositAccountId: link.borrowerDepositAccountId,
          scheduleDigest: event.scheduleDigest,
          sourceEventId: event.eventId,
          causationId: event.causationId,
          correlationId: event.correlationId,
          evidence: event.evidence,
        },
        meta: { simulated: true, apiVersion: 1 },
      });
      return Object.freeze({ loan: parsed.loan, schedule: parsed.schedule, why: parsed.why });
    }

    const loan = this.credit.getLoan(loanId);
    const application = this.credit.getApplication(loan.applicationId);
    const assessment = this.credit.getAssessmentForApplication(application.id);
    const review = this.credit.getReviewForApplication(application.id);
    const decision = this.credit.getDecisionForApplication(application.id);
    const circuitAssessments = this.circuits.listForApplication(application.id);
    const installments = this.credit.listLoanInstallments(loan.id);
    const defaultRecord = this.collections.getDefaultForLoan(loan.id);
    const parsed = loanDetailResponseSchema.parse({
      loan: {
        ...this.originatedListItem(loan.id),
        disbursedTick: loan.disbursedTick,
        maturityTick: loan.maturityTick,
        scheduleDigest: loan.scheduleDigest,
        bankAssetAccountId: loan.bankAssetAccountId,
        borrowerDepositAccountId: loan.borrowerDepositAccountId,
        recognitionTransactionId: loan.disbursementTransactionId,
      },
      schedule: installments.map((installment) => ({
        installmentNumber: installment.installmentNumber,
        dueTick: installment.dueTick,
        principalDueCents: installment.principalDueCents,
        interestDueCents: installment.interestDueCents,
        totalDueCents: installment.totalDueCents,
        status: installment.status,
        paidTick: installment.paidTick,
        transactionId: installment.transactionId,
        sourceEventId: installment.sourceEventId,
      })),
      why: {
        kind: "underwritten",
        explanation: `Stored model-v${assessment.modelVersion} score ${assessment.systemScore} and ${decision.policyChecks.filter((check) => check.passed).length}/${decision.policyChecks.length} policy checks produced an ${decision.outcome} decision before atomic disbursement.`,
        application,
        assessment,
        review,
        decision,
        circuitAssessments,
        default: defaultRecord,
        evidence: unique([
          application.sourceEventId,
          assessment.sourceEventId,
          review.sourceEventId,
          ...circuitAssessments.map((item) => item.sourceEventId),
          decision.sourceEventId,
          loan.sourceEventId,
          ...installments.map((item) => item.sourceEventId),
          ...(defaultRecord === null ? [] : [defaultRecord.sourceEventId]),
        ]),
      },
      meta: { simulated: true, apiVersion: 1 },
    });
    return Object.freeze({ loan: parsed.loan, schedule: parsed.schedule, why: parsed.why });
  }

  private seedListItem(seed: SeedLoan, sourceEventId: string): LoanListItem {
    const borrowerKind = seed.borrowerKind;
    const completed = seed.installments.filter((item) => item.status === "paid").length;
    const missed = seed.installments.filter((item) => item.status === "missed").length;
    return loanListItemSchema.parse({
      id: seed.id,
      origin: "opening_seed",
      borrower: {
        kind: borrowerKind,
        id: seed.borrowerId,
        name: this.borrowerName(borrowerKind, seed.borrowerId),
      },
      bank: this.bankForSeedLoan(seed.id),
      purpose: seed.purpose,
      principalCents: seed.originalPrincipalCents,
      outstandingPrincipalCents: seed.outstandingPrincipalCents,
      annualRateBp: seed.annualRateBp,
      termMonths: seed.termMonths,
      status: seed.status,
      openedTick: 0,
      progress: {
        completedInstallments: completed,
        missedInstallments: missed,
        totalInstallments: seed.installments.length,
        nextDueTick: null,
      },
      sourceEventId,
    });
  }

  private originatedListItem(loanId: string): LoanListItem {
    const loan = this.credit.getLoan(loanId);
    const application = this.credit.getApplication(loan.applicationId);
    const installments = this.credit.listLoanInstallments(loan.id);
    return loanListItemSchema.parse({
      id: loan.id,
      origin: "originated",
      borrower: {
        kind: loan.borrowerKind,
        id: loan.borrowerId,
        name: this.borrowerName(loan.borrowerKind, loan.borrowerId),
      },
      bank: this.bank(loan.bankId),
      purpose: application.purpose,
      principalCents: loan.principalCents,
      outstandingPrincipalCents: loan.outstandingPrincipalCents,
      annualRateBp: loan.annualRateBp,
      termMonths: loan.termMonths,
      status: loan.status,
      openedTick: loan.disbursedTick,
      progress: {
        completedInstallments: installments.filter((item) => item.status === "completed").length,
        missedInstallments: installments.filter((item) => item.status === "missed").length,
        totalInstallments: installments.length,
        nextDueTick: installments.find((item) => item.status === "due")?.dueTick ?? null,
      },
      sourceEventId: loan.sourceEventId,
    });
  }

  private borrowerName(kind: "agent" | "company" | "business", id: string): string {
    if (kind === "business") {
      const words = id.slice("biz_".length).split("_").filter((word) => word.length > 0);
      const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
      if (name.length === 0) throw new EngineError("INTERNAL", `business ${id} has no name`);
      return name;
    }
    const row = kind === "agent"
      ? this.db.prepare<[string, string], NameRow>(`
          SELECT persona.name
          FROM agents agent
          JOIN personas persona
            ON persona.run_id = agent.run_id AND persona.id = agent.persona_id
          WHERE agent.run_id = ? AND agent.id = ?
        `).get(this.runId, id)
      : this.db.prepare<[string, string], NameRow>(`
          SELECT name FROM companies WHERE run_id = ? AND id = ?
        `).get(this.runId, id);
    if (row === undefined) throw new EngineError("INTERNAL", `${kind} ${id} has no name`);
    return row.name;
  }

  private bankForSeedLoan(loanId: string): { readonly id: string; readonly name: string } {
    const row = this.db.prepare<[string, string], { id: string; name: string }>(`
      SELECT bank.id, bank.name
      FROM seed_loan_ledger_links link
      JOIN bank_accounts asset
        ON asset.run_id = link.run_id AND asset.id = link.bank_asset_account_id
      JOIN banks bank ON bank.run_id = asset.run_id AND bank.id = asset.bank_id
      WHERE link.run_id = ? AND link.loan_id = ?
    `).get(this.runId, loanId);
    if (row === undefined) throw new EngineError("INTERNAL", `seed loan ${loanId} has no bank`);
    return row;
  }

  private bank(bankId: string): { readonly id: string; readonly name: string } {
    const row = this.db.prepare<[string, string], NameRow>(`
      SELECT name FROM banks WHERE run_id = ? AND id = ?
    `).get(this.runId, bankId);
    if (row === undefined) throw new EngineError("INTERNAL", `bank ${bankId} has no name`);
    return { id: bankId, name: row.name };
  }
}
