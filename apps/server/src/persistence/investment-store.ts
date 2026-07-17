/** Authoritative WS-803 priced-round validation and atomic investment closing. */

import {
  capTableSnapshotSchema,
  EngineError,
  investmentCompletedPayloadSchema,
  investmentSchema,
  ledgerTransactionSchema,
  ownershipStakeSchema,
  type CapTableSnapshot,
  type Investment,
  type InvestmentProposal,
  type LedgerTransaction,
  type OwnershipStake,
  type VentureFund,
} from "@worldtangle/shared";
import {
  createContractFromTemplate,
  quotePricedRound,
  quoteVentureFundDeployment,
  type PricedRoundQuote,
  type TickContext,
} from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import {
  SqliteInvestmentProposalStore,
  type InvestmentProposalValidationFailure,
} from "./investment-proposal-store";
import { SqlitePhase4Store } from "./phase4-store";
import { SqliteVentureStore } from "./venture-store";

interface InvestmentRow {
  readonly run_id: string;
  readonly id: string;
  readonly proposal_id: string;
  readonly company_id: string;
  readonly investor_id: string;
  readonly firm_id: string;
  readonly amount_cents: string;
  readonly pre_money_valuation_cents: string;
  readonly shares_issued: string;
  readonly total_shares_before: string;
  readonly total_shares_after: string;
  readonly price_per_share_cents: string;
  readonly transaction_id: string;
  readonly capital_call_transaction_id: string | null;
  readonly contract_id: string;
  readonly ownership_stake_id: string;
  readonly completed_tick: bigint;
  readonly source_event_id: string;
}

interface CapTableRow {
  readonly company_kind: "opening" | "dynamic";
  readonly total_shares: string;
}

interface OwnershipStakeRow {
  readonly id: string;
  readonly company_id: string;
  readonly holder_kind: "agent" | "venture_fund";
  readonly holder_id: string;
  readonly shares: string;
  readonly acquired_via: "founding" | "investment" | "trade";
  readonly since_tick: bigint;
  readonly source_event_id: string | null;
}

interface PreparedInvestmentClose {
  readonly proposal: InvestmentProposal;
  readonly fund: VentureFund;
  readonly quote: PricedRoundQuote;
  readonly capTableBefore: CapTableSnapshot;
  readonly companyAccountId: string;
}

export interface InvestmentClosingTickResult {
  readonly completed: readonly Investment[];
  readonly rejected: readonly InvestmentProposal[];
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

function validationFailure(error: EngineError): InvestmentProposalValidationFailure {
  const details = error.details !== null && typeof error.details === "object" &&
      !Array.isArray(error.details)
    ? { ...(error.details as Readonly<Record<string, unknown>>) }
    : undefined;
  return {
    code: error.code,
    message: error.message,
    ...(details === undefined ? {} : { details }),
  };
}

function isRejectableClosingValidation(error: EngineError): boolean {
  return error.code === "VALIDATION_FAILED" ||
    error.code === "LIMIT_EXCEEDED" ||
    error.code === "INSUFFICIENT_FUNDS";
}

export class SqliteInvestmentStore {
  private readonly finance: SqliteFinanceStore;
  private readonly phase4: SqlitePhase4Store;
  private readonly proposals: SqliteInvestmentProposalStore;
  private readonly venture: SqliteVentureStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.finance = new SqliteFinanceStore(db, runId);
    this.phase4 = new SqlitePhase4Store(db, runId);
    this.proposals = new SqliteInvestmentProposalStore(db, runId);
    this.venture = new SqliteVentureStore(db, runId);
  }

  processTick(ctx: TickContext): InvestmentClosingTickResult {
    this.assertContext(ctx);
    const completed: Investment[] = [];
    const rejected: InvestmentProposal[] = [];
    for (const proposal of this.proposals.list("agreed")) {
      let prepared: PreparedInvestmentClose;
      try {
        prepared = this.prepare(proposal);
      } catch (error) {
        if (!(error instanceof EngineError) || !isRejectableClosingValidation(error)) {
          throw error;
        }
        rejected.push(this.proposals.rejectAgreed(
          proposal.id,
          validationFailure(error),
          ctx,
        ));
        continue;
      }
      completed.push(this.closePrepared(prepared, ctx));
    }
    return Object.freeze({
      completed: Object.freeze(completed),
      rejected: Object.freeze(rejected),
    });
  }

  close(proposalId: string, ctx: TickContext): Investment {
    this.assertContext(ctx);
    return this.closePrepared(this.prepare(this.proposals.get(proposalId)), ctx);
  }

  get(investmentId: string): Investment {
    const row = this.db.prepare<[string, string], InvestmentRow>(`
      SELECT * FROM investments WHERE run_id = ? AND id = ?
    `).get(this.runId, investmentId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `investment ${investmentId} does not exist`);
    }
    return this.mapInvestment(row);
  }

  list(companyId?: string): readonly Investment[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], InvestmentRow>(`
          SELECT * FROM investments
          WHERE run_id = ? ORDER BY completed_tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], InvestmentRow>(`
          SELECT * FROM investments
          WHERE run_id = ? AND company_id = ? ORDER BY completed_tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => this.mapInvestment(row)));
  }

  capTable(companyId: string): CapTableSnapshot {
    const cap = this.db.prepare<[string, string], CapTableRow>(`
      SELECT company_kind, total_shares FROM company_cap_tables
      WHERE run_id = ? AND company_id = ?
    `).get(this.runId, companyId);
    if (cap === undefined) {
      throw new EngineError("NOT_FOUND", `cap table for company ${companyId} does not exist`);
    }
    const stakes = this.db.prepare<[string, string], OwnershipStakeRow>(`
      SELECT id, company_id, holder_kind, holder_id, shares, acquired_via,
        since_tick, source_event_id
      FROM ownership_stakes
      WHERE run_id = ? AND company_id = ?
      ORDER BY id
    `).all(this.runId, companyId).map((row) => ownershipStakeSchema.parse({
      id: row.id,
      runId: this.runId,
      companyId: row.company_id,
      holderKind: row.holder_kind,
      holderId: row.holder_id,
      shares: row.shares,
      acquiredVia: row.acquired_via,
      sinceTick: toSafeNumber(row.since_tick, "ownership stake tick"),
      sourceEventId: row.source_event_id,
    }));
    const shareSum = stakes.reduce((sum, stake) => sum + BigInt(stake.shares), 0n);
    if (shareSum !== BigInt(cap.total_shares)) {
      throw new EngineError("CONFLICT", `company ${companyId} violates INV-4`, {
        recordedTotalShares: cap.total_shares,
        ownershipStakeShares: shareSum.toString(),
      });
    }
    return capTableSnapshotSchema.parse({
      companyId,
      totalShares: cap.total_shares,
      stakes: stakes.map((stake) => ({
        id: stake.id,
        companyId: stake.companyId,
        holderKind: stake.holderKind,
        holderId: stake.holderId,
        shares: stake.shares,
        acquiredVia: stake.acquiredVia,
        sinceTick: stake.sinceTick,
      })),
    });
  }

  private prepare(proposal: InvestmentProposal): PreparedInvestmentClose {
    if (proposal.status !== "agreed" || proposal.finalTerms === null) {
      throw new EngineError(
        "CONFLICT",
        `investment proposal ${proposal.id} is not ready to close`,
      );
    }
    const duplicate = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM investments WHERE run_id = ? AND proposal_id = ?
    `).get(this.runId, proposal.id);
    if (duplicate !== undefined) {
      throw new EngineError("CONFLICT", `investment proposal ${proposal.id} is already closed`);
    }
    const fund = this.venture.getFund(proposal.fundId);
    if (fund.firmId !== proposal.firmId || fund.status !== "open") {
      throw new EngineError(
        "CONFLICT",
        `investment proposal ${proposal.id} requires its open negotiated fund`,
      );
    }
    quoteVentureFundDeployment(fund, proposal.finalTerms.amountCents);
    const capTableBefore = this.capTable(proposal.companyId);
    const quote = quotePricedRound({
      totalSharesBefore: capTableBefore.totalShares,
      amountCents: proposal.finalTerms.amountCents,
      preMoneyValuationCents: proposal.finalTerms.preMoneyValuationCents,
      equityBasisPoints: proposal.finalTerms.equityBasisPoints,
    });
    this.assertCompanyCanIssue(proposal.companyId);
    this.assertFundAccount(fund);
    const companyAccountId = this.companyCheckingAccount(proposal.companyId);
    return Object.freeze({ proposal, fund, quote, capTableBefore, companyAccountId });
  }

  private closePrepared(
    prepared: PreparedInvestmentClose,
    ctx: TickContext,
  ): Investment {
    return this.atomic(() => {
      const current = this.prepare(this.proposals.get(prepared.proposal.id));
      const proposal = current.proposal;
      const fund = current.fund;
      const quote = current.quote;
      const capTableBefore = current.capTableBefore;
      const investmentId = ctx.ids.next("inv");
      const contractId = ctx.ids.next("ctr");
      const ownershipStakeId = ctx.ids.next("stk");
      const closingRequested = ctx.emit("investment.closing.requested", {
        investmentId,
        proposalId: proposal.id,
        companyId: proposal.companyId,
        investorId: fund.id,
        amountCents: quote.amountCents,
        evidence: evidence([proposal.sourceEventId, proposal.lastTransitionEventId]),
      }, {
        actor: { kind: "institution", id: proposal.firmId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: proposal.lastTransitionEventId,
      });

      const contract = createContractFromTemplate({
        id: contractId,
        runId: this.runId,
        type: "investment",
        parties: [
          { kind: "company", id: proposal.companyId, role: "issuer" },
          { kind: "institution", id: proposal.firmId, role: "investor" },
        ],
        terms: {
          template: "investment",
          proposalId: proposal.id,
          companyId: proposal.companyId,
          investorFundId: fund.id,
          investorFirmId: proposal.firmId,
          amountCents: quote.amountCents,
          preMoneyValuationCents: quote.preMoneyValuationCents,
          pricePerShareCents: quote.pricePerShareCents,
          sharesIssued: quote.sharesIssued,
          totalSharesBefore: quote.totalSharesBefore,
          totalSharesAfter: quote.totalSharesAfter,
        },
        draftedBy: { kind: "institution", id: proposal.firmId },
        feeCents: "0",
        createdTick: ctx.tick,
        effectiveTick: ctx.tick,
        ids: ctx.ids,
      });
      this.phase4.insertLegalContract(contract, ctx.ids);
      const drafted = ctx.emit("contract.drafted", {
        contractId,
        type: "investment",
        proposalId: proposal.id,
        companyId: proposal.companyId,
        investorFundId: fund.id,
        evidence: evidence([closingRequested.eventId]),
      }, {
        actor: { kind: "institution", id: proposal.firmId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: closingRequested.eventId,
      });
      this.phase4.signContract(
        contractId,
        { kind: "company", id: proposal.companyId },
        ctx.tick,
        ctx.ids,
      );
      const issuerSigned = ctx.emit("contract.signature.recorded", {
        contractId,
        party: { kind: "company", id: proposal.companyId },
        status: "draft",
        evidence: evidence([drafted.eventId]),
      }, {
        actor: { kind: "agent", id: proposal.founderAgentId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: drafted.eventId,
      });
      const signedContract = this.phase4.signContract(
        contractId,
        { kind: "institution", id: proposal.firmId },
        ctx.tick,
        ctx.ids,
      );
      const contractSigned = ctx.emit("contract.signed", {
        contractId,
        type: "investment",
        status: signedContract.status,
        proposalId: proposal.id,
        evidence: evidence([drafted.eventId, issuerSigned.eventId]),
      }, {
        actor: { kind: "institution", id: proposal.firmId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: issuerSigned.eventId,
      });

      const amount = BigInt(quote.amountCents);
      const fundBalance = this.finance.accountBalance(fund.bankAccountId);
      const shortfall = amount > fundBalance ? amount - fundBalance : 0n;
      let capitalCallTransactionId: string | null = null;
      let cashCausationId = contractSigned.eventId;
      let capitalCallPostedEventId: string | null = null;
      if (shortfall > 0n) {
        const capitalCallRequested = ctx.emit("venture.fund.capital_call.requested", {
          proposalId: proposal.id,
          fundId: fund.id,
          accountId: fund.bankAccountId,
          amountCents: shortfall.toString(),
          evidence: evidence([fund.sourceEventId, contractSigned.eventId]),
        }, {
          actor: { kind: "institution", id: proposal.firmId },
          schemaVersion: 1,
          correlationId: proposal.id,
          causationId: contractSigned.eventId,
        });
        const row = this.finance.systemAccount("system_row", "row_riverbend");
        const capitalCall = ledgerTransactionSchema.parse({
          id: ctx.ids.next("txn"),
          runId: this.runId,
          tick: ctx.tick,
          kind: "row_settlement",
          actor: { kind: "system", id: "investment-closing" },
          reason: "venture.fund.capital_call",
          sourceEventId: capitalCallRequested.eventId,
          correlationId: proposal.id,
          idempotencyKey: `investment-capital-call:${proposal.id}`,
          legs: [
            {
              accountId: fund.bankAccountId,
              direction: "debit",
              amountCents: shortfall.toString(),
            },
            {
              accountId: row.id,
              direction: "credit",
              amountCents: shortfall.toString(),
            },
          ],
        });
        this.finance.post(capitalCall);
        ctx.count("transactions");
        capitalCallTransactionId = capitalCall.id;
        capitalCallPostedEventId = this.emitTransactionPosted(
          capitalCall,
          capitalCallRequested.eventId,
          ctx,
        );
        cashCausationId = capitalCallPostedEventId;
      }

      const cashRequested = ctx.emit("investment.cash_transfer.requested", {
        proposalId: proposal.id,
        fundId: fund.id,
        companyId: proposal.companyId,
        amountCents: quote.amountCents,
        evidence: evidence([contractSigned.eventId, capitalCallPostedEventId]),
      }, {
        actor: { kind: "institution", id: proposal.firmId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: cashCausationId,
      });
      const cashTransfer = ledgerTransactionSchema.parse({
        id: ctx.ids.next("txn"),
        runId: this.runId,
        tick: ctx.tick,
        kind: "transfer",
        actor: { kind: "institution", id: proposal.firmId },
        reason: "investment.priced_round",
        sourceEventId: cashRequested.eventId,
        correlationId: proposal.id,
        idempotencyKey: `investment-close:${proposal.id}`,
        legs: [
          {
            accountId: fund.bankAccountId,
            direction: "credit",
            amountCents: quote.amountCents,
          },
          {
            accountId: current.companyAccountId,
            direction: "debit",
            amountCents: quote.amountCents,
          },
        ],
      });
      this.finance.post(cashTransfer);
      ctx.count("transactions");
      const cashPostedEventId = this.emitTransactionPosted(
        cashTransfer,
        cashRequested.eventId,
        ctx,
      );
      const deployed = this.venture.deployCapital({
        fundId: fund.id,
        targetCompanyId: proposal.companyId,
        referenceId: proposal.id,
        amountCents: quote.amountCents,
        causationId: cashPostedEventId,
        evidenceRefs: evidence([
          proposal.lastTransitionEventId,
          contractSigned.eventId,
          cashPostedEventId,
        ]),
      }, ctx);

      const pendingStake = ownershipStakeSchema.parse({
        id: ownershipStakeId,
        runId: this.runId,
        companyId: proposal.companyId,
        holderKind: "venture_fund",
        holderId: fund.id,
        shares: quote.sharesIssued,
        acquiredVia: "investment",
        sinceTick: ctx.tick,
        sourceEventId: null,
      });
      const capTableAfter = this.capTableAfter(capTableBefore, pendingStake, quote);
      const completedPayload = investmentCompletedPayloadSchema.parse({
        investmentId,
        proposalId: proposal.id,
        companyId: proposal.companyId,
        investorId: fund.id,
        firmId: proposal.firmId,
        amountCents: quote.amountCents,
        preMoneyValuationCents: quote.preMoneyValuationCents,
        sharesIssued: quote.sharesIssued,
        pricePerShareCents: quote.pricePerShareCents,
        transactionId: cashTransfer.id,
        capitalCallTransactionId,
        contractId,
        ownershipStakeId,
        completedTick: ctx.tick,
        capTableBefore,
        capTableAfter,
        evidence: evidence([
          proposal.sourceEventId,
          proposal.lastTransitionEventId,
          contractSigned.eventId,
          capitalCallPostedEventId,
          cashPostedEventId,
          deployed.deployment.sourceEventId,
        ]),
      });
      const completedEvent = ctx.emit("investment.completed", completedPayload, {
        actor: { kind: "institution", id: proposal.firmId },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: deployed.deployment.sourceEventId,
      });
      const issuedStake = ownershipStakeSchema.parse({
        ...pendingStake,
        sourceEventId: completedEvent.eventId,
      });
      this.insertOwnershipStake(issuedStake);
      const capUpdated = this.db.prepare(`
        UPDATE company_cap_tables
        SET total_shares = @totalSharesAfter, revision = revision + 1,
          last_event_id = @eventId
        WHERE run_id = @runId AND company_id = @companyId
          AND total_shares = @totalSharesBefore
      `).run({
        runId: this.runId,
        companyId: proposal.companyId,
        totalSharesBefore: quote.totalSharesBefore,
        totalSharesAfter: quote.totalSharesAfter,
        eventId: completedEvent.eventId,
      });
      if (capUpdated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale cap table for ${proposal.companyId}`);
      }
      const proposalUpdated = this.db.prepare(`
        UPDATE investment_proposals
        SET status = 'completed', revision = revision + 1,
          last_transition_event_id = @eventId
        WHERE run_id = @runId AND id = @proposalId AND status = 'agreed'
          AND last_transition_event_id = @agreementEventId
      `).run({
        runId: this.runId,
        proposalId: proposal.id,
        eventId: completedEvent.eventId,
        agreementEventId: proposal.lastTransitionEventId,
      });
      if (proposalUpdated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale investment proposal ${proposal.id}`);
      }
      const investment = investmentSchema.parse({
        id: investmentId,
        runId: this.runId,
        proposalId: proposal.id,
        companyId: proposal.companyId,
        investorId: fund.id,
        firmId: proposal.firmId,
        amountCents: quote.amountCents,
        preMoneyValuationCents: quote.preMoneyValuationCents,
        sharesIssued: quote.sharesIssued,
        totalSharesBefore: quote.totalSharesBefore,
        totalSharesAfter: quote.totalSharesAfter,
        pricePerShareCents: quote.pricePerShareCents,
        transactionId: cashTransfer.id,
        capitalCallTransactionId,
        contractId,
        ownershipStakeId,
        completedTick: ctx.tick,
        sourceEventId: completedEvent.eventId,
      });
      this.insertInvestment(investment);
      return investment;
    });
  }

  private capTableAfter(
    before: CapTableSnapshot,
    stake: OwnershipStake,
    quote: PricedRoundQuote,
  ): CapTableSnapshot {
    const added = {
      id: stake.id,
      companyId: stake.companyId,
      holderKind: stake.holderKind,
      holderId: stake.holderId,
      shares: stake.shares,
      acquiredVia: stake.acquiredVia,
      sinceTick: stake.sinceTick,
    };
    const stakes = [...before.stakes, added]
      .sort((left, right) => compareCodeUnit(left.id, right.id));
    return capTableSnapshotSchema.parse({
      companyId: before.companyId,
      totalShares: quote.totalSharesAfter,
      stakes,
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

  private assertCompanyCanIssue(companyId: string): void {
    const row = this.db.prepare<[string, string], { company_kind: string }>(`
      SELECT cap.company_kind FROM company_cap_tables cap
      WHERE cap.run_id = ? AND cap.company_id = ? AND (
        cap.company_kind = 'opening' OR EXISTS (
          SELECT 1 FROM companies company
          WHERE company.run_id = cap.run_id AND company.id = cap.company_id
            AND company.status = 'active'
        )
      )
    `).get(this.runId, companyId);
    if (row === undefined) {
      throw new EngineError("CONFLICT", `company ${companyId} cannot issue investment shares`);
    }
  }

  private assertFundAccount(fund: VentureFund): void {
    const row = this.db.prepare<[string, string, string], { id: string }>(`
      SELECT account.id
      FROM vc_fund_accounts link
      JOIN bank_accounts account
        ON account.run_id = link.run_id AND account.id = link.account_id
      WHERE link.run_id = ? AND link.fund_id = ? AND link.account_id = ?
        AND account.status = 'active' AND account.account_type = 'checking'
    `).get(this.runId, fund.id, fund.bankAccountId);
    if (row === undefined) {
      throw new EngineError("CONFLICT", `venture fund ${fund.id} lacks its active cash account`);
    }
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

  private insertOwnershipStake(stake: OwnershipStake): void {
    this.db.prepare(`
      INSERT INTO ownership_stakes(
        run_id, id, company_id, holder_kind, holder_id, shares,
        acquired_via, since_tick, source_event_id
      ) VALUES (
        @runId, @id, @companyId, @holderKind, @holderId, @shares,
        @acquiredVia, @sinceTick, @sourceEventId
      )
    `).run(stake);
  }

  private insertInvestment(investment: Investment): void {
    this.db.prepare(`
      INSERT INTO investments(
        run_id, id, proposal_id, company_id, investor_id, firm_id,
        amount_cents, pre_money_valuation_cents, shares_issued,
        total_shares_before, total_shares_after, price_per_share_cents,
        transaction_id, capital_call_transaction_id, contract_id,
        ownership_stake_id, completed_tick, source_event_id
      ) VALUES (
        @runId, @id, @proposalId, @companyId, @investorId, @firmId,
        @amountCents, @preMoneyValuationCents, @sharesIssued,
        @totalSharesBefore, @totalSharesAfter, @pricePerShareCents,
        @transactionId, @capitalCallTransactionId, @contractId,
        @ownershipStakeId, @completedTick, @sourceEventId
      )
    `).run(investment);
  }

  private mapInvestment(row: InvestmentRow): Investment {
    return investmentSchema.parse({
      id: row.id,
      runId: row.run_id,
      proposalId: row.proposal_id,
      companyId: row.company_id,
      investorId: row.investor_id,
      firmId: row.firm_id,
      amountCents: row.amount_cents,
      preMoneyValuationCents: row.pre_money_valuation_cents,
      sharesIssued: row.shares_issued,
      totalSharesBefore: row.total_shares_before,
      totalSharesAfter: row.total_shares_after,
      pricePerShareCents: row.price_per_share_cents,
      transactionId: row.transaction_id,
      capitalCallTransactionId: row.capital_call_transaction_id,
      contractId: row.contract_id,
      ownershipStakeId: row.ownership_stake_id,
      completedTick: toSafeNumber(row.completed_tick, "investment completed tick"),
      sourceEventId: row.source_event_id,
    });
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "investment context belongs to another run");
    }
  }

  private atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
