/**
 * Append-only event log (ADR-0003/0009). The in-memory implementation is the
 * foundation/testing store; the SQLite-backed store (Phase 1) implements the
 * same interface behind M20.
 */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  eventEnvelopeSchema,
  sha256Hex,
} from "@worldtangle/shared";
import type { EventEnvelope } from "@worldtangle/shared";

const validatedEvents = new WeakSet<object>();
const canonicalPayloads = new WeakMap<object, string>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateEventEnvelope(event: EventEnvelope): EventEnvelope {
  if (validatedEvents.has(event)) return event;
  const parsed = eventEnvelopeSchema.safeParse(event);
  if (!parsed.success) {
    throw new EngineError(
      "SCHEMA_INVALID",
      `event failed envelope schema: ${parsed.error.message}`,
    );
  }

  let clone: unknown;
  try {
    clone = canonicalParse(canonicalStringify(event));
  } catch (error) {
    throw new EngineError("SCHEMA_INVALID", "event is not canonically serializable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    typeof clone !== "object" ||
    clone === null ||
    !Object.prototype.hasOwnProperty.call(clone, "payload")
  ) {
    throw new EngineError("SCHEMA_INVALID", "event payload must be canonically serializable");
  }
  const roundTrip = eventEnvelopeSchema.safeParse(clone);
  if (!roundTrip.success) {
    throw new EngineError(
      "SCHEMA_INVALID",
      `canonical event failed envelope schema: ${roundTrip.error.message}`,
    );
  }
  const validated = deepFreeze(roundTrip.data);
  validatedEvents.add(validated);
  canonicalPayloads.set(validated, canonicalStringify(validated.payload));
  return validated;
}

export function isValidatedEventEnvelope(event: EventEnvelope): boolean {
  return validatedEvents.has(event);
}

export function canonicalEventPayload(event: EventEnvelope): string {
  const validated = validateEventEnvelope(event);
  return canonicalPayloads.get(validated)!;
}

export interface EventFilter {
  type?: string;
  fromSeq?: number;
  toSeq?: number;
  tick?: number;
}

export interface EventLog {
  /** Append one event. Envelope is schema-validated; seq must be gapless. */
  append(event: EventEnvelope): void;
  /** Append a complete tick's events atomically. */
  appendBatch(events: readonly EventEnvelope[]): void;
  list(filter?: EventFilter): readonly EventEnvelope[];
  count(): number;
  /** Digest of the full log with wallTime excluded (ADR-0009). */
  logHash(): string;
}

export class InMemoryEventLog implements EventLog {
  private readonly events: EventEnvelope[] = [];
  private readonly eventIds = new Set<string>();

  append(event: EventEnvelope): void {
    this.appendBatch([event]);
  }

  appendBatch(events: readonly EventEnvelope[]): void {
    let expectedSeq = this.events.length;
    const stored: EventEnvelope[] = [];
    const expectedSimulationId = this.events[0]?.simulationId ?? events[0]?.simulationId;
    const expectedRunId = this.events[0]?.runId ?? events[0]?.runId;
    const pendingIds = new Set(this.eventIds);
    for (const event of events) {
      const immutable = validateEventEnvelope(event);
      if (event.seq !== expectedSeq) {
        throw new EngineError(
          "CONFLICT",
          `gapless seq violated: got ${event.seq}, expected ${expectedSeq}`,
        );
      }
      if (event.simulationId !== expectedSimulationId || event.runId !== expectedRunId) {
        throw new EngineError("CONFLICT", "event log cannot mix simulations or runs");
      }
      if (pendingIds.has(event.eventId)) {
        throw new EngineError("CONFLICT", `duplicate event ID: ${event.eventId}`);
      }
      pendingIds.add(event.eventId);
      expectedSeq += 1;
      stored.push(immutable);
    }

    this.events.push(...stored);
    for (const event of stored) this.eventIds.add(event.eventId);
  }

  list(filter?: EventFilter): readonly EventEnvelope[] {
    if (!filter) return [...this.events];
    return this.events.filter(
      (event) =>
        (filter.type === undefined || event.type === filter.type) &&
        (filter.fromSeq === undefined || event.seq >= filter.fromSeq) &&
        (filter.toSeq === undefined || event.seq <= filter.toSeq) &&
        (filter.tick === undefined || event.tick === filter.tick),
    );
  }

  count(): number {
    return this.events.length;
  }

  logHash(): string {
    const hashable = this.events.map((event) => {
      const clone: Record<string, unknown> = { ...event };
      delete clone["wallTime"];
      return clone;
    });
    return sha256Hex(canonicalStringify(hashable));
  }
}
