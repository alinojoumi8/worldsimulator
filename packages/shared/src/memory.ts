/** M03 append-only agent-memory contracts. Memory text is always untrusted data. */

import { z } from "zod";
import { agentIdSchema } from "./agent";
import { runIdSchema } from "./simulation";

const idSuffix = "[0-9a-z]{8}";

export const memoryIdSchema = z.string().regex(new RegExp(`^mem_${idSuffix}$`));
export const MEMORY_KINDS = ["event", "conversation", "outcome", "reflection"] as const;
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

const eventReferenceSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

const memoryBaseSchema = z.object({
  id: memoryIdSchema,
  runId: runIdSchema,
  agentId: agentIdSchema,
  tick: z.number().int().nonnegative().safe(),
  kind: memoryKindSchema,
  content: z.string().trim().min(1).max(2_000),
  importance: z.number().int().min(0).max(100),
  references: z.array(eventReferenceSchema).max(64),
  /** Populated only on deterministic template summaries. */
  sourceMemoryIds: z.array(memoryIdSchema).max(256).optional(),
}).strict();

export const memorySchema = memoryBaseSchema.superRefine((memory, ctx) => {
  if (new Set(memory.references).size !== memory.references.length) {
    ctx.addIssue({
      code: "custom",
      path: ["references"],
      message: "memory references must be unique",
    });
  }
  if (
    memory.sourceMemoryIds !== undefined &&
    new Set(memory.sourceMemoryIds).size !== memory.sourceMemoryIds.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceMemoryIds"],
      message: "source memory IDs must be unique",
    });
  }
  if (memory.sourceMemoryIds !== undefined && memory.kind !== "reflection") {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: "only reflection memories may summarize source memories",
    });
  }
});
export type Memory = z.infer<typeof memorySchema>;

export const memoryRecordInputSchema = memoryBaseSchema.omit({
  id: true,
  sourceMemoryIds: true,
});
export type MemoryRecordInput = z.infer<typeof memoryRecordInputSchema>;

export const memoryRetrievalContextSchema = z.object({
  tick: z.number().int().nonnegative().safe(),
  triggerKind: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  queryText: z.string().max(500).optional(),
  referenceIds: z.array(eventReferenceSchema).max(32).default([]),
  preferredKinds: z.array(memoryKindSchema).max(MEMORY_KINDS.length).default([]),
}).strict();
export type MemoryRetrievalContext = z.infer<typeof memoryRetrievalContextSchema>;
