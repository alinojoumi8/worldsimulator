/** Authoritative persisted read model and audit boundary for WS-506 opening credit. */

import {
  canonicalParse,
  EngineError,
} from "@worldtangle/shared";
import {
  auditOpeningCreditState,
  parseSeedLoan,
} from "@worldtangle/engine";
import type {
  OpeningCreditAuditReport,
  OpeningCreditLedgerAccount,
  OpeningCreditLedgerLink,
  OpeningCreditLedgerTransaction,
  OpeningCreditSeedEvent,
  OpeningCreditState,
  SeedLoan,
} from "@worldtangle/engine";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

interface SeedLoanRow {
  readonly id: string;
  readonly loan_canonical: string;
}

interface AccountRow {
  readonly id: string;
  readonly bank_id: string;
  readonly owner_kind: string;
  readonly owner_id: string;
  readonly account_type: string;
  readonly balance_cents: string;
  readonly status: string;
}

interface LinkRow {
  readonly loan_id: string;
  readonly bank_asset_account_id: string;
  readonly borrower_deposit_account_id: string;
  readonly disbursement_transaction_id: string;
}

interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly reason: string;
}

interface LegRow {
  readonly transaction_id: string;
  readonly account_id: string;
  readonly direction: "debit" | "credit";
  readonly amount_cents: string;
}

interface EventRow {
  readonly event_id: string;
  readonly schema_version: bigint;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload_canonical: string;
}

interface TransactionEventRow {
  readonly event_id: string;
  readonly payload_canonical: string;
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("INTERNAL", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new EngineError("INTERNAL", `${path}.${key} must be a string`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("INTERNAL", `${path}.${key} must be an integer`);
  }
  return Number(value);
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new EngineError("INTERNAL", `${path}.${key} must be a string array`);
  }
  return Object.freeze(value.map(String));
}

function parseSeedEvent(row: EventRow): OpeningCreditSeedEvent {
  const path = `loan.seeded event ${row.event_id}`;
  const payload = objectRecord(canonicalParse(row.payload_canonical), `${path}.payload`);
  return Object.freeze({
    eventId: row.event_id,
    schemaVersion: toSafeNumber(row.schema_version, "opening credit event schema version"),
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    loanId: requiredString(payload, "loanId", path),
    borrowerKind: requiredString(payload, "borrowerKind", path),
    borrowerId: requiredString(payload, "borrowerId", path),
    purpose: requiredString(payload, "purpose", path),
    originalPrincipalCents: requiredString(payload, "originalPrincipalCents", path),
    outstandingPrincipalCents: requiredString(payload, "outstandingPrincipalCents", path),
    annualRateBp: requiredInteger(payload, "annualRateBp", path),
    termMonths: requiredInteger(payload, "termMonths", path),
    seasonedMonths: requiredInteger(payload, "seasonedMonths", path),
    status: requiredString(payload, "status", path),
    missedPayments: requiredInteger(payload, "missedPayments", path),
    scheduleDigest: requiredString(payload, "scheduleDigest", path),
    bankId: requiredString(payload, "bankId", path),
    bankAssetAccountId: requiredString(payload, "bankAssetAccountId", path),
    borrowerDepositAccountId: requiredString(payload, "borrowerDepositAccountId", path),
    recognitionTransactionId: requiredString(payload, "recognitionTransactionId", path),
    evidence: requiredStringArray(payload, "evidence", path),
  });
}

export class SqliteOpeningCreditStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {}

  listLoans(): readonly SeedLoan[] {
    return Object.freeze(this.db.prepare<[string], SeedLoanRow>(`
      SELECT id, loan_canonical FROM seed_loans
      WHERE run_id = ? ORDER BY id
    `).all(this.runId).map((row) => {
      const loan = parseSeedLoan(canonicalParse(row.loan_canonical), `seed_loans.${row.id}`);
      if (loan.id !== row.id || loan.runId !== this.runId) {
        throw new EngineError("INTERNAL", `seed loan ${row.id} identity is inconsistent`);
      }
      return loan;
    }));
  }

  readState(): OpeningCreditState {
    const links: readonly OpeningCreditLedgerLink[] = Object.freeze(
      this.db.prepare<[string], LinkRow>(`
        SELECT loan_id, bank_asset_account_id, borrower_deposit_account_id,
          disbursement_transaction_id
        FROM seed_loan_ledger_links WHERE run_id = ? ORDER BY loan_id
      `).all(this.runId).map((row) => Object.freeze({
        loanId: row.loan_id,
        bankAssetAccountId: row.bank_asset_account_id,
        borrowerDepositAccountId: row.borrower_deposit_account_id,
        recognitionTransactionId: row.disbursement_transaction_id,
      })),
    );
    const accounts: readonly OpeningCreditLedgerAccount[] = Object.freeze(
      this.db.prepare<[string], AccountRow>(`
        SELECT id, bank_id, owner_kind, owner_id, account_type, balance_cents, status
        FROM bank_accounts WHERE run_id = ? ORDER BY id
      `).all(this.runId).map((row) => Object.freeze({
        id: row.id,
        bankId: row.bank_id,
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        accountType: row.account_type,
        balanceCents: row.balance_cents,
        status: row.status,
      })),
    );
    const legsByTransaction = new Map<string, LegRow[]>();
    for (const row of this.db.prepare<[string, string], LegRow>(`
      SELECT transaction_id, account_id, direction, amount_cents
      FROM ledger_transaction_legs
      WHERE run_id = ? AND transaction_id IN (
        SELECT disbursement_transaction_id FROM seed_loan_ledger_links
        WHERE run_id = ?
      )
      ORDER BY transaction_id, leg_index
    `).all(this.runId, this.runId)) {
      const legs = legsByTransaction.get(row.transaction_id) ?? [];
      legs.push(row);
      legsByTransaction.set(row.transaction_id, legs);
    }
    const transactionEventIds = new Map<string, string>();
    for (const row of this.db.prepare<[string], TransactionEventRow>(`
      SELECT event_id, payload_canonical FROM events
      WHERE run_id = ? AND type = 'transaction.posted' ORDER BY seq
    `).all(this.runId)) {
      const payload = canonicalParse(row.payload_canonical);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
      const transactionId = (payload as Record<string, unknown>)["transactionId"];
      if (typeof transactionId === "string") transactionEventIds.set(transactionId, row.event_id);
    }
    const transactions: readonly OpeningCreditLedgerTransaction[] = Object.freeze(
      this.db.prepare<[string, string], TransactionRow>(`
        SELECT id, kind, actor_kind, actor_id, reason FROM ledger_transactions
        WHERE run_id = ? AND id IN (
          SELECT disbursement_transaction_id FROM seed_loan_ledger_links
          WHERE run_id = ?
        )
        ORDER BY id
      `).all(this.runId, this.runId).map((row) => Object.freeze({
        id: row.id,
        kind: row.kind,
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        reason: row.reason,
        eventId: transactionEventIds.get(row.id) ?? null,
        legs: Object.freeze((legsByTransaction.get(row.id) ?? []).map((leg) => Object.freeze({
          accountId: leg.account_id,
          direction: leg.direction,
          amountCents: leg.amount_cents,
        }))),
      })),
    );
    const seedEvents: readonly OpeningCreditSeedEvent[] = Object.freeze(
      this.db.prepare<[string], EventRow>(`
        SELECT event_id, schema_version, actor_kind, actor_id, correlation_id,
          causation_id, payload_canonical
        FROM events WHERE run_id = ? AND type = 'loan.seeded' ORDER BY seq
      `).all(this.runId).map(parseSeedEvent),
    );
    return Object.freeze({
      loans: this.listLoans(),
      accounts,
      transactions,
      links,
      seedEvents,
    });
  }

  audit(): OpeningCreditAuditReport {
    return auditOpeningCreditState(this.readState());
  }
}
