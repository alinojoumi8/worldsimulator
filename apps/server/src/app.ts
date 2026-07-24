/**
 * M22 API skeleton (API_CONTRACTS.md). Foundation scope: health + version +
 * problem+json error shapes + optional bearer token (ADR-0011). Simulation
 * endpoints land in Phase 1 behind this same app factory.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import type { Logger } from "pino";
import {
  apiRootResponseSchema,
  EngineError,
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  PROMPT_PACK_VERSION,
  RULESET_VERSION,
} from "@worldtangle/shared";
import type { KimiAccessMode, KimiModel, LlmModelPrice } from "@worldtangle/engine";
import { SimulationService } from "./simulation-service";
import {
  registerSimulationRoutes,
  type SimulationApi,
} from "./simulation-routes";
import {
  CommittedEventStream,
  registerEventStreamRoute,
} from "./event-stream";
import {
  AgentLabGateway,
  registerAgentLabRoutes,
} from "./agent-lab-gateway";

export interface AppOptions {
  /** When set, API routes except /api/v1/health require `Authorization: Bearer <token>`. */
  apiToken?: string;
  /** Root for authoritative per-run databases. Defaults to ./data. */
  dataDir?: string;
  /** Test seam for deterministic API event wall times. */
  wallClock?: () => string;
  /** Tick cadence for continuously running simulations. */
  tickIntervalMs?: number;
  /** Periodic post-commit snapshot cadence. Defaults to every 100 ticks. */
  snapshotIntervalTicks?: number;
  /** Enables the Phase 2 Riverbend agent framework. Defaults to true. */
  enableAgentFramework?: boolean;
  /** Phase-isolation seam; production defaults to the Phase 7 news pipeline. */
  enableNewsPipeline?: boolean;
  /** Optional live Anthropic credential; omitted live runs fail closed to Tier 1. */
  anthropicApiKey?: string;
  /** MiniMax Token Plan or API key for live Tier-2 decisions. */
  minimaxApiKey?: string;
  /** Kimi Code Token Plan or Moonshot Open Platform key for live Tier-3 decisions. */
  kimiApiKey?: string;
  /** Must match the Kimi credential source; defaults to Kimi Code Token Plan. */
  kimiAccessMode?: KimiAccessMode;
  /** General-purpose K2.6 by default; K2.7 Code may be selected explicitly. */
  kimiModel?: KimiModel;
  /** Exact provider price table required before successful live usage can commit. */
  llmModelPrices?: ReadonlyMap<string, LlmModelPrice>;
  /** Committed-event SSE polling cadence. */
  ssePollIntervalMs?: number;
  /** SSE heartbeat cadence; defaults to 15 seconds (ADR-0012). */
  sseHeartbeatIntervalMs?: number;
  /** Maximum raw event backlog before the stream coalesces to a gap frame. */
  sseMaxBacklogEvents?: number;
  /** Optional application-service adapter for route-level contract tests. */
  simulationApi?: SimulationApi;
  /** Pino instance for production; omitted/false keeps tests quiet. */
  logger?: Logger | false;
  /** Built dashboard root. `false` disables static delivery; defaults to apps/web/dist when built. */
  webRoot?: string | false;
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  correlationId: string;
  instance?: string;
}

function problem(
  status: number,
  code: string,
  title: string,
  correlationId: string,
  detail?: string,
  instance?: string,
): Problem {
  return {
    type: `urn:worldtangle:error:${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    correlationId,
    ...(detail !== undefined ? { detail } : {}),
    ...(instance !== undefined ? { instance } : {}),
  };
}

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

function registerWebShell(app: FastifyInstance, webRoot: string): void {
  app.register(async (web) => {
    await web.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });

    // With wildcard disabled, @fastify/static registers an exact route for
    // every built asset (including `/`). Add only the client-side detail route.
    web.get("/simulations/:simId", async (_request, reply) => reply.sendFile("index.html"));
  });
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const logger = options.logger ?? false;
  const dataDir = options.dataDir ?? "data";
  const app: FastifyInstance = logger === false
    ? Fastify({ logger: false })
    : Fastify({ loggerInstance: logger as FastifyBaseLogger });

  const apiToken = options.apiToken;
  if (apiToken) {
    const expected = `Bearer ${apiToken}`;
    app.addHook("onRequest", async (request, reply) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      const isApiPath = pathname === "/api/v1" || pathname.startsWith("/api/v1/");
      const isAgentLabPath = pathname.startsWith("/api/v1/agent-lab/");
      if (!isApiPath || pathname === "/api/v1/health" || isAgentLabPath) return;
      if (request.headers.authorization !== expected) {
        return reply
          .code(401)
          .type("application/problem+json")
          .send(
            problem(
              401,
              "UNAUTHORIZED",
              "Missing or invalid bearer token",
              request.id,
              undefined,
              request.url,
            ),
          );
      }
    });
  }

  const simulationApi =
    options.simulationApi ??
    new SimulationService({
      dataDir,
      ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
      ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
      ...(options.snapshotIntervalTicks === undefined
        ? {}
        : { snapshotIntervalTicks: options.snapshotIntervalTicks }),
      ...(options.enableAgentFramework === undefined
        ? {}
        : { enableAgentFramework: options.enableAgentFramework }),
      ...(options.enableNewsPipeline === undefined
        ? {}
        : { enableNewsPipeline: options.enableNewsPipeline }),
      ...(options.anthropicApiKey === undefined
        ? {}
        : { anthropicApiKey: options.anthropicApiKey }),
      ...(options.minimaxApiKey === undefined
        ? {}
        : { minimaxApiKey: options.minimaxApiKey }),
      ...(options.kimiApiKey === undefined
        ? {}
        : { kimiApiKey: options.kimiApiKey }),
      ...(options.kimiAccessMode === undefined
        ? {}
        : { kimiAccessMode: options.kimiAccessMode }),
      ...(options.kimiModel === undefined ? {} : { kimiModel: options.kimiModel }),
      ...(options.llmModelPrices === undefined
        ? {}
        : { llmModelPrices: options.llmModelPrices }),
      ...(logger === false ? {} : { logger }),
    });
  const eventStream = new CommittedEventStream({
    dataDir,
    ...(options.ssePollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.ssePollIntervalMs }),
    ...(options.sseHeartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.sseHeartbeatIntervalMs }),
    ...(options.sseMaxBacklogEvents === undefined
      ? {}
      : { maxBacklogEvents: options.sseMaxBacklogEvents }),
    onError: (error, location) => {
      app.log.error(
        {
          event: "sse.poll.failed",
          err: error,
          simulationId: location.simulationId,
          runId: location.runId,
        },
        "committed-event stream poll failed",
      );
    },
  });

  app.get("/api/v1", async () => apiRootResponseSchema.parse({
    name: "WorldTangle",
    simulated: true,
    apiVersion: 1,
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    rulesetVersion: RULESET_VERSION,
    promptPackVersion: PROMPT_PACK_VERSION,
    links: {
      health: "/api/v1/health",
      version: "/api/v1/version",
      simulations: "/api/v1/simulations",
    },
  }));

  app.get("/api/v1/health", async () => ({
    status: "ok",
    engine: simulationApi.engineState?.() ?? "idle",
    version: ENGINE_VERSION,
    simulated: true,
  }));

  app.get("/api/v1/version", async () => ({
    apiVersion: 1,
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    rulesetVersion: RULESET_VERSION,
    promptPackVersion: PROMPT_PACK_VERSION,
    simulated: true,
  }));

  registerSimulationRoutes(app, simulationApi);
  registerEventStreamRoute(app, eventStream);
  registerAgentLabRoutes(
    app,
    new AgentLabGateway(
      dataDir,
      options.wallClock ?? (() => new Date().toISOString()),
    ),
  );
  const webRoot = options.webRoot === undefined ? DEFAULT_WEB_ROOT : options.webRoot;
  if (webRoot !== false && existsSync(webRoot)) {
    registerWebShell(app, webRoot);
  }
  // Active SSE responses must end before Fastify waits for the HTTP server to
  // drain, otherwise app.close() can be held open by dashboard clients.
  app.addHook("preClose", async () => {
    eventStream.close();
  });
  app.addHook("onClose", async () => {
    await simulationApi.close?.();
  });

  app.setNotFoundHandler(async (request, reply) => {
    await reply
      .code(404)
      .type("application/problem+json")
      .send(
        problem(
          404,
          "NOT_FOUND",
          "Route not found",
          request.id,
          `No route for ${request.method} ${request.url}`,
          request.url,
        ),
      );
  });

  app.setErrorHandler(async (error, request, reply) => {
    const engineError = error instanceof EngineError ? error : undefined;
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const statusByEngineCode: Record<string, number> = {
      VALIDATION_FAILED: 400,
      SCHEMA_INVALID: 400,
      PERMISSION_DENIED: 403,
      NOT_FOUND: 404,
      INSUFFICIENT_FUNDS: 409,
      CONFLICT: 409,
      BUDGET_EXHAUSTED: 409,
      LIMIT_EXCEEDED: 429,
      INTERNAL: 500,
    };
    const status = engineError
      ? (statusByEngineCode[engineError.code] ?? 500)
      : statusCode !== undefined && statusCode >= 400
        ? statusCode
        : 500;
    const code = engineError?.code ?? (status >= 500 ? "INTERNAL" : "VALIDATION_FAILED");
    const errorName = engineError?.code ?? (error instanceof Error ? error.name : "Error");
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";
    const logFields = {
      event: "api.request.failed",
      correlationId: request.id,
      code,
      status,
      method: request.method,
      url: request.url,
      err: error,
    };
    if (status >= 500) {
      request.log.error(logFields, "API request failed");
    } else {
      request.log.warn(logFields, "API request rejected");
    }
    await reply
      .code(status)
      .type("application/problem+json")
      .send(
        problem(
          status,
          code,
          errorName,
          request.id,
          errorMessage,
          request.url,
        ),
      );
  });

  return app;
}
