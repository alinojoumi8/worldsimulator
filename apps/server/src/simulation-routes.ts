/** Simulation lifecycle, event, and agent HTTP routes (API_CONTRACTS.md). */

import type { FastifyInstance } from "fastify";
import {
  agentDecisionListQuerySchema,
  agentListQuerySchema,
  agentPathSchema,
  advanceSimulationRequestSchema,
  bankPathSchema,
  companyListQuerySchema,
  companyPathSchema,
  contractListQuerySchema,
  contractPathSchema,
  conversationListQuerySchema,
  conversationPathSchema,
  createExportRequestSchema,
  createSimulationRequestSchema,
  EngineError,
  eventListQuerySchema,
  errorListQuerySchema,
  exportPathSchema,
  indicatorSeriesQuerySchema,
  injectWorldEventRequestSchema,
  institutionListQuerySchema,
  institutionPathSchema,
  investmentCapTablePathSchema,
  investmentDistributionListQuerySchema,
  investmentDistributionPathSchema,
  investmentListQuerySchema,
  investmentPathSchema,
  investmentProposalListQuerySchema,
  investmentProposalPathSchema,
  investmentRunQuerySchema,
  jobListQuerySchema,
  jobPathSchema,
  loanListQuerySchema,
  loanPathSchema,
  llmControlRequestSchema,
  llmCallListQuerySchema,
  newsListQuerySchema,
  newsStoryPathSchema,
  phase4RunQuerySchema,
  replayPathSchema,
  replayRequestSchema,
  relationshipListQuerySchema,
  runSelectionRequestSchema,
  simulationListQuerySchema,
  simulationPathSchema,
  transactionListQuerySchema,
  type AdvanceSimulationRequest,
  type AgentDecisionListQuery,
  type AgentListQuery,
  type CreateSimulationRequest,
  type CompanyListQuery,
  type ContractListQuery,
  type ConversationListQuery,
  type CreateExportRequest,
  type ErrorListQuery,
  type EventListQuery,
  type IndicatorSeriesQuery,
  type InjectWorldEventRequest,
  type InstitutionListQuery,
  type InvestmentDistributionListQuery,
  type InvestmentListQuery,
  type InvestmentProposalListQuery,
  type JobListQuery,
  type LoanListQuery,
  type LlmControlRequest,
  type LlmCallListQuery,
  type NewsListQuery,
  type RelationshipListQuery,
  type ReplayRequest,
  type RunSelectionRequest,
  type SimulationListQuery,
  type TransactionListQuery,
} from "@worldtangle/shared";

type MaybePromise<T> = T | Promise<T>;
type ApiBody = Readonly<Record<string, unknown>>;

export type SimulationControl = "start" | "pause" | "resume" | "stop";

export interface SimulationApi {
  close?(): MaybePromise<void>;
  engineState?(): "idle" | "running";
  createSimulation(
    input: CreateSimulationRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  listSimulations(query: SimulationListQuery): MaybePromise<ApiBody>;
  getSimulation(simulationId: string): MaybePromise<ApiBody>;
  controlSimulation(
    simulationId: string,
    control: SimulationControl,
    input: RunSelectionRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  setLlmControl(
    simulationId: string,
    input: LlmControlRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  advanceSimulation(
    simulationId: string,
    input: AdvanceSimulationRequest,
    requestId: string,
  ): MaybePromise<{ statusCode: 200 | 202; body: ApiBody }>;
  replaySimulation(
    simulationId: string,
    sourceRunId: string,
    input: ReplayRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  createExport(
    simulationId: string,
    input: CreateExportRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  getExport(exportId: string): MaybePromise<ApiBody>;
  injectWorldEvent(
    simulationId: string,
    input: InjectWorldEventRequest,
    requestId: string,
  ): MaybePromise<ApiBody>;
  getStatus(simulationId: string, runId?: string): MaybePromise<ApiBody>;
  listEvents(simulationId: string, query: EventListQuery): MaybePromise<ApiBody>;
  listNews(simulationId: string, query: NewsListQuery): MaybePromise<ApiBody>;
  getNewsStory(
    simulationId: string,
    storyId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  listLlmCalls(simulationId: string, query: LlmCallListQuery): MaybePromise<ApiBody>;
  listErrors(simulationId: string, query: ErrorListQuery): MaybePromise<ApiBody>;
  listConversations(simulationId: string, query: ConversationListQuery): MaybePromise<ApiBody>;
  getConversation(
    simulationId: string,
    conversationId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  listCompanies(simulationId: string, query: CompanyListQuery): MaybePromise<ApiBody>;
  getCompany(simulationId: string, companyId: string, runId?: string): MaybePromise<ApiBody>;
  listInvestmentProposals(
    simulationId: string,
    query: InvestmentProposalListQuery,
  ): MaybePromise<ApiBody>;
  getInvestmentProposal(
    simulationId: string,
    proposalId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  listInvestments(simulationId: string, query: InvestmentListQuery): MaybePromise<ApiBody>;
  getInvestment(
    simulationId: string,
    investmentId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  getInvestmentCapTable(
    simulationId: string,
    companyId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  listInvestmentDistributions(
    simulationId: string,
    query: InvestmentDistributionListQuery,
  ): MaybePromise<ApiBody>;
  getInvestmentDistribution(
    simulationId: string,
    distributionId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  listContracts(simulationId: string, query: ContractListQuery): MaybePromise<ApiBody>;
  getContract(simulationId: string, contractId: string, runId?: string): MaybePromise<ApiBody>;
  listJobs(simulationId: string, query: JobListQuery): MaybePromise<ApiBody>;
  getJob(simulationId: string, jobId: string, runId?: string): MaybePromise<ApiBody>;
  listInstitutions(simulationId: string, query: InstitutionListQuery): MaybePromise<ApiBody>;
  getInstitution(
    simulationId: string,
    institutionId: string,
    runId?: string,
  ): MaybePromise<ApiBody>;
  getGoodsMarket(simulationId: string, runId?: string): MaybePromise<ApiBody>;
  listAgents(simulationId: string, query: AgentListQuery): MaybePromise<ApiBody>;
  getAgent(simulationId: string, agentId: string, runId?: string): MaybePromise<ApiBody>;
  getAgentFinances(simulationId: string, agentId: string, runId?: string): MaybePromise<ApiBody>;
  listAgentRelationships(
    simulationId: string,
    agentId: string,
    query: RelationshipListQuery,
  ): MaybePromise<ApiBody>;
  listAgentDecisions(
    simulationId: string,
    agentId: string,
    query: AgentDecisionListQuery,
  ): MaybePromise<ApiBody>;
  listBanks(simulationId: string, runId?: string): MaybePromise<ApiBody>;
  getBank(simulationId: string, bankId: string, runId?: string): MaybePromise<ApiBody>;
  listLoans(simulationId: string, query: LoanListQuery): MaybePromise<ApiBody>;
  getLoan(simulationId: string, loanId: string, runId?: string): MaybePromise<ApiBody>;
  listIndicators(simulationId: string, query: IndicatorSeriesQuery): MaybePromise<ApiBody>;
  listTransactions(simulationId: string, query: TransactionListQuery): MaybePromise<ApiBody>;
}

interface Schema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<unknown> } };
}

const META = { simulated: true, apiVersion: 1 } as const;

function validate<T>(schema: Schema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError("VALIDATION_FAILED", "Request validation failed", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function withMeta(body: ApiBody): ApiBody & { meta: typeof META } {
  return { ...body, meta: META };
}

/** Register the v1 lifecycle, event-explorer, and agent-read surface. */
export function registerSimulationRoutes(
  app: FastifyInstance,
  service: SimulationApi,
): void {
  app.post("/api/v1/simulations", async (request, reply) => {
    const input = validate(createSimulationRequestSchema, request.body);
    const body = await service.createSimulation(input, request.id);
    return reply.code(201).send(withMeta(body));
  });

  app.get("/api/v1/simulations", async (request, reply) => {
    const query = validate(simulationListQuerySchema, request.query);
    const body = await service.listSimulations(query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const body = await service.getSimulation(simId);
    return reply.code(200).send(withMeta(body));
  });

  for (const control of ["start", "pause", "resume", "stop"] as const) {
    app.post(`/api/v1/simulations/:simId/${control}`, async (request, reply) => {
      const { simId } = validate(simulationPathSchema, request.params);
      const input = validate(runSelectionRequestSchema, request.body ?? {});
      const body = await service.controlSimulation(simId, control, input, request.id);
      return reply.code(202).send(withMeta(body));
    });
  }

  app.post("/api/v1/simulations/:simId/admin/llm-controls", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const input = validate(llmControlRequestSchema, request.body);
    const body = await service.setLlmControl(simId, input, request.id);
    return reply.code(202).send(withMeta(body));
  });

  app.post("/api/v1/simulations/:simId/advance", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const input = validate(advanceSimulationRequestSchema, request.body);
    const result = await service.advanceSimulation(simId, input, request.id);
    return reply.code(result.statusCode).send(withMeta(result.body));
  });

  app.post("/api/v1/simulations/:simId/runs/:runId/replay", async (request, reply) => {
    const { simId, runId } = validate(replayPathSchema, request.params);
    const input = validate(replayRequestSchema, request.body ?? {});
    const body = await service.replaySimulation(simId, runId, input, request.id);
    return reply.code(202).send(withMeta(body));
  });

  app.post("/api/v1/simulations/:simId/exports", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const input = validate(createExportRequestSchema, request.body);
    const body = await service.createExport(simId, input, request.id);
    return reply.code(202).send(withMeta(body));
  });

  app.get("/api/v1/exports/:exportId", async (request, reply) => {
    const { exportId } = validate(exportPathSchema, request.params);
    const body = await service.getExport(exportId);
    return reply.code(200).send(withMeta(body));
  });

  app.post("/api/v1/simulations/:simId/world-events", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const input = validate(injectWorldEventRequestSchema, request.body);
    const body = await service.injectWorldEvent(simId, input, request.id);
    return reply.code(202).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/status", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.getStatus(simId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/events", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(eventListQuerySchema, request.query);
    const body = await service.listEvents(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/news", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(newsListQuerySchema, request.query);
    const body = await service.listNews(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/news/:storyId", async (request, reply) => {
    const { simId, storyId } = validate(newsStoryPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.getNewsStory(simId, storyId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/llm-calls", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(llmCallListQuerySchema, request.query);
    const body = await service.listLlmCalls(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/errors", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(errorListQuerySchema, request.query);
    const body = await service.listErrors(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/conversations", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(conversationListQuerySchema, request.query);
    const body = await service.listConversations(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/conversations/:conversationId",
    async (request, reply) => {
      const { simId, conversationId } = validate(conversationPathSchema, request.params);
      const { runId } = validate(runSelectionRequestSchema, request.query);
      const body = await service.getConversation(simId, conversationId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/companies", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(companyListQuerySchema, request.query);
    const body = await service.listCompanies(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/companies/:companyId", async (request, reply) => {
    const { simId, companyId } = validate(companyPathSchema, request.params);
    const { runId } = validate(phase4RunQuerySchema, request.query);
    const body = await service.getCompany(simId, companyId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/companies/:companyId/cap-table",
    async (request, reply) => {
      const { simId, companyId } = validate(investmentCapTablePathSchema, request.params);
      const { runId } = validate(investmentRunQuerySchema, request.query);
      const body = await service.getInvestmentCapTable(simId, companyId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/investment-proposals", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(investmentProposalListQuerySchema, request.query);
    const body = await service.listInvestmentProposals(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/investment-proposals/:proposalId",
    async (request, reply) => {
      const { simId, proposalId } = validate(investmentProposalPathSchema, request.params);
      const { runId } = validate(investmentRunQuerySchema, request.query);
      const body = await service.getInvestmentProposal(simId, proposalId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/investments", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(investmentListQuerySchema, request.query);
    const body = await service.listInvestments(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/investments/:investmentId",
    async (request, reply) => {
      const { simId, investmentId } = validate(investmentPathSchema, request.params);
      const { runId } = validate(investmentRunQuerySchema, request.query);
      const body = await service.getInvestment(simId, investmentId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get(
    "/api/v1/simulations/:simId/investment-distributions",
    async (request, reply) => {
      const { simId } = validate(simulationPathSchema, request.params);
      const query = validate(investmentDistributionListQuerySchema, request.query);
      const body = await service.listInvestmentDistributions(simId, query);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get(
    "/api/v1/simulations/:simId/investment-distributions/:distributionId",
    async (request, reply) => {
      const { simId, distributionId } = validate(
        investmentDistributionPathSchema,
        request.params,
      );
      const { runId } = validate(investmentRunQuerySchema, request.query);
      const body = await service.getInvestmentDistribution(
        simId,
        distributionId,
        runId,
      );
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/contracts", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(contractListQuerySchema, request.query);
    const body = await service.listContracts(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/contracts/:contractId", async (request, reply) => {
    const { simId, contractId } = validate(contractPathSchema, request.params);
    const { runId } = validate(phase4RunQuerySchema, request.query);
    const body = await service.getContract(simId, contractId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/jobs", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(jobListQuerySchema, request.query);
    const body = await service.listJobs(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/jobs/:jobId", async (request, reply) => {
    const { simId, jobId } = validate(jobPathSchema, request.params);
    const { runId } = validate(phase4RunQuerySchema, request.query);
    const body = await service.getJob(simId, jobId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/institutions", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(institutionListQuerySchema, request.query);
    const body = await service.listInstitutions(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/institutions/:institutionId",
    async (request, reply) => {
      const { simId, institutionId } = validate(institutionPathSchema, request.params);
      const { runId } = validate(phase4RunQuerySchema, request.query);
      const body = await service.getInstitution(simId, institutionId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/markets/goods", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const { runId } = validate(phase4RunQuerySchema, request.query);
    const body = await service.getGoodsMarket(simId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/agents", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(agentListQuerySchema, request.query);
    const body = await service.listAgents(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/agents/:agentId", async (request, reply) => {
    const { simId, agentId } = validate(agentPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.getAgent(simId, agentId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get(
    "/api/v1/simulations/:simId/agents/:agentId/finances",
    async (request, reply) => {
      const { simId, agentId } = validate(agentPathSchema, request.params);
      const { runId } = validate(runSelectionRequestSchema, request.query);
      const body = await service.getAgentFinances(simId, agentId, runId);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get(
    "/api/v1/simulations/:simId/agents/:agentId/relationships",
    async (request, reply) => {
      const { simId, agentId } = validate(agentPathSchema, request.params);
      const query = validate(relationshipListQuerySchema, request.query);
      const body = await service.listAgentRelationships(simId, agentId, query);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get(
    "/api/v1/simulations/:simId/agents/:agentId/decisions",
    async (request, reply) => {
      const { simId, agentId } = validate(agentPathSchema, request.params);
      const query = validate(agentDecisionListQuerySchema, request.query);
      const body = await service.listAgentDecisions(simId, agentId, query);
      return reply.code(200).send(withMeta(body));
    },
  );

  app.get("/api/v1/simulations/:simId/banks", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.listBanks(simId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/banks/:bankId", async (request, reply) => {
    const { simId, bankId } = validate(bankPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.getBank(simId, bankId, runId);
    return reply.code(200).send(withMeta({ bank: body }));
  });

  app.get("/api/v1/simulations/:simId/loans", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(loanListQuerySchema, request.query);
    const body = await service.listLoans(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/loans/:loanId", async (request, reply) => {
    const { simId, loanId } = validate(loanPathSchema, request.params);
    const { runId } = validate(runSelectionRequestSchema, request.query);
    const body = await service.getLoan(simId, loanId, runId);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/indicators", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(indicatorSeriesQuerySchema, request.query);
    const body = await service.listIndicators(simId, query);
    return reply.code(200).send(withMeta(body));
  });

  app.get("/api/v1/simulations/:simId/transactions", async (request, reply) => {
    const { simId } = validate(simulationPathSchema, request.params);
    const query = validate(transactionListQuerySchema, request.query);
    const body = await service.listTransactions(simId, query);
    return reply.code(200).send(withMeta(body));
  });
}
