import { z } from "zod";
import {
  conversationIdSchema,
  conversationStructuredTermsSchema,
  conversationTopicSchema,
} from "./conversation";
import { runIdSchema } from "./simulation";

const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const domainIdSchema = z.string().trim().min(1).max(160);

export const conversationBindingIdSchema = z.string().regex(/^cnb_[0-9a-z]{8,}$/);
export const conversationBindingStatusSchema = z.enum(["bound", "rejected"]);
export const conversationBindingResultKindSchema = z.enum([
  "goods_order",
  "employment",
]);
export const conversationBindingRejectionReasonSchema = z.enum([
  "not_agreement",
  "terms_mismatch",
  "participant_mismatch",
  "inactive_offering",
  "invalid_buyer",
  "insufficient_funds",
  "stockout",
  "price_changed",
  "application_unavailable",
  "vacancy_unavailable",
  "wage_out_of_bounds",
]);

export const conversationBindingSchema = z.object({
  id: conversationBindingIdSchema,
  runId: runIdSchema,
  conversationId: conversationIdSchema,
  topic: conversationTopicSchema,
  status: conversationBindingStatusSchema,
  structuredTerms: conversationStructuredTermsSchema.nullable(),
  domainReferenceId: domainIdSchema,
  resultKind: conversationBindingResultKindSchema.nullable(),
  resultId: domainIdSchema.nullable(),
  rejectionReason: conversationBindingRejectionReasonSchema.nullable(),
  bindingTick: z.number().int().nonnegative().safe(),
  evidenceEventIds: z.array(eventIdSchema).min(1).max(64),
  sourceEventId: eventIdSchema,
}).strict().superRefine((binding, ctx) => {
  if (new Set(binding.evidenceEventIds).size !== binding.evidenceEventIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceEventIds"],
      message: "binding evidence event IDs must be unique",
    });
  }
  if (binding.structuredTerms !== null) {
    if (binding.structuredTerms.kind !== binding.topic) {
      ctx.addIssue({
        code: "custom",
        path: ["structuredTerms", "kind"],
        message: "binding terms must match the conversation topic",
      });
    }
    if (binding.structuredTerms.referenceId !== binding.domainReferenceId) {
      ctx.addIssue({
        code: "custom",
        path: ["domainReferenceId"],
        message: "binding reference must match the structured terms",
      });
    }
  }
  if (binding.status === "bound") {
    if (
      binding.structuredTerms === null ||
      binding.resultKind === null ||
      binding.resultId === null ||
      binding.rejectionReason !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "bound negotiation requires terms and one result without rejection",
      });
    }
    const expectedKind = binding.topic === "purchase" ? "goods_order" : "employment";
    if (binding.resultKind !== expectedKind) {
      ctx.addIssue({
        code: "custom",
        path: ["resultKind"],
        message: "binding result kind must match the conversation topic",
      });
    }
  } else if (
    binding.resultKind !== null ||
    binding.resultId !== null ||
    binding.rejectionReason === null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "rejected negotiation requires a reason and no binding result",
    });
  }
});

export type ConversationBindingStatus = z.infer<typeof conversationBindingStatusSchema>;
export type ConversationBindingResultKind = z.infer<
  typeof conversationBindingResultKindSchema
>;
export type ConversationBindingRejectionReason = z.infer<
  typeof conversationBindingRejectionReasonSchema
>;
export type ConversationBinding = z.infer<typeof conversationBindingSchema>;
