/** Durable, run-scoped append-only event store (WS-102). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  sha256Hex,
} from "@worldtangle/shared";
import type { EventEnvelope } from "@worldtangle/shared";
import {
  canonicalEventPayload,
  isValidatedEventEnvelope,
  validateEventEnvelope,
} from "@worldtangle/engine";
import type { EventFilter, EventLog } from "@worldtangle/engine";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

interface EventRow {
  run_id: string;
  seq: bigint;
  event_id: string;
  type: string;
  schema_version: bigint;
  tick: bigint;
  sim_date: string;
  wall_time: string;
  actor_kind: EventEnvelope["actor"]["kind"];
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  payload_canonical: string;
}

interface CountRow {
  count: bigint;
}

interface NextSeqRow {
  next_event_seq: bigint;
}

type EventInsertRow = readonly [
  string,
  number,
  string,
  string,
  number,
  number,
  string,
  string,
  EventEnvelope["actor"]["kind"],
  string,
  string,
  string | null,
  string,
];

interface VariadicStatement {
  run(...params: Array<string | number | null>): unknown;
}

const EVENT_INSERT_COLUMNS = `
  run_id, seq, event_id, type, schema_version, tick, sim_date, wall_time,
  actor_kind, actor_id, correlation_id, causation_id, payload_canonical
`;
const EVENT_ROW_PLACEHOLDERS = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
// 2,500 rows × 13 columns = 32,500 bind parameters, just below SQLite's
// standard 32,766-variable ceiling. Fewer statement executions keeps the
// 10k-event acceptance gate comfortably below 100 ms on cold runs.
const BULK_INSERT_SIZE = 2_500;

export interface EventPageQuery extends EventFilter {
  afterSeq?: number;
  beforeSeq?: number;
  fromTick?: number;
  toTick?: number;
  actorId?: string;
  correlationId?: string;
  causationId?: string;
  /** Internal read-model optimization; excludes event type families before deserialization. */
  excludeTypePrefixes?: readonly string[];
  direction?: "forward" | "backward";
  limit?: number;
}

export interface EventPage {
  readonly items: readonly EventEnvelope[];
  readonly nextCursor: number | null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function mapEvent(row: EventRow, simulationId: string): EventEnvelope {
  return {
    eventId: row.event_id,
    type: row.type,
    schemaVersion: toSafeNumber(row.schema_version, "event schema version"),
    simulationId,
    runId: row.run_id,
    seq: toSafeNumber(row.seq, "event sequence"),
    tick: toSafeNumber(row.tick, "event tick"),
    simDate: row.sim_date,
    wallTime: row.wall_time,
    actor: { kind: row.actor_kind, id: row.actor_id },
    correlationId: row.correlation_id,
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    payload: canonicalParse(row.payload_canonical),
  };
}

export class SqliteEventStore implements EventLog {
  private readonly insertEvent;
  private readonly simulationId: string;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    const run = db
      .prepare<[string], { simulation_id: string }>(
        "SELECT simulation_id FROM simulation_runs WHERE id = ?",
      )
      .get(runId);
    if (!run) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
    this.simulationId = run.simulation_id;
    this.insertEvent = db.prepare(`
      INSERT INTO events(${EVENT_INSERT_COLUMNS}) VALUES ${EVENT_ROW_PLACEHOLDERS}
    `);
  }

  append(event: EventEnvelope): void {
    this.appendBatch([event]);
  }

  appendBatch(events: readonly EventEnvelope[]): void {
    if (events.length === 0) return;
    const run = this.db
      .prepare<[string], NextSeqRow>(
        "SELECT next_event_seq FROM simulation_runs WHERE id = ?",
      )
      .get(this.runId);
    if (!run) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);

    const expectedStart = toSafeNumber(run.next_event_seq, "next event sequence");
    const rows: EventInsertRow[] = events.map((event, index) => {
      const validated = isValidatedEventEnvelope(event) ? event : validateEventEnvelope(event);
      if (validated.runId !== this.runId || validated.simulationId !== this.simulationId) {
        throw new EngineError("CONFLICT", "event belongs to a different simulation or run");
      }
      const expectedSeq = expectedStart + index;
      if (validated.seq !== expectedSeq) {
        throw new EngineError(
          "CONFLICT",
          `gapless seq violated: got ${validated.seq}, expected ${expectedSeq}`,
        );
      }
      return [
        validated.runId,
        validated.seq,
        validated.eventId,
        validated.type,
        validated.schemaVersion,
        validated.tick,
        validated.simDate,
        validated.wallTime,
        validated.actor.kind,
        validated.actor.id,
        validated.correlationId,
        validated.causationId ?? null,
        canonicalEventPayload(validated),
      ] as const;
    });

    const append = (): void => {
      this.insertRows(rows);
      const updated = this.db
        .prepare(`
          UPDATE simulation_runs
          SET next_event_seq = @nextSeq
          WHERE id = @runId AND next_event_seq = @expectedStart
        `)
        .run({ runId: this.runId, expectedStart, nextSeq: expectedStart + rows.length });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", "stale event sequence checkpoint");
      }
    };
    if (this.db.inTransaction) {
      append();
    } else {
      this.db.transaction(append).immediate();
    }
  }

  private insertRows(rows: readonly EventInsertRow[]): void {
    if (rows.length < 8) {
      for (const row of rows) this.insertEvent.run(...row);
      return;
    }

    const statements = new Map<number, VariadicStatement>();
    for (let offset = 0; offset < rows.length; offset += BULK_INSERT_SIZE) {
      const chunk = rows.slice(offset, offset + BULK_INSERT_SIZE);
      let statement = statements.get(chunk.length);
      if (!statement) {
        statement = this.db.prepare(`
            INSERT INTO events(${EVENT_INSERT_COLUMNS}) VALUES
            ${Array.from({ length: chunk.length }, () => EVENT_ROW_PLACEHOLDERS).join(",")}
          `) as unknown as VariadicStatement;
        statements.set(chunk.length, statement);
      }
      const values: Array<string | number | null> = [];
      for (const row of chunk) values.push(...row);
      statement.run(...values);
    }
  }

  list(filter: EventPageQuery = {}): readonly EventEnvelope[] {
    return this.query(filter).map((row) => deepFreeze(mapEvent(row, this.simulationId)));
  }

  page(query: EventPageQuery = {}): EventPage {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new EngineError("VALIDATION_FAILED", `event page limit must be 1..200, got ${limit}`);
    }
    const rows = this.query(query, limit + 1, query.direction ?? "forward");
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const items = selected.map((row) => deepFreeze(mapEvent(row, this.simulationId)));
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? items.at(-1)!.seq : null,
    };
  }

  count(): number {
    const row = this.db
      .prepare<[string], CountRow>("SELECT COUNT(*) AS count FROM events WHERE run_id = ?")
      .get(this.runId)!;
    return toSafeNumber(row.count, "event count");
  }

  logHash(): string {
    const hashable = this.list().map((event) => {
      const clone: Record<string, unknown> = { ...event };
      delete clone["wallTime"];
      return clone;
    });
    return sha256Hex(canonicalStringify(hashable));
  }

  private query(
    filter: EventPageQuery,
    limit?: number,
    direction: "forward" | "backward" = "forward",
  ): EventRow[] {
    const where = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId };
    const add = (condition: string, name: string, value: string | number | undefined): void => {
      if (value === undefined) return;
      where.push(condition);
      params[name] = value;
    };
    add("type = @type", "type", filter.type);
    add("seq >= @fromSeq", "fromSeq", filter.fromSeq);
    add("seq <= @toSeq", "toSeq", filter.toSeq);
    add("tick = @tick", "tick", filter.tick);
    add("tick >= @fromTick", "fromTick", filter.fromTick);
    add("tick <= @toTick", "toTick", filter.toTick);
    add("seq > @afterSeq", "afterSeq", filter.afterSeq);
    add("seq < @beforeSeq", "beforeSeq", filter.beforeSeq);
    add("actor_id = @actorId", "actorId", filter.actorId);
    add("correlation_id = @correlationId", "correlationId", filter.correlationId);
    add("causation_id = @causationId", "causationId", filter.causationId);
    for (const [index, prefix] of (filter.excludeTypePrefixes ?? []).entries()) {
      if (prefix.length === 0) {
        throw new EngineError("VALIDATION_FAILED", "excluded event type prefix must not be empty");
      }
      const name = `excludedTypePrefix${index}`;
      where.push(`type NOT LIKE @${name}`);
      params[name] = `${prefix}%`;
    }
    if (limit !== undefined) params["limit"] = limit;
    const sql = `
      SELECT * FROM events
      WHERE ${where.join(" AND ")}
      ORDER BY seq ${direction === "forward" ? "ASC" : "DESC"}
      ${limit === undefined ? "" : "LIMIT @limit"}
    `;
    return this.db.prepare<Record<string, string | number>, EventRow>(sql).all(params);
  }
}
