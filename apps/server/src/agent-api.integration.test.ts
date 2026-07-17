import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  agentDecisionListResponseSchema,
  agentListResponseSchema,
  agentProfileResponseSchema,
  createSimulationResponseSchema,
  decisionSchema,
  relationshipListResponseSchema,
} from "@worldtangle/shared";
import { buildAgentDecisionPrompt, checkInvariants } from "@worldtangle/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteAgentStore,
  SqliteSnapshotStore,
} from "./persistence";
import { readRunInvariantSnapshot } from "./testing/run-invariant-probe";

const temporaryDirectories: string[] = [];
const applications: FastifyInstance[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-agent-api-"));
  temporaryDirectories.push(path);
  return path;
}

function createApp(dataDir: string): FastifyInstance {
  const app = buildApp({
    dataDir,
    wallClock: () => "2026-07-15T12:00:00.000Z",
    tickIntervalMs: 60_000,
    snapshotIntervalTicks: 1,
  });
  applications.push(app);
  return app;
}

afterEach(async () => {
  while (applications.length > 0) await applications.pop()!.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const createBody = {
  name: "phase-2-riverbend",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock" as const,
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: {},
    endTick: 120,
  },
};

describe("Phase 2 agent API", () => {
  it("serves deterministic directory, profile, relationship, and decision reads across reopen", async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(dataDir);
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: createBody,
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createSimulationResponseSchema.parse(createResponse.json());
    const simulationId = created.simulation.id;
    const runId = created.run.id;

    const collected = [];
    let cursor: string | null = null;
    do {
      const response = await app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/agents?runId=${runId}&limit=17` +
          (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`),
      });
      expect(response.statusCode).toBe(200);
      const page = agentListResponseSchema.parse(response.json());
      collected.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(collected).toHaveLength(100);
    expect(new Set(collected.map((agent) => agent.id)).size).toBe(100);
    expect(collected.map((agent) => agent.id)).toEqual(
      [...collected.map((agent) => agent.id)].sort(),
    );

    const first = collected[0]!;
    const searchResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/agents?runId=${runId}` +
        `&search=${encodeURIComponent(first.name)}`,
    });
    const search = agentListResponseSchema.parse(searchResponse.json());
    expect(search.items.map((agent) => agent.id)).toContain(first.id);

    const profileResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents/${first.id}?runId=${runId}`,
    });
    expect(profileResponse.statusCode).toBe(200);
    const profile = agentProfileResponseSchema.parse(profileResponse.json());
    expect(profile.agent.goals.length).toBeGreaterThan(0);
    expect(profile.agent.memoryHighlights).toHaveLength(1);
    const initialMemoryId = profile.agent.memoryHighlights[0]!.id;

    const relationshipResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/agents/${first.id}/relationships` +
        `?runId=${runId}&limit=2`,
    });
    expect(relationshipResponse.statusCode).toBe(200);
    relationshipListResponseSchema.parse(relationshipResponse.json());

    const emptyDecisionResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/agents/${first.id}/decisions` +
        `?runId=${runId}`,
    });
    expect(agentDecisionListResponseSchema.parse(emptyDecisionResponse.json()).items).toEqual([]);

    const promptDb = openWorldDatabase(dataDir, simulationId, runId);
    let promptHash: string;
    try {
      const promptStore = new SqliteAgentStore(promptDb, runId);
      const persistedProfile = promptStore.getProfile(first.id);
      const activeGoal = persistedProfile.goals.find((goal) => goal.status === "active")!;
      const sourceEventId = persistedProfile.memoryHighlights[0]!.references[0]!;
      const promptOptions = [{
        actionId: "wait",
        actionType: "agent.noop",
        params: { reason: "preserve_buffer" },
        utility: 1,
      }] as const;
      const builtPrompt = buildAgentDecisionPrompt({
        persona: persistedProfile.persona,
        purpose: "decision.tier2.goal",
        correlationId: "dec_zzzzzzzz",
        budgetTag: `${runId}:agent_decisions`,
        tick: 1,
        simDate: "Y0001-M01-D02",
        trigger: {
          kind: "goal",
          agentId: first.id,
          sourceEventId,
          tick: 1,
          priority: activeGoal.priority * 20,
          payload: { goalId: activeGoal.id, goalKind: activeGoal.kind },
        },
        trustedState: {
          employmentStatus: persistedProfile.agent.employmentStatus,
          occupationCode: persistedProfile.agent.occupationCode,
          activeGoalIds: [activeGoal.id],
        },
        untrustedItems: persistedProfile.memoryHighlights.map((memory) => ({
          source: "memory" as const,
          id: memory.id,
          content: memory.content,
          references: memory.references,
        })),
        options: promptOptions,
      });
      promptHash = builtPrompt.promptHash;
      promptStore.saveDecisionResult([decisionSchema.parse({
        id: "dec_zzzzzzzz",
        runId,
        agentId: first.id,
        tick: 1,
        trigger: { kind: "goal", sourceEventId, priority: activeGoal.priority * 20 },
        tier: 2,
        observationDigest: builtPrompt.observationDigest,
        optionsOffered: promptOptions,
        chosenActionId: "wait",
        params: { reason: "preserve_buffer" },
        rationale: "Stored WS-604 prompt inspection fixture.",
        llmCallId: "llm_zzzzzzzz",
        validationResult: { status: "approved" },
        promptPackKey: builtPrompt.promptPackKey,
        promptVersion: builtPrompt.promptPackVersion,
        promptHash: builtPrompt.promptHash,
      })], []);
    } finally {
      promptDb.close();
    }

    for (const control of ["start", "pause"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/${control}`,
        payload: { runId },
      });
      expect(response.statusCode).toBe(202);
    }
    const advanceResponse = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/advance`,
      payload: { runId, ticks: 1 },
    });
    expect(advanceResponse.statusCode, advanceResponse.body).toBe(200);

    const decisionResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/agents/${first.id}/decisions` +
        `?runId=${runId}`,
    });
    expect(decisionResponse.statusCode).toBe(200);
    const decisions = agentDecisionListResponseSchema.parse(decisionResponse.json());
    expect(decisions.items.length).toBeGreaterThan(0);
    expect(decisions.items.some((decision) => decision.observation.summary.includes(initialMemoryId)))
      .toBe(true);
    expect(decisions.items.find((decision) => decision.id === "dec_zzzzzzzz")?.llm).toEqual({
      callId: "llm_zzzzzzzz",
      promptPackKey: "agent.decision",
      promptVersion: 1,
      promptHash,
    });

    const updatedProfile = agentProfileResponseSchema.parse((await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents/${first.id}?runId=${runId}`,
    })).json());
    expect(updatedProfile.agent.memoryHighlights.some((memory) => memory.kind === "outcome"))
      .toBe(true);

    const db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      const report = checkInvariants(readRunInvariantSnapshot(db, runId));
      expect(report.passed, JSON.stringify(report.violations)).toBe(true);
      expect(report.active).toEqual([
        "INV-1",
        "INV-2",
        "INV-3",
        "INV-4",
        "INV-5",
        "INV-6",
        "INV-8",
        "INV-9",
        "INV-10",
      ]);
      expect(report.inactive).toEqual([
        "INV-7",
      ]);

      const snapshotStore = new SqliteSnapshotStore(
        db,
        dataDir,
        simulationId,
        runId,
      );
      const snapshot = snapshotStore.list()[0]!;
      expect(snapshot.tick).toBe(1);
      expect(snapshotStore.stateHash()).toBe(snapshot.stateHash);
      const restoredPath = snapshotStore.restoreTo(
        snapshot.id,
        join(dataDir, simulationId, runId, "restored-phase2.db"),
      );
      const restored = openDatabaseFile(restoredPath);
      try {
        expect(computeLogicalStateHash(restored, runId)).toBe(snapshot.stateHash);
        for (const table of ["agents", "goals", "memories", "decisions", "agent_actions"]) {
          const liveCount = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: bigint;
          };
          const restoredCount = restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: bigint;
          };
          expect(restoredCount.count, table).toBe(liveCount.count);
        }
        restored.prepare(`
          UPDATE agents SET credit_score = credit_score + 1
          WHERE run_id = ? AND id = ? AND credit_score < 850
        `).run(runId, first.id);
        expect(computeLogicalStateHash(restored, runId)).not.toBe(snapshot.stateHash);
      } finally {
        restored.close();
      }
    } finally {
      db.close();
    }

    await app.close();
    applications.splice(applications.indexOf(app), 1);
    const reopened = createApp(dataDir);
    const reopenedDecisions = agentDecisionListResponseSchema.parse((await reopened.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/agents/${first.id}/decisions` +
        `?runId=${runId}`,
    })).json());
    expect(reopenedDecisions.items).toEqual(decisions.items);

    const malformedCursor = await reopened.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents?cursor=not-a-cursor`,
    });
    expect(malformedCursor.statusCode).toBe(400);
    const missingAgent = await reopened.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents/agt_zzzzzzzz`,
    });
    expect(missingAgent.statusCode).toBe(404);
  });

  it("produces the same Phase 2 state hash for equal seeds across distinct run IDs", async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(dataDir);
    const runs = [];
    for (const name of ["same-seed-a", "same-seed-b"]) {
      const created = createSimulationResponseSchema.parse((await app.inject({
        method: "POST",
        url: "/api/v1/simulations",
        payload: { ...createBody, name },
      })).json());
      for (const control of ["start", "pause"] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/simulations/${created.simulation.id}/${control}`,
          payload: { runId: created.run.id },
        });
        expect(response.statusCode).toBe(202);
      }
      const advanced = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${created.simulation.id}/advance`,
        payload: { runId: created.run.id, ticks: 1 },
      });
      expect(advanced.statusCode, advanced.body).toBe(200);
      runs.push({ simulationId: created.simulation.id, runId: created.run.id });
    }

    const hashes = runs.map(({ simulationId, runId }) => {
      const db = openWorldDatabase(dataDir, simulationId, runId);
      try {
        return computeLogicalStateHash(db, runId);
      } finally {
        db.close();
      }
    });
    expect(hashes[1]).toBe(hashes[0]);
  });
});
