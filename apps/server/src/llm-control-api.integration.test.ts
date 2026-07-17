import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { simulationStatusResponseSchema } from "@worldtangle/shared";
import { buildApp } from "./app";

const applications: FastifyInstance[] = [];
const directories: string[] = [];

function appFor(dataDir: string): FastifyInstance {
  const app = buildApp({
    dataDir,
    wallClock: () => "2026-07-15T12:00:00.000Z",
    enableAgentFramework: true,
  });
  applications.push(app);
  return app;
}

function object(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-603 LLM control API", () => {
  it("applies, journals, reverses, and reopens every kill switch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-llm-api-"));
    directories.push(dataDir);
    let app = appFor(dataDir);
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        name: "llm-control-world",
        scenario: {
          worldSpec: "riverbend-100@1",
          seed: 42,
          llmMode: "mock",
          budgets: { runCostCentsMax: "25", perAgentDailyTokens: 500 },
          policyOverrides: {},
          endTick: 30,
        },
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = object(createdResponse.json());
    const simulationId = String(object(created["simulation"])["id"]);
    const runId = String(object(created["run"])["id"]);
    const agentsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/agents?runId=${runId}&limit=1`,
    });
    const agentId = String(object((object(agentsResponse.json())["items"] as unknown[])[0])["id"]);

    const controls = [
      { command: "set_llm_enabled", enabled: false },
      { command: "set_llm_enabled", enabled: true },
      { command: "set_module_frozen", moduleId: "conversations", frozen: true },
      { command: "set_module_frozen", moduleId: "conversations", frozen: false },
      {
        command: "set_agent_quarantine",
        agentId,
        quarantined: true,
        untilTick: 5,
      },
      { command: "set_agent_quarantine", agentId, quarantined: false },
    ];
    for (const control of controls) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/admin/llm-controls`,
        payload: { runId, ...control },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        commandEventId: expect.stringMatching(/^evt_/),
        eventId: expect.stringMatching(/^evt_/),
      });
    }

    const statusResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(simulationStatusResponseSchema.safeParse(statusResponse.json()).success).toBe(true);
    expect(statusResponse.json()).toMatchObject({
      llm: {
        mode: "mock",
        enabled: true,
        effectiveTier: 3,
        autoPaused: false,
        frozenModules: [],
        limits: { runCostCentsMax: "25", perAgentDailyTokens: 500 },
      },
    });

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/events?runId=${runId}&limit=200`,
    });
    const eventTypes = (object(eventsResponse.json())["items"] as Array<Record<string, unknown>>)
      .map((event) => event["type"]);
    expect(eventTypes.filter((type) => type === "admin.command.received")).toHaveLength(6);
    expect(eventTypes).toContain("llm.enabled.changed");
    expect(eventTypes).toContain("llm.module_freeze.changed");
    expect(eventTypes).toContain("agent.quarantine.changed");

    await app.close();
    applications.splice(applications.indexOf(app), 1);
    app = appFor(dataDir);
    const reopenedStatus = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
    });
    expect(reopenedStatus.json()).toMatchObject({
      llm: { enabled: true, effectiveTier: 3, frozenModules: [] },
    });
  });
});
