/** Authoritative LLM budgets, usage, degradation, and reversible controls (WS-603). */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  EVENT_SCHEMA_VERSION,
  IdFactory,
  LLM_MODULE_IDS,
  quarantineSchema,
} from "@worldtangle/shared";
import type {
  ActorRef,
  AgentQuarantine,
  EventEnvelope,
  LlmControlRequest,
  LlmModuleId,
  SimulationRun,
} from "@worldtangle/shared";
import {
  llmCostMicrocents,
  simDateForTick,
  type LlmBudgetAuthorization,
  type LlmBudgetController,
  type LlmBudgetReceipt,
  type LlmBudgetUsageInput,
  type LlmModelPrice,
  type LlmRequest,
} from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { toSafeNumber } from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteRunRepository } from "./run-repository";

const FULL_BASIS_POINTS = 10_000n;
const WARNING_BASIS_POINTS = 8_000n;
const MICROCENTS_PER_CENT = 1_000_000n;
const SYSTEM_ACTOR = { kind: "system", id: "llm_gateway" } as const;
const ADMIN_ACTOR = { kind: "admin", id: "api" } as const;

interface BudgetRow {
  run_cost_ceiling_cents: string;
  per_agent_daily_tokens: bigint;
  input_tokens: bigint;
  cached_input_tokens: bigint;
  output_tokens: bigint;
  cost_microcents: string;
  warning_emitted: bigint;
  exhausted_emitted: bigint;
  auto_paused: bigint;
  llm_enabled: bigint;
  updated_tick: bigint;
  revision: bigint;
  source_event_id: string;
}

interface AgentUsageRow {
  input_tokens: bigint;
  cached_input_tokens: bigint;
  output_tokens: bigint;
  warning_emitted: bigint;
  exhausted_emitted: bigint;
  revision: bigint;
  source_event_id: string;
}

interface ModuleRow {
  module_id: LlmModuleId;
  frozen: bigint;
  updated_tick: bigint;
  revision: bigint;
  source_event_id: string;
}

interface QuarantineRow {
  quarantine_canonical: string;
}

interface ControlHistoryRow {
  seq: bigint;
  command: LlmControlRequest["command"];
  target_kind: "run" | "module" | "agent";
  target_id: string;
  previous_canonical: string;
  next_canonical: string;
  tick: bigint;
  command_event_id: string;
  source_event_id: string;
}

interface EventSpec {
  readonly type: string;
  readonly payload: unknown;
  readonly actor: ActorRef;
  readonly causationId?: string;
}

export interface LlmRuntimeStatus {
  readonly enabled: boolean;
  readonly effectiveTier: 1 | 2 | 3;
  readonly autoPaused: boolean;
  readonly frozenModules: readonly LlmModuleId[];
  readonly spend: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly costCentsEstimate: string;
  };
  readonly budgetPct: number;
  readonly limits: {
    readonly runCostCentsMax: string;
    readonly perAgentDailyTokens: number;
  };
}

export interface LlmControlResult {
  readonly commandEventId: string;
  readonly eventId: string;
  readonly controls: LlmRuntimeStatus;
}

export interface LlmControlHistoryItem {
  readonly seq: number;
  readonly command: LlmControlRequest["command"];
  readonly targetKind: "run" | "module" | "agent";
  readonly targetId: string;
  readonly previous: unknown;
  readonly next: unknown;
  readonly tick: number;
  readonly commandEventId: string;
  readonly sourceEventId: string;
}

export interface SqliteLlmControlStoreOptions {
  readonly prices?: ReadonlyMap<string, LlmModelPrice>;
  readonly wallClock?: () => string;
}

function parsePositiveBigint(value: string, field: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new EngineError("INTERNAL", `persisted ${field} is not a positive integer`);
  }
  return BigInt(value);
}

function parseNonnegativeBigint(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new EngineError("INTERNAL", `persisted ${field} is not a nonnegative integer`);
  }
  return BigInt(value);
}

function reached(numerator: bigint, denominator: bigint, basisPoints: bigint): boolean {
  return numerator * FULL_BASIS_POINTS >= denominator * basisPoints;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCanonical(text: string, field: string): unknown {
  try {
    return canonicalParse(text);
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${field} is not canonical JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseQuarantine(text: string): AgentQuarantine {
  const parsed = quarantineSchema.safeParse(parseCanonical(text, "agent quarantine"));
  if (!parsed.success) {
    throw new EngineError("INTERNAL", "persisted agent quarantine is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function runtimeEvent(
  run: SimulationRun,
  ids: IdFactory,
  seq: number,
  wallTime: string,
  correlationId: string,
  spec: EventSpec,
): EventEnvelope {
  return {
    eventId: ids.next("evt"),
    type: spec.type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    simulationId: run.simulationId,
    runId: run.id,
    seq,
    tick: run.currentTick,
    simDate: simDateForTick(run.currentTick),
    wallTime,
    actor: spec.actor,
    correlationId,
    ...(spec.causationId === undefined ? {} : { causationId: spec.causationId }),
    payload: spec.payload,
  };
}

export class SqliteLlmControlStore implements LlmBudgetController {
  private readonly prices: ReadonlyMap<string, LlmModelPrice>;
  private readonly wallClock: () => string;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
    options: SqliteLlmControlStoreOptions = {},
  ) {
    this.prices = options.prices ?? new Map();
    this.wallClock = options.wallClock ?? (() => "llm-gateway");
  }

  initialize(input: {
    readonly runCostCentsMax: string;
    readonly perAgentDailyTokens: number;
    readonly llmEnabled: boolean;
    readonly sourceEventId: string;
  }): LlmRuntimeStatus {
    parsePositiveBigint(input.runCostCentsMax, "run LLM cost ceiling");
    if (!Number.isSafeInteger(input.perAgentDailyTokens) || input.perAgentDailyTokens < 1) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "per-agent daily token allowance must be a positive safe integer",
      );
    }
    this.db.transaction(() => {
      const existing = this.budgetRow(false);
      if (existing !== undefined) {
        const exact =
          existing.run_cost_ceiling_cents === input.runCostCentsMax &&
          toSafeNumber(existing.per_agent_daily_tokens, "per-agent daily tokens") ===
            input.perAgentDailyTokens &&
          (existing.llm_enabled === 1n) === input.llmEnabled;
        if (!exact) throw new EngineError("CONFLICT", "LLM budget policy is immutable");
        return;
      }
      const run = this.db.prepare<[string], { current_tick: bigint }>(`
        SELECT current_tick FROM simulation_runs WHERE id = ?
      `).get(this.runId);
      if (run === undefined) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
      const currentTick = toSafeNumber(run.current_tick, "run current tick");
      const eventExists = this.db.prepare<[string, string], { present: bigint }>(`
        SELECT 1 AS present FROM events WHERE run_id = ? AND event_id = ?
      `).get(this.runId, input.sourceEventId);
      if (eventExists === undefined) {
        throw new EngineError("NOT_FOUND", `source event ${input.sourceEventId} does not exist`);
      }
      this.db.prepare(`
        INSERT INTO llm_runtime_budgets(
          run_id, run_cost_ceiling_cents, per_agent_daily_tokens, llm_enabled,
          updated_tick, source_event_id
        ) VALUES (@runId, @ceiling, @daily, @enabled, @tick, @sourceEventId)
      `).run({
        runId: this.runId,
        ceiling: input.runCostCentsMax,
        daily: input.perAgentDailyTokens,
        enabled: input.llmEnabled ? 1 : 0,
        tick: currentTick,
        sourceEventId: input.sourceEventId,
      });
      const insertModule = this.db.prepare(`
        INSERT INTO llm_module_controls(
          run_id, module_id, frozen, updated_tick, revision, source_event_id
        ) VALUES (@runId, @moduleId, 0, @tick, 0, @sourceEventId)
      `);
      for (const moduleId of LLM_MODULE_IDS) {
        insertModule.run({
          runId: this.runId,
          moduleId,
          tick: currentTick,
          sourceEventId: input.sourceEventId,
        });
      }
    }).immediate();
    return this.status();
  }

  status(): LlmRuntimeStatus {
    const row = this.budgetRow();
    const cost = parseNonnegativeBigint(row.cost_microcents, "LLM cost microcents");
    const ceilingCents = parsePositiveBigint(
      row.run_cost_ceiling_cents,
      "run LLM cost ceiling",
    );
    const ceilingMicrocents = ceilingCents * MICROCENTS_PER_CENT;
    const boundedCost = cost > ceilingMicrocents ? ceilingMicrocents : cost;
    const hundredths = boundedCost * 10_000n / ceilingMicrocents;
    const enabled = row.llm_enabled === 1n;
    const exhausted = row.exhausted_emitted === 1n || cost >= ceilingMicrocents;
    const warned = row.warning_emitted === 1n ||
      reached(cost, ceilingMicrocents, WARNING_BASIS_POINTS);
    return Object.freeze({
      enabled,
      effectiveTier: !enabled || exhausted ? 1 : warned ? 2 : 3,
      autoPaused: row.auto_paused === 1n,
      frozenModules: Object.freeze(
        this.moduleRows()
          .filter((module) => module.frozen === 1n)
          .map((module) => module.module_id)
          .sort(compareCodeUnit),
      ),
      spend: Object.freeze({
        inputTokens: toSafeNumber(row.input_tokens, "LLM input tokens"),
        cachedInputTokens: toSafeNumber(
          row.cached_input_tokens,
          "LLM cached input tokens",
        ),
        outputTokens: toSafeNumber(row.output_tokens, "LLM output tokens"),
        costCentsEstimate: ceilDivide(cost, MICROCENTS_PER_CENT).toString(),
      }),
      budgetPct: Number(hundredths) / 100,
      limits: Object.freeze({
        runCostCentsMax: row.run_cost_ceiling_cents,
        perAgentDailyTokens: toSafeNumber(
          row.per_agent_daily_tokens,
          "per-agent daily tokens",
        ),
      }),
    });
  }

  authorize(request: LlmRequest): LlmBudgetAuthorization {
    this.assertRequest(request);
    const run = new SqliteRunRepository(this.db).getRun(this.runId);
    if (request.tick !== run.currentTick && request.tick !== run.currentTick + 1) {
      throw new EngineError(
        "CONFLICT",
        "LLM request must target the current or next simulation tick",
      );
    }
    const row = this.budgetRow();
    if (row.llm_enabled !== 1n) return this.block(request, "llm_disabled");
    const module = this.moduleRow(request.moduleId);
    if (module.frozen === 1n) return this.block(request, "module_frozen");

    if (request.agentId !== undefined) {
      const agent = this.db.prepare<[string, string], QuarantineRow>(`
        SELECT quarantine_canonical FROM agents WHERE run_id = ? AND id = ?
      `).get(this.runId, request.agentId);
      if (agent === undefined) {
        throw new EngineError("NOT_FOUND", `agent ${request.agentId} does not exist`);
      }
      const quarantine = parseQuarantine(agent.quarantine_canonical);
      if (quarantine.mode === "tier1_only" && quarantine.untilTick >= request.tick) {
        return this.block(request, "agent_quarantined");
      }
    }

    const cost = parseNonnegativeBigint(row.cost_microcents, "LLM cost microcents");
    const ceiling = parsePositiveBigint(row.run_cost_ceiling_cents, "run LLM cost ceiling") *
      MICROCENTS_PER_CENT;
    if (reached(cost, ceiling, FULL_BASIS_POINTS)) {
      return this.block(request, "run_cost_exhausted");
    }

    const agentUsage = request.agentId === undefined
      ? undefined
      : this.agentUsageRow(request.agentId, request.tick);
    const agentTokens = (agentUsage?.input_tokens ?? 0n) + (agentUsage?.output_tokens ?? 0n);
    const daily = row.per_agent_daily_tokens;
    if (agentTokens >= daily) {
      return this.block(request, "agent_daily_tokens_exhausted");
    }

    const degradationReason = reached(cost, ceiling, WARNING_BASIS_POINTS)
      ? "run_cost_warning" as const
      : reached(agentTokens, daily, WARNING_BASIS_POINTS)
        ? "agent_daily_tokens_warning" as const
        : undefined;
    const effectiveTier = request.tier === 3 && degradationReason !== undefined
      ? 2 as const
      : request.tier;
    return Object.freeze({
      disposition: "allow",
      requestedTier: request.tier,
      effectiveTier,
      authorizedRunTick: run.currentTick,
      ...(effectiveTier === request.tier || degradationReason === undefined
        ? {}
        : { degradationReason }),
    });
  }

  recordSuccess(input: LlmBudgetUsageInput): LlmBudgetReceipt {
    if (input.result.cached) {
      const current = this.budgetRow();
      return Object.freeze({
        charged: false,
        costMicrocents: 0n,
        runCostMicrocents: parseNonnegativeBigint(
          current.cost_microcents,
          "LLM cost microcents",
        ),
        warningEmitted: false,
        exhaustedEmitted: false,
        autoPauseRequested: false,
      });
    }
    const price = this.prices.get(input.route.model);
    if (price === undefined) {
      throw new EngineError("VALIDATION_FAILED", `no exact LLM price for ${input.route.model}`);
    }
    const callCost = llmCostMicrocents(
      input.result.inputTokens,
      input.result.outputTokens,
      price,
      input.result.cachedInputTokens ?? 0,
    );
    return this.db.transaction(() => this.recordUsageTransaction(input, callCost)).immediate();
  }

  applyControl(
    input: LlmControlRequest,
    correlationId: string,
    wallTime: string,
  ): LlmControlResult {
    if (input.runId !== undefined && input.runId !== this.runId) {
      throw new EngineError("CONFLICT", "LLM control targets a different run");
    }
    if (correlationId.length === 0 || wallTime.length === 0) {
      throw new EngineError("VALIDATION_FAILED", "control correlation and wall time are required");
    }
    return this.db.transaction(() => {
      const run = new SqliteRunRepository(this.db).getRun(this.runId);
      const control = this.controlTransition(run, input);
      const ids = IdFactory.restore(run.idState);
      const command = runtimeEvent(
        run,
        ids,
        run.nextEventSeq,
        wallTime,
        correlationId,
        {
          type: "admin.command.received",
          actor: ADMIN_ACTOR,
          payload: { command: input.command, params: input, requestId: correlationId },
        },
      );
      const fact = runtimeEvent(
        run,
        ids,
        run.nextEventSeq + 1,
        wallTime,
        correlationId,
        {
          type: control.factType,
          actor: ADMIN_ACTOR,
          causationId: command.eventId,
          payload: {
            targetKind: control.targetKind,
            targetId: control.targetId,
            previous: control.previous,
            next: control.next,
            evidence: [command.eventId],
          },
        },
      );
      new SqliteEventStore(this.db, this.runId).appendBatch([command, fact]);
      control.mutate(fact.eventId);
      const historySeq = this.nextControlHistorySeq();
      this.db.prepare(`
        INSERT INTO llm_control_history(
          run_id, seq, command, target_kind, target_id, previous_canonical,
          next_canonical, tick, command_event_id, source_event_id
        ) VALUES (
          @runId, @seq, @command, @targetKind, @targetId, @previous,
          @next, @tick, @commandEventId, @sourceEventId
        )
      `).run({
        runId: this.runId,
        seq: historySeq,
        command: input.command,
        targetKind: control.targetKind,
        targetId: control.targetId,
        previous: canonicalStringify(control.previous),
        next: canonicalStringify(control.next),
        tick: run.currentTick,
        commandEventId: command.eventId,
        sourceEventId: fact.eventId,
      });
      this.persistIdState(run, ids, run.status, run.nextEventSeq + 2);
      return Object.freeze({
        commandEventId: command.eventId,
        eventId: fact.eventId,
        controls: this.status(),
      });
    }).immediate();
  }

  listHistory(): readonly LlmControlHistoryItem[] {
    return this.db.prepare<[string], ControlHistoryRow>(`
      SELECT seq, command, target_kind, target_id, previous_canonical,
        next_canonical, tick, command_event_id, source_event_id
      FROM llm_control_history WHERE run_id = ? ORDER BY seq
    `).all(this.runId).map((row) => Object.freeze({
      seq: toSafeNumber(row.seq, "LLM control history sequence"),
      command: row.command,
      targetKind: row.target_kind,
      targetId: row.target_id,
      previous: parseCanonical(row.previous_canonical, "previous LLM control state"),
      next: parseCanonical(row.next_canonical, "next LLM control state"),
      tick: toSafeNumber(row.tick, "LLM control history tick"),
      commandEventId: row.command_event_id,
      sourceEventId: row.source_event_id,
    }));
  }

  private recordUsageTransaction(
    input: LlmBudgetUsageInput,
    callCost: bigint,
  ): LlmBudgetReceipt {
    this.assertRequest(input.request);
    const run = new SqliteRunRepository(this.db).getRun(this.runId);
    if (run.currentTick !== input.authorization.authorizedRunTick) {
      throw new EngineError("CONFLICT", "LLM response crossed a simulation tick boundary");
    }
    const row = this.budgetRow();
    const priorCost = parseNonnegativeBigint(row.cost_microcents, "LLM cost microcents");
    const nextCost = priorCost + callCost;
    const nextInput = toSafeNumber(row.input_tokens, "LLM input tokens") + input.result.inputTokens;
    const nextCachedInput = toSafeNumber(
      row.cached_input_tokens,
      "LLM cached input tokens",
    ) + (input.result.cachedInputTokens ?? 0);
    const nextOutput = toSafeNumber(row.output_tokens, "LLM output tokens") + input.result.outputTokens;
    if (
      !Number.isSafeInteger(nextInput) ||
      !Number.isSafeInteger(nextCachedInput) ||
      nextCachedInput > nextInput ||
      !Number.isSafeInteger(nextOutput)
    ) {
      throw new EngineError("LIMIT_EXCEEDED", "LLM token counters exceed safe integer range");
    }
    const ceiling = parsePositiveBigint(row.run_cost_ceiling_cents, "run LLM cost ceiling") *
      MICROCENTS_PER_CENT;
    const runWarning = row.warning_emitted === 0n &&
      reached(nextCost, ceiling, WARNING_BASIS_POINTS);
    const runExhausted = row.exhausted_emitted === 0n &&
      reached(nextCost, ceiling, FULL_BASIS_POINTS);

    const priorAgent = input.request.agentId === undefined
      ? undefined
      : this.agentUsageRow(input.request.agentId, input.request.tick);
    const nextAgentInput = (priorAgent === undefined
      ? 0
      : toSafeNumber(priorAgent.input_tokens, "agent LLM input tokens")) + input.result.inputTokens;
    const nextAgentCachedInput = (priorAgent === undefined
      ? 0
      : toSafeNumber(
          priorAgent.cached_input_tokens,
          "agent LLM cached input tokens",
        )) + (input.result.cachedInputTokens ?? 0);
    const nextAgentOutput = (priorAgent === undefined
      ? 0
      : toSafeNumber(priorAgent.output_tokens, "agent LLM output tokens")) + input.result.outputTokens;
    const nextAgentTokens = BigInt(nextAgentInput + nextAgentOutput);
    const agentWarning = input.request.agentId !== undefined &&
      (priorAgent?.warning_emitted ?? 0n) === 0n &&
      reached(nextAgentTokens, row.per_agent_daily_tokens, WARNING_BASIS_POINTS);
    const agentExhausted = input.request.agentId !== undefined &&
      (priorAgent?.exhausted_emitted ?? 0n) === 0n &&
      reached(nextAgentTokens, row.per_agent_daily_tokens, FULL_BASIS_POINTS);

    const eventSpecs: EventSpec[] = [{
      type: "llm.usage.recorded",
      actor: SYSTEM_ACTOR,
      causationId: input.request.causationId,
      payload: {
        requestHash: input.result.requestHash,
        provider: input.route.provider,
        model: input.route.model,
        moduleId: input.request.moduleId,
        budgetTag: input.request.budgetTag,
        agentId: input.request.agentId ?? null,
        requestedTier: input.authorization.requestedTier,
        effectiveTier: input.authorization.effectiveTier,
        inputTokens: input.result.inputTokens,
        cachedInputTokens: input.result.cachedInputTokens ?? 0,
        outputTokens: input.result.outputTokens,
        costMicrocents: callCost.toString(),
        cumulativeCostMicrocents: nextCost.toString(),
        evidence: [input.request.causationId],
      },
    }];
    if (agentWarning) eventSpecs.push({
      type: "llm.agent_budget.warning",
      actor: SYSTEM_ACTOR,
      payload: {
        agentId: input.request.agentId,
        dayTick: input.request.tick,
        tokens: nextAgentTokens.toString(),
        allowance: row.per_agent_daily_tokens.toString(),
      },
    });
    if (agentExhausted) eventSpecs.push({
      type: "llm.agent_budget.exhausted",
      actor: SYSTEM_ACTOR,
      payload: {
        agentId: input.request.agentId,
        dayTick: input.request.tick,
        tokens: nextAgentTokens.toString(),
        allowance: row.per_agent_daily_tokens.toString(),
      },
    });
    if (runWarning) eventSpecs.push({
      type: "llm.budget.threshold",
      actor: SYSTEM_ACTOR,
      payload: {
        runId: this.runId,
        pct: 80,
        spend: {
          inputTokens: nextInput,
          cachedInputTokens: nextCachedInput,
          outputTokens: nextOutput,
          costMicrocents: nextCost.toString(),
        },
        action: "warn",
        thresholdPct: 80,
        costMicrocents: nextCost.toString(),
        ceilingMicrocents: ceiling.toString(),
      },
    });
    let exhaustedEventIndex: number | undefined;
    if (runExhausted) eventSpecs.push({
      type: "llm.budget.threshold",
      actor: SYSTEM_ACTOR,
      payload: {
        runId: this.runId,
        pct: 100,
        spend: {
          inputTokens: nextInput,
          cachedInputTokens: nextCachedInput,
          outputTokens: nextOutput,
          costMicrocents: nextCost.toString(),
        },
        action: "auto_pause",
        thresholdPct: 100,
        costMicrocents: nextCost.toString(),
        ceilingMicrocents: ceiling.toString(),
      },
    });
    if (runExhausted) exhaustedEventIndex = eventSpecs.length - 1;
    const autoPause = runExhausted && run.status === "running";
    if (autoPause) eventSpecs.push({
      type: "simulation.paused",
      actor: SYSTEM_ACTOR,
      payload: { status: "paused", reason: "llm_budget_exhausted" },
    });

    const ids = IdFactory.restore(run.idState);
    const events: EventEnvelope[] = [];
    for (let index = 0; index < eventSpecs.length; index++) {
      const spec = eventSpecs[index]!;
      const causeIndex = index === 0 ? undefined : 0;
      events.push(runtimeEvent(
        run,
        ids,
        run.nextEventSeq + index,
        this.wallClock(),
        input.request.correlationId,
        {
          ...spec,
          ...(spec.causationId !== undefined
            ? {}
            : causeIndex === undefined
              ? {}
              : { causationId: events[causeIndex]!.eventId }),
        },
      ));
    }
    if (autoPause) {
      const exhausted = exhaustedEventIndex === undefined
        ? undefined
        : events[exhaustedEventIndex];
      const pausedIndex = events.findIndex((event) => event.type === "simulation.paused");
      if (exhausted !== undefined && pausedIndex >= 0) {
        events[pausedIndex] = Object.freeze({
          ...events[pausedIndex]!,
          causationId: exhausted.eventId,
        });
      }
    }
    new SqliteEventStore(this.db, this.runId).appendBatch(events);
    const usageEventId = events[0]!.eventId;
    const budgetUpdated = this.db.prepare(`
      UPDATE llm_runtime_budgets SET
        input_tokens = @inputTokens,
        cached_input_tokens = @cachedInputTokens,
        output_tokens = @outputTokens,
        cost_microcents = @costMicrocents,
        warning_emitted = @warningEmitted,
        exhausted_emitted = @exhaustedEmitted,
        auto_paused = @autoPaused,
        updated_tick = @tick,
        revision = revision + 1,
        source_event_id = @sourceEventId
      WHERE run_id = @runId AND revision = @revision
    `).run({
      runId: this.runId,
      inputTokens: nextInput,
      cachedInputTokens: nextCachedInput,
      outputTokens: nextOutput,
      costMicrocents: nextCost.toString(),
      warningEmitted: row.warning_emitted === 1n || runWarning ? 1 : 0,
      exhaustedEmitted: row.exhausted_emitted === 1n || runExhausted ? 1 : 0,
      autoPaused: row.auto_paused === 1n || autoPause ? 1 : 0,
      tick: run.currentTick,
      sourceEventId: usageEventId,
      revision: row.revision,
    });
    if (budgetUpdated.changes !== 1) {
      throw new EngineError("CONFLICT", "stale LLM budget usage checkpoint");
    }
    if (input.request.agentId !== undefined) {
      this.db.prepare(`
        INSERT INTO llm_agent_daily_usage(
          run_id, agent_id, day_tick, input_tokens, cached_input_tokens, output_tokens,
          warning_emitted, exhausted_emitted, revision, source_event_id
        ) VALUES (
          @runId, @agentId, @dayTick, @inputTokens, @cachedInputTokens, @outputTokens,
          @warningEmitted, @exhaustedEmitted, 0, @sourceEventId
        )
        ON CONFLICT(run_id, agent_id, day_tick) DO UPDATE SET
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          warning_emitted = excluded.warning_emitted,
          exhausted_emitted = excluded.exhausted_emitted,
          revision = llm_agent_daily_usage.revision + 1,
          source_event_id = excluded.source_event_id
      `).run({
        runId: this.runId,
        agentId: input.request.agentId,
        dayTick: input.request.tick,
        inputTokens: nextAgentInput,
        cachedInputTokens: nextAgentCachedInput,
        outputTokens: nextAgentOutput,
        warningEmitted: (priorAgent?.warning_emitted ?? 0n) === 1n || agentWarning ? 1 : 0,
        exhaustedEmitted: (priorAgent?.exhausted_emitted ?? 0n) === 1n || agentExhausted ? 1 : 0,
        sourceEventId: usageEventId,
      });
    }
    this.persistIdState(
      run,
      ids,
      autoPause ? "paused" : run.status,
      run.nextEventSeq + events.length,
    );
    return Object.freeze({
      charged: true,
      costMicrocents: callCost,
      runCostMicrocents: nextCost,
      warningEmitted: runWarning || agentWarning,
      exhaustedEmitted: runExhausted || agentExhausted,
      autoPauseRequested: autoPause,
    });
  }

  private controlTransition(run: SimulationRun, input: LlmControlRequest): {
    factType: string;
    targetKind: "run" | "module" | "agent";
    targetId: string;
    previous: unknown;
    next: unknown;
    mutate: (sourceEventId: string) => void;
  } {
    if (input.command === "set_llm_enabled") {
      const row = this.budgetRow();
      const previous = Object.freeze({ enabled: row.llm_enabled === 1n });
      const next = Object.freeze({ enabled: input.enabled });
      if (previous.enabled === next.enabled) {
        throw new EngineError("CONFLICT", "LLM enabled switch already has the requested value");
      }
      return {
        factType: "llm.enabled.changed",
        targetKind: "run",
        targetId: this.runId,
        previous,
        next,
        mutate: (sourceEventId) => {
          const updated = this.db.prepare(`
            UPDATE llm_runtime_budgets SET
              llm_enabled = @enabled, updated_tick = @tick,
              revision = revision + 1, source_event_id = @sourceEventId
            WHERE run_id = @runId AND revision = @revision
          `).run({
            runId: this.runId,
            enabled: input.enabled ? 1 : 0,
            tick: run.currentTick,
            sourceEventId,
            revision: row.revision,
          });
          if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale LLM control state");
        },
      };
    }
    if (input.command === "set_module_frozen") {
      const row = this.moduleRow(input.moduleId);
      const previous = Object.freeze({ frozen: row.frozen === 1n });
      const next = Object.freeze({ frozen: input.frozen });
      if (previous.frozen === next.frozen) {
        throw new EngineError("CONFLICT", "module freeze already has the requested value");
      }
      return {
        factType: "llm.module_freeze.changed",
        targetKind: "module",
        targetId: input.moduleId,
        previous,
        next,
        mutate: (sourceEventId) => {
          const updated = this.db.prepare(`
            UPDATE llm_module_controls SET
              frozen = @frozen, updated_tick = @tick,
              revision = revision + 1, source_event_id = @sourceEventId
            WHERE run_id = @runId AND module_id = @moduleId AND revision = @revision
          `).run({
            runId: this.runId,
            moduleId: input.moduleId,
            frozen: input.frozen ? 1 : 0,
            tick: run.currentTick,
            sourceEventId,
            revision: row.revision,
          });
          if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale module control");
        },
      };
    }

    const agent = this.db.prepare<[string, string], QuarantineRow>(`
      SELECT quarantine_canonical FROM agents WHERE run_id = ? AND id = ?
    `).get(this.runId, input.agentId);
    if (agent === undefined) throw new EngineError("NOT_FOUND", `agent ${input.agentId} does not exist`);
    const previous = parseQuarantine(agent.quarantine_canonical);
    if (input.quarantined && input.untilTick! < run.currentTick) {
      throw new EngineError("VALIDATION_FAILED", "quarantine cannot end before the current tick");
    }
    const next: AgentQuarantine = input.quarantined
      ? { mode: "tier1_only", untilTick: input.untilTick!, consecutiveFailures: 1 }
      : { mode: "none" };
    if (canonicalStringify(previous) === canonicalStringify(next)) {
      throw new EngineError("CONFLICT", "agent quarantine already has the requested value");
    }
    return {
      factType: "agent.quarantine.changed",
      targetKind: "agent",
      targetId: input.agentId,
      previous,
      next,
      mutate: (sourceEventId) => {
        const updated = this.db.prepare(`
          UPDATE agents SET quarantine_canonical = @next
          WHERE run_id = @runId AND id = @agentId AND quarantine_canonical = @previous
        `).run({
          runId: this.runId,
          agentId: input.agentId,
          previous: canonicalStringify(previous),
          next: canonicalStringify(next),
        });
        if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale agent quarantine");
        void sourceEventId;
      },
    };
  }

  private persistIdState(
    run: SimulationRun,
    ids: IdFactory,
    status: SimulationRun["status"],
    nextEventSeq: number,
  ): void {
    const state = ids.serialize();
    if ((state["evt"] ?? 0) !== nextEventSeq) {
      throw new EngineError("CONFLICT", "LLM journal and event ID checkpoints disagree");
    }
    const updated = this.db.prepare(`
      UPDATE simulation_runs SET id_state_canonical = @idState, status = @status
      WHERE id = @runId AND status = @priorStatus
        AND current_tick = @tick AND next_event_seq = @nextEventSeq
    `).run({
      runId: this.runId,
      priorStatus: run.status,
      status,
      tick: run.currentTick,
      nextEventSeq,
      idState: canonicalStringify(state),
    });
    if (updated.changes !== 1) throw new EngineError("CONFLICT", "stale LLM event checkpoint");
  }

  private assertRequest(request: LlmRequest): void {
    if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "LLM request tick is invalid");
    }
    if (!(LLM_MODULE_IDS as readonly string[]).includes(request.moduleId)) {
      throw new EngineError("VALIDATION_FAILED", `unknown LLM module ${request.moduleId}`);
    }
  }

  private budgetRow(required?: true): BudgetRow;
  private budgetRow(required: false): BudgetRow | undefined;
  private budgetRow(required = true): BudgetRow | undefined {
    const row = this.db.prepare<[string], BudgetRow>(`
      SELECT run_cost_ceiling_cents, per_agent_daily_tokens, input_tokens,
        cached_input_tokens, output_tokens, cost_microcents, warning_emitted, exhausted_emitted,
        auto_paused, llm_enabled, updated_tick, revision, source_event_id
      FROM llm_runtime_budgets WHERE run_id = ?
    `).get(this.runId);
    if (row === undefined && required) {
      throw new EngineError("NOT_FOUND", `LLM budget for run ${this.runId} is not initialized`);
    }
    return row;
  }

  private moduleRows(): readonly ModuleRow[] {
    return this.db.prepare<[string], ModuleRow>(`
      SELECT module_id, frozen, updated_tick, revision, source_event_id
      FROM llm_module_controls WHERE run_id = ? ORDER BY module_id
    `).all(this.runId);
  }

  private moduleRow(moduleId: LlmModuleId): ModuleRow {
    const row = this.db.prepare<[string, string], ModuleRow>(`
      SELECT module_id, frozen, updated_tick, revision, source_event_id
      FROM llm_module_controls WHERE run_id = ? AND module_id = ?
    `).get(this.runId, moduleId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `LLM module ${moduleId} is not initialized`);
    return row;
  }

  private agentUsageRow(agentId: string, tick: number): AgentUsageRow | undefined {
    return this.db.prepare<[string, string, number], AgentUsageRow>(`
      SELECT input_tokens, cached_input_tokens, output_tokens, warning_emitted, exhausted_emitted,
        revision, source_event_id
      FROM llm_agent_daily_usage
      WHERE run_id = ? AND agent_id = ? AND day_tick = ?
    `).get(this.runId, agentId, tick);
  }

  private nextControlHistorySeq(): number {
    const row = this.db.prepare<[string], { next_seq: bigint }>(`
      SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
      FROM llm_control_history WHERE run_id = ?
    `).get(this.runId);
    if (row === undefined) throw new EngineError("INTERNAL", "could not allocate control history sequence");
    return toSafeNumber(row.next_seq, "LLM control history sequence");
  }

  private block(
    request: LlmRequest,
    reason: Extract<LlmBudgetAuthorization, { disposition: "block" }>[
      "degradationReason"
    ],
  ): LlmBudgetAuthorization {
    return Object.freeze({
      disposition: "block",
      requestedTier: request.tier,
      effectiveTier: 1,
      degradationReason: reason,
    });
  }
}
