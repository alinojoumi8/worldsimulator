/** WS-607 one-shot binding of bounded conversation outcomes to domain state. */

import {
  termsWithinConversationBounds,
  type TickContext,
} from "@worldtangle/engine";
import {
  canonicalParse,
  canonicalStringify,
  conversationBindingSchema,
  EngineError,
  ledgerTransactionSchema,
} from "@worldtangle/shared";
import type {
  Conversation,
  ConversationBinding,
  ConversationBindingRejectionReason,
  ConversationStructuredTerms,
} from "@worldtangle/shared";
import type { WorldDatabase } from "./database";
import { toSafeNumber } from "./database";
import { SqliteConversationStore } from "./conversation-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";

interface BindingRow {
  run_id: string;
  id: string;
  conversation_id: string;
  topic: "purchase" | "job";
  status: "bound" | "rejected";
  structured_terms_canonical: string | null;
  domain_reference_id: string;
  result_kind: "goods_order" | "employment" | null;
  result_id: string | null;
  rejection_reason: ConversationBindingRejectionReason | null;
  binding_tick: bigint;
  evidence_event_ids_canonical: string;
  source_event_id: string;
}

interface TerminalRow {
  terminal_event_id: string | null;
}

export interface OpenPurchaseNegotiationInput {
  readonly buyerAgentId: string;
  readonly offeringId: string;
  readonly maximumQuantity: number;
  readonly initiatingTriggerEventId: string;
  readonly outputTokenBudget?: number;
}

export interface OpenJobNegotiationInput {
  readonly applicationId: string;
  readonly initiatingTriggerEventId: string;
  readonly outputTokenBudget?: number;
}

const SYSTEM_ACTOR = { kind: "system", id: "engine" } as const;
const MARKET_ACTOR = { kind: "system", id: "goods_market" } as const;

function parseEventIds(value: string): readonly string[] {
  const parsed = canonicalParse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new EngineError("INTERNAL", "conversation binding evidence is not a string array");
  }
  return Object.freeze([...parsed]);
}

function mapBinding(row: BindingRow): ConversationBinding {
  return conversationBindingSchema.parse({
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    topic: row.topic,
    status: row.status,
    structuredTerms: row.structured_terms_canonical === null
      ? null
      : canonicalParse(row.structured_terms_canonical),
    domainReferenceId: row.domain_reference_id,
    resultKind: row.result_kind,
    resultId: row.result_id,
    rejectionReason: row.rejection_reason,
    bindingTick: toSafeNumber(row.binding_tick, "conversation binding tick"),
    evidenceEventIds: parseEventIds(row.evidence_event_ids_canonical),
    sourceEventId: row.source_event_id,
  });
}

function uniqueEventIds(eventIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(eventIds)]);
}

export class SqliteNegotiationStore {
  private readonly conversations: SqliteConversationStore;
  private readonly finance: SqliteFinanceStore;
  private readonly market: SqliteMarketStore;
  private readonly phase4: SqlitePhase4Store;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.conversations = new SqliteConversationStore(db, runId);
    this.finance = new SqliteFinanceStore(db, runId);
    this.market = new SqliteMarketStore(db, runId);
    this.phase4 = new SqlitePhase4Store(db, runId);
  }

  openPurchase(input: OpenPurchaseNegotiationInput, ctx: TickContext): Conversation {
    if (!Number.isSafeInteger(input.maximumQuantity) || input.maximumQuantity < 1) {
      throw new EngineError("VALIDATION_FAILED", "maximum negotiated quantity must be positive");
    }
    this.finance.accountForAgent(input.buyerAgentId);
    const quote = this.market.getActiveOfferingQuote(input.offeringId, ctx.tick);
    if (quote.inventory.quantity < 1) {
      throw new EngineError("CONFLICT", `offering ${input.offeringId} has no inventory`);
    }
    const company = this.phase4.getCompany(quote.offering.companyId);
    const maximumQuantity = Math.min(input.maximumQuantity, quote.inventory.quantity);
    if (BigInt(quote.inventory.averageUnitCostCents) > BigInt(quote.offering.postedPriceCents)) {
      throw new EngineError("CONFLICT", "offering has no valid negotiated price envelope");
    }
    return this.conversations.open({
      participantAgentIds: [input.buyerAgentId, company.founderAgentId],
      topic: "purchase",
      initiatingTriggerEventId: input.initiatingTriggerEventId,
      termBounds: {
        kind: "purchase",
        referenceId: quote.offering.id,
        minQuantity: 1,
        maxQuantity: maximumQuantity,
        minUnitPriceCents: quote.inventory.averageUnitCostCents,
        maxUnitPriceCents: quote.offering.postedPriceCents,
      },
      maxTurns: 6,
      outputTokenBudget: input.outputTokenBudget ?? 4_096,
      startTick: ctx.tick,
    }, ctx);
  }

  openJob(input: OpenJobNegotiationInput, ctx: TickContext): Conversation {
    const candidate = this.phase4.getLaborNegotiationCandidate(input.applicationId, ctx.tick);
    if (
      BigInt(candidate.application.reservationWageCents) >
      BigInt(candidate.job.annualWageCents)
    ) {
      throw new EngineError("CONFLICT", "job has no valid negotiated wage envelope");
    }
    return this.conversations.open({
      participantAgentIds: [candidate.application.agentId, candidate.founderAgentId],
      topic: "job",
      initiatingTriggerEventId: input.initiatingTriggerEventId,
      termBounds: {
        kind: "job",
        referenceId: candidate.application.id,
        minAnnualWageCents: candidate.application.reservationWageCents,
        maxAnnualWageCents: candidate.job.annualWageCents,
      },
      maxTurns: 6,
      outputTokenBudget: input.outputTokenBudget ?? 4_096,
      startTick: ctx.tick,
    }, ctx);
  }

  get(bindingId: string): ConversationBinding {
    const row = this.db.prepare<[string, string], BindingRow>(`
      SELECT * FROM conversation_bindings WHERE run_id = ? AND id = ?
    `).get(this.runId, bindingId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `conversation binding ${bindingId} does not exist`);
    }
    return mapBinding(row);
  }

  getForConversation(conversationId: string): ConversationBinding | undefined {
    const row = this.db.prepare<[string, string], BindingRow>(`
      SELECT * FROM conversation_bindings WHERE run_id = ? AND conversation_id = ?
    `).get(this.runId, conversationId);
    return row === undefined ? undefined : mapBinding(row);
  }

  list(): readonly ConversationBinding[] {
    return Object.freeze(this.db.prepare<[string], BindingRow>(`
      SELECT * FROM conversation_bindings
      WHERE run_id = ? ORDER BY binding_tick, id
    `).all(this.runId).map(mapBinding));
  }

  bindPending(ctx: TickContext): readonly ConversationBinding[] {
    const conversationIds = this.db.prepare<[string], { id: string }>(`
      SELECT c.id
      FROM conversations c
      LEFT JOIN conversation_bindings b
        ON b.run_id = c.run_id AND b.conversation_id = c.id
      WHERE c.run_id = ? AND c.status <> 'active' AND b.id IS NULL
      ORDER BY c.end_tick, c.id
    `).all(this.runId).map((row) => row.id);
    return Object.freeze(conversationIds.map((conversationId) => this.bind(
      conversationId,
      ctx,
    )));
  }

  bind(conversationId: string, ctx: TickContext): ConversationBinding {
    const existing = this.getForConversation(conversationId);
    if (existing !== undefined) return existing;
    const conversation = this.conversations.get(conversationId);
    if (conversation.status === "active" || conversation.outcome === null) {
      throw new EngineError("CONFLICT", `conversation ${conversationId} is not terminal`);
    }
    const terminal = this.db.prepare<[string, string], TerminalRow>(`
      SELECT terminal_event_id FROM conversations WHERE run_id = ? AND id = ?
    `).get(this.runId, conversationId)?.terminal_event_id;
    if (terminal === undefined || terminal === null) {
      throw new EngineError("INTERNAL", `conversation ${conversationId} lacks terminal evidence`);
    }
    const bindingId = ctx.ids.next("cnb");
    const terms = conversation.outcome.structuredTerms;
    if (conversation.outcome.kind !== "agreement" || terms === null) {
      return this.recordRejected(
        bindingId,
        conversation,
        null,
        "not_agreement",
        [terminal],
        terminal,
        ctx,
      );
    }
    if (
      terms.kind !== conversation.topic ||
      terms.referenceId !== conversation.termBounds.referenceId ||
      !termsWithinConversationBounds(conversation.termBounds, terms)
    ) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "terms_mismatch",
        [terminal],
        terminal,
        ctx,
      );
    }
    return terms.kind === "purchase"
      ? this.bindPurchase(bindingId, conversation, terms, terminal, ctx)
      : this.bindJob(bindingId, conversation, terms, terminal, ctx);
  }

  private bindPurchase(
    bindingId: string,
    conversation: Conversation,
    terms: Extract<ConversationStructuredTerms, { kind: "purchase" }>,
    terminalEventId: string,
    ctx: TickContext,
  ): ConversationBinding {
    let quote;
    try {
      quote = this.market.getActiveOfferingQuote(terms.referenceId, ctx.tick);
    } catch (error) {
      if (error instanceof EngineError) {
        return this.recordRejected(
          bindingId,
          conversation,
          terms,
          "inactive_offering",
          [terminalEventId],
          terminalEventId,
          ctx,
        );
      }
      throw error;
    }
    const buyerAgentId = conversation.participantAgentIds[0]!;
    const sellerFounderId = conversation.participantAgentIds[1]!;
    const company = this.phase4.getCompany(quote.offering.companyId);
    if (company.founderAgentId !== sellerFounderId) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "participant_mismatch",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    let buyerAccount;
    try {
      buyerAccount = this.finance.accountForAgent(buyerAgentId);
    } catch (error) {
      if (error instanceof EngineError) {
        return this.recordRejected(
          bindingId,
          conversation,
          terms,
          "invalid_buyer",
          [terminalEventId],
          terminalEventId,
          ctx,
        );
      }
      throw error;
    }
    if (
      BigInt(terms.unitPriceCents) < BigInt(quote.inventory.averageUnitCostCents) ||
      BigInt(terms.unitPriceCents) > BigInt(quote.offering.postedPriceCents)
    ) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "price_changed",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    if (quote.inventory.quantity < terms.quantity) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "stockout",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    const totalCents = BigInt(terms.unitPriceCents) * BigInt(terms.quantity);
    if (BigInt(buyerAccount.balanceCents) < totalCents) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "insufficient_funds",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    const placement = this.market.placeNegotiatedOrder({
      buyerKind: "agent",
      buyerId: buyerAgentId,
      buyerAccountIds: [buyerAccount.id],
      sellerId: quote.offering.companyId,
      offeringId: quote.offering.id,
      sku: quote.offering.sku,
      quantity: terms.quantity,
      expectedUnitPriceCents: terms.unitPriceCents,
      tick: ctx.tick,
      requestEventId: terminalEventId,
      ids: ctx.ids,
    }, conversation.id);
    const created = ctx.emit("market.order.created", {
      orderId: placement.order.id,
      buyerKind: placement.order.buyerKind,
      buyerId: placement.order.buyerId,
      sellerId: placement.order.sellerId,
      offeringId: placement.order.offeringId,
      sku: placement.order.sku,
      requestedQuantity: placement.order.requestedQuantity,
      unitPriceCents: placement.order.unitPriceCents,
      totalCents: placement.order.totalCents,
      conversationId: conversation.id,
      negotiationBindingId: bindingId,
    }, {
      actor: { kind: "agent", id: buyerAgentId },
      correlationId: conversation.id,
      causationId: terminalEventId,
    });
    if (placement.order.status === "rejected") {
      const rejected = ctx.emit("market.order.rejected", {
        orderId: placement.order.id,
        rejectionReason: placement.order.rejectionReason,
        conversationId: conversation.id,
      }, {
        correlationId: conversation.id,
        causationId: created.eventId,
      });
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        placement.order.rejectionReason ?? "inactive_offering",
        [terminalEventId, created.eventId, rejected.eventId],
        rejected.eventId,
        ctx,
      );
    }
    let transactionEventId: string | undefined;
    const settlement = this.market.settleNegotiatedOrder(
      placement.order.id,
      conversation.id,
      ctx.tick,
      ctx.ids,
      (payment) => {
        const transaction = ledgerTransactionSchema.parse({
          id: ctx.ids.next("txn"),
          runId: ctx.runId,
          tick: ctx.tick,
          kind: "purchase",
          actor: MARKET_ACTOR,
          reason: "conversation.purchase",
          sourceEventId: created.eventId,
          correlationId: conversation.id,
          idempotencyKey: `negotiation:${conversation.id}`,
          legs: [
            {
              accountId: payment.sellerAccountId,
              direction: "debit",
              amountCents: payment.totalCents,
            },
            {
              accountId: buyerAccount.id,
              direction: "credit",
              amountCents: payment.totalCents,
            },
          ],
        });
        const posted = this.finance.post(transaction);
        if (posted.duplicate) {
          throw new EngineError("CONFLICT", `purchase for ${conversation.id} was already posted`);
        }
        ctx.count("transactions");
        transactionEventId = ctx.emit("transaction.posted", {
          transactionId: transaction.id,
          kind: transaction.kind,
          legs: transaction.legs,
          reason: transaction.reason,
          sourceEventId: transaction.sourceEventId,
          correlationId: transaction.correlationId,
        }, {
          correlationId: conversation.id,
          causationId: created.eventId,
        }).eventId;
        return { transactionId: transaction.id, sourceEventId: created.eventId };
      },
    );
    if (settlement.order.status === "rejected") {
      const rejected = ctx.emit("market.order.rejected", {
        orderId: settlement.order.id,
        rejectionReason: settlement.order.rejectionReason,
        conversationId: conversation.id,
      }, {
        correlationId: conversation.id,
        causationId: created.eventId,
      });
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        settlement.order.rejectionReason ?? "inactive_offering",
        [terminalEventId, created.eventId, rejected.eventId],
        rejected.eventId,
        ctx,
      );
    }
    const inventory = ctx.emit("inventory.decreased", {
      inventoryId: quote.inventory.id,
      movementId: settlement.inventoryMovementId,
      companyId: settlement.order.sellerId,
      sku: settlement.order.sku,
      quantityDelta: -settlement.order.filledQuantity,
      quantityAfter: settlement.inventoryAfter,
      sourceRef: settlement.order.id,
      conversationId: conversation.id,
    }, {
      correlationId: conversation.id,
      causationId: created.eventId,
    });
    const filled = ctx.emit("market.order.filled", {
      orderId: settlement.order.id,
      buyerKind: settlement.order.buyerKind,
      buyerId: settlement.order.buyerId,
      sellerId: settlement.order.sellerId,
      sku: settlement.order.sku,
      quantity: settlement.order.filledQuantity,
      unitPriceCents: settlement.order.unitPriceCents,
      totalCents: settlement.order.totalCents,
      transactionId: settlement.order.settlementTransactionId,
      inventoryAfter: settlement.inventoryAfter,
      conversationId: conversation.id,
      negotiationBindingId: bindingId,
    }, {
      correlationId: conversation.id,
      causationId: inventory.eventId,
    });
    return this.recordBound(
      bindingId,
      conversation,
      terms,
      "goods_order",
      settlement.order.id,
      uniqueEventIds([
        terminalEventId,
        created.eventId,
        ...(transactionEventId === undefined ? [] : [transactionEventId]),
        inventory.eventId,
        filled.eventId,
      ]),
      filled.eventId,
      ctx,
    );
  }

  private bindJob(
    bindingId: string,
    conversation: Conversation,
    terms: Extract<ConversationStructuredTerms, { kind: "job" }>,
    terminalEventId: string,
    ctx: TickContext,
  ): ConversationBinding {
    let candidate;
    try {
      candidate = this.phase4.getLaborNegotiationCandidate(terms.referenceId, ctx.tick);
    } catch (error) {
      if (error instanceof EngineError) {
        return this.recordRejected(
          bindingId,
          conversation,
          terms,
          "application_unavailable",
          [terminalEventId],
          terminalEventId,
          ctx,
        );
      }
      throw error;
    }
    if (
      conversation.participantAgentIds[0] !== candidate.application.agentId ||
      conversation.participantAgentIds[1] !== candidate.founderAgentId
    ) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "participant_mismatch",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    const wage = BigInt(terms.annualWageCents);
    if (
      wage < BigInt(candidate.application.reservationWageCents) ||
      wage > BigInt(candidate.job.annualWageCents)
    ) {
      return this.recordRejected(
        bindingId,
        conversation,
        terms,
        "wage_out_of_bounds",
        [terminalEventId],
        terminalEventId,
        ctx,
      );
    }
    let hired;
    try {
      hired = this.phase4.hireNegotiatedApplication({
        conversationId: conversation.id,
        bindingId,
        applicationId: candidate.application.id,
        founderAgentId: candidate.founderAgentId,
        applicantAgentId: candidate.application.agentId,
        annualWageCents: terms.annualWageCents,
        sourceEventId: terminalEventId,
      }, ctx);
    } catch (error) {
      if (error instanceof EngineError) {
        return this.recordRejected(
          bindingId,
          conversation,
          terms,
          error.code === "VALIDATION_FAILED" ? "wage_out_of_bounds" : "vacancy_unavailable",
          [terminalEventId],
          terminalEventId,
          ctx,
        );
      }
      throw error;
    }
    return this.recordBound(
      bindingId,
      conversation,
      terms,
      "employment",
      hired.employmentContractId,
      uniqueEventIds([terminalEventId, ...hired.eventIds]),
      hired.eventIds.at(-1) ?? terminalEventId,
      ctx,
    );
  }

  private recordBound(
    bindingId: string,
    conversation: Conversation,
    terms: ConversationStructuredTerms,
    resultKind: "goods_order" | "employment",
    resultId: string,
    evidenceEventIds: readonly string[],
    causationId: string,
    ctx: TickContext,
  ): ConversationBinding {
    const completed = ctx.emit("conversation.binding.completed", {
      schemaVersion: 1,
      bindingId,
      conversationId: conversation.id,
      topic: conversation.topic,
      structuredTerms: terms,
      resultKind,
      resultId,
      evidenceEventIds,
    }, {
      actor: SYSTEM_ACTOR,
      schemaVersion: 1,
      correlationId: conversation.id,
      causationId,
    });
    return this.insert({
      id: bindingId,
      runId: this.runId,
      conversationId: conversation.id,
      topic: conversation.topic,
      status: "bound",
      structuredTerms: terms,
      domainReferenceId: terms.referenceId,
      resultKind,
      resultId,
      rejectionReason: null,
      bindingTick: ctx.tick,
      evidenceEventIds: [...uniqueEventIds([...evidenceEventIds, completed.eventId])],
      sourceEventId: completed.eventId,
    });
  }

  private recordRejected(
    bindingId: string,
    conversation: Conversation,
    terms: ConversationStructuredTerms | null,
    rejectionReason: ConversationBindingRejectionReason,
    evidenceEventIds: readonly string[],
    causationId: string,
    ctx: TickContext,
  ): ConversationBinding {
    const rejected = ctx.emit("conversation.binding.rejected", {
      schemaVersion: 1,
      bindingId,
      conversationId: conversation.id,
      topic: conversation.topic,
      structuredTerms: terms,
      rejectionReason,
      evidenceEventIds,
    }, {
      actor: SYSTEM_ACTOR,
      schemaVersion: 1,
      correlationId: conversation.id,
      causationId,
    });
    return this.insert({
      id: bindingId,
      runId: this.runId,
      conversationId: conversation.id,
      topic: conversation.topic,
      status: "rejected",
      structuredTerms: terms,
      domainReferenceId: terms?.referenceId ?? conversation.termBounds.referenceId,
      resultKind: null,
      resultId: null,
      rejectionReason,
      bindingTick: ctx.tick,
      evidenceEventIds: [...uniqueEventIds([...evidenceEventIds, rejected.eventId])],
      sourceEventId: rejected.eventId,
    });
  }

  private insert(bindingValue: ConversationBinding): ConversationBinding {
    const binding = conversationBindingSchema.parse(bindingValue);
    this.db.prepare(`
      INSERT INTO conversation_bindings(
        run_id, id, conversation_id, topic, status, structured_terms_canonical,
        domain_reference_id, result_kind, result_id, rejection_reason,
        binding_tick, evidence_event_ids_canonical, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.runId,
      binding.id,
      binding.conversationId,
      binding.topic,
      binding.status,
      binding.structuredTerms === null ? null : canonicalStringify(binding.structuredTerms),
      binding.domainReferenceId,
      binding.resultKind,
      binding.resultId,
      binding.rejectionReason,
      binding.bindingTick,
      canonicalStringify(binding.evidenceEventIds),
      binding.sourceEventId,
    );
    return binding;
  }
}
