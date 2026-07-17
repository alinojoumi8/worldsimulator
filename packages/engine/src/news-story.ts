/** WS-702 deterministic, menu-bound journalist story construction. */

import {
  canonicalStringify,
  EngineError,
  hashValue,
  newsOrganizationSchema,
  newsStoryDraftSchema,
  newsStoryFactSchema,
  newsStorySelectionProposalSchema,
  type DecisionOption,
  type EventEnvelope,
  type NewsOrganization,
  type NewsStoryDraft,
  type NewsStoryFact,
  type NewsStorySelectionProposal,
  type NewsTopic,
} from "@worldtangle/shared";
import { validateEventEnvelope } from "./event-log";
import {
  newsEventFactHash,
  newsLogicalProjection,
  type NewsDigestCandidate,
} from "./newsworthiness";

const ENTITY_KEY_PATTERN = /(id|ids)$/i;

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "");
}

function collectEntityValues(value: unknown, entities: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0 && value.length <= 160) entities.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && item.length <= 160) entities.add(item);
  }
}

function scanEntities(value: unknown, entities: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) scanEntities(item, entities);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value).sort(compareCodeUnit)) {
    const item = (value as Readonly<Record<string, unknown>>)[key];
    if (ENTITY_KEY_PATTERN.test(normalizeKey(key))) collectEntityValues(item, entities);
    scanEntities(item, entities);
  }
}

export function newsTopicForEvent(eventType: string): NewsTopic {
  const tokens = eventType.split(".");
  if (tokens.some((token) => ["employment", "employee", "job", "labor", "wage", "payroll"].includes(token))) {
    return "employment";
  }
  if (tokens.some((token) => [
    "market", "price", "pricing", "goods", "inventory", "production", "energy", "tariff",
    "fuel", "demand", "stockout", "order", "sale",
  ].includes(token))) {
    return "market";
  }
  if (tokens.some((token) => [
    "bank", "credit", "loan", "government", "policy", "legal", "institution", "tax",
  ].includes(token))) {
    return "institutions";
  }
  return "economy";
}

export function newsStoryFactFromEvent(rawEvent: EventEnvelope): NewsStoryFact {
  const event = validateEventEnvelope(rawEvent);
  return newsStoryFactSchema.parse({
    eventId: event.eventId,
    eventFactHash: newsEventFactHash(event),
    eventType: event.type,
    tick: event.tick,
    simDate: event.simDate,
    actor: event.actor,
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    payload: event.payload,
  });
}

function draft(
  variant: "neutral" | "context" | "brief",
  organization: NewsOrganization,
  candidate: NewsDigestCandidate,
  event: EventEnvelope,
): NewsStoryDraft {
  const topic = newsTopicForEvent(event.type);
  const fact = newsStoryFactFromEvent(event);
  const entities = new Set<string>();
  if (event.actor.kind !== "system") entities.add(event.actor.id);
  scanEntities(newsLogicalProjection(event.payload), entities);
  const sortedEntities = [...entities].sort(compareCodeUnit).slice(0, 64);
  const eventLabel = event.type.replaceAll(".", " ");
  const headline = variant === "neutral"
    ? `${eventLabel}: verified development at ${event.simDate}`
    : variant === "context"
    ? `${organization.name} tracks ${eventLabel}`
    : `Brief: ${eventLabel}`;
  const body = variant === "neutral"
    ? `A committed simulation event (${event.eventId}) recorded ${event.type} at ${event.simDate}. The exact source payload is preserved in the attached fact fields.`
    : variant === "context"
    ? `The ${topic} desk selected committed event ${event.eventId} after deterministic newsworthiness ranking. Its immutable event type, actor, date, and payload are copied below without alteration.`
    : `Verified event ${event.eventId} records ${event.type} at ${event.simDate}; see the exact copied fact fields for the complete source data.`;
  return newsStoryDraftSchema.parse({
    headline,
    body,
    topic,
    entities: sortedEntities,
    stance: variant === "context" ? organization.stanceBias : 0,
    citedEventIds: [candidate.eventId],
    facts: [fact],
  });
}

export interface BuildNewsStoryOptionsInput {
  readonly organization: NewsOrganization;
  readonly candidate: NewsDigestCandidate;
  readonly event: EventEnvelope;
}

export interface NewsStoryMenuOption {
  readonly option: DecisionOption;
  readonly draft: NewsStoryDraft;
}

/** Menu identity excludes operational correlation metadata while persisted facts retain it. */
export function newsStoryDraftHash(rawDraft: NewsStoryDraft): string {
  const storyDraft = newsStoryDraftSchema.parse(rawDraft);
  return hashValue(newsLogicalProjection(storyDraft));
}

/** Complete drafts stay engine-side; the model receives only exact draft IDs and hashes. */
export function buildNewsStoryMenu(input: BuildNewsStoryOptionsInput): readonly NewsStoryMenuOption[] {
  const organization = newsOrganizationSchema.parse(input.organization);
  const event = validateEventEnvelope(input.event);
  if (event.runId !== organization.runId || event.eventId !== input.candidate.eventId) {
    throw new EngineError("CONFLICT", "story source event does not match its digest candidate");
  }
  if (event.tick !== input.candidate.tick || newsEventFactHash(event) !== input.candidate.eventFactHash) {
    throw new EngineError("CONFLICT", "story source facts do not match the committed digest");
  }
  const variants = ["neutral", "context", "brief"] as const;
  return Object.freeze(variants.map((variant, index) => {
    const storyDraft = draft(variant, organization, input.candidate, event);
    return Object.freeze({
      option: Object.freeze({
        actionId: `news.story.publish.${variant}`,
        actionType: "news.story.publish",
        params: Object.freeze({ draftId: variant, draftHash: newsStoryDraftHash(storyDraft) }),
        utility: Math.min(1_000_000, input.candidate.totalPoints + (variants.length - index)),
        utilityFactors: Object.freeze({
          newsworthiness: input.candidate.totalPoints,
          editorPreference: variants.length - index,
        }),
      }),
      draft: storyDraft,
    });
  }));
}

export function buildNewsStoryOptions(input: BuildNewsStoryOptionsInput): readonly DecisionOption[] {
  return Object.freeze(buildNewsStoryMenu(input).map((entry) => entry.option));
}

export interface ResolvedNewsStorySelection {
  readonly ok: boolean;
  readonly proposal?: NewsStorySelectionProposal;
  readonly option?: DecisionOption;
  readonly reason?: "schema_invalid" | "menu_mismatch";
  readonly detail?: string;
}

export function resolveNewsStorySelection(
  candidate: unknown,
  options: readonly DecisionOption[],
): ResolvedNewsStorySelection {
  const parsed = newsStorySelectionProposalSchema.safeParse(candidate);
  if (!parsed.success) {
    return Object.freeze({
      ok: false,
      reason: "schema_invalid",
      detail: parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 2_000),
    });
  }
  const option = options.find((offered) => offered.actionId === parsed.data.actionId);
  if (option === undefined || canonicalStringify(option.params) !== canonicalStringify(parsed.data.params)) {
    return Object.freeze({
      ok: false,
      reason: "menu_mismatch",
      detail: "proposal does not exactly match an engine-authored story option",
    });
  }
  return Object.freeze({ ok: true, proposal: parsed.data, option });
}

export function templateNewsStorySelection(
  options: readonly DecisionOption[],
): NewsStorySelectionProposal {
  const option = options.find((candidate) => candidate.actionId === "news.story.publish.neutral");
  if (option === undefined) throw new EngineError("NOT_FOUND", "neutral news template is missing");
  return newsStorySelectionProposalSchema.parse({
    actionId: option.actionId,
    params: option.params,
    rationale: "deterministic_template_fallback",
  });
}

export function newsStoryReach(newsworthinessPoints: number): number {
  if (!Number.isSafeInteger(newsworthinessPoints) || newsworthinessPoints < 0) {
    throw new EngineError("VALIDATION_FAILED", "newsworthiness points must be nonnegative");
  }
  return Math.min(100_000, 1_000 + newsworthinessPoints * 5);
}
