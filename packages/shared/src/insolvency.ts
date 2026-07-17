/** Authoritative WS-407 solvency, liquidation, and creditor-waterfall contracts. */

import { z } from "zod";
import { bankAccountSchema } from "./finance";
import { companyIdSchema } from "./legal";
import { productSkuSchema } from "./market";
import { runIdSchema } from "./simulation";

const domainId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{8,}$`));
const nonnegativeCents = z.string().regex(/^\d+$/);
const positiveCents = z.string().regex(/^[1-9]\d*$/);

export const companySolvencyAssessmentSchema = z.object({
  id: domainId("solv"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  tick: z.number().int().nonnegative().safe(),
  cashCents: nonnegativeCents,
  obligationCents: nonnegativeCents,
  shortfallCents: nonnegativeCents,
  consecutiveShortfallDays: z.number().int().nonnegative().safe(),
  insolvent: z.boolean(),
  rulesetVersion: z.number().int().positive().safe(),
  sourceEventId: z.string().min(1),
}).strict().superRefine((assessment, ctx) => {
  const expected = BigInt(assessment.obligationCents) > BigInt(assessment.cashCents)
    ? BigInt(assessment.obligationCents) - BigInt(assessment.cashCents)
    : 0n;
  if (BigInt(assessment.shortfallCents) !== expected) {
    ctx.addIssue({ code: "custom", path: ["shortfallCents"], message: "shortfall must be exact" });
  }
  if ((expected === 0n) !== (assessment.consecutiveShortfallDays === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["consecutiveShortfallDays"],
      message: "shortfall streak must reset exactly when there is no shortfall",
    });
  }
});
export type CompanySolvencyAssessment = z.infer<typeof companySolvencyAssessmentSchema>;

export const COMPANY_CREDITOR_KINDS = [
  "employee_wage",
  "secured_debt",
  "tax",
  "trade",
  "unsecured_debt",
  "equity_residual",
] as const;
export const companyCreditorKindSchema = z.enum(COMPANY_CREDITOR_KINDS);
export type CompanyCreditorKind = z.infer<typeof companyCreditorKindSchema>;

export const COMPANY_CLAIM_ORIGIN_KINDS = [
  "employment",
  "energy_bill",
  "legal_obligation",
  "loan",
  "manual",
  "equity_residual",
] as const;
export const companyClaimOriginKindSchema = z.enum(COMPANY_CLAIM_ORIGIN_KINDS);
export type CompanyClaimOriginKind = z.infer<typeof companyClaimOriginKindSchema>;

export const companyCreditorClaimSchema = z.object({
  id: domainId("clm"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  creditorKind: companyCreditorKindSchema,
  creditorId: z.string().trim().min(1).max(120),
  creditorAccountId: bankAccountSchema.shape.id,
  seniority: z.number().int().min(1).max(10_000).safe(),
  amountCents: positiveCents,
  originKind: companyClaimOriginKindSchema,
  originId: z.string().trim().min(1).max(200),
  registeredTick: z.number().int().nonnegative().safe(),
  sourceEventId: z.string().min(1),
}).strict();
export type CompanyCreditorClaim = z.infer<typeof companyCreditorClaimSchema>;

export const companyCreditorRecoverySchema = z.object({
  id: domainId("rcv"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  claimId: companyCreditorClaimSchema.shape.id,
  tick: z.number().int().nonnegative().safe(),
  amountCents: positiveCents,
  transactionId: z.string().regex(/^txn_[0-9a-z]{8,}$/),
  sourceEventId: z.string().min(1),
}).strict();
export type CompanyCreditorRecovery = z.infer<typeof companyCreditorRecoverySchema>;

export const companyCreditorWriteOffSchema = z.object({
  id: domainId("wof"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  claimId: companyCreditorClaimSchema.shape.id,
  tick: z.number().int().nonnegative().safe(),
  amountCents: positiveCents,
  sourceEventId: z.string().min(1),
}).strict();
export type CompanyCreditorWriteOff = z.infer<typeof companyCreditorWriteOffSchema>;

export const companyInventorySalvageSchema = z.object({
  id: domainId("slv"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  inventoryId: z.string().regex(/^invt_[0-9a-z]{8,}$/),
  sku: productSkuSchema,
  tick: z.number().int().nonnegative().safe(),
  quantity: z.number().int().positive().safe(),
  unitPriceCents: positiveCents,
  totalCents: positiveCents,
  transactionId: z.string().regex(/^txn_[0-9a-z]{8,}$/),
  sourceEventId: z.string().min(1),
}).strict().superRefine((salvage, ctx) => {
  if (BigInt(salvage.totalCents) !== BigInt(salvage.unitPriceCents) * BigInt(salvage.quantity)) {
    ctx.addIssue({ code: "custom", path: ["totalCents"], message: "salvage total must be exact" });
  }
});
export type CompanyInventorySalvage = z.infer<typeof companyInventorySalvageSchema>;

export const companyWindDownSchema = z.object({
  id: domainId("wnd"),
  runId: runIdSchema,
  companyId: companyIdSchema,
  startedTick: z.number().int().nonnegative().safe(),
  completedTick: z.number().int().nonnegative().safe(),
  openingCashCents: nonnegativeCents,
  salvageProceedsCents: nonnegativeCents,
  liquidationPoolCents: nonnegativeCents,
  creditorRecoveriesCents: nonnegativeCents,
  writtenOffCents: nonnegativeCents,
  employeesTerminated: z.number().int().nonnegative().safe(),
  contractsTerminated: z.number().int().nonnegative().safe(),
  jobsWithdrawn: z.number().int().nonnegative().safe(),
  offeringsDeactivated: z.number().int().nonnegative().safe(),
  accountsClosed: z.array(bankAccountSchema.shape.id),
  causeChain: z.array(z.string().min(1)).min(1),
  sourceEventId: z.string().min(1),
}).strict().superRefine((windDown, ctx) => {
  if (windDown.completedTick < windDown.startedTick) {
    ctx.addIssue({ code: "custom", path: ["completedTick"], message: "wind-down cannot complete before it starts" });
  }
  const pool = BigInt(windDown.openingCashCents) + BigInt(windDown.salvageProceedsCents);
  if (BigInt(windDown.liquidationPoolCents) !== pool) {
    ctx.addIssue({ code: "custom", path: ["liquidationPoolCents"], message: "liquidation pool must be exact" });
  }
  if (BigInt(windDown.creditorRecoveriesCents) !== pool) {
    ctx.addIssue({
      code: "custom",
      path: ["creditorRecoveriesCents"],
      message: "recoveries plus the residual tier must allocate the full pool",
    });
  }
});
export type CompanyWindDown = z.infer<typeof companyWindDownSchema>;
