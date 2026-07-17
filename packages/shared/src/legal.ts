/** Authoritative Phase 4 contracts for legal agreements, companies, and labor. */

import { z } from "zod";
import { agentIdSchema, skillCodeSchema } from "./agent";
import { actorRefSchema } from "./envelope";
import { bankAccountSchema } from "./finance";
import { runIdSchema } from "./simulation";

const domainId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{8,}$`));
const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);
const nonnegativeIntegerString = z.string().regex(/^\d+$/);

export const legalContractIdSchema = domainId("ctr");
export const legalObligationIdSchema = domainId("obl");
export const companyIdSchema = domainId("co");
export const companyTimelineIdSchema = domainId("ctl");
export const jobIdSchema = domainId("job");
export const jobApplicationIdSchema = domainId("app");
export const employmentTerminationIdSchema = domainId("trm");

export const LEGAL_CONTRACT_TYPES = [
  "incorporation",
  "employment",
  "service",
  "lease",
] as const;
export const legalContractTypeSchema = z.enum(LEGAL_CONTRACT_TYPES);
export type LegalContractType = z.infer<typeof legalContractTypeSchema>;

export const LEGAL_CONTRACT_STATUSES = [
  "draft",
  "signed",
  "active",
  "completed",
  "terminated",
  "breached",
] as const;
export const legalContractStatusSchema = z.enum(LEGAL_CONTRACT_STATUSES);
export type LegalContractStatus = z.infer<typeof legalContractStatusSchema>;

export const legalPartySchema = z.object({
  kind: z.enum(["agent", "company", "institution"]),
  id: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(80),
  signedTick: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type LegalParty = z.infer<typeof legalPartySchema>;

export const incorporationTermsSchema = z.object({
  template: z.literal("incorporation"),
  companyName: z.string().trim().min(2).max(120),
  jurisdiction: z.string().trim().min(2).max(80),
  founderAgentId: agentIdSchema,
  foundingCapitalCents: positiveIntegerString,
  totalShares: positiveIntegerString,
}).strict();

export const employmentTermsSchema = z.object({
  template: z.literal("employment"),
  jobId: jobIdSchema,
  employerId: companyIdSchema,
  employeeAgentId: agentIdSchema,
  annualWageCents: positiveIntegerString,
  startTick: z.number().int().nonnegative().safe(),
  noticeDays: z.number().int().nonnegative().safe(),
}).strict();

export const serviceTermsSchema = z.object({
  template: z.literal("service"),
  providerId: z.string().trim().min(1).max(120),
  clientId: z.string().trim().min(1).max(120),
  scope: z.string().trim().min(1).max(1_000),
  feeCents: positiveIntegerString,
  dueTick: z.number().int().nonnegative().safe(),
}).strict();

export const leaseTermsSchema = z.object({
  template: z.literal("lease"),
  lessorId: z.string().trim().min(1).max(120),
  lesseeId: z.string().trim().min(1).max(120),
  propertyRef: z.string().trim().min(1).max(200),
  rentCents: positiveIntegerString,
  startTick: z.number().int().nonnegative().safe(),
  endTick: z.number().int().nonnegative().safe(),
}).strict().refine((terms) => terms.endTick >= terms.startTick, {
  path: ["endTick"],
  message: "lease endTick must be on or after startTick",
});

export const legalContractTermsSchema = z.discriminatedUnion("template", [
  incorporationTermsSchema,
  employmentTermsSchema,
  serviceTermsSchema,
  leaseTermsSchema,
]);
export type LegalContractTerms = z.infer<typeof legalContractTermsSchema>;

export const LEGAL_OBLIGATION_KINDS = ["payment", "deliverable", "notice"] as const;
export const legalObligationKindSchema = z.enum(LEGAL_OBLIGATION_KINDS);
export const legalObligationSchema = z.object({
  id: legalObligationIdSchema,
  dueTick: z.number().int().nonnegative().safe(),
  recurrenceTicks: z.number().int().positive().safe().nullable(),
  kind: legalObligationKindSchema,
  params: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "fired", "completed", "waived"]),
  firedTick: z.number().int().nonnegative().safe().nullable(),
  completedTick: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type LegalObligation = z.infer<typeof legalObligationSchema>;

export const legalBreachSchema = z.object({
  id: domainId("brc"),
  predicate: z.enum(["overdue_obligation", "invalid_transition", "missing_signature"]),
  tick: z.number().int().nonnegative().safe(),
  details: z.record(z.string(), z.unknown()),
}).strict();
export type LegalBreach = z.infer<typeof legalBreachSchema>;

export const legalContractSchema = z.object({
  id: legalContractIdSchema,
  runId: runIdSchema,
  type: legalContractTypeSchema,
  parties: z.array(legalPartySchema).min(2),
  terms: legalContractTermsSchema,
  obligations: z.array(legalObligationSchema),
  draftedBy: actorRefSchema,
  feeCents: nonnegativeIntegerString,
  status: legalContractStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  effectiveTick: z.number().int().nonnegative().safe(),
  terminalTick: z.number().int().nonnegative().safe().nullable(),
  breaches: z.array(legalBreachSchema),
}).strict().superRefine((contract, ctx) => {
  if (contract.terms.template !== contract.type) {
    ctx.addIssue({ code: "custom", path: ["terms", "template"], message: "terms must match contract type" });
  }
  const keys = new Set<string>();
  for (const party of contract.parties) {
    const key = `${party.kind}:${party.id}`;
    if (keys.has(key)) {
      ctx.addIssue({ code: "custom", path: ["parties"], message: "contract parties must be unique" });
    }
    keys.add(key);
  }
});
export type LegalContract = z.infer<typeof legalContractSchema>;

export const COMPANY_STATUSES = [
  "forming",
  "registered",
  "active",
  "insolvent",
  "winding_down",
  "closed",
] as const;
export const companyStatusSchema = z.enum(COMPANY_STATUSES);
export const companyFormationStageSchema = z.enum([
  "agreement_drafted",
  "fee_paid",
  "registered",
  "account_opened",
  "capitalized",
  "active",
]);
export const companySchema = z.object({
  id: companyIdSchema,
  runId: runIdSchema,
  name: z.string().trim().min(2).max(120),
  sector: z.string().trim().min(1).max(80),
  founderAgentId: agentIdSchema,
  status: companyStatusSchema,
  formationStage: companyFormationStageSchema,
  incorporationContractId: legalContractIdSchema,
  businessAccountId: bankAccountSchema.shape.id.nullable(),
  foundingCapitalCents: positiveIntegerString,
  totalShares: positiveIntegerString,
  foundedTick: z.number().int().nonnegative().safe(),
  registeredTick: z.number().int().nonnegative().safe().nullable(),
  activatedTick: z.number().int().nonnegative().safe().nullable(),
  failureReason: z.string().trim().min(1).max(500).nullable(),
}).strict();
export type Company = z.infer<typeof companySchema>;

export const jobRequirementSchema = z.object({
  skillCode: skillCodeSchema,
  minimum: z.number().int().min(0).max(100),
  weight: z.number().int().min(1).max(100).default(1),
}).strict();
export type JobRequirement = z.infer<typeof jobRequirementSchema>;

export const jobSchema = z.object({
  id: jobIdSchema,
  runId: runIdSchema,
  employerId: companyIdSchema,
  occupationCode: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  title: z.string().trim().min(1).max(120),
  annualWageCents: positiveIntegerString,
  requirements: z.array(jobRequirementSchema).max(20),
  openings: z.number().int().positive().safe(),
  filledCount: z.number().int().nonnegative().safe(),
  status: z.enum(["open", "filled", "withdrawn", "expired"]),
  postedTick: z.number().int().nonnegative().safe(),
  expiresTick: z.number().int().nonnegative().safe().nullable(),
  payrollRisk: z.boolean(),
}).strict().refine((job) => job.filledCount <= job.openings, {
  path: ["filledCount"],
  message: "filledCount cannot exceed openings",
});
export type Job = z.infer<typeof jobSchema>;

export const jobApplicationSchema = z.object({
  id: jobApplicationIdSchema,
  runId: runIdSchema,
  jobId: jobIdSchema,
  agentId: agentIdSchema,
  reservationWageCents: positiveIntegerString,
  status: z.enum(["submitted", "selected", "declined", "withdrawn"]),
  score: z.number().int().safe().nullable(),
  submittedTick: z.number().int().nonnegative().safe(),
  decidedTick: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type JobApplication = z.infer<typeof jobApplicationSchema>;

export const employmentTerminationSchema = z.object({
  id: employmentTerminationIdSchema,
  runId: runIdSchema,
  employmentContractId: z.string().regex(/^emp_[0-9a-z]{8,}$/),
  initiatedBy: z.object({ kind: z.enum(["agent", "company", "system"]), id: z.string().min(1) }).strict(),
  reason: z.enum(["quit", "layoff", "company_failure"]),
  initiatedTick: z.number().int().nonnegative().safe(),
  effectiveTick: z.number().int().nonnegative().safe(),
  status: z.enum(["pending", "effective"]),
}).strict();
export type EmploymentTermination = z.infer<typeof employmentTerminationSchema>;
