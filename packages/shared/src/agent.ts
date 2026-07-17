/** M02 agent, persona, household, goal, relationship, and catalog contracts. */

import { z } from "zod";
import { runIdSchema } from "./simulation";

const idSuffix = "[0-9a-z]{8}";
const codePattern = /^[a-z][a-z0-9_]*$/;

export const agentIdSchema = z.string().regex(new RegExp(`^agt_${idSuffix}$`));
export const personaIdSchema = z.string().regex(new RegExp(`^per_${idSuffix}$`));
export const householdIdSchema = z.string().regex(new RegExp(`^hh_${idSuffix}$`));
export const goalIdSchema = z.string().regex(new RegExp(`^gol_${idSuffix}$`));
export const relationshipIdSchema = z.string().regex(new RegExp(`^rel_${idSuffix}$`));
export const accountIdSchema = z.string().regex(new RegExp(`^acct_${idSuffix}$`));
export const loanIdSchema = z.string().regex(new RegExp(`^loan_${idSuffix}$`));
export const transactionIdSchema = z.string().regex(new RegExp(`^txn_${idSuffix}$`));

export const skillCodeSchema = z.string().regex(codePattern);
export const occupationCodeSchema = z.string().regex(codePattern);

export const EDUCATION_LEVELS = ["none", "hs", "college", "graduate"] as const;
export const educationLevelSchema = z.enum(EDUCATION_LEVELS);
export type EducationLevel = z.infer<typeof educationLevelSchema>;

export const EMPLOYMENT_STATUSES = [
  "employed",
  "unemployed",
  "student",
  "retired",
  "homemaker",
] as const;
export const employmentStatusSchema = z.enum(EMPLOYMENT_STATUSES);
export type EmploymentStatus = z.infer<typeof employmentStatusSchema>;

const traitSchema = z.number().int().min(0).max(100);
const generatedTraitSchema = z.number().int().min(5).max(95);
const opinionValueSchema = z.number().int().min(-100).max(100);

export const personalitySchema = z.object({
  openness: generatedTraitSchema,
  conscientiousness: generatedTraitSchema,
  extraversion: generatedTraitSchema,
  agreeableness: generatedTraitSchema,
  neuroticism: generatedTraitSchema,
  riskTolerance: generatedTraitSchema,
  timePreference: generatedTraitSchema,
  ambition: generatedTraitSchema,
});
export type Personality = z.infer<typeof personalitySchema>;

export const opinionAxesSchema = z.object({
  redistribution: opinionValueSchema,
  regulation: opinionValueSchema,
  institutionalTrust: opinionValueSchema,
  economicOptimism: opinionValueSchema,
});
export type OpinionAxes = z.infer<typeof opinionAxesSchema>;

export const personaSchema = z.object({
  id: personaIdSchema,
  agentId: agentIdSchema,
  name: z.string().trim().min(3).max(120),
  age: z.number().int().min(16).max(100),
  gender: z.string().trim().min(1).max(40).optional(),
  education: educationLevelSchema,
  skills: z.record(skillCodeSchema, traitSchema),
  personality: personalitySchema,
  opinions: opinionAxesSchema,
  bioSummary: z.string().trim().min(1).max(1_000),
  promptVersion: z.number().int().positive().safe(),
});
export type Persona = z.infer<typeof personaSchema>;

export const quarantineSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("tier1_only"),
    untilTick: z.number().int().nonnegative().safe(),
    consecutiveFailures: z.number().int().positive().safe(),
  }),
]);
export type AgentQuarantine = z.infer<typeof quarantineSchema>;

export const agentSchema = z.object({
  id: agentIdSchema,
  runId: runIdSchema,
  personaId: personaIdSchema,
  householdId: householdIdSchema,
  occupationCode: occupationCodeSchema,
  employmentStatus: employmentStatusSchema,
  creditScore: z.number().int().min(300).max(850),
  quarantine: quarantineSchema,
  aliveFlags: z.object({ alive: z.boolean(), canAct: z.boolean() }),
});
export type Agent = z.infer<typeof agentSchema>;

const annualCentsSchema = z.string().regex(/^\d+$/);
export const wageBandSchema = z
  .object({
    minAnnualCents: annualCentsSchema,
    maxAnnualCents: annualCentsSchema,
  })
  .superRefine((band, ctx) => {
    if (BigInt(band.minAnnualCents) > BigInt(band.maxAnnualCents)) {
      ctx.addIssue({
        code: "custom",
        path: ["maxAnnualCents"],
        message: "maximum annual cents must be at least the minimum",
      });
    }
  });

export const OCCUPATION_EMPLOYMENT_KINDS = [
  "wage",
  "draw",
  "variable",
  "transfer",
  "capital",
  "none",
] as const;
export const occupationEmploymentKindSchema = z.enum(OCCUPATION_EMPLOYMENT_KINDS);

export const occupationSchema = z.object({
  code: occupationCodeSchema,
  title: z.string().trim().min(1).max(100),
  requiredSkills: z.array(skillCodeSchema).min(1),
  baseWageBand: wageBandSchema,
  sector: z.string().regex(codePattern),
  minimumAge: z.number().int().min(16).max(65),
  minimumEducation: educationLevelSchema,
  employmentKind: occupationEmploymentKindSchema,
  personalityTags: z.array(z.string().regex(codePattern)),
});
export type Occupation = z.infer<typeof occupationSchema>;

export const skillSchema = z.object({
  code: skillCodeSchema,
  name: z.string().trim().min(1).max(80),
  sectorAffinity: z.array(z.string().regex(codePattern)).min(1),
});
export type Skill = z.infer<typeof skillSchema>;

export const GOAL_STATUSES = ["dormant", "active", "achieved", "abandoned"] as const;
export const goalStatusSchema = z.enum(GOAL_STATUSES);
export const goalSchema = z.object({
  id: goalIdSchema,
  agentId: agentIdSchema,
  kind: z.string().regex(codePattern),
  params: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(1).max(5),
  status: goalStatusSchema,
  activationRule: z.string().regex(codePattern),
  progress: z.number().min(0).max(1),
});
export type Goal = z.infer<typeof goalSchema>;

export const RELATIONSHIP_TYPES = [
  "family",
  "friend",
  "colleague",
  "business",
  "adversary",
] as const;
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export const relationshipSchema = z
  .object({
    id: relationshipIdSchema,
    runId: runIdSchema,
    fromAgentId: agentIdSchema,
    toAgentId: agentIdSchema,
    type: relationshipTypeSchema,
    strength: z.number().int().min(-100).max(100),
    lastInteractionTick: z.number().int().nonnegative().safe(),
  })
  .superRefine((relationship, ctx) => {
    if (relationship.fromAgentId === relationship.toAgentId) {
      ctx.addIssue({ code: "custom", path: ["toAgentId"], message: "self edges are forbidden" });
    }
    if (relationship.type === "adversary" && relationship.strength >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["strength"],
        message: "adversary strength must be negative",
      });
    }
    if (relationship.type !== "adversary" && relationship.strength < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["strength"],
        message: "non-adversary strength must be nonnegative",
      });
    }
  });
export type Relationship = z.infer<typeof relationshipSchema>;

export const HOUSEHOLD_STRUCTURES = ["single", "couple", "family", "shared"] as const;
export const householdStructureSchema = z.enum(HOUSEHOLD_STRUCTURES);
export const HOUSING_TIERS = ["modest", "standard", "comfortable"] as const;
export const housingTierSchema = z.enum(HOUSING_TIERS);
export const householdSchema = z.object({
  id: householdIdSchema,
  runId: runIdSchema,
  memberAgentIds: z.array(agentIdSchema).min(1).max(4),
  structure: householdStructureSchema,
  housingTier: housingTierSchema,
  budgetPolicy: z.object({
    bufferDays: z.number().int().min(0).max(180),
    discretionaryPropensityBp: z.number().int().min(0).max(10_000),
  }),
});
export type Household = z.infer<typeof householdSchema>;
