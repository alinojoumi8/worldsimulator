/** Authoritative M17 energy contracts shared by engine and persistence. */

import { z } from "zod";
import { bankAccountSchema, ledgerTransactionSchema } from "./finance";
import { runIdSchema } from "./simulation";

const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/);
const nonnegativeIntegerStringSchema = z.string().regex(/^\d+$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

export const ENERGY_CUSTOMER_CLASSES = ["household", "business"] as const;
export const energyCustomerClassSchema = z.enum(ENERGY_CUSTOMER_CLASSES);
export type EnergyCustomerClass = z.infer<typeof energyCustomerClassSchema>;

export const energySystemSchema = z.object({
  runId: runIdSchema,
  utilityId: z.literal("inst_riverbend_power"),
  utilityAccountId: bankAccountSchema.shape.id,
  rowAccountId: bankAccountSchema.shape.id,
  billingIntervalTicks: z.number().int().positive().safe(),
  passThroughBp: z.number().int().min(0).max(10_000),
  minimumTariffBp: z.number().int().positive().max(10_000),
  maximumTariffBp: z.number().int().min(10_000).max(100_000),
  minimumFuelPriceBp: z.number().int().positive().max(10_000),
  maximumFuelPriceBp: z.number().int().min(10_000).max(100_000),
  referenceFuelPriceCents: positiveCentsSchema,
  householdBaseTariffCents: positiveCentsSchema,
  businessBaseTariffCents: positiveCentsSchema,
  rulesetVersion: z.number().int().positive().safe(),
  sourceEventId: eventIdSchema,
}).strict().refine(
  (system) => system.minimumTariffBp <= system.maximumTariffBp &&
    system.minimumFuelPriceBp <= system.maximumFuelPriceBp,
  { message: "energy system bounds are inverted" },
);
export type EnergySystem = z.infer<typeof energySystemSchema>;

export const energyTariffSchema = z.object({
  id: z.string().regex(/^etar_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  customerClass: energyCustomerClassSchema,
  effectiveTick: z.number().int().nonnegative().safe(),
  priceCents: positiveCentsSchema,
  fuelPriceCents: positiveCentsSchema,
  source: z.enum(["world_gen", "fuel_pass_through"]),
  causeEventId: eventIdSchema.nullable(),
  sourceEventId: eventIdSchema,
  rulesetVersion: z.number().int().positive().safe(),
}).strict();
export type EnergyTariff = z.infer<typeof energyTariffSchema>;

export const energyFuelPriceSchema = z.object({
  id: z.string().regex(/^efuel_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  tick: z.number().int().nonnegative().safe(),
  oldPriceCents: positiveCentsSchema.nullable(),
  newPriceCents: positiveCentsSchema,
  changeBp: z.number().int().min(-9_999).max(100_000),
  nextTariffTick: z.number().int().nonnegative().safe(),
  source: z.enum(["world_gen", "world_event", "test"]),
  causeEventId: eventIdSchema.nullable(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((entry, ctx) => {
  if (entry.source === "world_gen" && entry.oldPriceCents !== null) {
    ctx.addIssue({ code: "custom", message: "world-gen fuel prices cannot have an old price" });
  }
  if (entry.source !== "world_gen" && entry.oldPriceCents === null) {
    ctx.addIssue({ code: "custom", message: "fuel-price changes require an old price" });
  }
});
export type EnergyFuelPrice = z.infer<typeof energyFuelPriceSchema>;

export const ENERGY_BILL_REJECTION_REASONS = ["insufficient_funds"] as const;
export const energyBillRejectionReasonSchema = z.enum(ENERGY_BILL_REJECTION_REASONS);

export const energyBillSchema = z.object({
  id: z.string().regex(/^ebill_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  customerClass: energyCustomerClassSchema,
  customerId: z.string().min(1),
  customerAccountIds: z.array(bankAccountSchema.shape.id).min(1),
  tariffId: energyTariffSchema.shape.id,
  tick: z.number().int().positive().safe(),
  units: z.number().int().positive().safe(),
  unitPriceCents: positiveCentsSchema,
  amountCents: positiveCentsSchema,
  fuelMilliunits: z.number().int().positive().safe(),
  status: z.enum(["paid", "rejected"]),
  rejectionReason: energyBillRejectionReasonSchema.nullable(),
  transactionId: ledgerTransactionSchema.shape.id.nullable(),
  evidenceRefs: z.array(z.string().min(1)),
  requestEventId: eventIdSchema,
  sourceEventId: eventIdSchema,
}).strict().superRefine((bill, ctx) => {
  if (bill.status === "paid" && (bill.rejectionReason !== null || bill.transactionId === null)) {
    ctx.addIssue({ code: "custom", message: "paid energy bills require a transaction only" });
  }
  if (bill.status === "rejected" &&
    (bill.rejectionReason === null || bill.transactionId !== null)) {
    ctx.addIssue({ code: "custom", message: "rejected energy bills require a reason only" });
  }
});
export type EnergyBill = z.infer<typeof energyBillSchema>;

export const energyFuelPurchaseSchema = z.object({
  id: z.string().regex(/^efpur_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  tick: z.number().int().positive().safe(),
  fuelPriceId: energyFuelPriceSchema.shape.id,
  fuelMilliunits: z.number().int().positive().safe(),
  unitPriceCents: positiveCentsSchema,
  totalCents: positiveCentsSchema,
  billIds: z.array(energyBillSchema.shape.id).min(1),
  transactionId: ledgerTransactionSchema.shape.id,
  sourceEventId: eventIdSchema,
}).strict();
export type EnergyFuelPurchase = z.infer<typeof energyFuelPurchaseSchema>;

export const energyMarketPriceUpdatedPayloadSchema = z.object({
  sku: z.literal("electricity"),
  tariffId: energyTariffSchema.shape.id,
  customerClass: energyCustomerClassSchema,
  effectiveTick: z.number().int().nonnegative().safe(),
  oldPriceCents: positiveCentsSchema,
  newPriceCents: positiveCentsSchema,
  fuelPriceCents: positiveCentsSchema,
  passThroughBp: z.number().int().min(0).max(10_000),
  cause: z.literal("fuel_pass_through"),
  causeEventId: eventIdSchema,
}).strict().refine(
  (payload) => payload.oldPriceCents !== payload.newPriceCents,
  { message: "tariff updates require an actual price change" },
);
export type EnergyMarketPriceUpdatedPayload = z.infer<
  typeof energyMarketPriceUpdatedPayloadSchema
>;

export const energyStateDigestSchema = z.object({
  householdTariffCents: positiveCentsSchema,
  businessTariffCents: positiveCentsSchema,
  fuelPriceCents: positiveCentsSchema,
  paidBillCents: nonnegativeIntegerStringSchema,
}).strict();
