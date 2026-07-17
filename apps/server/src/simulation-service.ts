/** Restart-safe Phase 1 application service for lifecycle, status, and events. */

import { existsSync, renameSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import {
  canonicalStringify,
  createSimulationRequestSchema,
  ENGINE_VERSION,
  EngineError,
  EVENT_SCHEMA_VERSION,
  exportIdSchema,
  hashValue,
  IdFactory,
  injectWorldEventRequestSchema,
  llmControlRequestSchema,
  PROMPT_PACK_VERSION,
  RULESET_VERSION,
  SENTIMENT_TOPICS,
  ventureFirmCreatedPayloadSchema,
  ventureFundCreatedPayloadSchema,
  worldEventSchema,
} from "@worldtangle/shared";
import type {
  ActorRef,
  AdvanceSimulationRequest,
  AgentDecisionListQuery,
  AgentListQuery,
  ConversationListQuery,
  CreateExportRequest,
  ErrorListQuery,
  CreateSimulationRequest,
  EventEnvelope,
  EventListQuery,
  IndicatorKey,
  IndicatorSeriesName,
  IndicatorSeriesQuery,
  InjectWorldEventRequest,
  LlmControlRequest,
  LlmCallListQuery,
  LoanListQuery,
  NewsListQuery,
  CompanyListQuery,
  ContractListQuery,
  InstitutionListQuery,
  JobListQuery,
  RelationshipListQuery,
  ReplayRequest,
  RunManifest,
  RunSelectionRequest,
  Simulation,
  SimulationListQuery,
  SimulationRun,
  TransactionListQuery,
  WorldEventSpec,
} from "@worldtangle/shared";
import {
  ANTHROPIC_DEFAULT_MODELS,
  AnthropicFetchTransport,
  AnthropicLlmProvider,
  assertCanAdvance,
  BudgetedLlmProvider,
  CachedLlmProvider,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES,
  DeterministicMemoryStore,
  ECONOMIC_INDICATOR_RULESET_VERSION,
  EventBus,
  generateRiverbendPopulation,
  llmRequestHash,
  KIMI_CODE_API_ENDPOINT,
  KIMI_K2_6_MODEL,
  KIMI_OPEN_PLATFORM_API_ENDPOINT,
  KIMI_SUPPORTED_MODELS,
  KimiLlmProvider,
  MINIMAX_M3_MODEL,
  MiniMaxLlmProvider,
  MockLlmProvider,
  OpenAiCompatibleFetchTransport,
  SimLoop,
  simDateForTick,
  TierRoutedLlmProvider,
  WORLD_EVENT_CATALOG_VERSION,
} from "@worldtangle/engine";
import type {
  KimiAccessMode,
  LlmModelPrice,
  KimiModel,
  LlmRequest,
  LlmResult,
  RoutedLlmProvider,
  RunCommand,
} from "@worldtangle/engine";
import {
  openDatabaseFile,
  readRunCheckpoint,
  RunLocator,
  SqliteAgentStore,
  SqliteApiTaskStore,
  SqliteCreditReadStore,
  SqliteEventStore,
  SqliteEnergyStore,
  SqliteExportStore,
  SqliteFinanceStore,
  SqliteLlmCallStore,
  SqliteLlmResponseCache,
  SqliteLlmControlStore,
  SqliteNewsStore,
  SqliteObservabilityReadStore,
  SqlitePhase4ReadStore,
  SqliteReplayStore,
  SqliteRunRepository,
  SqliteScheduler,
  SqliteSentimentStore,
  SqliteSnapshotStore,
  SqliteTickCommitter,
  SqliteVentureStore,
  SqliteWorldEventStore,
  WORLD_EVENT_TASK_ORDER,
  WORLD_EVENT_TASK_REF,
  worldDatabasePath,
  computeLogicalStateHash,
} from "./persistence";
import type { ApiTask, RunLocation, WorldDatabase } from "./persistence";
import {
  decodeAgentCursor,
  decodeAgentDecisionCursor,
  decodeEventCursor,
  decodeConversationCursor,
  decodeErrorCursor,
  decodeLlmCallCursor,
  decodeNewsCursor,
  decodePhase4Cursor,
  decodeTransactionCursor,
  decodeRelationshipCursor,
  decodeSimulationCursor,
  encodeAgentCursor,
  encodeAgentDecisionCursor,
  encodeEventCursor,
  encodeConversationCursor,
  encodeErrorCursor,
  encodeLlmCallCursor,
  encodeNewsCursor,
  encodePhase4Cursor,
  encodeTransactionCursor,
  encodeRelationshipCursor,
  encodeSimulationCursor,
} from "./cursor";
import {
  createAgentDecisionPhaseHandler,
  createGoalActivationPhaseHandler,
} from "./agent-phase";
import type { SimulationApi, SimulationControl } from "./simulation-routes";
import { childRunLogger, logPhaseTiming } from "./logger";
import {
  createSchedulerPhaseHandler,
  RegisteredScheduledTaskDispatcher,
} from "./scheduler-phase";
import type { ScheduledTaskDispatcher } from "./scheduler-phase";
import { createFinancePhaseHandlers } from "./finance-phase";
import { createPhase4Handlers } from "./phase4-phase";
import {
  createTier2DecisionPhaseHandler,
  discoverTier2DecisionOpportunities,
  prepareTier2DecisionBatch,
} from "./tier2-decision-phase";
import {
  createConversationPhaseHandler,
  discoverConversationTurnOpportunities,
  prepareConversationBatch,
} from "./conversation-phase";
import { createNegotiationBindingPhaseHandler } from "./negotiation-phase";
import { createInvestmentProposalPhaseHandler } from "./investment-phase";
import { TimedLlmProvider } from "./llm-telemetry-provider";
import {
  createNewsStoryPhaseHandler,
  discoverNewsStoryOpportunities,
  prepareNewsStoryBatch,
} from "./news-phase";
import { createSentimentPhaseHandler } from "./sentiment-phase";
import { ReplayEvidenceLlmProvider } from "./replay-llm-provider";
import { materializeExport } from "./export-generator";
import {
  firstReplayEventMismatch,
  parseReplayJournalCommand,
  replayEventHash,
  replayJournalDigest,
} from "./replay-executor";

const SUPPORTED_WORLD_SPEC = "riverbend-100@1";
const MAX_SYNC_ADVANCE_TICKS = 50;
const ASYNC_ADVANCE_CHUNK_TICKS = 10;
const DEFAULT_SNAPSHOT_INTERVAL_TICKS = 100;
const ADMIN_ACTOR = { kind: "admin", id: "api" } as const;
const SYSTEM_ACTOR = { kind: "system", id: "engine" } as const;

const INDICATOR_SERIES: Readonly<Record<
  IndicatorSeriesName,
  { readonly key: IndicatorKey; readonly unit: "cents" | "bp" | "index" | "count" }
>> = {
  gdpProxy: { key: "gdp_proxy_cents", unit: "cents" },
  cpi: { key: "cpi_index", unit: "index" },
  m1: { key: "m1_cents", unit: "cents" },
  averageWage: { key: "average_wage_cents", unit: "cents" },
  unemploymentRate: { key: "unemployment_rate_bp", unit: "bp" },
  creditOutstanding: { key: "credit_outstanding_cents", unit: "cents" },
  defaultRate: { key: "default_rate_bp", unit: "bp" },
  businessCount: { key: "active_business_count", unit: "count" },
  treasuryBalance: { key: "treasury_balance_cents", unit: "cents" },
  sentimentIndex: { key: "sentiment_index_bp", unit: "bp" },
};

export interface SimulationServiceOptions {
  readonly dataDir: string;
  readonly wallClock?: () => string;
  /** Operational monotonic clock for non-authoritative LLM latency telemetry. */
  readonly monotonicClock?: () => number;
  /** Pace for continuously running simulations. Defaults to four ticks/second. */
  readonly tickIntervalMs?: number;
  /** Create a post-commit snapshot and state hash every N ticks. */
  readonly snapshotIntervalTicks?: number;
  readonly logger?: Logger;
  /** Test/domain-module seam. Empty by default so unknown durable tasks fail loudly. */
  readonly scheduledTaskDispatcher?: ScheduledTaskDispatcher;
  /** Test seam; production defaults to the complete Phase 2 agent framework. */
  readonly enableAgentFramework?: boolean;
  /** Phase-isolation seam; production defaults to the complete Phase 7 news pipeline. */
  readonly enableNewsPipeline?: boolean;
  /** Optional live Anthropic credential. Missing credentials fail closed to Tier 1. */
  readonly anthropicApiKey?: string;
  /** MiniMax Token Plan or API key used for live Tier-2 decisions. */
  readonly minimaxApiKey?: string;
  /** Kimi Code Token Plan or Moonshot Open Platform key for live Tier-3 decisions. */
  readonly kimiApiKey?: string;
  /** Selects the endpoint/wire-model pair that matches the Kimi credential. */
  readonly kimiAccessMode?: KimiAccessMode;
  /** Pinned Kimi model. K2.6 is the general-purpose default. */
  readonly kimiModel?: KimiModel;
  /** Exact model prices used by the authoritative integer budget controller. */
  readonly llmModelPrices?: ReadonlyMap<string, LlmModelPrice>;
  /** Test/provider seam; the returned base provider is still cache- and budget-wrapped. */
  readonly llmProviderFactory?: (input: {
    readonly db: WorldDatabase;
    readonly run: SimulationRun;
  }) => RoutedLlmProvider;
}

interface EventInput {
  readonly eventId?: string;
  readonly type: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actor?: ActorRef;
}

function apiEvent(
  run: Pick<SimulationRun, "simulationId" | "id" | "currentTick">,
  ids: IdFactory,
  seq: number,
  wallTime: string,
  input: EventInput,
): EventEnvelope {
  const eventId = input.eventId ?? ids.next("evt");
  return {
    eventId,
    type: input.type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    simulationId: run.simulationId,
    runId: run.id,
    seq,
    tick: run.currentTick,
    simDate: simDateForTick(run.currentTick),
    wallTime,
    actor: input.actor ?? ADMIN_ACTOR,
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payload: input.payload,
  };
}

function lifecycleType(command: SimulationControl): string {
  const types: Record<SimulationControl, string> = {
    start: "simulation.started",
    pause: "simulation.paused",
    resume: "simulation.resumed",
    stop: "simulation.stopped",
  };
  return types[command];
}

function isAfterSimulationCursor(
  item: { readonly id: string; readonly createdAt: string },
  cursor: { readonly simulationId: string; readonly createdWall: string },
): boolean {
  return (
    item.createdAt < cursor.createdWall ||
    (item.createdAt === cursor.createdWall && item.id < cursor.simulationId)
  );
}

function phase4Page<T extends { readonly id: string }>(
  items: readonly T[],
  limit: number,
  cursor: { readonly id: string; readonly order: number } | undefined,
  orderOf: (item: T) => number,
): { readonly items: readonly T[]; readonly hasMore: boolean } {
  let start = 0;
  if (cursor !== undefined) {
    const index = items.findIndex((item) => item.id === cursor.id && orderOf(item) === cursor.order);
    if (index < 0) throw new EngineError("VALIDATION_FAILED", "pagination cursor is stale or filtered out");
    start = index + 1;
  }
  const window = items.slice(start, start + limit + 1);
  return { items: window.slice(0, limit), hasMore: window.length > limit };
}

function removeSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

function unavailableLlmProvider(input: {
  readonly provider: string;
  readonly model: string;
  readonly detail: string;
  readonly code: "authentication" | "unknown";
}): RoutedLlmProvider {
  return Object.freeze({
    route: () => ({ provider: input.provider, model: input.model }),
    propose: (request: LlmRequest): Promise<LlmResult> => Promise.resolve({
      ok: false,
      reason: "provider_error",
      requestHash: llmRequestHash(request),
      detail: input.detail,
      providerError: {
        provider: input.provider,
        code: input.code,
        retryable: false,
      },
      attempts: 0,
      requestedTier: request.tier,
      effectiveTier: 1,
    }),
  });
}

export type ResolvedLiveProviderRoute = Readonly<
  | { family: "anthropic"; tier2Model: string; tier3Model: string }
  | { family: "minimax_kimi"; tier2Model: typeof MINIMAX_M3_MODEL; tier3Model: KimiModel }
>;

/** Resolve only manifest-pinned provider/model pairs; never silently cross providers. */
export function resolveLiveProviderRoute(
  modelRouting: Readonly<Record<string, string>>,
  defaultKimiModel: KimiModel = KIMI_K2_6_MODEL,
): ResolvedLiveProviderRoute {
  const tier2Provider = modelRouting["tier2_provider"];
  const tier3Provider = modelRouting["tier3_provider"];
  const configuredTier2Model = modelRouting["tier2_routine"];
  const legacyAnthropicManifest = tier2Provider === "anthropic" ||
    (tier2Provider === undefined && configuredTier2Model?.startsWith("claude-") === true);
  if (legacyAnthropicManifest) {
    if (tier3Provider !== undefined && tier3Provider !== "anthropic") {
      throw new EngineError(
        "VALIDATION_FAILED",
        `unsupported legacy provider route anthropic/${tier3Provider}`,
      );
    }
    return Object.freeze({
      family: "anthropic",
      tier2Model: configuredTier2Model ?? ANTHROPIC_DEFAULT_MODELS.tier2,
      tier3Model: modelRouting["tier3"] ?? ANTHROPIC_DEFAULT_MODELS.tier3,
    });
  }
  if (tier2Provider !== "minimax" || tier3Provider !== "kimi") {
    throw new EngineError(
      "VALIDATION_FAILED",
      `unsupported live provider route ${tier2Provider ?? "missing"}/${tier3Provider ?? "missing"}`,
    );
  }
  const tier2Model = configuredTier2Model ?? MINIMAX_M3_MODEL;
  if (tier2Model !== MINIMAX_M3_MODEL) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `unsupported pinned MiniMax model ${tier2Model}`,
    );
  }
  const tier3Model = modelRouting["tier3"] ?? defaultKimiModel;
  if (!KIMI_SUPPORTED_MODELS.includes(tier3Model as KimiModel)) {
    throw new EngineError("VALIDATION_FAILED", `unsupported pinned Kimi model ${tier3Model}`);
  }
  return Object.freeze({
    family: "minimax_kimi",
    tier2Model: MINIMAX_M3_MODEL,
    tier3Model: tier3Model as KimiModel,
  });
}

export class SimulationService implements SimulationApi {
  private readonly dataDir: string;
  private readonly locator: RunLocator;
  private readonly wallClock: () => string;
  private readonly monotonicClock: () => number;
  private readonly tickIntervalMs: number;
  private readonly snapshotIntervalTicks: number;
  private readonly logger: Logger | undefined;
  private readonly scheduledTaskDispatcher: ScheduledTaskDispatcher;
  private readonly enableAgentFramework: boolean;
  private readonly enableNewsPipeline: boolean;
  private readonly anthropicApiKey: string | undefined;
  private readonly minimaxApiKey: string | undefined;
  private readonly kimiApiKey: string | undefined;
  private readonly kimiAccessMode: KimiAccessMode;
  private readonly kimiModel: KimiModel;
  private readonly llmModelPrices: ReadonlyMap<string, LlmModelPrice>;
  private readonly llmProviderFactory: SimulationServiceOptions["llmProviderFactory"];
  private readonly runTimers = new Map<string, NodeJS.Timeout>();
  private readonly taskTimers = new Map<string, NodeJS.Timeout>();
  private readonly replayTimers = new Map<string, NodeJS.Timeout>();
  private readonly exportTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeRunOperations = new Set<string>();
  private closed = false;

  constructor(options: SimulationServiceOptions) {
    this.dataDir = options.dataDir;
    this.locator = new RunLocator(options.dataDir);
    this.wallClock = options.wallClock ?? (() => new Date().toISOString());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.tickIntervalMs = options.tickIntervalMs ?? 250;
    this.snapshotIntervalTicks =
      options.snapshotIntervalTicks ?? DEFAULT_SNAPSHOT_INTERVAL_TICKS;
    this.logger = options.logger;
    this.scheduledTaskDispatcher =
      options.scheduledTaskDispatcher ?? new RegisteredScheduledTaskDispatcher();
    this.enableAgentFramework = options.enableAgentFramework ?? true;
    this.enableNewsPipeline = options.enableNewsPipeline ?? true;
    this.anthropicApiKey = options.anthropicApiKey?.trim() || undefined;
    this.minimaxApiKey = options.minimaxApiKey?.trim() || undefined;
    this.kimiApiKey = options.kimiApiKey?.trim() || undefined;
    this.kimiAccessMode = options.kimiAccessMode ?? "code_plan";
    this.kimiModel = options.kimiModel ?? KIMI_K2_6_MODEL;
    const prices = new Map(DEFAULT_OPENAI_COMPATIBLE_MODEL_PRICES);
    for (const [model, price] of options.llmModelPrices ?? []) prices.set(model, price);
    if (!prices.has("mock-llm-v1")) {
      prices.set("mock-llm-v1", {
        inputMicrocentsPerToken: 0n,
        outputMicrocentsPerToken: 0n,
      });
    }
    this.llmModelPrices = prices;
    this.llmProviderFactory = options.llmProviderFactory;
    if (
      !Number.isSafeInteger(this.tickIntervalMs) ||
      this.tickIntervalMs < 1 ||
      this.tickIntervalMs > 60_000
    ) {
      throw new EngineError("VALIDATION_FAILED", "tick interval must be an integer from 1..60000 ms");
    }
    if (
      !Number.isSafeInteger(this.snapshotIntervalTicks) ||
      this.snapshotIntervalTicks < 1
    ) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "snapshot interval must be a positive safe integer",
      );
    }
    this.recoverRunningRuns();
    this.recoverAdvanceTasks();
    this.recoverExportJobs();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.runTimers.values()) clearTimeout(timer);
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    for (const timer of this.replayTimers.values()) clearTimeout(timer);
    for (const timer of this.exportTimers.values()) clearTimeout(timer);
    this.runTimers.clear();
    this.taskTimers.clear();
    this.replayTimers.clear();
    this.exportTimers.clear();
  }

  engineState(): "idle" | "running" {
    return this.runTimers.size > 0 ||
      this.taskTimers.size > 0 ||
      this.replayTimers.size > 0 ||
      this.exportTimers.size > 0 ||
      this.activeRunOperations.size > 0
      ? "running"
      : "idle";
  }

  createSimulation(input: CreateSimulationRequest, requestId: string) {
    return this.createInitializedRun(input, requestId, this.locator.nextIds());
  }

  private createInitializedRun(
    input: CreateSimulationRequest,
    requestId: string,
    identity: Readonly<{ simulationId: string; runId: string }>,
    manifestTemplate?: RunManifest,
  ) {
    if (input.scenario.worldSpec !== SUPPORTED_WORLD_SPEC) {
      throw new EngineError(
        "VALIDATION_FAILED",
        `unknown world specification: ${input.scenario.worldSpec}`,
      );
    }

    const { simulationId, runId } = identity;
    const population = this.enableAgentFramework
      ? generateRiverbendPopulation({ runId, seed: input.scenario.seed })
      : undefined;
    const createdWall = this.wallClock();
    const simulation: Simulation = {
      id: simulationId,
      name: input.name,
      status: "created",
      scenarioVersion: 1,
      scenario: input.scenario,
      createdWall,
    };
    const run: SimulationRun = {
      id: runId,
      simulationId,
      status: "created",
      currentTick: 0,
      nextEventSeq: 0,
      endTick: input.scenario.endTick,
      manifest: manifestTemplate === undefined ? {
        runId,
        simulationId,
        seed: input.scenario.seed,
        engineVersion: ENGINE_VERSION,
        rulesetVersion: RULESET_VERSION,
        promptPackVersion: PROMPT_PACK_VERSION,
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        llmMode: input.scenario.llmMode,
        modelRouting: input.scenario.llmMode === "mock"
          ? { tier2_routine: "mock-llm-v1" }
          : input.scenario.llmMode === "live"
            ? {
                tier2_provider: "minimax",
                tier2_routine: MINIMAX_M3_MODEL,
                tier3_provider: "kimi",
                tier3: this.kimiModel,
              }
            : {},
        scenarioDigest: hashValue(input.scenario),
        worldSpecDigest: hashValue(input.scenario.worldSpec),
        createdWall,
      } : {
        ...manifestTemplate,
        runId,
        simulationId,
        createdWall,
      },
      idState: population?.idState ?? {},
      startedWall: null,
      endedWall: null,
    };

    const finalPath = worldDatabasePath(this.locator.dataDir, simulationId, runId);
    const creatingPath = `${finalPath}.creating`;
    if (existsSync(finalPath)) {
      throw new EngineError("CONFLICT", `run database already exists for ${runId}`);
    }
    removeSqliteFiles(creatingPath);

    const db = openDatabaseFile(creatingPath);
    try {
      const repository = new SqliteRunRepository(db);
      const created = repository.createSimulationWithRun(simulation, run, ({ run: persisted }) => {
        const ids = IdFactory.restore(persisted.idState);
        const command = apiEvent(persisted, ids, persisted.nextEventSeq, createdWall, {
          type: "admin.command.received",
          correlationId: requestId,
          payload: {
            command: "create",
            params: { simulationId, runId, name: input.name, scenario: input.scenario },
            requestId,
          },
        });
        const fact = apiEvent(persisted, ids, persisted.nextEventSeq + 1, createdWall, {
          type: "simulation.created",
          correlationId: requestId,
          causationId: command.eventId,
          payload: { status: "created", byCommandEventId: command.eventId },
        });
        const eventStore = new SqliteEventStore(db, persisted.id);
        if (population === undefined) {
          eventStore.appendBatch([command, fact]);
          new SqliteLlmControlStore(db, persisted.id).initialize({
            runCostCentsMax: input.scenario.budgets.runCostCentsMax,
            perAgentDailyTokens: input.scenario.budgets.perAgentDailyTokens,
            llmEnabled: input.scenario.llmMode !== "off",
            sourceEventId: fact.eventId,
          });
          return ids.serialize();
        }
        const populationEvent = apiEvent(
          persisted,
          ids,
          persisted.nextEventSeq + 2,
          createdWall,
          {
            type: "population.generated",
            correlationId: requestId,
            causationId: fact.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              worldSpec: population.report.worldSpec,
              populationHash: population.report.populationHash,
              specHash: population.report.specHash,
              stats: population.report.stats,
            },
          },
        );
        const agentEvents = population.residents.map((resident, index) =>
          apiEvent(
            persisted,
            ids,
            persisted.nextEventSeq + 3 + index,
            createdWall,
            {
              type: "agent.created",
              correlationId: requestId,
              causationId: populationEvent.eventId,
              actor: SYSTEM_ACTOR,
              payload: {
                agentId: resident.agent.id,
                occupation: resident.agent.occupationCode,
                householdId: resident.agent.householdId,
              },
            },
          )
        );
        const triggerEventByAgent = new Map(
          population.residents.map((resident, index) => [
            resident.agent.id,
            agentEvents[index]!.eventId,
          ]),
        );
        eventStore.append(command);
        const agentStore = new SqliteAgentStore(db, persisted.id);
        agentStore.insertPopulation(population, triggerEventByAgent);
        const memories = new DeterministicMemoryStore({
          repository: agentStore,
          ids,
        });
        for (let index = 0; index < population.residents.length; index++) {
          const resident = population.residents[index]!;
          memories.record({
            runId: persisted.id,
            agentId: resident.agent.id,
            tick: 0,
            kind: "event",
            content: (
              resident.persona.name +
              " began the Riverbend simulation as " +
              resident.agent.occupationCode +
              "."
            ),
            importance: Math.min(
              100,
              50 + Math.floor(resident.persona.personality.ambition / 2),
            ),
            references: [agentEvents[index]!.eventId],
          });
        }
        const finance = new SqliteFinanceStore(db, persisted.id).initialize(
          population,
          ids,
          input.scenario.policyOverrides,
          populationEvent.eventId,
        );
        const energyEventId = ids.next("evt");
        const energy = new SqliteEnergyStore(db, persisted.id).initialize({
          ids,
          householdBaseTariffCents: finance.policies.find(
            (policy) => policy.key === "utilities_monthly_cents",
          )!.valueInteger,
          sourceEventId: energyEventId,
        });
        const ventureFirmEventId = ids.next("evt");
        const ventureFundEventId = ids.next("evt");
        const venture = new SqliteVentureStore(db, persisted.id).initializeFoundry({
          ids,
          firmSourceEventId: ventureFirmEventId,
          fundSourceEventId: ventureFundEventId,
        });
        const financeEventInputs: EventInput[] = [
          {
            eventId: energyEventId,
            type: "energy.system.initialized",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              utilityId: energy.system.utilityId,
              utilityAccountId: energy.system.utilityAccountId,
              rowAccountId: energy.system.rowAccountId,
              billingIntervalTicks: energy.system.billingIntervalTicks,
              passThroughBp: energy.system.passThroughBp,
              tariffs: energy.tariffs.map((tariff) => ({
                tariffId: tariff.id,
                customerClass: tariff.customerClass,
                priceCents: tariff.priceCents,
                effectiveTick: tariff.effectiveTick,
              })),
              fuelPriceId: energy.fuelPrice.id,
              fuelPriceCents: energy.fuelPrice.newPriceCents,
              rulesetVersion: energy.system.rulesetVersion,
            },
          },
          ...finance.accounts.map((account) => ({
            type: "account.opened",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              accountId: account.id,
              bankId: account.bankId,
              ownerKind: account.ownerKind,
              ownerId: account.ownerId,
              type: account.type,
              balanceCents: account.balanceCents,
              floorCents: account.floorCents,
            },
          })),
          ...[...finance.mintTransactions, ...finance.loanTransactions].map((transaction) => ({
            type: "transaction.posted",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              transactionId: transaction.id,
              kind: transaction.kind,
              legs: transaction.legs,
              reason: transaction.reason,
              sourceEventId: transaction.sourceEventId,
            },
          })),
          ...finance.policies.map((policy) => ({
            type: "policy.changed",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              policyId: policy.id,
              key: policy.key,
              old: null,
              new: policy.valueInteger,
              effectiveTick: 0,
              source: "world_gen",
              causeEventId: populationEvent.eventId,
            },
          })),
          {
            type: "economic.metrics.updated",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: {
              rulesetVersion: ECONOMIC_INDICATOR_RULESET_VERSION,
              indicators: finance.indicators,
              evidence: finance.indicatorEvidence,
            },
          },
          {
            eventId: ventureFirmEventId,
            type: "venture.firm.created",
            correlationId: requestId,
            causationId: populationEvent.eventId,
            actor: SYSTEM_ACTOR,
            payload: ventureFirmCreatedPayloadSchema.parse({
              firmId: venture.firm.id,
              name: venture.firm.name,
              status: venture.firm.status,
              evidence: [populationEvent.eventId],
            }),
          },
          {
            eventId: ventureFundEventId,
            type: "venture.fund.created",
            correlationId: requestId,
            causationId: ventureFirmEventId,
            actor: { kind: "institution", id: venture.firm.id },
            payload: ventureFundCreatedPayloadSchema.parse({
              fundId: venture.fund.id,
              firmId: venture.firm.id,
              name: venture.fund.name,
              fundSizeCents: venture.fund.fundSizeCents,
              evidence: [ventureFirmEventId],
            }),
          },
        ];
        const financeEventStart = persisted.nextEventSeq + 3 + agentEvents.length;
        const financeEvents = financeEventInputs.map((input, index) =>
          apiEvent(persisted, ids, financeEventStart + index, createdWall, input)
        );
        const linkByLoan = new Map(
          finance.seedLoanLinks.map((link) => [link.loanId, link]),
        );
        const firstTransactionEventIndex = 1 + finance.accounts.length;
        const firstLoanTransactionEventIndex =
          firstTransactionEventIndex + finance.mintTransactions.length;
        const loanEvents = population.loans.map((loan, index) => {
          const link = linkByLoan.get(loan.id);
          const transaction = finance.loanTransactions[index];
          const transactionEvent = financeEvents[firstLoanTransactionEventIndex + index];
          if (
            link === undefined ||
            transaction === undefined ||
            transactionEvent === undefined ||
            transaction.id !== link.recognitionTransactionId
          ) {
            throw new EngineError(
              "INTERNAL",
              `seed loan ${loan.id} lacks its deterministic finance evidence`,
            );
          }
          return apiEvent(
            persisted,
            ids,
            financeEventStart + financeEvents.length + index,
            createdWall,
            {
              type: "loan.seeded",
              correlationId: requestId,
              causationId: transactionEvent.eventId,
              actor: SYSTEM_ACTOR,
              payload: {
                loanId: loan.id,
                borrowerKind: loan.borrowerKind,
                borrowerId: loan.borrowerId,
                purpose: loan.purpose,
                originalPrincipalCents: loan.originalPrincipalCents,
                outstandingPrincipalCents: loan.outstandingPrincipalCents,
                annualRateBp: loan.annualRateBp,
                termMonths: loan.termMonths,
                seasonedMonths: loan.seasonedMonths,
                status: loan.status,
                missedPayments: loan.missedPayments,
                scheduleDigest: hashValue(loan.installments),
                bankId: finance.bankId,
                bankAssetAccountId: link.bankAssetAccountId,
                borrowerDepositAccountId: link.borrowerDepositAccountId,
                recognitionTransactionId: link.recognitionTransactionId,
                evidence: [
                  populationEvent.eventId,
                  transactionEvent.eventId,
                  transaction.id,
                ],
              },
            },
          );
        });
        eventStore.appendBatch([
          fact,
          populationEvent,
          ...agentEvents,
          ...financeEvents,
          ...loanEvents,
        ]);
        new SqliteLlmControlStore(db, persisted.id).initialize({
          runCostCentsMax: input.scenario.budgets.runCostCentsMax,
          perAgentDailyTokens: input.scenario.budgets.perAgentDailyTokens,
          llmEnabled: input.scenario.llmMode !== "off",
          sourceEventId: fact.eventId,
        });
        return ids.serialize();
      });
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      renameSync(creatingPath, finalPath);
      const response = {
        simulation: {
          id: created.simulation.id,
          name: created.simulation.name,
          status: created.simulation.status,
          createdAt: created.simulation.createdWall,
        },
        run: {
          id: created.run.id,
          status: created.run.status,
          currentTick: created.run.currentTick,
          manifest: created.run.manifest,
        },
      };
      if (this.logger !== undefined) {
        childRunLogger(this.logger, {
          simulationId,
          runId,
          tick: 0,
          correlationId: requestId,
        }).info({ event: "simulation.created" }, "simulation created");
      }
      return response;
    } catch (error) {
      if (db.open) db.close();
      removeSqliteFiles(creatingPath);
      if (this.logger !== undefined) {
        childRunLogger(this.logger, {
          simulationId,
          runId,
          tick: 0,
          correlationId: requestId,
        }).error(
          {
            event: "simulation.create.failed",
            code: error instanceof EngineError ? error.code : "INTERNAL",
            err: error,
          },
          "simulation creation failed",
        );
      }
      throw error;
    }
  }

  replaySimulation(
    simulationId: string,
    sourceRunId: string,
    input: ReplayRequest,
    requestId: string,
  ) {
    const sourceLocation = this.locator.locate(simulationId, sourceRunId);
    this.assertRunOperationAvailable(sourceLocation);
    const source = this.withDatabase(sourceLocation, (db) => {
      const repository = new SqliteRunRepository(db);
      const run = repository.getRun(sourceRunId);
      if (run.status !== "completed" && run.status !== "stopped" && run.status !== "failed") {
        throw new EngineError("CONFLICT", `source run ${sourceRunId} is not terminal`);
      }
      const pinnedVersions = {
        engineVersion: ENGINE_VERSION,
        rulesetVersion: RULESET_VERSION,
        promptPackVersion: PROMPT_PACK_VERSION,
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
      } as const;
      for (const [field, current] of Object.entries(pinnedVersions)) {
        const sourceValue = run.manifest[field as keyof typeof pinnedVersions];
        if (sourceValue !== current) {
          throw new EngineError(
            "CONFLICT",
            `source manifest ${field} ${String(sourceValue)} does not match ${String(current)}`,
          );
        }
      }
      const toTick = input.toTick ?? run.currentTick;
      if (toTick > run.currentTick) {
        throw new EngineError(
          "VALIDATION_FAILED",
          `replay target tick ${toTick} exceeds source tick ${run.currentTick}`,
        );
      }
      const simulation = repository.getSimulation(simulationId);
      const events = new SqliteEventStore(db, sourceRunId).list();
      const creationCommand = events
        .filter((event) => event.type === "admin.command.received")
        .map((event) => parseReplayJournalCommand(event))
        .find((command) => command.command === "create");
      if (creationCommand === undefined) {
        throw new EngineError("CONFLICT", "source run has no replayable creation command");
      }
      const cacheArtifact = new SqliteLlmResponseCache(db, sourceRunId).exportArtifact();
      const llmCalls = new SqliteLlmCallStore(db, sourceRunId).listForReplay();
      const cachedRequestHashes = new Set(
        cacheArtifact.entries.map((entry) => entry.key.requestHash),
      );
      const missingCacheHashes = [...new Set(
        llmCalls
          .filter((call) => call.status === "success" && !cachedRequestHashes.has(call.requestHash))
          .map((call) => call.requestHash),
      )].sort();
      const createInput = createSimulationRequestSchema.parse({
        name: simulation.name,
        scenario: simulation.scenario,
      });
      return Object.freeze({
        run,
        createInput,
        events,
        creationRequestId: creationCommand.requestId,
        cacheArtifact,
        llmCalls,
        missingCacheHashes,
        toTick,
        journalDigest: replayJournalDigest(events),
        sourceStateHash: toTick === run.currentTick
          ? computeLogicalStateHash(db, sourceRunId)
          : null,
      });
    });

    const runId = this.locator.nextIds().runId;
    this.createInitializedRun(
      source.createInput,
      source.creationRequestId,
      { simulationId, runId },
      source.run.manifest,
    );
    const replayLocation = this.locator.locate(simulationId, runId);
    const replayRun = this.withDatabase(replayLocation, (db) => db.transaction(() => {
      const targetEvents = new SqliteEventStore(db, runId).list();
      const cacheCausationId = targetEvents.at(-1)?.eventId;
      if (cacheCausationId === undefined) {
        throw new EngineError("INTERNAL", "replay target has no creation journal");
      }
      const cache = new SqliteLlmResponseCache(db, runId);
      cache.importArtifact(source.cacheArtifact, {
        correlationId: requestId,
        causationId: cacheCausationId,
      });
      const store = new SqliteReplayStore(db, runId);
      store.create({
        runId,
        sourceSimulationId: simulationId,
        sourceRunId,
        mode: input.mode,
        toTick: source.toTick,
        cacheArtifactDigest: source.cacheArtifact.digest,
        journalDigest: source.journalDigest,
        startedWall: this.wallClock(),
      });
      store.importLlmExpectations(source.llmCalls);
      const genesisMismatch = firstReplayEventMismatch(
        source.events.slice(0, targetEvents.length),
        targetEvents,
      );
      if (genesisMismatch !== null) {
        store.recordDivergence({
          tick: 0,
          kind: "event_mismatch",
          expectedHash: genesisMismatch.expectedHash,
          actualHash: genesisMismatch.actualHash,
          details: { ...genesisMismatch },
          createdWall: this.wallClock(),
        });
      }
      if (source.missingCacheHashes.length > 0) {
        store.recordDivergence({
          tick: 0,
          kind: "cache_incomplete",
          details: {
            missingRequestHashes: source.missingCacheHashes,
            sourceRunId,
          },
          createdWall: this.wallClock(),
        });
      }
      store.updateProgress(0, targetEvents.length - 1);
      return store.require();
    }).immediate());
    this.scheduleReplay(replayLocation);
    return { replayRun };
  }

  createExport(
    simulationId: string,
    input: CreateExportRequest,
    requestId: string,
  ) {
    const location = this.locator.locate(simulationId, input.runId);
    const release = this.enterRunOperation(location);
    try {
      const exportJob = this.withDatabase(location, (db) => {
        const run = new SqliteRunRepository(db).getRun(location.runId);
        if (run.status === "running") {
          throw new EngineError("CONFLICT", "a running simulation cannot be exported");
        }
        if (new SqliteApiTaskStore(db, location.runId).getActive() !== null) {
          throw new EngineError("CONFLICT", "a run with an active advance task cannot be exported");
        }
        const replay = new SqliteReplayStore(db, location.runId).get();
        if (replay?.status === "running") {
          throw new EngineError("CONFLICT", "an active replay cannot be exported");
        }
        return new SqliteExportStore(db, location.runId).create({
          simulationId,
          format: input.format,
          datasets: input.datasets,
          sourceTick: run.currentTick,
          sourceStateHash: computeLogicalStateHash(db, location.runId),
          correlationId: requestId,
          createdWall: this.wallClock(),
        });
      });
      this.scheduleExport(location, exportJob.id);
      return { export: exportJob };
    } finally {
      release();
    }
  }

  getExport(exportId: string) {
    const location = this.locateExport(exportId);
    return {
      export: this.withDatabase(
        location,
        (db) => new SqliteExportStore(db, location.runId).get(exportId),
      ),
    };
  }

  listSimulations(query: SimulationListQuery) {
    const latestBySimulation = new Map<string, RunLocation>();
    for (const location of this.locator.list()) {
      latestBySimulation.set(location.simulationId, location);
    }
    const items = [...latestBySimulation.values()].map((location) =>
      this.withDatabase(location, (db) => {
        const repository = new SqliteRunRepository(db);
        const simulation = repository.getSimulation(location.simulationId);
        const run = repository.getRun(location.runId);
        return {
          id: simulation.id,
          name: simulation.name,
          status: simulation.status,
          latestRun: { id: run.id, status: run.status, currentTick: run.currentTick },
          createdAt: simulation.createdWall,
        };
      }),
    );
    items.sort(
      (left, right) =>
        (left.createdAt > right.createdAt ? -1 : left.createdAt < right.createdAt ? 1 : 0) ||
        (left.id > right.id ? -1 : left.id < right.id ? 1 : 0),
    );
    const cursor = query.cursor === undefined ? undefined : decodeSimulationCursor(query.cursor);
    const filtered = items.filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (cursor === undefined || isAfterSimulationCursor(item, cursor)),
    );
    const selected = filtered.slice(0, query.limit);
    const last = selected.at(-1);
    return {
      items: selected,
      nextCursor:
        filtered.length > selected.length && last !== undefined
          ? encodeSimulationCursor({
              simulationId: last.id,
              createdWall: last.createdAt,
            })
          : null,
    };
  }

  getSimulation(simulationId: string) {
    const locations = this.locator
      .list()
      .filter((location) => location.simulationId === simulationId);
    if (locations.length === 0) {
      // `locate` also validates the ID and gives the public NOT_FOUND wording.
      this.locator.locate(simulationId);
    }
    const latest = locations.at(-1)!;
    const simulation = this.withDatabase(latest, (db) =>
      new SqliteRunRepository(db).getSimulation(simulationId),
    );
    const runs = locations.map((location) =>
      this.withDatabase(location, (db) => {
        const run = new SqliteRunRepository(db).getRun(location.runId);
        return {
          id: run.id,
          seed: run.manifest.seed,
          status: run.status,
          currentTick: run.currentTick,
          startedAt: run.startedWall,
          endedAt: run.endedWall,
          spend: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            costCentsEstimate: "0",
          },
        };
      }),
    );
    return {
      simulation: {
        id: simulation.id,
        name: simulation.name,
        status: simulation.status,
        scenarioVersion: simulation.scenarioVersion,
        scenario: simulation.scenario,
        createdAt: simulation.createdWall,
      },
      runs,
    };
  }

  controlSimulation(
    simulationId: string,
    control: SimulationControl,
    input: RunSelectionRequest,
    requestId: string,
  ) {
    const location = this.locator.locate(simulationId, input.runId);
    try {
      this.assertRunOperationAvailable(location);
      const response = this.withDatabase(location, (db) => {
      const repository = new SqliteRunRepository(db);
      const activeTask = new SqliteApiTaskStore(db, location.runId).getActive();
      if (activeTask !== null) {
        throw new EngineError(
          "CONFLICT",
          `run has active API task ${activeTask.id}; wait for it before ${control}`,
        );
      }
      let commandEventId: string | undefined;
      const wallTime = this.wallClock();
      const transitioned = repository.transitionRun(
        { runId: location.runId, command: control as RunCommand, wallTime },
        ({ current, nextStatus }) => {
          const ids = IdFactory.restore(current.idState);
          const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
            type: "admin.command.received",
            correlationId: requestId,
            payload: {
              command: control,
              params: { runId: current.id },
              requestId,
            },
          });
          commandEventId = command.eventId;
          const fact = apiEvent(current, ids, current.nextEventSeq + 1, wallTime, {
            type: lifecycleType(control),
            correlationId: requestId,
            causationId: command.eventId,
            payload: { status: nextStatus, byCommandEventId: command.eventId },
          });
          new SqliteEventStore(db, current.id).appendBatch([command, fact]);
          if (control === "start") {
            const activated = db.prepare(`
              UPDATE simulations SET status = 'active'
              WHERE id = ? AND status = 'created'
            `).run(simulationId);
            if (activated.changes !== 1) {
              throw new EngineError("CONFLICT", "simulation could not be activated");
            }
          }
          return ids.serialize();
        },
      );
      if (commandEventId === undefined) {
        throw new EngineError("INTERNAL", "lifecycle command was not journaled");
      }
      return {
        run: {
          id: transitioned.id,
          status: transitioned.status,
          currentTick: transitioned.currentTick,
        },
        commandEventId,
      };
      });
      if (response.run.status === "running") {
        this.scheduleRun(location);
      } else {
        this.cancelRun(location);
      }
      if (this.logger !== undefined) {
        childRunLogger(this.logger, {
          simulationId,
          runId: location.runId,
          tick: response.run.currentTick,
          correlationId: requestId,
        }).info(
          { event: "simulation.lifecycle.changed", command: control, status: response.run.status },
          "simulation lifecycle changed",
        );
      }
      return response;
    } catch (error) {
      this.logRunOperationFailure(
        location,
        requestId,
        "simulation.lifecycle.failed",
        error,
        { command: control },
      );
      throw error;
    }
  }

  setLlmControl(
    simulationId: string,
    input: LlmControlRequest,
    requestId: string,
  ) {
    const location = this.locator.locate(simulationId, input.runId);
    try {
      this.assertRunOperationAvailable(location);
      const result = this.withDatabase(location, (db) =>
        new SqliteLlmControlStore(db, location.runId).applyControl(
          input,
          requestId,
          this.wallClock(),
        )
      );
      if (this.logger !== undefined) {
        childRunLogger(this.logger, {
          simulationId,
          runId: location.runId,
          tick: 0,
          correlationId: requestId,
        }).info(
          { event: "llm.control.changed", command: input.command },
          "LLM runtime control changed",
        );
      }
      return { ...result };
    } catch (error) {
      this.logRunOperationFailure(
        location,
        requestId,
        "llm.control.failed",
        error,
        { command: input.command },
      );
      throw error;
    }
  }

  async advanceSimulation(
    simulationId: string,
    input: AdvanceSimulationRequest,
    requestId: string,
  ) {
    const location = this.locator.locate(simulationId, input.runId);
    const release = this.enterRunOperation(location);
    try {
      if (input.ticks > MAX_SYNC_ADVANCE_TICKS) {
        const task = this.enqueueAdvanceTask(location, input.ticks, requestId);
        this.scheduleAdvanceTask(location, task.id);
        if (this.logger !== undefined) {
          childRunLogger(this.logger, {
            simulationId,
            runId: location.runId,
            tick: task.startTick,
            correlationId: requestId,
          }).info(
            { event: "simulation.advance.queued", taskId: task.id, targetTick: task.targetTick },
            "simulation advance queued",
          );
        }
        return {
          statusCode: 202 as const,
          body: {
            taskId: task.id,
            poll: `/api/v1/simulations/${simulationId}/status`,
          },
        };
      }
      const body = await this.withDatabaseAsync(location, async (db) => {
        const repository = new SqliteRunRepository(db);
        const activeTask = new SqliteApiTaskStore(db, location.runId).getActive();
        if (activeTask !== null) {
          throw new EngineError("CONFLICT", `run already has active API task ${activeTask.id}`);
        }
        const wallTime = this.wallClock();
        const before = repository.getRun(location.runId);
        assertCanAdvance(before.status);
        if (input.ticks > before.endTick - before.currentTick) {
          throw new EngineError(
            "CONFLICT",
            `cannot advance ${input.ticks} ticks with only ${before.endTick - before.currentTick} remaining`,
          );
        }

        let commandEventId: string | undefined;
        db.transaction(() => {
          const current = repository.getRun(location.runId);
          assertCanAdvance(current.status);
          if (
            current.currentTick !== before.currentTick ||
            current.nextEventSeq !== before.nextEventSeq
          ) {
            throw new EngineError("CONFLICT", "stale advance checkpoint");
          }
          const ids = IdFactory.restore(current.idState);
          const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
            type: "admin.command.received",
            correlationId: requestId,
            payload: {
              command: "advance",
              params: { runId: current.id, ticks: input.ticks },
              requestId,
            },
          });
          commandEventId = command.eventId;
          new SqliteEventStore(db, current.id).append(command);
          const updated = db.prepare(`
            UPDATE simulation_runs
            SET id_state_canonical = @idState
            WHERE id = @runId
              AND status = 'paused'
              AND current_tick = @currentTick
              AND next_event_seq = @nextEventSeq
          `).run({
            runId: current.id,
            currentTick: current.currentTick,
            nextEventSeq: current.nextEventSeq + 1,
            idState: canonicalStringify(ids.serialize()),
          });
          if (updated.changes !== 1) {
            throw new EngineError("CONFLICT", "stale advance journal checkpoint");
          }
        }).immediate();
        if (commandEventId === undefined) {
          throw new EngineError("INTERNAL", "advance command was not journaled");
        }

        const result = await this.executeTicks(
          db,
          simulationId,
          location.runId,
          input.ticks,
          requestId,
        );
        const advanced =
          result.run.currentTick === result.run.endTick
            ? this.completeRun(db, location.runId, requestId, commandEventId)
            : result.run;
        return {
          run: { currentTick: advanced.currentTick, status: advanced.status },
          tickResults: {
            executed: input.ticks,
            events: result.events,
          },
        };
      });
      if (this.logger !== undefined) {
        childRunLogger(this.logger, {
          simulationId,
          runId: location.runId,
          tick: body.run.currentTick,
          correlationId: requestId,
        }).info(
          { event: "simulation.advanced", ticks: input.ticks, events: body.tickResults.events },
          "simulation advanced",
        );
      }
      return { statusCode: 200 as const, body };
    } catch (error) {
      this.logRunOperationFailure(
        location,
        requestId,
        "simulation.advance.failed",
        error,
        { ticks: input.ticks },
      );
      throw error;
    } finally {
      release();
    }
  }

  injectWorldEvent(
    simulationId: string,
    input: InjectWorldEventRequest,
    requestId: string,
  ) {
    const location = this.locator.locate(simulationId, input.runId);
    const release = this.enterRunOperation(location);
    try {
      return this.withDatabase(location, (db) => db.transaction(() => {
        const repository = new SqliteRunRepository(db);
        const current = repository.getRun(location.runId);
        if (current.status !== "created" && current.status !== "paused") {
          throw new EngineError(
            "CONFLICT",
            `world events can be injected only while created or paused; run is ${current.status}`,
          );
        }
        const activeTask = new SqliteApiTaskStore(db, location.runId).getActive();
        if (activeTask !== null) {
          throw new EngineError(
            "CONFLICT",
            `run has active API task ${activeTask.id}; wait before injecting a world event`,
          );
        }
        const scheduledTick = input.scheduleTick ?? current.currentTick + 1;
        if (scheduledTick <= current.currentTick || scheduledTick > current.endTick) {
          throw new EngineError(
            "VALIDATION_FAILED",
            `world-event schedule tick must be in ${current.currentTick + 1}..${current.endTick}`,
          );
        }

        const worldEventStore = new SqliteWorldEventStore(db, current.id);
        const spec = { type: input.type, params: input.params } as WorldEventSpec;
        worldEventStore.validateSpecTargets(spec);
        const ids = IdFactory.restore(current.idState);
        const worldEventId = ids.next("wev");
        const taskId = ids.next("task");
        const wallTime = this.wallClock();
        const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
          type: "admin.command.received",
          correlationId: requestId,
          payload: {
            command: "world_event.inject",
            params: {
              runId: current.id,
              type: input.type,
              params: input.params,
              scheduledTick,
            },
            requestId,
          },
        });
        const injected = apiEvent(current, ids, current.nextEventSeq + 1, wallTime, {
          type: "world.event.injected",
          correlationId: requestId,
          causationId: command.eventId,
          payload: {
            worldEventId,
            type: input.type,
            params: input.params,
            scheduledTick,
            source: "admin",
          },
        });
        const worldEvent = worldEventSchema.parse({
          id: worldEventId,
          runId: current.id,
          type: input.type,
          params: input.params,
          source: "admin",
          status: "scheduled",
          createdTick: current.currentTick,
          scheduledTick,
          appliedTick: null,
          taskId,
          commandEventId: command.eventId,
          injectedEventId: injected.eventId,
          appliedEventId: null,
          effectEventIds: [],
          catalogVersion: WORLD_EVENT_CATALOG_VERSION,
        });

        new SqliteEventStore(db, current.id).appendBatch([command, injected]);
        worldEventStore.recordScheduled(worldEvent);
        new SqliteScheduler(db, current.id).schedule({
          id: taskId,
          dueTick: scheduledTick,
          order: WORLD_EVENT_TASK_ORDER,
          taskRef: WORLD_EVENT_TASK_REF,
          payload: { worldEventId },
        });
        const updated = db.prepare(`
          UPDATE simulation_runs
          SET id_state_canonical = @idState
          WHERE id = @runId AND status = @status
            AND current_tick = @currentTick AND next_event_seq = @nextEventSeq
        `).run({
          runId: current.id,
          status: current.status,
          currentTick: current.currentTick,
          nextEventSeq: current.nextEventSeq + 2,
          idState: canonicalStringify(ids.serialize()),
        });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", "stale world-event injection checkpoint");
        }
        return { worldEvent: worldEventStore.get(worldEventId), commandEventId: command.eventId };
      }).immediate());
    } catch (error) {
      this.logRunOperationFailure(
        location,
        requestId,
        "world_event.injection.failed",
        error,
        { type: input.type, scheduleTick: input.scheduleTick },
      );
      throw error;
    } finally {
      release();
    }
  }

  getStatus(simulationId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) => {
      const run = new SqliteRunRepository(db).getRun(location.runId);
      const task = new SqliteApiTaskStore(db, location.runId).getLatest();
      const llm = new SqliteLlmControlStore(db, location.runId).status();
      const calls = new SqliteLlmCallStore(db, location.runId).summary();
      const observability = new SqliteObservabilityReadStore(db, location.runId);
      const replay = new SqliteReplayStore(db, location.runId).get();
      return {
        run: {
          id: run.id,
          status: run.status,
          currentTick: run.currentTick,
          simDate: simDateForTick(run.currentTick),
          endTick: run.endTick,
        },
        tickRate: {
          ticksPerSec: run.status === "running" ? 1_000 / this.tickIntervalMs : 0,
        },
        llm: {
          mode: run.manifest.llmMode,
          spend: llm.spend,
          budgetPct: llm.budgetPct,
          cacheHitRate: calls.cacheableCalls === 0
            ? 0
            : calls.cacheHits / calls.cacheableCalls,
          enabled: llm.enabled,
          effectiveTier: llm.effectiveTier,
          autoPaused: llm.autoPaused,
          frozenModules: llm.frozenModules,
          limits: llm.limits,
        },
        errors: {
          last24Ticks: observability.errorCountSinceTick(Math.max(0, run.currentTick - 23)),
        },
        replay,
        task:
          task === null
            ? null
            : {
                id: task.id,
                kind: task.kind,
                status: task.status,
                startTick: task.startTick,
                targetTick: task.targetTick,
                completedTicks: Math.max(
                  0,
                  Math.min(run.currentTick, task.targetTick) - task.startTick,
                ),
                errorText: task.errorText,
              },
      };
    });
  }

  listEvents(simulationId: string, query: EventListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const beforeSeq =
        query.cursor === undefined
          ? undefined
          : decodeEventCursor(query.cursor, location.runId).seq;
      const page = new SqliteEventStore(db, location.runId).page({
        direction: "backward",
        limit: query.limit,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.fromTick === undefined ? {} : { fromTick: query.fromTick }),
        ...(query.toTick === undefined ? {} : { toTick: query.toTick }),
        ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
        ...(query.correlationId === undefined
          ? {}
          : { correlationId: query.correlationId }),
        ...(query.causationId === undefined ? {} : { causationId: query.causationId }),
      });
      return {
        items: page.items,
        nextCursor:
          page.nextCursor === null
            ? null
            : encodeEventCursor({ runId: location.runId, seq: page.nextCursor }),
      };
    });
  }

  listNews(simulationId: string, query: NewsListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeNewsCursor(query.cursor, location.runId);
      const news = new SqliteNewsStore(db, location.runId);
      const sentiment = new SqliteSentimentStore(db, location.runId);
      const agents = new SqliteAgentStore(db, location.runId);
      const stories = [...news.listStories({ status: "published" })]
        .filter((story) => query.topic === undefined || story.topic === query.topic)
        .filter((story) => query.fromTick === undefined || story.tick >= query.fromTick)
        .filter((story) => query.toTick === undefined || story.tick <= query.toTick)
        .sort((left, right) => {
          if (left.tick !== right.tick) return right.tick - left.tick;
          if (left.id === right.id) return 0;
          return left.id < right.id ? 1 : -1;
        })
        .filter((story) => cursor === undefined || (
          story.tick < cursor.tick ||
          (story.tick === cursor.tick && story.id < cursor.storyId)
        ));
      const window = stories.slice(0, query.limit + 1);
      const selected = window.slice(0, query.limit);
      const organizationNames = new Map<string, string>();
      const authorNames = new Map<string, string>();
      const organizationName = (organizationId: string): string => {
        const known = organizationNames.get(organizationId);
        if (known !== undefined) return known;
        const organization = news.getOrganization(organizationId);
        if (organization === null) {
          throw new EngineError("INTERNAL", `news organization ${organizationId} is missing`);
        }
        organizationNames.set(organizationId, organization.name);
        return organization.name;
      };
      const authorName = (agentId: string): string => {
        const known = authorNames.get(agentId);
        if (known !== undefined) return known;
        const name = agents.getProfile(agentId, 0).persona.name;
        authorNames.set(agentId, name);
        return name;
      };
      const last = selected.at(-1);
      return {
        items: selected.map((story) => ({
          id: story.id,
          tick: story.tick,
          sourceTick: story.sourceTick,
          headline: story.headline,
          topic: story.topic,
          stance: story.stance,
          reach: story.reach,
          author: { id: story.authorAgentId, name: authorName(story.authorAgentId) },
          org: { id: story.orgId, name: organizationName(story.orgId) },
          citedEventIds: story.citedEventIds,
          sourceEventId: story.sourceEventId,
        })),
        nextCursor: window.length > selected.length && last !== undefined
          ? encodeNewsCursor({
              runId: location.runId,
              tick: last.tick,
              storyId: last.id,
            })
          : null,
        sentiment: SENTIMENT_TOPICS.map((topic) => ({
          topic,
          points: sentiment.listSentimentUpdates({ topic })
            .filter((update) => query.fromTick === undefined || update.tick >= query.fromTick)
            .filter((update) => query.toTick === undefined || update.tick <= query.toTick)
            .map((update) => [update.tick, update.value] as [number, number]),
        })),
      };
    });
  }

  getNewsStory(simulationId: string, storyId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) => {
      const news = new SqliteNewsStore(db, location.runId);
      const story = news.getStory(storyId);
      if (story === null || story.status !== "published") {
        throw new EngineError("NOT_FOUND", `published news story ${storyId} does not exist`);
      }
      const organization = news.getOrganization(story.orgId);
      if (organization === null) {
        throw new EngineError("INTERNAL", `news organization ${story.orgId} is missing`);
      }
      const author = new SqliteAgentStore(db, location.runId)
        .getProfile(story.authorAgentId, 0).persona;
      const sentimentImpact = new SqliteSentimentStore(db, location.runId)
        .listContributions()
        .filter((contribution) => contribution.storyId === story.id)
        .sort((left, right) => {
          if (left.topic !== right.topic) return left.topic < right.topic ? -1 : 1;
          return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
        })
        .map((contribution) => ({
          topic: contribution.topic,
          delta: contribution.delta,
          stanceDelta: contribution.stanceDelta,
          outcomeDelta: contribution.outcomeDelta,
          sourceEventId: contribution.sourceEventId,
        }));
      return {
        story: {
          id: story.id,
          tick: story.tick,
          sourceTick: story.sourceTick,
          headline: story.headline,
          body: story.body,
          topic: story.topic,
          stance: story.stance,
          reach: story.reach,
          entities: story.entities,
          author: { id: story.authorAgentId, name: author.name },
          org: { id: story.orgId, name: organization.name },
          citedEventIds: story.citedEventIds,
          decisionId: story.decisionId,
          ...(story.llmCallId === undefined ? {} : { llmCallId: story.llmCallId }),
          sourceEventId: story.sourceEventId,
        },
        citedEvents: story.facts,
        sentimentImpact,
      };
    });
  }

  listLlmCalls(simulationId: string, query: LlmCallListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeLlmCallCursor(query.cursor, location.runId);
      const page = new SqliteObservabilityReadStore(db, location.runId)
        .listLlmCalls(query, cursor);
      return {
        items: page.items,
        nextCursor: page.next === null ? null : encodeLlmCallCursor(page.next),
        totals: page.totals,
      };
    });
  }

  listErrors(simulationId: string, query: ErrorListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeErrorCursor(query.cursor, location.runId);
      const page = new SqliteObservabilityReadStore(db, location.runId)
        .listErrors(query, cursor);
      return {
        items: page.items,
        nextCursor: page.next === null ? null : encodeErrorCursor(page.next),
        summary: page.summary,
      };
    });
  }

  listConversations(simulationId: string, query: ConversationListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeConversationCursor(query.cursor, location.runId);
      const page = new SqliteObservabilityReadStore(db, location.runId)
        .listConversations(query, cursor);
      return {
        items: page.items,
        nextCursor: page.next === null ? null : encodeConversationCursor(page.next),
      };
    });
  }

  getConversation(simulationId: string, conversationId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqliteObservabilityReadStore(db, location.runId).getConversation(conversationId));
  }

  listCompanies(simulationId: string, query: CompanyListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodePhase4Cursor(query.cursor, location.runId, "companies");
      const page = phase4Page(
        new SqlitePhase4ReadStore(db, location.runId).listCompanies(query),
        query.limit,
        cursor,
        (company) => company.foundedTick,
      );
      const last = page.items.at(-1);
      return {
        items: page.items,
        nextCursor: page.hasMore && last !== undefined
          ? encodePhase4Cursor({
              runId: location.runId,
              view: "companies",
              order: last.foundedTick,
              id: last.id,
            })
          : null,
      };
    });
  }

  getCompany(simulationId: string, companyId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqlitePhase4ReadStore(db, location.runId).getCompany(companyId)
    );
  }

  listContracts(simulationId: string, query: ContractListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodePhase4Cursor(query.cursor, location.runId, "contracts");
      const all = new SqlitePhase4ReadStore(db, location.runId).listContracts(query) as readonly (
        Readonly<Record<string, unknown>> & { readonly id: string }
      )[];
      const page = phase4Page(all, query.limit, cursor, () => 0);
      const last = page.items.at(-1);
      return {
        items: page.items,
        nextCursor: page.hasMore && last !== undefined
          ? encodePhase4Cursor({
              runId: location.runId,
              view: "contracts",
              order: 0,
              id: last.id,
            })
          : null,
      };
    });
  }

  getContract(simulationId: string, contractId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqlitePhase4ReadStore(db, location.runId).getContract(contractId)
    );
  }

  listJobs(simulationId: string, query: JobListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodePhase4Cursor(query.cursor, location.runId, "jobs");
      const all = new SqlitePhase4ReadStore(db, location.runId).listJobs(query) as readonly (
        Readonly<Record<string, unknown>> & {
          readonly id: string;
          readonly postedTick: number;
        }
      )[];
      const page = phase4Page(all, query.limit, cursor, (job) => job.postedTick);
      const last = page.items.at(-1);
      return {
        items: page.items,
        nextCursor: page.hasMore && last !== undefined
          ? encodePhase4Cursor({
              runId: location.runId,
              view: "jobs",
              order: last.postedTick,
              id: last.id,
            })
          : null,
      };
    });
  }

  getJob(simulationId: string, jobId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqlitePhase4ReadStore(db, location.runId).getJob(jobId)
    );
  }

  listInstitutions(simulationId: string, query: InstitutionListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => ({
      items: new SqlitePhase4ReadStore(db, location.runId).listInstitutions(query),
      nextCursor: null,
    }));
  }

  getInstitution(simulationId: string, institutionId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqlitePhase4ReadStore(db, location.runId).getInstitution(institutionId)
    );
  }

  getGoodsMarket(simulationId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqlitePhase4ReadStore(db, location.runId).goodsMarket()
    );
  }

  listAgents(simulationId: string, query: AgentListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeAgentCursor(query.cursor, location.runId);
      const store = new SqliteAgentStore(db, location.runId);
      const page = store.listAgents({
        limit: query.limit + 1,
        ...(cursor === undefined ? {} : { afterAgentId: cursor.agentId }),
        ...(query.occupation === undefined ? {} : { occupation: query.occupation }),
        ...(query.employmentStatus === undefined
          ? {}
          : { employmentStatus: query.employmentStatus }),
        ...(query.search === undefined ? {} : { search: query.search }),
      });
      const items = page.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          page.length > items.length && last !== undefined
            ? encodeAgentCursor({ runId: location.runId, agentId: last.id })
            : null,
      };
    });
  }

  getAgent(simulationId: string, agentId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) => {
      const profile = new SqliteAgentStore(db, location.runId).getProfile(agentId);
      return {
        agent: {
          id: profile.agent.id,
          name: profile.persona.name,
          age: profile.persona.age,
          ...(profile.persona.gender === undefined ? {} : { gender: profile.persona.gender }),
          education: profile.persona.education,
          occupation: profile.agent.occupationCode,
          employmentStatus: profile.agent.employmentStatus,
          householdId: profile.agent.householdId,
          creditScore: profile.agent.creditScore,
          personality: profile.persona.personality,
          opinions: profile.persona.opinions,
          goals: profile.goals,
          skills: profile.persona.skills,
          bioSummary: profile.persona.bioSummary,
          promptVersion: profile.persona.promptVersion,
          quarantine: profile.agent.quarantine.mode === "none"
            ? null
            : profile.agent.quarantine,
          annualIncome: { cents: profile.annualIncomeCents },
          roleCode: profile.roleCode,
          organizationId: profile.organizationId,
          memoryHighlights: profile.memoryHighlights.map((memory) => ({
            id: memory.id,
            tick: memory.tick,
            kind: memory.kind,
            content: memory.content,
            importance: memory.importance,
            references: memory.references,
          })),
        },
      };
    });
  }

  getAgentFinances(simulationId: string, agentId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqliteFinanceStore(db, location.runId).agentFinances(agentId)
    );
  }

  listBanks(simulationId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) => ({
      items: new SqliteFinanceStore(db, location.runId).listBanks(),
      nextCursor: null,
    }));
  }

  getBank(simulationId: string, bankId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqliteFinanceStore(db, location.runId).getBank(bankId)
    );
  }

  listLoans(simulationId: string, query: LoanListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodePhase4Cursor(query.cursor, location.runId, "loans");
      const page = phase4Page(
        new SqliteCreditReadStore(db, location.runId).listLoans(query),
        query.limit,
        cursor,
        (loan) => loan.openedTick,
      );
      const last = page.items.at(-1);
      return {
        items: page.items,
        nextCursor: page.hasMore && last !== undefined
          ? encodePhase4Cursor({
              runId: location.runId,
              view: "loans",
              order: last.openedTick,
              id: last.id,
            })
          : null,
      };
    });
  }

  getLoan(simulationId: string, loanId: string, runId?: string) {
    const location = this.locator.locate(simulationId, runId);
    return this.withDatabase(location, (db) =>
      new SqliteCreditReadStore(db, location.runId).getLoan(loanId)
    );
  }

  listIndicators(simulationId: string, query: IndicatorSeriesQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const store = new SqliteFinanceStore(db, location.runId);
      const definitions = query.series.map((name) => ({ name, ...INDICATOR_SERIES[name] }));
      const points = store.listIndicatorPoints({
        series: [...new Set(definitions.map((definition) => definition.key))],
        ...(query.fromTick === undefined ? {} : { fromTick: query.fromTick }),
        ...(query.toTick === undefined ? {} : { toTick: query.toTick }),
        step: query.step,
        max: query.max,
      });
      return {
        series: definitions.map((definition) => ({
          name: definition.name,
          unit: definition.unit,
          points: points
            .filter((point) => point.series === definition.key)
            .map((point) => [
              point.tick,
              definition.unit === "cents" ? point.value : Number(point.value),
            ] as [number, number | string]),
        })),
      };
    });
  }

  listTransactions(simulationId: string, query: TransactionListQuery) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const beforeId = query.cursor === undefined
        ? undefined
        : decodeTransactionCursor(query.cursor, location.runId).transactionId;
      const page = new SqliteFinanceStore(db, location.runId).listTransactions({
        limit: query.limit,
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.fromTick === undefined ? {} : { fromTick: query.fromTick }),
        ...(query.toTick === undefined ? {} : { toTick: query.toTick }),
        ...(query.correlationId === undefined
          ? {}
          : { correlationId: query.correlationId }),
      });
      return {
        items: page.items.map((transaction) => ({
          id: transaction.id,
          tick: transaction.tick,
          kind: transaction.kind,
          legs: transaction.legs.map((leg) => ({
            accountId: leg.accountId,
            owner: {
              kind: leg.ownerKind,
              id: leg.ownerId,
              name: leg.ownerName,
            },
            direction: leg.direction,
            amount: leg.amountCents,
          })),
          reason: transaction.reason,
          actor: transaction.actor,
          sourceEventId: transaction.sourceEventId,
          correlationId: transaction.correlationId,
        })),
        nextCursor: page.nextId === null
          ? null
          : encodeTransactionCursor({
              runId: location.runId,
              transactionId: page.nextId,
            }),
      };
    });
  }

  listAgentRelationships(
    simulationId: string,
    agentId: string,
    query: RelationshipListQuery,
  ) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeRelationshipCursor(query.cursor, location.runId, agentId);
      const page = new SqliteAgentStore(db, location.runId).listRelationships(agentId, {
        limit: query.limit + 1,
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(cursor === undefined
          ? {}
          : { after: { strength: cursor.strength, toAgentId: cursor.toAgentId } }),
      });
      const items = page.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          page.length > items.length && last !== undefined
            ? encodeRelationshipCursor({
                runId: location.runId,
                agentId,
                strength: last.strength,
                toAgentId: last.toAgent.id,
              })
            : null,
      };
    });
  }

  listAgentDecisions(
    simulationId: string,
    agentId: string,
    query: AgentDecisionListQuery,
  ) {
    const location = this.locator.locate(simulationId, query.runId);
    return this.withDatabase(location, (db) => {
      const cursor = query.cursor === undefined
        ? undefined
        : decodeAgentDecisionCursor(query.cursor, location.runId, agentId);
      const page = new SqliteAgentStore(db, location.runId).listDecisions(agentId, {
        limit: query.limit + 1,
        ...(query.tier === undefined ? {} : { tier: query.tier }),
        ...(query.fromTick === undefined ? {} : { fromTick: query.fromTick }),
        ...(query.toTick === undefined ? {} : { toTick: query.toTick }),
        ...(cursor === undefined
          ? {}
          : { before: { tick: cursor.tick, decisionId: cursor.decisionId } }),
      });
      const selected = page.slice(0, query.limit);
      const items = selected.map((decision) => ({
        id: decision.id,
        tick: decision.tick,
        trigger: {
          kind: decision.trigger.kind,
          sourceEventId: decision.trigger.sourceEventId,
        },
        tier: decision.tier,
        observation: decision.observationDigest,
        optionsOffered: decision.optionsOffered.map((option) => ({
          actionId: option.actionId,
          summary: option.actionType + " utility=" + option.utility,
        })),
        chosen: decision.chosenActionId === undefined
          ? null
          : {
              actionId: decision.chosenActionId,
              params: decision.params ?? {},
            },
        rationale: decision.rationale,
        validation: decision.validationResult.status === "approved"
          ? { result: "approved" as const }
          : {
              result: "rejected" as const,
              code: decision.validationResult.code,
            },
        ...(decision.llmCallId === undefined
          ? {}
          : {
              llm: {
                callId: decision.llmCallId,
                promptPackKey: decision.promptPackKey!,
                promptVersion: decision.promptVersion!,
                promptHash: decision.promptHash!,
              },
            }),
      }));
      const last = selected.at(-1);
      return {
        items,
        nextCursor:
          page.length > selected.length && last !== undefined
            ? encodeAgentDecisionCursor({
                runId: location.runId,
                agentId,
                tick: last.tick,
                decisionId: last.id,
              })
            : null,
      };
    });
  }

  private enqueueAdvanceTask(
    location: RunLocation,
    ticks: number,
    requestId: string,
  ): ApiTask {
    return this.withDatabase(location, (db) => {
      const repository = new SqliteRunRepository(db);
      const taskStore = new SqliteApiTaskStore(db, location.runId);
      const before = repository.getRun(location.runId);
      assertCanAdvance(before.status);
      if (ticks > before.endTick - before.currentTick) {
        throw new EngineError(
          "CONFLICT",
          `cannot advance ${ticks} ticks with only ${before.endTick - before.currentTick} remaining`,
        );
      }
      const active = taskStore.getActive();
      if (active !== null) {
        throw new EngineError("CONFLICT", `run already has active API task ${active.id}`);
      }

      const wallTime = this.wallClock();
      return db.transaction(() => {
        const current = repository.getRun(location.runId);
        assertCanAdvance(current.status);
        if (
          current.currentTick !== before.currentTick ||
          current.nextEventSeq !== before.nextEventSeq
        ) {
          throw new EngineError("CONFLICT", "stale async advance checkpoint");
        }
        const ids = IdFactory.restore(current.idState);
        const taskId = ids.next("task");
        const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
          type: "admin.command.received",
          correlationId: requestId,
          payload: {
            command: "advance",
            params: { runId: current.id, ticks, taskId },
            requestId,
          },
        });
        new SqliteEventStore(db, current.id).append(command);
        const updated = db.prepare(`
          UPDATE simulation_runs
          SET id_state_canonical = @idState
          WHERE id = @runId
            AND status = 'paused'
            AND current_tick = @currentTick
            AND next_event_seq = @nextEventSeq
        `).run({
          runId: current.id,
          currentTick: current.currentTick,
          nextEventSeq: current.nextEventSeq + 1,
          idState: canonicalStringify(ids.serialize()),
        });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", "stale async advance journal checkpoint");
        }
        return taskStore.createAdvanceTask({
          id: taskId,
          startTick: current.currentTick,
          targetTick: current.currentTick + ticks,
          wallTime,
        });
      }).immediate();
    });
  }

  private recoverAdvanceTasks(): void {
    for (const location of this.locator.list()) {
      const active = this.withDatabase(
        location,
        (db) => new SqliteApiTaskStore(db, location.runId).getActive(),
      );
      if (active !== null) {
        if (this.logger !== undefined) {
          childRunLogger(this.logger, {
            simulationId: location.simulationId,
            runId: location.runId,
            tick: this.currentRunTick(location),
            correlationId: active.id,
          }).warn(
            { event: "simulation.advance.recovered", taskId: active.id, status: active.status },
            "recovering unfinished simulation advance task",
          );
        }
        this.scheduleAdvanceTask(location, active.id);
      }
    }
  }

  private scheduleAdvanceTask(location: RunLocation, taskId: string): void {
    if (this.closed) return;
    const key = this.taskKey(location, taskId);
    if (this.taskTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.taskTimers.delete(key);
      void this.runAdvanceTaskStep(location, taskId);
    }, 0);
    timer.unref();
    this.taskTimers.set(key, timer);
  }

  private async runAdvanceTaskStep(location: RunLocation, taskId: string): Promise<void> {
    if (this.closed) return;
    const release = this.tryEnterRunOperation(location);
    if (release === null) {
      this.scheduleAdvanceTask(location, taskId);
      return;
    }
    try {
      const shouldContinue = await this.withDatabaseAsync(location, async (db) => {
        const taskStore = new SqliteApiTaskStore(db, location.runId);
        let task = taskStore.get(taskId);
        if (task.status === "completed" || task.status === "failed") return false;
        if (task.status === "pending") task = taskStore.markRunning(task.id, this.wallClock());

        const repository = new SqliteRunRepository(db);
        let run = repository.getRun(location.runId);
        if (run.currentTick > task.targetTick) {
          throw new EngineError("CONFLICT", `run advanced beyond API task ${task.id}`);
        }
        if (run.currentTick === task.targetTick) {
          if (run.currentTick === run.endTick && run.status !== "completed") {
            run = this.completeRun(db, run.id, task.id);
          }
          taskStore.markCompleted(task.id, this.wallClock());
          this.logAdvanceTaskCompleted(location, task, run.currentTick);
          return false;
        }
        if (run.status !== "paused") {
          throw new EngineError(
            "CONFLICT",
            `API task ${task.id} requires a paused run, found ${run.status}`,
          );
        }

        const result = await this.executeTicks(
          db,
          run.simulationId,
          run.id,
          Math.min(ASYNC_ADVANCE_CHUNK_TICKS, task.targetTick - run.currentTick),
          task.id,
        );
        run = result.run;
        if (run.currentTick === task.targetTick) {
          if (run.currentTick === run.endTick) {
            run = this.completeRun(db, run.id, task.id);
          }
          taskStore.markCompleted(task.id, this.wallClock());
          this.logAdvanceTaskCompleted(location, task, run.currentTick);
          return false;
        }
        return true;
      });
      if (shouldContinue) this.scheduleAdvanceTask(location, taskId);
    } catch (error) {
      this.failAdvanceTask(location, taskId, error);
    } finally {
      release();
    }
  }

  private failAdvanceTask(location: RunLocation, taskId: string, cause: unknown): void {
    const errorText = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000);
    try {
      this.withDatabase(location, (db) => {
        const store = new SqliteApiTaskStore(db, location.runId);
        const task = store.get(taskId);
        if (task.status === "pending" || task.status === "running") {
          store.markFailed(taskId, this.wallClock(), errorText || "unknown task failure");
        }
      });
    } catch {
      // The active row remains recoverable on restart if failure recording itself fails.
    }
    this.logRunOperationFailure(
      location,
      taskId,
      "simulation.advance.failed",
      cause,
      { taskId },
    );
  }

  private logAdvanceTaskCompleted(
    location: RunLocation,
    task: ApiTask,
    currentTick: number,
  ): void {
    if (this.logger === undefined) return;
    childRunLogger(this.logger, {
      simulationId: location.simulationId,
      runId: location.runId,
      tick: currentTick,
      correlationId: task.id,
    }).info(
      { event: "simulation.advance.completed", taskId: task.id, targetTick: task.targetTick },
      "simulation advance task completed",
    );
  }

  private taskKey(location: RunLocation, taskId: string): string {
    return `${this.runKey(location)}/${taskId}`;
  }

  private createTier2Provider(
    db: WorldDatabase,
    run: SimulationRun,
    cacheOnly = false,
  ): RoutedLlmProvider {
    let base: RoutedLlmProvider;
    let deterministicLatency = cacheOnly;
    try {
      if (cacheOnly && run.manifest.llmMode === "live") {
        const route = resolveLiveProviderRoute(run.manifest.modelRouting, this.kimiModel);
        base = route.family === "anthropic"
          ? new TierRoutedLlmProvider(
              unavailableLlmProvider({
                provider: "anthropic",
                model: route.tier2Model,
                detail: "replay is cache-only",
                code: "unknown",
              }),
              unavailableLlmProvider({
                provider: "anthropic",
                model: route.tier3Model,
                detail: "replay is cache-only",
                code: "unknown",
              }),
            )
          : new TierRoutedLlmProvider(
              unavailableLlmProvider({
                provider: "minimax",
                model: route.tier2Model,
                detail: "replay is cache-only",
                code: "unknown",
              }),
              unavailableLlmProvider({
                provider: "kimi",
                model: route.tier3Model,
                detail: "replay is cache-only",
                code: "unknown",
              }),
            );
      } else if (this.llmProviderFactory !== undefined && !cacheOnly) {
        base = this.llmProviderFactory({ db, run });
      } else if (run.manifest.llmMode === "mock") {
        base = new MockLlmProvider({
          model: run.manifest.modelRouting["tier2_routine"] ?? "mock-llm-v1",
        });
        deterministicLatency = true;
      } else {
        const route = resolveLiveProviderRoute(run.manifest.modelRouting, this.kimiModel);
        if (route.family === "anthropic") {
          if (this.anthropicApiKey === undefined) {
            base = new TierRoutedLlmProvider(
              unavailableLlmProvider({
                provider: "anthropic",
                model: route.tier2Model,
                detail: "ANTHROPIC_API_KEY is not configured; using deterministic Tier-1 fallback",
                code: "authentication",
              }),
              unavailableLlmProvider({
                provider: "anthropic",
                model: route.tier3Model,
                detail: "ANTHROPIC_API_KEY is not configured; using deterministic Tier-1 fallback",
                code: "authentication",
              }),
            );
          } else {
            base = new AnthropicLlmProvider({
              transport: new AnthropicFetchTransport({ apiKey: this.anthropicApiKey }),
              models: { tier2: route.tier2Model, tier3: route.tier3Model },
            });
          }
        } else {
          const tier2 = this.minimaxApiKey === undefined
            ? unavailableLlmProvider({
                provider: "minimax",
                model: route.tier2Model,
                detail: "MINIMAX_API_KEY or MINIMAX_TOKEN_PLAN_KEY is not configured; using deterministic Tier-1 fallback",
                code: "authentication",
              })
            : new MiniMaxLlmProvider({
                transport: new OpenAiCompatibleFetchTransport({
                  provider: "minimax",
                  apiKey: this.minimaxApiKey,
                }),
                model: route.tier2Model,
              });
          const tier3 = this.kimiApiKey === undefined
            ? unavailableLlmProvider({
                provider: "kimi",
                model: route.tier3Model,
                detail: "KIMI_API_KEY or MOONSHOT_API_KEY is not configured; using deterministic Tier-1 fallback",
                code: "authentication",
              })
            : new KimiLlmProvider({
                transport: new OpenAiCompatibleFetchTransport({
                  provider: "kimi",
                  apiKey: this.kimiApiKey,
                  endpoint: this.kimiAccessMode === "code_plan"
                    ? KIMI_CODE_API_ENDPOINT
                    : KIMI_OPEN_PLATFORM_API_ENDPOINT,
                }),
                model: route.tier3Model,
                accessMode: this.kimiAccessMode,
              });
          base = new TierRoutedLlmProvider(tier2, tier3);
        }
      }
    } catch (error) {
      base = unavailableLlmProvider({
        provider: "unavailable",
        model: run.manifest.modelRouting["tier2_routine"] ?? "unavailable",
        detail: error instanceof Error ? error.message : "LLM provider construction failed",
        code: "unknown",
      });
    }
    const cached = new CachedLlmProvider({
      provider: base,
      cache: new SqliteLlmResponseCache(db, run.id),
      mode: cacheOnly ? "cache_only" : "read_write",
    });
    const replayed = cacheOnly
      ? new ReplayEvidenceLlmProvider(cached, db, run.id)
      : cached;
    const budgeted = new BudgetedLlmProvider({
      provider: replayed,
      controller: new SqliteLlmControlStore(db, run.id, {
        prices: this.llmModelPrices,
        wallClock: this.wallClock,
      }),
    });
    // Built-in mock and cache-only replay are deterministic evidence boundaries.
    // Injected/live providers retain measured latency for operational telemetry.
    return new TimedLlmProvider(
      budgeted,
      deterministicLatency ? () => 0 : this.monotonicClock,
    );
  }

  private async executeTicks(
    db: WorldDatabase,
    simulationId: string,
    runId: string,
    ticks: number,
    correlationId?: string,
    options: Readonly<{ cacheOnly?: boolean }> = {},
  ): Promise<{ run: SimulationRun; events: number }> {
    const repository = new SqliteRunRepository(db);
    const store = new SqliteEventStore(db, runId);
    const eventCountBeforeTicks = store.count();
    const logger = this.logger;
    let remaining = ticks;

    // Repair the narrow crash window where a due tick committed but its
    // post-commit backup did not. This is idempotent when the snapshot exists.
    await this.ensurePeriodicSnapshot(db, simulationId, runId, correlationId);

    const initialRun = repository.getRun(runId);
    const tier2Provider = this.enableAgentFramework && initialRun.manifest.llmMode !== "off"
      ? this.createTier2Provider(db, initialRun, options.cacheOnly ?? false)
      : undefined;
    let loop: SimLoop | undefined;

    while (remaining > 0) {
      const run = repository.getRun(runId);
      const beforePreparation = readRunCheckpoint(db, runId);
      const opportunities = tier2Provider === undefined
        ? []
        : discoverTier2DecisionOpportunities(
            db,
            runId,
            beforePreparation.currentTick + 1,
          );
      const tier2Batch = tier2Provider === undefined || opportunities.length === 0
        ? undefined
        : await prepareTier2DecisionBatch({
            db,
            runId,
            tick: beforePreparation.currentTick + 1,
            provider: tier2Provider,
            promptPackVersion: run.manifest.promptPackVersion,
            opportunities,
          });
      const conversationOpportunities = this.enableAgentFramework
        ? discoverConversationTurnOpportunities(
            db,
            runId,
            beforePreparation.currentTick + 1,
          )
        : [];
      const conversationBatch = conversationOpportunities.length === 0
        ? undefined
        : await prepareConversationBatch({
            db,
            runId,
            tick: beforePreparation.currentTick + 1,
            promptPackVersion: run.manifest.promptPackVersion,
            ...(tier2Provider === undefined ? {} : { provider: tier2Provider }),
            opportunities: conversationOpportunities,
          });
      const newsBatch = this.enableNewsPipeline && this.enableAgentFramework && tier2Provider !== undefined
        ? await prepareNewsStoryBatch({
            db,
            runId,
            tick: beforePreparation.currentTick + 1,
            provider: tier2Provider,
            promptPackVersion: run.manifest.promptPackVersion,
          })
        : undefined;
      if (
        tier2Batch !== undefined ||
        conversationBatch !== undefined ||
        newsBatch !== undefined
      ) loop = undefined;
      // Provider/cache/budget work can append authoritative events and advance
      // the ID checkpoint. Restore the tick loop only after that async barrier.
      const checkpoint = readRunCheckpoint(db, runId);
      if (checkpoint.currentTick !== beforePreparation.currentTick) {
        throw new EngineError("CONFLICT", "simulation tick changed during Tier-2 preparation");
      }
      if (loop === undefined) {
        const committer = new SqliteTickCommitter(db, store);
        loop = new SimLoop({
          simulationId,
          runId,
          seed: run.manifest.seed,
          bus: new EventBus(),
          log: store,
          ids: IdFactory.restore(checkpoint.idState),
          wallClock: this.wallClock,
          initialTick: checkpoint.currentTick,
          nextSeq: checkpoint.nextEventSeq,
          tickCommitter: committer,
          tickUnitOfWork: committer,
          ...(logger === undefined
            ? {}
            : {
                monotonicClock: () => performance.now(),
                phaseObserver: (sample: {
                  tick: number;
                  phase: string;
                  durationMs: number;
                }) => {
                  logPhaseTiming(logger, {
                    simulationId,
                    runId,
                    tick: sample.tick,
                    phase: sample.phase,
                    durationMs: sample.durationMs,
                    ...(correlationId === undefined ? {} : { correlationId }),
                  });
                },
              }),
        });
        loop.registerPhase(
          "obligations",
          createSchedulerPhaseHandler(
            new SqliteScheduler(db, runId),
            {
              dispatch: (task, ctx) => {
                if (task.taskRef === WORLD_EVENT_TASK_REF) {
                  new SqliteWorldEventStore(db, runId).applyTask(task, ctx);
                  return;
                }
                this.scheduledTaskDispatcher.dispatch(task, ctx);
              },
            },
          ),
        );
        if (this.enableAgentFramework) {
          loop.registerPhase(
            "perception",
            createGoalActivationPhaseHandler(db, runId, {
              automatic: run.manifest.llmMode === "off",
            }),
          );
          if (tier2Batch !== undefined) {
            loop.registerPhase(
              "decisions",
              createTier2DecisionPhaseHandler(db, runId, tier2Batch),
            );
          }
          loop.registerPhase(
            "decisions",
            createConversationPhaseHandler(db, runId, conversationBatch),
          );
          loop.registerPhase(
            "decisions",
            createInvestmentProposalPhaseHandler(db, runId),
          );
          loop.registerPhase(
            "decisions",
            createNegotiationBindingPhaseHandler(db, runId),
          );
          loop.registerPhase(
            "decisions",
            createAgentDecisionPhaseHandler(db, runId, {
              ...(this.enableNewsPipeline
                ? {
                    reservedActionCountsForTick: (tick: number) => {
                      const work = newsBatch?.tick === tick
                        ? newsBatch
                        : discoverNewsStoryOpportunities(db, runId, tick);
                      const counts: Record<string, number> = {};
                      for (const opportunity of work.opportunities) {
                        counts[opportunity.authorAgentId] =
                          (counts[opportunity.authorAgentId] ?? 0) + 1;
                      }
                      return Object.freeze(counts);
                    },
                  }
                : {}),
            }),
          );
          for (const finance of createFinancePhaseHandlers(db, runId)) {
            loop.registerPhase(finance.phase, finance.handler);
          }
          for (const phase4 of createPhase4Handlers(db, runId, {
            laborDecisionMode: run.manifest.llmMode === "off" ? "tier1" : "tier2",
          })) {
            loop.registerPhase(phase4.phase, phase4.handler);
          }
          if (this.enableNewsPipeline) {
            loop.registerPhase(
              "news",
              createNewsStoryPhaseHandler(db, runId, {
                mode: run.manifest.llmMode,
                ...(newsBatch === undefined ? {} : { batch: newsBatch }),
              }),
            );
            loop.registerPhase("news", createSentimentPhaseHandler(db, runId));
          }
        }
      }
      const ticksThisPass = tier2Provider === undefined && conversationBatch === undefined
        ? Math.min(
            remaining,
            this.snapshotIntervalTicks - (checkpoint.currentTick % this.snapshotIntervalTicks),
          )
        : 1;
      loop.advance(ticksThisPass);
      remaining -= ticksThisPass;
      const completedTick = repository.getRun(runId).currentTick;
      if (
        tier2Batch !== undefined ||
        conversationBatch !== undefined ||
        newsBatch !== undefined ||
        completedTick % this.snapshotIntervalTicks === 0
      ) {
        loop = undefined;
      }
      if (completedTick % this.snapshotIntervalTicks === 0) {
        await this.ensurePeriodicSnapshot(db, simulationId, runId, correlationId);
      }
    }
    return {
      run: repository.getRun(runId),
      events: store.count() - eventCountBeforeTicks,
    };
  }

  private async ensurePeriodicSnapshot(
    db: WorldDatabase,
    simulationId: string,
    runId: string,
    correlationId?: string,
  ): Promise<void> {
    const run = new SqliteRunRepository(db).getRun(runId);
    if (
      run.currentTick === 0 ||
      run.currentTick % this.snapshotIntervalTicks !== 0
    ) {
      return;
    }
    const store = new SqliteSnapshotStore(
      db,
      this.dataDir,
      simulationId,
      runId,
    );
    if (store.getAtTick(run.currentTick) !== null) return;
    const snapshot = await store.create({ createdWall: this.wallClock() });
    if (this.logger !== undefined) {
      childRunLogger(this.logger, {
        simulationId,
        runId,
        tick: snapshot.tick,
        ...(correlationId === undefined ? {} : { correlationId }),
      }).info(
        {
          event: "simulation.snapshot.created",
          snapshotId: snapshot.id,
          stateHash: snapshot.stateHash,
        },
        "periodic simulation snapshot created",
      );
    }
  }

  private completeRun(
    db: WorldDatabase,
    runId: string,
    correlationId: string,
    causationId?: string,
  ): SimulationRun {
    const repository = new SqliteRunRepository(db);
    const current = repository.getRun(runId);
    if (current.status === "completed") return current;
    if (current.currentTick !== current.endTick) {
      throw new EngineError("CONFLICT", "run cannot complete before its end tick");
    }
    const wallTime = this.wallClock();
    const completed = repository.transitionRun(
      { runId, command: "complete", wallTime, expectedStatus: current.status },
      ({ current: checkpoint }) => {
        const ids = IdFactory.restore(checkpoint.idState);
        const event = apiEvent(checkpoint, ids, checkpoint.nextEventSeq, wallTime, {
          type: "simulation.completed",
          correlationId,
          ...(causationId === undefined ? {} : { causationId }),
          actor: SYSTEM_ACTOR,
          payload: {
            status: "completed",
            ...(causationId === undefined ? {} : { byCommandEventId: causationId }),
          },
        });
        new SqliteEventStore(db, runId).append(event);
        return ids.serialize();
      },
    );
    if (this.logger !== undefined) {
      childRunLogger(this.logger, {
        simulationId: completed.simulationId,
        runId: completed.id,
        tick: completed.currentTick,
        correlationId,
      }).info({ event: "simulation.completed" }, "simulation completed");
    }
    return completed;
  }

  private scheduleExport(
    location: RunLocation,
    exportId: string,
    delayMs = 0,
  ): void {
    if (this.closed || this.exportTimers.has(exportId)) return;
    const timer = setTimeout(() => {
      this.exportTimers.delete(exportId);
      void this.runExport(location, exportId);
    }, delayMs);
    timer.unref();
    this.exportTimers.set(exportId, timer);
  }

  private async runExport(location: RunLocation, exportId: string): Promise<void> {
    if (this.closed) return;
    const release = this.tryEnterRunOperation(location);
    if (release === null) {
      this.scheduleExport(location, exportId, Math.min(this.tickIntervalMs, 50));
      return;
    }
    try {
      this.withDatabase(location, (db) => {
        const store = new SqliteExportStore(db, location.runId);
        let job = store.get(exportId);
        if (job.status === "queued") job = store.markRunning(exportId, this.wallClock());
        if (job.status !== "running") return;
        const run = new SqliteRunRepository(db).getRun(location.runId);
        if (run.status === "running") {
          throw new EngineError("CONFLICT", "export source resumed before materialization");
        }
        if (run.currentTick !== job.sourceTick) {
          throw new EngineError(
            "CONFLICT",
            `export source tick changed from ${job.sourceTick} to ${run.currentTick}`,
          );
        }
        const currentHash = computeLogicalStateHash(db, location.runId);
        if (currentHash !== job.sourceStateHash) {
          throw new EngineError("CONFLICT", "export source state changed before materialization");
        }
        const artifacts = materializeExport(db, location, job);
        store.complete(exportId, {
          files: artifacts.files,
          manifest: artifacts.manifest,
          completedWall: this.wallClock(),
        });
      });
    } catch (error) {
      try {
        this.withDatabase(location, (db) => {
          const store = new SqliteExportStore(db, location.runId);
          const job = store.get(exportId);
          if (job.status !== "queued" && job.status !== "running") return;
          store.fail(exportId, {
            errorCode: error instanceof EngineError ? error.code : "INTERNAL",
            errorMessage: error instanceof Error ? error.message : String(error),
            completedWall: this.wallClock(),
          });
        });
      } catch (journalError) {
        this.logRunOperationFailure(
          location,
          exportId,
          "simulation.export.failure_journal.failed",
          journalError,
        );
      }
      this.logRunOperationFailure(
        location,
        exportId,
        "simulation.export.failed",
        error,
      );
    } finally {
      release();
    }
  }

  private scheduleReplay(location: RunLocation): void {
    if (this.closed) return;
    const key = this.runKey(location);
    if (this.replayTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.replayTimers.delete(key);
      void this.runReplay(location);
    }, 0);
    timer.unref();
    this.replayTimers.set(key, timer);
  }

  private async runReplay(location: RunLocation): Promise<void> {
    if (this.closed) return;
    const release = this.tryEnterRunOperation(location);
    if (release === null) {
      this.scheduleReplay(location);
      return;
    }
    try {
      await this.withDatabaseAsync(location, async (targetDb) => {
        const replayStore = new SqliteReplayStore(targetDb, location.runId);
        const replay = replayStore.require();
        if (replay.status !== "running") return;
        const sourceLocation = this.locator.locate(
          replay.sourceSimulationId,
          replay.replayOf,
        );
        const sourceDb = openDatabaseFile(sourceLocation.databasePath);
        try {
          await this.executeReplay(targetDb, sourceDb, location, replayStore);
        } finally {
          sourceDb.close();
        }
      });
    } catch (error) {
      try {
        this.withDatabase(location, (db) => {
          const store = new SqliteReplayStore(db, location.runId);
          const replay = store.get();
          if (replay === null || replay.status !== "running") return;
          const run = new SqliteRunRepository(db).getRun(location.runId);
          store.fail({
            currentTick: run.currentTick,
            lastComparedSeq: Math.max(replay.lastComparedSeq, run.nextEventSeq - 1),
            errorCode: error instanceof EngineError ? error.code : "INTERNAL",
            errorMessage: error instanceof Error ? error.message : String(error),
            completedWall: this.wallClock(),
          });
        });
      } catch (journalError) {
        this.logRunOperationFailure(
          location,
          `${location.runId}:replay_failure`,
          "simulation.replay.failure_journal.failed",
          journalError,
        );
      }
      this.logRunOperationFailure(
        location,
        `${location.runId}:replay_failure`,
        "simulation.replay.failed",
        error,
      );
    } finally {
      release();
    }
  }

  private async executeReplay(
    targetDb: WorldDatabase,
    sourceDb: WorldDatabase,
    location: RunLocation,
    replayStore: SqliteReplayStore,
  ): Promise<void> {
    let replay = replayStore.require();
    const sourceRun = new SqliteRunRepository(sourceDb).getRun(replay.replayOf);
    const sourceEvents = new SqliteEventStore(sourceDb, replay.replayOf).list();
    const sourceCache = new SqliteLlmResponseCache(sourceDb, replay.replayOf).exportArtifact();
    if (replay.journalDigest !== replayJournalDigest(sourceEvents)) {
      throw new EngineError("CONFLICT", "source replay journal changed after replay creation");
    }
    if (replay.cacheArtifactDigest !== sourceCache.digest) {
      throw new EngineError("CONFLICT", "source LLM cache changed after replay creation");
    }

    let targetRun = new SqliteRunRepository(targetDb).getRun(location.runId);
    if (replay.lastComparedSeq < targetRun.nextEventSeq - 1) {
      this.compareReplayRange(
        targetDb,
        replayStore,
        sourceEvents,
        replay.lastComparedSeq + 1,
        targetRun.nextEventSeq,
        targetRun.currentTick,
      );
      replayStore.updateProgress(targetRun.currentTick, targetRun.nextEventSeq - 1);
      replay = replayStore.require();
    }
    if (replay.mode === "strict" && replay.divergenceCount > 0) {
      this.finishReplay(targetDb, sourceDb, replayStore, sourceRun, false);
      return;
    }

    while (targetRun.currentTick < replay.toTick) {
      const boundaryComplete = this.applyReplayBoundary(
        targetDb,
        replayStore,
        sourceEvents,
        false,
      );
      replay = replayStore.require();
      if (!boundaryComplete || (replay.mode === "strict" && replay.divergenceCount > 0)) {
        this.finishReplay(targetDb, sourceDb, replayStore, sourceRun, false);
        return;
      }

      const fromSeq = new SqliteRunRepository(targetDb).getRun(location.runId).nextEventSeq;
      await this.executeTicks(
        targetDb,
        location.simulationId,
        location.runId,
        1,
        `${location.runId}:replay`,
        { cacheOnly: true },
      );
      targetRun = new SqliteRunRepository(targetDb).getRun(location.runId);
      this.compareReplayRange(
        targetDb,
        replayStore,
        sourceEvents,
        fromSeq,
        targetRun.nextEventSeq,
        targetRun.currentTick,
      );
      replayStore.updateProgress(targetRun.currentTick, targetRun.nextEventSeq - 1);
      replay = replayStore.require();
      if (replay.mode === "strict" && replay.divergenceCount > 0) {
        this.finishReplay(targetDb, sourceDb, replayStore, sourceRun, false);
        return;
      }
    }

    if (replay.toTick === sourceRun.currentTick) {
      this.applyReplayBoundary(targetDb, replayStore, sourceEvents, true);
    }
    this.finishReplay(targetDb, sourceDb, replayStore, sourceRun, true);
  }

  private applyReplayBoundary(
    db: WorldDatabase,
    replayStore: SqliteReplayStore,
    sourceEvents: readonly EventEnvelope[],
    allowTerminalFact: boolean,
  ): boolean {
    while (true) {
      const run = new SqliteRunRepository(db).getRun(replayStore.require().id);
      const expected = sourceEvents[run.nextEventSeq];
      if (expected === undefined || expected.tick !== run.currentTick) return true;
      const fromSeq = run.nextEventSeq;
      if (expected.type === "admin.command.received") {
        const command = parseReplayJournalCommand(expected);
        const applied = this.applyReplayCommand(db, run, command);
        if (!applied) {
          replayStore.recordDivergence({
            tick: run.currentTick,
            kind: "unsupported_journal_command",
            expectedHash: replayEventHash(expected),
            details: { command: command.command, seq: command.seq },
            createdWall: this.wallClock(),
          });
          return false;
        }
      } else if (allowTerminalFact && expected.type === "simulation.completed") {
        this.completeRun(
          db,
          run.id,
          expected.correlationId,
          expected.causationId,
        );
      } else {
        // Provider preparation for tick N+1 emits authoritative evidence at
        // the current tick N. The tick executor, not the boundary journal,
        // owns those non-admin events.
        return true;
      }
      const after = new SqliteRunRepository(db).getRun(run.id);
      this.compareReplayRange(
        db,
        replayStore,
        sourceEvents,
        fromSeq,
        after.nextEventSeq,
        after.currentTick,
      );
      replayStore.updateProgress(after.currentTick, after.nextEventSeq - 1);
      const replay = replayStore.require();
      if (replay.mode === "strict" && replay.divergenceCount > 0) return false;
    }
  }

  private applyReplayCommand(
    db: WorldDatabase,
    run: SimulationRun,
    command: ReturnType<typeof parseReplayJournalCommand>,
  ): boolean {
    if (
      command.command === "start" ||
      command.command === "pause" ||
      command.command === "resume" ||
      command.command === "stop"
    ) {
      this.applyReplayLifecycleCommand(db, run, command.command, command.requestId);
      return true;
    }
    if (command.command === "advance") {
      this.applyReplayAdvanceCommand(db, run, command.params, command.requestId);
      return true;
    }
    if (command.command === "world_event.inject") {
      const { scheduledTick, ...params } = command.params;
      const input = injectWorldEventRequestSchema.parse({
        ...params,
        runId: run.id,
        scheduleTick: scheduledTick,
      });
      this.applyReplayWorldEventCommand(db, run, input, command.requestId);
      return true;
    }
    if (
      command.command === "set_llm_enabled" ||
      command.command === "set_module_frozen" ||
      command.command === "set_agent_quarantine"
    ) {
      const input = llmControlRequestSchema.parse({
        ...command.params,
        runId: run.id,
      });
      new SqliteLlmControlStore(db, run.id).applyControl(
        input,
        command.requestId,
        this.wallClock(),
      );
      return true;
    }
    return false;
  }

  private applyReplayLifecycleCommand(
    db: WorldDatabase,
    run: SimulationRun,
    control: SimulationControl,
    requestId: string,
  ): void {
    const repository = new SqliteRunRepository(db);
    const wallTime = this.wallClock();
    repository.transitionRun(
      { runId: run.id, command: control as RunCommand, wallTime },
      ({ current, nextStatus }) => {
        const ids = IdFactory.restore(current.idState);
        const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
          type: "admin.command.received",
          correlationId: requestId,
          payload: {
            command: control,
            params: { runId: current.id },
            requestId,
          },
        });
        const fact = apiEvent(current, ids, current.nextEventSeq + 1, wallTime, {
          type: lifecycleType(control),
          correlationId: requestId,
          causationId: command.eventId,
          payload: { status: nextStatus, byCommandEventId: command.eventId },
        });
        new SqliteEventStore(db, current.id).appendBatch([command, fact]);
        if (control === "start") {
          const activated = db.prepare(`
            UPDATE simulations SET status = 'active'
            WHERE id = ? AND status = 'created'
          `).run(current.simulationId);
          if (activated.changes !== 1) {
            throw new EngineError("CONFLICT", "replay simulation could not be activated");
          }
        }
        return ids.serialize();
      },
    );
  }

  private applyReplayAdvanceCommand(
    db: WorldDatabase,
    run: SimulationRun,
    params: Readonly<Record<string, unknown>>,
    requestId: string,
  ): void {
    const ticks = params["ticks"];
    if (!Number.isSafeInteger(ticks) || (ticks as number) < 1) {
      throw new EngineError("INTERNAL", "source advance command has invalid ticks");
    }
    db.transaction(() => {
      const current = new SqliteRunRepository(db).getRun(run.id);
      const ids = IdFactory.restore(current.idState);
      const sourceTaskId = params["taskId"];
      let taskId: string | undefined;
      if (sourceTaskId !== undefined) {
        if (typeof sourceTaskId !== "string") {
          throw new EngineError("INTERNAL", "source advance task ID is invalid");
        }
        taskId = ids.next("task");
        if (taskId !== sourceTaskId) {
          throw new EngineError("CONFLICT", "replay advance task ID diverged");
        }
      }
      const wallTime = this.wallClock();
      const event = apiEvent(current, ids, current.nextEventSeq, wallTime, {
        type: "admin.command.received",
        correlationId: requestId,
        payload: {
          command: "advance",
          params: {
            runId: current.id,
            ticks,
            ...(taskId === undefined ? {} : { taskId }),
          },
          requestId,
        },
      });
      new SqliteEventStore(db, current.id).append(event);
      const updated = db.prepare(`
        UPDATE simulation_runs SET id_state_canonical = @idState
        WHERE id = @runId AND status = 'paused'
          AND current_tick = @currentTick AND next_event_seq = @nextEventSeq
      `).run({
        runId: current.id,
        currentTick: current.currentTick,
        nextEventSeq: current.nextEventSeq + 1,
        idState: canonicalStringify(ids.serialize()),
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", "stale replay advance checkpoint");
      }
    }).immediate();
  }

  private applyReplayWorldEventCommand(
    db: WorldDatabase,
    run: SimulationRun,
    input: InjectWorldEventRequest,
    requestId: string,
  ): void {
    db.transaction(() => {
      const current = new SqliteRunRepository(db).getRun(run.id);
      const scheduledTick = input.scheduleTick ?? current.currentTick + 1;
      const worldEventStore = new SqliteWorldEventStore(db, current.id);
      const spec = { type: input.type, params: input.params } as WorldEventSpec;
      worldEventStore.validateSpecTargets(spec);
      const ids = IdFactory.restore(current.idState);
      const worldEventId = ids.next("wev");
      const taskId = ids.next("task");
      const wallTime = this.wallClock();
      const command = apiEvent(current, ids, current.nextEventSeq, wallTime, {
        type: "admin.command.received",
        correlationId: requestId,
        payload: {
          command: "world_event.inject",
          params: {
            runId: current.id,
            type: input.type,
            params: input.params,
            scheduledTick,
          },
          requestId,
        },
      });
      const injected = apiEvent(current, ids, current.nextEventSeq + 1, wallTime, {
        type: "world.event.injected",
        correlationId: requestId,
        causationId: command.eventId,
        payload: {
          worldEventId,
          type: input.type,
          params: input.params,
          scheduledTick,
          source: "admin",
        },
      });
      const worldEvent = worldEventSchema.parse({
        id: worldEventId,
        runId: current.id,
        type: input.type,
        params: input.params,
        source: "admin",
        status: "scheduled",
        createdTick: current.currentTick,
        scheduledTick,
        appliedTick: null,
        taskId,
        commandEventId: command.eventId,
        injectedEventId: injected.eventId,
        appliedEventId: null,
        effectEventIds: [],
        catalogVersion: WORLD_EVENT_CATALOG_VERSION,
      });
      new SqliteEventStore(db, current.id).appendBatch([command, injected]);
      worldEventStore.recordScheduled(worldEvent);
      new SqliteScheduler(db, current.id).schedule({
        id: taskId,
        dueTick: scheduledTick,
        order: WORLD_EVENT_TASK_ORDER,
        taskRef: WORLD_EVENT_TASK_REF,
        payload: { worldEventId },
      });
      const updated = db.prepare(`
        UPDATE simulation_runs SET id_state_canonical = @idState
        WHERE id = @runId AND current_tick = @currentTick
          AND next_event_seq = @nextEventSeq
      `).run({
        runId: current.id,
        currentTick: current.currentTick,
        nextEventSeq: current.nextEventSeq + 2,
        idState: canonicalStringify(ids.serialize()),
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", "stale replay world-event checkpoint");
      }
    }).immediate();
  }

  private compareReplayRange(
    db: WorldDatabase,
    replayStore: SqliteReplayStore,
    sourceEvents: readonly EventEnvelope[],
    fromSeq: number,
    toSeqExclusive: number,
    tick: number,
  ): boolean {
    if (toSeqExclusive <= fromSeq) return true;
    const expected = sourceEvents.slice(fromSeq, toSeqExclusive);
    const actual = new SqliteEventStore(db, replayStore.require().id).list({
      fromSeq,
      toSeq: toSeqExclusive - 1,
    });
    const mismatch = firstReplayEventMismatch(expected, actual);
    if (mismatch === null) return true;
    replayStore.recordDivergence({
      tick,
      kind: "event_mismatch",
      expectedHash: mismatch.expectedHash,
      actualHash: mismatch.actualHash,
      details: { ...mismatch },
      createdWall: this.wallClock(),
    });
    return false;
  }

  private finishReplay(
    targetDb: WorldDatabase,
    sourceDb: WorldDatabase,
    replayStore: SqliteReplayStore,
    sourceRun: SimulationRun,
    compareTargetState: boolean,
  ): void {
    const targetRun = new SqliteRunRepository(targetDb).getRun(replayStore.require().id);
    const replayHash = computeLogicalStateHash(targetDb, targetRun.id);
    let sourceHash: string | null = null;
    if (compareTargetState && targetRun.currentTick === sourceRun.currentTick) {
      sourceHash = computeLogicalStateHash(sourceDb, sourceRun.id);
    } else if (compareTargetState) {
      const row = sourceDb.prepare<[string, number], { state_hash: string }>(`
        SELECT state_hash FROM snapshots WHERE run_id = ? AND tick = ?
        ORDER BY id LIMIT 1
      `).get(sourceRun.id, targetRun.currentTick);
      sourceHash = row?.state_hash ?? null;
    }
    if (sourceHash !== null && sourceHash !== replayHash) {
      replayStore.recordDivergence({
        tick: targetRun.currentTick,
        kind: "state_hash_mismatch",
        expectedHash: sourceHash,
        actualHash: replayHash,
        details: { sourceRunId: sourceRun.id, replayRunId: targetRun.id },
        createdWall: this.wallClock(),
      });
    }
    const replay = replayStore.require();
    replayStore.finish({
      status: replay.divergenceCount === 0 ? "completed" : "diverged",
      currentTick: targetRun.currentTick,
      lastComparedSeq: targetRun.nextEventSeq - 1,
      sourceStateHash: sourceHash,
      replayStateHash: replayHash,
      completedWall: this.wallClock(),
    });
  }

  private recoverRunningRuns(): void {
    for (const location of this.locator.list()) {
      const replay = this.withDatabase(location, (db) =>
        new SqliteReplayStore(db, location.runId).get()
      );
      if (replay !== null) {
        if (replay.status === "running") this.scheduleReplay(location);
        continue;
      }
      const run = this.withDatabase(location, (db) => {
        const repository = new SqliteRunRepository(db);
        let run = repository.getRun(location.runId);
        // Repair the narrow crash window between committing the final tick and
        // recording its terminal lifecycle fact.
        if (
          run.currentTick === run.endTick &&
          (run.status === "running" || run.status === "paused")
        ) {
          run = this.completeRun(db, run.id, `${run.id}:end_tick_recovery`);
        }
        return run;
      });
      if (run.status === "running") {
        if (this.logger !== undefined) {
          childRunLogger(this.logger, {
            simulationId: location.simulationId,
            runId: location.runId,
            tick: run.currentTick,
            correlationId: `${location.runId}:startup_recovery`,
          }).warn(
            { event: "simulation.lifecycle.recovered", status: run.status },
            "recovering running simulation after restart",
          );
        }
        this.scheduleRun(location);
      }
    }
  }

  private recoverExportJobs(): void {
    for (const location of this.locator.list()) {
      const active = this.withDatabase(
        location,
        (db) => new SqliteExportStore(db, location.runId).listActive(),
      );
      for (const job of active) this.scheduleExport(location, job.id);
    }
  }

  private locateExport(exportId: string): RunLocation {
    exportIdSchema.parse(exportId);
    for (const location of this.locator.list()) {
      const found = this.withDatabase(
        location,
        (db) => new SqliteExportStore(db, location.runId).has(exportId),
      );
      if (found) return location;
    }
    throw new EngineError("NOT_FOUND", `export ${exportId} does not exist`);
  }

  private scheduleRun(location: RunLocation): void {
    if (this.closed) return;
    const key = this.runKey(location);
    if (this.runTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.runTimers.delete(key);
      void this.superviseRun(location);
    }, this.tickIntervalMs);
    timer.unref();
    this.runTimers.set(key, timer);
  }

  private cancelRun(location: RunLocation): void {
    const key = this.runKey(location);
    const timer = this.runTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.runTimers.delete(key);
  }

  private async superviseRun(location: RunLocation): Promise<void> {
    if (this.closed) return;
    const release = this.tryEnterRunOperation(location);
    if (release === null) {
      this.scheduleRun(location);
      return;
    }
    try {
      const shouldContinue = await this.withDatabaseAsync(location, async (db) => {
        const repository = new SqliteRunRepository(db);
        const run = repository.getRun(location.runId);
        if (run.status !== "running") return false;
        if (run.currentTick === run.endTick) {
          this.completeRun(db, run.id, `${run.id}:end_tick`);
          return false;
        }
        const result = await this.executeTicks(
          db,
          run.simulationId,
          run.id,
          1,
          `${run.id}:automatic`,
        );
        if (result.run.currentTick === result.run.endTick) {
          this.completeRun(db, run.id, `${run.id}:end_tick`);
          return false;
        }
        return result.run.status === "running";
      });
      if (shouldContinue) this.scheduleRun(location);
    } catch (error) {
      this.failRun(location, error);
    } finally {
      release();
    }
  }

  private failRun(location: RunLocation, cause: unknown): void {
    let correlationId = `${location.runId}:failure`;
    try {
      this.withDatabase(location, (db) => {
        const repository = new SqliteRunRepository(db);
        const run = repository.getRun(location.runId);
        if (run.status !== "running") return;
        const wallTime = this.wallClock();
        correlationId = `${run.id}:failure:${run.nextEventSeq}`;
        repository.transitionRun(
          { runId: run.id, command: "pause", wallTime, expectedStatus: "running" },
          ({ current }) => {
            const ids = IdFactory.restore(current.idState);
            const event = apiEvent(current, ids, current.nextEventSeq, wallTime, {
              type: "system.error.raised",
              correlationId,
              actor: SYSTEM_ACTOR,
              payload: {
                code: cause instanceof EngineError ? cause.code : "INTERNAL",
                message: cause instanceof Error ? cause.message : String(cause),
                module: "simulation.loop",
                tick: current.currentTick + 1,
                correlationId,
              },
            });
            new SqliteEventStore(db, current.id).append(event);
            return ids.serialize();
          },
        );
      });
    } catch (journalError) {
      // The original tick failure remains authoritative when even failure
      // journaling cannot commit; a later repair tool can inspect the run DB.
      this.logRunOperationFailure(
        location,
        correlationId,
        "simulation.failure_journal.failed",
        journalError,
        {
          originalError: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
    this.logRunOperationFailure(
      location,
      correlationId,
      "simulation.background.failed",
      cause,
    );
  }

  private currentRunTick(location: RunLocation): number {
    try {
      return this.withDatabase(location, (db) =>
        new SqliteRunRepository(db).getRun(location.runId).currentTick,
      );
    } catch {
      // Logging must never mask the originating operation. Zero is the only
      // valid checkpoint before a run database can be read successfully.
      return 0;
    }
  }

  private logRunOperationFailure(
    location: RunLocation,
    correlationId: string,
    event: string,
    cause: unknown,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    if (this.logger === undefined) return;
    childRunLogger(this.logger, {
      simulationId: location.simulationId,
      runId: location.runId,
      tick: this.currentRunTick(location),
      correlationId,
    }).error(
      {
        event,
        code: cause instanceof EngineError ? cause.code : "INTERNAL",
        err: cause,
        ...details,
      },
      "simulation operation failed",
    );
  }

  private runKey(location: RunLocation): string {
    return `${location.simulationId}/${location.runId}`;
  }

  private assertRunOperationAvailable(location: RunLocation): void {
    if (this.activeRunOperations.has(this.runKey(location))) {
      throw new EngineError("CONFLICT", `run ${location.runId} already has an active operation`);
    }
  }

  private tryEnterRunOperation(location: RunLocation): (() => void) | null {
    const key = this.runKey(location);
    if (this.activeRunOperations.has(key)) return null;
    this.activeRunOperations.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRunOperations.delete(key);
    };
  }

  private enterRunOperation(location: RunLocation): () => void {
    const release = this.tryEnterRunOperation(location);
    if (release === null) {
      throw new EngineError("CONFLICT", `run ${location.runId} already has an active operation`);
    }
    return release;
  }

  private withDatabase<T>(location: RunLocation, action: (db: WorldDatabase) => T): T {
    const db = openDatabaseFile(location.databasePath);
    try {
      return action(db);
    } finally {
      db.close();
    }
  }

  private async withDatabaseAsync<T>(
    location: RunLocation,
    action: (db: WorldDatabase) => Promise<T>,
  ): Promise<T> {
    const db = openDatabaseFile(location.databasePath);
    try {
      return await action(db);
    } finally {
      db.close();
    }
  }
}
