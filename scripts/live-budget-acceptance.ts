/** WS-609 manual AC-2 probe: real MiniMax/Kimi calls and a durable $2 budget gate. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSimulationResponseSchema,
  createWs609LiveBudgetArtifact,
  eventListResponseSchema,
  llmCallListResponseSchema,
  simulationStatusResponseSchema,
  type EventEnvelope,
  type LlmCallTelemetryItem,
  type SimulationStatusResponse,
  type Ws609LiveBudgetArtifact,
} from "../packages/shared/src/index";
import {
  DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES,
  KIMI_K2_6_MODEL,
  MINIMAX_M3_MODEL,
  type KimiAccessMode,
  type LlmModelPrice,
} from "../packages/engine/src/index";
import { buildApp } from "../apps/server/src/app";
import { prepareSingleGoalParityFixture } from "../apps/server/src/llm-parity";
import { openWorldDatabase } from "../apps/server/src/persistence";

const BUDGET_CENTS = 200n;
const MICROCENTS_PER_CENT = 1_000_000n;
const REQUIRED_CONFIRMATION = "LIVE_USD_2";
/**
 * AC-2 validates the hard-ceiling lifecycle, not provider invoicing. Riverbend's
 * bounded 360-tick workload does not reach $2 at retail-like rates, so preserve
 * the pinned provider ratios while scaling the nonbillable reference table.
 */
const ACCEPTANCE_REFERENCE_PRICE_MULTIPLIER = 5_500n;

function acceptanceReferencePrice(model: string): LlmModelPrice {
  const base = DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES.get(model);
  if (base?.cachedInputMicrocentsPerToken === undefined) {
    throw new Error(`missing cached-token reference price for ${model}`);
  }
  return Object.freeze({
    inputMicrocentsPerToken:
      base.inputMicrocentsPerToken * ACCEPTANCE_REFERENCE_PRICE_MULTIPLIER,
    cachedInputMicrocentsPerToken:
      base.cachedInputMicrocentsPerToken * ACCEPTANCE_REFERENCE_PRICE_MULTIPLIER,
    outputMicrocentsPerToken:
      base.outputMicrocentsPerToken * ACCEPTANCE_REFERENCE_PRICE_MULTIPLIER,
  });
}

interface ProbeConfig {
  readonly minimaxApiKey: string;
  readonly kimiApiKey: string;
  readonly kimiAccessMode: KimiAccessMode;
  readonly outputPath: string;
  readonly dataDir: string;
  readonly removeDataDir: boolean;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly postPauseGraceMs: number;
  readonly prices: ReadonlyMap<string, LlmModelPrice>;
}

interface CallLedger {
  readonly calls: readonly LlmCallTelemetryItem[];
  readonly providerAttempts: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: bigint;
  readonly independentlyPricedMicrocents: bigint;
  readonly cacheHits: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the WS-609 live acceptance run`);
  }
  return value;
}

function requiredFirstEnvironment(names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  throw new Error(`${names.join(" or ")} is required for the WS-609 live acceptance run`);
}

function integerEnvironment(name: string): bigint {
  const value = requiredEnvironment(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a nonnegative integer microcent value`);
  }
  return BigInt(value);
}

function boundedIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function price(prefix: string, fallback: LlmModelPrice): LlmModelPrice {
  const names = {
    input: `${prefix}_INPUT_MICROCENTS_PER_TOKEN`,
    cached: `${prefix}_CACHED_INPUT_MICROCENTS_PER_TOKEN`,
    output: `${prefix}_OUTPUT_MICROCENTS_PER_TOKEN`,
  };
  const supplied = [names.input, names.cached, names.output]
    .map((name) => process.env[name] !== undefined);
  if (!supplied.some(Boolean)) return fallback;
  if (!supplied.every(Boolean)) {
    throw new Error(`${prefix} must override input, cached-input, and output prices together`);
  }
  const inputMicrocentsPerToken = integerEnvironment(names.input);
  const cachedInputMicrocentsPerToken = integerEnvironment(names.cached);
  const outputMicrocentsPerToken = integerEnvironment(names.output);
  if (
    inputMicrocentsPerToken === 0n &&
    cachedInputMicrocentsPerToken === 0n &&
    outputMicrocentsPerToken === 0n
  ) {
    throw new Error(`${prefix} cannot use an all-zero price for a live budget acceptance run`);
  }
  return Object.freeze({
    inputMicrocentsPerToken,
    cachedInputMicrocentsPerToken,
    outputMicrocentsPerToken,
  });
}

export function loadProbeConfig(): ProbeConfig {
  if (process.env["WORLDTANGLE_LIVE_ACCEPTANCE_CONFIRM"] !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `Set WORLDTANGLE_LIVE_ACCEPTANCE_CONFIRM=${REQUIRED_CONFIRMATION} to acknowledge ` +
      "a real MiniMax/Kimi run with a $2 reference-price budget and one possible overshoot",
    );
  }
  const minimaxApiKey = requiredFirstEnvironment(["MINIMAX_API_KEY", "MINIMAX_TOKEN_PLAN_KEY"]);
  const kimiCodeApiKey = process.env["KIMI_API_KEY"]?.trim();
  const kimiOpenPlatformApiKey = process.env["MOONSHOT_API_KEY"]?.trim();
  const kimiApiKey = kimiCodeApiKey || kimiOpenPlatformApiKey;
  if (kimiApiKey === undefined || kimiApiKey.length === 0) {
    throw new Error("KIMI_API_KEY or MOONSHOT_API_KEY is required for the WS-609 live acceptance run");
  }
  const kimiAccessMode: KimiAccessMode = kimiCodeApiKey === undefined ||
      kimiCodeApiKey.length === 0
    ? "open_platform"
    : "code_plan";
  const tier2 = price(
    "WORLDTANGLE_MINIMAX_M3",
    acceptanceReferencePrice(MINIMAX_M3_MODEL),
  );
  const tier3 = price(
    "WORLDTANGLE_KIMI_K2_6",
    acceptanceReferencePrice(KIMI_K2_6_MODEL),
  );
  const configuredDataDir = process.env["WORLDTANGLE_LIVE_ACCEPTANCE_DATA_DIR"]?.trim();
  const dataDir = configuredDataDir === undefined || configuredDataDir.length === 0
    ? mkdtempSync(join(tmpdir(), "worldtangle-ws609-live-"))
    : resolve(configuredDataDir);
  if (configuredDataDir !== undefined && configuredDataDir.length > 0) {
    mkdirSync(dataDir, { recursive: true });
  }
  return Object.freeze({
    minimaxApiKey,
    kimiApiKey,
    kimiAccessMode,
    outputPath: resolve(
      process.argv[2] ??
        process.env["WORLDTANGLE_LIVE_ACCEPTANCE_OUTPUT"] ??
        "artifacts/ws609-live-acceptance/latest.json",
    ),
    dataDir,
    removeDataDir: configuredDataDir === undefined || configuredDataDir.length === 0,
    timeoutMs: boundedIntegerEnvironment(
      "WORLDTANGLE_LIVE_ACCEPTANCE_TIMEOUT_MS",
      1_800_000,
      10_000,
      7_200_000,
    ),
    pollMs: boundedIntegerEnvironment(
      "WORLDTANGLE_LIVE_ACCEPTANCE_POLL_MS",
      250,
      50,
      5_000,
    ),
    postPauseGraceMs: boundedIntegerEnvironment(
      "WORLDTANGLE_LIVE_ACCEPTANCE_GRACE_MS",
      2_000,
      500,
      30_000,
    ),
    prices: new Map([
      [MINIMAX_M3_MODEL, tier2],
      [KIMI_K2_6_MODEL, tier3],
    ]),
  });
}

async function request(origin: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(origin + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function status(
  origin: string,
  simulationId: string,
  runId: string,
): Promise<SimulationStatusResponse> {
  return simulationStatusResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
  ));
}

async function allCalls(
  origin: string,
  simulationId: string,
  runId: string,
): Promise<readonly LlmCallTelemetryItem[]> {
  const calls: LlmCallTelemetryItem[] = [];
  let cursor: string | null = null;
  do {
    const page = llmCallListResponseSchema.parse(await request(
      origin,
      `/api/v1/simulations/${simulationId}/llm-calls?runId=${runId}&limit=100` +
        (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`),
    ));
    calls.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(calls);
}

async function eventsByType(
  origin: string,
  simulationId: string,
  runId: string,
  type: string,
): Promise<readonly EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  let cursor: string | null = null;
  do {
    const page = eventListResponseSchema.parse(await request(
      origin,
      `/api/v1/simulations/${simulationId}/events?runId=${runId}&limit=100` +
        `&type=${encodeURIComponent(type)}` +
        (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`),
    ));
    events.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(events);
}

function eventPayload(event: EventEnvelope): Readonly<Record<string, unknown>> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Readonly<Record<string, unknown>>
    : {};
}

export function reconcileCallLedger(
  calls: readonly LlmCallTelemetryItem[],
  prices: ReadonlyMap<string, LlmModelPrice>,
): CallLedger {
  let providerAttempts = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costMicrocents = 0n;
  let independentlyPricedMicrocents = 0n;
  let cacheHits = 0;
  for (const call of calls) {
    providerAttempts += call.attempts;
    if (call.cached) cacheHits += 1;
    const storedCost = BigInt(call.costMicrocents);
    costMicrocents += storedCost;
    if (storedCost === 0n) continue;
    const modelPrice = prices.get(call.model);
    if (modelPrice === undefined) {
      throw new Error(`call ${call.id} uses unpriced model ${call.model}`);
    }
    inputTokens += call.inputTokens;
    cachedInputTokens += call.cachedInputTokens;
    outputTokens += call.outputTokens;
    const uncachedInputTokens = call.inputTokens - call.cachedInputTokens;
    if (uncachedInputTokens < 0 || modelPrice.cachedInputMicrocentsPerToken === undefined) {
      throw new Error(`call ${call.id} has invalid or unpriced cached input usage`);
    }
    independentlyPricedMicrocents +=
      BigInt(uncachedInputTokens) * modelPrice.inputMicrocentsPerToken +
      BigInt(call.cachedInputTokens) * modelPrice.cachedInputMicrocentsPerToken +
      BigInt(call.outputTokens) * modelPrice.outputMicrocentsPerToken;
  }
  return Object.freeze({
    calls,
    providerAttempts,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costMicrocents,
    independentlyPricedMicrocents,
    cacheHits,
  });
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function withinFivePercent(actual: bigint, expected: bigint): boolean {
  if (expected === 0n) return actual === 0n;
  return absoluteDifference(actual, expected) * 100n <= expected * 5n;
}

async function awaitAutoPause(
  origin: string,
  simulationId: string,
  runId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<SimulationStatusResponse> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const current = await status(origin, simulationId, runId);
    if (current.run.status === "paused" && current.llm.autoPaused) return current;
    if (current.run.status === "completed" || current.run.status === "failed") {
      const calls = await allCalls(origin, simulationId, runId);
      const statuses: Record<string, number> = {};
      let providerAttempts = 0;
      let chargedCalls = 0;
      for (const call of calls) {
        const key = `${call.provider}:${call.model}:${call.status}`;
        statuses[key] = (statuses[key] ?? 0) + 1;
        providerAttempts += call.attempts;
        if (BigInt(call.costMicrocents) > 0n) chargedCalls += 1;
      }
      throw new Error(
        `run reached ${current.run.status} at tick ${current.run.currentTick} before budget ` +
        `auto-pause: ${JSON.stringify({
          callRecords: calls.length,
          providerAttempts,
          chargedCalls,
          statuses,
          spend: current.llm.spend,
        })}`,
      );
    }
    await delay(pollMs);
  }
  throw new Error(`live run did not auto-pause within ${timeoutMs} ms`);
}

async function awaitLedgerCatchup(
  origin: string,
  simulationId: string,
  runId: string,
  paused: SimulationStatusResponse,
  prices: ReadonlyMap<string, LlmModelPrice>,
  timeoutMs: number,
  pollMs: number,
): Promise<CallLedger> {
  const deadline = performance.now() + Math.min(timeoutMs, 60_000);
  while (performance.now() < deadline) {
    const ledger = reconcileCallLedger(await allCalls(origin, simulationId, runId), prices);
    if (
      ledger.inputTokens === paused.llm.spend.inputTokens &&
      ledger.cachedInputTokens === paused.llm.spend.cachedInputTokens &&
      ledger.outputTokens === paused.llm.spend.outputTokens &&
      ledger.costMicrocents > 0n
    ) {
      return ledger;
    }
    await delay(pollMs);
  }
  throw new Error("LLM call ledger did not reconcile to paused status within 60 seconds");
}

async function runProbe(config: ProbeConfig): Promise<Ws609LiveBudgetArtifact> {
  const app = buildApp({
    dataDir: config.dataDir,
    enableNewsPipeline: false,
    tickIntervalMs: 1,
    snapshotIntervalTicks: 100,
    minimaxApiKey: config.minimaxApiKey,
    kimiApiKey: config.kimiApiKey,
    kimiAccessMode: config.kimiAccessMode,
    llmModelPrices: config.prices,
    logger: false,
    webRoot: false,
  });
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = createSimulationResponseSchema.parse(await request(
      origin,
      "/api/v1/simulations",
      {
        method: "POST",
        body: JSON.stringify({
          name: "WS-609 AC-2 live budget acceptance",
          scenario: {
            worldSpec: "riverbend-100@1",
            seed: 42,
            llmMode: "live",
            budgets: {
              runCostCentsMax: BUDGET_CENTS.toString(),
              perAgentDailyTokens: 128_000,
            },
            policyOverrides: {},
            endTick: 360,
          },
        }),
      },
    ));
    const simulationId = created.simulation.id;
    const runId = created.run.id;
    const fixtureDb = openWorldDatabase(config.dataDir, simulationId, runId);
    try {
      prepareSingleGoalParityFixture(fixtureDb, runId);
    } finally {
      fixtureDb.close();
    }
    await request(origin, `/api/v1/simulations/${simulationId}/start`, {
      method: "POST",
      body: JSON.stringify({ runId }),
    });

    const paused = await awaitAutoPause(
      origin,
      simulationId,
      runId,
      config.timeoutMs,
      config.pollMs,
    );
    const atPause = await awaitLedgerCatchup(
      origin,
      simulationId,
      runId,
      paused,
      config.prices,
      config.timeoutMs,
      config.pollMs,
    );
    await delay(config.postPauseGraceMs);
    const afterGraceStatus = await status(origin, simulationId, runId);
    const afterGrace = reconcileCallLedger(
      await allCalls(origin, simulationId, runId),
      config.prices,
    );
    if (afterGrace.providerAttempts !== atPause.providerAttempts) {
      throw new Error(
        `provider attempts increased after auto-pause: ${atPause.providerAttempts} -> ` +
        `${afterGrace.providerAttempts}`,
      );
    }
    if (afterGraceStatus.run.status !== "paused" || !afterGraceStatus.llm.autoPaused) {
      throw new Error("run did not remain budget-paused during the post-pause probe");
    }
    if (afterGrace.providerAttempts === 0) {
      throw new Error("live acceptance run recorded zero provider attempts");
    }
    if (!withinFivePercent(atPause.costMicrocents, atPause.independentlyPricedMicrocents)) {
      throw new Error("stored spend differs from independently priced provider usage by more than 5%");
    }
    if (
      paused.llm.spend.inputTokens !== atPause.inputTokens ||
      paused.llm.spend.cachedInputTokens !== atPause.cachedInputTokens ||
      paused.llm.spend.outputTokens !== atPause.outputTokens
    ) {
      throw new Error("status token spend does not equal provider-reported call usage");
    }
    const displayedMicrocents = BigInt(paused.llm.spend.costCentsEstimate) * MICROCENTS_PER_CENT;
    if (
      displayedMicrocents < atPause.costMicrocents ||
      displayedMicrocents - atPause.costMicrocents >= MICROCENTS_PER_CENT
    ) {
      throw new Error("status whole-cent estimate is not the exact-cost round-up");
    }
    if (atPause.costMicrocents < BUDGET_CENTS * MICROCENTS_PER_CENT) {
      throw new Error("run auto-paused before reaching the configured $2 budget");
    }

    const thresholdEvents = await eventsByType(
      origin,
      simulationId,
      runId,
      "llm.budget.threshold",
    );
    const exhausted = thresholdEvents.find((event) =>
      eventPayload(event)["action"] === "auto_pause" &&
      eventPayload(event)["thresholdPct"] === 100);
    if (exhausted === undefined) throw new Error("missing 100% budget threshold event");
    const pauseEvents = await eventsByType(origin, simulationId, runId, "simulation.paused");
    const pauseEvent = pauseEvents.find((event) =>
      event.causationId === exhausted.eventId &&
      eventPayload(event)["reason"] === "llm_budget_exhausted");
    if (pauseEvent === undefined) throw new Error("missing causally linked budget pause event");

    const expected = atPause.independentlyPricedMicrocents;
    const difference = absoluteDifference(atPause.costMicrocents, expected);
    const evidence = Object.freeze({
      artifactSchemaVersion: 2,
      acceptanceCriterion: "AC-2",
      status: "passed",
      executedAt: new Date().toISOString(),
      transport: "Fastify on an ephemeral 127.0.0.1 listener with real MiniMax/Kimi transport",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "live",
        endTick: 360,
        runCostCentsMax: BUDGET_CENTS.toString(),
        perAgentDailyTokens: 128_000,
      },
      simulationId,
      runId,
      models: {
        tier2: MINIMAX_M3_MODEL,
        tier3: KIMI_K2_6_MODEL,
      },
      providers: { tier2: "minimax", tier3: "kimi" },
      prices: Object.fromEntries([...config.prices.entries()].map(([model, modelPrice]) => [
        model,
        {
          inputMicrocentsPerToken: modelPrice.inputMicrocentsPerToken.toString(),
          cachedInputMicrocentsPerToken:
            (modelPrice.cachedInputMicrocentsPerToken ?? 0n).toString(),
          outputMicrocentsPerToken: modelPrice.outputMicrocentsPerToken.toString(),
        },
      ])),
      pause: {
        tick: afterGraceStatus.run.currentTick,
        runStatus: afterGraceStatus.run.status,
        autoPaused: afterGraceStatus.llm.autoPaused,
        effectiveTier: afterGraceStatus.llm.effectiveTier,
        budgetPct: afterGraceStatus.llm.budgetPct,
        thresholdEventId: exhausted.eventId,
        pauseEventId: pauseEvent.eventId,
        pauseCausationId: pauseEvent.causationId,
      },
      providerUsage: {
        callRecords: atPause.calls.length,
        providerAttempts: atPause.providerAttempts,
        cacheHits: atPause.cacheHits,
        inputTokens: atPause.inputTokens,
        cachedInputTokens: atPause.cachedInputTokens,
        outputTokens: atPause.outputTokens,
      },
      spendReconciliation: {
        recordedCostMicrocents: atPause.costMicrocents.toString(),
        independentlyPricedMicrocents: expected.toString(),
        absoluteDifferenceMicrocents: difference.toString(),
        differenceBasisPoints: expected === 0n
          ? 0
          : Number(difference * 10_000n / expected),
        withinFivePercent: true,
        displayedCostCentsEstimate: paused.llm.spend.costCentsEstimate,
      },
      postPauseProbe: {
        graceMs: config.postPauseGraceMs,
        providerAttemptsAtPause: atPause.providerAttempts,
        providerAttemptsAfterGrace: afterGrace.providerAttempts,
        additionalProviderAttempts: 0,
        remainedPaused: true,
      },
    });
    return createWs609LiveBudgetArtifact(evidence);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  let config: ProbeConfig | undefined;
  try {
    config = loadProbeConfig();
    const artifact = await runProbe(config);
    mkdirSync(dirname(config.outputPath), { recursive: true });
    writeFileSync(config.outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    process.stdout.write(JSON.stringify({ outputPath: config.outputPath, ...artifact }, null, 2) + "\n");
  } finally {
    if (config?.removeDataDir) {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  }
}

await main();
