/** WS-102 acceptance benchmark: one prepared transaction for 10k staged events. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { EventEnvelope } from "@worldtangle/shared";
import { validateEventEnvelope } from "@worldtangle/engine";
import { openWorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";

const eventCount = 10_000;
const targetMs = Number(process.env["WORLDTANGLE_EVENT_BENCHMARK_MS"] ?? 100);
const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-event-benchmark-"));

try {
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  insertTestRun(db);
  const store = new SqliteEventStore(db, TEST_RUN_ID);
  const events: EventEnvelope[] = Array.from({ length: eventCount }, (_, seq) =>
    validateEventEnvelope({
      eventId: `evt_${(seq + 1).toString(36).padStart(8, "0")}`,
      type: "benchmark.event",
      schemaVersion: 1,
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      seq,
      tick: Math.floor(seq / 2) + 1,
      simDate: "Y0001-M01-D01",
      wallTime: "T0",
      actor: { kind: "system", id: "engine" },
      correlationId: "cor_00000001",
      payload: { seq },
    }),
  );

  const started = performance.now();
  store.appendBatch(events);
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      eventCount: store.count(),
      elapsedMs: Number(elapsedMs.toFixed(2)),
      targetMs,
      passed: elapsedMs < targetMs,
    }),
  );
  db.close();
  if (elapsedMs >= targetMs) process.exitCode = 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
