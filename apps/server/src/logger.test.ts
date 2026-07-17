import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@worldtangle/shared";
import {
  childRunLogger,
  createLogger,
  LOG_REDACTION_CENSOR,
  PHASE_TIMING_EVENT,
  PHASE_TIMING_METRIC,
  logPhaseTiming,
} from "./logger";

interface LogLine {
  [key: string]: unknown;
}

function captureLogs(options: Parameters<typeof createLogger>[0] = {}) {
  const chunks: string[] = [];
  const logger = createLogger({
    ...options,
    destination: {
      write(message: string) {
        chunks.push(message);
      },
    },
  });

  return {
    logger,
    lines(): LogLine[] {
      return chunks
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LogLine);
    },
  };
}

describe("createLogger", () => {
  it("adds stable service, version, and simulation bindings", () => {
    const capture = captureLogs();

    capture.logger.info({ event: "server.ready" }, "ready");

    expect(capture.lines()).toEqual([
      expect.objectContaining({
        level: 30,
        service: "worldtangle-server",
        version: ENGINE_VERSION,
        simulated: true,
        event: "server.ready",
        msg: "ready",
      }),
    ]);
  });

  it("uses an allowed environment level and safely falls back for unknown values", () => {
    const debugCapture = captureLogs({
      env: { WORLDTANGLE_LOG_LEVEL: "DEBUG" },
    });
    debugCapture.logger.debug({ event: "debug.enabled" });
    expect(debugCapture.lines()).toHaveLength(1);

    const fallbackCapture = captureLogs({
      env: { WORLDTANGLE_LOG_LEVEL: "verbose-and-secret" },
    });
    fallbackCapture.logger.debug({ event: "debug.disabled" });
    fallbackCapture.logger.info({ event: "info.enabled" });
    expect(fallbackCapture.lines()).toEqual([
      expect.objectContaining({ event: "info.enabled", level: 30 }),
    ]);
  });

  it("redacts authorization and API-key-like values in common request shapes", () => {
    const capture = captureLogs();

    capture.logger.info({
      authorization: "Bearer root-secret",
      apiKey: "provider-secret",
      config: { apiToken: "config-secret" },
      req: {
        headers: {
          authorization: "Bearer request-secret",
          "x-api-key": "header-secret",
        },
      },
    });

    const [line] = capture.lines();
    expect(line).toMatchObject({
      authorization: LOG_REDACTION_CENSOR,
      apiKey: LOG_REDACTION_CENSOR,
      config: { apiToken: LOG_REDACTION_CENSOR },
      req: {
        headers: {
          authorization: LOG_REDACTION_CENSOR,
          "x-api-key": LOG_REDACTION_CENSOR,
        },
      },
    });
    expect(JSON.stringify(line)).not.toContain("secret");
  });
});

describe("run logging helpers", () => {
  it("binds run context without inventing optional fields", () => {
    const capture = captureLogs();

    childRunLogger(capture.logger, {
      simulationId: "sim_000001",
      runId: "run_000001",
      tick: 0,
      correlationId: "cor_000001",
    }).warn({ event: "run.paused" });

    expect(capture.lines()).toEqual([
      expect.objectContaining({
        simulationId: "sim_000001",
        runId: "run_000001",
        tick: 0,
        correlationId: "cor_000001",
        event: "run.paused",
      }),
    ]);
  });

  it("records a stable per-phase timing metric with full run context", () => {
    const capture = captureLogs();

    logPhaseTiming(capture.logger, {
      simulationId: "sim_000002",
      runId: "run_000003",
      tick: 17,
      correlationId: "cor_000009",
      phase: "decisions",
      durationMs: 12.5,
    });

    expect(capture.lines()).toEqual([
      expect.objectContaining({
        level: 30,
        simulationId: "sim_000002",
        runId: "run_000003",
        tick: 17,
        correlationId: "cor_000009",
        event: PHASE_TIMING_EVENT,
        metric: PHASE_TIMING_METRIC,
        phase: "decisions",
        durationMs: 12.5,
        unit: "ms",
        msg: "simulation phase completed",
      }),
    ]);
  });
});
