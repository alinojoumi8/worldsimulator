import {
  CREDIT_SCORE_MODEL_VERSION,
  EngineError,
  LOAN_POLICY_VERSION,
  canonicalParse,
  canonicalStringify,
  creditScoreAssessmentSchema,
  creditScoreInputsSchema,
  decisionIdSchema,
  ledgerTransactionSchema,
  loanApplicationDecisionSchema,
  loanApplicationReviewSchema,
  loanApplicationSchema,
  loanInstallmentSchema,
  loanSchema,
  submitLoanApplicationInputSchema,
  type CreditApplicantKind,
  type BankLendingAssessment,
  type CreditScoreAssessment,
  type CreditScoreInputs,
  type LedgerTransaction,
  type Loan,
  type LoanApplication,
  type LoanApplicationDecision,
  type LoanApplicationReview,
  type LoanInstallment,
  type SubmitLoanApplicationInput,
} from "@worldtangle/shared";
import {
  amortizationScheduleDigest,
  calculateCreditScore,
  creditHistoryScoreBasisPoints,
  debtToIncomeBasisPoints,
  evaluateLoanPolicy,
  generateAmortizationSchedule,
  principalDueWithinYear,
  tier1LoanReviewRationale,
  transitionLoanApplicationStatus,
  type TickContext,
} from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteBankCircuitStore } from "./bank-circuit-store";
import { SqliteFinanceStore } from "./finance-store";

interface LoanApplicationRow {
  readonly id: string;
  readonly applicant_kind: CreditApplicantKind;
  readonly applicant_id: string;
  readonly bank_id: string;
  readonly purpose: string;
  readonly amount_cents: string;
  readonly term_months: bigint;
  readonly status: LoanApplication["status"];
  readonly submitted_tick: bigint;
  readonly decided_tick: bigint | null;
  readonly source_event_id: string;
}

interface CreditScoreAssessmentRow {
  readonly id: string;
  readonly application_id: string;
  readonly model_version: bigint;
  readonly inputs_canonical: string;
  readonly system_score: bigint;
  readonly breakdown_canonical: string;
  readonly computed_tick: bigint;
  readonly source_event_id: string;
}

interface LoanApplicationReviewRow {
  readonly id: string;
  readonly application_id: string;
  readonly officer_agent_id: string;
  readonly review_tier: LoanApplicationReview["reviewTier"];
  readonly started_tick: bigint;
  readonly source_event_id: string;
}

interface LoanApplicationDecisionRow {
  readonly id: string;
  readonly application_id: string;
  readonly assessment_id: string;
  readonly review_id: string;
  readonly officer_agent_id: string;
  readonly review_tier: LoanApplicationDecision["reviewTier"];
  readonly agent_decision_id: string | null;
  readonly policy_version: bigint;
  readonly system_score: bigint;
  readonly officer_adjustment: bigint;
  readonly final_score: bigint;
  readonly rationale: string;
  readonly policy_checks_canonical: string;
  readonly outcome: LoanApplicationDecision["outcome"];
  readonly offered_rate_bp: bigint | null;
  readonly decided_tick: bigint;
  readonly source_event_id: string;
}

interface LoanRow {
  readonly id: string;
  readonly application_id: string;
  readonly decision_id: string;
  readonly borrower_kind: CreditApplicantKind;
  readonly borrower_id: string;
  readonly bank_id: string;
  readonly principal_cents: string;
  readonly annual_rate_bp: bigint;
  readonly term_months: bigint;
  readonly disbursed_tick: bigint;
  readonly maturity_tick: bigint;
  readonly outstanding_principal_cents: string;
  readonly consecutive_misses: bigint;
  readonly status: Loan["status"];
  readonly bank_asset_account_id: string;
  readonly borrower_deposit_account_id: string;
  readonly disbursement_transaction_id: string;
  readonly schedule_digest: string;
  readonly source_event_id: string;
}

interface LoanInstallmentRow {
  readonly id: string;
  readonly loan_id: string;
  readonly installment_number: bigint;
  readonly due_tick: bigint;
  readonly opening_principal_cents: string;
  readonly principal_due_cents: string;
  readonly interest_due_cents: string;
  readonly total_due_cents: string;
  readonly status: LoanInstallment["status"];
  readonly paid_tick: bigint | null;
  readonly transaction_id: string | null;
  readonly source_event_id: string;
}

interface BankPolicyRow {
  readonly id: string;
  readonly base_lending_rate_bp: bigint;
}

interface SeedLoanRow {
  readonly id: string;
  readonly outstanding_principal_cents: string;
  readonly loan_canonical: string;
}

interface ParsedInstallment {
  readonly installment: number;
  readonly principalCents: string;
  readonly interestCents: string;
  readonly status: "paid" | "scheduled" | "missed";
}

export interface LoanDisbursementResult {
  readonly loan: Loan;
  readonly installments: readonly LoanInstallment[];
  readonly transaction: LedgerTransaction;
}

export interface BlockedLoanDisbursement {
  readonly kind: "blocked";
  readonly assessment: BankLendingAssessment;
  readonly sourceEventId: string;
}

export interface CompletedLoanDisbursement extends LoanDisbursementResult {
  readonly kind: "disbursed";
}

export type LoanDisbursementAttempt = BlockedLoanDisbursement | CompletedLoanDisbursement;

function parseNonnegativeCents(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new EngineError("INTERNAL", `persisted ${field} is not nonnegative cents`);
  }
  return value;
}

function parseInstallments(text: string, loanId: string): readonly ParsedInstallment[] {
  const parsed = canonicalParse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("INTERNAL", `seed loan ${loanId} is not an object`);
  }
  const installments = (parsed as Record<string, unknown>)["installments"];
  if (!Array.isArray(installments)) {
    throw new EngineError("INTERNAL", `seed loan ${loanId} has no installment history`);
  }
  return Object.freeze(installments.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EngineError("INTERNAL", `seed loan ${loanId} installment ${index} is invalid`);
    }
    const row = value as Record<string, unknown>;
    const installment = row["installment"];
    const status = row["status"];
    if (!Number.isSafeInteger(installment) || Number(installment) < 1 ||
      (status !== "paid" && status !== "scheduled" && status !== "missed")) {
      throw new EngineError("INTERNAL", `seed loan ${loanId} installment ${index} is invalid`);
    }
    return Object.freeze({
      installment: Number(installment),
      principalCents: parseNonnegativeCents(
        row["principalCents"],
        `seed loan ${loanId} principal`,
      ),
      interestCents: parseNonnegativeCents(
        row["interestCents"],
        `seed loan ${loanId} interest`,
      ),
      status,
    });
  }));
}

function mapApplication(runId: string, row: LoanApplicationRow): LoanApplication {
  return loanApplicationSchema.parse({
    id: row.id,
    runId,
    applicantKind: row.applicant_kind,
    applicantId: row.applicant_id,
    bankId: row.bank_id,
    purpose: row.purpose,
    amountCents: row.amount_cents,
    termMonths: toSafeNumber(row.term_months, "loan application term"),
    status: row.status,
    submittedTick: toSafeNumber(row.submitted_tick, "loan application submitted tick"),
    decidedTick: row.decided_tick === null
      ? null
      : toSafeNumber(row.decided_tick, "loan application decided tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapAssessment(runId: string, row: CreditScoreAssessmentRow): CreditScoreAssessment {
  return creditScoreAssessmentSchema.parse({
    id: row.id,
    runId,
    applicationId: row.application_id,
    modelVersion: toSafeNumber(row.model_version, "credit score model version"),
    inputs: canonicalParse(row.inputs_canonical),
    systemScore: toSafeNumber(row.system_score, "system credit score"),
    breakdown: canonicalParse(row.breakdown_canonical),
    computedTick: toSafeNumber(row.computed_tick, "credit score computed tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapReview(runId: string, row: LoanApplicationReviewRow): LoanApplicationReview {
  return loanApplicationReviewSchema.parse({
    id: row.id,
    runId,
    applicationId: row.application_id,
    officerAgentId: row.officer_agent_id,
    reviewTier: row.review_tier,
    startedTick: toSafeNumber(row.started_tick, "loan review started tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapDecision(runId: string, row: LoanApplicationDecisionRow): LoanApplicationDecision {
  return loanApplicationDecisionSchema.parse({
    id: row.id,
    runId,
    applicationId: row.application_id,
    assessmentId: row.assessment_id,
    reviewId: row.review_id,
    officerAgentId: row.officer_agent_id,
    reviewTier: row.review_tier,
    agentDecisionId: row.agent_decision_id,
    policyVersion: toSafeNumber(row.policy_version, "loan policy version"),
    systemScore: toSafeNumber(row.system_score, "loan decision system score"),
    officerAdjustment: toSafeNumber(
      row.officer_adjustment,
      "loan decision officer adjustment",
    ),
    finalScore: toSafeNumber(row.final_score, "loan decision final score"),
    rationale: row.rationale,
    policyChecks: canonicalParse(row.policy_checks_canonical),
    outcome: row.outcome,
    offeredRateBp: row.offered_rate_bp === null
      ? null
      : toSafeNumber(row.offered_rate_bp, "loan offered rate"),
    decidedTick: toSafeNumber(row.decided_tick, "loan decision tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapLoan(runId: string, row: LoanRow): Loan {
  return loanSchema.parse({
    id: row.id,
    runId,
    applicationId: row.application_id,
    decisionId: row.decision_id,
    borrowerKind: row.borrower_kind,
    borrowerId: row.borrower_id,
    bankId: row.bank_id,
    principalCents: row.principal_cents,
    annualRateBp: toSafeNumber(row.annual_rate_bp, "loan annual rate"),
    termMonths: toSafeNumber(row.term_months, "loan term"),
    disbursedTick: toSafeNumber(row.disbursed_tick, "loan disbursement tick"),
    maturityTick: toSafeNumber(row.maturity_tick, "loan maturity tick"),
    outstandingPrincipalCents: row.outstanding_principal_cents,
    consecutiveMisses: toSafeNumber(row.consecutive_misses, "loan consecutive misses"),
    status: row.status,
    bankAssetAccountId: row.bank_asset_account_id,
    borrowerDepositAccountId: row.borrower_deposit_account_id,
    disbursementTransactionId: row.disbursement_transaction_id,
    scheduleDigest: row.schedule_digest,
    sourceEventId: row.source_event_id,
  });
}

function mapLoanInstallment(runId: string, row: LoanInstallmentRow): LoanInstallment {
  return loanInstallmentSchema.parse({
    id: row.id,
    runId,
    loanId: row.loan_id,
    installmentNumber: toSafeNumber(row.installment_number, "loan installment number"),
    dueTick: toSafeNumber(row.due_tick, "loan installment due tick"),
    openingPrincipalCents: row.opening_principal_cents,
    principalDueCents: row.principal_due_cents,
    interestDueCents: row.interest_due_cents,
    totalDueCents: row.total_due_cents,
    status: row.status,
    paidTick: row.paid_tick === null
      ? null
      : toSafeNumber(row.paid_tick, "loan installment paid tick"),
    transactionId: row.transaction_id,
    sourceEventId: row.source_event_id,
  });
}

export class SqliteCreditStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  submitApplication(
    input: SubmitLoanApplicationInput,
    ctx: TickContext,
    causationId?: string,
  ): { readonly application: LoanApplication; readonly assessment: CreditScoreAssessment } {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "credit context belongs to another run");
    }
    const request = submitLoanApplicationInputSchema.parse(input);
    const bank = this.db.prepare<[string, string], { status: string }>(`
      SELECT status FROM banks WHERE run_id = ? AND id = ?
    `).get(this.runId, request.bankId);
    if (bank === undefined) {
      throw new EngineError("NOT_FOUND", `bank ${request.bankId} does not exist`);
    }
    if (bank.status === "closed") {
      throw new EngineError("CONFLICT", `bank ${request.bankId} is closed`);
    }

    const inputs = this.buildScoreInputs(request, ctx.tick);
    const breakdown = calculateCreditScore(inputs);
    const applicationId = ctx.ids.next("loanapp");
    const assessmentId = ctx.ids.next("cscore");
    const inputCandidate = {
      id: applicationId,
      runId: this.runId,
      ...request,
      status: "submitted" as const,
      submittedTick: ctx.tick,
      decidedTick: null,
      sourceEventId: "evt_placeholder0",
    };
    const validatedCandidate = loanApplicationSchema.parse(inputCandidate);
    const correlationId = `loan-application:${applicationId}`;
    const applicationEvent = ctx.emit("loan.application.created", {
      applicationId,
      applicantKind: request.applicantKind,
      applicantId: request.applicantId,
      bankId: request.bankId,
      purpose: request.purpose,
      amountCents: request.amountCents,
      termMonths: request.termMonths,
      scoreAssessmentId: assessmentId,
      modelVersion: CREDIT_SCORE_MODEL_VERSION,
    }, {
      actor: request.applicantKind === "agent"
        ? { kind: "agent", id: request.applicantId }
        : { kind: "institution", id: request.applicantId },
      correlationId,
      ...(causationId === undefined ? {} : { causationId }),
    });
    const scoreEvent = ctx.emit("loan.score.computed", {
      assessmentId,
      applicationId,
      applicantKind: request.applicantKind,
      applicantId: request.applicantId,
      modelVersion: CREDIT_SCORE_MODEL_VERSION,
      inputs,
      systemScore: breakdown.totalPoints,
      breakdown,
    }, {
      actor: { kind: "system", id: "credit-scoring" },
      correlationId,
      causationId: applicationEvent.eventId,
    });
    const application = loanApplicationSchema.parse({
      ...validatedCandidate,
      sourceEventId: applicationEvent.eventId,
    });
    const assessment = creditScoreAssessmentSchema.parse({
      id: assessmentId,
      runId: this.runId,
      applicationId,
      modelVersion: CREDIT_SCORE_MODEL_VERSION,
      inputs,
      systemScore: breakdown.totalPoints,
      breakdown,
      computedTick: ctx.tick,
      sourceEventId: scoreEvent.eventId,
    });
    this.db.prepare(`
      INSERT INTO loan_applications(
        run_id, id, applicant_kind, applicant_id, bank_id, purpose,
        amount_cents, term_months, status, submitted_tick, decided_tick,
        source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      application.runId,
      application.id,
      application.applicantKind,
      application.applicantId,
      application.bankId,
      application.purpose,
      application.amountCents,
      application.termMonths,
      application.status,
      application.submittedTick,
      application.decidedTick,
      application.sourceEventId,
    );
    this.db.prepare(`
      INSERT INTO credit_score_assessments(
        run_id, id, application_id, model_version, inputs_canonical,
        system_score, breakdown_canonical, computed_tick, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessment.runId,
      assessment.id,
      assessment.applicationId,
      assessment.modelVersion,
      canonicalStringify(assessment.inputs),
      assessment.systemScore,
      canonicalStringify(assessment.breakdown),
      assessment.computedTick,
      assessment.sourceEventId,
    );
    return Object.freeze({ application, assessment });
  }

  getApplication(applicationId: string): LoanApplication {
    const row = this.db.prepare<[string, string], LoanApplicationRow>(`
      SELECT id, applicant_kind, applicant_id, bank_id, purpose, amount_cents,
        term_months, status, submitted_tick, decided_tick, source_event_id
      FROM loan_applications WHERE run_id = ? AND id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `loan application ${applicationId} does not exist`);
    }
    return mapApplication(this.runId, row);
  }

  listApplications(): readonly LoanApplication[] {
    return Object.freeze(this.db.prepare<[string], LoanApplicationRow>(`
      SELECT id, applicant_kind, applicant_id, bank_id, purpose, amount_cents,
        term_months, status, submitted_tick, decided_tick, source_event_id
      FROM loan_applications WHERE run_id = ? ORDER BY submitted_tick, id
    `).all(this.runId).map((row) => mapApplication(this.runId, row)));
  }

  getAssessmentForApplication(applicationId: string): CreditScoreAssessment {
    const row = this.db.prepare<[string, string], CreditScoreAssessmentRow>(`
      SELECT id, application_id, model_version, inputs_canonical, system_score,
        breakdown_canonical, computed_tick, source_event_id
      FROM credit_score_assessments WHERE run_id = ? AND application_id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `credit score for ${applicationId} does not exist`);
    }
    return mapAssessment(this.runId, row);
  }

  beginReview(
    applicationId: string,
    ctx: TickContext,
    requestedOfficerAgentId?: string,
    reviewTier: LoanApplicationReview["reviewTier"] = "tier1",
  ): { readonly application: LoanApplication; readonly review: LoanApplicationReview } {
    this.assertContext(ctx);
    return this.inTransaction(() => {
      const application = this.getApplication(applicationId);
      transitionLoanApplicationStatus(application.status, "under_review");
      if (ctx.tick < application.submittedTick) {
        throw new EngineError("VALIDATION_FAILED", "loan review cannot precede submission");
      }
      const officerAgentId = this.selectOfficer(application.bankId, requestedOfficerAgentId);
      const reviewId = ctx.ids.next("loanrev");
      const correlationId = `loan-application:${application.id}`;
      const event = ctx.emit("loan.application.review_started", {
        reviewId,
        applicationId: application.id,
        assessmentId: this.getAssessmentForApplication(application.id).id,
        bankId: application.bankId,
        officerAgentId,
        reviewTier,
      }, {
        actor: { kind: "agent", id: officerAgentId },
        correlationId,
        causationId: application.sourceEventId,
      });
      const review = loanApplicationReviewSchema.parse({
        id: reviewId,
        runId: this.runId,
        applicationId: application.id,
        officerAgentId,
        reviewTier,
        startedTick: ctx.tick,
        sourceEventId: event.eventId,
      });
      this.db.prepare(`
        INSERT INTO loan_application_reviews(
          run_id, id, application_id, officer_agent_id, review_tier,
          started_tick, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.runId,
        review.id,
        review.applicationId,
        review.officerAgentId,
        review.reviewTier,
        review.startedTick,
        review.sourceEventId,
      );
      this.db.prepare(`
        UPDATE loan_applications SET status = 'under_review'
        WHERE run_id = ? AND id = ? AND status = 'submitted'
      `).run(this.runId, application.id);
      return Object.freeze({ application: this.getApplication(application.id), review });
    });
  }

  decideTier1Application(
    applicationId: string,
    ctx: TickContext,
  ): {
    readonly application: LoanApplication;
    readonly assessment: CreditScoreAssessment;
    readonly review: LoanApplicationReview;
    readonly decision: LoanApplicationDecision;
  } {
    return this.decideApplication(applicationId, ctx);
  }

  decideTier2Application(
    applicationId: string,
    input: {
      readonly officerAdjustment: number;
      readonly rationale: string;
      readonly agentDecisionId: string;
    },
    ctx: TickContext,
  ): {
    readonly application: LoanApplication;
    readonly assessment: CreditScoreAssessment;
    readonly review: LoanApplicationReview;
    readonly decision: LoanApplicationDecision;
  } {
    return this.decideApplication(applicationId, ctx, input);
  }

  private decideApplication(
    applicationId: string,
    ctx: TickContext,
    tier2?: {
      readonly officerAdjustment: number;
      readonly rationale: string;
      readonly agentDecisionId: string;
    },
  ): {
    readonly application: LoanApplication;
    readonly assessment: CreditScoreAssessment;
    readonly review: LoanApplicationReview;
    readonly decision: LoanApplicationDecision;
  } {
    this.assertContext(ctx);
    return this.inTransaction(() => {
      const application = this.getApplication(applicationId);
      if (application.status !== "under_review") {
        throw new EngineError(
          "CONFLICT",
          `loan application ${application.id} is ${application.status}, not under_review`,
        );
      }
      const review = this.getReviewForApplication(application.id);
      const expectedTier = tier2 === undefined ? "tier1" : "tier2";
      if (review.reviewTier !== expectedTier) {
        throw new EngineError(
          "CONFLICT",
          `loan review ${review.id} is not a ${expectedTier === "tier1" ? "Tier-1" : "Tier-2"} review`,
        );
      }
      if (ctx.tick < review.startedTick) {
        throw new EngineError("VALIDATION_FAILED", "loan decision cannot precede review");
      }
      if (tier2 !== undefined) {
        const agentDecisionId = decisionIdSchema.parse(tier2.agentDecisionId);
        if (!Number.isSafeInteger(tier2.officerAdjustment) ||
          tier2.officerAdjustment < -5 || tier2.officerAdjustment > 5) {
          throw new EngineError(
            "VALIDATION_FAILED",
            "Tier-2 loan officer adjustment must be an integer from -5 through +5",
          );
        }
        const rationale = tier2.rationale.trim();
        if (rationale.length < 1 || rationale.length > 1_000) {
          throw new EngineError(
            "VALIDATION_FAILED",
            "Tier-2 loan officer rationale must contain 1 to 1000 characters",
          );
        }
        const agentDecision = this.db.prepare<[string, string], {
          agent_id: string;
          tick: bigint;
          tier: bigint;
        }>(`
          SELECT agent_id, tick, tier FROM decisions WHERE run_id = ? AND id = ?
        `).get(this.runId, agentDecisionId);
        if (agentDecision === undefined) {
          throw new EngineError("NOT_FOUND", `agent decision ${agentDecisionId} does not exist`);
        }
        if (
          agentDecision.agent_id !== review.officerAgentId ||
          toSafeNumber(agentDecision.tick, "loan agent decision tick") !== ctx.tick ||
          (agentDecision.tier !== 1n && agentDecision.tier !== 2n)
        ) {
          throw new EngineError(
            "PERMISSION_DENIED",
            "loan review requires the current officer's bounded Tier-1 or Tier-2 decision",
          );
        }
      }
      const assessment = this.getAssessmentForApplication(application.id);
      const bank = this.bankPolicy(application.bankId);
      const circuit = new SqliteBankCircuitStore(this.db, this.runId).assessApplication(
        application,
        {
          stage: "approval",
          decisionId: null,
          causationId: review.sourceEventId,
          evidenceRefs: [
            application.sourceEventId,
            assessment.id,
            assessment.sourceEventId,
            review.sourceEventId,
            bank.id,
          ],
        },
        ctx,
      );
      const evaluation = evaluateLoanPolicy({
        systemScore: assessment.systemScore,
        officerAdjustment: tier2?.officerAdjustment ?? 0,
        debtToIncomeBp: assessment.inputs.debtToIncomeBp,
        termMonths: application.termMonths,
        existingDebtCents: circuit.assessment.borrowerExposureCents,
        requestedAmountCents: application.amountCents,
        bankStatus: circuit.assessment.bankStatusAfter,
        bankCapitalCents: circuit.assessment.effectiveCapitalCents,
        bankDepositCents: circuit.assessment.projectedDepositCents,
        bankMinimumCapitalRatioBp: circuit.assessment.capitalRatioMinBp,
        bankExposureCapCents: circuit.assessment.borrowerExposureCapCents,
        bankBaseLendingRateBp: toSafeNumber(
          bank.base_lending_rate_bp,
          "bank base lending rate",
        ),
        assessmentEvidenceRefs: [assessment.id, assessment.sourceEventId],
        debtEvidenceRefs: assessment.inputs.debtEvidenceRefs,
        bankEvidenceRefs: [
          bank.id,
          circuit.assessment.id,
          circuit.assessment.sourceEventId,
        ],
      });
      const outcome = evaluation.approved ? "approved" as const : "rejected" as const;
      transitionLoanApplicationStatus(application.status, outcome);
      const decisionId = ctx.ids.next("loandec");
      const rationale = tier2?.rationale ?? tier1LoanReviewRationale(evaluation);
      const failedChecks = evaluation.policyChecks
        .filter((check) => !check.passed)
        .map((check) => check.id);
      const event = ctx.emit(`loan.${outcome}`, {
        decisionId,
        applicationId: application.id,
        assessmentId: assessment.id,
        reviewId: review.id,
        applicantKind: application.applicantKind,
        applicantId: application.applicantId,
        bankId: application.bankId,
        amountCents: application.amountCents,
        termMonths: application.termMonths,
        scoreInputs: assessment.inputs,
        scoreBreakdown: assessment.breakdown,
        systemScore: assessment.systemScore,
        officerAgentId: review.officerAgentId,
        officerAdjustment: tier2?.officerAdjustment ?? 0,
        finalScore: evaluation.finalScore,
        officerRationale: rationale,
        policyVersion: LOAN_POLICY_VERSION,
        policyChecks: evaluation.policyChecks,
        failedChecks,
        offeredRateBp: evaluation.offeredRateBp,
        circuitBreakerAssessment: circuit.assessment,
        agentDecisionId: tier2?.agentDecisionId ?? null,
      }, {
        actor: { kind: "agent", id: review.officerAgentId },
        correlationId: tier2?.agentDecisionId ?? `loan-application:${application.id}`,
        causationId: circuit.terminalEventId,
      });
      const decision = loanApplicationDecisionSchema.parse({
        id: decisionId,
        runId: this.runId,
        applicationId: application.id,
        assessmentId: assessment.id,
        reviewId: review.id,
        officerAgentId: review.officerAgentId,
        reviewTier: review.reviewTier,
        agentDecisionId: tier2?.agentDecisionId ?? null,
        policyVersion: LOAN_POLICY_VERSION,
        systemScore: assessment.systemScore,
        officerAdjustment: tier2?.officerAdjustment ?? 0,
        finalScore: evaluation.finalScore,
        rationale,
        policyChecks: evaluation.policyChecks,
        outcome,
        offeredRateBp: evaluation.offeredRateBp,
        decidedTick: ctx.tick,
        sourceEventId: event.eventId,
      });
      this.db.prepare(`
        INSERT INTO loan_application_decisions(
          run_id, id, application_id, assessment_id, review_id,
          officer_agent_id, review_tier, policy_version, system_score,
          agent_decision_id, officer_adjustment, final_score, rationale, policy_checks_canonical,
          outcome, offered_rate_bp, decided_tick, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.runId,
        decision.id,
        decision.applicationId,
        decision.assessmentId,
        decision.reviewId,
        decision.officerAgentId,
        decision.reviewTier,
        decision.policyVersion,
        decision.systemScore,
        decision.agentDecisionId,
        decision.officerAdjustment,
        decision.finalScore,
        decision.rationale,
        canonicalStringify(decision.policyChecks),
        decision.outcome,
        decision.offeredRateBp,
        decision.decidedTick,
        decision.sourceEventId,
      );
      this.db.prepare(`
        UPDATE loan_applications SET status = ?, decided_tick = ?
        WHERE run_id = ? AND id = ? AND status = 'under_review'
      `).run(outcome, ctx.tick, this.runId, application.id);
      return Object.freeze({
        application: this.getApplication(application.id),
        assessment,
        review,
        decision,
      });
    });
  }

  getReviewForApplication(applicationId: string): LoanApplicationReview {
    const row = this.db.prepare<[string, string], LoanApplicationReviewRow>(`
      SELECT id, application_id, officer_agent_id, review_tier,
        started_tick, source_event_id
      FROM loan_application_reviews WHERE run_id = ? AND application_id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `loan review for ${applicationId} does not exist`);
    }
    return mapReview(this.runId, row);
  }

  getDecisionForApplication(applicationId: string): LoanApplicationDecision {
    const row = this.db.prepare<[string, string], LoanApplicationDecisionRow>(`
      SELECT id, application_id, assessment_id, review_id, officer_agent_id,
        review_tier, agent_decision_id, policy_version, system_score, officer_adjustment, final_score,
        rationale, policy_checks_canonical, outcome, offered_rate_bp, decided_tick,
        source_event_id
      FROM loan_application_decisions WHERE run_id = ? AND application_id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `loan decision for ${applicationId} does not exist`);
    }
    return mapDecision(this.runId, row);
  }

  getLoan(loanId: string): Loan {
    const row = this.db.prepare<[string, string], LoanRow>(`
      SELECT id, application_id, decision_id, borrower_kind, borrower_id,
        bank_id, principal_cents, annual_rate_bp, term_months, disbursed_tick,
        maturity_tick, outstanding_principal_cents, consecutive_misses, status,
        bank_asset_account_id, borrower_deposit_account_id,
        disbursement_transaction_id, schedule_digest, source_event_id
      FROM loans WHERE run_id = ? AND id = ?
    `).get(this.runId, loanId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `loan ${loanId} does not exist`);
    }
    return mapLoan(this.runId, row);
  }

  getLoanForApplication(applicationId: string): Loan {
    const row = this.db.prepare<[string, string], LoanRow>(`
      SELECT id, application_id, decision_id, borrower_kind, borrower_id,
        bank_id, principal_cents, annual_rate_bp, term_months, disbursed_tick,
        maturity_tick, outstanding_principal_cents, consecutive_misses, status,
        bank_asset_account_id, borrower_deposit_account_id,
        disbursement_transaction_id, schedule_digest, source_event_id
      FROM loans WHERE run_id = ? AND application_id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `loan for application ${applicationId} does not exist`);
    }
    return mapLoan(this.runId, row);
  }

  listLoanInstallments(loanId: string): readonly LoanInstallment[] {
    this.getLoan(loanId);
    return Object.freeze(this.db.prepare<[string, string], LoanInstallmentRow>(`
      SELECT id, loan_id, installment_number, due_tick, opening_principal_cents,
        principal_due_cents, interest_due_cents, total_due_cents, status,
        paid_tick, transaction_id, source_event_id
      FROM loan_installments
      WHERE run_id = ? AND loan_id = ? ORDER BY installment_number
    `).all(this.runId, loanId).map((row) => mapLoanInstallment(this.runId, row)));
  }

  disburseApprovedApplication(
    applicationId: string,
    ctx: TickContext,
  ): LoanDisbursementResult {
    const attempt = this.tryDisburseApprovedApplication(applicationId, ctx);
    if (attempt.kind === "blocked") {
      throw new EngineError(
        "CONFLICT",
        `loan disbursement blocked by ${attempt.assessment.failedBreakers.join(", ")}`,
        {
          assessmentId: attempt.assessment.id,
          sourceEventId: attempt.sourceEventId,
        },
      );
    }
    return Object.freeze({
      loan: attempt.loan,
      installments: attempt.installments,
      transaction: attempt.transaction,
    });
  }

  tryDisburseApprovedApplication(
    applicationId: string,
    ctx: TickContext,
  ): LoanDisbursementAttempt {
    this.assertContext(ctx);
    return this.inTransaction(() => {
      const application = this.getApplication(applicationId);
      if (application.status !== "approved") {
        throw new EngineError(
          "CONFLICT",
          `loan application ${application.id} is ${application.status}, not approved`,
        );
      }
      const existing = this.db.prepare<[string, string], { id: string }>(`
        SELECT id FROM loans WHERE run_id = ? AND application_id = ?
      `).get(this.runId, application.id);
      if (existing !== undefined) {
        throw new EngineError(
          "CONFLICT",
          `loan application ${application.id} was already disbursed as ${existing.id}`,
        );
      }
      const decision = this.getDecisionForApplication(application.id);
      if (decision.outcome !== "approved" || decision.offeredRateBp === null) {
        throw new EngineError("CONFLICT", `loan decision ${decision.id} is not approved`);
      }
      if (ctx.tick < decision.decidedTick) {
        throw new EngineError("VALIDATION_FAILED", "loan disbursement cannot precede approval");
      }
      if (application.applicantKind === "company") {
        const company = this.db.prepare<[string, string], { status: string }>(`
          SELECT status FROM companies WHERE run_id = ? AND id = ?
        `).get(this.runId, application.applicantId);
        if (company?.status !== "active") {
          throw new EngineError(
            "CONFLICT",
            `company ${application.applicantId} is not active for disbursement`,
          );
        }
      }
      const borrowerAccount = this.db.prepare<[
        string,
        string,
        CreditApplicantKind,
        string,
      ], { id: string }>(`
        SELECT id FROM bank_accounts
        WHERE run_id = ? AND bank_id = ? AND owner_kind = ? AND owner_id = ?
          AND account_type = 'checking' AND status = 'active'
        ORDER BY id LIMIT 1
      `).get(
        this.runId,
        application.bankId,
        application.applicantKind,
        application.applicantId,
      );
      if (borrowerAccount === undefined) {
        throw new EngineError(
          "CONFLICT",
          `${application.applicantKind} ${application.applicantId} has no active deposit account`,
        );
      }
      const loanSourceAccount = this.db.prepare<[string, string, string], { id: string }>(`
        SELECT id FROM bank_accounts
        WHERE run_id = ? AND bank_id = ? AND owner_kind = 'bank_internal'
          AND owner_id = ? AND account_type = 'internal_liability' AND status = 'active'
        ORDER BY id LIMIT 1
      `).get(this.runId, application.bankId, `${application.bankId}:loan_source`);
      if (loanSourceAccount === undefined) {
        throw new EngineError("INTERNAL", `bank ${application.bankId} has no loan source account`);
      }

      const circuit = new SqliteBankCircuitStore(this.db, this.runId).assessApplication(
        application,
        {
          stage: "disbursement",
          decisionId: decision.id,
          causationId: decision.sourceEventId,
          evidenceRefs: [
            application.sourceEventId,
            decision.id,
            decision.sourceEventId,
          ],
        },
        ctx,
      );
      if (!circuit.assessment.allowed) {
        const blocked = ctx.emit("loan.disbursement.blocked", {
          applicationId: application.id,
          decisionId: decision.id,
          bankId: application.bankId,
          borrowerKind: application.applicantKind,
          borrowerId: application.applicantId,
          requestedAmountCents: application.amountCents,
          assessmentId: circuit.assessment.id,
          failedBreakers: circuit.assessment.failedBreakers,
          evidence: [
            application.sourceEventId,
            decision.sourceEventId,
            circuit.assessment.sourceEventId,
            circuit.terminalEventId,
          ],
        }, {
          actor: { kind: "institution", id: application.bankId },
          correlationId: `loan-application:${application.id}`,
          causationId: circuit.terminalEventId,
        });
        return Object.freeze({
          kind: "blocked" as const,
          assessment: circuit.assessment,
          sourceEventId: blocked.eventId,
        });
      }

      const loanId = ctx.ids.next("loan");
      const assetAccountId = ctx.ids.next("acct");
      const transactionId = ctx.ids.next("txn");
      const schedule = generateAmortizationSchedule({
        principalCents: application.amountCents,
        annualRateBp: decision.offeredRateBp,
        termMonths: application.termMonths,
        disbursedTick: ctx.tick,
      });
      const scheduleDigest = amortizationScheduleDigest(schedule);
      const installmentIds = schedule.map(() => ctx.ids.next("pay"));
      const correlationId = `loan-application:${application.id}`;
      const loanEvent = ctx.emit("loan.disbursed", {
        loanId,
        applicationId: application.id,
        decisionId: decision.id,
        borrowerKind: application.applicantKind,
        borrowerId: application.applicantId,
        bankId: application.bankId,
        principalCents: application.amountCents,
        annualRateBp: decision.offeredRateBp,
        termMonths: application.termMonths,
        disbursedTick: ctx.tick,
        maturityTick: ctx.tick + application.termMonths * 30,
        bankAssetAccountId: assetAccountId,
        borrowerDepositAccountId: borrowerAccount.id,
        disbursementTransactionId: transactionId,
        scheduleDigest,
        circuitBreakerAssessment: circuit.assessment,
        evidence: [
          application.sourceEventId,
          decision.sourceEventId,
          circuit.assessment.id,
          circuit.assessment.sourceEventId,
        ],
      }, {
        actor: { kind: "institution", id: application.bankId },
        correlationId,
        causationId: circuit.terminalEventId,
      });

      const finance = new SqliteFinanceStore(this.db, this.runId);
      const assetAccount = finance.openAccount({
        id: assetAccountId,
        bankId: application.bankId,
        ownerKind: "bank_internal",
        ownerId: loanId,
        type: "internal_asset",
        floorCents: "0",
        openedTick: ctx.tick,
        actor: { kind: "system", id: "credit" },
      });
      ctx.emit("account.opened", {
        accountId: assetAccount.id,
        bankId: assetAccount.bankId,
        ownerKind: assetAccount.ownerKind,
        ownerId: assetAccount.ownerId,
        type: assetAccount.type,
        balanceCents: assetAccount.balanceCents,
        floorCents: assetAccount.floorCents,
        evidence: [loanEvent.eventId, decision.sourceEventId],
      }, {
        actor: { kind: "system", id: "credit" },
        correlationId,
        causationId: loanEvent.eventId,
      });
      const scheduleEvent = ctx.emit("loan.schedule.created", {
        loanId,
        applicationId: application.id,
        decisionId: decision.id,
        scheduleDigest,
        convention: "equal_principal_30_360_half_even",
        installments: schedule.map((row, index) => ({
          id: installmentIds[index],
          ...row,
        })),
        evidence: [decision.sourceEventId, loanEvent.eventId],
      }, {
        actor: { kind: "system", id: "credit-amortization" },
        correlationId,
        causationId: loanEvent.eventId,
      });

      const doublePrincipal = (BigInt(application.amountCents) * 2n).toString();
      const transaction = ledgerTransactionSchema.parse({
        id: transactionId,
        runId: this.runId,
        tick: ctx.tick,
        kind: "loan_disbursement",
        actor: { kind: "system", id: "credit" },
        reason: "loan.disbursement",
        sourceEventId: loanEvent.eventId,
        correlationId,
        idempotencyKey: `loan-disbursement:${loanId}`,
        legs: [
          {
            accountId: assetAccount.id,
            direction: "debit",
            amountCents: application.amountCents,
          },
          {
            accountId: borrowerAccount.id,
            direction: "debit",
            amountCents: application.amountCents,
          },
          {
            accountId: loanSourceAccount.id,
            direction: "credit",
            amountCents: doublePrincipal,
          },
        ],
      });
      const posted = finance.post(transaction);
      if (posted.duplicate) {
        throw new EngineError("CONFLICT", `loan ${loanId} disbursement was a duplicate`);
      }
      ctx.count("transactions");
      ctx.emit("transaction.posted", {
        transactionId: transaction.id,
        kind: transaction.kind,
        legs: transaction.legs,
        reason: transaction.reason,
        sourceEventId: transaction.sourceEventId,
        correlationId: transaction.correlationId,
        evidence: [loanEvent.eventId, decision.sourceEventId],
      }, {
        actor: { kind: "system", id: "credit" },
        correlationId,
        causationId: loanEvent.eventId,
      });

      const loan = loanSchema.parse({
        id: loanId,
        runId: this.runId,
        applicationId: application.id,
        decisionId: decision.id,
        borrowerKind: application.applicantKind,
        borrowerId: application.applicantId,
        bankId: application.bankId,
        principalCents: application.amountCents,
        annualRateBp: decision.offeredRateBp,
        termMonths: application.termMonths,
        disbursedTick: ctx.tick,
        maturityTick: ctx.tick + application.termMonths * 30,
        outstandingPrincipalCents: application.amountCents,
        consecutiveMisses: 0,
        status: "disbursed",
        bankAssetAccountId: assetAccount.id,
        borrowerDepositAccountId: borrowerAccount.id,
        disbursementTransactionId: transaction.id,
        scheduleDigest,
        sourceEventId: loanEvent.eventId,
      });
      this.db.prepare(`
        INSERT INTO loans(
          run_id, id, application_id, decision_id, borrower_kind, borrower_id,
          bank_id, principal_cents, annual_rate_bp, term_months, disbursed_tick,
          maturity_tick, outstanding_principal_cents, consecutive_misses, status,
          bank_asset_account_id, borrower_deposit_account_id,
          disbursement_transaction_id, schedule_digest, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        loan.runId,
        loan.id,
        loan.applicationId,
        loan.decisionId,
        loan.borrowerKind,
        loan.borrowerId,
        loan.bankId,
        loan.principalCents,
        loan.annualRateBp,
        loan.termMonths,
        loan.disbursedTick,
        loan.maturityTick,
        loan.outstandingPrincipalCents,
        loan.consecutiveMisses,
        loan.status,
        loan.bankAssetAccountId,
        loan.borrowerDepositAccountId,
        loan.disbursementTransactionId,
        loan.scheduleDigest,
        loan.sourceEventId,
      );
      const installments = Object.freeze(schedule.map((row, index) => loanInstallmentSchema.parse({
        id: installmentIds[index],
        runId: this.runId,
        loanId: loan.id,
        ...row,
        status: "due",
        paidTick: null,
        transactionId: null,
        sourceEventId: scheduleEvent.eventId,
      })));
      const insertInstallment = this.db.prepare(`
        INSERT INTO loan_installments(
          run_id, id, loan_id, installment_number, due_tick,
          opening_principal_cents, principal_due_cents, interest_due_cents,
          total_due_cents, status, paid_tick, transaction_id, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const installment of installments) {
        insertInstallment.run(
          installment.runId,
          installment.id,
          installment.loanId,
          installment.installmentNumber,
          installment.dueTick,
          installment.openingPrincipalCents,
          installment.principalDueCents,
          installment.interestDueCents,
          installment.totalDueCents,
          installment.status,
          installment.paidTick,
          installment.transactionId,
          installment.sourceEventId,
        );
      }
      return Object.freeze({
        kind: "disbursed" as const,
        loan,
        installments,
        transaction,
      });
    });
  }

  private buildScoreInputs(
    application: SubmitLoanApplicationInput,
    tick: number,
  ): CreditScoreInputs {
    const income = application.applicantKind === "agent"
      ? this.agentIncome(application.applicantId, tick)
      : this.companyIncome(application.applicantId, tick);
    const history = this.debtHistory(application.applicantKind, application.applicantId);
    const proposedAnnualPrincipal = principalDueWithinYear(
      application.amountCents,
      application.termMonths,
    );
    const annualDebtServiceCents = (history.annualDebtServiceCents + proposedAnnualPrincipal)
      .toString();
    return creditScoreInputsSchema.parse({
      modelVersion: CREDIT_SCORE_MODEL_VERSION,
      annualIncomeCents: income.annualIncomeCents.toString(),
      annualDebtServiceCents,
      existingDebtCents: history.existingDebtCents.toString(),
      requestedAmountCents: application.amountCents,
      termMonths: application.termMonths,
      incomeStabilityBp: income.stabilityBp,
      debtToIncomeBp: debtToIncomeBasisPoints(
        annualDebtServiceCents,
        income.annualIncomeCents.toString(),
      ),
      historyScoreBp: creditHistoryScoreBasisPoints(history),
      completedPayments: history.completedPayments,
      missedPayments: history.missedPayments,
      defaults: history.defaults,
      noHistory: history.completedPayments + history.missedPayments + history.defaults === 0,
      incomeEvidenceRefs: income.evidenceRefs,
      debtEvidenceRefs: history.evidenceRefs,
    });
  }

  private agentIncome(agentId: string, tick: number): {
    readonly annualIncomeCents: bigint;
    readonly stabilityBp: number;
    readonly evidenceRefs: readonly string[];
  } {
    const agent = this.db.prepare<[string, string], {
      annual_income_cents: string;
    }>(`
      SELECT annual_income_cents FROM agents WHERE run_id = ? AND id = ?
    `).get(this.runId, agentId);
    if (agent === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
    const annualIncomeCents = BigInt(agent.annual_income_cents);
    const employment = this.db.prepare<[string, string], {
      id: string;
      start_tick: bigint;
    }>(`
      SELECT id, start_tick FROM employment_contracts
      WHERE run_id = ? AND employee_agent_id = ? AND status = 'active'
      ORDER BY start_tick DESC, id DESC LIMIT 1
    `).get(this.runId, agentId);
    if (employment === undefined) {
      return {
        annualIncomeCents,
        stabilityBp: annualIncomeCents === 0n ? 0 : 3_000,
        evidenceRefs: [],
      };
    }
    const startTick = toSafeNumber(employment.start_tick, "employment start tick");
    const fromTick = Math.max(1, startTick, tick - 89);
    const account = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'agent' AND owner_id = ? AND status = 'open'
      ORDER BY id LIMIT 1
    `).get(this.runId, agentId);
    const payrolls = account === undefined ? [] : this.db.prepare<[
      string,
      string,
      number,
      number,
    ], { id: string }>(`
      SELECT DISTINCT t.id
      FROM ledger_transactions t
      JOIN ledger_transaction_legs l
        ON l.run_id = t.run_id AND l.transaction_id = t.id
      WHERE t.run_id = ? AND l.account_id = ? AND t.kind = 'payroll'
        AND t.tick BETWEEN ? AND ?
      ORDER BY t.id
    `).all(this.runId, account.id, fromTick, tick);
    const expectedPeriods = tick < fromTick
      ? 0
      : Math.floor(tick / 15) - Math.floor((fromTick - 1) / 15);
    const reliabilityBp = expectedPeriods === 0
      ? 10_000
      : Math.min(10_000, Math.floor(payrolls.length * 10_000 / expectedPeriods));
    const tenureTicks = Math.max(0, tick - startTick + 1);
    const maturityBp = Math.min(10_000, 7_000 + Math.min(30, tenureTicks) * 100);
    return {
      annualIncomeCents,
      stabilityBp: Math.min(maturityBp, reliabilityBp),
      evidenceRefs: Object.freeze([employment.id, ...payrolls.map((row) => row.id)]),
    };
  }

  private companyIncome(companyId: string, tick: number): {
    readonly annualIncomeCents: bigint;
    readonly stabilityBp: number;
    readonly evidenceRefs: readonly string[];
  } {
    const company = this.db.prepare<[string, string], {
      status: string;
      business_account_id: string | null;
    }>(`
      SELECT status, business_account_id FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, companyId);
    if (company === undefined) {
      throw new EngineError("NOT_FOUND", `company ${companyId} does not exist`);
    }
    if (company.status !== "active" || company.business_account_id === null) {
      throw new EngineError("CONFLICT", `company ${companyId} is not active for credit`);
    }
    const fromTick = Math.max(0, tick - 89);
    const revenue = this.db.prepare<[string, string, number, number], {
      id: string;
      tick: bigint;
      amount_cents: string;
    }>(`
      SELECT t.id, t.tick, l.amount_cents
      FROM ledger_transaction_legs l
      JOIN ledger_transactions t ON t.run_id = l.run_id AND t.id = l.transaction_id
      WHERE l.run_id = ? AND l.account_id = ? AND t.tick BETWEEN ? AND ?
        AND l.direction = 'debit' AND t.kind IN ('purchase', 'row_settlement')
      ORDER BY t.tick, t.id, l.leg_index
    `).all(this.runId, company.business_account_id, fromTick, tick);
    const observedTicks = Math.max(1, tick - fromTick + 1);
    const revenueTotal = revenue.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    const annualIncomeCents = revenueTotal * 360n / BigInt(observedTicks);
    const revenueTicks = new Set(revenue.map((row) => row.tick.toString())).size;
    const frequencyBp = Math.floor(revenueTicks * 10_000 / observedTicks);
    const maturityBp = Math.floor(Math.min(observedTicks, 30) * 10_000 / 30);
    const evidenceRefs = [...new Set(revenue.map((row) => row.id))].slice(-200);
    return {
      annualIncomeCents,
      stabilityBp: Math.min(frequencyBp, maturityBp),
      evidenceRefs: Object.freeze(evidenceRefs),
    };
  }

  private debtHistory(applicantKind: CreditApplicantKind, applicantId: string): {
    readonly annualDebtServiceCents: bigint;
    readonly existingDebtCents: bigint;
    readonly completedPayments: number;
    readonly missedPayments: number;
    readonly defaults: number;
    readonly evidenceRefs: readonly string[];
  } {
    const seedKind = applicantKind === "agent" ? "agent" : "business";
    const rows = this.db.prepare<[string, string, string], SeedLoanRow>(`
      SELECT id, outstanding_principal_cents, loan_canonical FROM seed_loans
      WHERE run_id = ? AND borrower_kind = ? AND borrower_id = ? ORDER BY id
    `).all(this.runId, seedKind, applicantId);
    let annualDebtServiceCents = 0n;
    let existingDebtCents = 0n;
    let completedPayments = 0;
    let missedPayments = 0;
    let defaults = 0;
    for (const row of rows) {
      existingDebtCents += BigInt(row.outstanding_principal_cents);
      const installments = parseInstallments(row.loan_canonical, row.id);
      completedPayments += installments.filter((entry) => entry.status === "paid").length;
      missedPayments += installments.filter((entry) => entry.status === "missed").length;
      const due = installments.filter((entry) => entry.status !== "paid").slice(0, 12);
      annualDebtServiceCents += due.reduce((sum, entry) => (
        sum + BigInt(entry.principalCents) + BigInt(entry.interestCents)
      ), 0n);
    }
    const liveLoans = this.db.prepare<[string, CreditApplicantKind, string], {
      id: string;
      outstanding_principal_cents: string;
      status: Loan["status"];
    }>(`
      SELECT id, outstanding_principal_cents, status FROM loans
      WHERE run_id = ? AND borrower_kind = ? AND borrower_id = ?
      ORDER BY id
    `).all(this.runId, applicantKind, applicantId);
    for (const loan of liveLoans) {
      existingDebtCents += BigInt(loan.outstanding_principal_cents);
      if (loan.status === "defaulted" || loan.status === "written_off") defaults += 1;
      const installments = this.db.prepare<[string, string], {
        principal_due_cents: string;
        interest_due_cents: string;
        status: LoanInstallment["status"];
      }>(`
        SELECT principal_due_cents, interest_due_cents, status
        FROM loan_installments WHERE run_id = ? AND loan_id = ?
        ORDER BY installment_number
      `).all(this.runId, loan.id);
      completedPayments += installments.filter((entry) => entry.status === "completed").length;
      missedPayments += installments.filter((entry) => entry.status === "missed").length;
      annualDebtServiceCents += installments
        .filter((entry) => entry.status !== "completed")
        .slice(0, 12)
        .reduce((sum, entry) => (
          sum + BigInt(entry.principal_due_cents) + BigInt(entry.interest_due_cents)
        ), 0n);
    }
    return {
      annualDebtServiceCents,
      existingDebtCents,
      completedPayments,
      missedPayments,
      defaults,
      evidenceRefs: Object.freeze([
        ...rows.map((row) => row.id),
        ...liveLoans.map((row) => row.id),
      ].slice(0, 200)),
    };
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "credit context belongs to another run");
    }
  }

  private selectOfficer(bankId: string, requestedOfficerAgentId?: string): string {
    this.bankPolicy(bankId);
    const baseSql = `
      SELECT a.id, COUNT(r.id) AS review_count
      FROM agents a
      LEFT JOIN loan_application_reviews r
        ON r.run_id = a.run_id AND r.officer_agent_id = a.id
      WHERE a.run_id = ? AND a.organization_id = 'inst_first_ledger_bank'
        AND a.role_code = 'bank.loan_officer' AND a.employment_status = 'employed'
    `;
    if (requestedOfficerAgentId !== undefined) {
      const officer = this.db.prepare<[string, string], { id: string }>(`
        ${baseSql} AND a.id = ? GROUP BY a.id
      `).get(this.runId, requestedOfficerAgentId);
      if (officer === undefined) {
        throw new EngineError(
          "PERMISSION_DENIED",
          `agent ${requestedOfficerAgentId} is not an active loan officer at ${bankId}`,
        );
      }
      return officer.id;
    }
    const officer = this.db.prepare<[string], { id: string; review_count: bigint }>(`
      ${baseSql}
      GROUP BY a.id ORDER BY review_count, a.id LIMIT 1
    `).get(this.runId);
    if (officer === undefined) {
      throw new EngineError("CONFLICT", `bank ${bankId} has no active loan officer`);
    }
    return officer.id;
  }

  private bankPolicy(bankId: string): BankPolicyRow {
    const bank = this.db.prepare<[string, string], BankPolicyRow>(`
      SELECT id, base_lending_rate_bp
      FROM banks WHERE run_id = ? AND id = ?
    `).get(this.runId, bankId);
    if (bank === undefined) throw new EngineError("NOT_FOUND", `bank ${bankId} does not exist`);
    return bank;
  }

  private inTransaction<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }
}
