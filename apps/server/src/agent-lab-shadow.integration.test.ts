import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSimulationResponseSchema,
  type AgentActionReceipt,
  type AgentTurnEnvelope,
  type CreateSimulationResponse,
} from "@worldtangle/shared";
import { buildApp } from "./app";
import { prepareSingleGoalParityFixture } from "./llm-parity";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteAgentLabStore,
  SqliteEventStore,
} from "./persistence";
import {
  buildAgentLabTestScenario,
  variantDigest,
} from "./testing/agent-lab-test-fixture";

const directories: string[] = [];
const applications: FastifyInstance[] = [];
const digest = "b".repeat(64);
const driverPolicyDigest = variantDigest(digest, "driver-policy");
const wallTime = "2026-07-24T12:00:00.000Z";

afterEach(async () => {
  while (applications.length > 0) await applications.pop()!.close();
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

interface AdvanceTestRunOptions {
  readonly directoryPrefix: string;
  readonly snapshotIntervalTicks: number;
  readonly name: string;
  readonly endTick: number;
  readonly advanceTicks: number;
  readonly agentLab: ReturnType<typeof buildAgentLabTestScenario>;
  readonly prepareCredential?: (
    dataDir: string,
    created: CreateSimulationResponse,
  ) => string;
}

async function createAndAdvanceTestRun(options: AdvanceTestRunOptions) {
  const dataDir = mkdtempSync(join(tmpdir(), options.directoryPrefix));
  directories.push(dataDir);
  const app = buildApp({
    dataDir,
    wallClock: () => wallTime,
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: options.snapshotIntervalTicks,
    enableNewsPipeline: false,
    webRoot: false,
  });
  applications.push(app);
  const createdResponse = await app.inject({
    method: "POST",
    url: "/api/v1/simulations",
    payload: {
      name: options.name,
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: {
          runCostCentsMax: "10000",
          perAgentDailyTokens: 10_000,
        },
        policyOverrides: {},
        endTick: options.endTick,
        agentLab: options.agentLab,
      },
    },
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const created = createSimulationResponseSchema.parse(createdResponse.json());
  const credentialToken = options.prepareCredential?.(dataDir, created);

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
    payload: { runId: created.run.id, ticks: options.advanceTicks },
  });
  expect(advanced.statusCode, advanced.body).toBe(200);

  return { dataDir, app, created, credentialToken };
}

async function runShadowTrial(submit: boolean) {
  const { app, created, credentialToken, dataDir } = await createAndAdvanceTestRun({
    directoryPrefix: "worldtangle-agent-lab-shadow-",
    snapshotIntervalTicks: 1,
    name: "Agent Lab shadow invariance",
    endTick: 1,
    advanceTicks: 1,
    agentLab: buildAgentLabTestScenario({
      studyId: "shadow-invariance",
      trialId: "shadow-invariance-seed-42",
      digest,
      mode: "shadow",
      agentIds: ["agt_00000001"],
    }),
    prepareCredential: (fixtureDataDir, fixtureRun) => {
      const fixtureDb = openWorldDatabase(
        fixtureDataDir,
        fixtureRun.simulation.id,
        fixtureRun.run.id,
      );
      try {
        const fixtureAgentId = prepareSingleGoalParityFixture(
          fixtureDb,
          fixtureRun.run.id,
        );
        return new SqliteAgentLabStore(fixtureDb, fixtureRun.run.id).issueCredential({
          agentId: fixtureAgentId,
          createdWall: wallTime,
        }).token;
      } finally {
        fixtureDb.close();
      }
    },
  });
  if (credentialToken === undefined) {
    throw new Error("shadow invariance run has no scoped credential");
  }

  const turnResponse = await app.inject({
    method: "GET",
    url: "/api/v1/agent-lab/turn?waitMs=0",
    headers: { authorization: `Bearer ${credentialToken}` },
  });
  expect(turnResponse.statusCode, turnResponse.body).toBe(200);
  const turn = turnResponse.json<{ turn: AgentTurnEnvelope | null }>().turn;
  expect(turn).not.toBeNull();
  expect(turn!.driverPolicyDigest).toBe(driverPolicyDigest);

  if (submit) {
    expect(turn!.offeredOptions.length).toBeGreaterThan(0);
    const selected = turn!.offeredOptions[0]!;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent-lab/actions",
      headers: { authorization: `Bearer ${credentialToken}` },
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
        driverPolicyDigest: turn!.driverPolicyDigest,
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

async function runMatchedArm(mode: "native" | "shadow") {
  const { created, dataDir } = await createAndAdvanceTestRun({
    directoryPrefix: `worldtangle-agent-lab-${mode}-`,
    snapshotIntervalTicks: 100,
    name: "Agent Lab matched native-shadow control",
    endTick: 10,
    advanceTicks: 10,
    agentLab: buildAgentLabTestScenario({
      studyId: "matched-native-shadow",
      trialId: `matched-native-shadow-${mode}`,
      digest,
      mode,
      cohortSize: 8,
      fixtureTicks: [10],
    }),
  });

  const resolvedAssignments = created.run.manifest.agentLab?.resolvedAssignments;
  if (resolvedAssignments === undefined) {
    throw new Error("matched Agent Lab arm has no resolved cohort");
  }
  expect(resolvedAssignments).toHaveLength(8);
  const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
  try {
    return {
      stateHash: computeLogicalStateHash(db, created.run.id),
      turnCount: new SqliteAgentLabStore(db, created.run.id).artifactRows().turns.length,
      cohortAgentIds: resolvedAssignments.map(
        (assignment) => assignment.agentId,
      ),
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

  it("matches the same-seed native world while retaining shadow-only turns", async () => {
    const native = await runMatchedArm("native");
    const shadow = await runMatchedArm("shadow");
    const nativeRepeat = await runMatchedArm("native");
    const shadowRepeat = await runMatchedArm("shadow");

    expect(nativeRepeat).toEqual(native);
    expect(shadowRepeat).toEqual(shadow);
    expect(native.turnCount).toBe(0);
    expect(shadow.turnCount).toBe(8);
    expect(shadow.cohortAgentIds).toEqual(native.cohortAgentIds);
    expect(shadow.stateHash).toBe(native.stateHash);
  }, 60_000);
});
