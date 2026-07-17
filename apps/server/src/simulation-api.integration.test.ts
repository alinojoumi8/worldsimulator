import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceSimulationResponseSchema,
  controlSimulationResponseSchema,
  createSimulationResponseSchema,
  eventListResponseSchema,
  injectWorldEventResponseSchema,
  replaySimulationResponseSchema,
  simulationDetailResponseSchema,
  simulationListResponseSchema,
  simulationStatusResponseSchema,
} from "@worldtangle/shared";
import {
  KIMI_K2_7_CODE_MODEL,
  MINIMAX_M3_MODEL,
} from "@worldtangle/engine";
import { buildApp } from "./app";

const temporaryDirectories: string[] = [];
const applications: FastifyInstance[] = [];

function createApp(
  dataDir?: string,
  tickIntervalMs = 250,
  enableAgentFramework = false,
): { app: FastifyInstance; dataDir: string } {
  const resolvedDataDir = dataDir ?? mkdtempSync(join(tmpdir(), "worldtangle-api-"));
  if (dataDir === undefined) temporaryDirectories.push(resolvedDataDir);
  const app = buildApp({
    dataDir: resolvedDataDir,
    wallClock: () => "2026-07-14T12:00:00.000Z",
    tickIntervalMs,
    enableAgentFramework,
  });
  applications.push(app);
  return { app, dataDir: resolvedDataDir };
}

const validCreateRequest = {
  name: "baseline-riverbend",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: { income_tax_rate_bp: 1_800 },
    endTick: 360,
  },
};

function object(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

async function waitForTerminalStatus(app: FastifyInstance, simulationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status`,
    });
    const body = object(response.json());
    const run = object(body["run"]);
    if (run["status"] === "completed" || run["status"] === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not reach a terminal status");
}

async function waitForTaskCompletion(app: FastifyInstance, simulationId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status`,
    });
    const body = object(response.json());
    const task = body["task"] === null ? null : object(body["task"]);
    if (task?.["status"] === "completed" || task?.["status"] === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("API task did not reach a terminal status");
}

async function waitForReplayCompletion(
  app: FastifyInstance,
  simulationId: string,
  runId: string,
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
    });
    const body = object(response.json());
    const replay = body["replay"] === null ? null : object(body["replay"]);
    if (replay !== null && replay["status"] !== "running") return replay;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("replay did not reach a terminal status");
}

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Phase 1 simulation API", () => {
  it("pins provider-neutral live routing in the immutable run manifest", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-live-routing-"));
    temporaryDirectories.push(dataDir);
    const app = buildApp({
      dataDir,
      enableAgentFramework: false,
      kimiModel: KIMI_K2_7_CODE_MODEL,
      wallClock: () => "2026-07-14T12:00:00.000Z",
    });
    applications.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, llmMode: "live" },
      },
    });
    const created = createSimulationResponseSchema.parse(response.json());
    expect(created.run.manifest.modelRouting).toEqual({
      tier2_provider: "minimax",
      tier2_routine: MINIMAX_M3_MODEL,
      tier3_provider: "kimi",
      tier3: KIMI_K2_7_CODE_MODEL,
    });
  });

  it("persists a journaled lifecycle, paused ticks, and status across restart", async () => {
    const { app, dataDir } = createApp();
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: validCreateRequest,
    });
    expect(createdResponse.statusCode).toBe(201);
    expect(createSimulationResponseSchema.safeParse(createdResponse.json()).success).toBe(true);
    const created = object(createdResponse.json());
    const simulation = object(created["simulation"]);
    const run = object(created["run"]);
    expect(simulation).toMatchObject({
      id: "sim_00000001",
      name: "baseline-riverbend",
      status: "created",
    });
    expect(run).toMatchObject({ id: "run_00000001", status: "created", currentTick: 0 });
    expect(object(created["meta"])).toEqual({ simulated: true, apiVersion: 1 });

    const initialEvents = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sim_00000001/events",
    });
    expect(initialEvents.statusCode).toBe(200);
    expect(eventListResponseSchema.safeParse(initialEvents.json()).success).toBe(true);
    expect(array(object(initialEvents.json())["items"]).map((item) => object(item)["type"]))
      .toEqual(["simulation.created", "admin.command.received"]);

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(controlSimulationResponseSchema.safeParse(started.json()).success).toBe(true);
    const startBody = object(started.json());
    expect(object(startBody["run"])["status"]).toBe("running");
    expect(startBody["commandEventId"]).toBe("evt_00000003");

    const duplicateStart = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    expect(duplicateStart.statusCode).toBe(409);
    expect(object(duplicateStart.json())["code"]).toBe("CONFLICT");

    const afterRejected = object(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/simulations/sim_00000001/events",
        })
      ).json(),
    );
    const afterRejectedItems = array(afterRejected["items"]).map(object);
    expect(afterRejectedItems).toHaveLength(4);
    expect(afterRejectedItems.map((event) => event["type"])).toEqual([
      "simulation.started",
      "admin.command.received",
      "simulation.created",
      "admin.command.received",
    ]);
    expect(afterRejectedItems[0]?.["causationId"]).toBe(startBody["commandEventId"]);
    expect(object(afterRejectedItems[0]?.["payload"])["byCommandEventId"]).toBe(
      startBody["commandEventId"],
    );

    const paused = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    expect(paused.statusCode).toBe(202);
    expect(object(object(paused.json())["run"])["status"]).toBe("paused");

    const resumed = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/resume",
      payload: {},
    });
    expect(resumed.statusCode).toBe(202);
    expect(object(object(resumed.json())["run"])["status"]).toBe("running");
    const pausedAgain = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    expect(pausedAgain.statusCode).toBe(202);

    const advanced = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 2 },
    });
    expect(advanced.statusCode).toBe(200);
    expect(advanceSimulationResponseSchema.safeParse(advanced.json()).success).toBe(true);
    const advancedBody = object(advanced.json());
    expect(object(advancedBody["run"])).toEqual({ currentTick: 2, status: "paused" });
    expect(object(advancedBody["tickResults"])).toEqual({ executed: 2, events: 4 });

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/stop",
      payload: {},
    });
    expect(stopped.statusCode).toBe(202);
    expect(object(object(stopped.json())["run"])["status"]).toBe("stopped");

    await app.close();
    applications.splice(applications.indexOf(app), 1);
    const reopened = createApp(dataDir).app;
    const status = await reopened.inject({
      method: "GET",
      url: "/api/v1/simulations/sim_00000001/status",
    });
    expect(status.statusCode).toBe(200);
    expect(simulationStatusResponseSchema.safeParse(status.json()).success).toBe(true);
    const statusBody = object(status.json());
    expect(object(statusBody["run"])).toEqual({
      id: "run_00000001",
      status: "stopped",
      currentTick: 2,
      simDate: "Y0001-M01-D02",
      endTick: 360,
    });
    expect(object(statusBody["llm"])).toMatchObject({ mode: "mock", budgetPct: 0 });
  });

  it("re-executes a terminal run from its manifest, journal, and cache", async () => {
    const { app } = createApp();
    const created = createSimulationResponseSchema.parse((await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, endTick: 10 },
      },
    })).json());
    await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/start`,
      payload: { runId: created.run.id },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/pause`,
      payload: { runId: created.run.id },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/advance`,
      payload: { runId: created.run.id, ticks: 2 },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/stop`,
      payload: { runId: created.run.id },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/runs/${created.run.id}/replay`,
      payload: { mode: "strict" },
    });
    expect(response.statusCode).toBe(202);
    const accepted = replaySimulationResponseSchema.parse(response.json());
    expect(accepted.replayRun).toMatchObject({
      replayOf: created.run.id,
      status: "running",
      toTick: 2,
    });

    const replay = await waitForReplayCompletion(
      app,
      created.simulation.id,
      accepted.replayRun.id,
    );
    expect(replay).toMatchObject({
      replayOf: created.run.id,
      status: "completed",
      currentTick: 2,
      divergenceCount: 0,
    });
    expect(replay["sourceStateHash"]).toBe(replay["replayStateHash"]);
  });

  it("paginates committed events newest-first without gaps or duplicates", async () => {
    const { app } = createApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: validCreateRequest,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });

    const first = object(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/simulations/sim_00000001/events?limit=3",
        })
      ).json(),
    );
    const firstItems = array(first["items"]).map(object);
    expect(firstItems.map((item) => item["seq"])).toEqual([5, 4, 3]);
    expect(first["nextCursor"]).toBeTypeOf("string");

    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/sim_00000001/events?limit=3&cursor=${String(first["nextCursor"])}`,
    });
    expect(secondResponse.statusCode).toBe(200);
    const second = object(secondResponse.json());
    expect(array(second["items"]).map((item) => object(item)["seq"])).toEqual([2, 1, 0]);
    expect(second["nextCursor"]).toBeNull();

    const commands = object(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/simulations/sim_00000001/events?type=admin.command.received",
        })
      ).json(),
    );
    expect(array(commands["items"]).map((item) => object(item)["seq"])).toEqual([4, 2, 0]);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sim_00000001/events?cursor=not+base64",
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("rejects unsupported worlds and invalid budgets without publishing a simulation", async () => {
    const { app } = createApp();
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, worldSpec: "unknown@1" },
      },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(object(unsupported.json())["code"]).toBe("VALIDATION_FAILED");

    const zeroBudget = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: {
          ...validCreateRequest.scenario,
          budgets: { ...validCreateRequest.scenario.budgets, runCostCentsMax: "0" },
        },
      },
    });
    expect(zeroBudget.statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: "/api/v1/simulations" });
    expect(array(object(list.json())["items"])).toEqual([]);
  });

  it("lists and details simulations with deterministic opaque pagination", async () => {
    const { app } = createApp();
    for (const name of ["first", "second"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/simulations",
        payload: { ...validCreateRequest, name },
      });
      expect(response.statusCode).toBe(201);
    }

    const firstPage = object(
      (await app.inject({ method: "GET", url: "/api/v1/simulations?limit=1" })).json(),
    );
    expect(simulationListResponseSchema.safeParse(firstPage).success).toBe(true);
    expect(object(array(firstPage["items"])[0])["id"]).toBe("sim_00000002");
    expect(firstPage["nextCursor"]).toBeTypeOf("string");

    const secondPageResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations?limit=1&cursor=${String(firstPage["nextCursor"])}`,
    });
    expect(secondPageResponse.statusCode).toBe(200);
    const secondPage = object(secondPageResponse.json());
    expect(object(array(secondPage["items"])[0])["id"]).toBe("sim_00000001");
    expect(secondPage["nextCursor"]).toBeNull();

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sim_00000002",
    });
    expect(detail.statusCode).toBe(200);
    expect(simulationDetailResponseSchema.safeParse(detail.json()).success).toBe(true);
    const detailBody = object(detail.json());
    expect(object(detailBody["simulation"])).toMatchObject({ id: "sim_00000002", name: "second" });
    expect(object(array(detailBody["runs"])[0])).toMatchObject({
      id: "run_00000002",
      seed: 42,
      status: "created",
    });
  });

  it("recovers a running simulation after restart and completes at endTick", async () => {
    const { app, dataDir } = createApp(undefined, 60_000);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, endTick: 2 },
      },
    });
    expect(created.statusCode).toBe(201);
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    expect(object(object(started.json())["run"])["status"]).toBe("running");
    expect(object((await app.inject({ method: "GET", url: "/api/v1/health" })).json())["engine"])
      .toBe("running");
    await app.close();
    applications.splice(applications.indexOf(app), 1);

    const reopened = createApp(dataDir, 5).app;
    const terminal = await waitForTerminalStatus(reopened, "sim_00000001");
    expect(terminal).toMatchObject({ status: "completed", currentTick: 2, endTick: 2 });

    const events = object(
      (
        await reopened.inject({
          method: "GET",
          url: "/api/v1/simulations/sim_00000001/events?type=simulation.completed",
        })
      ).json(),
    );
    const completion = object(array(events["items"])[0]);
    expect(completion["actor"]).toEqual({ kind: "system", id: "engine" });
  });

  it("completes a paused run at endTick and forbids resuming it", async () => {
    const { app } = createApp(undefined, 60_000);
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, endTick: 1 },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    const advanced = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 1 },
    });
    expect(advanced.statusCode).toBe(200);
    expect(object(object(advanced.json())["run"])).toEqual({
      currentTick: 1,
      status: "completed",
    });
    const resumed = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/resume",
      payload: {},
    });
    expect(resumed.statusCode).toBe(409);

    const tickEvents = object(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/simulations/sim_00000001/events?type=simulation.tick.completed",
        })
      ).json(),
    );
    expect(object(object(array(tickEvents["items"])[0])["payload"])).toMatchObject({
      counts: { events: 2, transactions: 0, decisions: 0, llmCalls: 0 },
      durationMs: 0,
    });
  });

  it("executes large advances through a restart-safe async task", async () => {
    const { app } = createApp(undefined, 60_000);
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        ...validCreateRequest,
        scenario: { ...validCreateRequest.scenario, endTick: 51 },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 51 },
    });
    expect(response.statusCode).toBe(202);
    expect(advanceSimulationResponseSchema.safeParse(response.json()).success).toBe(true);
    const taskId = object(response.json())["taskId"];
    expect(taskId).toBe("task_00000001");

    const conflictingResume = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/resume",
      payload: {},
    });
    expect(conflictingResume.statusCode).toBe(409);

    const completed = await waitForTaskCompletion(app, "sim_00000001");
    expect(object(completed["run"])).toMatchObject({ status: "completed", currentTick: 51 });
    expect(object(completed["task"])).toMatchObject({
      id: taskId,
      status: "completed",
      startTick: 0,
      targetTick: 51,
      completedTicks: 51,
    });
  });

  it("journals, schedules, applies, and reopens an approved world event", async () => {
    const { app, dataDir } = createApp(undefined, 60_000, true);
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: validCreateRequest,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    const whileRunning = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/world-events",
      payload: {
        type: "energy.fuel_price_shock",
        params: { deltaPct: 30 },
      },
    });
    expect(whileRunning.statusCode).toBe(409);
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });

    const rejectedCatalogEntry = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/world-events",
      payload: { type: "arbitrary.tool_call", params: {} },
    });
    expect(rejectedCatalogEntry.statusCode).toBe(400);
    const injectedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/world-events",
      payload: {
        type: "energy.fuel_price_shock",
        params: { deltaPct: 30 },
      },
    });
    expect(injectedResponse.statusCode).toBe(202);
    expect(injectWorldEventResponseSchema.safeParse(injectedResponse.json()).success).toBe(true);
    const injectedBody = object(injectedResponse.json());
    expect(object(injectedBody["worldEvent"])).toMatchObject({
      type: "energy.fuel_price_shock",
      status: "scheduled",
      createdTick: 0,
      scheduledTick: 1,
      effectEventIds: [],
    });

    const advanced = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 1 },
    });
    expect(advanced.statusCode).toBe(200);

    const eventOfType = async (type: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/simulations/sim_00000001/events?type=${type}`,
      });
      expect(response.statusCode).toBe(200);
      return object(array(object(response.json())["items"])[0]);
    };
    const injectedEvent = await eventOfType("world.event.injected");
    const appliedEvent = await eventOfType("world.event.applied");
    const fuelEvent = await eventOfType("energy.fuel_price.changed");
    expect(appliedEvent["causationId"]).toBe(injectedEvent["eventId"]);
    expect(fuelEvent["causationId"]).toBe(appliedEvent["eventId"]);
    expect(object(fuelEvent["payload"])).toMatchObject({
      oldPriceCents: "100",
      newPriceCents: "130",
      changeBp: 3_000,
      causeEventId: appliedEvent["eventId"],
    });

    await app.close();
    applications.splice(applications.indexOf(app), 1);
    const reopened = createApp(dataDir, 60_000, true).app;
    const persisted = await reopened.inject({
      method: "GET",
      url: "/api/v1/simulations/sim_00000001/events?type=world.event.applied",
    });
    expect(array(object(persisted.json())["items"])).toHaveLength(1);
  });

  it("recovers an unfinished async advance task after app restart", async () => {
    const { app, dataDir } = createApp(undefined, 60_000);
    await app.inject({ method: "POST", url: "/api/v1/simulations", payload: validCreateRequest });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/start",
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 51 },
    });
    expect(queued.statusCode).toBe(202);
    await app.close();
    applications.splice(applications.indexOf(app), 1);

    const reopened = createApp(dataDir, 60_000).app;
    const completed = await waitForTaskCompletion(reopened, "sim_00000001");
    expect(object(completed["run"])).toMatchObject({ status: "paused", currentTick: 51 });
    expect(object(completed["task"])).toMatchObject({
      id: "task_00000001",
      status: "completed",
      completedTicks: 51,
    });
  });
});
