/** WS-610 manual check: one real MiniMax M3 choice replayed through mock. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createWs610LiveParityArtifact,
  hashValue,
  tier2DecisionProposalSchema,
  type Tier2DecisionProposal,
  type Ws610LiveParityArtifact,
} from "../packages/shared/src/index";
import {
  DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES,
  MINIMAX_M3_MODEL,
  MockLlmProvider,
  type LlmModelPrice,
} from "../packages/engine/src/index";
import {
  captureLlmParity,
  compareLlmParity,
  prepareSingleGoalParityFixture,
  type LlmParityCapture,
} from "../apps/server/src/llm-parity";
import {
  computeLogicalStateHash,
  openWorldDatabase,
} from "../apps/server/src/persistence/index";
import { SimulationService } from "../apps/server/src/simulation-service";

const REQUIRED_CONFIRMATION = "LIVE_ONE_CALL";
const FIXED_WALL_TIME = "2026-07-15T12:00:00.000Z";

interface ParityConfig {
  readonly minimaxApiKey: string;
  readonly outputPath: string;
  readonly rootDataDir: string;
  readonly removeDataDir: boolean;
  readonly tier2Price: LlmModelPrice;
}

interface RunResult {
  readonly capture: LlmParityCapture;
  readonly logicalStateHash: string;
  readonly activeGoalCount: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the WS-610 live parity check`);
  }
  return value;
}

function requiredFirstEnvironment(names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  throw new Error(`${names.join(" or ")} is required for the WS-610 live parity check`);
}

function integerEnvironment(name: string): bigint {
  const value = requiredEnvironment(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a nonnegative integer microcent value`);
  }
  return BigInt(value);
}

function createRootDataDir(): { rootDataDir: string; removeDataDir: boolean } {
  const configured = process.env["WORLDTANGLE_LIVE_PARITY_DATA_DIR"]?.trim();
  if (configured === undefined || configured.length === 0) {
    return {
      rootDataDir: mkdtempSync(join(tmpdir(), "worldtangle-ws610-live-parity-")),
      removeDataDir: true,
    };
  }
  const rootDataDir = resolve(configured);
  if (existsSync(rootDataDir) && readdirSync(rootDataDir).length > 0) {
    throw new Error("WORLDTANGLE_LIVE_PARITY_DATA_DIR must be empty");
  }
  mkdirSync(rootDataDir, { recursive: true });
  return { rootDataDir, removeDataDir: false };
}

export function loadParityConfig(): ParityConfig {
  if (process.env["WORLDTANGLE_LIVE_PARITY_CONFIRM"] !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `Set WORLDTANGLE_LIVE_PARITY_CONFIRM=${REQUIRED_CONFIRMATION} to acknowledge one ` +
      "real MiniMax M3 Tier-2 request",
    );
  }
  const minimaxApiKey = requiredFirstEnvironment(["MINIMAX_API_KEY", "MINIMAX_TOKEN_PLAN_KEY"]);
  const priceNames = {
    input: "WORLDTANGLE_MINIMAX_M3_INPUT_MICROCENTS_PER_TOKEN",
    cached: "WORLDTANGLE_MINIMAX_M3_CACHED_INPUT_MICROCENTS_PER_TOKEN",
    output: "WORLDTANGLE_MINIMAX_M3_OUTPUT_MICROCENTS_PER_TOKEN",
  };
  const supplied = Object.values(priceNames).map((name) => process.env[name] !== undefined);
  if (supplied.some(Boolean) && !supplied.every(Boolean)) {
    throw new Error("WORLDTANGLE_MINIMAX_M3 must override all three token prices together");
  }
  const tier2Price = supplied.every(Boolean)
    ? Object.freeze({
        inputMicrocentsPerToken: integerEnvironment(priceNames.input),
        cachedInputMicrocentsPerToken: integerEnvironment(priceNames.cached),
        outputMicrocentsPerToken: integerEnvironment(priceNames.output),
      })
    : DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES.get(MINIMAX_M3_MODEL)!;
  if (
    tier2Price.inputMicrocentsPerToken === 0n &&
    (tier2Price.cachedInputMicrocentsPerToken ?? 0n) === 0n &&
    tier2Price.outputMicrocentsPerToken === 0n
  ) {
    throw new Error("WS-610 live parity cannot use an all-zero MiniMax M3 price");
  }
  const data = createRootDataDir();
  return Object.freeze({
    minimaxApiKey,
    outputPath: resolve(
      process.argv[2] ??
        process.env["WORLDTANGLE_LIVE_PARITY_OUTPUT"] ??
        "artifacts/ws610-live-parity/latest.json",
    ),
    rootDataDir: data.rootDataDir,
    removeDataDir: data.removeDataDir,
    tier2Price,
  });
}

function replayCandidate(capture: LlmParityCapture): Tier2DecisionProposal {
  if (capture.projection.decisions.length !== 1) {
    throw new Error(
      `WS-610 live run produced ${capture.projection.decisions.length} decisions; expected one`,
    );
  }
  const decision = capture.projection.decisions[0]!;
  if (
    decision.tier !== 2 ||
    decision.chosenActionId === undefined ||
    decision.params === undefined
  ) {
    throw new Error("WS-610 live provider did not produce one valid Tier-2 decision");
  }
  return tier2DecisionProposalSchema.parse({
    actionId: decision.chosenActionId,
    params: decision.params,
    rationale: decision.rationale,
  });
}

async function runScenario(input: {
  readonly dataDir: string;
  readonly llmMode: "live" | "mock";
  readonly minimaxApiKey?: string;
  readonly tier2Price?: LlmModelPrice;
  readonly candidate?: Tier2DecisionProposal;
}): Promise<RunResult> {
  let monotonicReading = 0;
  const service = new SimulationService({
    dataDir: input.dataDir,
    enableNewsPipeline: false,
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: 100,
    wallClock: () => FIXED_WALL_TIME,
    monotonicClock: () => {
      monotonicReading += 1;
      return monotonicReading;
    },
    ...(input.minimaxApiKey === undefined ? {} : { minimaxApiKey: input.minimaxApiKey }),
    ...(input.candidate === undefined
      ? {}
      : {
          llmProviderFactory: () => new MockLlmProvider({
            script: () => input.candidate,
          }),
        }),
    llmModelPrices: input.tier2Price === undefined
      ? new Map()
      : new Map([[MINIMAX_M3_MODEL, input.tier2Price]]),
  });
  try {
    const created = service.createSimulation({
      name: "WS-610 provider parity fixture",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: input.llmMode,
        budgets: { runCostCentsMax: "100000000", perAgentDailyTokens: 128_000 },
        policyOverrides: {},
        endTick: 2,
      },
    }, "ws610-create");
    const setup = openWorldDatabase(input.dataDir, created.simulation.id, created.run.id);
    let agentId: string;
    try {
      agentId = prepareSingleGoalParityFixture(setup, created.run.id);
    } finally {
      setup.close();
    }
    service.controlSimulation(created.simulation.id, "start", {}, "ws610-start");
    service.controlSimulation(created.simulation.id, "pause", {}, "ws610-pause");
    const advanced = await service.advanceSimulation(
      created.simulation.id,
      { runId: created.run.id, ticks: 1 },
      "ws610-advance",
    );
    if (advanced.statusCode !== 200 || advanced.body.run.currentTick !== 1) {
      throw new Error(`WS-610 run did not commit tick 1: ${JSON.stringify(advanced)}`);
    }
    const verified = openWorldDatabase(input.dataDir, created.simulation.id, created.run.id);
    try {
      const active = verified.prepare<[string, string], { count: bigint }>(`
        SELECT COUNT(*) AS count FROM goals
        WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).get(created.run.id, agentId);
      return Object.freeze({
        capture: captureLlmParity(verified, created.run.id, 1),
        logicalStateHash: computeLogicalStateHash(verified, created.run.id),
        activeGoalCount: Number(active?.count ?? 0n),
      });
    } finally {
      verified.close();
    }
  } finally {
    service.close();
  }
}

async function runParity(config: ParityConfig): Promise<Ws610LiveParityArtifact> {
  const live = await runScenario({
    dataDir: join(config.rootDataDir, "live"),
    llmMode: "live",
    minimaxApiKey: config.minimaxApiKey,
    tier2Price: config.tier2Price,
  });
  const candidate = replayCandidate(live.capture);
  if (
    live.capture.providerReceipts.length !== 1 ||
    live.capture.providerReceipts[0]?.provider !== "minimax"
  ) {
    throw new Error("WS-610 live run did not record exactly one MiniMax call");
  }
  const mock = await runScenario({
    dataDir: join(config.rootDataDir, "mock"),
    llmMode: "mock",
    candidate,
  });
  if (
    mock.capture.providerReceipts.length !== 1 ||
    mock.capture.providerReceipts[0]?.provider !== "mock"
  ) {
    throw new Error("WS-610 replay did not record exactly one mock call");
  }
  const comparison = compareLlmParity(live.capture, mock.capture);
  if (comparison.status !== "passed") {
    throw new Error(`WS-610 provider-neutral mismatch: ${comparison.mismatches.join(", ")}`);
  }
  if (live.logicalStateHash === mock.logicalStateHash) {
    throw new Error("WS-610 expected provider-bound logical hashes to remain distinct");
  }
  if (live.activeGoalCount !== mock.activeGoalCount) {
    throw new Error("WS-610 replay changed the affected agent's goal state");
  }
  const liveReceipt = live.capture.providerReceipts[0]!;
  const mockReceipt = mock.capture.providerReceipts[0]!;
  const evidence = Object.freeze({
    artifactSchemaVersion: 2,
    ticket: "WS-610",
    status: "passed",
    executedAt: new Date().toISOString(),
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      decisionTick: 1,
      fixture: "one seeded agent with all goals dormant before the first tick",
    },
    live: {
      provider: liveReceipt.provider,
      model: liveReceipt.model,
      requestHash: liveReceipt.requestHash,
      attempts: liveReceipt.attempts,
      inputTokens: liveReceipt.inputTokens,
      cachedInputTokens: liveReceipt.cachedInputTokens,
      outputTokens: liveReceipt.outputTokens,
      logicalStateHash: live.logicalStateHash,
      activeGoalCount: live.activeGoalCount,
    },
    mock: {
      provider: mockReceipt.provider,
      model: mockReceipt.model,
      requestHash: mockReceipt.requestHash,
      attempts: mockReceipt.attempts,
      inputTokens: mockReceipt.inputTokens,
      cachedInputTokens: mockReceipt.cachedInputTokens,
      outputTokens: mockReceipt.outputTokens,
      logicalStateHash: mock.logicalStateHash,
      activeGoalCount: mock.activeGoalCount,
    },
    replayedProposal: {
      actionId: candidate.actionId,
      params: candidate.params,
      rationale: candidate.rationale,
      proposalHash: hashValue(candidate),
    },
    providerNeutral: {
      projectionDigest: comparison.leftDigest,
      sections: comparison.sections,
      mismatches: comparison.mismatches,
    },
    checklist: {
      liveDecisionValid: true,
      distinctProviderReceipts: true,
      providerBoundLogicalHashesRemainDistinct: true,
      callShapeEqual: true,
      decisionShapeEqual: true,
      actionShapeEqual: true,
      causalEventFlowEqual: true,
      affectedAgentStateEqual: true,
    },
  });
  return createWs610LiveParityArtifact(evidence);
}

async function main(): Promise<void> {
  let config: ParityConfig | undefined;
  try {
    config = loadParityConfig();
    mkdirSync(join(config.rootDataDir, "live"), { recursive: true });
    mkdirSync(join(config.rootDataDir, "mock"), { recursive: true });
    const artifact = await runParity(config);
    mkdirSync(dirname(config.outputPath), { recursive: true });
    writeFileSync(config.outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    process.stdout.write(JSON.stringify({ outputPath: config.outputPath, ...artifact }, null, 2) + "\n");
  } finally {
    if (config?.removeDataDir) {
      rmSync(config.rootDataDir, { recursive: true, force: true });
    }
  }
}

await main();
