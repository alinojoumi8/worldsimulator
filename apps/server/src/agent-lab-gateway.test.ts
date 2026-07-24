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
import { buildApp } from "./app";
import { openWorldDatabase, SqliteAgentLabStore } from "./persistence";

const roots: string[] = [];
const digest = "d".repeat(64);
const now = "2026-07-24T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worldtangle-agent-lab-api-"));
  roots.push(root);
  const creator = buildApp({ dataDir: root, wallClock: () => now, webRoot: false });
  const created = await creator.inject({
    method: "POST",
    url: "/api/v1/simulations",
    payload: {
      name: "Agent Lab API",
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
          studyId: "gateway",
          trialId: "gateway-shadow",
          experimentManifestDigest: digest,
          mode: "shadow",
          cohortSelection: {
            strategy: "stable_stratified_v1",
            size: 1,
            controller: "shadow",
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
  expect(created.statusCode).toBe(201);
  const body = created.json<{ simulation: { id: string }; run: { id: string } }>();
  await creator.close();
  const db = openWorldDatabase(root, body.simulation.id, body.run.id);
  const store = new SqliteAgentLabStore(db, body.run.id);
  const agentId = store.config().resolvedAssignments[0]!.agentId;
  const issued = store.issueCredential({ agentId, createdWall: now });
  const observation = {
    policyVersion: "partial_observation_v1" as const,
    ownState: { cashCents: "10000" },
    learnedFacts: [],
    deliveredItems: [],
    publicPrices: [],
    citedMemories: [],
  };
  const offeredOptions = [{
    actionId: "goal.defer",
    actionType: "goal.defer",
    params: {},
    utility: 5,
  }];
  const turn: AgentTurnEnvelope = {
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    simulationId: body.simulation.id,
    runId: body.run.id,
    studyId: "gateway",
    trialId: "gateway-shadow",
    turnId: `turn_${"7".repeat(24)}`,
    agentId,
    controller: "shadow",
    opportunityKey: `goal:${agentId}:1`,
    trigger: {
      kind: "goal",
      agentId,
      sourceEventId: "evt_00000001",
      tick: 1,
      priority: 50,
      payload: { goalId: "goal_00000001", goalKind: "stability" },
    },
    completedTick: 0,
    targetTick: 1,
    observation,
    offeredOptions,
    projectionHash: hashValue(observation),
    menuHash: hashValue(offeredOptions),
    cursor: "gateway-turn-1",
    deadline: "2026-07-24T12:00:05.000Z",
    driverPolicyDigest: digest,
    promptDigest: digest,
    toolSchemaDigest: digest,
  };
  store.openTurn(turn, now);
  db.close();
  return {
    root,
    issued,
    turn,
    app: buildApp({
      dataDir: root,
      wallClock: () => now,
      apiToken: "operator-token",
      webRoot: false,
    }),
  };
}

function submission(turn: AgentTurnEnvelope): AgentActionSubmission {
  return {
    turnId: turn.turnId,
    targetTick: turn.targetTick,
    observedProjectionHash: turn.projectionHash,
    observedMenuHash: turn.menuHash,
    idempotencyKey: "gateway-1",
    action: {
      actionId: turn.offeredOptions[0]!.actionId,
      params: {},
      rationale: "Choose the bounded engine-authored defer option.",
    },
    driverPolicyDigest: digest,
  };
}

describe("Agent Lab REST and MCP gateway", () => {
  it("authenticates a trial-bound PAT and exposes the four scoped tools", async () => {
    const test = await fixture();
    try {
      const headers = { authorization: `Bearer ${test.issued.token}` };
      const me = await test.app.inject({
        method: "GET",
        url: "/api/v1/agent-lab/me",
        headers,
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().identity.agentId).toBe(test.turn.agentId);
      expect(me.json().identity).not.toHaveProperty("credentialId");

      const current = await test.app.inject({
        method: "GET",
        url: "/api/v1/agent-lab/turn?waitMs=0",
        headers,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json().turn.turnId).toBe(test.turn.turnId);

      const initialize = await test.app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
      });
      expect(initialize.statusCode).toBe(200);
      expect(initialize.headers["mcp-session-id"]).toBeTruthy();

      const unboundInitialize = await test.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer unbound-agent-lab-token" },
        payload: {
          jsonrpc: "2.0",
          id: 10,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
      });
      expect(unboundInitialize.json().error.data.code).toBe("PERMISSION_DENIED");

      const listed = await test.app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "wt_identity_get",
        "wt_turn_wait",
        "wt_action_submit",
        "wt_receipt_get",
      ]);
    } finally {
      await test.app.close();
    }
  });

  it("accepts an idempotent shadow action and fails closed on unknown fields and non-loopback", async () => {
    const test = await fixture();
    try {
      const headers = { authorization: `Bearer ${test.issued.token}` };
      const invalid = await test.app.inject({
        method: "POST",
        url: "/api/v1/agent-lab/actions",
        headers,
        payload: { ...submission(test.turn), privatePrompt: "blocked" },
      });
      expect(invalid.statusCode).toBe(400);

      const submitted = await test.app.inject({
        method: "POST",
        url: "/api/v1/agent-lab/actions",
        headers,
        payload: submission(test.turn),
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().receipt.status).toBe("shadowed");
      const submissionId = submitted.json().receipt.submissionId as string;
      const receipt = await test.app.inject({
        method: "GET",
        url: `/api/v1/agent-lab/actions/${submissionId}`,
        headers,
      });
      expect(receipt.json().receipt).toEqual(submitted.json().receipt);

      const remote = await test.app.inject({
        method: "GET",
        url: "/api/v1/agent-lab/me",
        headers,
        remoteAddress: "203.0.113.10",
      });
      expect(remote.statusCode).toBe(403);
    } finally {
      await test.app.close();
    }
  });

  it("reserves tool calls before execution and fails closed at the pinned turn budget", async () => {
    const test = await fixture();
    try {
      const headers = { authorization: `Bearer ${test.issued.token}` };
      for (let id = 1; id <= 8; id += 1) {
        const response = await test.app.inject({
          method: "POST",
          url: "/mcp",
          headers,
          payload: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "wt_identity_get", arguments: {} },
          },
        });
        expect(response.json().result).toBeDefined();
      }
      const blocked = await test.app.inject({
        method: "POST",
        url: "/mcp",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "wt_identity_get", arguments: {} },
        },
      });
      expect(blocked.json().error.data.code).toBe("BUDGET_EXHAUSTED");

      const db = openWorldDatabase(test.root, test.turn.simulationId, test.turn.runId);
      try {
        expect(new SqliteAgentLabStore(db, test.turn.runId).artifactRows().toolCalls)
          .toHaveLength(8);
      } finally {
        db.close();
      }
    } finally {
      await test.app.close();
    }
  });
});
