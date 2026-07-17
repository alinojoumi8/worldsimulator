/** Phase 3 deterministic payroll, treasury, household, ROW, and metrics handlers. */

import {
  allocateHouseholdSpending,
  dayOfMonth,
  ECONOMIC_INDICATOR_RULESET_VERSION,
  householdDailyRequests,
  isPayrollDay,
  payrollGrossForPeriod,
  quotePayroll,
  scaleMoneyByBasisPoints,
} from "@worldtangle/engine";
import type { PhaseHandler, TickContext } from "@worldtangle/engine";
import { ledgerTransactionSchema, money, mulDiv } from "@worldtangle/shared";
import type {
  EventEnvelope,
  GoodsOrder,
  LedgerTransaction,
  MarketStockout,
} from "@worldtangle/shared";
import { SqliteFinanceStore } from "./persistence/finance-store";
import { SqliteEnergyStore } from "./persistence/energy-store";
import type {
  ActiveOfferingQuote,
  GoodsOrderPlacement,
} from "./persistence/market-store";
import { SqliteMarketStore } from "./persistence/market-store";
import type { WorldDatabase } from "./persistence/database";
import { SqliteLoanCollectionStore } from "./persistence/loan-collection-store";
import { SqliteWorldEventStore } from "./persistence/world-event-store";

const SYSTEM_ACTOR = { kind: "system", id: "finance" } as const;
const MARKET_ACTOR = { kind: "system", id: "market" } as const;

function periodIndexWithinYear(tick: number): number {
  const dayIndex = (tick - 1) % 360;
  const monthIndex = Math.floor(dayIndex / 30);
  return monthIndex * 2 + (dayOfMonth(tick) === 30 ? 1 : 0);
}

function emitPosted(ctx: TickContext, transaction: LedgerTransaction, duplicate: boolean): void {
  if (duplicate) {
    ctx.emit("transaction.duplicate_ignored", {
      transactionId: transaction.id,
      idempotencyKey: transaction.idempotencyKey,
      warning: "duplicate_idempotency_key_ignored",
    });
    return;
  }
  ctx.count("transactions");
  ctx.emit("transaction.posted", {
    transactionId: transaction.id,
    kind: transaction.kind,
    legs: transaction.legs,
    reason: transaction.reason,
    sourceEventId: transaction.sourceEventId,
    correlationId: transaction.correlationId,
  }, {
    correlationId: transaction.correlationId,
    ...(transaction.sourceEventId === null
      ? {}
      : { causationId: transaction.sourceEventId }),
  });
}

function post(store: SqliteFinanceStore, ctx: TickContext, transaction: LedgerTransaction): void {
  const result = store.post(transaction);
  emitPosted(ctx, result.transaction, result.duplicate);
}

function payrollTransaction(input: {
  readonly ctx: TickContext;
  readonly employerAccountId: string;
  readonly employeeAccountId: string;
  readonly treasuryAccountId: string;
  readonly employeeAgentId: string;
  readonly contractId: string;
  readonly sourceEventId: string;
  readonly grossCents: string;
  readonly withholdingCents: string;
  readonly netCents: string;
}): LedgerTransaction {
  const correlationId = `payroll:${input.ctx.tick}:${input.contractId}`;
  const legs: LedgerTransaction["legs"] = [
    {
      accountId: input.employerAccountId,
      direction: "credit",
      amountCents: input.grossCents,
    },
    {
      accountId: input.employeeAccountId,
      direction: "debit",
      amountCents: input.netCents,
    },
  ];
  if (input.withholdingCents !== "0") {
    legs.push({
      accountId: input.treasuryAccountId,
      direction: "debit",
      amountCents: input.withholdingCents,
    });
  } else {
    // A zero-value leg is prohibited, so gross equals net in the two-leg case.
  }
  return ledgerTransactionSchema.parse({
    id: input.ctx.ids.next("txn"),
    runId: input.ctx.runId,
    tick: input.ctx.tick,
    kind: "payroll",
    actor: SYSTEM_ACTOR,
    reason: "payroll.semi_monthly",
    sourceEventId: input.sourceEventId,
    correlationId,
    idempotencyKey: correlationId,
    legs,
  });
}

function runPayroll(store: SqliteFinanceStore, ctx: TickContext): void {
  if (!isPayrollDay(ctx.tick)) return;
  const periodIndex = periodIndexWithinYear(ctx.tick);
  const withholdingRateBp = Number(store.policyValue("personal_withholding_rate_bp", ctx.tick));
  const treasury = store.systemAccount("government", "inst_town_riverbend");
  const row = store.systemAccount("system_row", "row_riverbend");

  for (const obligation of store.listPayrollObligations()) {
    const quote = quotePayroll(
      money(obligation.annualWageCents),
      periodIndex,
      withholdingRateBp,
    );
    const grossCents = quote.grossCents.toString();
    const correlationId = `payroll:${ctx.tick}:${obligation.contractId}`;
    const dueEvent = ctx.emit("payroll.due", {
      contractId: obligation.contractId,
      employerId: obligation.employerId,
      employeeAgentId: obligation.employeeAgentId,
      grossCents,
    }, { correlationId });

    if (
      obligation.employerOwnerKind === "company" &&
      obligation.employerId.startsWith("inst_") &&
      store.accountBalance(obligation.employerAccountId) < quote.grossCents
    ) {
      const fundingNeeded = quote.grossCents - store.accountBalance(obligation.employerAccountId);
      const funding = ledgerTransactionSchema.parse({
        id: ctx.ids.next("txn"),
        runId: ctx.runId,
        tick: ctx.tick,
        kind: "row_settlement",
        actor: SYSTEM_ACTOR,
        reason: "row.institution_operating_revenue",
        sourceEventId: dueEvent.eventId,
        correlationId,
        idempotencyKey: `${correlationId}:funding`,
        legs: [
          {
            accountId: obligation.employerAccountId,
            direction: "debit",
            amountCents: fundingNeeded.toString(),
          },
          {
            accountId: row.id,
            direction: "credit",
            amountCents: fundingNeeded.toString(),
          },
        ],
      });
      post(store, ctx, funding);
    }

    if (store.accountBalance(obligation.employerAccountId) < quote.grossCents) {
      ctx.emit("payroll.missed", {
        contractId: obligation.contractId,
        employerId: obligation.employerId,
        employeeAgentId: obligation.employeeAgentId,
        grossCents,
        reason: "insufficient_employer_funds",
      }, { correlationId, causationId: dueEvent.eventId });
      continue;
    }

    const transaction = payrollTransaction({
      ctx,
      employerAccountId: obligation.employerAccountId,
      employeeAccountId: obligation.employeeAccountId,
      treasuryAccountId: treasury.id,
      employeeAgentId: obligation.employeeAgentId,
      contractId: obligation.contractId,
      sourceEventId: dueEvent.eventId,
      grossCents,
      withholdingCents: quote.withholdingCents.toString(),
      netCents: quote.netCents.toString(),
    });
    post(store, ctx, transaction);
    if (quote.withholdingCents > 0n) {
      const taxId = ctx.ids.next("tax");
      store.recordTax({
        id: taxId,
        payerId: obligation.employeeAgentId,
        period: ctx.simDate.slice(0, 9),
        baseCents: grossCents,
        rateBp: withholdingRateBp,
        amountCents: quote.withholdingCents.toString(),
        transactionId: transaction.id,
        tick: ctx.tick,
      });
      ctx.emit("tax.collected", {
        taxId,
        payerId: obligation.employeeAgentId,
        transactionId: transaction.id,
        baseCents: grossCents,
        rateBp: withholdingRateBp,
        amountCents: quote.withholdingCents.toString(),
      }, { correlationId, causationId: dueEvent.eventId });
    }
    ctx.emit("payroll.executed", {
      contractId: obligation.contractId,
      employeeAgentId: obligation.employeeAgentId,
      transactionId: transaction.id,
      grossCents,
      withholdingCents: quote.withholdingCents.toString(),
      netCents: quote.netCents.toString(),
    }, { correlationId, causationId: dueEvent.eventId });
  }
}

function runBenefits(store: SqliteFinanceStore, ctx: TickContext): void {
  if (!isPayrollDay(ctx.tick)) return;
  const treasury = store.systemAccount("government", "inst_town_riverbend");
  const annualBenefit = money(store.policyValue("unemployment_benefit_annual_cents", ctx.tick));
  const benefit = payrollGrossForPeriod(annualBenefit, periodIndexWithinYear(ctx.tick));
  for (const unemployed of store.unemployedAgents()) {
    const correlationId = `benefit:${ctx.tick}:${unemployed.agentId}`;
    const dueEvent = ctx.emit("benefit.due", {
      agentId: unemployed.agentId,
      amountCents: benefit.toString(),
    }, { correlationId });
    if (store.accountBalance(treasury.id) < benefit) {
      ctx.emit("benefit.suspended", {
        agentId: unemployed.agentId,
        amountCents: benefit.toString(),
        reason: "treasury_empty",
      }, { correlationId, causationId: dueEvent.eventId });
      continue;
    }
    const transaction = ledgerTransactionSchema.parse({
      id: ctx.ids.next("txn"),
      runId: ctx.runId,
      tick: ctx.tick,
      kind: "benefit",
      actor: SYSTEM_ACTOR,
      reason: "treasury.unemployment_benefit",
      sourceEventId: dueEvent.eventId,
      correlationId,
      idempotencyKey: correlationId,
      legs: [
        { accountId: unemployed.accountId, direction: "debit", amountCents: benefit.toString() },
        { accountId: treasury.id, direction: "credit", amountCents: benefit.toString() },
      ],
    });
    post(store, ctx, transaction);
    ctx.emit("benefit.paid", {
      agentId: unemployed.agentId,
      amountCents: benefit.toString(),
      transactionId: transaction.id,
    }, { correlationId, causationId: dueEvent.eventId });
  }
}

function payerLegs(
  accounts: readonly { readonly accountId: string; readonly balanceCents: string }[],
  amountCents: bigint,
): LedgerTransaction["legs"] {
  let remaining = amountCents;
  const legs: LedgerTransaction["legs"] = [];
  for (const account of accounts) {
    if (remaining === 0n) break;
    const available = BigInt(account.balanceCents);
    const contribution = available < remaining ? available : remaining;
    if (contribution <= 0n) continue;
    legs.push({
      accountId: account.accountId,
      direction: "credit",
      amountCents: contribution.toString(),
    });
    remaining -= contribution;
  }
  return legs;
}

interface HouseholdAccountState {
  readonly accountId: string;
  readonly balanceCents: string;
}

interface LocalMarketSettlement {
  readonly spentCents: bigint;
  readonly transactionIds: readonly string[];
  readonly orderIds: readonly string[];
  readonly currentAccounts: readonly HouseholdAccountState[];
}

function refreshHouseholdAccounts(
  store: SqliteFinanceStore,
  memberAgentIds: readonly string[],
): readonly HouseholdAccountState[] {
  return memberAgentIds.map((agentId) => {
    const account = store.accountForAgent(agentId);
    return { accountId: account.id, balanceCents: account.balanceCents };
  });
}

function emitOrderCreated(
  ctx: TickContext,
  placement: GoodsOrderPlacement,
  correlationId: string,
  requestEventId: string,
): EventEnvelope {
  const order = placement.order;
  return ctx.emit("market.order.created", {
    orderId: order.id,
    buyerKind: order.buyerKind,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
    offeringId: order.offeringId,
    sku: order.sku,
    requestedQuantity: order.requestedQuantity,
    unitPriceCents: order.unitPriceCents,
    totalCents: order.totalCents,
    status: order.status,
  }, { correlationId, causationId: requestEventId });
}

function emitOrderRejected(
  ctx: TickContext,
  order: GoodsOrder,
  stockout: MarketStockout | null,
  correlationId: string,
  orderEventId: string,
): void {
  ctx.emit("market.order.rejected", {
    orderId: order.id,
    buyerKind: order.buyerKind,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
    sku: order.sku,
    requestedQuantity: order.requestedQuantity,
    rejectionReason: order.rejectionReason,
  }, { correlationId, causationId: orderEventId });
  if (stockout !== null) {
    ctx.emit("market.stockout", {
      stockoutId: stockout.id,
      orderId: stockout.orderId,
      offeringId: stockout.offeringId,
      companyId: stockout.companyId,
      sku: stockout.sku,
      buyerKind: stockout.buyerKind,
      buyerId: stockout.buyerId,
      requestedQuantity: stockout.requestedQuantity,
      availableQuantity: stockout.availableQuantity,
      shortageQuantity: stockout.requestedQuantity - stockout.availableQuantity,
    }, { correlationId, causationId: orderEventId });
  }
}

function placeHouseholdOrder(
  market: SqliteMarketStore,
  ctx: TickContext,
  householdId: string,
  accounts: readonly HouseholdAccountState[],
  quote: ActiveOfferingQuote,
  quantity: number,
  requestEventId: string,
): GoodsOrderPlacement {
  return market.placeOrder({
    buyerKind: "household",
    buyerId: householdId,
    buyerAccountIds: accounts.map((account) => account.accountId),
    sellerId: quote.offering.companyId,
    offeringId: quote.offering.id,
    sku: quote.offering.sku,
    quantity,
    expectedUnitPriceCents: quote.offering.postedPriceCents,
    tick: ctx.tick,
    requestEventId,
    ids: ctx.ids,
  });
}

function settleLocalFoodPurchases(input: {
  readonly store: SqliteFinanceStore;
  readonly market: SqliteMarketStore;
  readonly ctx: TickContext;
  readonly householdId: string;
  readonly memberAgentIds: readonly string[];
  readonly approvedCents: bigint;
  readonly requestEventId: string;
  readonly correlationId: string;
  readonly accounts: readonly HouseholdAccountState[];
}): LocalMarketSettlement {
  let remainingCents = input.approvedCents;
  let currentAccounts = input.accounts;
  const transactionIds: string[] = [];
  const orderIds: string[] = [];
  const offerings = input.market.listActiveOfferings("groceries", input.ctx.tick);
  for (const quote of offerings) {
    if (remainingCents <= 0n) break;
    const desiredQuantity = input.market.affordableQuantity(
      remainingCents.toString(),
      quote.offering.postedPriceCents,
    );
    if (desiredQuantity === 0) continue;
    let placement = placeHouseholdOrder(
      input.market,
      input.ctx,
      input.householdId,
      currentAccounts,
      quote,
      desiredQuantity,
      input.requestEventId,
    );
    orderIds.push(placement.order.id);
    let orderEvent = emitOrderCreated(
      input.ctx,
      placement,
      input.correlationId,
      input.requestEventId,
    );
    if (placement.order.status === "rejected") {
      emitOrderRejected(
        input.ctx,
        placement.order,
        placement.stockout,
        input.correlationId,
        orderEvent.eventId,
      );
      if (placement.order.rejectionReason !== "stockout" || placement.availableQuantity === 0) {
        if (placement.order.rejectionReason === "insufficient_funds" ||
          placement.order.rejectionReason === "invalid_buyer") break;
        continue;
      }
      placement = placeHouseholdOrder(
        input.market,
        input.ctx,
        input.householdId,
        currentAccounts,
        quote,
        placement.availableQuantity,
        input.requestEventId,
      );
      orderIds.push(placement.order.id);
      orderEvent = emitOrderCreated(
        input.ctx,
        placement,
        input.correlationId,
        input.requestEventId,
      );
      if (placement.order.status === "rejected") {
        emitOrderRejected(
          input.ctx,
          placement.order,
          placement.stockout,
          input.correlationId,
          orderEvent.eventId,
        );
        continue;
      }
    }
    const settlement = input.market.settleOrder(
      placement.order.id,
      input.ctx.tick,
      input.ctx.ids,
      (payment) => {
        const credits = payerLegs(currentAccounts, BigInt(payment.totalCents));
        const transaction = ledgerTransactionSchema.parse({
          id: input.ctx.ids.next("txn"),
          runId: input.ctx.runId,
          tick: input.ctx.tick,
          kind: "purchase",
          actor: MARKET_ACTOR,
          reason: "household.food",
          sourceEventId: orderEvent.eventId,
          correlationId: input.correlationId,
          idempotencyKey: `market:${payment.order.id}`,
          legs: [
            {
              accountId: payment.sellerAccountId,
              direction: "debit",
              amountCents: payment.totalCents,
            },
            ...credits,
          ],
        });
        post(input.store, input.ctx, transaction);
        return { transactionId: transaction.id, sourceEventId: orderEvent.eventId };
      },
    );
    if (settlement.order.status === "rejected") {
      emitOrderRejected(
        input.ctx,
        settlement.order,
        settlement.stockout,
        input.correlationId,
        orderEvent.eventId,
      );
      continue;
    }
    transactionIds.push(settlement.order.settlementTransactionId!);
    remainingCents -= BigInt(settlement.order.totalCents);
    currentAccounts = refreshHouseholdAccounts(input.store, input.memberAgentIds);
    input.ctx.emit("inventory.decreased", {
      inventoryId: quote.inventory.id,
      movementId: settlement.inventoryMovementId,
      companyId: settlement.order.sellerId,
      sku: settlement.order.sku,
      quantityDelta: -settlement.order.filledQuantity,
      quantityAfter: settlement.inventoryAfter,
      sourceRef: settlement.order.id,
    }, { correlationId: input.correlationId, causationId: orderEvent.eventId });
    input.ctx.emit("market.order.filled", {
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
    }, { correlationId: input.correlationId, causationId: orderEvent.eventId });
  }
  return {
    spentCents: input.approvedCents - remainingCents,
    transactionIds,
    orderIds,
    currentAccounts,
  };
}

function runHouseholdSettlement(
  store: SqliteFinanceStore,
  market: SqliteMarketStore,
  energy: SqliteEnergyStore,
  worldEvents: SqliteWorldEventStore,
  ctx: TickContext,
): void {
  const row = store.systemAccount("system_row", "row_riverbend");
  const baseFoodMonthly = money(store.policyValue("food_monthly_per_person_cents", ctx.tick));
  const baseGroceryReferencePrice = money(
    market.getProduct("groceries").rowReferencePriceCents,
  );
  const groceryReferencePrice = money(
    worldEvents.rowReferencePriceCents("groceries", ctx.tick),
  );
  const demandMultiplierBp = worldEvents.demandMultiplierBp("groceries", ctx.tick);
  const rowPriceAdjustedFoodMonthly = mulDiv(
    baseFoodMonthly,
    groceryReferencePrice,
    baseGroceryReferencePrice,
    "HALF_EVEN",
  );
  const foodMonthly = scaleMoneyByBasisPoints(
    rowPriceAdjustedFoodMonthly,
    demandMultiplierBp,
  );
  const utilitiesMonthly = energy.isInitialized()
    ? money(energy.tariff("household", ctx.tick).priceCents)
    : money(store.policyValue("utilities_monthly_cents", ctx.tick));
  for (const household of store.listHouseholdFinances()) {
    const refreshedAccounts = refreshHouseholdAccounts(store, household.memberAgentIds);
    const available = refreshedAccounts.reduce(
      (sum, account) => sum + BigInt(account.balanceCents),
      0n,
    );
    const requests = householdDailyRequests({
      dayOfMonth: dayOfMonth(ctx.tick),
      dayOfYear: ((ctx.tick - 1) % 360) + 1,
      memberCount: household.memberAgentIds.length,
      housingTier: household.housingTier,
      foodMonthlyPerPersonCents: foodMonthly,
      utilitiesMonthlyCents: utilitiesMonthly,
      annualHouseholdIncomeCents: money(household.annualIncomeCents),
      discretionaryPropensityBp: household.budgetPolicy.discretionaryPropensityBp,
    });
    const allocations = allocateHouseholdSpending(money(available), requests);
    let currentAccounts = refreshedAccounts;
    for (const allocation of allocations) {
      const correlationId = `household:${ctx.tick}:${household.householdId}:${allocation.category}`;
      const requestEvent = ctx.emit("household.purchase.requested", {
        householdId: household.householdId,
        category: allocation.category,
        requestedCents: allocation.requestedCents.toString(),
        ...(allocation.category === "food"
          ? {
              demandMultiplierBp,
              rowReferencePriceCents: groceryReferencePrice.toString(),
            }
          : {}),
      }, { correlationId });
      if (allocation.category === "utilities" && energy.isInitialized()) {
        const bill = energy.settleHouseholdBill(ctx, {
          householdId: household.householdId,
          accountIds: currentAccounts.map((account) => account.accountId),
          evidenceRefs: [requestEvent.eventId],
          causeEventId: requestEvent.eventId,
        });
        if (bill.status === "paid") {
          currentAccounts = refreshHouseholdAccounts(store, household.memberAgentIds);
          ctx.emit("household.purchase.completed", {
            householdId: household.householdId,
            category: allocation.category,
            amountCents: bill.amountCents,
            localAmountCents: bill.amountCents,
            rowAmountCents: "0",
            orderIds: [],
            transactionIds: [bill.transactionId],
            transactionId: bill.transactionId,
            energyBillId: bill.id,
          }, { correlationId, causationId: bill.sourceEventId });
        }
        if (bill.status === "rejected") {
          ctx.emit("financial_stress.triggered", {
            householdId: household.householdId,
            category: allocation.category,
            requestedCents: allocation.requestedCents.toString(),
            paidCents: "0",
            shortfallCents: allocation.requestedCents.toString(),
            energyBillId: bill.id,
          }, { correlationId, causationId: bill.sourceEventId });
        }
        continue;
      }
      if (allocation.approvedCents > 0n) {
        const local = allocation.category === "food"
          ? settleLocalFoodPurchases({
              store,
              market,
              ctx,
              householdId: household.householdId,
              memberAgentIds: household.memberAgentIds,
              approvedCents: allocation.approvedCents,
              requestEventId: requestEvent.eventId,
              correlationId,
              accounts: currentAccounts,
            })
          : {
              spentCents: 0n,
              transactionIds: [] as readonly string[],
              orderIds: [] as readonly string[],
              currentAccounts,
            };
        currentAccounts = local.currentAccounts;
        const rowAmount = allocation.approvedCents - local.spentCents;
        const transactionIds = [...local.transactionIds];
        if (rowAmount > 0n) {
          const credits = payerLegs(currentAccounts, rowAmount);
          const rowIdempotencyKey = local.spentCents === 0n
            ? correlationId
            : `${correlationId}:row`;
          const transaction = ledgerTransactionSchema.parse({
            id: ctx.ids.next("txn"),
            runId: ctx.runId,
            tick: ctx.tick,
            kind: "row_settlement",
            actor: SYSTEM_ACTOR,
            reason: `household.${allocation.category}`,
            sourceEventId: requestEvent.eventId,
            correlationId,
            idempotencyKey: rowIdempotencyKey,
            legs: [
              {
                accountId: row.id,
                direction: "debit",
                amountCents: rowAmount.toString(),
              },
              ...credits,
            ],
          });
          post(store, ctx, transaction);
          transactionIds.push(transaction.id);
          currentAccounts = refreshHouseholdAccounts(store, household.memberAgentIds);
        }
        ctx.emit("household.purchase.completed", {
          householdId: household.householdId,
          category: allocation.category,
          amountCents: allocation.approvedCents.toString(),
          localAmountCents: local.spentCents.toString(),
          rowAmountCents: rowAmount.toString(),
          orderIds: local.orderIds,
          transactionIds,
          transactionId: transactionIds.at(-1),
        }, { correlationId, causationId: requestEvent.eventId });
      }
      if (allocation.essential && allocation.approvedCents < allocation.requestedCents) {
        ctx.emit("financial_stress.triggered", {
          householdId: household.householdId,
          category: allocation.category,
          requestedCents: allocation.requestedCents.toString(),
          paidCents: allocation.approvedCents.toString(),
          shortfallCents: (allocation.requestedCents - allocation.approvedCents).toString(),
        }, { correlationId, causationId: requestEvent.eventId });
      }
    }
  }
}

function recordMetrics(store: SqliteFinanceStore, ctx: TickContext): void {
  const snapshot = store.computeIndicatorSnapshot(ctx.tick);
  const indicators = snapshot.values;
  store.insertIndicatorPoints(ctx.tick, snapshot);
  ctx.setDigestIndicators({
    gdpProxy: indicators.gdp_proxy_cents,
    cpi: indicators.cpi_index,
    m1: indicators.m1_cents,
    averageWage: indicators.average_wage_cents,
    unemploymentRate: indicators.unemployment_rate_bp,
    creditOutstanding: indicators.credit_outstanding_cents,
    defaultRate: indicators.default_rate_bp,
    businessCount: indicators.active_business_count,
    treasuryBalance: indicators.treasury_balance_cents,
    sentimentIndex: indicators.sentiment_index_bp,
  });
  ctx.emit("economic.metrics.updated", {
    rulesetVersion: ECONOMIC_INDICATOR_RULESET_VERSION,
    indicators,
    evidence: snapshot.evidence,
  });
}

export function createFinancePhaseHandlers(
  db: WorldDatabase,
  runId: string,
): readonly { readonly phase: "obligations" | "settlement" | "metrics"; readonly handler: PhaseHandler }[] {
  const store = new SqliteFinanceStore(db, runId);
  const market = new SqliteMarketStore(db, runId);
  const energy = new SqliteEnergyStore(db, runId);
  const worldEvents = new SqliteWorldEventStore(db, runId);
  const collections = new SqliteLoanCollectionStore(db, runId);
  return [
    {
      phase: "obligations",
      handler: {
        module: "M07-payroll-treasury",
        order: 50,
        run: (ctx) => {
          runPayroll(store, ctx);
          runBenefits(store, ctx);
        },
      },
    },
    {
      phase: "obligations",
      handler: {
        module: "M09-credit-collections",
        order: 60,
        run: (ctx) => {
          collections.processDueInstallments(ctx);
        },
      },
    },
    {
      phase: "settlement",
      handler: {
        module: "M06-household-market-settlement",
        order: 50,
        run: (ctx) => runHouseholdSettlement(store, market, energy, worldEvents, ctx),
      },
    },
    {
      phase: "metrics",
      handler: {
        module: "M16-economic-indicators",
        order: 50,
        run: (ctx) => recordMetrics(store, ctx),
      },
    },
  ];
}
