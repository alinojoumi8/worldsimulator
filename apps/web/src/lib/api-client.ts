import {
  advanceSimulationResponseSchema,
  agentFinancesResponseSchema,
  agentListResponseSchema,
  agentProfileResponseSchema,
  bankDetailResponseSchema,
  bankListResponseSchema,
  companyDetailResponseSchema,
  companyListResponseSchema,
  contractDetailResponseSchema,
  contractListResponseSchema,
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  controlSimulationResponseSchema,
  createSimulationResponseSchema,
  eventListResponseSchema,
  errorListResponseSchema,
  evidencePathResponseSchema,
  goodsMarketResponseSchema,
  indicatorSeriesResponseSchema,
  injectWorldEventResponseSchema,
  institutionDetailResponseSchema,
  institutionListResponseSchema,
  investmentCapTableResponseSchema,
  investmentDetailResponseSchema,
  investmentDistributionDetailResponseSchema,
  investmentDistributionListResponseSchema,
  investmentListResponseSchema,
  investmentProposalDetailResponseSchema,
  investmentProposalListResponseSchema,
  jobDetailResponseSchema,
  jobListResponseSchema,
  loanDetailResponseSchema,
  loanListResponseSchema,
  llmCallListResponseSchema,
  newsListResponseSchema,
  newsStoryDetailResponseSchema,
  replaySimulationResponseSchema,
  simulationDetailResponseSchema,
  simulationListResponseSchema,
  simulationStatusResponseSchema,
  transactionListResponseSchema,
  type AdvanceSimulationResponse,
  type AgentFinancesResponse,
  type AgentListResponse,
  type AgentProfileResponse,
  type BankDetailResponse,
  type BankListResponse,
  type CompanyDetailResponse,
  type CompanyListResponse,
  type ContractDetailResponse,
  type ContractListResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ControlSimulationResponse,
  type CreateSimulationRequest,
  type CreateSimulationResponse,
  type EventListResponse,
  type ErrorListResponse,
  type EvidencePathResponse,
  type GoodsMarketResponse,
  type IndicatorSeriesResponse,
  type InjectWorldEventRequest,
  type InjectWorldEventResponse,
  type InstitutionDetailResponse,
  type InstitutionListResponse,
  type InvestmentCapTableResponse,
  type InvestmentDetailResponse,
  type InvestmentDistributionDetailResponse,
  type InvestmentDistributionListResponse,
  type InvestmentListResponse,
  type InvestmentProposalDetailResponse,
  type InvestmentProposalListResponse,
  type JobDetailResponse,
  type JobListResponse,
  type LoanDetailResponse,
  type LoanListResponse,
  type LlmCallListResponse,
  type NewsListResponse,
  type NewsStoryDetailResponse,
  type NewsTopic,
  type ReplayRequest,
  type ReplaySimulationResponse,
  type SimulationDetailResponse,
  type SimulationListResponse,
  type SimulationStatusResponse,
  type TransactionKind,
  type TransactionListResponse,
} from "@worldtangle/shared";

export interface EventReadFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly type?: string;
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly actorId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface TransactionReadFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly accountId?: string;
  readonly kind?: TransactionKind;
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly correlationId?: string;
}

export interface NewsReadFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly topic?: NewsTopic;
  readonly fromTick?: number;
  readonly toTick?: number;
}

interface Contract<T> {
  parse(value: unknown): T;
}

interface ProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly correlationId?: string;
}

export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.title ?? `Request failed with status ${status}`);
    this.name = "ApiProblemError";
    this.status = status;
    this.code = problem.code ?? "REQUEST_FAILED";
    this.correlationId = problem.correlationId;
  }
}

function object(value: unknown): ProblemDetails {
  return typeof value === "object" && value !== null ? (value as ProblemDetails) : {};
}

async function decodeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Server returned non-JSON data (${response.status})`);
  }
}

export class WorldTangleApi {
  private readonly token: string;

  constructor(token = "") {
    this.token = token.trim();
  }

  private async request<T>(
    path: string,
    contract: Contract<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token.length > 0) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
    const payload = await decodeJson(response);
    if (!response.ok) throw new ApiProblemError(response.status, object(payload));

    try {
      return contract.parse(payload);
    } catch (error) {
      throw new Error(
        `WorldTangle API contract validation failed for ${path}: ${error instanceof Error ? error.message : "unknown schema error"}`,
      );
    }
  }

  listSimulations(signal?: AbortSignal): Promise<SimulationListResponse> {
    return this.request("/api/v1/simulations?limit=100", simulationListResponseSchema, { signal });
  }

  createSimulation(input: CreateSimulationRequest): Promise<CreateSimulationResponse> {
    return this.request("/api/v1/simulations", createSimulationResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getSimulation(simulationId: string, signal?: AbortSignal): Promise<SimulationDetailResponse> {
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}`,
      simulationDetailResponseSchema,
      { signal },
    );
  }

  getStatus(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<SimulationStatusResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/status${query}`,
      simulationStatusResponseSchema,
      { signal },
    );
  }

  listEvents(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
    filters: EventReadFilters = {},
  ): Promise<EventListResponse> {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 40) });
    if (runId !== undefined) params.set("runId", runId);
    if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
    if (filters.type !== undefined) params.set("type", filters.type);
    if (filters.fromTick !== undefined) params.set("fromTick", String(filters.fromTick));
    if (filters.toTick !== undefined) params.set("toTick", String(filters.toTick));
    if (filters.actorId !== undefined) params.set("actorId", filters.actorId);
    if (filters.correlationId !== undefined) {
      params.set("correlationId", filters.correlationId);
    }
    if (filters.causationId !== undefined) params.set("causationId", filters.causationId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/events?${params}`,
      eventListResponseSchema,
      { signal },
    );
  }

  listNews(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
    filters: NewsReadFilters = {},
  ): Promise<NewsListResponse> {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 25) });
    if (runId !== undefined) params.set("runId", runId);
    if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
    if (filters.topic !== undefined) params.set("topic", filters.topic);
    if (filters.fromTick !== undefined) params.set("fromTick", String(filters.fromTick));
    if (filters.toTick !== undefined) params.set("toTick", String(filters.toTick));
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/news?${params}`,
      newsListResponseSchema,
      { signal },
    );
  }

  getNewsStory(
    simulationId: string,
    storyId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<NewsStoryDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/news/${encodeURIComponent(storyId)}${query}`,
      newsStoryDetailResponseSchema,
      { signal },
    );
  }

  listTransactions(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
    filters: TransactionReadFilters = {},
  ): Promise<TransactionListResponse> {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 50) });
    if (runId !== undefined) params.set("runId", runId);
    if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
    if (filters.accountId !== undefined) params.set("accountId", filters.accountId);
    if (filters.kind !== undefined) params.set("kind", filters.kind);
    if (filters.fromTick !== undefined) params.set("fromTick", String(filters.fromTick));
    if (filters.toTick !== undefined) params.set("toTick", String(filters.toTick));
    if (filters.correlationId !== undefined) {
      params.set("correlationId", filters.correlationId);
    }
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/transactions?${params}`,
      transactionListResponseSchema,
      { signal },
    );
  }

  replaySimulation(
    simulationId: string,
    sourceRunId: string,
    input: ReplayRequest,
  ): Promise<ReplaySimulationResponse> {
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/runs/${encodeURIComponent(sourceRunId)}/replay`,
      replaySimulationResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  injectWorldEvent(
    simulationId: string,
    input: InjectWorldEventRequest,
  ): Promise<InjectWorldEventResponse> {
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/world-events`,
      injectWorldEventResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listLlmCalls(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<LlmCallListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/llm-calls?${params}`,
      llmCallListResponseSchema,
      { signal },
    );
  }

  listErrors(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ErrorListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/errors?${params}`,
      errorListResponseSchema,
      { signal },
    );
  }

  listConversations(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/conversations?${params}`,
      conversationListResponseSchema,
      { signal },
    );
  }

  getConversation(
    simulationId: string,
    conversationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/conversations/${encodeURIComponent(conversationId)}${query}`,
      conversationDetailResponseSchema,
      { signal },
    );
  }

  listIndicators(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<IndicatorSeriesResponse> {
    const params = new URLSearchParams({
      series: [
        "gdpProxy",
        "cpi",
        "m1",
        "averageWage",
        "unemploymentRate",
        "creditOutstanding",
        "defaultRate",
        "businessCount",
        "treasuryBalance",
        "sentimentIndex",
      ].join(","),
      max: "5000",
    });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/indicators?${params}`,
      indicatorSeriesResponseSchema,
      { signal },
    );
  }

  listAgents(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<AgentListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/agents?${params}`,
      agentListResponseSchema,
      { signal },
    );
  }

  getAgent(
    simulationId: string,
    agentId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<AgentProfileResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/agents/${encodeURIComponent(agentId)}${query}`,
      agentProfileResponseSchema,
      { signal },
    );
  }

  getAgentFinances(
    simulationId: string,
    agentId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<AgentFinancesResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/agents/${encodeURIComponent(agentId)}/finances${query}`,
      agentFinancesResponseSchema,
      { signal },
    );
  }

  listCompanies(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<CompanyListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/companies?${params}`,
      companyListResponseSchema,
      { signal },
    );
  }

  getCompany(
    simulationId: string,
    companyId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<CompanyDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/companies/${encodeURIComponent(companyId)}${query}`,
      companyDetailResponseSchema,
      { signal },
    );
  }

  listInvestmentProposals(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentProposalListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investment-proposals?${params}`,
      investmentProposalListResponseSchema,
      { signal },
    );
  }

  getInvestmentProposal(
    simulationId: string,
    proposalId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentProposalDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investment-proposals/${encodeURIComponent(proposalId)}${query}`,
      investmentProposalDetailResponseSchema,
      { signal },
    );
  }

  listInvestments(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investments?${params}`,
      investmentListResponseSchema,
      { signal },
    );
  }

  getInvestment(
    simulationId: string,
    investmentId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investments/${encodeURIComponent(investmentId)}${query}`,
      investmentDetailResponseSchema,
      { signal },
    );
  }

  getInvestmentCapTable(
    simulationId: string,
    companyId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentCapTableResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/companies/${encodeURIComponent(companyId)}/cap-table${query}`,
      investmentCapTableResponseSchema,
      { signal },
    );
  }

  listInvestmentDistributions(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentDistributionListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investment-distributions?${params}`,
      investmentDistributionListResponseSchema,
      { signal },
    );
  }

  getInvestmentDistribution(
    simulationId: string,
    distributionId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InvestmentDistributionDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/investment-distributions/${encodeURIComponent(distributionId)}${query}`,
      investmentDistributionDetailResponseSchema,
      { signal },
    );
  }

  getEvidencePath(
    simulationId: string,
    correlationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<EvidencePathResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/evidence-paths/${encodeURIComponent(correlationId)}${query}`,
      evidencePathResponseSchema,
      { signal },
    );
  }

  listContracts(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ContractListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/contracts?${params}`,
      contractListResponseSchema,
      { signal },
    );
  }

  getContract(
    simulationId: string,
    contractId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<ContractDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/contracts/${encodeURIComponent(contractId)}${query}`,
      contractDetailResponseSchema,
      { signal },
    );
  }

  listJobs(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<JobListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/jobs?${params}`,
      jobListResponseSchema,
      { signal },
    );
  }

  getJob(
    simulationId: string,
    jobId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<JobDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/jobs/${encodeURIComponent(jobId)}${query}`,
      jobDetailResponseSchema,
      { signal },
    );
  }

  listInstitutions(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InstitutionListResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/institutions${query}`,
      institutionListResponseSchema,
      { signal },
    );
  }

  getInstitution(
    simulationId: string,
    institutionId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<InstitutionDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/institutions/${encodeURIComponent(institutionId)}${query}`,
      institutionDetailResponseSchema,
      { signal },
    );
  }

  getGoodsMarket(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GoodsMarketResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/markets/goods${query}`,
      goodsMarketResponseSchema,
      { signal },
    );
  }

  listBanks(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<BankListResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/banks${query}`,
      bankListResponseSchema,
      { signal },
    );
  }

  getBank(
    simulationId: string,
    bankId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<BankDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/banks/${encodeURIComponent(bankId)}${query}`,
      bankDetailResponseSchema,
      { signal },
    );
  }

  listLoans(
    simulationId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<LoanListResponse> {
    const params = new URLSearchParams({ limit: "100" });
    if (runId !== undefined) params.set("runId", runId);
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/loans?${params}`,
      loanListResponseSchema,
      { signal },
    );
  }

  getLoan(
    simulationId: string,
    loanId: string,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<LoanDetailResponse> {
    const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/loans/${encodeURIComponent(loanId)}${query}`,
      loanDetailResponseSchema,
      { signal },
    );
  }

  control(
    simulationId: string,
    command: "start" | "pause" | "resume" | "stop",
    runId?: string,
  ): Promise<ControlSimulationResponse> {
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/${command}`,
      controlSimulationResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(runId === undefined ? {} : { runId }),
      },
    );
  }

  advance(simulationId: string, runId?: string): Promise<AdvanceSimulationResponse> {
    return this.request(
      `/api/v1/simulations/${encodeURIComponent(simulationId)}/advance`,
      advanceSimulationResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ ticks: 1, ...(runId === undefined ? {} : { runId }) }),
      },
    );
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiProblemError) {
    return `${error.message}${error.correlationId === undefined ? "" : ` · ${error.correlationId}`}`;
  }
  return error instanceof Error ? error.message : "An unexpected error occurred";
}
