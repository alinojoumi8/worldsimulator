import { z } from "zod";
import { productSkuSchema } from "./market";
import { companyIdSchema } from "./legal";
import { runIdSchema } from "./simulation";

export const WORLD_EVENT_TYPES = [
  "energy.fuel_price_shock",
  "row.reference_price_shift",
  "market.demand_shock",
  "business.disaster",
] as const;

export const worldEventTypeSchema = z.enum(WORLD_EVENT_TYPES);
export const worldEventSourceSchema = z.enum(["admin", "scenario"]);
export const worldEventStatusSchema = z.enum(["scheduled", "applied", "cancelled"]);

export const energyFuelPriceShockParamsSchema = z.object({
  deltaPct: z.number().int().min(-99).max(1_000).safe(),
}).strict();

export const rowReferencePriceShiftParamsSchema = z.object({
  sku: productSkuSchema,
  deltaPct: z.number().int().min(-90).max(500).safe(),
}).strict();

export const marketDemandShockParamsSchema = z.object({
  sku: productSkuSchema,
  deltaPct: z.number().int().min(-90).max(500).safe(),
  durationTicks: z.number().int().min(1).max(360).safe(),
}).strict();

export const businessDisasterParamsSchema = z.object({
  companyId: companyIdSchema,
  capacityReductionPct: z.number().int().min(1).max(100).safe(),
  durationTicks: z.number().int().min(1).max(360).safe(),
}).strict();

export const worldEventSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("energy.fuel_price_shock"),
    params: energyFuelPriceShockParamsSchema,
  }).strict(),
  z.object({
    type: z.literal("row.reference_price_shift"),
    params: rowReferencePriceShiftParamsSchema,
  }).strict(),
  z.object({
    type: z.literal("market.demand_shock"),
    params: marketDemandShockParamsSchema,
  }).strict(),
  z.object({
    type: z.literal("business.disaster"),
    params: businessDisasterParamsSchema,
  }).strict(),
]);

const injectionCommonShape = {
  runId: runIdSchema.optional(),
  scheduleTick: z.number().int().positive().safe().optional(),
};

export const injectWorldEventRequestSchema = z.discriminatedUnion("type", [
  z.object({
    ...injectionCommonShape,
    type: z.literal("energy.fuel_price_shock"),
    params: energyFuelPriceShockParamsSchema,
  }).strict(),
  z.object({
    ...injectionCommonShape,
    type: z.literal("row.reference_price_shift"),
    params: rowReferencePriceShiftParamsSchema,
  }).strict(),
  z.object({
    ...injectionCommonShape,
    type: z.literal("market.demand_shock"),
    params: marketDemandShockParamsSchema,
  }).strict(),
  z.object({
    ...injectionCommonShape,
    type: z.literal("business.disaster"),
    params: businessDisasterParamsSchema,
  }).strict(),
]);

const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

const worldEventCommonShape = {
  id: z.string().regex(/^wev_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  source: worldEventSourceSchema,
  status: worldEventStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  scheduledTick: z.number().int().positive().safe(),
  appliedTick: z.number().int().nonnegative().safe().nullable(),
  taskId: z.string().regex(/^task_[0-9a-z]{8,}$/),
  commandEventId: eventIdSchema,
  injectedEventId: eventIdSchema,
  appliedEventId: eventIdSchema.nullable(),
  effectEventIds: z.array(eventIdSchema),
  catalogVersion: z.number().int().positive().safe(),
};

export const worldEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...worldEventCommonShape,
    type: z.literal("energy.fuel_price_shock"),
    params: energyFuelPriceShockParamsSchema,
  }).strict(),
  z.object({
    ...worldEventCommonShape,
    type: z.literal("row.reference_price_shift"),
    params: rowReferencePriceShiftParamsSchema,
  }).strict(),
  z.object({
    ...worldEventCommonShape,
    type: z.literal("market.demand_shock"),
    params: marketDemandShockParamsSchema,
  }).strict(),
  z.object({
    ...worldEventCommonShape,
    type: z.literal("business.disaster"),
    params: businessDisasterParamsSchema,
  }).strict(),
]);

export const rowReferencePriceChangeSchema = z.object({
  id: z.string().regex(/^wrp_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  worldEventId: z.string().regex(/^wev_[0-9a-z]{8,}$/),
  sku: productSkuSchema,
  effectiveTick: z.number().int().positive().safe(),
  oldPriceCents: z.string().regex(/^[1-9]\d*$/),
  newPriceCents: z.string().regex(/^[1-9]\d*$/),
  changeBp: z.number().int().min(-9_000).max(50_000).safe(),
  sourceEventId: eventIdSchema,
}).strict();

export const marketDemandShockSchema = z.object({
  id: z.string().regex(/^dsh_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  worldEventId: z.string().regex(/^wev_[0-9a-z]{8,}$/),
  sku: productSkuSchema,
  effectiveTick: z.number().int().positive().safe(),
  expiresTick: z.number().int().positive().safe(),
  changeBp: z.number().int().min(-9_000).max(50_000).safe(),
  sourceEventId: eventIdSchema,
}).strict().refine(
  (value) => value.expiresTick >= value.effectiveTick,
  { path: ["expiresTick"], message: "demand shock expiry precedes its effective tick" },
);

export const companyCapacityDisasterSchema = z.object({
  id: z.string().regex(/^bds_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  worldEventId: z.string().regex(/^wev_[0-9a-z]{8,}$/),
  companyId: companyIdSchema,
  effectiveTick: z.number().int().positive().safe(),
  expiresTick: z.number().int().positive().safe(),
  capacityReductionBp: z.number().int().min(100).max(10_000).safe(),
  sourceEventId: eventIdSchema,
}).strict().refine(
  (value) => value.expiresTick >= value.effectiveTick,
  { path: ["expiresTick"], message: "business disaster expiry precedes its effective tick" },
);

export type WorldEventType = z.infer<typeof worldEventTypeSchema>;
export type WorldEventSource = z.infer<typeof worldEventSourceSchema>;
export type WorldEventStatus = z.infer<typeof worldEventStatusSchema>;
export type WorldEventSpec = z.infer<typeof worldEventSpecSchema>;
export type InjectWorldEventRequest = z.infer<typeof injectWorldEventRequestSchema>;
export type WorldEvent = z.infer<typeof worldEventSchema>;
export type RowReferencePriceChange = z.infer<typeof rowReferencePriceChangeSchema>;
export type MarketDemandShock = z.infer<typeof marketDemandShockSchema>;
export type CompanyCapacityDisaster = z.infer<typeof companyCapacityDisasterSchema>;
