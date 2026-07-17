import { mkdtempSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "@worldtangle/shared";
import { buildApp } from "./app";
import {
  frameForCommittedEvent,
  readCommittedEventBatch,
  serializeSseFrame,
  type EventStreamTopic,
} from "./event-stream";
import { openWorldDatabase, worldDatabasePath } from "./persistence/database";
import { SqliteEventStore } from "./persistence/event-store";
import type { RunLocation } from "./persistence/run-locator";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./persistence/test-helpers";

const temporaryDirectories: string[] = [];
const applications: FastifyInstance[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-sse-"));
  temporaryDirectories.push(path);
  return path;
}

function topics(...values: EventStreamTopic[]): ReadonlySet<EventStreamTopic> {
  return new Set(values);
}

function event(
  seq: number,
  type: string,
  tick: number,
  payload: unknown,
): EventEnvelope {
  return {
    eventId: `evt_${(seq + 1).toString(36).padStart(8, "0")}`,
    type,
    schemaVersion: 1,
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    seq,
    tick,
    simDate: "Y0001-M01-D01",
    wallTime: "2026-07-14T12:00:00.000Z",
    actor: { kind: "system", id: "engine" },
    correlationId: `tick-${tick}`,
    payload,
  };
}

function committedFixture(): RunLocation {
  const dataDir = temporaryDirectory();
  const databasePath = worldDatabasePath(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  insertTestRun(db);
  new SqliteEventStore(db, TEST_RUN_ID).appendBatch([
    event(0, "simulation.started", 0, { status: "running" }),
    event(1, "simulation.tick.started", 1, { tick: 1 }),
    event(2, "simulation.tick.completed", 1, {
      tick: 1,
      counts: { events: 2, transactions: 0, decisions: 0, llmCalls: 0 },
      durationMs: 0,
    }),
    event(3, "simulation.paused", 1, { status: "paused" }),
  ]);
  db.close();
  return { simulationId: TEST_SIMULATION_ID, runId: TEST_RUN_ID, databasePath };
}

interface OpenStream {
  readonly text: string;
  readonly headers: IncomingHttpHeaders;
  readonly closed: Promise<void>;
}

function openStreamUntil(
  url: string,
  headers: Readonly<Record<string, string>>,
  marker: string,
): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpGet(url, { headers }, (response: IncomingMessage) => {
      response.setEncoding("utf8");
      let text = "";
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>((closedResolve) => {
        resolveClosed = closedResolve;
      });
      response.once("end", () => resolveClosed?.());
      response.once("close", () => resolveClosed?.());
      response.on("data", (chunk: string) => {
        text += chunk;
        if (!settled && text.includes(marker)) {
          settled = true;
          clearTimeout(timeout);
          resolve({ text, headers: response.headers, closed });
        }
      });
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`timed out waiting for SSE marker: ${marker}`));
    }, 2_000);
    timeout.unref();
  });
}

const createRequest = {
  name: "sse-world",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: {},
    endTick: 360,
  },
};

async function listeningApp(maxBacklogEvents = 100): Promise<{
  app: FastifyInstance;
  origin: string;
}> {
  const app = buildApp({
    dataDir: temporaryDirectory(),
    wallClock: () => "2026-07-14T12:00:00.000Z",
    tickIntervalMs: 60_000,
    enableAgentFramework: false,
    ssePollIntervalMs: 5,
    sseHeartbeatIntervalMs: 10,
    sseMaxBacklogEvents: maxBacklogEvents,
  });
  applications.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/simulations",
        payload: createRequest,
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${TEST_SIMULATION_ID}/start`,
        payload: {},
      })
    ).statusCode,
  ).toBe(202);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${TEST_SIMULATION_ID}/pause`,
        payload: {},
      })
    ).statusCode,
  ).toBe(202);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${TEST_SIMULATION_ID}/advance`,
        payload: { ticks: 1 },
      })
    ).statusCode,
  ).toBe(200);
  return { app, origin };
}

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("committed event SSE formatting", () => {
  it("builds the v1 financial digest from a completed tick", () => {
    const frame = frameForCommittedEvent(
      event(2, "simulation.tick.completed", 1, {
        indicators: {
          m1: "510000000",
          unemploymentRate: "649",
          treasuryBalance: "18000000",
        },
        counts: { events: 7, transactions: 3, decisions: 2, llmCalls: 1 },
      }),
      topics("digest"),
    );
    expect(frame).toEqual({
      id: 2,
      event: "digest",
      data: {
        v: 1,
        tick: 1,
        simDate: "Y0001-M01-D01",
        indicators: {
          m1: "510000000",
          unemploymentRate: "649",
          treasuryBalance: "18000000",
        },
        counts: {
          events: 7,
          transactions: 3,
          decisions: 2,
          llmCalls: 1,
          rejectedIntents: 0,
        },
        notable: [],
        spend: { budgetPct: 0 },
      },
    });
    expect(serializeSseFrame(frame!)).toContain(
      "id: 2\nevent: digest\ndata: {\"v\":1",
    );
  });

  it("advances over unsubscribed rows and resumes strictly after Last-Event-ID", () => {
    const batch = readCommittedEventBatch(
      committedFixture(),
      0,
      topics("digest", "lifecycle"),
      100,
    );
    expect(batch.gap).toBe(false);
    expect(batch.deliveries.map((delivery) => delivery.throughSeq)).toEqual([1, 2, 3]);
    expect(
      batch.deliveries.flatMap((delivery) =>
        delivery.frame === undefined ? [] : [delivery.frame.event],
      ),
    ).toEqual(["digest", "lifecycle"]);
  });

  it("coalesces a lagging committed backlog into one gap-to-latest frame", () => {
    const batch = readCommittedEventBatch(
      committedFixture(),
      0,
      topics("digest", "lifecycle"),
      2,
    );
    expect(batch).toEqual({
      gap: true,
      deliveries: [
        {
          throughSeq: 3,
          frame: {
            id: 3,
            event: "gap",
            data: { fromSeq: 1, toSeq: 3 },
          },
        },
      ],
    });
  });
});

describe("GET /api/v1/simulations/:simId/stream", () => {
  it("resumes from committed seq, emits heartbeat, and closes during app shutdown", async () => {
    const { app, origin } = await listeningApp();
    const stream = await openStreamUntil(
      `${origin}/api/v1/simulations/${TEST_SIMULATION_ID}/stream?topics=digest,lifecycle`,
      { "Last-Event-ID": "5" },
      ":hb\n\n",
    );
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.text).toContain("id: 8\nevent: digest\n");
    expect(stream.text).not.toContain("event: lifecycle");
    expect(stream.text).toContain(":hb\n\n");

    await expect(app.close()).resolves.toBeUndefined();
    await expect(stream.closed).resolves.toBeUndefined();
    applications.splice(applications.indexOf(app), 1);
  });

  it("sends a gap frame to a simulated lagging client", async () => {
    const { app, origin } = await listeningApp(2);
    const stream = await openStreamUntil(
      `${origin}/api/v1/simulations/${TEST_SIMULATION_ID}/stream?topics=digest,lifecycle`,
      { "Last-Event-ID": "0" },
      "event: gap",
    );
    expect(stream.text).toContain("id: 8\nevent: gap\n");
    expect(stream.text).toContain('data: {"fromSeq":1,"toSeq":8}');
    await app.close();
    await stream.closed;
    applications.splice(applications.indexOf(app), 1);
  });

  it("rejects unknown topics and malformed resume IDs before opening a stream", async () => {
    const app = buildApp({ dataDir: temporaryDirectory(), enableAgentFramework: false });
    applications.push(app);
    const invalidTopic = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${TEST_SIMULATION_ID}/stream?topics=digest,market`,
    });
    expect(invalidTopic.statusCode).toBe(400);
    const invalidResume = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${TEST_SIMULATION_ID}/stream?topics=digest`,
      headers: { "last-event-id": "1.5" },
    });
    expect(invalidResume.statusCode).toBe(400);
  });
});
