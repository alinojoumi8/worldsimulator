/** Deterministic LLM allowances, degradation, and hard kill-switch gateway (WS-603). */

import { LLM_MODULE_IDS } from "@worldtangle/shared";
import type { LlmModuleId } from "@worldtangle/shared";
import {
  llmRequestHash,
  type LlmFallback,
  type LlmProviderRoute,
  type LlmRequest,
  type LlmResult,
  type LlmSuccess,
  type RoutedLlmProvider,
} from "./llm-provider";

const WARNING_BASIS_POINTS = 8_000n;
const FULL_BASIS_POINTS = 10_000n;
const MICROCENTS_PER_CENT = 1_000_000n;

export type LlmBudgetBlockReason =
  | "llm_disabled"
  | "module_frozen"
  | "agent_quarantined"
  | "agent_daily_tokens_exhausted"
  | "run_cost_exhausted";

export type LlmDegradationReason =
  | LlmBudgetBlockReason
  | "agent_daily_tokens_warning"
  | "run_cost_warning";

export type LlmBudgetAuthorization =
  | Readonly<{
      disposition: "allow";
      requestedTier: 2 | 3;
      effectiveTier: 2 | 3;
      /** Authoritative simulation tick observed when this call was authorized. */
      authorizedRunTick: number;
      degradationReason?: LlmDegradationReason;
    }>
  | Readonly<{
      disposition: "block";
      requestedTier: 2 | 3;
      effectiveTier: 1;
      degradationReason: LlmBudgetBlockReason;
    }>;

export interface LlmModelPrice {
  /** Exact integer microcents per input token. */
  readonly inputMicrocentsPerToken: bigint;
  /** Exact integer microcents per provider-cache-hit input token. */
  readonly cachedInputMicrocentsPerToken?: bigint;
  /** Exact integer microcents per output token. */
  readonly outputMicrocentsPerToken: bigint;
}

export interface LlmBudgetUsageInput {
  readonly request: LlmRequest;
  readonly route: LlmProviderRoute;
  readonly result: LlmSuccess;
  readonly authorization: Extract<LlmBudgetAuthorization, { disposition: "allow" }>;
}

export interface LlmBudgetReceipt {
  readonly charged: boolean;
  readonly costMicrocents: bigint;
  readonly runCostMicrocents: bigint;
  readonly warningEmitted: boolean;
  readonly exhaustedEmitted: boolean;
  readonly autoPauseRequested: boolean;
}

/** Authoritative implementations must make authorize a read-only operation. */
export interface LlmBudgetController {
  authorize(request: LlmRequest): LlmBudgetAuthorization;
  recordSuccess(input: LlmBudgetUsageInput): LlmBudgetReceipt;
}

export type LlmBudgetEventType =
  | "llm.usage.recorded"
  | "llm.budget.threshold"
  | "llm.agent_budget.warning"
  | "llm.agent_budget.exhausted"
  | "simulation.auto_pause.requested";

export interface LlmBudgetEvent {
  readonly type: LlmBudgetEventType;
  readonly tick: number;
  readonly agentId?: string;
  readonly requestHash: string;
  readonly costMicrocents: string;
  readonly runCostMicrocents: string;
  readonly thresholdPct?: 80 | 100;
  readonly action?: "warn" | "auto_pause";
}

export interface LlmBudgetSnapshot {
  readonly runCostCeilingCents: bigint;
  readonly perAgentDailyTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: bigint;
  readonly warningEmitted: boolean;
  readonly exhaustedEmitted: boolean;
  readonly autoPauseRequested: boolean;
  readonly llmEnabled: boolean;
  readonly frozenModules: readonly LlmModuleId[];
}

export function llmCostMicrocents(
  inputTokens: number,
  outputTokens: number,
  price: LlmModelPrice,
  cachedInputTokens = 0,
): bigint {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new RangeError("input token count must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new RangeError("output token count must be a nonnegative safe integer");
  }
  if (
    !Number.isSafeInteger(cachedInputTokens) ||
    cachedInputTokens < 0 ||
    cachedInputTokens > inputTokens
  ) {
    throw new RangeError("cached input token count must be within total input tokens");
  }
  if (
    price.inputMicrocentsPerToken < 0n ||
    price.outputMicrocentsPerToken < 0n ||
    (price.cachedInputMicrocentsPerToken ?? 0n) < 0n
  ) {
    throw new RangeError("LLM token prices cannot be negative");
  }
  if (cachedInputTokens > 0 && price.cachedInputMicrocentsPerToken === undefined) {
    throw new RangeError("cached input token price is required for provider cache hits");
  }
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  return (
    BigInt(uncachedInputTokens) * price.inputMicrocentsPerToken +
    BigInt(cachedInputTokens) * (price.cachedInputMicrocentsPerToken ?? 0n) +
    BigInt(outputTokens) * price.outputMicrocentsPerToken
  );
}

function reached(numerator: bigint, denominator: bigint, basisPoints: bigint): boolean {
  return numerator * FULL_BASIS_POINTS >= denominator * basisPoints;
}

function validateRequestBoundary(request: LlmRequest): void {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    throw new RangeError("LLM request tick must be a nonnegative safe integer");
  }
  if (!(LLM_MODULE_IDS as readonly string[]).includes(request.moduleId)) {
    throw new RangeError(`unknown LLM module: ${request.moduleId}`);
  }
}

function blockedFallback(
  request: LlmRequest,
  authorization: Extract<LlmBudgetAuthorization, { disposition: "block" }>,
): LlmFallback {
  const administrative =
    authorization.degradationReason === "llm_disabled" ||
    authorization.degradationReason === "module_frozen" ||
    authorization.degradationReason === "agent_quarantined";
  return {
    ok: false,
    reason: administrative ? "llm_off" : "budget_blocked",
    requestHash: llmRequestHash(request),
    detail: authorization.degradationReason,
    attempts: 0,
    requestedTier: authorization.requestedTier,
    effectiveTier: 1,
    degradationReason: authorization.degradationReason,
  };
}

/**
 * Place this gateway outside the cache provider. Controls then apply even to a
 * cached proposal, while cache hits that remain allowed are never charged.
 */
export class BudgetedLlmProvider implements RoutedLlmProvider {
  private readonly provider: RoutedLlmProvider;
  private readonly controller: LlmBudgetController;

  constructor(options: {
    readonly provider: RoutedLlmProvider;
    readonly controller: LlmBudgetController;
  }) {
    this.provider = options.provider;
    this.controller = options.controller;
  }

  route(request: LlmRequest): LlmProviderRoute {
    validateRequestBoundary(request);
    const authorization = this.controller.authorize(request);
    const effectiveRequest = authorization.disposition === "allow"
      ? { ...request, tier: authorization.effectiveTier }
      : request;
    return this.provider.route(effectiveRequest);
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    try {
      validateRequestBoundary(request);
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash: llmRequestHash(request),
        detail: error instanceof Error ? error.message : "invalid LLM request boundary",
        attempts: 0,
      };
    }

    let authorization: LlmBudgetAuthorization;
    try {
      authorization = this.controller.authorize(request);
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash: llmRequestHash(request),
        detail: error instanceof Error ? error.message : "LLM budget authorization failed",
        attempts: 0,
      };
    }
    if (authorization.disposition === "block") {
      return blockedFallback(request, authorization);
    }

    const effectiveRequest: LlmRequest = authorization.effectiveTier === request.tier
      ? request
      : { ...request, tier: authorization.effectiveTier };
    const route = this.provider.route(effectiveRequest);
    let result: LlmResult;
    try {
      result = await this.provider.propose(effectiveRequest);
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash: llmRequestHash(effectiveRequest),
        detail: error instanceof Error ? error.message : "wrapped LLM provider threw",
        attempts: 0,
        requestedTier: request.tier,
        effectiveTier: authorization.effectiveTier,
        ...(authorization.degradationReason === undefined
          ? {}
          : { degradationReason: authorization.degradationReason }),
      };
    }
    if (!result.ok) {
      return {
        ...result,
        requestedTier: request.tier,
        effectiveTier: authorization.effectiveTier,
        ...(authorization.degradationReason === undefined
          ? {}
          : { degradationReason: authorization.degradationReason }),
      };
    }

    let costMicrocents = "0";
    if (!result.cached) {
      try {
        const receipt = this.controller.recordSuccess({
          request: effectiveRequest,
          route,
          result,
          authorization,
        });
        costMicrocents = receipt.costMicrocents.toString();
      } catch (error) {
        return {
          ok: false,
          reason: "provider_error",
          requestHash: result.requestHash,
          detail: error instanceof Error ? error.message : "LLM usage persistence failed",
          attempts: result.attempts ?? 1,
          requestedTier: request.tier,
          effectiveTier: authorization.effectiveTier,
          ...(authorization.degradationReason === undefined
            ? {}
            : { degradationReason: authorization.degradationReason }),
        };
      }
    }
    return {
      ...result,
      costMicrocents,
      requestedTier: request.tier,
      effectiveTier: authorization.effectiveTier,
      ...(authorization.degradationReason === undefined
        ? {}
        : { degradationReason: authorization.degradationReason }),
    };
  }
}

interface AgentDayUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  warningEmitted: boolean;
  exhaustedEmitted: boolean;
}

export interface InMemoryLlmBudgetControllerOptions {
  readonly runCostCeilingCents: bigint;
  readonly perAgentDailyTokens: number;
  readonly prices: ReadonlyMap<string, LlmModelPrice>;
  readonly llmEnabled?: boolean;
  readonly onEvent?: (event: LlmBudgetEvent) => void;
}

/** Deterministic in-memory controller used by acceptance tests and mock runs. */
export class InMemoryLlmBudgetController implements LlmBudgetController {
  readonly events: LlmBudgetEvent[] = [];
  private readonly runCostCeilingCents: bigint;
  private readonly perAgentDailyTokens: number;
  private readonly prices: ReadonlyMap<string, LlmModelPrice>;
  private readonly onEvent?: (event: LlmBudgetEvent) => void;
  private readonly frozenModules = new Set<LlmModuleId>();
  private readonly quarantines = new Map<string, number>();
  private readonly agentDays = new Map<string, AgentDayUsage>();
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private outputTokens = 0;
  private costMicrocents = 0n;
  private warningEmitted = false;
  private exhaustedEmitted = false;
  private autoPauseRequested = false;
  private llmEnabled: boolean;

  constructor(options: InMemoryLlmBudgetControllerOptions) {
    if (options.runCostCeilingCents <= 0n) {
      throw new RangeError("run LLM cost ceiling must be positive");
    }
    if (!Number.isSafeInteger(options.perAgentDailyTokens) || options.perAgentDailyTokens < 1) {
      throw new RangeError("per-agent daily token allowance must be a positive safe integer");
    }
    this.runCostCeilingCents = options.runCostCeilingCents;
    this.perAgentDailyTokens = options.perAgentDailyTokens;
    this.prices = options.prices;
    this.llmEnabled = options.llmEnabled ?? true;
    this.onEvent = options.onEvent;
  }

  setLlmEnabled(enabled: boolean): void {
    this.llmEnabled = enabled;
  }

  setModuleFrozen(moduleId: LlmModuleId, frozen: boolean): void {
    if (frozen) this.frozenModules.add(moduleId);
    else this.frozenModules.delete(moduleId);
  }

  setAgentQuarantine(agentId: string, untilTick: number | undefined): void {
    if (untilTick === undefined) this.quarantines.delete(agentId);
    else {
      if (!Number.isSafeInteger(untilTick) || untilTick < 0) {
        throw new RangeError("quarantine tick must be a nonnegative safe integer");
      }
      this.quarantines.set(agentId, untilTick);
    }
  }

  snapshot(): LlmBudgetSnapshot {
    return Object.freeze({
      runCostCeilingCents: this.runCostCeilingCents,
      perAgentDailyTokens: this.perAgentDailyTokens,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      costMicrocents: this.costMicrocents,
      warningEmitted: this.warningEmitted,
      exhaustedEmitted: this.exhaustedEmitted,
      autoPauseRequested: this.autoPauseRequested,
      llmEnabled: this.llmEnabled,
      frozenModules: Object.freeze(
        [...this.frozenModules].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      ),
    });
  }

  authorize(request: LlmRequest): LlmBudgetAuthorization {
    validateRequestBoundary(request);
    if (!this.llmEnabled) return this.block(request, "llm_disabled");
    if (this.frozenModules.has(request.moduleId)) return this.block(request, "module_frozen");
    if (
      request.agentId !== undefined &&
      (this.quarantines.get(request.agentId) ?? -1) >= request.tick
    ) {
      return this.block(request, "agent_quarantined");
    }

    const ceiling = this.runCostCeilingCents * MICROCENTS_PER_CENT;
    if (reached(this.costMicrocents, ceiling, FULL_BASIS_POINTS)) {
      return this.block(request, "run_cost_exhausted");
    }
    const agentUsage = request.agentId === undefined
      ? undefined
      : this.agentDays.get(this.agentDayKey(request.agentId, request.tick));
    const agentTokens = (agentUsage?.inputTokens ?? 0) + (agentUsage?.outputTokens ?? 0);
    if (agentTokens >= this.perAgentDailyTokens) {
      return this.block(request, "agent_daily_tokens_exhausted");
    }

    let degradationReason: LlmDegradationReason | undefined;
    if (reached(this.costMicrocents, ceiling, WARNING_BASIS_POINTS)) {
      degradationReason = "run_cost_warning";
    } else if (
      BigInt(agentTokens) * FULL_BASIS_POINTS >=
      BigInt(this.perAgentDailyTokens) * WARNING_BASIS_POINTS
    ) {
      degradationReason = "agent_daily_tokens_warning";
    }
    const effectiveTier = degradationReason !== undefined && request.tier === 3 ? 2 : request.tier;
    return Object.freeze({
      disposition: "allow",
      requestedTier: request.tier,
      effectiveTier,
      authorizedRunTick: request.tick,
      ...(effectiveTier === request.tier || degradationReason === undefined
        ? {}
        : { degradationReason }),
    });
  }

  recordSuccess(input: LlmBudgetUsageInput): LlmBudgetReceipt {
    if (input.result.cached) {
      return this.receipt(false, 0n, false, false, false);
    }
    const price = this.prices.get(input.route.model);
    if (price === undefined) throw new RangeError(`no exact LLM price for ${input.route.model}`);
    const cost = llmCostMicrocents(
      input.result.inputTokens,
      input.result.outputTokens,
      price,
      input.result.cachedInputTokens ?? 0,
    );
    this.inputTokens += input.result.inputTokens;
    this.cachedInputTokens += input.result.cachedInputTokens ?? 0;
    this.outputTokens += input.result.outputTokens;
    this.costMicrocents += cost;
    this.emit("llm.usage.recorded", input, cost);

    let agentWarning = false;
    let agentExhausted = false;
    if (input.request.agentId !== undefined) {
      const key = this.agentDayKey(input.request.agentId, input.request.tick);
      const usage = this.agentDays.get(key) ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        warningEmitted: false,
        exhaustedEmitted: false,
      };
      usage.inputTokens += input.result.inputTokens;
      usage.cachedInputTokens += input.result.cachedInputTokens ?? 0;
      usage.outputTokens += input.result.outputTokens;
      const tokens = usage.inputTokens + usage.outputTokens;
      if (
        !usage.warningEmitted &&
        BigInt(tokens) * FULL_BASIS_POINTS >=
          BigInt(this.perAgentDailyTokens) * WARNING_BASIS_POINTS
      ) {
        usage.warningEmitted = true;
        agentWarning = true;
        this.emit("llm.agent_budget.warning", input, cost);
      }
      if (!usage.exhaustedEmitted && tokens >= this.perAgentDailyTokens) {
        usage.exhaustedEmitted = true;
        agentExhausted = true;
        this.emit("llm.agent_budget.exhausted", input, cost);
      }
      this.agentDays.set(key, usage);
    }

    const ceiling = this.runCostCeilingCents * MICROCENTS_PER_CENT;
    let runWarning = false;
    let runExhausted = false;
    if (!this.warningEmitted && reached(this.costMicrocents, ceiling, WARNING_BASIS_POINTS)) {
      this.warningEmitted = true;
      runWarning = true;
      this.emit("llm.budget.threshold", input, cost, {
        thresholdPct: 80,
        action: "warn",
      });
    }
    if (!this.exhaustedEmitted && reached(this.costMicrocents, ceiling, FULL_BASIS_POINTS)) {
      this.exhaustedEmitted = true;
      this.autoPauseRequested = true;
      runExhausted = true;
      this.emit("llm.budget.threshold", input, cost, {
        thresholdPct: 100,
        action: "auto_pause",
      });
      this.emit("simulation.auto_pause.requested", input, cost);
    }
    return this.receipt(
      true,
      cost,
      runWarning || agentWarning,
      runExhausted || agentExhausted,
      runExhausted,
    );
  }

  private block(request: LlmRequest, reason: LlmBudgetBlockReason): LlmBudgetAuthorization {
    return Object.freeze({
      disposition: "block",
      requestedTier: request.tier,
      effectiveTier: 1,
      degradationReason: reason,
    });
  }

  private agentDayKey(agentId: string, tick: number): string {
    return `${agentId}:${tick}`;
  }

  private emit(
    type: LlmBudgetEventType,
    input: LlmBudgetUsageInput,
    cost: bigint,
    threshold?: Readonly<{ thresholdPct: 80 | 100; action: "warn" | "auto_pause" }>,
  ): void {
    const event = Object.freeze({
      type,
      tick: input.request.tick,
      ...(input.request.agentId === undefined ? {} : { agentId: input.request.agentId }),
      requestHash: input.result.requestHash,
      costMicrocents: cost.toString(),
      runCostMicrocents: this.costMicrocents.toString(),
      ...(threshold ?? {}),
    });
    this.events.push(event);
    this.onEvent?.(event);
  }

  private receipt(
    charged: boolean,
    costMicrocents: bigint,
    warningEmitted: boolean,
    exhaustedEmitted: boolean,
    autoPauseRequested: boolean,
  ): LlmBudgetReceipt {
    return Object.freeze({
      charged,
      costMicrocents,
      runCostMicrocents: this.costMicrocents,
      warningEmitted,
      exhaustedEmitted,
      autoPauseRequested,
    });
  }
}
