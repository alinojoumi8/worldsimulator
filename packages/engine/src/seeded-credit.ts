/** Deterministic validation for the complete Riverbend opening credit state. */

import {
  EngineError,
  hashValue,
  money,
  mulDiv,
} from "@worldtangle/shared";
import type { SeedLoan } from "./world-generator";

export interface OpeningCreditLedgerAccount {
  readonly id: string;
  readonly bankId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly accountType: string;
  readonly balanceCents: string;
  readonly status: string;
}

export interface OpeningCreditLedgerTransaction {
  readonly id: string;
  readonly kind: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly reason: string;
  readonly eventId: string | null;
  readonly legs: readonly {
    readonly accountId: string;
    readonly direction: "debit" | "credit";
    readonly amountCents: string;
  }[];
}

export interface OpeningCreditLedgerLink {
  readonly loanId: string;
  readonly bankAssetAccountId: string;
  readonly borrowerDepositAccountId: string;
  readonly recognitionTransactionId: string;
}

export interface OpeningCreditSeedEvent {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly actorKind: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly loanId: string;
  readonly borrowerKind: string;
  readonly borrowerId: string;
  readonly purpose: string;
  readonly originalPrincipalCents: string;
  readonly outstandingPrincipalCents: string;
  readonly annualRateBp: number;
  readonly termMonths: number;
  readonly seasonedMonths: number;
  readonly status: string;
  readonly missedPayments: number;
  readonly scheduleDigest: string;
  readonly bankId: string;
  readonly bankAssetAccountId: string;
  readonly borrowerDepositAccountId: string;
  readonly recognitionTransactionId: string;
  readonly evidence: readonly string[];
}

export interface OpeningCreditState {
  readonly loans: readonly SeedLoan[];
  readonly accounts: readonly OpeningCreditLedgerAccount[];
  readonly transactions: readonly OpeningCreditLedgerTransaction[];
  readonly links: readonly OpeningCreditLedgerLink[];
  readonly seedEvents: readonly OpeningCreditSeedEvent[];
}

export interface OpeningCreditAuditViolation {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OpeningCreditAuditSummary {
  readonly totalLoans: number;
  readonly businessLoans: number;
  readonly personalLoans: number;
  readonly currentPersonalLoans: number;
  readonly delinquentPersonalLoans: number;
  readonly ironvaleLoanId: string | null;
  readonly delinquentPersonalLoanId: string | null;
  readonly totalOutstandingPrincipalCents: string;
}

export interface OpeningCreditAuditReport {
  readonly passed: boolean;
  readonly violations: readonly OpeningCreditAuditViolation[];
  readonly summary: OpeningCreditAuditSummary;
}

export interface OpeningCreditAuditOptions {
  /** Direct store fixtures may validate INV-6 before the service appends genesis facts. */
  readonly requireSeedEvents?: boolean;
}

type MutableViolation = OpeningCreditAuditViolation;

function issue(
  violations: MutableViolation[],
  code: string,
  message: string,
  path: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  violations.push({
    code,
    message,
    path,
    ...(details === undefined ? {} : { details }),
  });
}

function parseCents(
  value: string,
  path: string,
  violations: MutableViolation[],
  positive = false,
): bigint | undefined {
  if (!/^\d+$/.test(value)) {
    issue(violations, "invalid_cents", "value must be nonnegative integer cents", path);
    return undefined;
  }
  const parsed = BigInt(value);
  if (positive && parsed === 0n) {
    issue(violations, "nonpositive_cents", "value must be positive integer cents", path);
    return undefined;
  }
  return parsed;
}

function countBy<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((count, value) => count + (predicate(value) ? 1 : 0), 0);
}

function validateLoanHistory(
  loan: SeedLoan,
  violations: MutableViolation[],
): void {
  const path = `loans.${loan.id}`;
  const original = parseCents(
    loan.originalPrincipalCents,
    `${path}.originalPrincipalCents`,
    violations,
    true,
  );
  const declaredOutstanding = parseCents(
    loan.outstandingPrincipalCents,
    `${path}.outstandingPrincipalCents`,
    violations,
  );
  if (!Number.isSafeInteger(loan.termMonths) || loan.termMonths < 1 || loan.termMonths > 360) {
    issue(violations, "invalid_term", "loan term must be 1 to 360 months", `${path}.termMonths`);
  }
  if (
    !Number.isSafeInteger(loan.seasonedMonths) ||
    loan.seasonedMonths < 1 ||
    loan.seasonedMonths >= loan.termMonths
  ) {
    issue(
      violations,
      "invalid_seasoning",
      "opening loan must have at least one completed period and remaining term",
      `${path}.seasonedMonths`,
    );
  }
  if (!Number.isSafeInteger(loan.annualRateBp) || loan.annualRateBp < 0) {
    issue(violations, "invalid_rate", "annual rate must be nonnegative basis points", `${path}.annualRateBp`);
  }
  if (loan.installments.length !== loan.termMonths) {
    issue(
      violations,
      "installment_count_mismatch",
      "installment count must equal the contractual term",
      `${path}.installments`,
      { expected: loan.termMonths, actual: loan.installments.length },
    );
  }

  let scheduledOutstanding = original ?? 0n;
  let principalTotal = 0n;
  let outstandingTotal = 0n;
  let missed = 0;
  let minimumPrincipal: bigint | undefined;
  let maximumPrincipal: bigint | undefined;
  for (let index = 0; index < loan.installments.length; index += 1) {
    const installment = loan.installments[index]!;
    const installmentPath = `${path}.installments.${index}`;
    const principal = parseCents(
      installment.principalCents,
      `${installmentPath}.principalCents`,
      violations,
      true,
    );
    const interest = parseCents(
      installment.interestCents,
      `${installmentPath}.interestCents`,
      violations,
    );
    if (installment.installment !== index + 1) {
      issue(
        violations,
        "installment_sequence_mismatch",
        "installment numbers must be contiguous and one-based",
        `${installmentPath}.installment`,
      );
    }
    const expectedStatus = installment.installment < loan.seasonedMonths
      ? "paid"
      : installment.installment === loan.seasonedMonths
        ? loan.status === "delinquent" ? "missed" : "paid"
        : "scheduled";
    if (installment.status !== expectedStatus) {
      issue(
        violations,
        "installment_history_mismatch",
        "installment status is inconsistent with seasoning and delinquency",
        `${installmentPath}.status`,
        { expected: expectedStatus, actual: installment.status },
      );
    }
    if (principal !== undefined) {
      principalTotal += principal;
      if (installment.status !== "paid") outstandingTotal += principal;
      minimumPrincipal = minimumPrincipal === undefined || principal < minimumPrincipal
        ? principal
        : minimumPrincipal;
      maximumPrincipal = maximumPrincipal === undefined || principal > maximumPrincipal
        ? principal
        : maximumPrincipal;
    }
    if (installment.status === "missed") missed += 1;
    if (interest !== undefined && Number.isSafeInteger(loan.annualRateBp) && loan.annualRateBp >= 0) {
      const expectedInterest = mulDiv(
        money(scheduledOutstanding),
        BigInt(loan.annualRateBp),
        120_000n,
        "HALF_EVEN",
      );
      if (interest !== expectedInterest) {
        issue(
          violations,
          "interest_history_mismatch",
          "interest must use the stored opening principal and exact 30/360 monthly rate",
          `${installmentPath}.interestCents`,
          { expected: expectedInterest.toString(), actual: interest.toString() },
        );
      }
    }
    if (principal !== undefined) scheduledOutstanding -= principal;
  }
  if (original !== undefined && principalTotal !== original) {
    issue(
      violations,
      "principal_schedule_mismatch",
      "installment principal must sum exactly to original principal",
      `${path}.installments`,
      { expected: original.toString(), actual: principalTotal.toString() },
    );
  }
  if (declaredOutstanding !== undefined && outstandingTotal !== declaredOutstanding) {
    issue(
      violations,
      "outstanding_schedule_mismatch",
      "outstanding principal must equal every non-paid principal row",
      `${path}.outstandingPrincipalCents`,
      { expected: outstandingTotal.toString(), actual: declaredOutstanding.toString() },
    );
  }
  if (
    minimumPrincipal !== undefined &&
    maximumPrincipal !== undefined &&
    maximumPrincipal - minimumPrincipal > 1n
  ) {
    issue(
      violations,
      "principal_allocation_mismatch",
      "equal-principal rows may differ by at most one cent",
      `${path}.installments`,
    );
  }
  if (loan.missedPayments !== missed) {
    issue(
      violations,
      "missed_payment_count_mismatch",
      "declared missed-payment count must match installment history",
      `${path}.missedPayments`,
      { expected: missed, actual: loan.missedPayments },
    );
  }
  if (
    (loan.status === "current" && missed !== 0) ||
    (loan.status === "delinquent" && missed !== 1)
  ) {
    issue(
      violations,
      "delinquency_status_mismatch",
      "current loans have no misses and the seeded delinquent loan has exactly one",
      `${path}.status`,
    );
  }
}

function portfolioSummary(loans: readonly SeedLoan[]): OpeningCreditAuditSummary {
  const personal = loans.filter((loan) => loan.borrowerKind === "agent");
  const business = loans.filter((loan) => loan.borrowerKind === "business");
  const ironvale = business.find((loan) => loan.borrowerId === "biz_ironvale") ?? null;
  const delinquent = personal.find((loan) => loan.status === "delinquent") ?? null;
  const totalOutstanding = loans.reduce((total, loan) => (
    /^\d+$/.test(loan.outstandingPrincipalCents)
      ? total + BigInt(loan.outstandingPrincipalCents)
      : total
  ), 0n);
  return Object.freeze({
    totalLoans: loans.length,
    businessLoans: business.length,
    personalLoans: personal.length,
    currentPersonalLoans: countBy(personal, (loan) => loan.status === "current"),
    delinquentPersonalLoans: countBy(personal, (loan) => loan.status === "delinquent"),
    ironvaleLoanId: ironvale?.id ?? null,
    delinquentPersonalLoanId: delinquent?.id ?? null,
    totalOutstandingPrincipalCents: totalOutstanding.toString(),
  });
}

function validatePortfolio(
  loans: readonly SeedLoan[],
  violations: MutableViolation[],
): OpeningCreditAuditSummary {
  const summary = portfolioSummary(loans);
  if (summary.totalLoans !== 8) {
    issue(violations, "opening_loan_count", "opening credit must contain exactly eight loans", "loans");
  }
  if (summary.businessLoans !== 1 || summary.ironvaleLoanId === null) {
    issue(
      violations,
      "ironvale_loan_count",
      "opening credit must contain exactly one Ironvale business loan",
      "loans",
    );
  }
  if (
    summary.personalLoans !== 7 ||
    summary.currentPersonalLoans !== 6 ||
    summary.delinquentPersonalLoans !== 1
  ) {
    issue(
      violations,
      "personal_loan_mix",
      "opening credit must contain six current and one delinquent personal loan",
      "loans",
      {
        personal: summary.personalLoans,
        current: summary.currentPersonalLoans,
        delinquent: summary.delinquentPersonalLoans,
      },
    );
  }
  const borrowerKeys = new Set<string>();
  for (const loan of loans) {
    validateLoanHistory(loan, violations);
    const borrowerKey = `${loan.borrowerKind}:${loan.borrowerId}`;
    if (borrowerKeys.has(borrowerKey)) {
      issue(
        violations,
        "duplicate_opening_borrower",
        "each seeded opening loan must belong to a distinct borrower",
        `loans.${loan.id}.borrowerId`,
      );
    }
    borrowerKeys.add(borrowerKey);
    if (loan.borrowerKind === "business") {
      if (
        loan.borrowerId !== "biz_ironvale" ||
        loan.purpose !== "working_capital" ||
        loan.originalPrincipalCents !== "30000000" ||
        loan.annualRateBp !== 650 ||
        loan.termMonths !== 36 ||
        loan.seasonedMonths !== 22 ||
        loan.status !== "current"
      ) {
        issue(
          violations,
          "ironvale_terms_mismatch",
          "Ironvale opening terms must match INITIAL_WORLD section 5.11",
          `loans.${loan.id}`,
        );
      }
    } else if (
      loan.termMonths !== 24 ||
      (loan.purpose !== "vehicle" && loan.purpose !== "appliance") ||
      !/^\d+$/.test(loan.originalPrincipalCents) ||
      BigInt(loan.originalPrincipalCents) < 300_000n ||
      BigInt(loan.originalPrincipalCents) > 1_200_000n
    ) {
      issue(
        violations,
        "personal_terms_out_of_bounds",
        "personal opening loans must be 24-month vehicle or appliance loans from $3k to $12k",
        `loans.${loan.id}`,
      );
    }
  }
  return summary;
}

export function auditSeededCreditPortfolio(
  loans: readonly SeedLoan[],
): OpeningCreditAuditReport {
  const violations: MutableViolation[] = [];
  const summary = validatePortfolio(loans, violations);
  return Object.freeze({
    passed: violations.length === 0,
    violations: Object.freeze(violations),
    summary,
  });
}

function uniqueById<T>(
  values: readonly T[],
  kind: string,
  violations: MutableViolation[],
  idOf: (value: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (result.has(id)) {
      issue(violations, `duplicate_${kind}`, `${kind} identifiers must be unique`, `${kind}.${id}`);
    }
    result.set(id, value);
  }
  return result;
}

export function auditOpeningCreditState(
  state: OpeningCreditState,
  options: OpeningCreditAuditOptions = {},
): OpeningCreditAuditReport {
  const requireSeedEvents = options.requireSeedEvents ?? true;
  const violations: MutableViolation[] = [];
  const summary = validatePortfolio(state.loans, violations);
  const accounts = uniqueById(state.accounts, "account", violations, (account) => account.id);
  const transactions = uniqueById(
    state.transactions,
    "transaction",
    violations,
    (transaction) => transaction.id,
  );
  const events = uniqueById(
    state.seedEvents,
    "seed_event",
    violations,
    (event) => event.eventId,
  );
  const loanIds = new Set(state.loans.map((loan) => loan.id));
  const links = new Map<string, OpeningCreditLedgerLink>();
  for (const link of state.links) {
    if (links.has(link.loanId)) {
      issue(
        violations,
        "duplicate_loan_link",
        "each opening loan must have one ledger link",
        `links.${link.loanId}`,
      );
    }
    if (!loanIds.has(link.loanId)) {
      issue(
        violations,
        "dangling_loan_link",
        "opening credit link references an unknown loan",
        `links.${link.loanId}`,
      );
    }
    links.set(link.loanId, link);
  }
  const eventsByLoan = new Map<string, OpeningCreditSeedEvent>();
  for (const event of events.values()) {
    if (eventsByLoan.has(event.loanId)) {
      issue(
        violations,
        "duplicate_seed_event_for_loan",
        "each opening loan must have one seeded event",
        `seedEvents.${event.eventId}`,
      );
    }
    if (!loanIds.has(event.loanId)) {
      issue(
        violations,
        "dangling_seed_event",
        "seeded event references an unknown opening loan",
        `seedEvents.${event.eventId}`,
      );
    }
    eventsByLoan.set(event.loanId, event);
  }

  for (const loan of state.loans) {
    const path = `loans.${loan.id}`;
    const link = links.get(loan.id);
    if (link === undefined) {
      issue(violations, "missing_loan_link", "opening loan lacks its ledger link", path);
      continue;
    }
    const asset = accounts.get(link.bankAssetAccountId);
    const borrower = accounts.get(link.borrowerDepositAccountId);
    const transaction = transactions.get(link.recognitionTransactionId);
    if (
      asset === undefined ||
      asset.ownerKind !== "bank_internal" ||
      asset.ownerId !== loan.id ||
      asset.accountType !== "internal_asset" ||
      asset.status !== "active" ||
      asset.balanceCents !== loan.outstandingPrincipalCents
    ) {
      issue(
        violations,
        "invalid_seed_asset",
        "opening loan must have a live bank asset equal to outstanding principal",
        `${path}.bankAssetAccountId`,
      );
    }
    const expectedBorrowerKind = loan.borrowerKind === "business" ? "company" : "agent";
    if (
      borrower === undefined ||
      borrower.ownerKind !== expectedBorrowerKind ||
      borrower.ownerId !== loan.borrowerId ||
      borrower.accountType !== "checking" ||
      borrower.status !== "active" ||
      (asset !== undefined && borrower.bankId !== asset.bankId)
    ) {
      issue(
        violations,
        "invalid_seed_borrower_account",
        "opening loan must link to the borrower's active checking account at the same bank",
        `${path}.borrowerDepositAccountId`,
      );
    }
    if (
      transaction === undefined ||
      transaction.kind !== "loan_disbursement" ||
      transaction.actorKind !== "system" ||
      transaction.actorId !== "finance" ||
      transaction.reason !== "world_gen.seed_loan_recognition" ||
      transaction.legs.length !== 2
    ) {
      issue(
        violations,
        "invalid_seed_recognition",
        "opening loan must have one balanced two-leg recognition transaction",
        `${path}.recognitionTransactionId`,
      );
    } else {
      const assetLegs = transaction.legs.filter((leg) => (
        leg.accountId === link.bankAssetAccountId &&
        leg.direction === "debit" &&
        leg.amountCents === loan.outstandingPrincipalCents
      ));
      const sourceLeg = transaction.legs.find((leg) => leg.direction === "credit");
      const source = sourceLeg === undefined ? undefined : accounts.get(sourceLeg.accountId);
      if (assetLegs.length !== 1 || sourceLeg === undefined ||
        sourceLeg.amountCents !== loan.outstandingPrincipalCents ||
        source === undefined || source.ownerKind !== "bank_internal" ||
        source.ownerId !== `${asset?.bankId ?? "missing"}:loan_source` ||
        source.accountType !== "internal_liability" ||
        source.bankId !== asset?.bankId) {
        issue(
          violations,
          "invalid_seed_recognition_legs",
          "recognition must debit the loan asset and credit its bank loan-source liability exactly",
          `${path}.recognitionTransactionId`,
        );
      }
    }

    const event = eventsByLoan.get(loan.id);
    if (event === undefined) {
      if (requireSeedEvents) {
        issue(violations, "missing_seed_event", "opening loan lacks a causal loan.seeded event", path);
      }
      continue;
    }
    const expectedEvidence = transaction?.eventId === null || transaction?.eventId === undefined
      ? []
      : [transaction.eventId, transaction.id];
    if (
      event.schemaVersion < 1 ||
      event.actorKind !== "system" ||
      event.actorId !== "engine" ||
      event.correlationId.length === 0 ||
      event.causationId !== transaction?.eventId ||
      event.borrowerKind !== loan.borrowerKind ||
      event.borrowerId !== loan.borrowerId ||
      event.purpose !== loan.purpose ||
      event.originalPrincipalCents !== loan.originalPrincipalCents ||
      event.outstandingPrincipalCents !== loan.outstandingPrincipalCents ||
      event.annualRateBp !== loan.annualRateBp ||
      event.termMonths !== loan.termMonths ||
      event.seasonedMonths !== loan.seasonedMonths ||
      event.status !== loan.status ||
      event.missedPayments !== loan.missedPayments ||
      event.scheduleDigest !== hashValue(loan.installments) ||
      event.bankId !== asset?.bankId ||
      event.bankAssetAccountId !== link.bankAssetAccountId ||
      event.borrowerDepositAccountId !== link.borrowerDepositAccountId ||
      event.recognitionTransactionId !== link.recognitionTransactionId ||
      !expectedEvidence.every((reference) => event.evidence.includes(reference))
    ) {
      issue(
        violations,
        "seed_event_mismatch",
        "loan.seeded event must reproduce stored terms and follow its recognition transaction",
        `seedEvents.${event.eventId}`,
      );
    }
  }

  return Object.freeze({
    passed: violations.length === 0,
    violations: Object.freeze(violations),
    summary,
  });
}

export function assertOpeningCreditState(state: OpeningCreditState): void {
  const report = auditOpeningCreditState(state);
  if (!report.passed) {
    throw new EngineError("INTERNAL", "opening credit-state audit failed", {
      violations: report.violations,
    });
  }
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("INTERNAL", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new EngineError("INTERNAL", `${path}.${key} must be a string`);
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new EngineError("INTERNAL", `${path}.${key} must be an integer`);
  return Number(value);
}

/** Strictly reconstruct a seed loan from its canonical persistence field. */
export function parseSeedLoan(value: unknown, path = "seedLoan"): SeedLoan {
  const record = objectRecord(value, path);
  const borrowerKind = requiredString(record, "borrowerKind", path);
  const purpose = requiredString(record, "purpose", path);
  const status = requiredString(record, "status", path);
  if (borrowerKind !== "agent" && borrowerKind !== "business") {
    throw new EngineError("INTERNAL", `${path}.borrowerKind is invalid`);
  }
  if (purpose !== "working_capital" && purpose !== "vehicle" && purpose !== "appliance") {
    throw new EngineError("INTERNAL", `${path}.purpose is invalid`);
  }
  if (status !== "current" && status !== "delinquent") {
    throw new EngineError("INTERNAL", `${path}.status is invalid`);
  }
  const rawInstallments = record["installments"];
  if (!Array.isArray(rawInstallments)) {
    throw new EngineError("INTERNAL", `${path}.installments must be an array`);
  }
  const installments = rawInstallments.map((entry, index) => {
    const installmentPath = `${path}.installments.${index}`;
    const row = objectRecord(entry, installmentPath);
    const installmentStatus = requiredString(row, "status", installmentPath);
    if (
      installmentStatus !== "paid" &&
      installmentStatus !== "missed" &&
      installmentStatus !== "scheduled"
    ) {
      throw new EngineError("INTERNAL", `${installmentPath}.status is invalid`);
    }
    return Object.freeze({
      installment: requiredInteger(row, "installment", installmentPath),
      principalCents: requiredString(row, "principalCents", installmentPath),
      interestCents: requiredString(row, "interestCents", installmentPath),
      status: installmentStatus,
    });
  });
  return Object.freeze({
    id: requiredString(record, "id", path),
    runId: requiredString(record, "runId", path),
    borrowerKind,
    borrowerId: requiredString(record, "borrowerId", path),
    purpose,
    originalPrincipalCents: requiredString(record, "originalPrincipalCents", path),
    outstandingPrincipalCents: requiredString(record, "outstandingPrincipalCents", path),
    annualRateBp: requiredInteger(record, "annualRateBp", path),
    termMonths: requiredInteger(record, "termMonths", path),
    seasonedMonths: requiredInteger(record, "seasonedMonths", path),
    status,
    missedPayments: requiredInteger(record, "missedPayments", path),
    installments: Object.freeze(installments),
  });
}
