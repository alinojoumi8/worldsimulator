import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  createSimulationResponseSchema,
  recordedAgentLabSubmissionSchema,
  replaySimulationResponseSchema,
  type AgentActionReceipt,
  type AgentTurnEnvelope,
  type ReplayRun,
} from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import { buildApp } from "./app";
import { prepareSingleGoalParityFixture } from "./llm-parity";
import {
  openWorldDatabase,
  SqliteAgentLabStore,
  SqliteEventStore,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";
import { readRiverbendBaselineObservation } from "./testing/scenario-regression-probe";

const directories: string[] = [];
const applications: FastifyInstance[] = [];
const digest = "a".repeat(64);
const wallTime = "2026-07-24T12:00:00.000Z";

afterEach(async () => {
  while (applications.length > 0) await applications.pop()!.close();
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

async function waitForTurn(
  app: FastifyInstance,
  token: string,
): Promise<AgentTurnEnvelope> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent-lab/turn?waitMs=0",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const turn = response.json<{ turn: AgentTurnEnvelope | null }>().turn;
    if (turn !== null) return turn;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("external Agent Lab turn did not open");
}

async function waitForTerminalReceipt(
  app: FastifyInstance,
  token: string,
  submissionId: string,
): Promise<AgentActionReceipt> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agent-lab/actions/${submissionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const receipt = response.json<{ receipt: AgentActionReceipt }>().receipt;
    if (!["queued"].includes(receipt.status)) return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("external Agent Lab receipt did not become terminal");
}

async function waitForReplay(
  app: FastifyInstance,
  simulationId: string,
  runId: string,
): Promise<ReplayRun> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const replay = response.json<{ replay: ReplayRun | null }>().replay;
    if (replay !== null && replay.status !== "running") return replay;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("external Agent Lab replay did not become terminal");
}

describe("active Agent Lab execution", () => {
  it("journals a scoped submission, uses normal validators, and replays offline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-agent-lab-active-"));
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

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        name: "Agent Lab active and replay",
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
            studyId: "active-replay",
            trialId: "active-replay-seed-42",
            experimentManifestDigest: digest,
            mode: "external",
            controllerAssignments: [{
              agentId: "agt_00000001",
              controller: "external",
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
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = createSimulationResponseSchema.parse(createResponse.json());

    const credentialDb = openWorldDatabase(
      dataDir,
      created.simulation.id,
      created.run.id,
    );
    const credentialStore = new SqliteAgentLabStore(credentialDb, created.run.id);
    const fixtureAgentId = prepareSingleGoalParityFixture(credentialDb, created.run.id);
    const controlledAgentId = credentialStore.config().resolvedAssignments[0]!.agentId;
    expect(controlledAgentId).toBe(fixtureAgentId);
    const credential = credentialStore.issueCredential({
      agentId: controlledAgentId,
      createdWall: wallTime,
    });
    credentialDb.close();

    for (const control of ["start", "pause"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${created.simulation.id}/${control}`,
        payload: { runId: created.run.id },
      });
      expect(response.statusCode, response.body).toBe(202);
    }

    const advancePromise = app.inject({
      method: "POST",
      url: `/api/v1/simulations/${created.simulation.id}/advance`,
      payload: { runId: created.run.id, ticks: 1 },
    });
    const turn = await waitForTurn(app, credential.token);
    expect(turn.agentId).toBe(controlledAgentId);
    expect(turn.controller).toBe("external");
    expect(turn.observation.policyVersion).toBe("partial_observation_v1");
    expect(turn.offeredOptions.length).toBeGreaterThan(0);

    const selected = turn.offeredOptions[0]!;
    const submissionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agent-lab/actions",
      headers: { authorization: `Bearer ${credential.token}` },
      payload: {
        turnId: turn.turnId,
        targetTick: turn.targetTick,
        observedProjectionHash: turn.projectionHash,
        observedMenuHash: turn.menuHash,
        idempotencyKey: "active-replay-1",
        action: {
          actionId: selected.actionId,
          params: selected.params,
          rationale: "Select an engine-authored bounded option for replay proof.",
        },
        driverPolicyDigest: digest,
      },
    });
    expect(submissionResponse.statusCode, submissionResponse.body).toBe(202);
    const queued = submissionResponse.json<{ receipt: AgentActionReceipt }>().receipt;
    expect(queued.status).toBe("queued");
    expect(queued.submissionId).toBeDefined();

    const advanceResponse = await advancePromise;
    expect(advanceResponse.statusCode, advanceResponse.body).toBe(200);
    const receipt = await waitForTerminalReceipt(
      app,
      credential.token,
      queued.submissionId!,
    );
    expect(receipt.status).toBe("applied");
    expect(receipt.postTickStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.validatorResults).toContainEqual(expect.objectContaining({
      validator: "action_registry",
      ok: true,
    }));

    let sourceInputPayload: unknown;
    const sourceDb = openWorldDatabase(
      dataDir,
      created.simulation.id,
      created.run.id,
    );
    try {
      const store = new SqliteAgentLabStore(sourceDb, created.run.id);
      expect(store.artifactRows().externallyInfluenced).toBe(true);
      const inputEvents = new SqliteEventStore(sourceDb, created.run.id).list({
        type: "agent.external_submission.recorded",
      });
      expect(inputEvents).toHaveLength(1);
      expect(inputEvents[0]?.payload).toMatchObject({
        trialId: "active-replay-seed-42",
        turnId: turn.turnId,
        actionId: selected.actionId,
      });
      sourceInputPayload = inputEvents[0]?.payload;
      const recorded = recordedAgentLabSubmissionSchema.parse(sourceInputPayload);
      const cachedExternal = sourceDb.prepare<
        [string, string],
        { count: bigint }
      >(`
        SELECT COUNT(*) AS count FROM llm_response_cache
        WHERE run_id = ? AND request_hash = ?
      `).get(created.run.id, recorded.requestHash);
      expect(cachedExternal?.count).toBe(0n);
      expect(() => readRiverbendBaselineObservation(sourceDb, created.run.id)).toThrow(
        /cannot replace the Riverbend release baseline/,
      );
      const invariants = checkInvariants(readRunInvariantSnapshot(sourceDb, created.run.id));
      expect(invariants.passed, JSON.stringify(invariants.violations)).toBe(true);
    } finally {
      sourceDb.close();
    }

    const replayResponse = await app.inject({
      method: "POST",
      url:
        `/api/v1/simulations/${created.simulation.id}/runs/` +
        `${created.run.id}/replay`,
      payload: { mode: "strict" },
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    const accepted = replaySimulationResponseSchema.parse(replayResponse.json());
    const replayFixtureDb = openWorldDatabase(
      dataDir,
      created.simulation.id,
      accepted.replayRun.id,
    );
    try {
      expect(prepareSingleGoalParityFixture(
        replayFixtureDb,
        accepted.replayRun.id,
      )).toBe(controlledAgentId);
    } finally {
      replayFixtureDb.close();
    }
    const replay = await waitForReplay(
      app,
      created.simulation.id,
      accepted.replayRun.id,
    );
    expect(replay.status, JSON.stringify(replay)).toBe("completed");
    expect(replay.divergenceCount).toBe(0);
    expect(replay.replayStateHash).toBe(replay.sourceStateHash);

    const replayDb = openWorldDatabase(
      dataDir,
      created.simulation.id,
      accepted.replayRun.id,
    );
    try {
      const replayInputs = new SqliteEventStore(replayDb, accepted.replayRun.id).list({
        type: "agent.external_submission.recorded",
      });
      expect(replayInputs).toHaveLength(1);
      expect(replayInputs[0]?.payload).toEqual(sourceInputPayload);
    } finally {
      replayDb.close();
    }
  }, 30_000);
});
