/** Deterministic double-entry posting engine (WS-301/WS-302). */

import {
  EngineError,
  hashValue,
  ledgerTransactionSchema,
  money,
} from "@worldtangle/shared";
import type {
  AccountOwnerKind,
  ActorRef,
  BankAccountType,
  LedgerTransaction,
} from "@worldtangle/shared";

export interface LedgerAccountSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly ownerKind: AccountOwnerKind;
  readonly ownerId: string;
  readonly type: BankAccountType;
  readonly balanceCents: bigint;
  readonly floorCents: bigint;
  readonly status: "active" | "frozen" | "closed";
}

export interface StoredLedgerTransaction {
  readonly transaction: LedgerTransaction;
  readonly requestHash: string;
}

export interface LedgerRepository {
  findByIdempotencyKey(runId: string, idempotencyKey: string): StoredLedgerTransaction | null;
  getAccounts(runId: string, accountIds: readonly string[]): readonly LedgerAccountSnapshot[];
  saveTransaction(
    transaction: LedgerTransaction,
    requestHash: string,
    resultingBalances: ReadonlyMap<string, bigint>,
  ): void;
}

export interface LedgerPostResult {
  readonly transaction: LedgerTransaction;
  readonly duplicate: boolean;
  readonly warning?: "duplicate_idempotency_key_ignored";
  readonly resultingBalances: ReadonlyMap<string, bigint>;
}

const CONTROLLED_MONEY_KINDS = new Set([
  "mint",
  "loan_disbursement",
  "loan_payment",
  "row_settlement",
]);

function postingRequestHash(transaction: LedgerTransaction): string {
  return hashValue({
    runId: transaction.runId,
    tick: transaction.tick,
    kind: transaction.kind,
    actor: transaction.actor,
    reason: transaction.reason,
    sourceEventId: transaction.sourceEventId,
    correlationId: transaction.correlationId,
    legs: transaction.legs,
  });
}

function assertMoneyChannelAuthorized(
  transaction: LedgerTransaction,
  accounts: ReadonlyMap<string, LedgerAccountSnapshot>,
): void {
  if (!CONTROLLED_MONEY_KINDS.has(transaction.kind)) return;
  if (transaction.actor.kind !== "system") {
    throw new EngineError(
      "PERMISSION_DENIED",
      `only the system actor may post ${transaction.kind} transactions`,
    );
  }
  if (transaction.kind === "row_settlement") {
    if (!transaction.legs.some((leg) => accounts.get(leg.accountId)?.ownerKind === "system_row")) {
      throw new EngineError("PERMISSION_DENIED", "ROW settlements require a system ROW account");
    }
    return;
  }
  if (transaction.kind === "loan_disbursement" || transaction.kind === "loan_payment") {
    if (!transaction.legs.some((leg) => accounts.get(leg.accountId)?.ownerKind === "bank_internal")) {
      throw new EngineError("PERMISSION_DENIED", "loan money channels require a bank-internal account");
    }
    return;
  }
  const hasAuthorizedSource = transaction.legs.some((leg) => {
    const account = accounts.get(leg.accountId);
    return leg.direction === "credit" &&
      account?.ownerKind === "bank_internal" &&
      (account.type === "equity" || account.type === "internal_liability");
  });
  if (!hasAuthorizedSource) {
    throw new EngineError(
      "PERMISSION_DENIED",
      "mint transactions require a credited bank-internal source account",
    );
  }
}

function assertOutboundOwnership(
  transaction: LedgerTransaction,
  accounts: ReadonlyMap<string, LedgerAccountSnapshot>,
): void {
  if (transaction.actor.kind === "system" || transaction.actor.kind === "admin") return;
  for (const leg of transaction.legs) {
    if (leg.direction !== "credit") continue;
    const account = accounts.get(leg.accountId)!;
    const ownsAccount = transaction.actor.kind === "agent"
      ? account.ownerKind === "agent" && account.ownerId === transaction.actor.id
      : (account.ownerKind === "company" || account.ownerKind === "government") &&
        account.ownerId === transaction.actor.id;
    if (!ownsAccount) {
      throw new EngineError(
        "PERMISSION_DENIED",
        `${transaction.actor.kind}:${transaction.actor.id} cannot spend from account ${account.id}`,
      );
    }
  }
}

/**
 * Debit-positive convention: a debit raises an account's cached balance and a
 * credit lowers it. Internal contra accounts make every external balance
 * change double-entry while account floors remain directly understandable.
 */
export class DoubleEntryLedger {
  constructor(private readonly repository: LedgerRepository) {}

  post(input: LedgerTransaction): LedgerPostResult {
    const transaction = ledgerTransactionSchema.parse(input);
    const requestHash = postingRequestHash(transaction);
    const prior = this.repository.findByIdempotencyKey(
      transaction.runId,
      transaction.idempotencyKey,
    );
    if (prior !== null) {
      if (prior.requestHash !== requestHash) {
        throw new EngineError(
          "CONFLICT",
          `idempotency key ${transaction.idempotencyKey} was already used for different work`,
        );
      }
      return {
        transaction: prior.transaction,
        duplicate: true,
        warning: "duplicate_idempotency_key_ignored",
        resultingBalances: new Map(),
      };
    }

    let debitCents = 0n;
    let creditCents = 0n;
    const accountIds = [...new Set(transaction.legs.map((leg) => leg.accountId))];
    if (accountIds.length < 2) {
      throw new EngineError("VALIDATION_FAILED", "a transaction must affect at least two accounts");
    }
    const loaded = this.repository.getAccounts(transaction.runId, accountIds);
    const accounts = new Map(loaded.map((account) => [account.id, account]));
    for (const accountId of accountIds) {
      const account = accounts.get(accountId);
      if (account === undefined) {
        throw new EngineError("NOT_FOUND", `ledger account ${accountId} does not exist`);
      }
      if (account.runId !== transaction.runId) {
        throw new EngineError("CONFLICT", `ledger account ${accountId} belongs to another run`);
      }
      if (account.status !== "active") {
        throw new EngineError("CONFLICT", `ledger account ${accountId} is not active`);
      }
    }
    assertMoneyChannelAuthorized(transaction, accounts);
    assertOutboundOwnership(transaction, accounts);

    const deltas = new Map<string, bigint>();
    for (const leg of transaction.legs) {
      const amount = money(leg.amountCents);
      if (leg.direction === "debit") {
        debitCents += amount;
        deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? 0n) + amount);
      } else {
        creditCents += amount;
        deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? 0n) - amount);
      }
    }
    if (debitCents !== creditCents) {
      throw new EngineError("VALIDATION_FAILED", "transaction debits and credits must be equal", {
        debitCents: debitCents.toString(),
        creditCents: creditCents.toString(),
      });
    }

    const resultingBalances = new Map<string, bigint>();
    for (const [accountId, delta] of deltas) {
      const account = accounts.get(accountId)!;
      const next = account.balanceCents + delta;
      if (next < account.floorCents) {
        throw new EngineError("INSUFFICIENT_FUNDS", `account ${accountId} would cross its floor`, {
          accountId,
          balanceCents: account.balanceCents.toString(),
          deltaCents: delta.toString(),
          floorCents: account.floorCents.toString(),
        });
      }
      resultingBalances.set(accountId, next);
    }

    this.repository.saveTransaction(transaction, requestHash, resultingBalances);
    return { transaction, duplicate: false, resultingBalances };
  }
}

/** Capability rule used by the account-opening command boundary. */
export function assertCanOpenAccount(
  actor: ActorRef,
  ownerKind: AccountOwnerKind,
  ownerId: string,
): void {
  if (actor.kind === "system" || actor.kind === "admin") return;
  if (actor.kind === "agent" && ownerKind === "agent" && actor.id === ownerId) return;
  if (
    actor.kind === "institution" &&
    (ownerKind === "company" || ownerKind === "government") &&
    actor.id === ownerId
  ) return;
  throw new EngineError("PERMISSION_DENIED", `${actor.kind}:${actor.id} cannot open this account`);
}

/** Rebuild one account balance from immutable legs and an optional genesis base. */
export function reconcileLedgerBalance(
  baseCents: bigint,
  legs: readonly { readonly direction: "debit" | "credit"; readonly amountCents: string }[],
): bigint {
  return legs.reduce(
    (balance, leg) => balance + (leg.direction === "debit" ? money(leg.amountCents) : -money(leg.amountCents)),
    baseCents,
  );
}
