import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  llmRequestHash,
  type LlmRequest,
  type RoutedLlmProvider,
} from "@worldtangle/engine";
import { openWorldDatabase } from "./persistence";
import { prepareSingleGoalParityFixture } from "./llm-parity";
import { SimulationService } from "./simulation-service";

const directories: string[] = [];
const services: SimulationService[] = [];

class LiveShapeCeilingProvider implements RoutedLlmProvider {
  readonly calls: LlmRequest[] = [];

  route() {
    return { provider: "anthropic", model: "ws609-live-shape" };
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
      model: "ws609-live-shape",
      cached: false,
      inputTokens: 1,
      outputTokens: 0,
      requestHash: llmRequestHash(request),
      attempts: 1,
    };
  }
}

async function waitForBudgetPause(
  service: SimulationService,
  simulationId: string,
  runId: string,
) {
  const deadline = performance.now() + 20_000;
  let last: unknown;
  while (performance.now() < deadline) {
    const current = service.getStatus(simulationId, runId) as {
      run: { status: string; currentTick: number };
      llm: {
        autoPaused: boolean;
        effectiveTier: number;
        spend: { inputTokens: number; outputTokens: number; costCentsEstimate: string };
      };
    };
    last = current;
    if (current.run.status === "paused" && current.llm.autoPaused) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fixture run did not auto-pause: ${JSON.stringify(last)}`);
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-609 live budget acceptance lifecycle", () => {
  it("auto-pauses at $2 and makes no provider call after the ceiling response", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-ws609-"));
    directories.push(dataDir);
    const provider = new LiveShapeCeilingProvider();
    const service = new SimulationService({
      dataDir,
      enableNewsPipeline: false,
      tickIntervalMs: 1,
      snapshotIntervalTicks: 100,
      llmProviderFactory: () => provider,
      llmModelPrices: new Map([["ws609-live-shape", {
        inputMicrocentsPerToken: 200_000_000n,
        outputMicrocentsPerToken: 0n,
      }]]),
    });
    services.push(service);
    const created = service.createSimulation({
      name: "WS-609 nonbillable lifecycle fixture",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "live",
        budgets: { runCostCentsMax: "200", perAgentDailyTokens: 128_000 },
        policyOverrides: {},
        endTick: 360,
      },
    }, "ws609-create");

    const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
    try {
      prepareSingleGoalParityFixture(db, created.run.id);
    } finally {
      db.close();
    }

    service.controlSimulation(created.simulation.id, "start", {}, "ws609-start");
    const paused = await waitForBudgetPause(service, created.simulation.id, created.run.id);
    expect(paused).toMatchObject({
      run: { status: "paused" },
      llm: {
        autoPaused: true,
        effectiveTier: 1,
        spend: { inputTokens: 1, outputTokens: 0, costCentsEstimate: "200" },
      },
    });
    expect(provider.calls).toHaveLength(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(provider.calls).toHaveLength(1);
    expect(service.getStatus(created.simulation.id, created.run.id)).toMatchObject({
      run: { status: "paused" },
      llm: { autoPaused: true },
    });

    const events = service.listEvents(created.simulation.id, {
      runId: created.run.id,
      limit: 100,
      type: "llm.budget.threshold",
    });
    expect(events.items.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "auto_pause", thresholdPct: 100 }),
    ]));
  }, 30_000);
});
