/** Authoritative WS-804 exact pro-rata ownership distributions. */

import {
  EngineError,
  investmentDistributionCompletedPayloadSchema,
  investmentDistributionRequestSchema,
  investmentDistributionRequestedPayloadSchema,
  investmentDistributionSchema,
  ledgerTransactionSchema,
  type InvestmentDistribution,
  type InvestmentDistributionAllocation,
  type InvestmentDistributionRequest,
  type LedgerTransaction,
} from "@worldtangle/shared";
import {
  quoteInvestmentDistribution,
  type InvestmentDistributionAllocationQuote,
  type TickContext,
} from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteInvestmentStore } from "./investment-store";

interface DistributionRow {
  readonly run_id: string;
  readonly id: string;
  readonly company_id: string;
  readonly amount_cents: string;
  readonly total_shares: string;
  readonly company_account_id: string;
  readonly transaction_id: string;
  readonly reference_id: string;
  readonly distributed_tick: bigint;
  readonly request_event_id: string;
  readonly source_event_id: string;
}

interface AllocationRow {
  readonly distribution_id: string;
  readonly allocation_index: bigint;
  readonly holder_kind: "agent" | "venture_fund";
  readonly holder_id: string;
  readonly shares: string;
  readonly amount_cents: string;
  readonly account_id: string;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidence(refs: readonly (string | null | undefined)[]): readonly string[] {
  return Object.freeze(
    [...new Set(refs.filter((ref): ref is string => ref !== null && ref !== undefined))]
      .sort(compareCodeUnit),
  );
}

export class SqliteInvestmentDistributionStore {
  private readonly finance: SqliteFinanceStore;
  private readonly investments: SqliteInvestmentStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.finance = new SqliteFinanceStore(db, runId);
    this.investments = new SqliteInvestmentStore(db, runId);
  }

  distribute(
    input: InvestmentDistributionRequest,
    ctx: TickContext,
  ): InvestmentDistribution {
    this.assertContext(ctx);
    const request = investmentDistributionRequestSchema.parse(input);
    const prior = this.findByReference(request.companyId, request.referenceId);
    if (prior !== null) {
      if (prior.amountCents !== request.amountCents) {
        throw new EngineError(
          "CONFLICT",
          `distribution reference ${request.referenceId} was already used for a different amount`,
        );
      }
      return prior;
    }

    return this.atomic(() => {
      const duplicate = this.findByReference(request.companyId, request.referenceId);
      if (duplicate !== null) {
        if (duplicate.amountCents !== request.amountCents) {
          throw new EngineError(
            "CONFLICT",
            `distribution reference ${request.referenceId} was already used for a different amount`,
          );
        }
        return duplicate;
      }

      const capTable = this.investments.capTable(request.companyId);
      const quote = quoteInvestmentDistribution(
        request.amountCents,
        capTable.stakes.map((stake) => ({
          holderKind: stake.holderKind,
          holderId: stake.holderId,
          shares: stake.shares,
        })),
      );
      if (quote.totalShares !== capTable.totalShares) {
        throw new EngineError("CONFLICT", `company ${request.companyId} violates INV-4`);
      }
      const companyAccountId = this.companyCheckingAccount(request.companyId);
      const companyBalance = this.finance.accountBalance(companyAccountId);
      if (BigInt(quote.amountCents) > companyBalance) {
        throw new EngineError(
          "INSUFFICIENT_FUNDS",
          `company ${request.companyId} cannot fund distribution ${request.referenceId}`,
          {
            companyAccountId,
            balanceCents: companyBalance.toString(),
            requestedCents: quote.amountCents,
          },
        );
      }
      const resolvedAllocations = quote.allocations.map((allocation) => ({
        ...allocation,
        accountId: this.recipientAccount(allocation),
      }));
      const distributionId = ctx.ids.next("dist");
      const allocations = resolvedAllocations.map((allocation, allocationIndex) => ({
        distributionId,
        allocationIndex,
        ...allocation,
      }));
      const requestedPayload = investmentDistributionRequestedPayloadSchema.parse({
        distributionId,
        companyId: request.companyId,
        amountCents: quote.amountCents,
        totalShares: quote.totalShares,
        referenceId: request.referenceId,
        allocations: allocations.map((allocation) => ({
          allocationIndex: allocation.allocationIndex,
          holderKind: allocation.holderKind,
          holderId: allocation.holderId,
          shares: allocation.shares,
          amountCents: allocation.amountCents,
        })),
        evidence: evidence([request.causationId, ...request.evidenceRefs]),
      });
      const requestedEvent = ctx.emit(
        "investment.distribution.requested",
        requestedPayload,
        {
          actor: { kind: "institution", id: request.companyId },
          schemaVersion: 1,
          correlationId: request.referenceId,
          causationId: request.causationId,
        },
      );
      const transaction = ledgerTransactionSchema.parse({
        id: ctx.ids.next("txn"),
        runId: this.runId,
        tick: ctx.tick,
        kind: "dividend",
        actor: { kind: "institution", id: request.companyId },
        reason: "investment.distribution",
        sourceEventId: requestedEvent.eventId,
        correlationId: request.referenceId,
        idempotencyKey: `investment-distribution:${distributionId}`,
        legs: [
          {
            accountId: companyAccountId,
            direction: "credit",
            amountCents: quote.amountCents,
          },
          ...allocations
            .filter((allocation) => allocation.amountCents !== "0")
            .map((allocation) => ({
              accountId: allocation.accountId,
              direction: "debit" as const,
              amountCents: allocation.amountCents,
            })),
        ],
      });
      this.finance.post(transaction);
      ctx.count("transactions");
      const postedEventId = this.emitTransactionPosted(
        transaction,
        requestedEvent.eventId,
        ctx,
      );
      const completedPayload = investmentDistributionCompletedPayloadSchema.parse({
        distributionId,
        companyId: request.companyId,
        amountCents: quote.amountCents,
        totalShares: quote.totalShares,
        companyAccountId,
        transactionId: transaction.id,
        referenceId: request.referenceId,
        distributedTick: ctx.tick,
        allocations: allocations.map((allocation) => ({
          allocationIndex: allocation.allocationIndex,
          holderKind: allocation.holderKind,
          holderId: allocation.holderId,
          shares: allocation.shares,
          amountCents: allocation.amountCents,
          accountId: allocation.accountId,
        })),
        requestEventId: requestedEvent.eventId,
        evidence: evidence([
          request.causationId,
          ...request.evidenceRefs,
          requestedEvent.eventId,
          postedEventId,
        ]),
      });
      const completedEvent = ctx.emit(
        "investment.distribution.completed",
        completedPayload,
        {
          actor: { kind: "institution", id: request.companyId },
          schemaVersion: 1,
          correlationId: request.referenceId,
          causationId: postedEventId,
        },
      );
      const distribution = investmentDistributionSchema.parse({
        id: distributionId,
        runId: this.runId,
        companyId: request.companyId,
        amountCents: quote.amountCents,
        totalShares: quote.totalShares,
        companyAccountId,
        transactionId: transaction.id,
        referenceId: request.referenceId,
        distributedTick: ctx.tick,
        allocations,
        requestEventId: requestedEvent.eventId,
        sourceEventId: completedEvent.eventId,
      });
      this.insert(distribution);
      return distribution;
    });
  }

  get(distributionId: string): InvestmentDistribution {
    const row = this.db.prepare<[string, string], DistributionRow>(`
      SELECT * FROM investment_distributions WHERE run_id = ? AND id = ?
    `).get(this.runId, distributionId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `investment distribution ${distributionId} does not exist`);
    }
    return this.mapDistribution(row);
  }

  list(companyId?: string): readonly InvestmentDistribution[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], DistributionRow>(`
          SELECT * FROM investment_distributions
          WHERE run_id = ? ORDER BY distributed_tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], DistributionRow>(`
          SELECT * FROM investment_distributions
          WHERE run_id = ? AND company_id = ? ORDER BY distributed_tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => this.mapDistribution(row)));
  }

  private findByReference(companyId: string, referenceId: string): InvestmentDistribution | null {
    const row = this.db.prepare<[string, string, string], DistributionRow>(`
      SELECT * FROM investment_distributions
      WHERE run_id = ? AND company_id = ? AND reference_id = ?
    `).get(this.runId, companyId, referenceId);
    return row === undefined ? null : this.mapDistribution(row);
  }

  private recipientAccount(
    allocation: InvestmentDistributionAllocationQuote,
  ): string {
    const row = allocation.holderKind === "agent"
      ? this.db.prepare<[string, string], { id: string }>(`
          SELECT id FROM bank_accounts
          WHERE run_id = ? AND owner_kind = 'agent' AND owner_id = ?
            AND account_type = 'checking' AND status = 'active'
          ORDER BY id LIMIT 1
        `).get(this.runId, allocation.holderId)
      : this.db.prepare<[string, string], { id: string }>(`
          SELECT account.id
          FROM vc_fund_accounts link
          JOIN bank_accounts account
            ON account.run_id = link.run_id AND account.id = link.account_id
          WHERE link.run_id = ? AND link.fund_id = ?
            AND account.account_type = 'checking' AND account.status = 'active'
          ORDER BY account.id LIMIT 1
        `).get(this.runId, allocation.holderId);
    if (row === undefined) {
      throw new EngineError(
        "CONFLICT",
        `${allocation.holderKind}:${allocation.holderId} lacks an active distribution account`,
      );
    }
    return row.id;
  }

  private companyCheckingAccount(companyId: string): string {
    const row = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company' AND owner_id = ?
        AND account_type = 'checking' AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(this.runId, companyId);
    if (row === undefined) {
      throw new EngineError("CONFLICT", `company ${companyId} lacks an active checking account`);
    }
    return row.id;
  }

  private insert(distribution: InvestmentDistribution): void {
    const insertAllocation = this.db.prepare(`
      INSERT INTO investment_distribution_allocations(
        run_id, distribution_id, company_id, allocation_index, holder_kind,
        holder_id, shares, amount_cents, account_id
      ) VALUES (
        @runId, @distributionId, @companyId, @allocationIndex, @holderKind,
        @holderId, @shares, @amountCents, @accountId
      )
    `);
    for (const allocation of distribution.allocations) {
      insertAllocation.run({
        runId: distribution.runId,
        companyId: distribution.companyId,
        ...allocation,
      });
    }
    this.db.prepare(`
      INSERT INTO investment_distributions(
        run_id, id, company_id, amount_cents, total_shares,
        company_account_id, transaction_id, reference_id, distributed_tick,
        request_event_id, source_event_id
      ) VALUES (
        @runId, @id, @companyId, @amountCents, @totalShares,
        @companyAccountId, @transactionId, @referenceId, @distributedTick,
        @requestEventId, @sourceEventId
      )
    `).run(distribution);
  }

  private mapDistribution(row: DistributionRow): InvestmentDistribution {
    const allocations = this.db.prepare<[string, string], AllocationRow>(`
      SELECT distribution_id, allocation_index, holder_kind, holder_id,
        shares, amount_cents, account_id
      FROM investment_distribution_allocations
      WHERE run_id = ? AND distribution_id = ? ORDER BY allocation_index
    `).all(this.runId, row.id).map((allocation) => ({
      distributionId: allocation.distribution_id,
      allocationIndex: toSafeNumber(allocation.allocation_index, "distribution allocation index"),
      holderKind: allocation.holder_kind,
      holderId: allocation.holder_id,
      shares: allocation.shares,
      amountCents: allocation.amount_cents,
      accountId: allocation.account_id,
    } satisfies InvestmentDistributionAllocation));
    return investmentDistributionSchema.parse({
      id: row.id,
      runId: row.run_id,
      companyId: row.company_id,
      amountCents: row.amount_cents,
      totalShares: row.total_shares,
      companyAccountId: row.company_account_id,
      transactionId: row.transaction_id,
      referenceId: row.reference_id,
      distributedTick: toSafeNumber(row.distributed_tick, "investment distribution tick"),
      allocations,
      requestEventId: row.request_event_id,
      sourceEventId: row.source_event_id,
    });
  }

  private emitTransactionPosted(
    transaction: LedgerTransaction,
    causationId: string,
    ctx: TickContext,
  ): string {
    return ctx.emit("transaction.posted", {
      transactionId: transaction.id,
      kind: transaction.kind,
      legs: transaction.legs,
      reason: transaction.reason,
      sourceEventId: transaction.sourceEventId,
      correlationId: transaction.correlationId,
    }, {
      actor: transaction.actor,
      schemaVersion: 1,
      correlationId: transaction.correlationId,
      causationId,
    }).eventId;
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "distribution context belongs to another run");
    }
  }

  private atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
