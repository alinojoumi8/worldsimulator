/** M04 trigger, decision, proposal, and action contracts. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { actorRefSchema, engineErrorCodeSchema, TYPE_NAME_PATTERN } from "./envelope";
import { runIdSchema } from "./simulation";
import { decisionPriorModifierSchema } from "./sentiment";

const idSuffix = "[0-9a-z]{8}";

export const decisionIdSchema = z.string().regex(new RegExp("^dec_" + idSuffix + "$"));
export const actionIdSchema = z.string().regex(new RegExp("^act_" + idSuffix + "$"));

export const TRIGGER_KINDS = [
  "schedule",
  "message",
  "stress",
  "news",
  "goal",
  "policy",
  "company",
  "market",
] as const;
export const triggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof triggerKindSchema>;

const triggerBaseSchema = z.object({
  agentId: agentIdSchema,
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  tick: z.number().int().nonnegative().safe(),
  priority: z.number().int().min(0).max(100),
});

export const triggerSignalSchema = z.discriminatedUnion("kind", [
  triggerBaseSchema.extend({
    kind: z.literal("schedule"),
    payload: z.object({
      taskRef: z.string().min(1).max(160),
      dueTick: z.number().int().nonnegative().safe(),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("message"),
    payload: z.object({
      messageId: z.string().min(1).max(80),
      conversationId: z.string().min(1).max(80).optional(),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("stress"),
    payload: z.object({
      balanceCents: z.string().regex(/^-?\d+$/),
      bufferDays: z.number().int().min(0).max(365),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("news"),
    payload: z.object({
      storyId: z.string().min(1).max(80),
      relevanceScore: z.number().int().min(0).max(100),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("goal"),
    payload: z.object({
      goalId: z.string().min(1).max(80),
      goalKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("policy"),
    payload: z.object({
      policyId: z.string().min(1).max(80),
      changeKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("company"),
    payload: z.object({
      companyId: z.string().min(1).max(80),
      eventKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("market"),
    payload: z.object({
      marketId: z.string().min(1).max(80),
      securityId: z.string().min(1).max(80).optional(),
      movementBp: z.number().int().min(-10_000).max(10_000),
    }).strict(),
  }).strict(),
]);
export type TriggerSignal = z.infer<typeof triggerSignalSchema>;

export const decisionTriggerRefSchema = z.object({
  kind: triggerKindSchema,
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  priority: z.number().int().min(0).max(100),
}).strict();
export type DecisionTriggerRef = z.infer<typeof decisionTriggerRefSchema>;

export const DECISION_TIERS = [1, 2, 3] as const;
export const decisionTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type DecisionTier = z.infer<typeof decisionTierSchema>;

export const decisionOptionSchema = z.object({
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  actionType: z.string().regex(TYPE_NAME_PATTERN),
  params: z.record(z.string(), z.unknown()),
  utility: z.number().int().min(-1_000_000).max(1_000_000),
  utilityFactors: z.record(z.string(), z.number().int()).optional(),
}).strict();
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const decisionValidationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved") }).strict(),
  z.object({
    status: z.literal("rejected"),
    code: engineErrorCodeSchema,
    message: z.string().min(1).max(2_000),
  }).strict(),
]);
export type DecisionValidationResult = z.infer<typeof decisionValidationResultSchema>;

export const decisionSchema = z.object({
  id: decisionIdSchema,
  runId: runIdSchema,
  agentId: agentIdSchema,
  tick: z.number().int().nonnegative().safe(),
  trigger: decisionTriggerRefSchema,
  tier: decisionTierSchema,
  observationDigest: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    summary: z.string().min(1).max(4_000),
  }).strict(),
  optionsOffered: z.array(decisionOptionSchema).min(1).max(32),
  chosenActionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  rationale: z.string().min(1).max(4_000),
  llmCallId: z.string().regex(/^llm_[0-9a-z]{8,}$/).optional(),
  validationResult: decisionValidationResultSchema,
  promptPackKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/).optional(),
  promptVersion: z.number().int().positive().safe().optional(),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  priorModifier: decisionPriorModifierSchema.optional(),
}).strict().superRefine((decision, ctx) => {
  if (
    decision.chosenActionId !== undefined &&
    !decision.optionsOffered.some((option) => option.actionId === decision.chosenActionId)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["chosenActionId"],
      message: "chosen action must be one of the offered options",
    });
  }
  if (decision.validationResult.status === "approved" && decision.chosenActionId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["chosenActionId"],
      message: "approved decision requires a chosen action",
    });
  }
  if (decision.tier >= 2 && decision.llmCallId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["llmCallId"],
      message: "Tier 2/3 decision requires an LLM call record",
    });
  }
  if (decision.tier >= 2) {
    for (const field of ["promptPackKey", "promptVersion", "promptHash"] as const) {
      if (decision[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `Tier 2/3 decision requires ${field}`,
        });
      }
    }
  }
  if (decision.tier === 1 && decision.llmCallId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["llmCallId"],
      message: "Tier 1 decision cannot link an LLM call",
    });
  }
  if (
    decision.tier === 1 &&
    (
      decision.promptPackKey !== undefined ||
      decision.promptVersion !== undefined ||
      decision.promptHash !== undefined
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["promptHash"],
      message: "Tier 1 decision cannot carry LLM prompt metadata",
    });
  }
});
export type Decision = z.infer<typeof decisionSchema>;

export const AGENT_ACTION_STATUSES = ["validated", "applied", "failed"] as const;
export const agentActionStatusSchema = z.enum(AGENT_ACTION_STATUSES);
export const agentActionSchema = z.object({
  id: actionIdSchema,
  runId: runIdSchema,
  decisionId: decisionIdSchema.optional(),
  actorId: agentIdSchema,
  type: z.string().regex(TYPE_NAME_PATTERN),
  params: z.record(z.string(), z.unknown()),
  status: agentActionStatusSchema,
  resultEventIds: z.array(z.string().regex(/^evt_[0-9a-z]{8,}$/)),
  error: z.object({
    code: engineErrorCodeSchema,
    message: z.string().min(1).max(2_000),
  }).strict().optional(),
}).strict().superRefine((action, ctx) => {
  if (action.status === "failed" && action.error === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["error"],
      message: "failed action requires an engine error",
    });
  }
  if (action.status !== "failed" && action.error !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["error"],
      message: "only failed actions may carry an engine error",
    });
  }
});
export type AgentAction = z.infer<typeof agentActionSchema>;

/**
 * The bounded structured-choice surface used by Tier 2 and by live-provider
 * contract probes. Domain action schemas still validate params afterward.
 */
export const tier2DecisionProposalSchema = z.object({
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
export type Tier2DecisionProposal = z.infer<typeof tier2DecisionProposalSchema>;

export const decisionActorSchema = actorRefSchema.refine(
  (actor) => actor.kind === "agent",
  "decision actor must be an agent",
);
