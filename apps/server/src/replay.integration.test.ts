import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  type ReplayRun,
} from "@worldtangle/shared";
import {
  llmRequestHash,
  MINIMAX_M3_MODEL,
  type LlmRequest,
  type RoutedLlmProvider,
} from "@worldtangle/engine";
import { prepareSingleGoalParityFixture } from "./llm-parity";
import {
  openWorldDatabase,
  SqliteEventStore,
  SqliteLlmCallStore,
} from "./persistence";
import { SimulationService } from "./simulation-service";

const directories: string[] = [];
const services: SimulationService[] = [];

class CountingReplayProvider implements RoutedLlmProvider {
  readonly calls: LlmRequest[] = [];

  route() {
    return { provider: "minimax", model: MINIMAX_M3_MODEL };
  }

  async propose(request: LlmRequest) {
    this.calls.push(request);
    const candidate = request.options?.[0];
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
      model: MINIMAX_M3_MODEL,
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

async function waitForReplay(
  service: SimulationService,
  simulationId: string,
  runId: string,
): Promise<ReplayRun> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const status = service.getStatus(simulationId, runId) as { replay: ReplayRun | null };
    if (status.replay !== null && status.replay.status !== "running") return status.replay;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("replay did not become terminal");
}

async function createLiveSourceFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-ws705-cache-"));
  directories.push(dataDir);
  const provider = new CountingReplayProvider();
  let monotonic = 0;
  const service = new SimulationService({
    dataDir,
    enableNewsPipeline: false,
    tickIntervalMs: 60_000,
    wallClock: () => "2026-07-16T12:00:00.000Z",
    monotonicClock: () => {
      monotonic += 1;
      return monotonic;
    },
    llmProviderFactory: () => provider,
    llmModelPrices: new Map([[MINIMAX_M3_MODEL, {
      inputMicrocentsPerToken: 0n,
      outputMicrocentsPerToken: 0n,
    }]]),
  });
  services.push(service);
  const created = service.createSimulation({
    name: "WS-705 cached live replay",
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      llmMode: "live",
      budgets: { runCostCentsMax: "1000000", perAgentDailyTokens: 128_000 },
      policyOverrides: {},
      endTick: 1,
    },
  }, "ws705-create");
  const sourceDb = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  try {
    prepareSingleGoalParityFixture(sourceDb, created.run.id);
  } finally {
    sourceDb.close();
  }
  service.controlSimulation(created.simulation.id, "start", {}, "ws705-start");
  service.controlSimulation(created.simulation.id, "pause", {}, "ws705-pause");
  await service.advanceSimulation(
    created.simulation.id,
    { runId: created.run.id, ticks: 1 },
    "ws705-advance",
  );
  expect(provider.calls.length).toBeGreaterThan(0);
  return { dataDir, provider, service, created };
}

function removeSourceCache(input: Awaited<ReturnType<typeof createLiveSourceFixture>>): void {
  const db = openWorldDatabase(
    input.dataDir,
    input.created.simulation.id,
    input.created.run.id,
  );
  try {
    db.exec("DROP TRIGGER llm_response_cache_no_delete");
    db.prepare("DELETE FROM llm_response_cache WHERE run_id = ?")
      .run(input.created.run.id);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-705 replay executor", () => {
  it("produces identical raw event hashes for independent built-in mock runs", async () => {
    const hashes: string[] = [];
    for (let index = 0; index < 2; index++) {
      const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-ws710-mock-hash-"));
      directories.push(dataDir);
      const service = new SimulationService({
        dataDir,
        enableNewsPipeline: false,
        tickIntervalMs: 60_000,
        wallClock: () => "2026-07-16T12:00:00.000Z",
      });
      services.push(service);
      const created = service.createSimulation({
        name: "WS-710 deterministic mock hash",
        scenario: {
          worldSpec: "riverbend-100@1",
          seed: 42,
          llmMode: "mock",
          budgets: { runCostCentsMax: "50000", perAgentDailyTokens: 2_000 },
          policyOverrides: {},
          endTick: 1,
        },
      }, "ws710-hash-create");
      service.controlSimulation(created.simulation.id, "start", {}, "ws710-hash-start");
      service.controlSimulation(created.simulation.id, "pause", {}, "ws710-hash-pause");
      await service.advanceSimulation(
        created.simulation.id,
        { runId: created.run.id, ticks: 1 },
        "ws710-hash-advance",
      );
      const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
      try {
        expect(new SqliteLlmCallStore(db, created.run.id)
          .listWithTelemetry().every((call) => call.latencyMs === 0)).toBe(true);
        hashes.push(new SqliteEventStore(db, created.run.id).logHash());
      } finally {
        db.close();
      }
    }

    expect(hashes[1]).toBe(hashes[0]);
  }, 30_000);

  it("replays the standard mock decision pipeline without a tick-one divergence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-ws710-mock-replay-"));
    directories.push(dataDir);
    const service = new SimulationService({
      dataDir,
      tickIntervalMs: 60_000,
      wallClock: () => "2026-07-16T12:00:00.000Z",
    });
    services.push(service);
    const created = service.createSimulation({
      name: "WS-710 mock replay",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: { runCostCentsMax: "50000", perAgentDailyTokens: 2_000 },
        policyOverrides: {},
        endTick: 1,
      },
    }, "ws710-mock-create");
    service.controlSimulation(created.simulation.id, "start", {}, "ws710-mock-start");
    service.controlSimulation(created.simulation.id, "pause", {}, "ws710-mock-pause");
    await service.advanceSimulation(
      created.simulation.id,
      { runId: created.run.id, ticks: 1 },
      "ws710-mock-advance",
    );

    const accepted = service.replaySimulation(
      created.simulation.id,
      created.run.id,
      { mode: "strict" },
      "ws710-mock-replay",
    );
    const replay = await waitForReplay(service, created.simulation.id, accepted.replayRun.id);

    expect(replay.status, JSON.stringify(replay)).toBe("completed");
    expect(replay.divergenceCount).toBe(0);
    expect(replay.replayStateHash).toBe(replay.sourceStateHash);
  }, 30_000);

  it("replays an injected world event at the original tick boundary", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-ws705-world-event-"));
    directories.push(dataDir);
    const service = new SimulationService({
      dataDir,
      enableNewsPipeline: false,
      tickIntervalMs: 60_000,
      wallClock: () => "2026-07-16T12:00:00.000Z",
    });
    services.push(service);
    const created = service.createSimulation({
      name: "WS-705 world-event replay",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "off",
        budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
        policyOverrides: {},
        endTick: 1,
      },
    }, "ws705-world-create");
    service.controlSimulation(created.simulation.id, "start", {}, "ws705-world-start");
    service.controlSimulation(created.simulation.id, "pause", {}, "ws705-world-pause");
    service.injectWorldEvent(created.simulation.id, {
      runId: created.run.id,
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30 },
    }, "ws705-world-inject");
    await service.advanceSimulation(
      created.simulation.id,
      { runId: created.run.id, ticks: 1 },
      "ws705-world-advance",
    );

    const accepted = service.replaySimulation(
      created.simulation.id,
      created.run.id,
      { mode: "strict" },
      "ws705-world-replay",
    );
    const replay = await waitForReplay(service, created.simulation.id, accepted.replayRun.id);

    expect(replay.errorMessage).toBeNull();
    expect(replay).toMatchObject({
      status: "completed",
      currentTick: 1,
      divergenceCount: 0,
    });
    expect(replay.replayStateHash).toBe(replay.sourceStateHash);
  }, 30_000);

  it("replays a live-shaped run exclusively from cached provider evidence", async () => {
    const fixture = await createLiveSourceFixture();
    const sourceProviderCalls = fixture.provider.calls.length;

    const accepted = fixture.service.replaySimulation(
      fixture.created.simulation.id,
      fixture.created.run.id,
      { mode: "strict" },
      "ws705-replay",
    );
    const replayDb = openWorldDatabase(
      fixture.dataDir,
      fixture.created.simulation.id,
      accepted.replayRun.id,
    );
    try {
      prepareSingleGoalParityFixture(replayDb, accepted.replayRun.id);
    } finally {
      replayDb.close();
    }
    const replay = await waitForReplay(
      fixture.service,
      fixture.created.simulation.id,
      accepted.replayRun.id,
    );

    expect(fixture.provider.calls).toHaveLength(sourceProviderCalls);
    expect(replay.firstDivergence).toBeNull();
    expect(replay).toMatchObject({
      replayOf: fixture.created.run.id,
      status: "completed",
      divergenceCount: 0,
    });
    expect(replay.replayStateHash).toBe(replay.sourceStateHash);
  }, 30_000);

  it("halts strict replay before tick mutation when successful call cache evidence is missing", async () => {
    const fixture = await createLiveSourceFixture();
    const sourceProviderCalls = fixture.provider.calls.length;
    removeSourceCache(fixture);

    const accepted = fixture.service.replaySimulation(
      fixture.created.simulation.id,
      fixture.created.run.id,
      { mode: "strict" },
      "ws705-strict-missing-cache",
    );
    const replay = await waitForReplay(
      fixture.service,
      fixture.created.simulation.id,
      accepted.replayRun.id,
    );

    expect(fixture.provider.calls).toHaveLength(sourceProviderCalls);
    expect(replay).toMatchObject({
      status: "diverged",
      currentTick: 0,
      divergenceCount: 1,
      firstDivergence: { kind: "cache_incomplete", tick: 0 },
    });
  }, 30_000);

  it("records missing-cache divergence and continues observe replay with fallback", async () => {
    const fixture = await createLiveSourceFixture();
    const sourceProviderCalls = fixture.provider.calls.length;
    removeSourceCache(fixture);

    const accepted = fixture.service.replaySimulation(
      fixture.created.simulation.id,
      fixture.created.run.id,
      { mode: "observe" },
      "ws705-observe-missing-cache",
    );
    const replayDb = openWorldDatabase(
      fixture.dataDir,
      fixture.created.simulation.id,
      accepted.replayRun.id,
    );
    try {
      prepareSingleGoalParityFixture(replayDb, accepted.replayRun.id);
    } finally {
      replayDb.close();
    }
    const replay = await waitForReplay(
      fixture.service,
      fixture.created.simulation.id,
      accepted.replayRun.id,
    );

    expect(fixture.provider.calls).toHaveLength(sourceProviderCalls);
    expect(replay).toMatchObject({
      status: "diverged",
      currentTick: 1,
      firstDivergence: { kind: "cache_incomplete", tick: 0 },
    });
    expect(replay.divergenceCount).toBeGreaterThan(1);
    expect(replay.replayStateHash).not.toBe(replay.sourceStateHash);
  }, 30_000);
});
