import {
  digestStreamDataSchema,
  type DigestStreamData,
  type EventEnvelope,
} from "@worldtangle/shared";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Convert the authoritative tick-completion event into the public dashboard digest. */
export function digestForCommittedEvent(event: EventEnvelope): DigestStreamData | undefined {
  if (event.type !== "simulation.tick.completed") return undefined;
  const payload = record(event.payload);
  const counts = record(payload["counts"]);
  const indicators = record(payload["indicators"]);
  return digestStreamDataSchema.parse({
    v: 1,
    tick: event.tick,
    simDate: event.simDate,
    indicators,
    counts: {
      events: nonnegativeInteger(counts["events"]),
      transactions: nonnegativeInteger(counts["transactions"]),
      decisions: nonnegativeInteger(counts["decisions"]),
      llmCalls: nonnegativeInteger(counts["llmCalls"]),
      rejectedIntents: nonnegativeInteger(counts["rejectedIntents"]),
    },
    notable: [],
    spend: { budgetPct: 0 },
  });
}
