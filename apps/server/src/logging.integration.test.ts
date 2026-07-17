import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHASES } from "@worldtangle/engine";
import { buildApp } from "./app";
import { createLogger, PHASE_TIMING_EVENT } from "./logger";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("server logging integration", () => {
  it("binds run context and emits non-authoritative timing for every phase", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-logging-"));
    temporaryDirectories.push(dataDir);
    const chunks: string[] = [];
    const logger = createLogger({
      destination: { write: (message: string) => chunks.push(message) },
    });
    const app = buildApp({
      dataDir,
      tickIntervalMs: 60_000,
      enableAgentFramework: false,
      wallClock: () => "2026-07-14T12:00:00.000Z",
      logger,
    });
    const createPayload = {
      name: "logging-world",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 1,
        llmMode: "mock",
        budgets: { runCostCentsMax: "10", perAgentDailyTokens: 10 },
        policyOverrides: {},
        endTick: 10,
      },
    };

    await app.inject({ method: "POST", url: "/api/v1/simulations", payload: createPayload });
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
    await app.close();

    const lines = chunks
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const timings = lines.filter((line) => line["event"] === PHASE_TIMING_EVENT);
    expect(timings).toHaveLength(PHASES.length);
    expect(timings.map((line) => line["phase"])).toEqual(PHASES);
    for (const timing of timings) {
      expect(timing).toMatchObject({
        simulationId: "sim_00000001",
        runId: "run_00000001",
        tick: 1,
        unit: "ms",
      });
      expect(timing["correlationId"]).toBeTypeOf("string");
      expect(timing["durationMs"]).toBeTypeOf("number");
    }
    expect(lines.some((line) => line["event"] === "simulation.created")).toBe(true);
    expect(lines.some((line) => line["event"] === "simulation.advanced")).toBe(true);
  });

  it("logs rejected lifecycle and advance requests with correlation and run checkpoints", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-error-logging-"));
    temporaryDirectories.push(dataDir);
    const chunks: string[] = [];
    const logger = createLogger({
      destination: { write: (message: string) => chunks.push(message) },
    });
    const app = buildApp({
      dataDir,
      tickIntervalMs: 60_000,
      enableAgentFramework: false,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      logger,
    });
    const createPayload = {
      name: "error-logging-world",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 1,
        llmMode: "mock",
        budgets: { runCostCentsMax: "10", perAgentDailyTokens: 10 },
        policyOverrides: {},
        endTick: 10,
      },
    };

    await app.inject({ method: "POST", url: "/api/v1/simulations", payload: createPayload });
    const illegalPause = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/pause",
      payload: {},
    });
    expect(illegalPause.statusCode).toBe(409);
    const pauseCorrelationId = (illegalPause.json() as Record<string, unknown>)["correlationId"];

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
    const oversizedAdvance = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sim_00000001/advance",
      payload: { ticks: 11 },
    });
    expect(oversizedAdvance.statusCode).toBe(409);
    const advanceCorrelationId = (oversizedAdvance.json() as Record<string, unknown>)[
      "correlationId"
    ];
    await app.close();

    const lines = chunks
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      lines.find(
        (line) =>
          line["event"] === "simulation.lifecycle.failed" &&
          line["correlationId"] === pauseCorrelationId,
      ),
    ).toMatchObject({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      tick: 0,
      code: "CONFLICT",
      command: "pause",
    });
    expect(
      lines.find(
        (line) =>
          line["event"] === "simulation.advance.failed" &&
          line["correlationId"] === advanceCorrelationId,
      ),
    ).toMatchObject({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      tick: 0,
      code: "CONFLICT",
      ticks: 11,
    });
    expect(
      lines.filter((line) => line["event"] === "api.request.failed"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correlationId: pauseCorrelationId, code: "CONFLICT", status: 409 }),
        expect.objectContaining({
          correlationId: advanceCorrelationId,
          code: "CONFLICT",
          status: 409,
        }),
      ]),
    );
  });
});
