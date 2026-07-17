import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  tier2DecisionProposalSchema,
  type Tier2DecisionProposal,
} from "@worldtangle/shared";
import {
  llmRequestHash,
  MockLlmProvider,
  type LlmRequest,
  type RoutedLlmProvider,
} from "@worldtangle/engine";
import {
  compareLlmParity,
  captureLlmParity,
  prepareSingleGoalParityFixture,
  type LlmParityCapture,
} from "./llm-parity";
import {
  computeLogicalStateHash,
  openWorldDatabase,
} from "./persistence";
import { SimulationService } from "./simulation-service";

const directories: string[] = [];
const services: SimulationService[] = [];
const LIVE_SHAPE_MODEL = "ws610-live-shape";

interface FixtureResult {
  readonly capture: LlmParityCapture;
  readonly logicalStateHash: string;
  readonly activeGoalCount: number;
}

class ValidLiveShapeProvider implements RoutedLlmProvider {
  route() {
    return { provider: "anthropic", model: LIVE_SHAPE_MODEL };
  }

  async propose(request: LlmRequest) {
    const options = request.options as readonly Tier2DecisionProposal[] | undefined;
    const selected = options?.find((option) => option.actionId.startsWith("goal.activate_")) ??
      options?.[0];
    const candidate = selected === undefined
      ? undefined
      : { ...selected, rationale: "WS-610 selected the engine-authored live-shape choice" };
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false as const,
        reason: "schema_invalid" as const,
        requestHash: llmRequestHash(request),
        attempts: 1,
      };
    }
    return {
      ok: true as const,
      value: parsed.data,
      model: LIVE_SHAPE_MODEL,
      cached: false,
      inputTokens: Math.ceil(
        (request.promptParts.system.length + request.promptParts.observation.length) / 4,
      ),
      outputTokens: Math.ceil(canonicalStringify(parsed.data).length / 4),
      requestHash: llmRequestHash(request),
      attempts: 1,
    };
  }
}

class InvalidLiveShapeProvider implements RoutedLlmProvider {
  route() {
    return { provider: "anthropic", model: LIVE_SHAPE_MODEL };
  }

  async propose(request: LlmRequest) {
    return {
      ok: false as const,
      reason: "schema_invalid" as const,
      requestHash: llmRequestHash(request),
      detail: "live-shaped provider rejected an invalid structured response",
      attempts: 1,
    };
  }
}

async function runFixture(input: {
  readonly llmMode: "mock" | "live";
  readonly providerFactory: () => RoutedLlmProvider;
}): Promise<FixtureResult> {
  const dataDir = mkdtempSync(join(tmpdir(), `worldtangle-ws610-${input.llmMode}-`));
  directories.push(dataDir);
  let monotonicReading = 0;
  const service = new SimulationService({
    dataDir,
    enableNewsPipeline: false,
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: 100,
    wallClock: () => "2026-07-15T12:00:00.000Z",
    monotonicClock: () => {
      monotonicReading += 1;
      return monotonicReading;
    },
    llmProviderFactory: input.providerFactory,
    llmModelPrices: new Map([[LIVE_SHAPE_MODEL, {
      inputMicrocentsPerToken: 0n,
      outputMicrocentsPerToken: 0n,
    }]]),
  });
  services.push(service);
  const created = service.createSimulation({
    name: "WS-610 provider parity fixture",
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      llmMode: input.llmMode,
      budgets: { runCostCentsMax: "1000000", perAgentDailyTokens: 128_000 },
      policyOverrides: {},
      endTick: 2,
    },
  }, "ws610-create");
  const setup = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  try {
    prepareSingleGoalParityFixture(setup, created.run.id);
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
  expect(advanced).toMatchObject({
    statusCode: 200,
    body: { run: { currentTick: 1 } },
  });
  const verified = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  try {
    const active = verified.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM goals
      WHERE run_id = ? AND agent_id = ? AND status = 'active'
    `).get(created.run.id, prepareAgentId(verified, created.run.id));
    return Object.freeze({
      capture: captureLlmParity(verified, created.run.id, 1),
      logicalStateHash: computeLogicalStateHash(verified, created.run.id),
      activeGoalCount: Number(active?.count ?? 0n),
    });
  } finally {
    verified.close();
  }
}

function prepareAgentId(
  db: ReturnType<typeof openWorldDatabase>,
  runId: string,
): string {
  const row = db.prepare<[string], { agent_id: string }>(`
    SELECT agent_id FROM goals WHERE run_id = ? ORDER BY agent_id LIMIT 1
  `).get(runId);
  if (row === undefined) throw new Error("WS-610 verified fixture has no goals");
  return row.agent_id;
}

function replayCandidate(capture: LlmParityCapture): Tier2DecisionProposal {
  const decision = capture.projection.decisions[0];
  if (decision === undefined || decision.chosenActionId === undefined || decision.params === undefined) {
    throw new Error("WS-610 live-shape run did not commit a replayable decision");
  }
  return tier2DecisionProposalSchema.parse({
    actionId: decision.chosenActionId,
    params: decision.params,
    rationale: decision.rationale,
  });
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-610 mock/live provider parity", () => {
  it("commits the same valid decision, action, causal flow, goals, and memories", async () => {
    const live = await runFixture({
      llmMode: "live",
      providerFactory: () => new ValidLiveShapeProvider(),
    });
    const candidate = replayCandidate(live.capture);
    const mock = await runFixture({
      llmMode: "mock",
      providerFactory: () => new MockLlmProvider({ script: () => candidate }),
    });

    expect(live.capture.providerReceipts).toEqual([
      expect.objectContaining({ provider: "anthropic", model: LIVE_SHAPE_MODEL }),
    ]);
    expect(mock.capture.providerReceipts).toEqual([
      expect.objectContaining({ provider: "mock", model: "mock-llm-v1" }),
    ]);
    expect(live.capture.providerReceipts).not.toEqual(mock.capture.providerReceipts);
    expect(live.logicalStateHash).not.toBe(mock.logicalStateHash);
    expect(live.activeGoalCount).toBe(1);
    expect(mock.activeGoalCount).toBe(1);

    const comparison = compareLlmParity(live.capture, mock.capture);
    expect(comparison).toMatchObject({ status: "passed", mismatches: [] });
    expect(comparison.sections.every((section) => section.equal)).toBe(true);
    expect(comparison.leftDigest).toBe(comparison.rightDigest);
  });

  it("falls back through the same Tier-1 flow when both provider shapes reject output", async () => {
    const live = await runFixture({
      llmMode: "live",
      providerFactory: () => new InvalidLiveShapeProvider(),
    });
    const mock = await runFixture({
      llmMode: "mock",
      providerFactory: () => new MockLlmProvider({
        script: () => ({ actionId: "FORGED", params: {}, rationale: "forged" }),
      }),
    });

    expect(live.capture.projection.calls).toEqual([
      expect.objectContaining({
        status: "fallback",
        fallbackReason: "schema_invalid",
        effectiveTier: 1,
      }),
    ]);
    expect(mock.capture.projection.calls).toEqual(live.capture.projection.calls);
    expect(canonicalStringify(live.capture.projection)).not.toContain("forged");
    expect(canonicalStringify(mock.capture.projection)).not.toContain("forged");
    expect(compareLlmParity(live.capture, mock.capture)).toMatchObject({
      status: "passed",
      mismatches: [],
    });
  });
});
