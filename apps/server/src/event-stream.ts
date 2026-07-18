/**
 * Durable Server-Sent Events adapter (WS-109).
 *
 * The stream deliberately polls committed SQLite rows. Engine EventBus
 * notifications are pre-commit and therefore must never be exposed here.
 */

import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import {
  EngineError,
  runIdSchema,
  simulationIdSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import { openDatabaseFile } from "./persistence/database";
import { SqliteEventStore } from "./persistence/event-store";
import { RunLocator, type RunLocation } from "./persistence/run-locator";
import { digestForCommittedEvent } from "./run-digest";

export const EVENT_STREAM_TOPICS = ["digest", "lifecycle"] as const;
export type EventStreamTopic = (typeof EVENT_STREAM_TOPICS)[number];

const EVENT_STREAM_TOPIC_SET = new Set<string>(EVENT_STREAM_TOPICS);
const LIFECYCLE_EVENT_TYPES = new Set([
  "simulation.created",
  "simulation.started",
  "simulation.paused",
  "simulation.resumed",
  "simulation.stopped",
  "simulation.completed",
  "simulation.failed",
]);

export interface SseFrame {
  readonly id: number;
  readonly event: EventStreamTopic | "gap";
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EventStreamSelection {
  readonly topics: ReadonlySet<EventStreamTopic>;
  readonly runId?: string;
}

export interface CommittedEventDelivery {
  /** All raw events through this sequence are accounted for. */
  readonly throughSeq: number;
  /** Absent when the raw event does not belong to a subscribed topic. */
  readonly frame?: SseFrame;
}

export interface CommittedEventBatch {
  readonly deliveries: readonly CommittedEventDelivery[];
  readonly gap: boolean;
}

interface EventStreamOptions {
  readonly dataDir: string;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxBacklogEvents?: number;
  readonly onError?: (error: unknown, location: RunLocation) => void;
}

interface StreamConnectionOptions {
  readonly response: ServerResponse;
  readonly location: RunLocation;
  readonly topics: ReadonlySet<EventStreamTopic>;
  readonly afterSeq: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxBacklogEvents: number;
  readonly onError?: (error: unknown, location: RunLocation) => void;
  readonly onClose: () => void;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function lifecycleStatus(event: EventEnvelope): string {
  const status = record(event.payload)["status"];
  if (typeof status === "string" && status.length > 0) return status;
  return event.type.slice("simulation.".length);
}

/** Convert one committed event to its subscribed public frame, if any. */
export function frameForCommittedEvent(
  event: EventEnvelope,
  topics: ReadonlySet<EventStreamTopic>,
): SseFrame | undefined {
  if (event.type === "simulation.tick.completed" && topics.has("digest")) {
    const digest = digestForCommittedEvent(event);
    if (digest === undefined) return undefined;
    return {
      id: event.seq,
      event: "digest",
      data: digest,
    };
  }

  if (LIFECYCLE_EVENT_TYPES.has(event.type) && topics.has("lifecycle")) {
    return {
      id: event.seq,
      event: "lifecycle",
      data: {
        v: 1,
        eventId: event.eventId,
        type: event.type,
        simulationId: event.simulationId,
        runId: event.runId,
        status: lifecycleStatus(event),
        tick: event.tick,
        simDate: event.simDate,
        wallTime: event.wallTime,
        correlationId: event.correlationId,
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      },
    };
  }

  return undefined;
}

/** Serialize one SSE event. JSON is one line, so embedded text cannot forge fields. */
export function serializeSseFrame(frame: SseFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/**
 * Read a bounded forward batch from the authoritative event log.
 *
 * A delivery with no frame still advances the raw sequence checkpoint. This
 * prevents reconnects from repeatedly scanning unsubscribed event types.
 */
export function readCommittedEventBatch(
  location: RunLocation,
  afterSeq: number,
  topics: ReadonlySet<EventStreamTopic>,
  maxBacklogEvents: number,
): CommittedEventBatch {
  const db = openDatabaseFile(location.databasePath);
  try {
    const store = new SqliteEventStore(db, location.runId);
    const page = store.page({
      afterSeq,
      direction: "forward",
      limit: maxBacklogEvents,
    });

    if (page.nextCursor !== null) {
      const latest = store.page({ direction: "backward", limit: 1 }).items[0];
      if (latest === undefined || latest.seq <= afterSeq) {
        throw new EngineError("INTERNAL", "event backlog changed unexpectedly");
      }
      return {
        gap: true,
        deliveries: [
          {
            throughSeq: latest.seq,
            frame: {
              id: latest.seq,
              event: "gap",
              data: { fromSeq: afterSeq + 1, toSeq: latest.seq },
            },
          },
        ],
      };
    }

    return {
      gap: false,
      deliveries: page.items.map((event) => {
        const frame = frameForCommittedEvent(event, topics);
        return {
          throughSeq: event.seq,
          ...(frame === undefined ? {} : { frame }),
        };
      }),
    };
  } finally {
    db.close();
  }
}

function parseLastEventId(value: string | string[] | undefined): number {
  if (value === undefined) return -1;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new EngineError(
      "VALIDATION_FAILED",
      "Last-Event-ID must be a nonnegative integer event sequence",
    );
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new EngineError("VALIDATION_FAILED", "Last-Event-ID exceeds the safe integer range");
  }
  return sequence;
}

function parseSelection(value: unknown): EventStreamSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("VALIDATION_FAILED", "stream query must be an object");
  }
  const query = value as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (key !== "topics" && key !== "runId") {
      throw new EngineError("VALIDATION_FAILED", `unknown stream query parameter: ${key}`);
    }
  }

  const rawTopics = query["topics"] ?? "digest";
  if (typeof rawTopics !== "string") {
    throw new EngineError("VALIDATION_FAILED", "topics must be a comma-separated string");
  }
  const topicNames = rawTopics.split(",").map((topic) => topic.trim());
  if (
    topicNames.length === 0 ||
    topicNames.some((topic) => topic.length === 0 || !EVENT_STREAM_TOPIC_SET.has(topic))
  ) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `topics must contain only: ${EVENT_STREAM_TOPICS.join(",")}`,
    );
  }
  const topics = new Set(topicNames as EventStreamTopic[]);

  const rawRunId = query["runId"];
  if (rawRunId === undefined) return { topics };
  const parsedRunId = runIdSchema.safeParse(rawRunId);
  if (!parsedRunId.success) {
    throw new EngineError("VALIDATION_FAILED", "invalid run ID");
  }
  return { topics, runId: parsedRunId.data };
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${name} must be an integer from 1..${maximum}`,
    );
  }
  return resolved;
}

class StreamConnection {
  private readonly response: ServerResponse;
  private readonly location: RunLocation;
  private readonly topics: ReadonlySet<EventStreamTopic>;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBacklogEvents: number;
  private readonly reportError: ((error: unknown, location: RunLocation) => void) | undefined;
  private readonly notifyClosed: () => void;
  private afterSeq: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private blocked = false;
  private polling = false;
  private closed = false;

  constructor(options: StreamConnectionOptions) {
    this.response = options.response;
    this.location = options.location;
    this.topics = options.topics;
    this.afterSeq = options.afterSeq;
    this.pollIntervalMs = options.pollIntervalMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.maxBacklogEvents = options.maxBacklogEvents;
    this.reportError = options.onError;
    this.notifyClosed = options.onClose;
  }

  start(): void {
    this.response.once("close", this.handleRemoteClose);
    this.response.once("error", this.handleResponseError);
    // Send a comment immediately so development/reverse proxies expose the
    // established response before the first committed frame or heartbeat.
    this.write(":connected\n\n");
    if (this.closed) return;
    this.poll();
    if (this.closed) return;
    this.pollTimer = setInterval(this.poll, this.pollIntervalMs);
    this.pollTimer.unref();
    this.heartbeatTimer = setInterval(this.heartbeat, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.response.off("close", this.handleRemoteClose);
    this.response.off("error", this.handleResponseError);
    this.response.off("drain", this.handleDrain);
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
    this.notifyClosed();
  }

  private readonly poll = (): void => {
    if (this.closed || this.blocked || this.polling) return;
    this.polling = true;
    try {
      const batch = readCommittedEventBatch(
        this.location,
        this.afterSeq,
        this.topics,
        this.maxBacklogEvents,
      );
      for (const delivery of batch.deliveries) {
        if (delivery.frame !== undefined) {
          const accepted = this.write(serializeSseFrame(delivery.frame));
          // response.write() returning false still accepted this frame into
          // Node's buffer; resume after it drains.
          this.afterSeq = delivery.throughSeq;
          if (!accepted) break;
        } else {
          this.afterSeq = delivery.throughSeq;
        }
      }
    } catch (error) {
      this.report(error);
      this.close();
    } finally {
      this.polling = false;
    }
  };

  private readonly heartbeat = (): void => {
    if (this.closed || this.blocked) return;
    try {
      this.write(":hb\n\n");
    } catch (error) {
      this.report(error);
      this.close();
    }
  };

  private write(payload: string): boolean {
    if (this.closed || this.response.destroyed || this.response.writableEnded) {
      this.close();
      return false;
    }
    const accepted = this.response.write(payload);
    if (!accepted) {
      this.blocked = true;
      this.response.once("drain", this.handleDrain);
    }
    return accepted;
  }

  private readonly handleDrain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    this.poll();
  };

  private readonly handleRemoteClose = (): void => {
    this.close();
  };

  private readonly handleResponseError = (error: Error): void => {
    this.report(error);
    this.close();
  };

  private report(error: unknown): void {
    try {
      this.reportError?.(error, this.location);
    } catch {
      // Observability must not keep a failed stream connection alive.
    }
  }
}

/** Owns all live stream timers and responses for one Fastify application. */
export class CommittedEventStream {
  private readonly locator: RunLocator;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBacklogEvents: number;
  private readonly reportError: ((error: unknown, location: RunLocation) => void) | undefined;
  private readonly connections = new Set<StreamConnection>();
  private closed = false;

  constructor(options: EventStreamOptions) {
    this.locator = new RunLocator(options.dataDir);
    this.pollIntervalMs = positiveIntegerOption(
      options.pollIntervalMs,
      100,
      "SSE poll interval",
      60_000,
    );
    this.heartbeatIntervalMs = positiveIntegerOption(
      options.heartbeatIntervalMs,
      15_000,
      "SSE heartbeat interval",
      600_000,
    );
    this.maxBacklogEvents = positiveIntegerOption(
      options.maxBacklogEvents,
      100,
      "SSE max backlog events",
      200,
    );
    this.reportError = options.onError;
  }

  locate(simulationId: string, runId?: string): RunLocation {
    return this.locator.locate(simulationId, runId);
  }

  connect(
    response: ServerResponse,
    location: RunLocation,
    topics: ReadonlySet<EventStreamTopic>,
    afterSeq: number,
  ): void {
    if (this.closed) {
      throw new EngineError("CONFLICT", "event stream is closing");
    }
    const connection = new StreamConnection({
      response,
      location,
      topics,
      afterSeq,
      pollIntervalMs: this.pollIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      maxBacklogEvents: this.maxBacklogEvents,
      ...(this.reportError === undefined ? {} : { onError: this.reportError }),
      onClose: () => this.connections.delete(connection),
    });
    this.connections.add(connection);
    connection.start();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.connections]) connection.close();
    this.connections.clear();
  }
}

/** Register the v1 committed-event stream route. */
export function registerEventStreamRoute(
  app: FastifyInstance,
  stream: CommittedEventStream,
): void {
  app.get("/api/v1/simulations/:simId/stream", (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const parsedSimulationId = simulationIdSchema.safeParse(params["simId"]);
    if (!parsedSimulationId.success) {
      throw new EngineError("VALIDATION_FAILED", "invalid simulation ID");
    }
    const selection = parseSelection(request.query);
    const afterSeq = parseLastEventId(request.headers["last-event-id"]);
    // Resolve the durable run before hijacking so validation/not-found errors
    // still use the normal RFC 9457 response path.
    const location = stream.locate(parsedSimulationId.data, selection.runId);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    request.raw.socket.setNoDelay(true);
    request.raw.socket.setKeepAlive(true);
    stream.connect(reply.raw, location, selection.topics, afterSeq);
  });
}
