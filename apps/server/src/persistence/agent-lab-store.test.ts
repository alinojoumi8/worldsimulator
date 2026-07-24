import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  hashValue,
  type AgentActionSubmission,
  type AgentTurnEnvelope,
} from "@worldtangle/shared";
import { buildApp } from "../app";
import { openWorldDatabase } from "./database";
import { SqliteAgentLabStore } from "./agent-lab-store";

const directories: string[] = [];
const digest = "a".repeat(64);

function dataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-agent-lab-store-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createTrial() {
  const root = dataDir();
  const app = buildApp({
    dataDir: root,
    wallClock: () => "2026-07-24T12:00:00.000Z",
    webRoot: false,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/simulations",
    payload: {
      name: "Agent Lab store test",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: {
          runCostCentsMax: "10000",
          perAgentDailyTokens: 10_000,
        },
        policyOverrides: {},
        endTick: 2,
        agentLab: {
          protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
          studyId: "agent-lab-store",
          trialId: "seed-42-external",
          experimentManifestDigest: digest,
          mode: "external",
          cohortSelection: {
            strategy: "stable_stratified_v1",
            size: 2,
            controller: "external",
            strata: ["occupation"],
          },
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
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    simulation: { id: string };
    run: { id: string };
  }>();
  await app.close();
  const db = openWorldDatabase(root, body.simulation.id, body.run.id);
  return {
    root,
    db,
    simulationId: body.simulation.id,
    runId: body.run.id,
    store: new SqliteAgentLabStore(db, body.run.id),
  };
}

function turn(
  simulationId: string,
  runId: string,
  agentId: string,
): AgentTurnEnvelope {
  const observation = {
    policyVersion: "partial_observation_v1" as const,
    ownState: { availableCashCents: "10000" },
    learnedFacts: [],
    deliveredItems: [],
    publicPrices: [],
    citedMemories: [],
  };
  const offeredOptions = [{
    actionId: "goal.defer",
    actionType: "goal.defer",
    params: {},
    utility: 10,
  }];
  return {
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    simulationId,
    runId,
    studyId: "agent-lab-store",
    trialId: "seed-42-external",
    turnId: `turn_${"1".repeat(24)}`,
    agentId,
    controller: "external",
    opportunityKey: `goal:${agentId}:1`,
    trigger: {
      kind: "goal",
      agentId,
      sourceEventId: "evt_00000001",
      tick: 1,
      priority: 70,
      payload: { goalId: "goal_00000001", goalKind: "stability" },
    },
    completedTick: 0,
    targetTick: 1,
    observation,
    offeredOptions,
    projectionHash: hashValue(observation),
    menuHash: hashValue(offeredOptions),
    cursor: "tick:1:goal",
    deadline: "2026-07-24T12:00:05.000Z",
    driverPolicyDigest: digest,
    promptDigest: digest,
    toolSchemaDigest: digest,
  };
}

function submission(envelope: AgentTurnEnvelope): AgentActionSubmission {
  return {
    turnId: envelope.turnId,
    targetTick: envelope.targetTick,
    observedProjectionHash: envelope.projectionHash,
    observedMenuHash: envelope.menuHash,
    idempotencyKey: "hermes-turn-1",
    action: {
      actionId: "goal.defer",
      params: {},
      rationale: "Wait for one more observation before committing resources.",
    },
    driverPolicyDigest: digest,
  };
}

describe("SqliteAgentLabStore", () => {
  it("immediately falls back when an assigned external agent has no active credential", async () => {
    const fixture = await createTrial();
    try {
      const agentId = fixture.store.config().resolvedAssignments[0]!.agentId;
      const envelope = fixture.store.openTurn(
        turn(fixture.simulationId, fixture.runId, agentId),
        "2026-07-24T12:00:00.200Z",
      );
      const receipt = fixture.store.artifactRows().receipts.find(
        (candidate) => candidate.turnId === envelope.turnId,
      );
      expect(receipt).toMatchObject({
        status: "fallback",
        agentId,
      });
      await expect(fixture.store.waitForAcceptedSubmission(
        envelope.turnId,
        () => "2026-07-24T12:00:00.300Z",
      )).resolves.toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  it("stores only credential hashes and returns idempotent receipts", async () => {
    const fixture = await createTrial();
    try {
      const assigned = fixture.store.config().resolvedAssignments;
      const issued = fixture.store.issueCredential({
        agentId: assigned[0]!.agentId,
        createdWall: "2026-07-24T12:00:00.000Z",
      });
      const stored = fixture.db.prepare<[string], { token_hash: string }>(`
        SELECT token_hash FROM agent_lab_credentials WHERE credential_id = ?
      `).get(issued.credentialId);
      expect(stored?.token_hash).toHaveLength(64);
      expect(stored?.token_hash).not.toContain(issued.token);

      const identity = fixture.store.authenticate(
        issued.token,
        "2026-07-24T12:00:00.100Z",
        "agent-lab.action:submit",
      );
      const envelope = fixture.store.openTurn(
        turn(fixture.simulationId, fixture.runId, identity.agentId),
        "2026-07-24T12:00:00.200Z",
      );
      const first = fixture.store.submit(
        identity,
        submission(envelope),
        "2026-07-24T12:00:00.300Z",
      );
      const retry = fixture.store.submit(
        identity,
        submission(envelope),
        "2026-07-24T12:00:00.400Z",
      );
      expect(first.status).toBe("queued");
      expect(retry).toEqual(first);
      expect(fixture.store.artifactRows().externallyInfluenced).toBe(true);

      const applied = fixture.store.finalizeTurn({
        opportunityKey: envelope.opportunityKey,
        status: "applied",
        validatorResults: [{
          validator: "action_registry",
          ok: true,
          code: "OK",
          message: "existing action registry accepted the intent",
        }],
        resultEventIds: ["evt_00000002"],
        completedWall: "2026-07-24T12:00:01.000Z",
      });
      expect(applied?.status).toBe("applied");
      fixture.store.finalizePostTick(1, "b".repeat(64));
      expect(fixture.store.receipt(identity, first.submissionId!).postTickStateHash)
        .toBe("b".repeat(64));
    } finally {
      fixture.db.close();
    }
  });

  it("rejects stale hashes, cross-agent access, private canaries, and revoked credentials", async () => {
    const fixture = await createTrial();
    try {
      const assignments = fixture.store.config().resolvedAssignments;
      const firstIssued = fixture.store.issueCredential({
        agentId: assignments[0]!.agentId,
        createdWall: "2026-07-24T12:00:00.000Z",
      });
      const secondIssued = fixture.store.issueCredential({
        agentId: assignments[1]!.agentId,
        createdWall: "2026-07-24T12:00:00.000Z",
      });
      const first = fixture.store.authenticate(
        firstIssued.token,
        "2026-07-24T12:00:00.100Z",
      );
      const second = fixture.store.authenticate(
        secondIssued.token,
        "2026-07-24T12:00:00.100Z",
      );
      const envelope = turn(fixture.simulationId, fixture.runId, first.agentId);
      expect(() => fixture.store.openTurn({
        ...envelope,
        observation: {
          ...envelope.observation,
          ownState: { privateCanary: "must-not-cross" },
        },
      }, "2026-07-24T12:00:00.200Z")).toThrow(/private or credential/);
      fixture.store.openTurn(envelope, "2026-07-24T12:00:00.200Z");
      expect(() => fixture.store.submit(
        second,
        submission(envelope),
        "2026-07-24T12:00:00.300Z",
      )).toThrow(/not owned/);

      const changedParams = fixture.store.submit(first, {
        ...submission(envelope),
        idempotencyKey: "changed-params",
        action: {
          ...submission(envelope).action,
          params: { invented: true },
        },
      }, "2026-07-24T12:00:00.250Z");
      expect(changedParams.status).toBe("rejected");
      expect(changedParams.validatorResults).toContainEqual(expect.objectContaining({
        validator: "offered_params",
        ok: false,
      }));

      const stale = fixture.store.submit(first, {
        ...submission(envelope),
        observedProjectionHash: "c".repeat(64),
      }, "2026-07-24T12:00:00.300Z");
      expect(stale.status).toBe("stale");
      fixture.store.revokeCredential(
        first.credentialId,
        "2026-07-24T12:00:00.400Z",
      );
      expect(() => fixture.store.authenticate(
        firstIssued.token,
        "2026-07-24T12:00:00.500Z",
      )).toThrow(/invalid or revoked/);
    } finally {
      fixture.db.close();
    }
  });
});
