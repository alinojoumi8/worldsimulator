/** Versioned provider-neutral controls for the bounded LLM gateway (WS-603). */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { runIdSchema } from "./simulation";

export const LLM_MODULE_IDS = [
  "agent_decisions",
  "conversations",
  "news",
] as const;

export const llmModuleIdSchema = z.enum(LLM_MODULE_IDS);
export type LlmModuleId = z.infer<typeof llmModuleIdSchema>;

const runSelection = { runId: runIdSchema.optional() } as const;

const setLlmEnabledSchema = z
  .object({
    ...runSelection,
    command: z.literal("set_llm_enabled"),
    enabled: z.boolean(),
  })
  .strict();

const setModuleFrozenSchema = z
  .object({
    ...runSelection,
    command: z.literal("set_module_frozen"),
    moduleId: llmModuleIdSchema,
    frozen: z.boolean(),
  })
  .strict();

const setAgentQuarantineSchema = z
  .object({
    ...runSelection,
    command: z.literal("set_agent_quarantine"),
    agentId: agentIdSchema,
    quarantined: z.boolean(),
    untilTick: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quarantined && value.untilTick === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["untilTick"],
        message: "untilTick is required when quarantining an agent",
      });
    }
    if (!value.quarantined && value.untilTick !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["untilTick"],
        message: "untilTick must be omitted when clearing quarantine",
      });
    }
  });

export const llmControlRequestSchema = z.union([
  setLlmEnabledSchema,
  setModuleFrozenSchema,
  setAgentQuarantineSchema,
]);
export type LlmControlRequest = z.infer<typeof llmControlRequestSchema>;

export const llmDegradationTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type LlmDegradationTier = z.infer<typeof llmDegradationTierSchema>;
