/** SQLite M08/M12 production, inventory, posted-price sales, and pricing adapter. */

import {
  affordableQuantity,
  assertMarketPriceWithinBounds,
  inventoryAfterProduction,
  inventoryAfterSale,
  inventorySalesRatioBasisPoints,
  linearProductionUnits,
  marketPriceBounds,
  marketPriceReviewDue,
  movingAverageUnitCost,
  postedPriceTotal,
  scaleCapacity,
  sortPostedPriceOfferings,
  termsWithinConversationBounds,
  weeklyMarketPriceAdjustment,
} from "@worldtangle/engine";
import type { TickContext } from "@worldtangle/engine";
import {
  canonicalParse,
  canonicalStringify,
  companyInventorySchema,
  conversationOutcomeSchema,
  conversationTermBoundsSchema,
  decisionIdSchema,
  EngineError,
  goodsOrderSchema,
  marketOfferingSchema,
  marketPriceHistorySchema,
  marketPriceUpdatedPayloadSchema,
  marketStockoutSchema,
  money,
  productCatalogItemSchema,
  productSkuSchema,
  productionProfileSchema,
  productionRunSchema,
} from "@worldtangle/shared";
import type {
  CompanyInventory,
  GoodsOrder,
  GoodsOrderBuyerKind,
  GoodsOrderRejectionReason,
  IdFactory,
  MarketOffering,
  MarketPriceHistory,
  MarketStockout,
  ProductCatalogItem,
  ProductSku,
  ProductionProfile,
  ProductionRun,
} from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

interface ProductRow {
  sku: ProductSku;
  name: string;
  kind: "good" | "service";
  unit: string;
  basket_category: "food" | "discretionary" | "utilities";
  inventoried: bigint;
  basket_weight_bp: bigint;
  row_reference_price_cents: string;
  ruleset_version: bigint;
}

interface OfferingRow {
  run_id: string;
  id: string;
  company_id: string;
  sku: ProductSku;
  posted_price_cents: string;
  active: bigint;
  created_tick: bigint;
}

interface ProfileRow {
  run_id: string;
  company_id: string;
  sku: ProductSku;
  labor_hours_per_worker: bigint;
  productivity_milliunits_per_labor_hour: bigint;
  capacity_units_per_tick: bigint;
  unit_cost_cents: string;
}

interface InventoryRow {
  run_id: string;
  id: string;
  company_id: string;
  sku: ProductSku;
  quantity: bigint;
  average_unit_cost_cents: string;
  updated_tick: bigint;
}

interface ProductionInputRow extends ProfileRow {
  offering_id: string;
  posted_price_cents: string;
  active: bigint;
  created_tick: bigint;
  inventory_id: string;
  quantity: bigint;
  average_unit_cost_cents: string;
  updated_tick: bigint;
  business_account_id: string;
  activated_tick: bigint;
  worker_count: bigint;
}

interface OrderRow {
  run_id: string;
  id: string;
  buyer_kind: GoodsOrderBuyerKind;
  buyer_id: string;
  buyer_account_ids_canonical: string;
  seller_id: string;
  offering_id: string;
  sku: ProductSku;
  requested_quantity: bigint;
  filled_quantity: bigint;
  unit_price_cents: string;
  total_cents: string;
  status: "placed" | "filled" | "rejected";
  rejection_reason: GoodsOrderRejectionReason | null;
  placed_tick: bigint;
  settled_tick: bigint | null;
  request_event_id: string;
  settlement_transaction_id: string | null;
}

interface StockoutRow {
  run_id: string;
  id: string;
  order_id: string;
  offering_id: string;
  company_id: string;
  sku: ProductSku;
  buyer_kind: GoodsOrderBuyerKind;
  buyer_id: string;
  tick: bigint;
  requested_quantity: bigint;
  available_quantity: bigint;
  request_event_id: string;
}

interface PriceHistoryRow {
  run_id: string;
  id: string;
  offering_id: string;
  company_id: string;
  sku: ProductSku;
  tick: bigint;
  old_price_cents: string;
  new_price_cents: string;
  unit_cost_cents: string;
  inventory_quantity: bigint;
  units_sold: bigint;
  unfilled_units: bigint;
  inventory_sales_ratio_bp: bigint | null;
  source: "rule" | "decision";
  decision_id: string | null;
  rule_signal: MarketPriceHistory["ruleSignal"];
  source_event_id: string;
}

interface PriceReviewRow extends OfferingRow {
  inventory_quantity: bigint;
  average_unit_cost_cents: string;
  profile_unit_cost_cents: string;
  founder_agent_id: string;
}

export interface FounderPricingOpportunity {
  readonly offering: MarketOffering;
  readonly founderAgentId: string;
  readonly unitCostCents: string;
  readonly minimumPriceCents: string;
  readonly maximumPriceCents: string;
  readonly inventoryQuantity: number;
  readonly unitsSold: number;
  readonly unfilledUnits: number;
  readonly inventorySalesRatioBp: number | null;
  readonly rulePriceCents: string;
  readonly ruleSignal: MarketPriceHistory["ruleSignal"];
}

interface OfferingStateRow {
  run_id: string;
  offering_id: string;
  company_id: string;
  sku: ProductSku;
  posted_price_cents: string;
  active: bigint;
  created_tick: bigint;
  inventory_id: string;
  quantity: bigint;
  average_unit_cost_cents: string;
  updated_tick: bigint;
  company_status: string;
  business_account_id: string | null;
  activated_tick: bigint | null;
}

interface AccountValidationRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  account_type: string;
  balance_cents: string;
  status: string;
}

interface TransactionValidationRow {
  tick: bigint;
  kind: string;
  source_event_id: string | null;
}

interface PurchaseNegotiationRow {
  participant_a_id: string;
  participant_b_id: string;
  topic: string;
  status: string;
  close_reason: string | null;
  outcome_canonical: string | null;
  term_bounds_canonical: string;
  terminal_event_id: string | null;
  founder_agent_id: string;
}

interface LegValidationRow {
  account_id: string;
  direction: "debit" | "credit";
  amount_cents: string;
}

function parseStringArray(value: string, field: string): readonly string[] {
  const parsed = canonicalParse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new EngineError("INTERNAL", `${field} is not a string array`);
  }
  return Object.freeze([...parsed]);
}

function mapProduct(row: ProductRow): ProductCatalogItem {
  return productCatalogItemSchema.parse({
    sku: row.sku,
    name: row.name,
    kind: row.kind,
    unit: row.unit,
    basketCategory: row.basket_category,
    inventoried: row.inventoried === 1n,
    basketWeightBp: toSafeNumber(row.basket_weight_bp, "product basket weight"),
    rowReferencePriceCents: row.row_reference_price_cents,
    rulesetVersion: toSafeNumber(row.ruleset_version, "product ruleset version"),
  });
}

function mapOffering(row: OfferingRow): MarketOffering {
  return marketOfferingSchema.parse({
    id: row.id,
    runId: row.run_id,
    companyId: row.company_id,
    sku: row.sku,
    postedPriceCents: row.posted_price_cents,
    active: row.active === 1n,
    createdTick: toSafeNumber(row.created_tick, "offering created tick"),
  });
}

function mapProfile(row: ProfileRow): ProductionProfile {
  return productionProfileSchema.parse({
    runId: row.run_id,
    companyId: row.company_id,
    sku: row.sku,
    laborHoursPerWorker: toSafeNumber(row.labor_hours_per_worker, "labor hours per worker"),
    productivityMilliunitsPerLaborHour: toSafeNumber(
      row.productivity_milliunits_per_labor_hour,
      "production productivity",
    ),
    capacityUnitsPerTick: toSafeNumber(row.capacity_units_per_tick, "production capacity"),
    unitCostCents: row.unit_cost_cents,
  });
}

function mapInventory(row: InventoryRow): CompanyInventory {
  return companyInventorySchema.parse({
    id: row.id,
    runId: row.run_id,
    companyId: row.company_id,
    sku: row.sku,
    quantity: toSafeNumber(row.quantity, "inventory quantity"),
    averageUnitCostCents: row.average_unit_cost_cents,
    updatedTick: toSafeNumber(row.updated_tick, "inventory updated tick"),
  });
}

function mapOrder(row: OrderRow): GoodsOrder {
  return goodsOrderSchema.parse({
    id: row.id,
    runId: row.run_id,
    buyerKind: row.buyer_kind,
    buyerId: row.buyer_id,
    buyerAccountIds: parseStringArray(
      row.buyer_account_ids_canonical,
      `order ${row.id} buyer accounts`,
    ),
    sellerId: row.seller_id,
    offeringId: row.offering_id,
    sku: row.sku,
    requestedQuantity: toSafeNumber(row.requested_quantity, "order requested quantity"),
    filledQuantity: toSafeNumber(row.filled_quantity, "order filled quantity"),
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    status: row.status,
    rejectionReason: row.rejection_reason,
    placedTick: toSafeNumber(row.placed_tick, "order placed tick"),
    settledTick: row.settled_tick === null
      ? null
      : toSafeNumber(row.settled_tick, "order settled tick"),
    requestEventId: row.request_event_id,
    settlementTransactionId: row.settlement_transaction_id,
  });
}

function mapStockout(row: StockoutRow): MarketStockout {
  return marketStockoutSchema.parse({
    id: row.id,
    runId: row.run_id,
    orderId: row.order_id,
    offeringId: row.offering_id,
    companyId: row.company_id,
    sku: row.sku,
    buyerKind: row.buyer_kind,
    buyerId: row.buyer_id,
    tick: toSafeNumber(row.tick, "stockout tick"),
    requestedQuantity: toSafeNumber(row.requested_quantity, "stockout requested quantity"),
    availableQuantity: toSafeNumber(row.available_quantity, "stockout available quantity"),
    requestEventId: row.request_event_id,
  });
}

function mapPriceHistory(row: PriceHistoryRow): MarketPriceHistory {
  return marketPriceHistorySchema.parse({
    id: row.id,
    runId: row.run_id,
    offeringId: row.offering_id,
    companyId: row.company_id,
    sku: row.sku,
    tick: toSafeNumber(row.tick, "market price tick"),
    oldPriceCents: row.old_price_cents,
    newPriceCents: row.new_price_cents,
    unitCostCents: row.unit_cost_cents,
    inventoryQuantity: toSafeNumber(row.inventory_quantity, "market price inventory"),
    unitsSold: toSafeNumber(row.units_sold, "market price units sold"),
    unfilledUnits: toSafeNumber(row.unfilled_units, "market price unfilled units"),
    inventorySalesRatioBp: row.inventory_sales_ratio_bp === null
      ? null
      : toSafeNumber(row.inventory_sales_ratio_bp, "market price inventory sales ratio"),
    source: row.source,
    decisionId: row.decision_id,
    ruleSignal: row.rule_signal,
    sourceEventId: row.source_event_id,
  });
}

function offeringFromState(row: OfferingStateRow): MarketOffering {
  return mapOffering({
    run_id: row.run_id,
    id: row.offering_id,
    company_id: row.company_id,
    sku: row.sku,
    posted_price_cents: row.posted_price_cents,
    active: row.active,
    created_tick: row.created_tick,
  });
}

function inventoryFromState(row: OfferingStateRow): CompanyInventory {
  return mapInventory({
    run_id: row.run_id,
    id: row.inventory_id,
    company_id: row.company_id,
    sku: row.sku,
    quantity: row.quantity,
    average_unit_cost_cents: row.average_unit_cost_cents,
    updated_tick: row.updated_tick,
  });
}

export interface ProductionOfferingInput {
  readonly companyId: string;
  readonly sku: ProductSku;
  readonly postedPriceCents: string;
  readonly unitCostCents: string;
  readonly laborHoursPerWorker: number;
  readonly productivityMilliunitsPerLaborHour: number;
  readonly capacityUnitsPerTick: number;
  readonly tick: number;
  readonly ids: IdFactory;
}

export interface CreatedProductionOffering {
  readonly offering: MarketOffering;
  readonly profile: ProductionProfile;
  readonly inventory: CompanyInventory;
}

export interface ActiveOfferingQuote {
  readonly offering: MarketOffering;
  readonly inventory: CompanyInventory;
  readonly sellerAccountId: string;
}

export interface PlaceGoodsOrderInput {
  readonly buyerKind: GoodsOrderBuyerKind;
  readonly buyerId: string;
  readonly buyerAccountIds: readonly string[];
  readonly sellerId: string;
  readonly offeringId: string;
  readonly sku: ProductSku;
  readonly quantity: number;
  readonly expectedUnitPriceCents: string;
  readonly tick: number;
  readonly requestEventId: string;
  readonly ids: IdFactory;
}

export interface GoodsOrderPlacement {
  readonly order: GoodsOrder;
  readonly offering: MarketOffering;
  readonly sellerAccountId: string | null;
  readonly availableQuantity: number;
  readonly stockout: MarketStockout | null;
}

export interface OrderPaymentRequest {
  readonly order: GoodsOrder;
  readonly sellerAccountId: string;
  readonly buyerAccountIds: readonly string[];
  readonly totalCents: string;
}

export interface OrderPaymentResult {
  readonly transactionId: string;
  readonly sourceEventId: string;
}

export interface GoodsOrderSettlement {
  readonly order: GoodsOrder;
  readonly inventoryBefore: number;
  readonly inventoryAfter: number;
  readonly inventoryMovementId: string | null;
  readonly stockout: MarketStockout | null;
  readonly paymentSourceEventId: string | null;
}

export interface FounderPriceOverrideInput {
  readonly offeringId: string;
  readonly founderAgentId: string;
  readonly decisionId: string;
  readonly newPriceCents: string;
}

export class SqliteMarketStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  listProducts(): readonly ProductCatalogItem[] {
    return this.db.prepare<[], ProductRow>(`
      SELECT * FROM market_products ORDER BY sku
    `).all().map(mapProduct);
  }

  getProduct(sku: ProductSku): ProductCatalogItem {
    const parsedSku = productSkuSchema.parse(sku);
    const row = this.db.prepare<[string], ProductRow>(`
      SELECT * FROM market_products WHERE sku = ?
    `).get(parsedSku);
    if (row === undefined) throw new EngineError("NOT_FOUND", `product ${sku} does not exist`);
    return mapProduct(row);
  }

  createProductionOffering(input: ProductionOfferingInput): CreatedProductionOffering {
    assertMarketPriceWithinBounds(
      money(input.postedPriceCents),
      money(input.unitCostCents),
    );
    const product = this.getProduct(input.sku);
    if (!product.inventoried || product.kind !== "good") {
      throw new EngineError(
        "VALIDATION_FAILED",
        `product ${input.sku} is a service and cannot use an inventory production profile`,
      );
    }
    const company = this.db.prepare<[string, string], {
      status: string;
      business_account_id: string | null;
      activated_tick: bigint | null;
    }>(`
      SELECT status, business_account_id, activated_tick
      FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, input.companyId);
    if (company === undefined) {
      throw new EngineError("NOT_FOUND", `company ${input.companyId} does not exist`);
    }
    if (company.status !== "active" || company.business_account_id === null ||
      company.activated_tick === null) {
      throw new EngineError("CONFLICT", `company ${input.companyId} cannot trade before activation`);
    }
    if (toSafeNumber(company.activated_tick, "company activated tick") >= input.tick) {
      throw new EngineError(
        "CONFLICT",
        `company ${input.companyId} cannot create an offering until the tick after activation`,
      );
    }
    const offering = marketOfferingSchema.parse({
      id: input.ids.next("off"),
      runId: this.runId,
      companyId: input.companyId,
      sku: input.sku,
      postedPriceCents: input.postedPriceCents,
      active: true,
      createdTick: input.tick,
    });
    const profile = productionProfileSchema.parse({
      runId: this.runId,
      companyId: input.companyId,
      sku: input.sku,
      laborHoursPerWorker: input.laborHoursPerWorker,
      productivityMilliunitsPerLaborHour: input.productivityMilliunitsPerLaborHour,
      capacityUnitsPerTick: input.capacityUnitsPerTick,
      unitCostCents: input.unitCostCents,
    });
    const inventory = companyInventorySchema.parse({
      id: input.ids.next("invt"),
      runId: this.runId,
      companyId: input.companyId,
      sku: input.sku,
      quantity: 0,
      averageUnitCostCents: "0",
      updatedTick: input.tick,
    });
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO market_offerings(
          run_id, id, company_id, sku, posted_price_cents, active, created_tick
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(
        this.runId,
        offering.id,
        offering.companyId,
        offering.sku,
        offering.postedPriceCents,
        offering.createdTick,
      );
      this.db.prepare(`
        INSERT INTO company_production_profiles(
          run_id, company_id, sku, labor_hours_per_worker,
          productivity_milliunits_per_labor_hour, capacity_units_per_tick, unit_cost_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        profile.companyId,
        profile.sku,
        profile.laborHoursPerWorker,
        profile.productivityMilliunitsPerLaborHour,
        profile.capacityUnitsPerTick,
        profile.unitCostCents,
      );
      this.db.prepare(`
        INSERT INTO company_inventory(
          run_id, id, company_id, sku, quantity, average_unit_cost_cents, updated_tick
        ) VALUES (?, ?, ?, ?, 0, '0', ?)
      `).run(
        this.runId,
        inventory.id,
        inventory.companyId,
        inventory.sku,
        inventory.updatedTick,
      );
    }).immediate();
    return { offering, profile, inventory };
  }

  getInventory(companyId: string, sku: ProductSku): CompanyInventory {
    const row = this.db.prepare<[string, string, string], InventoryRow>(`
      SELECT * FROM company_inventory WHERE run_id = ? AND company_id = ? AND sku = ?
    `).get(this.runId, companyId, sku);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `company ${companyId} has no ${sku} inventory`);
    }
    return mapInventory(row);
  }

  getActiveOfferingQuote(offeringId: string, tick: number): ActiveOfferingQuote {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "offering quote tick must be nonnegative");
    }
    const row = this.getOfferingState(offeringId);
    if (
      row === undefined ||
      row.active !== 1n ||
      row.company_status !== "active" ||
      row.business_account_id === null ||
      row.activated_tick === null ||
      toSafeNumber(row.activated_tick, "company activation tick") >= tick
    ) {
      throw new EngineError("CONFLICT", `offering ${offeringId} is not active at tick ${tick}`);
    }
    return Object.freeze({
      offering: offeringFromState(row),
      inventory: inventoryFromState(row),
      sellerAccountId: row.business_account_id,
    });
  }

  listActiveOfferings(sku: ProductSku, tick: number): readonly ActiveOfferingQuote[] {
    productSkuSchema.parse(sku);
    const rows = this.db.prepare<[string, string, number], OfferingStateRow>(`
      SELECT o.run_id, o.id AS offering_id, o.company_id, o.sku, o.posted_price_cents,
        o.active, o.created_tick, i.id AS inventory_id, i.quantity,
        i.average_unit_cost_cents, i.updated_tick,
        c.status AS company_status, c.business_account_id, c.activated_tick
      FROM market_offerings o
      JOIN company_inventory i
        ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
      JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
      WHERE o.run_id = ? AND o.sku = ? AND o.active = 1
        AND c.status = 'active' AND c.business_account_id IS NOT NULL
        AND c.activated_tick < ?
      ORDER BY o.id
    `).all(this.runId, sku, tick);
    const mapped = rows.map((row) => ({
      offering: mapOffering({
        run_id: this.runId,
        id: row.offering_id,
        company_id: row.company_id,
        sku: row.sku,
        posted_price_cents: row.posted_price_cents,
        active: row.active,
        created_tick: row.created_tick,
      }),
      inventory: mapInventory({
        run_id: this.runId,
        id: row.inventory_id,
        company_id: row.company_id,
        sku: row.sku,
        quantity: row.quantity,
        average_unit_cost_cents: row.average_unit_cost_cents,
        updated_tick: row.updated_tick,
      }),
      sellerAccountId: row.business_account_id!,
    }));
    const sorted = sortPostedPriceOfferings(mapped.map((entry) => ({
      ...entry,
      id: entry.offering.id,
      postedPriceCents: entry.offering.postedPriceCents,
    })));
    return sorted.map((entry) => ({
      offering: entry.offering,
      inventory: entry.inventory,
      sellerAccountId: entry.sellerAccountId,
    }));
  }

  processProduction(
    ctx: TickContext,
    energyUnitCostCents = "0",
    capacityMultiplierForCompany: (companyId: string, tick: number) => number = () => 10_000,
  ): readonly ProductionRun[] {
    const energyUnitCost = money(energyUnitCostCents);
    if (energyUnitCost < 0n) {
      throw new EngineError("VALIDATION_FAILED", "energy unit cost cannot be negative");
    }
    return this.db.transaction(
      () => this.processProductionWithinTransaction(
        ctx,
        energyUnitCost,
        capacityMultiplierForCompany,
      ),
    ).immediate();
  }

  private processProductionWithinTransaction(
    ctx: TickContext,
    energyUnitCostCents: ReturnType<typeof money>,
    capacityMultiplierForCompany: (companyId: string, tick: number) => number,
  ): readonly ProductionRun[] {
    const rows = this.db.prepare<[number, string, number], ProductionInputRow>(`
      SELECT p.run_id, p.company_id, p.sku, p.labor_hours_per_worker,
        p.productivity_milliunits_per_labor_hour, p.capacity_units_per_tick,
        p.unit_cost_cents, o.id AS offering_id, o.posted_price_cents,
        o.active, o.created_tick, i.id AS inventory_id, i.quantity,
        i.average_unit_cost_cents, i.updated_tick,
        c.business_account_id, c.activated_tick,
        (
          SELECT COUNT(*) FROM employment_contracts e
          WHERE e.run_id = p.run_id AND e.employer_id = p.company_id
            AND e.status = 'active' AND e.start_tick <= ?
        ) AS worker_count
      FROM company_production_profiles p
      JOIN market_offerings o
        ON o.run_id = p.run_id AND o.company_id = p.company_id AND o.sku = p.sku
      JOIN company_inventory i
        ON i.run_id = p.run_id AND i.company_id = p.company_id AND i.sku = p.sku
      JOIN companies c ON c.run_id = p.run_id AND c.id = p.company_id
      WHERE p.run_id = ? AND o.active = 1 AND c.status = 'active'
        AND c.business_account_id IS NOT NULL AND c.activated_tick < ?
      ORDER BY p.company_id, p.sku
    `).all(ctx.tick, this.runId, ctx.tick);
    const completed: ProductionRun[] = [];
    for (const row of rows) {
      const profile = mapProfile(row);
      const inventory = mapInventory({
        run_id: row.run_id,
        id: row.inventory_id,
        company_id: row.company_id,
        sku: row.sku,
        quantity: row.quantity,
        average_unit_cost_cents: row.average_unit_cost_cents,
        updated_tick: row.updated_tick,
      });
      const workerCount = toSafeNumber(row.worker_count, "production worker count");
      const capacityMultiplierBp = capacityMultiplierForCompany(profile.companyId, ctx.tick);
      const effectiveCapacityUnits = scaleCapacity(
        profile.capacityUnitsPerTick,
        capacityMultiplierBp,
      );
      const unitsProduced = linearProductionUnits({
        activeWorkerCount: workerCount,
        laborHoursPerWorker: profile.laborHoursPerWorker,
        productivityMilliunitsPerLaborHour: profile.productivityMilliunitsPerLaborHour,
        capacityUnitsPerTick: effectiveCapacityUnits,
      });
      if (unitsProduced === 0) continue;
      const totalUnitCost = money(money(profile.unitCostCents) + energyUnitCostCents);
      const inventoryAfter = inventoryAfterProduction(inventory.quantity, unitsProduced);
      const averageUnitCost = movingAverageUnitCost({
        currentQuantity: inventory.quantity,
        currentAverageUnitCostCents: money(inventory.averageUnitCostCents),
        producedQuantity: unitsProduced,
        producedUnitCostCents: totalUnitCost,
      });
      const productionId = ctx.ids.next("prod");
      const correlationId = `production:${ctx.tick}:${profile.companyId}:${profile.sku}`;
      const sourceEvent = ctx.emit("production.completed", {
        productionId,
        companyId: profile.companyId,
        sku: profile.sku,
        workerCount,
        laborHours: workerCount * profile.laborHoursPerWorker,
        productivityMilliunitsPerLaborHour: profile.productivityMilliunitsPerLaborHour,
        capacityUnits: effectiveCapacityUnits,
        baseCapacityUnits: profile.capacityUnitsPerTick,
        capacityMultiplierBp,
        unitsProduced,
        inventoryBefore: inventory.quantity,
        inventoryAfter,
        baseUnitCostCents: profile.unitCostCents,
        energyUnitCostCents: energyUnitCostCents.toString(),
        unitCostCents: totalUnitCost.toString(),
      }, { correlationId });
      const production = productionRunSchema.parse({
        id: productionId,
        runId: this.runId,
        companyId: profile.companyId,
        sku: profile.sku,
        tick: ctx.tick,
        workerCount,
        laborHours: workerCount * profile.laborHoursPerWorker,
        productivityMilliunitsPerLaborHour: profile.productivityMilliunitsPerLaborHour,
        capacityUnits: effectiveCapacityUnits,
        unitsProduced,
        inventoryBefore: inventory.quantity,
        inventoryAfter,
        unitCostCents: totalUnitCost.toString(),
        sourceEventId: sourceEvent.eventId,
      });
      const movementId = ctx.ids.next("invmov");
      const updated = this.db.prepare(`
        UPDATE company_inventory
        SET quantity = ?, average_unit_cost_cents = ?, updated_tick = ?
        WHERE run_id = ? AND id = ? AND quantity = ?
      `).run(
        inventoryAfter,
        averageUnitCost.toString(),
        ctx.tick,
        this.runId,
        inventory.id,
        inventory.quantity,
      );
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `inventory ${inventory.id} changed during production`);
      }
      this.db.prepare(`
        INSERT INTO production_runs(
          run_id, id, company_id, sku, tick, worker_count, labor_hours,
          productivity_milliunits_per_labor_hour, capacity_units, units_produced,
          inventory_before, inventory_after, unit_cost_cents, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        production.id,
        production.companyId,
        production.sku,
        production.tick,
        production.workerCount,
        production.laborHours,
        production.productivityMilliunitsPerLaborHour,
        production.capacityUnits,
        production.unitsProduced,
        production.inventoryBefore,
        production.inventoryAfter,
        production.unitCostCents,
        production.sourceEventId,
      );
      this.db.prepare(`
        INSERT INTO inventory_movements(
          run_id, id, inventory_id, company_id, sku, tick, kind,
          quantity_delta, quantity_after, unit_cost_cents, source_ref, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'production', ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        movementId,
        inventory.id,
        production.companyId,
        production.sku,
        production.tick,
        unitsProduced,
        inventoryAfter,
        averageUnitCost.toString(),
        production.id,
        production.sourceEventId,
      );
      ctx.emit("inventory.increased", {
        inventoryId: inventory.id,
        movementId,
        companyId: production.companyId,
        sku: production.sku,
        quantityDelta: unitsProduced,
        quantityAfter: inventoryAfter,
        sourceRef: production.id,
      }, { correlationId, causationId: sourceEvent.eventId });
      completed.push(production);
    }
    return completed;
  }

  /** Read-only weekly pricing menu inputs for founder Tier-2 decisions. */
  listFounderPricingOpportunities(tick: number): readonly FounderPricingOpportunity[] {
    if (!Number.isSafeInteger(tick) || tick < 1) {
      throw new EngineError("VALIDATION_FAILED", "pricing opportunity tick must be positive");
    }
    const rows = this.db.prepare<[string, number], PriceReviewRow>(`
      SELECT o.run_id, o.id, o.company_id, o.sku, o.posted_price_cents,
        o.active, o.created_tick, i.quantity AS inventory_quantity,
        i.average_unit_cost_cents, p.unit_cost_cents AS profile_unit_cost_cents,
        c.founder_agent_id
      FROM market_offerings o
      JOIN company_inventory i
        ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
      JOIN company_production_profiles p
        ON p.run_id = o.run_id AND p.company_id = o.company_id AND p.sku = o.sku
      JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
      WHERE o.run_id = ? AND o.active = 1 AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM market_price_history h
          WHERE h.run_id = o.run_id AND h.offering_id = o.id AND h.tick = ?
        )
      ORDER BY o.id
    `).all(this.runId, tick);
    const opportunities: FounderPricingOpportunity[] = [];
    for (const row of rows) {
      const createdTick = toSafeNumber(row.created_tick, "offering created tick");
      if (!marketPriceReviewDue(createdTick, tick)) continue;
      const metrics = this.priceWindowMetrics(row.company_id, row.sku, row.id, tick);
      const unitCostCents = BigInt(row.average_unit_cost_cents) > 0n
        ? row.average_unit_cost_cents
        : row.profile_unit_cost_cents;
      const rule = weeklyMarketPriceAdjustment({
        currentPriceCents: money(row.posted_price_cents),
        unitCostCents: money(unitCostCents),
        inventoryQuantity: toSafeNumber(row.inventory_quantity, "pricing opportunity inventory"),
        unitsSold: metrics.unitsSold,
        unfilledUnits: metrics.unfilledUnits,
      });
      const bounds = marketPriceBounds(money(unitCostCents));
      opportunities.push(Object.freeze({
        offering: mapOffering(row),
        founderAgentId: row.founder_agent_id,
        unitCostCents,
        minimumPriceCents: bounds.minimumCents.toString(),
        maximumPriceCents: bounds.maximumCents.toString(),
        inventoryQuantity: toSafeNumber(
          row.inventory_quantity,
          "pricing opportunity inventory",
        ),
        unitsSold: metrics.unitsSold,
        unfilledUnits: metrics.unfilledUnits,
        inventorySalesRatioBp: rule.inventorySalesRatioBp,
        rulePriceCents: rule.newPriceCents.toString(),
        ruleSignal: rule.signal,
      }));
    }
    return Object.freeze(opportunities);
  }

  processWeeklyPricing(ctx: TickContext): readonly MarketPriceHistory[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare<[string, number], PriceReviewRow>(`
        SELECT o.run_id, o.id, o.company_id, o.sku, o.posted_price_cents,
          o.active, o.created_tick, i.quantity AS inventory_quantity,
          i.average_unit_cost_cents, p.unit_cost_cents AS profile_unit_cost_cents,
          c.founder_agent_id
        FROM market_offerings o
        JOIN company_inventory i
          ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
        JOIN company_production_profiles p
          ON p.run_id = o.run_id AND p.company_id = o.company_id AND p.sku = o.sku
        JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
        WHERE o.run_id = ? AND o.active = 1 AND c.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM market_price_history h
            WHERE h.run_id = o.run_id AND h.offering_id = o.id AND h.tick = ?
          )
        ORDER BY o.id
      `).all(this.runId, ctx.tick);
      const updates: MarketPriceHistory[] = [];
      for (const row of rows) {
        const createdTick = toSafeNumber(row.created_tick, "offering created tick");
        if (!marketPriceReviewDue(createdTick, ctx.tick)) continue;
        const metrics = this.priceWindowMetrics(row.company_id, row.sku, row.id, ctx.tick);
        const unitCostCents = BigInt(row.average_unit_cost_cents) > 0n
          ? row.average_unit_cost_cents
          : row.profile_unit_cost_cents;
        const result = weeklyMarketPriceAdjustment({
          currentPriceCents: money(row.posted_price_cents),
          unitCostCents: money(unitCostCents),
          inventoryQuantity: toSafeNumber(row.inventory_quantity, "market price inventory"),
          unitsSold: metrics.unitsSold,
          unfilledUnits: metrics.unfilledUnits,
        });
        const update = this.recordPriceChange({
          offering: mapOffering(row),
          unitCostCents,
          inventoryQuantity: toSafeNumber(row.inventory_quantity, "market price inventory"),
          unitsSold: metrics.unitsSold,
          unfilledUnits: metrics.unfilledUnits,
          inventorySalesRatioBp: result.inventorySalesRatioBp,
          newPriceCents: result.newPriceCents.toString(),
          source: "rule",
          decisionId: null,
          ruleSignal: result.signal,
          actorId: "market-pricing",
          ctx,
        });
        if (update !== null) updates.push(update);
      }
      return Object.freeze(updates);
    }).immediate();
  }

  applyFounderPriceOverride(
    input: FounderPriceOverrideInput,
    ctx: TickContext,
  ): MarketPriceHistory | null {
    return this.db.transaction(() => {
      const decisionId = decisionIdSchema.parse(input.decisionId);
      const row = this.db.prepare<[string, string], PriceReviewRow>(`
        SELECT o.run_id, o.id, o.company_id, o.sku, o.posted_price_cents,
          o.active, o.created_tick, i.quantity AS inventory_quantity,
          i.average_unit_cost_cents, p.unit_cost_cents AS profile_unit_cost_cents,
          c.founder_agent_id
        FROM market_offerings o
        JOIN company_inventory i
          ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
        JOIN company_production_profiles p
          ON p.run_id = o.run_id AND p.company_id = o.company_id AND p.sku = o.sku
        JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
        WHERE o.run_id = ? AND o.id = ? AND o.active = 1 AND c.status = 'active'
      `).get(this.runId, input.offeringId);
      if (row === undefined) {
        throw new EngineError("NOT_FOUND", `active offering ${input.offeringId} does not exist`);
      }
      if (row.founder_agent_id !== input.founderAgentId) {
        throw new EngineError("PERMISSION_DENIED", "only the company founder may override price");
      }
      const decision = this.db.prepare<[string, string], {
        agent_id: string;
        tick: bigint;
        tier: bigint;
      }>(`
        SELECT agent_id, tick, tier FROM decisions WHERE run_id = ? AND id = ?
      `).get(this.runId, decisionId);
      if (decision === undefined) {
        throw new EngineError("NOT_FOUND", `decision ${decisionId} does not exist`);
      }
      if (decision.agent_id !== input.founderAgentId) {
        throw new EngineError("PERMISSION_DENIED", "price decision does not belong to the founder");
      }
      if (toSafeNumber(decision.tick, "price decision tick") !== ctx.tick ||
        (decision.tier !== 1n && decision.tier !== 2n)) {
        throw new EngineError("CONFLICT", "price override requires a current Tier-1 or Tier-2 decision");
      }
      const unitCostCents = BigInt(row.average_unit_cost_cents) > 0n
        ? row.average_unit_cost_cents
        : row.profile_unit_cost_cents;
      const boundedPrice = assertMarketPriceWithinBounds(
        money(input.newPriceCents),
        money(unitCostCents),
      );
      const metrics = this.priceWindowMetrics(row.company_id, row.sku, row.id, ctx.tick);
      return this.recordPriceChange({
        offering: mapOffering(row),
        unitCostCents,
        inventoryQuantity: toSafeNumber(row.inventory_quantity, "market price inventory"),
        unitsSold: metrics.unitsSold,
        unfilledUnits: metrics.unfilledUnits,
        inventorySalesRatioBp: inventorySalesRatioBasisPoints(
          toSafeNumber(row.inventory_quantity, "market price inventory"),
          metrics.unitsSold,
        ),
        newPriceCents: boundedPrice.toString(),
        source: "decision",
        decisionId,
        ruleSignal: null,
        actorId: input.founderAgentId,
        ctx,
      });
    }).immediate();
  }

  placeOrder(input: PlaceGoodsOrderInput): GoodsOrderPlacement {
    return this.db.transaction(() => this.placeOrderWithinTransaction(input)).immediate();
  }

  placeNegotiatedOrder(
    input: PlaceGoodsOrderInput,
    conversationId: string,
  ): GoodsOrderPlacement {
    return this.db.transaction(() => this.placeOrderWithinTransaction(
      input,
      conversationId,
    )).immediate();
  }

  private placeOrderWithinTransaction(
    input: PlaceGoodsOrderInput,
    negotiationConversationId?: string,
  ): GoodsOrderPlacement {
    productSkuSchema.parse(input.sku);
    const offeringState = this.getOfferingState(input.offeringId);
    if (offeringState === undefined) {
      throw new EngineError("NOT_FOUND", `offering ${input.offeringId} does not exist`);
    }
    const offering = offeringFromState(offeringState);
    if (offering.companyId !== input.sellerId || offering.sku !== input.sku) {
      throw new EngineError("VALIDATION_FAILED", "order seller, offering, and SKU do not match");
    }
    if (negotiationConversationId !== undefined) {
      this.assertNegotiatedPurchaseAuthority(input, negotiationConversationId);
    }
    const totalCents = postedPriceTotal(money(input.expectedUnitPriceCents), input.quantity);
    const buyer = this.validateBuyer(
      input.buyerKind,
      input.buyerId,
      input.buyerAccountIds,
    );
    const availableQuantity = toSafeNumber(offeringState.quantity, "available inventory");
    let rejectionReason: GoodsOrderRejectionReason | null = null;
    if (!buyer.valid) rejectionReason = "invalid_buyer";
    else if (!offering.active || offeringState.company_status !== "active" ||
      offeringState.business_account_id === null || offeringState.activated_tick === null ||
      toSafeNumber(offeringState.activated_tick, "company activated tick") >= input.tick) {
      rejectionReason = "inactive_offering";
    } else if (
      negotiationConversationId === undefined &&
      offering.postedPriceCents !== input.expectedUnitPriceCents
    ) {
      rejectionReason = "price_changed";
    } else if (
      negotiationConversationId !== undefined &&
      (
        BigInt(input.expectedUnitPriceCents) < BigInt(offeringState.average_unit_cost_cents) ||
        BigInt(input.expectedUnitPriceCents) > BigInt(offering.postedPriceCents)
      )
    ) {
      rejectionReason = "price_changed";
    } else if (buyer.balanceCents < totalCents) {
      rejectionReason = "insufficient_funds";
    } else if (availableQuantity < input.quantity) {
      rejectionReason = "stockout";
    }
    const order = goodsOrderSchema.parse({
      id: input.ids.next("gord"),
      runId: this.runId,
      buyerKind: input.buyerKind,
      buyerId: input.buyerId,
      buyerAccountIds: input.buyerAccountIds,
      sellerId: input.sellerId,
      offeringId: input.offeringId,
      sku: input.sku,
      requestedQuantity: input.quantity,
      filledQuantity: 0,
      unitPriceCents: input.expectedUnitPriceCents,
      totalCents: totalCents.toString(),
      status: rejectionReason === null ? "placed" : "rejected",
      rejectionReason,
      placedTick: input.tick,
      settledTick: rejectionReason === null ? null : input.tick,
      requestEventId: input.requestEventId,
      settlementTransactionId: null,
    });
    this.insertOrder(order);
    let stockout: MarketStockout | null = null;
    if (rejectionReason === "stockout") {
      stockout = marketStockoutSchema.parse({
        id: input.ids.next("stkout"),
        runId: this.runId,
        orderId: order.id,
        offeringId: order.offeringId,
        companyId: order.sellerId,
        sku: order.sku,
        buyerKind: order.buyerKind,
        buyerId: order.buyerId,
        tick: input.tick,
        requestedQuantity: order.requestedQuantity,
        availableQuantity,
        requestEventId: input.requestEventId,
      });
      this.insertStockout(stockout);
    }
    return {
      order,
      offering,
      sellerAccountId: offeringState.business_account_id,
      availableQuantity,
      stockout,
    };
  }

  settleOrder(
    orderId: string,
    tick: number,
    ids: IdFactory,
    postPayment: (request: OrderPaymentRequest) => OrderPaymentResult,
  ): GoodsOrderSettlement {
    return this.settleOrderWithAuthority(orderId, tick, ids, postPayment);
  }

  settleNegotiatedOrder(
    orderId: string,
    conversationId: string,
    tick: number,
    ids: IdFactory,
    postPayment: (request: OrderPaymentRequest) => OrderPaymentResult,
  ): GoodsOrderSettlement {
    return this.settleOrderWithAuthority(
      orderId,
      tick,
      ids,
      postPayment,
      conversationId,
    );
  }

  private settleOrderWithAuthority(
    orderId: string,
    tick: number,
    ids: IdFactory,
    postPayment: (request: OrderPaymentRequest) => OrderPaymentResult,
    negotiationConversationId?: string,
  ): GoodsOrderSettlement {
    return this.db.transaction(() => {
      const order = this.getOrder(orderId);
      if (order.status !== "placed") {
        throw new EngineError("CONFLICT", `order ${orderId} is already ${order.status}`);
      }
      const offeringState = this.getOfferingState(order.offeringId);
      if (offeringState === undefined || offeringState.business_account_id === null ||
        offeringState.company_status !== "active" || offeringState.active !== 1n) {
        return this.rejectPlacedOrder(order, "inactive_offering", tick, 0, ids);
      }
      if (negotiationConversationId !== undefined) {
        this.assertNegotiatedPurchaseAuthority({
          buyerKind: order.buyerKind,
          buyerId: order.buyerId,
          buyerAccountIds: order.buyerAccountIds,
          sellerId: order.sellerId,
          offeringId: order.offeringId,
          sku: order.sku,
          quantity: order.requestedQuantity,
          expectedUnitPriceCents: order.unitPriceCents,
          tick,
          requestEventId: order.requestEventId,
          ids,
        }, negotiationConversationId);
      }
      const priceInvalid = negotiationConversationId === undefined
        ? offeringState.posted_price_cents !== order.unitPriceCents
        : BigInt(order.unitPriceCents) < BigInt(offeringState.average_unit_cost_cents) ||
          BigInt(order.unitPriceCents) > BigInt(offeringState.posted_price_cents);
      if (priceInvalid) {
        return this.rejectPlacedOrder(
          order,
          "price_changed",
          tick,
          toSafeNumber(offeringState.quantity, "available inventory"),
          ids,
        );
      }
      const buyer = this.validateBuyer(order.buyerKind, order.buyerId, order.buyerAccountIds);
      if (!buyer.valid) {
        return this.rejectPlacedOrder(
          order,
          "invalid_buyer",
          tick,
          toSafeNumber(offeringState.quantity, "available inventory"),
          ids,
        );
      }
      if (buyer.balanceCents < money(order.totalCents)) {
        return this.rejectPlacedOrder(
          order,
          "insufficient_funds",
          tick,
          toSafeNumber(offeringState.quantity, "available inventory"),
          ids,
        );
      }
      const inventory = inventoryFromState(offeringState);
      if (inventory.quantity < order.requestedQuantity) {
        return this.rejectPlacedOrder(order, "stockout", tick, inventory.quantity, ids);
      }
      const payment = postPayment({
        order,
        sellerAccountId: offeringState.business_account_id,
        buyerAccountIds: order.buyerAccountIds,
        totalCents: order.totalCents,
      });
      this.assertPayment(
        payment,
        order,
        offeringState.business_account_id,
        tick,
      );
      const inventoryAfter = inventoryAfterSale(inventory.quantity, order.requestedQuantity);
      const updated = this.db.prepare(`
        UPDATE company_inventory SET quantity = ?, updated_tick = ?
        WHERE run_id = ? AND id = ? AND quantity = ?
      `).run(inventoryAfter, tick, this.runId, inventory.id, inventory.quantity);
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `inventory ${inventory.id} changed during settlement`);
      }
      const movementId = ids.next("invmov");
      this.db.prepare(`
        INSERT INTO inventory_movements(
          run_id, id, inventory_id, company_id, sku, tick, kind,
          quantity_delta, quantity_after, unit_cost_cents, source_ref, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        movementId,
        inventory.id,
        inventory.companyId,
        inventory.sku,
        tick,
        -order.requestedQuantity,
        inventoryAfter,
        inventory.averageUnitCostCents,
        order.id,
        payment.sourceEventId,
      );
      this.db.prepare(`
        UPDATE goods_orders
        SET status = 'filled', filled_quantity = requested_quantity,
          settled_tick = ?, settlement_transaction_id = ?
        WHERE run_id = ? AND id = ? AND status = 'placed'
      `).run(tick, payment.transactionId, this.runId, order.id);
      return {
        order: this.getOrder(order.id),
        inventoryBefore: inventory.quantity,
        inventoryAfter,
        inventoryMovementId: movementId,
        stockout: null,
        paymentSourceEventId: payment.sourceEventId,
      };
    }).immediate();
  }

  private assertNegotiatedPurchaseAuthority(
    input: PlaceGoodsOrderInput,
    conversationId: string,
  ): void {
    if (input.buyerKind !== "agent") {
      throw new EngineError(
        "PERMISSION_DENIED",
        "negotiated purchases require the initiating agent as buyer",
      );
    }
    const row = this.db.prepare<[string, string, string], PurchaseNegotiationRow>(`
      SELECT c.participant_a_id, c.participant_b_id, c.topic, c.status,
        c.close_reason, c.outcome_canonical, c.term_bounds_canonical,
        c.terminal_event_id, co.founder_agent_id
      FROM conversations c
      JOIN market_offerings mo
        ON mo.run_id = c.run_id AND mo.id = ?
      JOIN companies co
        ON co.run_id = mo.run_id AND co.id = mo.company_id
      WHERE c.run_id = ? AND c.id = ?
    `).get(input.offeringId, this.runId, conversationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `conversation ${conversationId} does not authorize a purchase`);
    }
    if (
      row.topic !== "purchase" ||
      row.status !== "concluded" ||
      row.close_reason !== "agreement" ||
      row.outcome_canonical === null ||
      row.terminal_event_id !== input.requestEventId
    ) {
      throw new EngineError("PERMISSION_DENIED", "purchase conversation is not a final agreement");
    }
    if (row.participant_a_id !== input.buyerId || row.participant_b_id !== row.founder_agent_id) {
      throw new EngineError("PERMISSION_DENIED", "purchase participants do not own the agreed assets");
    }
    const outcome = conversationOutcomeSchema.parse(canonicalParse(row.outcome_canonical));
    const bounds = conversationTermBoundsSchema.parse(canonicalParse(row.term_bounds_canonical));
    if (
      outcome.kind !== "agreement" ||
      outcome.structuredTerms?.kind !== "purchase" ||
      outcome.structuredTerms.referenceId !== input.offeringId ||
      outcome.structuredTerms.quantity !== input.quantity ||
      outcome.structuredTerms.unitPriceCents !== input.expectedUnitPriceCents ||
      !termsWithinConversationBounds(bounds, outcome.structuredTerms)
    ) {
      throw new EngineError("VALIDATION_FAILED", "purchase order differs from binding structured terms");
    }
  }

  getOrder(orderId: string): GoodsOrder {
    const row = this.db.prepare<[string, string], OrderRow>(`
      SELECT * FROM goods_orders WHERE run_id = ? AND id = ?
    `).get(this.runId, orderId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `order ${orderId} does not exist`);
    return mapOrder(row);
  }

  listOrders(): readonly GoodsOrder[] {
    return this.db.prepare<[string], OrderRow>(`
      SELECT * FROM goods_orders WHERE run_id = ? ORDER BY placed_tick, id
    `).all(this.runId).map(mapOrder);
  }

  listStockouts(): readonly MarketStockout[] {
    return this.db.prepare<[string], StockoutRow>(`
      SELECT * FROM market_stockouts WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map(mapStockout);
  }

  listPriceHistory(offeringId?: string): readonly MarketPriceHistory[] {
    const rows = offeringId === undefined
      ? this.db.prepare<[string], PriceHistoryRow>(`
          SELECT * FROM market_price_history WHERE run_id = ? ORDER BY tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], PriceHistoryRow>(`
          SELECT * FROM market_price_history
          WHERE run_id = ? AND offering_id = ? ORDER BY tick, id
        `).all(this.runId, offeringId);
    return rows.map(mapPriceHistory);
  }

  listProductionRuns(): readonly ProductionRun[] {
    return this.db.prepare<[string], {
      run_id: string;
      id: string;
      company_id: string;
      sku: ProductSku;
      tick: bigint;
      worker_count: bigint;
      labor_hours: bigint;
      productivity_milliunits_per_labor_hour: bigint;
      capacity_units: bigint;
      units_produced: bigint;
      inventory_before: bigint;
      inventory_after: bigint;
      unit_cost_cents: string;
      source_event_id: string;
    }>(`
      SELECT * FROM production_runs WHERE run_id = ? ORDER BY tick, id
    `).all(this.runId).map((row) => productionRunSchema.parse({
      id: row.id,
      runId: row.run_id,
      companyId: row.company_id,
      sku: row.sku,
      tick: toSafeNumber(row.tick, "production tick"),
      workerCount: toSafeNumber(row.worker_count, "production worker count"),
      laborHours: toSafeNumber(row.labor_hours, "production labor hours"),
      productivityMilliunitsPerLaborHour: toSafeNumber(
        row.productivity_milliunits_per_labor_hour,
        "production productivity",
      ),
      capacityUnits: toSafeNumber(row.capacity_units, "production capacity"),
      unitsProduced: toSafeNumber(row.units_produced, "production units"),
      inventoryBefore: toSafeNumber(row.inventory_before, "inventory before"),
      inventoryAfter: toSafeNumber(row.inventory_after, "inventory after"),
      unitCostCents: row.unit_cost_cents,
      sourceEventId: row.source_event_id,
    }));
  }

  affordableQuantity(budgetCents: string, unitPriceCents: string): number {
    return affordableQuantity(money(budgetCents), money(unitPriceCents));
  }

  private priceWindowMetrics(
    companyId: string,
    sku: ProductSku,
    offeringId: string,
    tick: number,
  ): { readonly unitsSold: number; readonly unfilledUnits: number } {
    const firstTickExclusive = tick - 7;
    const sales = this.db.prepare<[string, string, string, number, number], { total: bigint }>(`
      SELECT COALESCE(-SUM(quantity_delta), 0) AS total
      FROM inventory_movements
      WHERE run_id = ? AND company_id = ? AND sku = ? AND kind = 'sale'
        AND tick > ? AND tick <= ?
    `).get(this.runId, companyId, sku, firstTickExclusive, tick)!;
    const stockouts = this.db.prepare<[string, string, number, number], { total: bigint }>(`
      SELECT COALESCE(SUM(requested_quantity - available_quantity), 0) AS total
      FROM market_stockouts
      WHERE run_id = ? AND offering_id = ? AND tick > ? AND tick <= ?
    `).get(this.runId, offeringId, firstTickExclusive, tick)!;
    return Object.freeze({
      unitsSold: toSafeNumber(sales.total, "weekly units sold"),
      unfilledUnits: toSafeNumber(stockouts.total, "weekly unfilled units"),
    });
  }

  private recordPriceChange(input: {
    readonly offering: MarketOffering;
    readonly unitCostCents: string;
    readonly inventoryQuantity: number;
    readonly unitsSold: number;
    readonly unfilledUnits: number;
    readonly inventorySalesRatioBp: number | null;
    readonly newPriceCents: string;
    readonly source: "rule" | "decision";
    readonly decisionId: string | null;
    readonly ruleSignal: MarketPriceHistory["ruleSignal"];
    readonly actorId: string;
    readonly ctx: TickContext;
  }): MarketPriceHistory | null {
    if (input.newPriceCents === input.offering.postedPriceCents) return null;
    const id = input.ctx.ids.next("mprice");
    const cause = input.decisionId === null ? "rule" : `decision:${input.decisionId}`;
    const payload = marketPriceUpdatedPayloadSchema.parse({
      id,
      offeringId: input.offering.id,
      companyId: input.offering.companyId,
      sku: input.offering.sku,
      tick: input.ctx.tick,
      oldPriceCents: input.offering.postedPriceCents,
      newPriceCents: input.newPriceCents,
      unitCostCents: input.unitCostCents,
      inventoryQuantity: input.inventoryQuantity,
      unitsSold: input.unitsSold,
      unfilledUnits: input.unfilledUnits,
      inventorySalesRatioBp: input.inventorySalesRatioBp,
      ruleSignal: input.ruleSignal,
      cause,
    });
    const sourceEvent = input.ctx.emit("market.price.updated", payload, input.source === "rule"
      ? {
          actor: { kind: "system", id: input.actorId },
          correlationId: `price:${input.offering.id}:${input.ctx.tick}`,
        }
      : {
          actor: { kind: "agent", id: input.actorId },
          correlationId: input.decisionId!,
          causationId: input.decisionId!,
        });
    const history = marketPriceHistorySchema.parse({
      id: payload.id,
      runId: this.runId,
      offeringId: payload.offeringId,
      companyId: payload.companyId,
      sku: payload.sku,
      tick: payload.tick,
      oldPriceCents: payload.oldPriceCents,
      newPriceCents: payload.newPriceCents,
      unitCostCents: payload.unitCostCents,
      inventoryQuantity: payload.inventoryQuantity,
      unitsSold: payload.unitsSold,
      unfilledUnits: payload.unfilledUnits,
      inventorySalesRatioBp: payload.inventorySalesRatioBp,
      source: input.source,
      decisionId: input.decisionId,
      ruleSignal: payload.ruleSignal,
      sourceEventId: sourceEvent.eventId,
    });
    const updated = this.db.prepare(`
      UPDATE market_offerings SET posted_price_cents = ?
      WHERE run_id = ? AND id = ? AND posted_price_cents = ? AND active = 1
    `).run(
      history.newPriceCents,
      this.runId,
      history.offeringId,
      history.oldPriceCents,
    );
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", `offering ${history.offeringId} changed during pricing`);
    }
    this.db.prepare(`
      INSERT INTO market_price_history(
        run_id, id, offering_id, company_id, sku, tick, old_price_cents,
        new_price_cents, unit_cost_cents, inventory_quantity, units_sold,
        unfilled_units, inventory_sales_ratio_bp, source, decision_id,
        rule_signal, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      history.id,
      history.offeringId,
      history.companyId,
      history.sku,
      history.tick,
      history.oldPriceCents,
      history.newPriceCents,
      history.unitCostCents,
      history.inventoryQuantity,
      history.unitsSold,
      history.unfilledUnits,
      history.inventorySalesRatioBp,
      history.source,
      history.decisionId,
      history.ruleSignal,
      history.sourceEventId,
    );
    return history;
  }

  private getOfferingState(offeringId: string): OfferingStateRow | undefined {
    return this.db.prepare<[string, string], OfferingStateRow>(`
      SELECT o.run_id, o.id AS offering_id, o.company_id, o.sku, o.posted_price_cents,
        o.active, o.created_tick, i.id AS inventory_id, i.quantity,
        i.average_unit_cost_cents, i.updated_tick, c.status AS company_status,
        c.business_account_id, c.activated_tick
      FROM market_offerings o
      JOIN company_inventory i
        ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
      JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
      WHERE o.run_id = ? AND o.id = ?
    `).get(this.runId, offeringId);
  }

  private validateBuyer(
    buyerKind: GoodsOrderBuyerKind,
    buyerId: string,
    accountIds: readonly string[],
  ): { readonly valid: boolean; readonly balanceCents: ReturnType<typeof money> } {
    if (accountIds.length === 0 || new Set(accountIds).size !== accountIds.length) {
      return { valid: false, balanceCents: money(0n) };
    }
    let allowedAgentIds: ReadonlySet<string> | null = null;
    if (buyerKind === "household") {
      const household = this.db.prepare<[string, string], { member_ids_canonical: string }>(`
        SELECT member_ids_canonical FROM households WHERE run_id = ? AND id = ?
      `).get(this.runId, buyerId);
      if (household === undefined) return { valid: false, balanceCents: money(0n) };
      allowedAgentIds = new Set(parseStringArray(
        household.member_ids_canonical,
        `household ${buyerId} members`,
      ));
    } else if (buyerKind === "company") {
      const company = this.db.prepare<[string, string], { status: string }>(`
        SELECT status FROM companies WHERE run_id = ? AND id = ?
      `).get(this.runId, buyerId);
      if (company?.status !== "active") return { valid: false, balanceCents: money(0n) };
    }
    let balance = 0n;
    for (const accountId of accountIds) {
      const account = this.db.prepare<[string, string], AccountValidationRow>(`
        SELECT id, owner_kind, owner_id, account_type, balance_cents, status
        FROM bank_accounts WHERE run_id = ? AND id = ?
      `).get(this.runId, accountId);
      if (account === undefined || account.status !== "active" ||
        account.account_type !== "checking") {
        return { valid: false, balanceCents: money(0n) };
      }
      const ownsAccount = buyerKind === "household"
        ? account.owner_kind === "agent" && allowedAgentIds!.has(account.owner_id)
        : account.owner_kind === buyerKind && account.owner_id === buyerId;
      if (!ownsAccount) return { valid: false, balanceCents: money(0n) };
      balance += BigInt(account.balance_cents);
    }
    return { valid: true, balanceCents: money(balance) };
  }

  private insertOrder(order: GoodsOrder): void {
    this.db.prepare(`
      INSERT INTO goods_orders(
        run_id, id, buyer_kind, buyer_id, buyer_account_ids_canonical,
        seller_id, offering_id, sku, requested_quantity, filled_quantity,
        unit_price_cents, total_cents, status, rejection_reason, placed_tick,
        settled_tick, request_event_id, settlement_transaction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      order.id,
      order.buyerKind,
      order.buyerId,
      canonicalStringify(order.buyerAccountIds),
      order.sellerId,
      order.offeringId,
      order.sku,
      order.requestedQuantity,
      order.filledQuantity,
      order.unitPriceCents,
      order.totalCents,
      order.status,
      order.rejectionReason,
      order.placedTick,
      order.settledTick,
      order.requestEventId,
      order.settlementTransactionId,
    );
  }

  private insertStockout(stockout: MarketStockout): void {
    this.db.prepare(`
      INSERT INTO market_stockouts(
        run_id, id, order_id, offering_id, company_id, sku, buyer_kind,
        buyer_id, tick, requested_quantity, available_quantity, request_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      stockout.id,
      stockout.orderId,
      stockout.offeringId,
      stockout.companyId,
      stockout.sku,
      stockout.buyerKind,
      stockout.buyerId,
      stockout.tick,
      stockout.requestedQuantity,
      stockout.availableQuantity,
      stockout.requestEventId,
    );
  }

  private rejectPlacedOrder(
    order: GoodsOrder,
    reason: GoodsOrderRejectionReason,
    tick: number,
    availableQuantity: number,
    ids: IdFactory,
  ): GoodsOrderSettlement {
    this.db.prepare(`
      UPDATE goods_orders SET status = 'rejected', rejection_reason = ?, settled_tick = ?
      WHERE run_id = ? AND id = ? AND status = 'placed'
    `).run(reason, tick, this.runId, order.id);
    let stockout: MarketStockout | null = null;
    if (reason === "stockout") {
      stockout = marketStockoutSchema.parse({
        id: ids.next("stkout"),
        runId: this.runId,
        orderId: order.id,
        offeringId: order.offeringId,
        companyId: order.sellerId,
        sku: order.sku,
        buyerKind: order.buyerKind,
        buyerId: order.buyerId,
        tick,
        requestedQuantity: order.requestedQuantity,
        availableQuantity,
        requestEventId: order.requestEventId,
      });
      this.insertStockout(stockout);
    }
    return {
      order: this.getOrder(order.id),
      inventoryBefore: availableQuantity,
      inventoryAfter: availableQuantity,
      inventoryMovementId: null,
      stockout,
      paymentSourceEventId: null,
    };
  }

  private assertPayment(
    payment: OrderPaymentResult,
    order: GoodsOrder,
    sellerAccountId: string,
    tick: number,
  ): void {
    const transaction = this.db.prepare<[string, string], TransactionValidationRow>(`
      SELECT tick, kind, source_event_id FROM ledger_transactions
      WHERE run_id = ? AND id = ?
    `).get(this.runId, payment.transactionId);
    if (transaction === undefined || transaction.kind !== "purchase" ||
      toSafeNumber(transaction.tick, "purchase transaction tick") !== tick ||
      transaction.source_event_id !== payment.sourceEventId) {
      throw new EngineError(
        "CONFLICT",
        `order ${order.id} payment is not a matching purchase transaction`,
      );
    }
    const legs = this.db.prepare<[string, string], LegValidationRow>(`
      SELECT account_id, direction, amount_cents FROM ledger_transaction_legs
      WHERE run_id = ? AND transaction_id = ? ORDER BY leg_index
    `).all(this.runId, payment.transactionId);
    let sellerDebit = 0n;
    let buyerCredits = 0n;
    for (const leg of legs) {
      if (leg.account_id === sellerAccountId && leg.direction === "debit") {
        sellerDebit += BigInt(leg.amount_cents);
      } else if (order.buyerAccountIds.includes(leg.account_id) && leg.direction === "credit") {
        buyerCredits += BigInt(leg.amount_cents);
      } else {
        throw new EngineError("CONFLICT", `order ${order.id} payment contains an unrelated leg`);
      }
    }
    const expected = BigInt(order.totalCents);
    if (sellerDebit !== expected || buyerCredits !== expected) {
      throw new EngineError("CONFLICT", `order ${order.id} payment amount does not match its quote`);
    }
  }
}
