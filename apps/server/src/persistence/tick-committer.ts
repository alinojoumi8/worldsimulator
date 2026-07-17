/** Atomic empty-world tick boundary: checkpoint + staged events (WS-103). */

import { canonicalParse, canonicalStringify, EngineError, runCheckpointSchema } from "@worldtangle/shared";
import type { IdFactoryState, RunCheckpoint, RunStatus } from "@worldtangle/shared";
import type { TickCommit, TickCommitter, TickUnitOfWork } from "@worldtangle/engine";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";
import type { SqliteEventStore } from "./event-store";

interface RunTickRow {
  id: string;
  simulation_id: string;
  status: RunStatus;
  current_tick: bigint;
  next_event_seq: bigint;
  id_state_canonical: string;
}

export interface SqliteTickCommitterOptions {
  /** Test seam for proving rollback after event insertion. */
  afterEvents?: (commit: TickCommit) => void;
}

export class SqliteTickCommitter implements TickCommitter, TickUnitOfWork {
  constructor(
    private readonly db: WorldDatabase,
    private readonly eventStore: SqliteEventStore,
    private readonly options: SqliteTickCommitterOptions = {},
  ) {}

  execute(work: () => void): void {
    // better-sqlite3 turns a nested transaction into a savepoint. Always use
    // that boundary so a caller that catches a failed tick cannot accidentally
    // commit the tick's partial domain or scheduler effects with its outer work.
    this.db.transaction(work).immediate();
  }

  commitTick(commit: TickCommit): void {
    if (commit.runId !== this.eventStore.runId || commit.tick !== commit.previousTick + 1) {
      throw new EngineError("CONFLICT", "tick commit identity or sequence is invalid");
    }
    const eventCounter = commit.idState["evt"] ?? 0;
    const lastEvent = commit.events.at(-1);
    if (!lastEvent || eventCounter !== lastEvent.seq + 1) {
      throw new EngineError("CONFLICT", "tick event and ID checkpoints do not agree");
    }

    const persist = (): void => {
      const run = this.db
        .prepare<[string], RunTickRow>(`
          SELECT id, simulation_id, status, current_tick, next_event_seq, id_state_canonical
          FROM simulation_runs WHERE id = ?
        `)
        .get(commit.runId);
      if (!run) throw new EngineError("NOT_FOUND", `run ${commit.runId} does not exist`);
      const currentTick = toSafeNumber(run.current_tick, "run current tick");
      if (
        run.simulation_id !== commit.simulationId ||
        currentTick !== commit.previousTick ||
        (run.status !== "running" && run.status !== "paused")
      ) {
        throw new EngineError("CONFLICT", "run is not at the expected tick or status");
      }

      this.eventStore.appendBatch(commit.events);
      this.options.afterEvents?.(commit);
      const updated = this.db
        .prepare(`
          UPDATE simulation_runs
          SET current_tick = @tick, id_state_canonical = @idState
          WHERE id = @runId AND current_tick = @previousTick
        `)
        .run({
          runId: commit.runId,
          tick: commit.tick,
          previousTick: commit.previousTick,
          idState: canonicalStringify(commit.idState),
        });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", "stale run tick checkpoint");
      }
    };

    if (this.db.inTransaction) {
      persist();
    } else {
      this.execute(persist);
    }
  }
}

export function readRunCheckpoint(db: WorldDatabase, runId: string): RunCheckpoint {
  const row = db
    .prepare<[string], RunTickRow>(`
      SELECT id, simulation_id, status, current_tick, next_event_seq, id_state_canonical
      FROM simulation_runs WHERE id = ?
    `)
    .get(runId);
  if (!row) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  return runCheckpointSchema.parse({
    id: row.id,
    currentTick: toSafeNumber(row.current_tick, "run current tick"),
    nextEventSeq: toSafeNumber(row.next_event_seq, "run next event sequence"),
    idState: canonicalParse(row.id_state_canonical) as IdFactoryState,
  });
}
