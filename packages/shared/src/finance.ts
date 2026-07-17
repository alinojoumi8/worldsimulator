/** Authoritative finance contracts shared by the engine, persistence, and API. */

import { z } from "zod";
import { actorRefSchema } from "./envelope";
import { runIdSchema, simulationIdSchema } from "./simulation";

export const BANK_STATUSES = ["active", "lending_halted", "closed"] as const;
export const bankStatusSchema = z.enum(BANK_STATUSES);
export type BankStatus = z.infer<typeof bankStatusSchema>;

export const ACCOUNT_OWNER_KINDS = [
  "agent",
  "company",
  "government",
  "bank_internal",
  "system_row",
] as const;
export const accountOwnerKindSchema = z.enum(ACCOUNT_OWNER_KINDS);
export type AccountOwnerKind = z.infer<typeof accountOwnerKindSchema>;

export const BANK_ACCOUNT_TYPES = [
  "checking",
  "internal_asset",
  "internal_liability",
  "internal_income",
  "internal_expense",
  "equity",
] as const;
export const bankAccountTypeSchema = z.enum(BANK_ACCOUNT_TYPES);
export type BankAccountType = z.infer<typeof bankAccountTypeSchema>;

export const bankSchema = z.object({
  id: z.string().regex(/^bank_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  name: z.string().trim().min(1).max(120),
  capitalCents: z.string().regex(/^\d+$/),
  reserveRatioBp: z.number().int().min(0).max(10_000),
  capitalRatioMinBp: z.number().int().min(0).max(10_000),
  baseLendingRateBp: z.number().int().min(0).max(100_000),
  exposureCapCents: z.string().regex(/^\d+$/),
  status: bankStatusSchema,
});
export type Bank = z.infer<typeof bankSchema>;

export const bankPathSchema = z.object({
  simId: simulationIdSchema,
  bankId: bankSchema.shape.id,
}).strict();

export const bankAccountSchema = z.object({
  id: z.string().regex(/^acct_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  bankId: bankSchema.shape.id,
  ownerKind: accountOwnerKindSchema,
  ownerId: z.string().min(1),
  type: bankAccountTypeSchema,
  balanceCents: z.string().regex(/^-?\d+$/),
  floorCents: z.string().regex(/^-?\d+$/),
  status: z.enum(["active", "frozen", "closed"]),
  openedTick: z.number().int().nonnegative().safe(),
});
export type BankAccount = z.infer<typeof bankAccountSchema>;

export const TRANSACTION_KINDS = [
  "payroll",
  "purchase",
  "loan_disbursement",
  "loan_payment",
  "tax",
  "benefit",
  "transfer",
  "fee",
  "dividend",
  "mint",
  "row_settlement",
] as const;
export const transactionKindSchema = z.enum(TRANSACTION_KINDS);
export type TransactionKind = z.infer<typeof transactionKindSchema>;

export const transactionDirectionSchema = z.enum(["debit", "credit"]);
export type TransactionDirection = z.infer<typeof transactionDirectionSchema>;

export const transactionLegSchema = z.object({
  accountId: bankAccountSchema.shape.id,
  direction: transactionDirectionSchema,
  amountCents: z.string().regex(/^[1-9]\d*$/),
});
export type TransactionLeg = z.infer<typeof transactionLegSchema>;

export const ledgerTransactionSchema = z.object({
  id: z.string().regex(/^txn_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  tick: z.number().int().nonnegative().safe(),
  kind: transactionKindSchema,
  actor: actorRefSchema,
  reason: z.string().trim().min(1).max(500),
  sourceEventId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(300),
  legs: z.array(transactionLegSchema).min(2),
});
export type LedgerTransaction = z.infer<typeof ledgerTransactionSchema>;

export const employmentContractSchema = z.object({
  id: z.string().regex(/^emp_[0-9a-z]{8,}$/),
  runId: runIdSchema,
  employerId: z.string().min(1),
  employeeAgentId: z.string().regex(/^agt_[0-9a-z]{8,}$/),
  annualWageCents: z.string().regex(/^[1-9]\d*$/),
  startTick: z.number().int().nonnegative().safe(),
  endTick: z.number().int().nonnegative().safe().nullable(),
  noticeDays: z.number().int().nonnegative().safe(),
  status: z.enum(["active", "ended"]),
  legalContractId: z.string().min(1).nullable(),
});
export type EmploymentContract = z.infer<typeof employmentContractSchema>;

export const POLICY_KEYS = [
  "personal_withholding_rate_bp",
  "unemployment_benefit_annual_cents",
  "food_monthly_per_person_cents",
  "utilities_monthly_cents",
] as const;
export const policyKeySchema = z.enum(POLICY_KEYS);
export type PolicyKey = z.infer<typeof policyKeySchema>;

export const INDICATOR_KEYS = [
  "gdp_proxy_cents",
  "cpi_index",
  "m1_cents",
  "average_wage_cents",
  "unemployment_rate_bp",
  "credit_outstanding_cents",
  "default_rate_bp",
  "active_business_count",
  "treasury_balance_cents",
  "sentiment_index_bp",
] as const;
export const indicatorKeySchema = z.enum(INDICATOR_KEYS);
export type IndicatorKey = z.infer<typeof indicatorKeySchema>;

export const INDICATOR_SERIES_NAMES = [
  "gdpProxy",
  "cpi",
  "m1",
  "averageWage",
  "unemploymentRate",
  "creditOutstanding",
  "defaultRate",
  "businessCount",
  "treasuryBalance",
  "sentimentIndex",
] as const;
export const indicatorSeriesNameSchema = z.enum(INDICATOR_SERIES_NAMES);
export type IndicatorSeriesName = z.infer<typeof indicatorSeriesNameSchema>;

export const transactionListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  accountId: bankAccountSchema.shape.id.optional(),
  kind: transactionKindSchema.optional(),
  fromTick: z.coerce.number().int().nonnegative().safe().optional(),
  toTick: z.coerce.number().int().nonnegative().safe().optional(),
  correlationId: z.string().min(1).optional(),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined || query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

export const indicatorSeriesQuerySchema = z.object({
  runId: runIdSchema.optional(),
  series: z.union([
    indicatorSeriesNameSchema,
    z.string().transform((value, ctx) => {
      const values = value.split(",").filter((entry) => entry.length > 0);
      const parsed = z.array(indicatorSeriesNameSchema).min(1).max(10).safeParse(values);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "invalid indicator series" });
        return z.NEVER;
      }
      return parsed.data;
    }),
  ]).transform((value) => Array.isArray(value) ? value : [value]),
  fromTick: z.coerce.number().int().nonnegative().safe().optional(),
  toTick: z.coerce.number().int().nonnegative().safe().optional(),
  step: z.coerce.number().int().min(1).max(10_000).default(1),
  max: z.coerce.number().int().min(1).max(5_000).default(1_000),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined || query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type IndicatorSeriesQuery = z.infer<typeof indicatorSeriesQuerySchema>;

const financeApiMetaSchema = z.object({ simulated: z.literal(true), apiVersion: z.literal(1) });

export const bankListResponseSchema = z.object({
  items: z.array(z.object({
    id: bankSchema.shape.id,
    name: z.string().min(1),
    totalDeposits: z.string().regex(/^\d+$/),
    totalLoans: z.string().regex(/^\d+$/),
    capitalRatioBp: z.number().int(),
    reserveRatioBp: z.number().int(),
    lendingHalted: z.boolean(),
  }).strict()),
  nextCursor: z.string().min(1).nullable(),
  meta: financeApiMetaSchema,
}).strict();
export type BankListResponse = z.infer<typeof bankListResponseSchema>;

export const bankDetailResponseSchema = z.object({
  bank: bankListResponseSchema.shape.items.element.extend({
    accounts: z.object({ count: z.number().int().nonnegative().safe() }).strict(),
    loanBook: z.object({
      active: z.number().int().nonnegative().safe(),
      defaulted: z.number().int().nonnegative().safe(),
      writtenOff: z.number().int().nonnegative().safe(),
    }).strict(),
    incomeStatement30: z.object({
      interestIncome: z.string().regex(/^\d+$/),
      writeDowns: z.string().regex(/^\d+$/),
    }).strict(),
  }).strict(),
  meta: financeApiMetaSchema,
}).strict();
export type BankDetailResponse = z.infer<typeof bankDetailResponseSchema>;

export const indicatorSeriesResponseSchema = z.object({
  series: z.array(z.object({
    name: indicatorSeriesNameSchema,
    unit: z.enum(["cents", "bp", "index", "count"]),
    points: z.array(z.tuple([
      z.number().int().nonnegative().safe(),
      z.union([
        z.string().regex(/^-?\d+$/),
        z.number().int().safe(),
      ]),
    ])),
  }).strict()),
  meta: financeApiMetaSchema,
}).strict();
export type IndicatorSeriesResponse = z.infer<typeof indicatorSeriesResponseSchema>;

export const transactionListResponseSchema = z.object({
  items: z.array(z.object({
    id: ledgerTransactionSchema.shape.id,
    tick: z.number().int().nonnegative().safe(),
    kind: transactionKindSchema,
    legs: z.array(z.object({
      accountId: bankAccountSchema.shape.id,
      owner: z.object({
        kind: accountOwnerKindSchema,
        id: z.string().min(1),
        name: z.string().min(1),
      }).strict(),
      direction: transactionDirectionSchema,
      amount: z.string().regex(/^[1-9]\d*$/),
    }).strict()).min(2),
    reason: z.string().min(1),
    actor: actorRefSchema,
    sourceEventId: z.string().min(1).nullable(),
    correlationId: z.string().min(1),
  }).strict()),
  nextCursor: z.string().min(1).nullable(),
  meta: financeApiMetaSchema,
}).strict();
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;

export const agentFinancesResponseSchema = z.object({
  employment: z.object({
    contractId: employmentContractSchema.shape.id,
    employer: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    title: z.string().min(1),
    wage: z.string().regex(/^\d+$/),
    since: z.string().min(1),
  }).strict().nullable(),
  accounts: z.array(z.object({
    id: bankAccountSchema.shape.id,
    bank: z.string().min(1),
    type: bankAccountTypeSchema,
    balance: z.string().regex(/^-?\d+$/),
  }).strict()),
  income: z.object({
    last30Ticks: z.object({
      salary: z.string().regex(/^\d+$/),
      benefits: z.string().regex(/^\d+$/),
      other: z.string().regex(/^\d+$/),
    }).strict(),
  }).strict(),
  expenses: z.object({
    last30Ticks: z.object({
      subsistence: z.string().regex(/^\d+$/),
      discretionary: z.string().regex(/^\d+$/),
      rent: z.string().regex(/^\d+$/),
      utilities: z.string().regex(/^\d+$/),
    }).strict(),
  }).strict(),
  loans: z.array(z.object({
    id: z.string().min(1),
    principal: z.string().regex(/^\d+$/),
    outstanding: z.string().regex(/^\d+$/),
    status: z.string().min(1),
    nextDue: z.object({
      tick: z.number().int().nonnegative().safe(),
      amount: z.string().regex(/^\d+$/),
    }).strict().nullable(),
  }).strict()),
  meta: financeApiMetaSchema,
}).strict();
export type AgentFinancesResponse = z.infer<typeof agentFinancesResponseSchema>;
