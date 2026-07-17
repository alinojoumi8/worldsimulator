/** Versioned public Server-Sent Event data contracts (ADR-0012). */

import { z } from "zod";
import { SIM_DATE_PATTERN, TYPE_NAME_PATTERN } from "./envelope";
import { runIdSchema, runStatusSchema, simulationIdSchema } from "./simulation";

const sequenceSchema = z.number().int().nonnegative().safe();
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

export const digestStreamDataSchema = z
  .object({
    v: z.literal(1),
    tick: sequenceSchema,
    simDate: z.string().regex(SIM_DATE_PATTERN),
    indicators: z.record(z.string(), z.union([z.number().finite(), z.string()])),
    counts: z
      .object({
        events: sequenceSchema,
        transactions: sequenceSchema,
        decisions: sequenceSchema,
        llmCalls: sequenceSchema,
        rejectedIntents: sequenceSchema,
      })
      .strict(),
    notable: z.array(
      z
        .object({
          eventId: eventIdSchema,
          type: z.string().regex(TYPE_NAME_PATTERN),
          summary: z.string().min(1),
        })
        .strict(),
    ),
    spend: z.object({ budgetPct: z.number().min(0).max(100) }).strict(),
  })
  .strict();
export type DigestStreamData = z.infer<typeof digestStreamDataSchema>;

export const lifecycleStreamDataSchema = z
  .object({
    v: z.literal(1),
    eventId: eventIdSchema,
    type: z.string().regex(TYPE_NAME_PATTERN),
    simulationId: simulationIdSchema,
    runId: runIdSchema,
    status: runStatusSchema,
    tick: sequenceSchema,
    simDate: z.string().regex(SIM_DATE_PATTERN),
    wallTime: z.string().min(1),
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
  })
  .strict();
export type LifecycleStreamData = z.infer<typeof lifecycleStreamDataSchema>;

export const gapStreamDataSchema = z
  .object({
    fromSeq: sequenceSchema,
    toSeq: sequenceSchema,
  })
  .strict()
  .refine((gap) => gap.fromSeq <= gap.toSeq, {
    path: ["toSeq"],
    message: "toSeq must be greater than or equal to fromSeq",
  });
export type GapStreamData = z.infer<typeof gapStreamDataSchema>;

export const eventStreamFrameSchema = z.discriminatedUnion("event", [
  z.object({ id: sequenceSchema, event: z.literal("digest"), data: digestStreamDataSchema }),
  z.object({ id: sequenceSchema, event: z.literal("lifecycle"), data: lifecycleStreamDataSchema }),
  z.object({ id: sequenceSchema, event: z.literal("gap"), data: gapStreamDataSchema }),
]);
export type EventStreamFrame = z.infer<typeof eventStreamFrameSchema>;
