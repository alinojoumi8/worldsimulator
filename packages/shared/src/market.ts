/** Authoritative goods-market contracts shared by engine and persistence. */

import { z } from "zod";
import { decisionIdSchema } from "./decision";
import { bankAccountSchema, ledgerTransactionSchema } from "./finance";
import { runIdSchema } from "./simulation";

export const PRODUCT_SKUS = [
  "groceries",
  "meals",
  "durable_goods",
  "repair_services",
  "healthcare_visit",
  "tuition",
  "electricity",
] as const;
export const productSkuSchema = z.enum(PRODUCT_SKUS);
export type ProductSku = z.infer<typeof productSkuSchema>;

export const productKindSchema = z.enum(["good", "service"]);
export const productBasketCategorySchema = z.enum([
  "food",
  "discretionary",
  "utilities",
]);

const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/);
const nonnegativeCentsSchema = z.string().regex(/^\d+$/);
const safeQuantitySchema = z.number().int().nonnegative().safe();

export const productCatalogItemSchema = z.object({
  sku: productSkuSchema,
  name: z.string().trim().min(1).max(120),
  kind: productKindSchema,
  unit: z.string().trim().min(1).max(80),
  basketCategory: productBasketCategorySchema,
  inventoried: z.boolean(),
  basketWeightBp: z.number().int().min(0).max(10_000),
  rowReferencePriceCents: positiveCentsSchema,
  rulesetVersion: z.number().int().positive().safe(),
}).strict();
export type ProductCatalogItem = z.infer<typeof productCatalogItemSchema>;

export const marketOfferingSchema = z.object({
  id: z.string().regex(/^off_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  companyId: z.string().regex(/^co_[0-9a-z]{8,}$/),
  sku: productSkuSchema,
  postedPriceCents: positiveCentsSchema,
  active: z.boolean(),
  createdTick: z.number().int().nonnegative().safe(),
}).strict();
export type MarketOffering = z.infer<typeof marketOfferingSchema>;

export const productionProfileSchema = z.object({
  runId: runIdSchema,
  companyId: marketOfferingSchema.shape.companyId,
  sku: productSkuSchema,
  laborHoursPerWorker: z.number().int().min(1).max(24),
  productivityMilliunitsPerLaborHour: z.number().int().positive().safe(),
  capacityUnitsPerTick: z.number().int().positive().safe(),
  unitCostCents: positiveCentsSchema,
}).strict();
export type ProductionProfile = z.infer<typeof productionProfileSchema>;

export const companyInventorySchema = z.object({
  id: z.string().regex(/^invt_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  companyId: marketOfferingSchema.shape.companyId,
  sku: productSkuSchema,
  quantity: safeQuantitySchema,
  averageUnitCostCents: nonnegativeCentsSchema,
  updatedTick: z.number().int().nonnegative().safe(),
}).strict();
export type CompanyInventory = z.infer<typeof companyInventorySchema>;

export const productionRunSchema = z.object({
  id: z.string().regex(/^prod_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  companyId: marketOfferingSchema.shape.companyId,
  sku: productSkuSchema,
  tick: z.number().int().positive().safe(),
  workerCount: safeQuantitySchema,
  laborHours: safeQuantitySchema,
  productivityMilliunitsPerLaborHour: z.number().int().positive().safe(),
  capacityUnits: z.number().int().positive().safe(),
  unitsProduced: z.number().int().positive().safe(),
  inventoryBefore: safeQuantitySchema,
  inventoryAfter: z.number().int().positive().safe(),
  unitCostCents: positiveCentsSchema,
  sourceEventId: z.string().min(1),
}).strict();
export type ProductionRun = z.infer<typeof productionRunSchema>;

export const GOODS_ORDER_BUYER_KINDS = ["agent", "household", "company"] as const;
export const goodsOrderBuyerKindSchema = z.enum(GOODS_ORDER_BUYER_KINDS);
export type GoodsOrderBuyerKind = z.infer<typeof goodsOrderBuyerKindSchema>;

export const GOODS_ORDER_REJECTION_REASONS = [
  "stockout",
  "insufficient_funds",
  "inactive_offering",
  "invalid_buyer",
  "price_changed",
] as const;
export const goodsOrderRejectionReasonSchema = z.enum(GOODS_ORDER_REJECTION_REASONS);
export type GoodsOrderRejectionReason = z.infer<typeof goodsOrderRejectionReasonSchema>;

export const goodsOrderSchema = z.object({
  id: z.string().regex(/^gord_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  buyerKind: goodsOrderBuyerKindSchema,
  buyerId: z.string().min(1),
  buyerAccountIds: z.array(bankAccountSchema.shape.id).min(1),
  sellerId: marketOfferingSchema.shape.companyId,
  offeringId: marketOfferingSchema.shape.id,
  sku: productSkuSchema,
  requestedQuantity: z.number().int().positive().safe(),
  filledQuantity: safeQuantitySchema,
  unitPriceCents: positiveCentsSchema,
  totalCents: positiveCentsSchema,
  status: z.enum(["placed", "filled", "rejected"]),
  rejectionReason: goodsOrderRejectionReasonSchema.nullable(),
  placedTick: z.number().int().nonnegative().safe(),
  settledTick: z.number().int().nonnegative().safe().nullable(),
  requestEventId: z.string().min(1),
  settlementTransactionId: ledgerTransactionSchema.shape.id.nullable(),
}).strict().superRefine((order, ctx) => {
  if (order.status === "placed") {
    if (order.filledQuantity !== 0 || order.rejectionReason !== null ||
      order.settledTick !== null || order.settlementTransactionId !== null) {
      ctx.addIssue({ code: "custom", message: "placed orders cannot have a settlement" });
    }
  } else if (order.status === "filled") {
    if (order.filledQuantity !== order.requestedQuantity || order.rejectionReason !== null ||
      order.settledTick === null || order.settlementTransactionId === null) {
      ctx.addIssue({ code: "custom", message: "filled orders require a complete settlement" });
    }
  } else if (order.filledQuantity !== 0 || order.rejectionReason === null ||
    order.settledTick === null || order.settlementTransactionId !== null) {
    ctx.addIssue({ code: "custom", message: "rejected orders require a rejection reason" });
  }
});
export type GoodsOrder = z.infer<typeof goodsOrderSchema>;

export const marketStockoutSchema = z.object({
  id: z.string().regex(/^stkout_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  orderId: goodsOrderSchema.shape.id,
  offeringId: marketOfferingSchema.shape.id,
  companyId: marketOfferingSchema.shape.companyId,
  sku: productSkuSchema,
  buyerKind: goodsOrderBuyerKindSchema,
  buyerId: z.string().min(1),
  tick: z.number().int().nonnegative().safe(),
  requestedQuantity: z.number().int().positive().safe(),
  availableQuantity: safeQuantitySchema,
  requestEventId: z.string().min(1),
}).strict().refine(
  (stockout) => stockout.availableQuantity < stockout.requestedQuantity,
  { message: "stockout availability must be below requested quantity" },
);
export type MarketStockout = z.infer<typeof marketStockoutSchema>;

export const MARKET_PRICE_UPDATE_SOURCES = ["rule", "decision"] as const;
export const marketPriceUpdateSourceSchema = z.enum(MARKET_PRICE_UPDATE_SOURCES);
export const MARKET_PRICE_RULE_SIGNALS = [
  "bound_correction",
  "stockout",
  "low_inventory",
  "balanced",
  "excess_inventory",
  "no_sales",
  "no_activity",
] as const;
export const marketPriceRuleSignalSchema = z.enum(MARKET_PRICE_RULE_SIGNALS);

const marketPriceHistoryBaseSchema = z.object({
  id: z.string().regex(/^mprice_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  offeringId: marketOfferingSchema.shape.id,
  companyId: marketOfferingSchema.shape.companyId,
  sku: productSkuSchema,
  tick: z.number().int().nonnegative().safe(),
  oldPriceCents: positiveCentsSchema,
  newPriceCents: positiveCentsSchema,
  unitCostCents: positiveCentsSchema,
  inventoryQuantity: safeQuantitySchema,
  unitsSold: safeQuantitySchema,
  unfilledUnits: safeQuantitySchema,
  inventorySalesRatioBp: z.number().int().nonnegative().safe().nullable(),
  source: marketPriceUpdateSourceSchema,
  decisionId: decisionIdSchema.nullable(),
  ruleSignal: marketPriceRuleSignalSchema.nullable(),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
}).strict();

export const marketPriceHistorySchema = marketPriceHistoryBaseSchema.superRefine((entry, ctx) => {
  if (entry.oldPriceCents === entry.newPriceCents) {
    ctx.addIssue({ code: "custom", message: "price history requires an actual price change" });
  }
  if (entry.source === "rule" && (entry.decisionId !== null || entry.ruleSignal === null)) {
    ctx.addIssue({ code: "custom", message: "rule updates require a rule signal only" });
  }
  if (entry.source === "decision" && (entry.decisionId === null || entry.ruleSignal !== null)) {
    ctx.addIssue({ code: "custom", message: "decision updates require a decision ID only" });
  }
});
export type MarketPriceHistory = z.infer<typeof marketPriceHistorySchema>;

export const marketPriceUpdatedPayloadSchema = marketPriceHistoryBaseSchema.omit({
  runId: true,
  source: true,
  decisionId: true,
  sourceEventId: true,
}).extend({
  cause: z.union([
    z.literal("rule"),
    z.string().regex(/^decision:dec_[0-9a-z]{8,}$/),
  ]),
}).strict();
export type MarketPriceUpdatedPayload = z.infer<typeof marketPriceUpdatedPayloadSchema>;
