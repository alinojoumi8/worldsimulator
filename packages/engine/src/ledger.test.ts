import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import type { LedgerTransaction } from "@worldtangle/shared";
import {
  assertCanOpenAccount,
  DoubleEntryLedger,
} from "./ledger";
import type {
  LedgerAccountSnapshot,
  LedgerRepository,
  StoredLedgerTransaction,
} from "./ledger";

class MemoryLedgerRepository implements LedgerRepository {
  readonly accounts = new Map<string, LedgerAccountSnapshot>();
  readonly transactions = new Map<string, StoredLedgerTransaction>();

  findByIdempotencyKey(_runId: string, key: string): StoredLedgerTransaction | null {
    return this.transactions.get(key) ?? null;
  }

  getAccounts(_runId: string, ids: readonly string[]): readonly LedgerAccountSnapshot[] {
    return ids.flatMap((id) => {
      const account = this.accounts.get(id);
      return account === undefined ? [] : [account];
    });
  }

  saveTransaction(
    transaction: LedgerTransaction,
    requestHash: string,
    balances: ReadonlyMap<string, bigint>,
  ): void {
    this.transactions.set(transaction.idempotencyKey, { transaction, requestHash });
    for (const [id, balanceCents] of balances) {
      this.accounts.set(id, { ...this.accounts.get(id)!, balanceCents });
    }
  }
}

function account(
  id: string,
  balanceCents: bigint,
  ownerKind: LedgerAccountSnapshot["ownerKind"] = "agent",
  ownerId = id,
): LedgerAccountSnapshot {
  return {
    id,
    runId: "run_00000001",
    ownerKind,
    ownerId,
    type: ownerKind === "bank_internal" ? "equity" : "checking",
    balanceCents,
    floorCents: ownerKind === "bank_internal" ? -10_000_000_000n : 0n,
    status: "active",
  };
}

function transfer(amountCents: string): LedgerTransaction {
  return {
    id: "txn_00000001",
    runId: "run_00000001",
    tick: 1,
    kind: "transfer",
    actor: { kind: "agent", id: "agt_00000001" },
    reason: "test transfer",
    sourceEventId: null,
    correlationId: "test-transfer",
    idempotencyKey: "test-transfer",
    legs: [
      { accountId: "acct_00000002", direction: "debit", amountCents },
      { accountId: "acct_00000001", direction: "credit", amountCents },
    ],
  };
}

describe("DoubleEntryLedger", () => {
  it("posts balanced legs, reconciles caches, and ignores exact duplicates", () => {
    const repository = new MemoryLedgerRepository();
    repository.accounts.set("acct_00000001", account("acct_00000001", 1_000n, "agent", "agt_00000001"));
    repository.accounts.set("acct_00000002", account("acct_00000002", 100n, "agent", "agt_00000002"));
    const ledger = new DoubleEntryLedger(repository);

    const first = ledger.post(transfer("250"));
    const duplicate = ledger.post({ ...transfer("250"), id: "txn_00000002" });

    expect(first.duplicate).toBe(false);
    expect(repository.accounts.get("acct_00000001")?.balanceCents).toBe(750n);
    expect(repository.accounts.get("acct_00000002")?.balanceCents).toBe(350n);
    expect(duplicate).toMatchObject({
      duplicate: true,
      warning: "duplicate_idempotency_key_ignored",
      transaction: { id: "txn_00000001" },
    });
  });

  it("rejects imbalanced postings, floor violations, conflicting retries, and unauthorized mint", () => {
    const repository = new MemoryLedgerRepository();
    repository.accounts.set("acct_00000001", account("acct_00000001", 100n, "agent", "agt_00000001"));
    repository.accounts.set("acct_00000002", account("acct_00000002", 0n, "agent", "agt_00000002"));
    repository.accounts.set(
      "acct_00000003",
      account("acct_00000003", 0n, "bank_internal"),
    );
    const ledger = new DoubleEntryLedger(repository);

    expect(() => ledger.post({
      ...transfer("50"),
      legs: [
        { accountId: "acct_00000002", direction: "debit", amountCents: "50" },
        { accountId: "acct_00000001", direction: "credit", amountCents: "49" },
      ],
    })).toThrowError(/debits and credits/);
    expect(() => ledger.post(transfer("101"))).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_FUNDS" }),
    );
    expect(() => ledger.post({
      ...transfer("10"),
      kind: "mint",
      legs: [
        { accountId: "acct_00000002", direction: "debit", amountCents: "10" },
        { accountId: "acct_00000003", direction: "credit", amountCents: "10" },
      ],
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => ledger.post({
      ...transfer("10"),
      actor: { kind: "agent", id: "agt_00000002" },
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => ledger.post({
      ...transfer("10"),
      kind: "row_settlement",
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));

    ledger.post(transfer("50"));
    expect(() => ledger.post({ ...transfer("51"), id: "txn_00000002" })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("preserves total external balances for every valid transfer", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (amount, recipientOpening) => {
        const repository = new MemoryLedgerRepository();
        repository.accounts.set("acct_00000001", account("acct_00000001", BigInt(amount), "agent", "agt_00000001"));
        repository.accounts.set(
          "acct_00000002",
          account("acct_00000002", BigInt(recipientOpening), "agent", "agt_00000002"),
        );
        const before = BigInt(amount + recipientOpening);
        new DoubleEntryLedger(repository).post(transfer(String(amount)));
        const after = [...repository.accounts.values()]
          .reduce((sum, value) => sum + value.balanceCents, 0n);
        expect(after).toBe(before);
      },
    ));
  });
});

describe("account capabilities", () => {
  it("allows self-service and administrative opening but rejects ownership escalation", () => {
    expect(() => assertCanOpenAccount(
      { kind: "agent", id: "agt_00000001" },
      "agent",
      "agt_00000001",
    )).not.toThrow();
    expect(() => assertCanOpenAccount(
      { kind: "system", id: "engine" },
      "company",
      "biz_1",
    )).not.toThrow();
    expect(() => assertCanOpenAccount(
      { kind: "agent", id: "agt_00000001" },
      "agent",
      "agt_00000002",
    )).toThrowError(expect.objectContaining<Partial<EngineError>>({ code: "PERMISSION_DENIED" }));
  });
});
