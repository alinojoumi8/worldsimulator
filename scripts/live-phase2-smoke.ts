/** Real HTTP Phase 2 smoke probe with durable evidence output. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  agentDecisionListResponseSchema,
  agentListResponseSchema,
  agentProfileResponseSchema,
  createSimulationResponseSchema,
  relationshipListResponseSchema,
} from "../packages/shared/src/index";
import { checkInvariants } from "../packages/engine/src/index";
import { buildApp } from "../apps/server/src/app";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteSnapshotStore,
} from "../apps/server/src/persistence/index";
import { readRunInvariantSnapshot } from "../apps/server/src/testing/run-invariant-probe";

const outputPath = resolve(
  process.argv[2] ?? "artifacts/live-phase2/2026-07-15-smoke.json",
);
const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-live-phase2-"));
const wallTime = "2026-07-15T12:00:00.000Z";
let app = buildApp({
  dataDir,
  wallClock: () => wallTime,
  tickIntervalMs: 60_000,
  snapshotIntervalTicks: 1,
  webRoot: false,
});

async function request(origin: string, path: string, init?: RequestInit) {
  const response = await fetch(origin + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main(): Promise<void> {
  let origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const created = createSimulationResponseSchema.parse(await request(
    origin,
    "/api/v1/simulations",
    {
      method: "POST",
      body: JSON.stringify({
        name: "live-phase-2-riverbend",
        scenario: {
          worldSpec: "riverbend-100@1",
          seed: 42,
          llmMode: "mock",
          budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
          policyOverrides: {},
          endTick: 120,
        },
      }),
    },
  ));
  const simulationId = created.simulation.id;
  const runId = created.run.id;

  const agents = [];
  let cursor: string | null = null;
  do {
    const page = agentListResponseSchema.parse(await request(
      origin,
      `/api/v1/simulations/${simulationId}/agents?runId=${runId}&limit=23` +
        (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`),
    ));
    agents.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  if (agents.length !== 100) throw new Error(`expected 100 agents, found ${agents.length}`);

  const selected = agents[0]!;
  const profileBefore = agentProfileResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/agents/${selected.id}?runId=${runId}`,
  ));
  const relationships = relationshipListResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/agents/${selected.id}/relationships?runId=${runId}`,
  ));

  for (const control of ["start", "pause"]) {
    await request(origin, `/api/v1/simulations/${simulationId}/${control}`, {
      method: "POST",
      body: JSON.stringify({ runId }),
    });
  }
  await request(origin, `/api/v1/simulations/${simulationId}/advance`, {
    method: "POST",
    body: JSON.stringify({ runId, ticks: 1 }),
  });

  const decisions = agentDecisionListResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/agents/${selected.id}/decisions?runId=${runId}`,
  ));
  const profileAfter = agentProfileResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/agents/${selected.id}?runId=${runId}`,
  ));
  if (decisions.items.length === 0) throw new Error("tick 1 produced no selected-agent decision");
  if (!profileAfter.agent.memoryHighlights.some((memory) => memory.kind === "outcome")) {
    throw new Error("tick 1 produced no outcome memory");
  }

  const db = openWorldDatabase(dataDir, simulationId, runId);
  let invariantReport;
  let stateHash: string;
  let snapshotId: string;
  let persistedCounts: Record<string, number>;
  try {
    invariantReport = checkInvariants(readRunInvariantSnapshot(db, runId));
    if (!invariantReport.passed) {
      throw new Error(`invariant violations: ${JSON.stringify(invariantReport.violations)}`);
    }
    stateHash = computeLogicalStateHash(db, runId);
    const snapshot = new SqliteSnapshotStore(db, dataDir, simulationId, runId).list()[0];
    if (snapshot === undefined || snapshot.stateHash !== stateHash) {
      throw new Error("periodic snapshot does not match the committed Phase 2 state");
    }
    snapshotId = snapshot.id;
    persistedCounts = Object.fromEntries(
      ["agents", "goals", "relationships", "memories", "decisions", "agent_actions"]
        .map((table) => {
          const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: bigint;
          };
          return [table, Number(row.count)];
        }),
    );
  } finally {
    db.close();
  }

  await app.close();
  app = buildApp({
    dataDir,
    wallClock: () => wallTime,
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: 1,
    webRoot: false,
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const decisionsAfterReopen = agentDecisionListResponseSchema.parse(await request(
    origin,
    `/api/v1/simulations/${simulationId}/agents/${selected.id}/decisions?runId=${runId}`,
  ));
  if (JSON.stringify(decisionsAfterReopen.items) !== JSON.stringify(decisions.items)) {
    throw new Error("decision feed changed after service reopen");
  }

  const artifact = {
    artifactSchemaVersion: 1,
    status: "passed",
    executedDate: "2026-07-15",
    transport: "Fastify over a real 127.0.0.1 TCP listener using fetch",
    scenario: { worldSpec: "riverbend-100@1", seed: 42, llmMode: "mock" },
    simulationId,
    runId,
    tick: 1,
    population: {
      agents: agents.length,
      uniqueAgentIds: new Set(agents.map((agent) => agent.id)).size,
      selectedAgentId: selected.id,
      selectedAgentName: selected.name,
      selectedAgentGoals: profileBefore.agent.goals.length,
      selectedAgentRelationships: relationships.items.length,
    },
    runtime: {
      selectedAgentDecisions: decisions.items.length,
      initialMemoryId: profileBefore.agent.memoryHighlights[0]?.id,
      outcomeMemoryRecorded: profileAfter.agent.memoryHighlights.some(
        (memory) => memory.kind === "outcome",
      ),
      reopenEquivalent: true,
      persistedCounts,
    },
    invariants: invariantReport,
    snapshot: { id: snapshotId, stateHash, matchesLiveState: true },
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ outputPath, ...artifact }, null, 2) + "\n");
}

try {
  await main();
} finally {
  if (app.server.listening) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
