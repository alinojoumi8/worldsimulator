/** SQLite M17 tariff schedule, billing, fuel purchasing, and shock adapter. */

import {
  changedFuelPrice,
  ENERGY_BILLING_INTERVAL_TICKS,
  ENERGY_BUSINESS_BASE_TARIFF_CENTS,
  ENERGY_MAXIMUM_FUEL_PRICE_BP,
  ENERGY_MAXIMUM_TARIFF_BP,
  ENERGY_MINIMUM_FUEL_PRICE_BP,
  ENERGY_MINIMUM_TARIFF_BP,
  ENERGY_PASS_THROUGH_BP,
  ENERGY_REFERENCE_FUEL_PRICE_CENTS,
  ENERGY_RULESET_VERSION,
  energyBillTotal,
  energyBillingCycleDue,
  energyTariffForFuelPrice,
  fuelMilliunitsForDelivery,
  fuelPurchaseTotal,
  nextEnergyBillingTick,
} from "@worldtangle/engine";
import type { TickContext } from "@worldtangle/engine";
import {
  canonicalParse,
  canonicalStringify,
  energyBillSchema,
  energyFuelPriceSchema,
  energyFuelPurchaseSchema,
  energyMarketPriceUpdatedPayloadSchema,
  energySystemSchema,
  energyTariffSchema,
  EngineError,
  ledgerTransactionSchema,
  money,
  runIdSchema,
} from "@worldtangle/shared";
import type {
  EnergyBill,
  EnergyCustomerClass,
  EnergyFuelPrice,
  EnergyFuelPurchase,
  EnergySystem,
  EnergyTariff,
  EventEnvelope,
  IdFactory,
  LedgerTransaction,
} from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";

interface EnergySystemRow {
  run_id: string;
  utility_id: "inst_riverbend_power";
  utility_account_id: string;
  row_account_id: string;
  billing_interval_ticks: bigint;
  pass_through_bp: bigint;
  minimum_tariff_bp: bigint;
  maximum_tariff_bp: bigint;
  minimum_fuel_price_bp: bigint;
  maximum_fuel_price_bp: bigint;
  reference_fuel_price_cents: string;
  household_base_tariff_cents: string;
  business_base_tariff_cents: string;
  ruleset_version: bigint;
  source_event_id: string;
}

interface TariffRow {
  run_id: string;
  id: string;
  customer_class: EnergyCustomerClass;
  effective_tick: bigint;
  price_cents: string;
  fuel_price_cents: string;
  source: "world_gen" | "fuel_pass_through";
  cause_event_id: string | null;
  source_event_id: string;
  ruleset_version: bigint;
}

interface FuelPriceRow {
  run_id: string;
  id: string;
  tick: bigint;
  old_price_cents: string | null;
  new_price_cents: string;
  change_bp: bigint;
  next_tariff_tick: bigint;
  source: "world_gen" | "world_event" | "test";
  cause_event_id: string | null;
  source_event_id: string;
}

interface BillRow {
  run_id: string;
  id: string;
  customer_class: EnergyCustomerClass;
  customer_id: string;
  customer_account_ids_canonical: string;
  tariff_id: string;
  tick: bigint;
  units: bigint;
  unit_price_cents: string;
  amount_cents: string;
  fuel_milliunits: bigint;
  status: "paid" | "rejected";
  rejection_reason: "insufficient_funds" | null;
  transaction_id: string | null;
  evidence_refs_canonical: string;
  request_event_id: string;
  source_event_id: string;
}

interface FuelPurchaseRow {
  run_id: string;
  id: string;
  tick: bigint;
  fuel_price_id: string;
  fuel_milliunits: bigint;
  unit_price_cents: string;
  total_cents: string;
  bill_ids_canonical: string;
  transaction_id: string;
  source_event_id: string;
}

interface AccountRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  account_type: string;
  balance_cents: string;
  status: string;
}

interface ProductionBillingRow {
  id: string;
  company_id: string;
  units_produced: bigint;
  business_account_id: string;
}

export interface EnergyGenesis {
  readonly system: EnergySystem;
  readonly tariffs: readonly EnergyTariff[];
  readonly fuelPrice: EnergyFuelPrice;
}

export interface SettleHouseholdEnergyBillInput {
  readonly householdId: string;
  readonly accountIds: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly causeEventId?: string;
}

export interface ApplyFuelShockInput {
  readonly changeBp: number;
  readonly source: "world_event" | "test";
  readonly causeEventId: string | null;
}

function parseStringArray(value: string, field: string): readonly string[] {
  const parsed = canonicalParse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new EngineError("INTERNAL", `${field} is not a string array`);
  }
  return Object.freeze([...parsed]);
}

function mapSystem(row: EnergySystemRow): EnergySystem {
  return energySystemSchema.parse({
    runId: row.run_id,
    utilityId: row.utility_id,
    utilityAccountId: row.utility_account_id,
    rowAccountId: row.row_account_id,
    billingIntervalTicks: toSafeNumber(row.billing_interval_ticks, "energy billing interval"),
    passThroughBp: toSafeNumber(row.pass_through_bp, "energy pass-through"),
    minimumTariffBp: toSafeNumber(row.minimum_tariff_bp, "minimum energy tariff"),
    maximumTariffBp: toSafeNumber(row.maximum_tariff_bp, "maximum energy tariff"),
    minimumFuelPriceBp: toSafeNumber(row.minimum_fuel_price_bp, "minimum fuel price"),
    maximumFuelPriceBp: toSafeNumber(row.maximum_fuel_price_bp, "maximum fuel price"),
    referenceFuelPriceCents: row.reference_fuel_price_cents,
    householdBaseTariffCents: row.household_base_tariff_cents,
    businessBaseTariffCents: row.business_base_tariff_cents,
    rulesetVersion: toSafeNumber(row.ruleset_version, "energy ruleset version"),
    sourceEventId: row.source_event_id,
  });
}

function mapTariff(row: TariffRow): EnergyTariff {
  return energyTariffSchema.parse({
    id: row.id,
    runId: row.run_id,
    customerClass: row.customer_class,
    effectiveTick: toSafeNumber(row.effective_tick, "energy tariff effective tick"),
    priceCents: row.price_cents,
    fuelPriceCents: row.fuel_price_cents,
    source: row.source,
    causeEventId: row.cause_event_id,
    sourceEventId: row.source_event_id,
    rulesetVersion: toSafeNumber(row.ruleset_version, "energy tariff ruleset version"),
  });
}

function mapFuelPrice(row: FuelPriceRow): EnergyFuelPrice {
  return energyFuelPriceSchema.parse({
    id: row.id,
    runId: row.run_id,
    tick: toSafeNumber(row.tick, "fuel-price tick"),
    oldPriceCents: row.old_price_cents,
    newPriceCents: row.new_price_cents,
    changeBp: toSafeNumber(row.change_bp, "fuel-price change"),
    nextTariffTick: toSafeNumber(row.next_tariff_tick, "next tariff tick"),
    source: row.source,
    causeEventId: row.cause_event_id,
    sourceEventId: row.source_event_id,
  });
}

function mapBill(row: BillRow): EnergyBill {
  return energyBillSchema.parse({
    id: row.id,
    runId: row.run_id,
    customerClass: row.customer_class,
    customerId: row.customer_id,
    customerAccountIds: parseStringArray(
      row.customer_account_ids_canonical,
      `energy bill ${row.id} account IDs`,
    ),
    tariffId: row.tariff_id,
    tick: toSafeNumber(row.tick, "energy bill tick"),
    units: toSafeNumber(row.units, "energy bill units"),
    unitPriceCents: row.unit_price_cents,
    amountCents: row.amount_cents,
    fuelMilliunits: toSafeNumber(row.fuel_milliunits, "energy bill fuel milliunits"),
    status: row.status,
    rejectionReason: row.rejection_reason,
    transactionId: row.transaction_id,
    evidenceRefs: parseStringArray(
      row.evidence_refs_canonical,
      `energy bill ${row.id} evidence`,
    ),
    requestEventId: row.request_event_id,
    sourceEventId: row.source_event_id,
  });
}

function mapFuelPurchase(row: FuelPurchaseRow): EnergyFuelPurchase {
  return energyFuelPurchaseSchema.parse({
    id: row.id,
    runId: row.run_id,
    tick: toSafeNumber(row.tick, "fuel purchase tick"),
    fuelPriceId: row.fuel_price_id,
    fuelMilliunits: toSafeNumber(row.fuel_milliunits, "fuel purchase milliunits"),
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    billIds: parseStringArray(row.bill_ids_canonical, `fuel purchase ${row.id} bills`),
    transactionId: row.transaction_id,
    sourceEventId: row.source_event_id,
  });
}

function emitTransactionPosted(
  ctx: TickContext,
  transaction: LedgerTransaction,
  duplicate: boolean,
): EventEnvelope {
  if (duplicate) {
    return ctx.emit("transaction.duplicate_ignored", {
      transactionId: transaction.id,
      idempotencyKey: transaction.idempotencyKey,
      warning: "duplicate_idempotency_key_ignored",
    }, { correlationId: transaction.correlationId });
  }
  ctx.count("transactions");
  return ctx.emit("transaction.posted", {
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

export class SqliteEnergyStore {
  private readonly finance: SqliteFinanceStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    const parsed = runIdSchema.safeParse(runId);
    if (!parsed.success) throw new EngineError("VALIDATION_FAILED", "invalid energy run ID");
    this.finance = new SqliteFinanceStore(db, runId);
  }

  isInitialized(): boolean {
    return this.db.prepare<[string], { present: bigint }>(`
      SELECT COUNT(*) AS present FROM energy_systems WHERE run_id = ?
    `).get(this.runId)!.present === 1n;
  }

  initialize(input: {
    readonly ids: IdFactory;
    readonly householdBaseTariffCents: string;
    readonly sourceEventId: string;
  }): EnergyGenesis {
    if (this.isInitialized()) {
      throw new EngineError("CONFLICT", `run ${this.runId} already has energy state`);
    }
    const utility = this.db.prepare<[string], AccountRow>(`
      SELECT id, owner_kind, owner_id, account_type, balance_cents, status
      FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company'
        AND owner_id = 'inst_riverbend_power' AND account_type = 'checking'
        AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(this.runId);
    const row = this.db.prepare<[string], AccountRow>(`
      SELECT id, owner_kind, owner_id, account_type, balance_cents, status
      FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'system_row'
        AND owner_id = 'row_riverbend' AND account_type = 'checking'
        AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(this.runId);
    if (utility === undefined || row === undefined) {
      throw new EngineError("CONFLICT", "energy initialization requires RP&L and ROW accounts");
    }
    const system = energySystemSchema.parse({
      runId: this.runId,
      utilityId: "inst_riverbend_power",
      utilityAccountId: utility.id,
      rowAccountId: row.id,
      billingIntervalTicks: ENERGY_BILLING_INTERVAL_TICKS,
      passThroughBp: ENERGY_PASS_THROUGH_BP,
      minimumTariffBp: ENERGY_MINIMUM_TARIFF_BP,
      maximumTariffBp: ENERGY_MAXIMUM_TARIFF_BP,
      minimumFuelPriceBp: ENERGY_MINIMUM_FUEL_PRICE_BP,
      maximumFuelPriceBp: ENERGY_MAXIMUM_FUEL_PRICE_BP,
      referenceFuelPriceCents: ENERGY_REFERENCE_FUEL_PRICE_CENTS.toString(),
      householdBaseTariffCents: input.householdBaseTariffCents,
      businessBaseTariffCents: ENERGY_BUSINESS_BASE_TARIFF_CENTS.toString(),
      rulesetVersion: ENERGY_RULESET_VERSION,
      sourceEventId: input.sourceEventId,
    });
    const fuelPrice = energyFuelPriceSchema.parse({
      id: input.ids.next("efuel"),
      runId: this.runId,
      tick: 0,
      oldPriceCents: null,
      newPriceCents: system.referenceFuelPriceCents,
      changeBp: 0,
      nextTariffTick: system.billingIntervalTicks,
      source: "world_gen",
      causeEventId: null,
      sourceEventId: input.sourceEventId,
    });
    const tariffs = ([
      ["household", system.householdBaseTariffCents],
      ["business", system.businessBaseTariffCents],
    ] as const).map(([customerClass, priceCents]) => energyTariffSchema.parse({
      id: input.ids.next("etar"),
      runId: this.runId,
      customerClass,
      effectiveTick: 0,
      priceCents,
      fuelPriceCents: system.referenceFuelPriceCents,
      source: "world_gen",
      causeEventId: null,
      sourceEventId: input.sourceEventId,
      rulesetVersion: system.rulesetVersion,
    }));
    const persist = (): void => {
      this.db.prepare(`
        INSERT INTO energy_systems(
          run_id, utility_id, utility_account_id, row_account_id,
          billing_interval_ticks, pass_through_bp, minimum_tariff_bp,
          maximum_tariff_bp, minimum_fuel_price_bp, maximum_fuel_price_bp,
          reference_fuel_price_cents, household_base_tariff_cents,
          business_base_tariff_cents, ruleset_version, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        system.runId,
        system.utilityId,
        system.utilityAccountId,
        system.rowAccountId,
        system.billingIntervalTicks,
        system.passThroughBp,
        system.minimumTariffBp,
        system.maximumTariffBp,
        system.minimumFuelPriceBp,
        system.maximumFuelPriceBp,
        system.referenceFuelPriceCents,
        system.householdBaseTariffCents,
        system.businessBaseTariffCents,
        system.rulesetVersion,
        system.sourceEventId,
      );
      this.insertFuelPrice(fuelPrice);
      for (const tariff of tariffs) this.insertTariff(tariff);
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
    return Object.freeze({ system, tariffs: Object.freeze(tariffs), fuelPrice });
  }

  system(): EnergySystem | null {
    const row = this.db.prepare<[string], EnergySystemRow>(`
      SELECT * FROM energy_systems WHERE run_id = ?
    `).get(this.runId);
    return row === undefined ? null : mapSystem(row);
  }

  tariff(customerClass: EnergyCustomerClass, tick: number): EnergyTariff {
    const row = this.db.prepare<[string, string, number], TariffRow>(`
      SELECT * FROM energy_tariff_history
      WHERE run_id = ? AND customer_class = ? AND effective_tick <= ?
      ORDER BY effective_tick DESC, id DESC LIMIT 1
    `).get(this.runId, customerClass, tick);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `${customerClass} energy tariff is unavailable at tick ${tick}`);
    }
    return mapTariff(row);
  }

  latestFuelPrice(tick: number): EnergyFuelPrice {
    const row = this.db.prepare<[string, number], FuelPriceRow>(`
      SELECT * FROM energy_fuel_price_history
      WHERE run_id = ? AND tick <= ? ORDER BY tick DESC, id DESC LIMIT 1
    `).get(this.runId, tick);
    if (row === undefined) throw new EngineError("NOT_FOUND", "energy fuel price is unavailable");
    return mapFuelPrice(row);
  }

  processTariffCycle(ctx: TickContext): readonly EnergyTariff[] {
    const system = this.system();
    if (system === null || !energyBillingCycleDue(ctx.tick, system.billingIntervalTicks)) return [];
    const fuel = this.latestFuelPrice(ctx.tick);
    const updated: EnergyTariff[] = [];
    for (const customerClass of ["household", "business"] as const) {
      const current = this.tariff(customerClass, ctx.tick - 1);
      const baseTariff = customerClass === "household"
        ? system.householdBaseTariffCents
        : system.businessBaseTariffCents;
      const price = energyTariffForFuelPrice({
        baseTariffCents: money(baseTariff),
        referenceFuelPriceCents: money(system.referenceFuelPriceCents),
        fuelPriceCents: money(fuel.newPriceCents),
        passThroughBp: system.passThroughBp,
        minimumTariffBp: system.minimumTariffBp,
        maximumTariffBp: system.maximumTariffBp,
      });
      if (price.toString() === current.priceCents) continue;
      const tariffId = ctx.ids.next("etar");
      const correlationId = `energy:tariff:${ctx.tick}:${customerClass}`;
      const payload = energyMarketPriceUpdatedPayloadSchema.parse({
        sku: "electricity",
        tariffId,
        customerClass,
        effectiveTick: ctx.tick,
        oldPriceCents: current.priceCents,
        newPriceCents: price.toString(),
        fuelPriceCents: fuel.newPriceCents,
        passThroughBp: system.passThroughBp,
        cause: "fuel_pass_through",
        causeEventId: fuel.sourceEventId,
      });
      const sourceEvent = ctx.emit(
        "market.price.updated",
        payload,
        { correlationId, causationId: fuel.sourceEventId },
      );
      const tariff = energyTariffSchema.parse({
        id: tariffId,
        runId: this.runId,
        customerClass,
        effectiveTick: ctx.tick,
        priceCents: price.toString(),
        fuelPriceCents: fuel.newPriceCents,
        source: "fuel_pass_through",
        causeEventId: fuel.sourceEventId,
        sourceEventId: sourceEvent.eventId,
        rulesetVersion: system.rulesetVersion,
      });
      this.insertTariff(tariff);
      updated.push(tariff);
    }
    return Object.freeze(updated);
  }

  applyFuelShock(ctx: TickContext, input: ApplyFuelShockInput): EnergyFuelPrice {
    const system = this.system();
    if (system === null) throw new EngineError("CONFLICT", "energy system is not initialized");
    if (!Number.isSafeInteger(input.changeBp) || input.changeBp < -9_999 ||
      input.changeBp > 100_000) {
      throw new EngineError("VALIDATION_FAILED", "energy shock is outside approved bounds");
    }
    const prior = this.latestFuelPrice(ctx.tick);
    const nextPrice = changedFuelPrice({
      currentFuelPriceCents: money(prior.newPriceCents),
      referenceFuelPriceCents: money(system.referenceFuelPriceCents),
      changeBp: input.changeBp,
      minimumFuelPriceBp: system.minimumFuelPriceBp,
      maximumFuelPriceBp: system.maximumFuelPriceBp,
    });
    const fuelPriceId = ctx.ids.next("efuel");
    const correlationId = `energy:fuel:${ctx.tick}:${fuelPriceId}`;
    const sourceEvent = ctx.emit("energy.fuel_price.changed", {
      fuelPriceId,
      oldPriceCents: prior.newPriceCents,
      newPriceCents: nextPrice.toString(),
      changeBp: input.changeBp,
      nextTariffTick: nextEnergyBillingTick(ctx.tick, system.billingIntervalTicks),
      source: input.source,
      causeEventId: input.causeEventId,
    }, {
      correlationId,
      ...(input.causeEventId === null ? {} : { causationId: input.causeEventId }),
    });
    const fuelPrice = energyFuelPriceSchema.parse({
      id: fuelPriceId,
      runId: this.runId,
      tick: ctx.tick,
      oldPriceCents: prior.newPriceCents,
      newPriceCents: nextPrice.toString(),
      changeBp: input.changeBp,
      nextTariffTick: nextEnergyBillingTick(ctx.tick, system.billingIntervalTicks),
      source: input.source,
      causeEventId: input.causeEventId,
      sourceEventId: sourceEvent.eventId,
    });
    this.insertFuelPrice(fuelPrice);
    return fuelPrice;
  }

  settleHouseholdBill(
    ctx: TickContext,
    input: SettleHouseholdEnergyBillInput,
  ): EnergyBill {
    const system = this.system();
    if (system === null) throw new EngineError("CONFLICT", "energy system is not initialized");
    if (!energyBillingCycleDue(ctx.tick, system.billingIntervalTicks)) {
      throw new EngineError("CONFLICT", `household energy billing is not due at tick ${ctx.tick}`);
    }
    return this.settleBill(ctx, {
      customerClass: "household",
      customerId: input.householdId,
      accountIds: input.accountIds,
      units: 1,
      evidenceRefs: input.evidenceRefs ?? [],
      causeEventId: input.causeEventId,
    });
  }

  billBusinessProduction(ctx: TickContext): readonly EnergyBill[] {
    if (!this.isInitialized()) return [];
    const rows = this.db.prepare<[string, number], ProductionBillingRow>(`
      SELECT p.id, p.company_id, p.units_produced, c.business_account_id
      FROM production_runs p
      JOIN companies c ON c.run_id = p.run_id AND c.id = p.company_id
      WHERE p.run_id = ? AND p.tick = ? AND c.business_account_id IS NOT NULL
      ORDER BY p.company_id, p.id
    `).all(this.runId, ctx.tick);
    const grouped = new Map<string, {
      accountId: string;
      units: number;
      productionRunIds: string[];
    }>();
    for (const row of rows) {
      const existing = grouped.get(row.company_id) ?? {
        accountId: row.business_account_id,
        units: 0,
        productionRunIds: [],
      };
      existing.units = toSafeNumber(
        BigInt(existing.units) + row.units_produced,
        "business energy units",
      );
      existing.productionRunIds.push(row.id);
      grouped.set(row.company_id, existing);
    }
    const bills: EnergyBill[] = [];
    for (const [companyId, group] of grouped) {
      bills.push(this.settleBill(ctx, {
        customerClass: "business",
        customerId: companyId,
        accountIds: [group.accountId],
        units: group.units,
        evidenceRefs: group.productionRunIds,
        causeEventId: undefined,
      }));
    }
    return Object.freeze(bills);
  }

  purchaseFuelForTick(ctx: TickContext): EnergyFuelPurchase | null {
    const system = this.system();
    if (system === null) return null;
    const existing = this.db.prepare<[string, number], FuelPurchaseRow>(`
      SELECT * FROM energy_fuel_purchases WHERE run_id = ? AND tick = ?
    `).get(this.runId, ctx.tick);
    if (existing !== undefined) return mapFuelPurchase(existing);
    const bills = this.db.prepare<[string, number], BillRow>(`
      SELECT * FROM energy_bills
      WHERE run_id = ? AND tick = ? AND status = 'paid' ORDER BY id
    `).all(this.runId, ctx.tick).map(mapBill);
    if (bills.length === 0) return null;
    const fuelMilliunitsBig = bills.reduce(
      (sum, bill) => sum + BigInt(bill.fuelMilliunits),
      0n,
    );
    const fuelMilliunits = toSafeNumber(fuelMilliunitsBig, "fuel purchase milliunits");
    const fuelPrice = this.latestFuelPrice(ctx.tick);
    const total = fuelPurchaseTotal(money(fuelPrice.newPriceCents), fuelMilliunits);
    if (this.finance.accountBalance(system.utilityAccountId) < total) {
      ctx.emit("energy.fuel_purchase.rejected", {
        tick: ctx.tick,
        fuelMilliunits,
        totalCents: total.toString(),
        reason: "insufficient_utility_funds",
        billIds: bills.map((bill) => bill.id),
      }, { correlationId: `energy:fuel-purchase:${ctx.tick}` });
      return null;
    }
    const purchaseId = ctx.ids.next("efpur");
    const correlationId = `energy:fuel-purchase:${ctx.tick}`;
    const requestEvent = ctx.emit("energy.fuel_purchase.requested", {
      purchaseId,
      fuelPriceId: fuelPrice.id,
      fuelMilliunits,
      unitPriceCents: fuelPrice.newPriceCents,
      totalCents: total.toString(),
      billIds: bills.map((bill) => bill.id),
    }, { correlationId });
    const transaction = ledgerTransactionSchema.parse({
      id: ctx.ids.next("txn"),
      runId: this.runId,
      tick: ctx.tick,
      kind: "row_settlement",
      actor: { kind: "system", id: "M17-energy" },
      reason: "energy.row_fuel_purchase",
      sourceEventId: requestEvent.eventId,
      correlationId,
      idempotencyKey: correlationId,
      legs: [
        {
          accountId: system.rowAccountId,
          direction: "debit",
          amountCents: total.toString(),
        },
        {
          accountId: system.utilityAccountId,
          direction: "credit",
          amountCents: total.toString(),
        },
      ],
    });
    const posted = this.finance.post(transaction);
    const transactionEvent = emitTransactionPosted(ctx, posted.transaction, posted.duplicate);
    const sourceEvent = ctx.emit("energy.fuel.purchased", {
      purchaseId,
      transactionId: posted.transaction.id,
      fuelPriceId: fuelPrice.id,
      fuelMilliunits,
      unitPriceCents: fuelPrice.newPriceCents,
      totalCents: total.toString(),
      billIds: bills.map((bill) => bill.id),
    }, { correlationId, causationId: transactionEvent.eventId });
    const purchase = energyFuelPurchaseSchema.parse({
      id: purchaseId,
      runId: this.runId,
      tick: ctx.tick,
      fuelPriceId: fuelPrice.id,
      fuelMilliunits,
      unitPriceCents: fuelPrice.newPriceCents,
      totalCents: total.toString(),
      billIds: bills.map((bill) => bill.id),
      transactionId: posted.transaction.id,
      sourceEventId: sourceEvent.eventId,
    });
    this.db.prepare(`
      INSERT INTO energy_fuel_purchases(
        run_id, id, tick, fuel_price_id, fuel_milliunits, unit_price_cents,
        total_cents, bill_ids_canonical, transaction_id, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      purchase.runId,
      purchase.id,
      purchase.tick,
      purchase.fuelPriceId,
      purchase.fuelMilliunits,
      purchase.unitPriceCents,
      purchase.totalCents,
      canonicalStringify(purchase.billIds),
      purchase.transactionId,
      purchase.sourceEventId,
    );
    return purchase;
  }

  listTariffs(customerClass?: EnergyCustomerClass): readonly EnergyTariff[] {
    const rows = customerClass === undefined
      ? this.db.prepare<[string], TariffRow>(`
          SELECT * FROM energy_tariff_history
          WHERE run_id = ? ORDER BY effective_tick, customer_class, id
        `).all(this.runId)
      : this.db.prepare<[string, string], TariffRow>(`
          SELECT * FROM energy_tariff_history
          WHERE run_id = ? AND customer_class = ? ORDER BY effective_tick, id
        `).all(this.runId, customerClass);
    return Object.freeze(rows.map(mapTariff));
  }

  listFuelPrices(): readonly EnergyFuelPrice[] {
    return Object.freeze(this.db.prepare<[string], FuelPriceRow>(`
      SELECT * FROM energy_fuel_price_history WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map(mapFuelPrice));
  }

  listBills(): readonly EnergyBill[] {
    return Object.freeze(this.db.prepare<[string], BillRow>(`
      SELECT * FROM energy_bills WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map(mapBill));
  }

  listFuelPurchases(): readonly EnergyFuelPurchase[] {
    return Object.freeze(this.db.prepare<[string], FuelPurchaseRow>(`
      SELECT * FROM energy_fuel_purchases WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map(mapFuelPurchase));
  }

  private settleBill(ctx: TickContext, input: {
    readonly customerClass: EnergyCustomerClass;
    readonly customerId: string;
    readonly accountIds: readonly string[];
    readonly units: number;
    readonly evidenceRefs: readonly string[];
    readonly causeEventId: string | undefined;
  }): EnergyBill {
    if (input.accountIds.length === 0 || new Set(input.accountIds).size !== input.accountIds.length) {
      throw new EngineError("VALIDATION_FAILED", "energy billing requires distinct accounts");
    }
    const placeholders = input.accountIds.map(() => "?").join(", ");
    const accounts = this.db.prepare<unknown[], AccountRow>(`
      SELECT id, owner_kind, owner_id, account_type, balance_cents, status
      FROM bank_accounts
      WHERE run_id = ? AND id IN (${placeholders}) ORDER BY id
    `).all(this.runId, ...input.accountIds);
    if (accounts.length !== input.accountIds.length || accounts.some((account) => (
      account.status !== "active" || account.account_type !== "checking" ||
      (input.customerClass === "household"
        ? account.owner_kind !== "agent"
        : account.owner_kind !== "company" || account.owner_id !== input.customerId)
    ))) {
      throw new EngineError("VALIDATION_FAILED", "invalid energy customer accounts");
    }
    const tariff = this.tariff(input.customerClass, ctx.tick);
    const amount = energyBillTotal(money(tariff.priceCents), input.units);
    const fuelMilliunits = fuelMilliunitsForDelivery(input.customerClass, input.units);
    const billId = ctx.ids.next("ebill");
    const correlationId = `energy:bill:${ctx.tick}:${billId}`;
    const requestEvent = ctx.emit("energy.bill.requested", {
      billId,
      customerClass: input.customerClass,
      customerId: input.customerId,
      tariffId: tariff.id,
      units: input.units,
      unitPriceCents: tariff.priceCents,
      amountCents: amount.toString(),
      evidenceRefs: input.evidenceRefs,
    }, {
      correlationId,
      ...(input.causeEventId === undefined ? {} : { causationId: input.causeEventId }),
    });
    const available = accounts.reduce(
      (sum, account) => sum + BigInt(account.balance_cents),
      0n,
    );
    if (available < amount) {
      const sourceEvent = ctx.emit("energy.bill.rejected", {
        billId,
        customerClass: input.customerClass,
        customerId: input.customerId,
        tariffId: tariff.id,
        units: input.units,
        amountCents: amount.toString(),
        availableCents: available.toString(),
        reason: "insufficient_funds",
        evidenceRefs: input.evidenceRefs,
      }, { correlationId, causationId: requestEvent.eventId });
      const bill = energyBillSchema.parse({
        id: billId,
        runId: this.runId,
        customerClass: input.customerClass,
        customerId: input.customerId,
        customerAccountIds: accounts.map((account) => account.id),
        tariffId: tariff.id,
        tick: ctx.tick,
        units: input.units,
        unitPriceCents: tariff.priceCents,
        amountCents: amount.toString(),
        fuelMilliunits,
        status: "rejected",
        rejectionReason: "insufficient_funds",
        transactionId: null,
        evidenceRefs: input.evidenceRefs,
        requestEventId: requestEvent.eventId,
        sourceEventId: sourceEvent.eventId,
      });
      this.insertBill(bill);
      return bill;
    }
    let remaining = amount;
    const payerLegs: LedgerTransaction["legs"] = [];
    for (const account of accounts) {
      if (remaining === 0n) break;
      const balance = BigInt(account.balance_cents);
      const paid = balance < remaining ? balance : remaining;
      if (paid > 0n) {
        payerLegs.push({
          accountId: account.id,
          direction: "credit",
          amountCents: paid.toString(),
        });
        remaining = money(remaining - paid);
      }
    }
    if (remaining !== 0n) throw new EngineError("INTERNAL", "energy payer allocation drifted");
    const system = this.system()!;
    const transaction = ledgerTransactionSchema.parse({
      id: ctx.ids.next("txn"),
      runId: this.runId,
      tick: ctx.tick,
      kind: "purchase",
      actor: { kind: "system", id: "M17-energy" },
      reason: input.customerClass === "household"
        ? "energy.household_flat_tariff"
        : "energy.business_per_production_unit",
      sourceEventId: requestEvent.eventId,
      correlationId,
      idempotencyKey: correlationId,
      legs: [
        {
          accountId: system.utilityAccountId,
          direction: "debit",
          amountCents: amount.toString(),
        },
        ...payerLegs,
      ],
    });
    const posted = this.finance.post(transaction);
    const transactionEvent = emitTransactionPosted(ctx, posted.transaction, posted.duplicate);
    const sourceEvent = ctx.emit("energy.bill.posted", {
      billId,
      customerClass: input.customerClass,
      customerId: input.customerId,
      tariffId: tariff.id,
      units: input.units,
      unitPriceCents: tariff.priceCents,
      amountCents: amount.toString(),
      transactionId: posted.transaction.id,
      evidenceRefs: input.evidenceRefs,
    }, { correlationId, causationId: transactionEvent.eventId });
    const bill = energyBillSchema.parse({
      id: billId,
      runId: this.runId,
      customerClass: input.customerClass,
      customerId: input.customerId,
      customerAccountIds: accounts.map((account) => account.id),
      tariffId: tariff.id,
      tick: ctx.tick,
      units: input.units,
      unitPriceCents: tariff.priceCents,
      amountCents: amount.toString(),
      fuelMilliunits,
      status: "paid",
      rejectionReason: null,
      transactionId: posted.transaction.id,
      evidenceRefs: input.evidenceRefs,
      requestEventId: requestEvent.eventId,
      sourceEventId: sourceEvent.eventId,
    });
    this.insertBill(bill);
    return bill;
  }

  private insertTariff(tariff: EnergyTariff): void {
    this.db.prepare(`
      INSERT INTO energy_tariff_history(
        run_id, id, customer_class, effective_tick, price_cents,
        fuel_price_cents, source, cause_event_id, source_event_id, ruleset_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tariff.runId,
      tariff.id,
      tariff.customerClass,
      tariff.effectiveTick,
      tariff.priceCents,
      tariff.fuelPriceCents,
      tariff.source,
      tariff.causeEventId,
      tariff.sourceEventId,
      tariff.rulesetVersion,
    );
  }

  private insertFuelPrice(fuelPrice: EnergyFuelPrice): void {
    this.db.prepare(`
      INSERT INTO energy_fuel_price_history(
        run_id, id, tick, old_price_cents, new_price_cents, change_bp,
        next_tariff_tick, source, cause_event_id, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fuelPrice.runId,
      fuelPrice.id,
      fuelPrice.tick,
      fuelPrice.oldPriceCents,
      fuelPrice.newPriceCents,
      fuelPrice.changeBp,
      fuelPrice.nextTariffTick,
      fuelPrice.source,
      fuelPrice.causeEventId,
      fuelPrice.sourceEventId,
    );
  }

  private insertBill(bill: EnergyBill): void {
    this.db.prepare(`
      INSERT INTO energy_bills(
        run_id, id, customer_class, customer_id, customer_account_ids_canonical,
        tariff_id, tick, units, unit_price_cents, amount_cents, fuel_milliunits,
        status, rejection_reason, transaction_id, evidence_refs_canonical,
        request_event_id, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bill.runId,
      bill.id,
      bill.customerClass,
      bill.customerId,
      canonicalStringify(bill.customerAccountIds),
      bill.tariffId,
      bill.tick,
      bill.units,
      bill.unitPriceCents,
      bill.amountCents,
      bill.fuelMilliunits,
      bill.status,
      bill.rejectionReason,
      bill.transactionId,
      canonicalStringify(bill.evidenceRefs),
      bill.requestEventId,
      bill.sourceEventId,
    );
  }
}
