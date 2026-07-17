/** Pure replay journal and event-stream comparison helpers (WS-705). */

import {
  canonicalStringify,
  EngineError,
  sha256Hex,
  type EventEnvelope,
} from "@worldtangle/shared";

export interface ReplayJournalCommand {
  readonly seq: number;
  readonly tick: number;
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly requestId: string;
}

export interface ReplayEventMismatch {
  readonly seq: number;
  readonly tick: number;
  readonly expectedHash: string;
  readonly actualHash: string | null;
  readonly expectedType: string;
  readonly actualType: string | null;
  readonly reason: "missing" | "different";
}

const OPERATIONAL_KEYS = new Set([
  "simulationId",
  "runId",
  "createdWall",
  "wallTime",
  "correlationId",
  "latencyMs",
]);

function withoutOperationalIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOperationalIdentity);
  if (typeof value !== "object" || value === null) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (OPERATIONAL_KEYS.has(key)) continue;
    normalized[key] = withoutOperationalIdentity(
      (value as Readonly<Record<string, unknown>>)[key],
    );
  }
  return normalized;
}

export function replayEventProjection(event: EventEnvelope): Readonly<Record<string, unknown>> {
  return Object.freeze(withoutOperationalIdentity(event) as Readonly<Record<string, unknown>>);
}

export function replayEventHash(event: EventEnvelope): string {
  return sha256Hex(canonicalStringify(replayEventProjection(event)));
}

export function replayJournalDigest(events: readonly EventEnvelope[]): string {
  const commands = events
    .filter((event) => event.type === "admin.command.received")
    .map(replayEventProjection);
  return sha256Hex(canonicalStringify(commands));
}

export function parseReplayJournalCommand(event: EventEnvelope): ReplayJournalCommand {
  if (event.type !== "admin.command.received") {
    throw new EngineError("VALIDATION_FAILED", `event ${event.eventId} is not an admin command`);
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new EngineError("INTERNAL", `admin command ${event.eventId} has an invalid payload`);
  }
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const params = payload["params"];
  if (
    typeof payload["command"] !== "string" ||
    payload["command"].length === 0 ||
    typeof payload["requestId"] !== "string" ||
    payload["requestId"].length === 0 ||
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params)
  ) {
    throw new EngineError("INTERNAL", `admin command ${event.eventId} is malformed`);
  }
  return Object.freeze({
    seq: event.seq,
    tick: event.tick,
    command: payload["command"],
    params: params as Readonly<Record<string, unknown>>,
    requestId: payload["requestId"],
  });
}

export function firstReplayEventMismatch(
  expected: readonly EventEnvelope[],
  actual: readonly EventEnvelope[],
): ReplayEventMismatch | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const expectedEvent = expected[index];
    const actualEvent = actual[index];
    if (expectedEvent === undefined) {
      if (actualEvent === undefined) return null;
      return Object.freeze({
        seq: actualEvent.seq,
        tick: actualEvent.tick,
        expectedHash: sha256Hex(canonicalStringify(null)),
        actualHash: replayEventHash(actualEvent),
        expectedType: "<none>",
        actualType: actualEvent.type,
        reason: "different" as const,
      });
    }
    const expectedHash = replayEventHash(expectedEvent);
    if (actualEvent === undefined) {
      return Object.freeze({
        seq: expectedEvent.seq,
        tick: expectedEvent.tick,
        expectedHash,
        actualHash: null,
        expectedType: expectedEvent.type,
        actualType: null,
        reason: "missing" as const,
      });
    }
    const actualHash = replayEventHash(actualEvent);
    if (expectedHash !== actualHash) {
      return Object.freeze({
        seq: expectedEvent.seq,
        tick: Math.max(expectedEvent.tick, actualEvent.tick),
        expectedHash,
        actualHash,
        expectedType: expectedEvent.type,
        actualType: actualEvent.type,
        reason: "different" as const,
      });
    }
  }
  return null;
}
