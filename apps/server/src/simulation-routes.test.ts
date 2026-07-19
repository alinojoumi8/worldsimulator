import Fastify from "fastify";
import { EngineError } from "@worldtangle/shared";
import { describe, expect, it, vi } from "vitest";
import {
  registerSimulationRoutes,
  type SimulationApi,
} from "./simulation-routes";

const simulationId = "sim_00000001";
const runId = "run_00000001";
const agentId = "agt_00000001";

function createService(): SimulationApi {
  return {
    createSimulation: vi.fn(() => ({ simulation: { id: simulationId } })),
    listSimulations: vi.fn(() => ({ items: [], nextCursor: null })),
    getSimulation: vi.fn(() => ({ simulation: { id: simulationId }, runs: [] })),
    controlSimulation: vi.fn((_simId, control) => ({
      run: { id: runId, status: control },
      commandEventId: "evt_00000001",
    })),
    setLlmControl: vi.fn(() => ({
      commandEventId: "evt_00000001",
      eventId: "evt_00000002",
      controls: { enabled: false },
    })),
    advanceSimulation: vi.fn(() => ({
      statusCode: 202 as const,
      body: { taskId: "task_00000001", poll: `/simulations/${simulationId}/status` },
    })),
    replaySimulation: vi.fn(() => ({
      replayRun: { id: "run_00000002", replayOf: runId, status: "running" },
    })),
    createExport: vi.fn(() => ({
      export: { id: "xpt_0000000100000001", status: "queued" },
    })),
    getExport: vi.fn(() => ({
      export: { id: "xpt_0000000100000001", status: "completed" },
    })),
    injectWorldEvent: vi.fn(() => ({
      worldEvent: {
        id: "wev_00000001",
        status: "scheduled",
        scheduledTick: 10,
      },
      commandEventId: "evt_00000001",
    })),
    getStatus: vi.fn(() => ({ run: { id: runId, status: "paused" } })),
    listEvents: vi.fn(() => ({ items: [], nextCursor: null })),
    listNews: vi.fn(() => ({ items: [], nextCursor: null, sentiment: [] })),
    getNewsStory: vi.fn(() => ({ story: { id: "nws_00000001" } })),
    listLlmCalls: vi.fn(() => ({ items: [], nextCursor: null, totals: {} })),
    listErrors: vi.fn(() => ({ items: [], nextCursor: null, summary: {} })),
    listConversations: vi.fn(() => ({ items: [], nextCursor: null })),
    getConversation: vi.fn(() => ({ conversation: { id: "cnv_00000001" } })),
    listCompanies: vi.fn(() => ({ items: [], nextCursor: null })),
    getCompany: vi.fn(() => ({ company: { id: "co_00000001" } })),
    listInvestmentProposals: vi.fn(() => ({ items: [], nextCursor: null })),
    getInvestmentProposal: vi.fn(() => ({ proposal: { id: "prop_00000001" } })),
    listInvestments: vi.fn(() => ({ items: [], nextCursor: null })),
    getInvestment: vi.fn(() => ({ investment: { id: "inv_00000001" } })),
    getInvestmentCapTable: vi.fn(() => ({ capTable: { company: { id: "co_00000001" } } })),
    listInvestmentDistributions: vi.fn(() => ({ items: [], nextCursor: null })),
    getInvestmentDistribution: vi.fn(() => ({ distribution: { id: "dist_00000001" } })),
    listContracts: vi.fn(() => ({ items: [], nextCursor: null })),
    getContract: vi.fn(() => ({ contract: { id: "ctr_00000001" } })),
    listJobs: vi.fn(() => ({ items: [], nextCursor: null })),
    getJob: vi.fn(() => ({ job: { id: "job_00000001" } })),
    listInstitutions: vi.fn(() => ({ items: [], nextCursor: null })),
    getInstitution: vi.fn(() => ({ institution: { id: "inst_town_riverbend" } })),
    getGoodsMarket: vi.fn(() => ({ market: { id: "goods_riverbend" } })),
    listAgents: vi.fn(() => ({ items: [], nextCursor: null })),
    getAgent: vi.fn(() => ({ agent: { id: "agt_00000001" } })),
    getAgentFinances: vi.fn(() => ({ employment: null, accounts: [] })),
    listAgentRelationships: vi.fn(() => ({ items: [], nextCursor: null })),
    listAgentDecisions: vi.fn(() => ({ items: [], nextCursor: null })),
    listBanks: vi.fn(() => ({ items: [], nextCursor: null })),
    getBank: vi.fn(() => ({ id: "bank_00000001", name: "First Ledger Bank" })),
    listLoans: vi.fn(() => ({ items: [], nextCursor: null })),
    getLoan: vi.fn(() => ({ loan: { id: "loan_00000001" }, schedule: [], why: {} })),
    listIndicators: vi.fn(() => ({ series: [] })),
    listTransactions: vi.fn(() => ({ items: [], nextCursor: null })),
  };
}

function createApp(service: SimulationApi) {
  const app = Fastify({ logger: false });
  registerSimulationRoutes(app, service);
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof EngineError) {
      return reply.code(400).send({ code: error.code, details: error.details });
    }
    return reply.send(error);
  });
  return app;
}

const createBody = {
  name: "baseline-riverbend",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
    policyOverrides: { income_tax_rate_bp: 1_800 },
    endTick: 360,
  },
};

describe("simulation routes", () => {
  it("validates creation, passes its request ID, and adds response metadata", async () => {
    const service = createService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: createBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      simulation: { id: simulationId },
      meta: { simulated: true, apiVersion: 1 },
    });
    expect(service.createSimulation).toHaveBeenCalledWith(createBody, expect.any(String));
    await app.close();
  });

  it("validates and routes Phase 3 bank, ledger, indicator, and finance reads", async () => {
    const service = createService();
    const app = createApp(service);
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/banks?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/transactions?runId=${runId}&kind=payroll&limit=25&fromTick=15`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=m1,unemploymentRate&step=5`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/agents/${agentId}/finances?runId=${runId}`,
      }),
    ]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listBanks).toHaveBeenCalledWith(simulationId, runId);
    expect(service.listTransactions).toHaveBeenCalledWith(simulationId, expect.objectContaining({
      runId,
      kind: "payroll",
      limit: 25,
      fromTick: 15,
    }));
    expect(service.listIndicators).toHaveBeenCalledWith(simulationId, expect.objectContaining({
      runId,
      series: ["m1", "unemploymentRate"],
      step: 5,
    }));
    expect(service.getAgentFinances).toHaveBeenCalledWith(simulationId, agentId, runId);
    await app.close();
  });

  it("validates and dispatches every WS-409 world-explorer read", async () => {
    const service = createService();
    const app = createApp(service);
    const companyId = "co_00000001";
    const contractId = "ctr_00000001";
    const jobId = "job_00000001";
    const institutionId = "inst_town_riverbend";
    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/companies?runId=${runId}&status=active&limit=10` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/companies/${companyId}?runId=${runId}` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/contracts?runId=${runId}&type=employment` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/contracts/${contractId}?runId=${runId}` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/jobs?runId=${runId}&status=open` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/jobs/${jobId}?runId=${runId}` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/institutions?runId=${runId}&kind=government` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/institutions/${institutionId}?runId=${runId}` }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}/markets/goods?runId=${runId}` }),
    ]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listCompanies).toHaveBeenCalledWith(simulationId, {
      runId,
      status: "active",
      limit: 10,
    });
    expect(service.getCompany).toHaveBeenCalledWith(simulationId, companyId, runId);
    expect(service.listContracts).toHaveBeenCalledWith(
      simulationId,
      expect.objectContaining({ runId, type: "employment", limit: 50 }),
    );
    expect(service.getContract).toHaveBeenCalledWith(simulationId, contractId, runId);
    expect(service.listJobs).toHaveBeenCalledWith(
      simulationId,
      expect.objectContaining({ runId, status: "open", limit: 50 }),
    );
    expect(service.getJob).toHaveBeenCalledWith(simulationId, jobId, runId);
    expect(service.listInstitutions).toHaveBeenCalledWith(simulationId, {
      runId,
      kind: "government",
    });
    expect(service.getInstitution).toHaveBeenCalledWith(
      simulationId,
      institutionId,
      runId,
    );
    expect(service.getGoodsMarket).toHaveBeenCalledWith(simulationId, runId);
    for (const response of responses) {
      expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });
    }

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/companies/not-a-company`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.getCompany).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("validates and dispatches every WS-805 investment read", async () => {
    const service = createService();
    const app = createApp(service);
    const companyId = "co_00000001";
    const proposalId = "prop_00000001";
    const investmentId = "inv_00000001";
    const fundId = "vfund_00000001";
    const distributionId = "dist_00000001";
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investment-proposals?runId=${runId}&status=completed&companyId=${companyId}&limit=10`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investment-proposals/${proposalId}?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investments?runId=${runId}&companyId=${companyId}&fundId=${fundId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investments/${investmentId}?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/companies/${companyId}/cap-table?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investment-distributions?runId=${runId}&companyId=${companyId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/investment-distributions/${distributionId}?runId=${runId}`,
      }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listInvestmentProposals).toHaveBeenCalledWith(simulationId, {
      runId,
      status: "completed",
      companyId,
      limit: 10,
    });
    expect(service.getInvestmentProposal).toHaveBeenCalledWith(
      simulationId,
      proposalId,
      runId,
    );
    expect(service.listInvestments).toHaveBeenCalledWith(simulationId, {
      runId,
      companyId,
      fundId,
      limit: 50,
    });
    expect(service.getInvestment).toHaveBeenCalledWith(simulationId, investmentId, runId);
    expect(service.getInvestmentCapTable).toHaveBeenCalledWith(simulationId, companyId, runId);
    expect(service.listInvestmentDistributions).toHaveBeenCalledWith(simulationId, {
      runId,
      companyId,
      limit: 50,
    });
    expect(service.getInvestmentDistribution).toHaveBeenCalledWith(
      simulationId,
      distributionId,
      runId,
    );
    for (const response of responses) {
      expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });
    }

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/investments?fundId=agt_00000001`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.listInvestments).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("registers list, detail, status, and filtered event reads", async () => {
    const service = createService();
    const app = createApp(service);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/simulations?limit=2" }),
      app.inject({ method: "GET", url: `/api/v1/simulations/${simulationId}` }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/status?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/events?fromTick=2&toTick=4`,
      }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listSimulations).toHaveBeenCalledWith({ limit: 2 });
    expect(service.getSimulation).toHaveBeenCalledWith(simulationId);
    expect(service.getStatus).toHaveBeenCalledWith(simulationId, runId);
    expect(service.listEvents).toHaveBeenCalledWith(
      simulationId,
      expect.objectContaining({ limit: 50, fromTick: 2, toTick: 4 }),
    );
    for (const response of responses) {
      expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });
    }
    await app.close();
  });

  it("validates and routes the published news and story-detail reads", async () => {
    const service = createService();
    const app = createApp(service);
    const storyId = "nws_00000001";
    const [feed, detail] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/news?runId=${runId}&topic=economy&fromTick=1&limit=10`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/news/${storyId}?runId=${runId}`,
      }),
    ]);
    expect(feed.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(service.listNews).toHaveBeenCalledWith(simulationId, {
      runId,
      topic: "economy",
      fromTick: 1,
      limit: 10,
    });
    expect(service.getNewsStory).toHaveBeenCalledWith(simulationId, storyId, runId);

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/news/not-a-story`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.getNewsStory).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("validates and routes the WS-608 observability surface", async () => {
    const service = createService();
    const app = createApp(service);
    const conversationId = "cnv_00000001";
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/llm-calls?runId=${runId}&status=fallback&limit=25`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/errors?runId=${runId}&kind=schema`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/conversations?runId=${runId}&topic=purchase`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/conversations/${conversationId}?runId=${runId}`,
      }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listLlmCalls).toHaveBeenCalledWith(simulationId, {
      runId,
      status: "fallback",
      limit: 25,
    });
    expect(service.listErrors).toHaveBeenCalledWith(simulationId, {
      runId,
      kind: "schema",
      limit: 50,
    });
    expect(service.listConversations).toHaveBeenCalledWith(simulationId, {
      runId,
      topic: "purchase",
      limit: 50,
    });
    expect(service.getConversation).toHaveBeenCalledWith(
      simulationId,
      conversationId,
      runId,
    );
    for (const response of responses) {
      expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });
    }
    await app.close();
  });

  it("validates and dispatches the Phase 2 agent read surface", async () => {
    const service = createService();
    const app = createApp(service);
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/agents` +
          `?runId=${runId}&limit=2&employmentStatus=employed&search=Ada`,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/agents/${agentId}?runId=${runId}`,
      }),
      app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/agents/${agentId}/relationships` +
          `?runId=${runId}&type=friend`,
      }),
      app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/agents/${agentId}/decisions` +
          `?runId=${runId}&tier=1&fromTick=1&toTick=31`,
      }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(service.listAgents).toHaveBeenCalledWith(simulationId, {
      runId,
      limit: 2,
      employmentStatus: "employed",
      search: "Ada",
    });
    expect(service.getAgent).toHaveBeenCalledWith(simulationId, agentId, runId);
    expect(service.listAgentRelationships).toHaveBeenCalledWith(
      simulationId,
      agentId,
      { runId, limit: 50, type: "friend" },
    );
    expect(service.listAgentDecisions).toHaveBeenCalledWith(
      simulationId,
      agentId,
      { runId, limit: 50, tier: 1, fromTick: 1, toTick: 31 },
    );
    await app.close();
  });

  it("validates and routes approved world-event injections", async () => {
    const service = createService();
    const app = createApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/world-events`,
      payload: {
        runId,
        type: "energy.fuel_price_shock",
        params: { deltaPct: 30 },
        scheduleTick: 10,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(service.injectWorldEvent).toHaveBeenCalledWith(
      simulationId,
      {
        runId,
        type: "energy.fuel_price_shock",
        params: { deltaPct: 30 },
        scheduleTick: 10,
      },
      expect.any(String),
    );
    expect(response.json()).toMatchObject({
      worldEvent: { id: "wev_00000001", status: "scheduled" },
      meta: { simulated: true, apiVersion: 1 },
    });
    await app.close();
  });

  it.each(["start", "pause", "resume", "stop"] as const)(
    "accepts an absent body for %s and journals the request identity",
    async (control) => {
      const service = createService();
      const app = createApp(service);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/${control}`,
      });

      expect(response.statusCode).toBe(202);
      expect(service.controlSimulation).toHaveBeenCalledWith(
        simulationId,
        control,
        {},
        expect.any(String),
      );
      expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });
      await app.close();
    },
  );

  it("uses the advance service status discriminant", async () => {
    const service = createService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/advance`,
      payload: { ticks: 51, runId },
    });

    expect(response.statusCode).toBe(202);
    expect(service.advanceSimulation).toHaveBeenCalledWith(
      simulationId,
      { ticks: 51, runId },
      expect.any(String),
    );
    expect(response.json()).toMatchObject({
      taskId: "task_00000001",
      meta: { simulated: true, apiVersion: 1 },
    });
    await app.close();
  });

  it("validates and dispatches strict or observe replay requests", async () => {
    const service = createService();
    const app = createApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/runs/${runId}/replay`,
      payload: { toTick: 12, mode: "observe" },
    });
    expect(response.statusCode).toBe(202);
    expect(service.replaySimulation).toHaveBeenCalledWith(
      simulationId,
      runId,
      { toTick: 12, mode: "observe" },
      expect.any(String),
    );
    expect(response.json()).toMatchObject({
      replayRun: { id: "run_00000002", replayOf: runId, status: "running" },
      meta: { simulated: true, apiVersion: 1 },
    });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/runs/${runId}/replay`,
      payload: { toTick: -1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.replaySimulation).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("queues checksummed exports and exposes their poll resource", async () => {
    const service = createService();
    const app = createApp(service);
    const exportId = "xpt_0000000100000001";
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/exports`,
      payload: { runId, datasets: ["events", "transactions"], format: "jsonl" },
    });
    expect(queued.statusCode).toBe(202);
    expect(service.createExport).toHaveBeenCalledWith(
      simulationId,
      { runId, datasets: ["events", "transactions"], format: "jsonl" },
      expect.any(String),
    );
    expect(queued.json()).toMatchObject({
      export: { id: exportId, status: "queued" },
      meta: { simulated: true, apiVersion: 1 },
    });

    const polled = await app.inject({ method: "GET", url: `/api/v1/exports/${exportId}` });
    expect(polled.statusCode).toBe(200);
    expect(service.getExport).toHaveBeenCalledWith(exportId);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/exports`,
      payload: { runId, datasets: ["events", "events"], format: "jsonl" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.createExport).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("validates and routes provider-neutral LLM runtime controls", async () => {
    const service = createService();
    const app = createApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/admin/llm-controls`,
      payload: {
        runId,
        command: "set_module_frozen",
        moduleId: "conversations",
        frozen: true,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(service.setLlmControl).toHaveBeenCalledWith(
      simulationId,
      {
        runId,
        command: "set_module_frozen",
        moduleId: "conversations",
        frozen: true,
      },
      expect.any(String),
    );
    expect(response.json()).toMatchObject({ meta: { simulated: true, apiVersion: 1 } });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/admin/llm-controls`,
      payload: {
        command: "set_agent_quarantine",
        agentId,
        quarantined: true,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.setLlmControl).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("converts schema failures to VALIDATION_FAILED EngineErrors", async () => {
    const service = createService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/advance`,
      payload: { ticks: 1_001 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(service.advanceSimulation).not.toHaveBeenCalled();
    await app.close();
  });
});
