import { buildApp } from "./app";
import { createLogger } from "./logger";
import {
  ANTHROPIC_DEFAULT_MODELS,
  KIMI_K2_6_MODEL,
  KIMI_K2_7_CODE_MODEL,
  MINIMAX_M3_MODEL,
  type KimiAccessMode,
  type KimiModel,
  type LlmModelPrice,
} from "@worldtangle/engine";

function modelPriceFromEnvironment(
  prefix: string,
  cachedPriceRequired = false,
): LlmModelPrice | undefined {
  const input = process.env[`${prefix}_INPUT_MICROCENTS_PER_TOKEN`];
  const cachedInput = process.env[`${prefix}_CACHED_INPUT_MICROCENTS_PER_TOKEN`];
  const output = process.env[`${prefix}_OUTPUT_MICROCENTS_PER_TOKEN`];
  if (input === undefined && cachedInput === undefined && output === undefined) return undefined;
  if (
    input === undefined ||
    output === undefined ||
    (cachedPriceRequired && cachedInput === undefined) ||
    !/^\d+$/.test(input) ||
    !/^\d+$/.test(output) ||
    (cachedInput !== undefined && !/^\d+$/.test(cachedInput))
  ) {
    throw new Error(
      `${prefix} token prices must be a complete set of nonnegative integer microcents`,
    );
  }
  return {
    inputMicrocentsPerToken: BigInt(input),
    ...(cachedInput === undefined
      ? {}
      : { cachedInputMicrocentsPerToken: BigInt(cachedInput) }),
    outputMicrocentsPerToken: BigInt(output),
  };
}

function kimiModelFromEnvironment(value: string | undefined): KimiModel {
  const model = value ?? KIMI_K2_6_MODEL;
  if (model !== KIMI_K2_6_MODEL && model !== KIMI_K2_7_CODE_MODEL) {
    throw new Error(
      `WORLDTANGLE_KIMI_MODEL must be ${KIMI_K2_6_MODEL} or ${KIMI_K2_7_CODE_MODEL}`,
    );
  }
  return model;
}

const port = Number(process.env["WORLDTANGLE_PORT"] ?? 4000);
const host = process.env["WORLDTANGLE_BIND"] ?? "127.0.0.1";
const apiToken = process.env["WORLDTANGLE_API_TOKEN"];
const dataDir = process.env["WORLDTANGLE_DATA_DIR"] ?? "data";
const tickIntervalMs = Number(process.env["WORLDTANGLE_TICK_INTERVAL_MS"] ?? 250);
const snapshotIntervalTicks = Number(
  process.env["WORLDTANGLE_SNAPSHOT_INTERVAL_TICKS"] ?? 100,
);
const ssePollIntervalMs = Number(process.env["WORLDTANGLE_SSE_POLL_INTERVAL_MS"] ?? 100);
const sseHeartbeatIntervalMs = Number(
  process.env["WORLDTANGLE_SSE_HEARTBEAT_INTERVAL_MS"] ?? 15_000,
);
const sseMaxBacklogEvents = Number(process.env["WORLDTANGLE_SSE_MAX_BACKLOG_EVENTS"] ?? 100);
const logger = createLogger();
const llmModelPrices = new Map<string, LlmModelPrice>();
const tier2Price = modelPriceFromEnvironment("WORLDTANGLE_ANTHROPIC_TIER2");
const tier3Price = modelPriceFromEnvironment("WORLDTANGLE_ANTHROPIC_TIER3");
const minimaxPrice = modelPriceFromEnvironment("WORLDTANGLE_MINIMAX_M3", true);
const kimiK26Price = modelPriceFromEnvironment("WORLDTANGLE_KIMI_K2_6", true);
const kimiK27Price = modelPriceFromEnvironment("WORLDTANGLE_KIMI_K2_7_CODE", true);
if (tier2Price !== undefined) llmModelPrices.set(ANTHROPIC_DEFAULT_MODELS.tier2, tier2Price);
if (tier3Price !== undefined) llmModelPrices.set(ANTHROPIC_DEFAULT_MODELS.tier3, tier3Price);
if (minimaxPrice !== undefined) llmModelPrices.set(MINIMAX_M3_MODEL, minimaxPrice);
if (kimiK26Price !== undefined) llmModelPrices.set(KIMI_K2_6_MODEL, kimiK26Price);
if (kimiK27Price !== undefined) llmModelPrices.set(KIMI_K2_7_CODE_MODEL, kimiK27Price);
const kimiModel = kimiModelFromEnvironment(process.env["WORLDTANGLE_KIMI_MODEL"]);
const minimaxApiKey = process.env["MINIMAX_API_KEY"] ??
  process.env["MINIMAX_TOKEN_PLAN_KEY"];
const kimiCodeApiKey = process.env["KIMI_API_KEY"];
const kimiOpenPlatformApiKey = process.env["MOONSHOT_API_KEY"];
const kimiApiKey = kimiCodeApiKey ?? kimiOpenPlatformApiKey;
const kimiAccessMode: KimiAccessMode = kimiCodeApiKey === undefined
  ? "open_platform"
  : "code_plan";

if (host !== "127.0.0.1" && host !== "localhost" && !apiToken) {
  // ADR-0011: never expose the API beyond loopback without a token.
  logger.fatal(
    { event: "server.bind.refused", host },
    "Refusing non-loopback bind without WORLDTANGLE_API_TOKEN (ADR-0011)",
  );
  process.exit(1);
}

const app = buildApp({
  dataDir,
  tickIntervalMs,
  snapshotIntervalTicks,
  ssePollIntervalMs,
  sseHeartbeatIntervalMs,
  sseMaxBacklogEvents,
  logger,
  ...(apiToken ? { apiToken } : {}),
  ...(process.env["ANTHROPIC_API_KEY"] === undefined
    ? {}
    : { anthropicApiKey: process.env["ANTHROPIC_API_KEY"] }),
  ...(minimaxApiKey === undefined ? {} : { minimaxApiKey }),
  ...(kimiApiKey === undefined ? {} : { kimiApiKey }),
  ...(kimiApiKey === undefined ? {} : { kimiAccessMode }),
  kimiModel,
  ...(llmModelPrices.size === 0 ? {} : { llmModelPrices }),
});

app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ event: "server.ready", address }, "worldtangle server listening");
    app.log.info(
      { event: "server.disclaimer" },
      "All output is a simulated scenario — not financial, legal, or political advice.",
    );
  })
  .catch((error: unknown) => {
    logger.fatal(
      { event: "server.start.failed", err: error },
      "worldtangle server failed to start",
    );
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
