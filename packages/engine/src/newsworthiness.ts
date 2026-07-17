import { EngineError, type EventEnvelope, hashValue } from "@worldtangle/shared";
import { validateEventEnvelope } from "./event-log";

export const NEWSWORTHINESS_SCORING_VERSION = 1;
export const DEFAULT_NEWS_LOOKBACK_TICKS = 30;
export const DEFAULT_NEWS_DIGEST_LIMIT = 25;

const MONEY_POINTS_MAX = 4_000;
const RARITY_POINTS_MAX = 3_500;
const AFFECTED_POINTS_MAX = 2_500;
const AFFECTED_COUNT_CAP = 10_000;
const AFFECTED_POINTS_PER_ENTITY = 250;

const NEWS_OPERATIONAL_FACT_KEYS = new Set([
  "simulationId",
  "runId",
  "createdWall",
  "wallTime",
  "correlationId",
  "latencyMs",
]);

export const NEWS_OPERATIONAL_EVENT_PREFIXES = Object.freeze([
  "admin.",
  "agent.",
  "api.",
  "conversation.",
  "goal.",
  "llm.",
  "memory.",
  "news.",
  "scheduler.",
  "sentiment.",
  "simulation.",
  "snapshot.",
  "transaction.",
  "trigger.",
]);

const NEWS_GENESIS_ONLY_EVENT_TYPES = new Set([
  "venture.firm.created",
  "venture.fund.created",
]);

const ENTITY_ID_SUFFIXES = Object.freeze([
  "agentid",
  "agentids",
  "companyid",
  "companyids",
  "householdid",
  "householdids",
  "bankid",
  "bankids",
  "institutionid",
  "institutionids",
  "organizationid",
  "organizationids",
  "employerid",
  "employerids",
  "employeeid",
  "employeeids",
  "borrowerid",
  "borrowerids",
  "applicantid",
  "applicantids",
  "founderid",
  "founderids",
  "buyerid",
  "buyerids",
  "sellerid",
  "sellerids",
  "ownerid",
  "ownerids",
  "payerid",
  "payerids",
  "recipientid",
  "recipientids",
  "participantid",
  "participantids",
  "affectedid",
  "affectedids",
  "impactedid",
  "impactedids",
]);

const EXPLICIT_AFFECTED_COUNT_KEYS = new Set([
  "affectedcount",
  "affectedagentcount",
  "affectedentitycount",
  "affectedhouseholdcount",
  "affectedcompanycount",
  "impactedcount",
  "impactedagentcount",
  "impactedentitycount",
  "impactedhouseholdcount",
  "impactedcompanycount",
]);

export interface NewsworthinessComponents {
  readonly maxAbsMoneyCents: string;
  readonly moneyPoints: number;
  readonly typeOccurrences: number;
  readonly rarityPoints: number;
  readonly affectedCount: number;
  readonly affectedPoints: number;
}

export interface NewsworthinessScore {
  readonly totalPoints: number;
  readonly components: NewsworthinessComponents;
}

export interface NewsDigestCandidate extends NewsworthinessScore {
  readonly rank: number;
  readonly eventId: string;
  /** Hash of immutable source facts with wall time and operational identity removed. */
  readonly eventFactHash: string;
  readonly eventType: string;
  readonly tick: number;
  readonly simDate: string;
  readonly actor: EventEnvelope["actor"];
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface NewsworthinessDigestInput {
  readonly simulationId: string;
  readonly runId: string;
  readonly tick: number;
  /** Events for this run, including enough history to cover the requested lookback. */
  readonly events: readonly EventEnvelope[];
  /** Optional pre-aggregated inclusive lookback counts; events may then contain only the source tick. */
  readonly windowTypeOccurrences?: readonly Readonly<{
    eventType: string;
    count: number;
  }>[];
  readonly lookbackTicks?: number;
  readonly limit?: number;
}

export interface NewsworthinessDigest {
  readonly scoringVersion: typeof NEWSWORTHINESS_SCORING_VERSION;
  readonly simulationId: string;
  readonly runId: string;
  readonly tick: number;
  readonly windowStartTick: number;
  readonly lookbackTicks: number;
  readonly limit: number;
  readonly totalCandidateCount: number;
  readonly candidates: readonly NewsDigestCandidate[];
  readonly digestHash: string;
}

interface PayloadScan {
  maxAbsMoneyCents: bigint;
  explicitAffectedCount: number;
  readonly affectedIds: Set<string>;
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Removes replay-local metadata while retaining economically meaningful facts such as cost. */
export function newsLogicalProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(newsLogicalProjection);
  if (typeof value !== "object" || value === null) return value;
  const logical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (NEWS_OPERATIONAL_FACT_KEYS.has(key)) continue;
    logical[key] = newsLogicalProjection(
      (value as Readonly<Record<string, unknown>>)[key],
    );
  }
  return logical;
}

function withoutCorrelationId<T extends Readonly<{ correlationId: string }>>(
  value: T,
): Omit<T, "correlationId"> {
  const logical = { ...value } as { correlationId?: string } & Record<string, unknown>;
  delete logical.correlationId;
  return logical as Omit<T, "correlationId">;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineError("VALIDATION_FAILED", `${name} must be a nonnegative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EngineError("VALIDATION_FAILED", `${name} must be a positive safe integer`);
  }
  return value;
}

function parseInteger(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function isMoneyKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.endsWith("cents") && !normalized.endsWith("microcents");
}

function isEntityIdKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return ENTITY_ID_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function addAffectedIds(value: unknown, affectedIds: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    affectedIds.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) affectedIds.add(item);
  }
}

function cappedCount(value: unknown): number | undefined {
  const parsed = parseInteger(value);
  if (parsed === undefined || parsed < 0n) return undefined;
  if (parsed >= BigInt(AFFECTED_COUNT_CAP)) return AFFECTED_COUNT_CAP;
  return Number(parsed);
}

function scanPayload(value: unknown, scan: PayloadScan): void {
  if (Array.isArray(value)) {
    for (const item of value) scanPayload(item, scan);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record).sort(compareStrings)) {
    const item = record[key];
    if (isMoneyKey(key)) {
      const parsed = parseInteger(item);
      if (parsed !== undefined) {
        const magnitude = absolute(parsed);
        if (magnitude > scan.maxAbsMoneyCents) scan.maxAbsMoneyCents = magnitude;
      }
    }
    if (isEntityIdKey(key)) addAffectedIds(item, scan.affectedIds);
    if (EXPLICIT_AFFECTED_COUNT_KEYS.has(normalizedKey(key))) {
      const count = cappedCount(item);
      if (count !== undefined && count > scan.explicitAffectedCount) {
        scan.explicitAffectedCount = count;
      }
    }
    scanPayload(item, scan);
  }
}

function moneyPoints(maxAbsMoneyCents: bigint): number {
  if (maxAbsMoneyCents === 0n) return 0;
  const decimalOrdersAboveOneCent = maxAbsMoneyCents.toString().length - 1;
  return Math.min(MONEY_POINTS_MAX, decimalOrdersAboveOneCent * 500);
}

function affectedPoints(affectedCount: number): number {
  return Math.min(AFFECTED_POINTS_MAX, affectedCount * AFFECTED_POINTS_PER_ENTITY);
}

export function isNewsDigestCandidate(event: EventEnvelope): boolean {
  return !(
    (event.tick === 0 && NEWS_GENESIS_ONLY_EVENT_TYPES.has(event.type)) ||
    NEWS_OPERATIONAL_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))
  );
}

/**
 * Score one event using fixed integer points. Money uses the largest absolute cents fact,
 * rarity is inverse type frequency in the digest window, and affected entities are deduped.
 */
export function scoreNewsworthiness(
  rawEvent: EventEnvelope,
  typeOccurrences: number,
): NewsworthinessScore {
  const event = validateEventEnvelope(rawEvent);
  positiveSafeInteger(typeOccurrences, "typeOccurrences");
  return scoreValidatedNewsworthiness(event, typeOccurrences);
}

function scoreValidatedNewsworthiness(
  event: EventEnvelope,
  typeOccurrences: number,
): NewsworthinessScore {
  const scan: PayloadScan = {
    maxAbsMoneyCents: 0n,
    explicitAffectedCount: 0,
    affectedIds: new Set<string>(),
  };
  if (event.actor.kind !== "system") scan.affectedIds.add(event.actor.id);
  scanPayload(event.payload, scan);

  const affectedCount = Math.min(
    AFFECTED_COUNT_CAP,
    Math.max(scan.explicitAffectedCount, scan.affectedIds.size),
  );
  const components = Object.freeze({
    maxAbsMoneyCents: scan.maxAbsMoneyCents.toString(),
    moneyPoints: moneyPoints(scan.maxAbsMoneyCents),
    typeOccurrences,
    rarityPoints: Math.floor(RARITY_POINTS_MAX / typeOccurrences),
    affectedCount,
    affectedPoints: affectedPoints(affectedCount),
  });
  return Object.freeze({
    totalPoints: components.moneyPoints + components.rarityPoints + components.affectedPoints,
    components,
  });
}

function compareCandidates(
  left: Pick<NewsDigestCandidate, "totalPoints" | "tick" | "eventType" | "eventId">,
  right: Pick<NewsDigestCandidate, "totalPoints" | "tick" | "eventType" | "eventId">,
): number {
  if (left.totalPoints !== right.totalPoints) return right.totalPoints - left.totalPoints;
  if (left.tick !== right.tick) return left.tick - right.tick;
  const typeComparison = compareStrings(left.eventType, right.eventType);
  if (typeComparison !== 0) return typeComparison;
  return compareStrings(left.eventId, right.eventId);
}

export function newsEventFactHash(event: EventEnvelope): string {
  return hashValue(newsLogicalProjection({
    eventId: event.eventId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    seq: event.seq,
    tick: event.tick,
    simDate: event.simDate,
    actor: event.actor,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    payload: event.payload,
  }));
}

export function buildNewsworthinessDigest(
  input: NewsworthinessDigestInput,
): NewsworthinessDigest {
  if (input.simulationId.length === 0 || input.runId.length === 0) {
    throw new EngineError("VALIDATION_FAILED", "digest identity must not be empty");
  }
  const tick = nonnegativeSafeInteger(input.tick, "tick");
  const lookbackTicks = positiveSafeInteger(
    input.lookbackTicks ?? DEFAULT_NEWS_LOOKBACK_TICKS,
    "lookbackTicks",
  );
  const limit = positiveSafeInteger(input.limit ?? DEFAULT_NEWS_DIGEST_LIMIT, "limit");
  const windowStartTick = Math.max(0, tick - lookbackTicks + 1);

  const eventIds = new Set<string>();
  const events = input.events.map((rawEvent) => {
    const event = validateEventEnvelope(rawEvent);
    if (event.simulationId !== input.simulationId || event.runId !== input.runId) {
      throw new EngineError("CONFLICT", "news digest cannot mix simulations or runs");
    }
    if (eventIds.has(event.eventId)) {
      throw new EngineError("CONFLICT", `duplicate event ${event.eventId} in news digest input`);
    }
    eventIds.add(event.eventId);
    return event;
  });

  const observedTypeOccurrences = new Map<string, number>();
  for (const event of events) {
    if (event.tick < windowStartTick || event.tick > tick) continue;
    observedTypeOccurrences.set(
      event.type,
      (observedTypeOccurrences.get(event.type) ?? 0) + 1,
    );
  }
  const typeOccurrences = input.windowTypeOccurrences === undefined
    ? observedTypeOccurrences
    : new Map<string, number>();
  if (input.windowTypeOccurrences !== undefined) {
    for (const occurrence of input.windowTypeOccurrences) {
      if (occurrence.eventType.length === 0) {
        throw new EngineError("VALIDATION_FAILED", "event type occurrence key must not be empty");
      }
      const count = positiveSafeInteger(occurrence.count, "event type occurrence count");
      if (typeOccurrences.has(occurrence.eventType)) {
        throw new EngineError(
          "CONFLICT",
          `duplicate event type occurrence ${occurrence.eventType}`,
        );
      }
      typeOccurrences.set(occurrence.eventType, count);
    }
    for (const [eventType, observed] of observedTypeOccurrences) {
      if ((typeOccurrences.get(eventType) ?? 0) < observed) {
        throw new EngineError(
          "VALIDATION_FAILED",
          `event type occurrence ${eventType} undercounts supplied events`,
        );
      }
    }
  }

  const scored = events
    .filter((event) => event.tick === tick && isNewsDigestCandidate(event))
    .map((event) => {
      const score = scoreValidatedNewsworthiness(
        event,
        typeOccurrences.get(event.type) ?? 1,
      );
      return Object.freeze({
        event,
        eventId: event.eventId,
        eventType: event.type,
        tick: event.tick,
        simDate: event.simDate,
        actor: event.actor,
        correlationId: event.correlationId,
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
        ...score,
      });
    })
    .sort(compareCandidates);

  const candidates = Object.freeze(
    scored.slice(0, limit).map(({ event, ...candidate }, index) => Object.freeze({
      rank: index + 1,
      eventFactHash: newsEventFactHash(event),
      ...candidate,
    })),
  );
  const digestBasis = Object.freeze({
    scoringVersion: NEWSWORTHINESS_SCORING_VERSION,
    simulationId: input.simulationId,
    runId: input.runId,
    tick,
    windowStartTick,
    lookbackTicks,
    limit,
    totalCandidateCount: scored.length,
    candidates,
  });
  const digestHashBasis = Object.freeze({
    scoringVersion: digestBasis.scoringVersion,
    tick: digestBasis.tick,
    windowStartTick: digestBasis.windowStartTick,
    lookbackTicks: digestBasis.lookbackTicks,
    limit: digestBasis.limit,
    totalCandidateCount: digestBasis.totalCandidateCount,
    candidates: digestBasis.candidates.map(withoutCorrelationId),
  });
  return Object.freeze({
    ...digestBasis,
    digestHash: hashValue(digestHashBasis),
  });
}
