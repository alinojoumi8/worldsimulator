import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  createSimulationResponseSchema,
  type AgentActionReceipt,
  type AgentTurnEnvelope,
} from "@worldtangle/shared";
import { buildApp } from "./app";
import { prepareSingleGoalParityFixture } from "./llm-parity";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteAgentLabStore,
  SqliteEventStore,
} from "./persistence";

const directories: string[] = [];
const applications: FastifyInstance[] = [];
const digest = "b".repeat(64);
const wallTime = "2026-07-24T12:00:00.000Z";

afterEach(async () => {
  while (applications.length > 0) await applications.pop()!.close();
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

async function runShadowTrial(submit: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-agent-lab-shadow-"));
  directories.push(dataDir);
  const app = buildApp({
    dataDir,
    wallClock: () => wallTime,
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: 1,
    enableNewsPipeline: false,
    webRoot: false,
  });
  applications.push(app);
  const createdResponse = await app.inject({
    method: "POST",
    url: "/api/v1/simulations",
    payload: {
      name: "Agent Lab shadow invariance",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: {
          runCostCentsMax: "10000",
          perAgentDailyTokens: 10_000,
        },
        policyOverrides: {},
        endTick: 1,
        agentLab: {
          protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
          studyId: "shadow-invariance",
          trialId: "shadow-invariance-seed-42",
          experimentManifestDigest: digest,
          mode: "shadow",
          controllerAssignments: [{
            agentId: "agt_00000001",
            controller: "shadow",
          }],
          decisionDeadlineMs: 5_000,
          budget: {
            maxAgentLoopIterations: 8,
            maxInputTokens: 8_000,
            maxOutputTokens: 1_000,
            maxToolCalls: 8,
          },
          driverPolicyDigest: digest,
          promptDigest: digest,
          toolSchemaDigest: digest,
        },
      },
    },
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const created = createSimulationResponseSchema.parse(createdResponse.json());

  const fixtureDb = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  const fixtureAgentId = prepareSingleGoalParityFixture(fixtureDb, created.run.id);
  const labStore = new SqliteAgentLabStore(fixtureDb, created.run.id);
  const credential = labStore.issueCredential({
    agentId: fixtureAgentId,
    createdWall: wallTime,
  });
  fixtureDb.close();

  for (const control of ["start", "pause"] as const) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/${control}`,
      payload: { runId: created.run.id },
    });
    expect(response.statusCode, response.body).toBe(202);
  }
  const advanced = await app.inject({
    method: "POST",
    url: `/api/v1/simulations/${created.simulation.id}/advance`,
    payload: { runId: created.run.id, ticks: 1 },
  });
  expect(advanced.statusCode, advanced.body).toBe(200);

  const turnResponse = await app.inject({
    method: "GET",
    url: "/api/v1/agent-lab/turn?waitMs=0",
    headers: { authorization: `Bearer ${credential.token}` },
  });
  expect(turnResponse.statusCode, turnResponse.body).toBe(200);
  const turn = turnResponse.json<{ turn: AgentTurnEnvelope | null }>().turn;
  expect(turn).not.toBeNull();

  if (submit) {
    const selected = turn!.offeredOptions[0]!;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent-lab/actions",
      headers: { authorization: `Bearer ${credential.token}` },
      payload: {
        turnId: turn!.turnId,
        targetTick: turn!.targetTick,
        observedProjectionHash: turn!.projectionHash,
        observedMenuHash: turn!.menuHash,
        idempotencyKey: "shadow-invariance-1",
        action: {
          actionId: selected.actionId,
          params: selected.params,
          rationale: "Record a non-authoritative shadow choice.",
        },
        driverPolicyDigest: digest,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ receipt: AgentActionReceipt }>().receipt.status).toBe("shadowed");
  }

  const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  try {
    const store = new SqliteAgentLabStore(db, created.run.id);
    return {
      eventLogHash: new SqliteEventStore(db, created.run.id).logHash(),
      stateHash: computeLogicalStateHash(db, created.run.id),
      externallyInfluenced: store.artifactRows().externallyInfluenced,
      submissionCount: store.artifactRows().submissions.length,
    };
  } finally {
    db.close();
  }
}

describe("shadow Agent Lab execution", () => {
  it("keeps authoritative state and raw event hashes unchanged", async () => {
    const control = await runShadowTrial(false);
    const submitted = await runShadowTrial(true);

    expect(submitted.submissionCount).toBe(1);
    expect(control.submissionCount).toBe(0);
    expect(submitted.externallyInfluenced).toBe(false);
    expect(control.externallyInfluenced).toBe(false);
    expect(submitted.eventLogHash).toBe(control.eventLogHash);
    expect(submitted.stateHash).toBe(control.stateHash);
  }, 30_000);
});
