/** Deterministic Tier 0/1 agent decision engine with records, caps, and quarantine. */

import {
  EngineError,
  TRIGGER_KINDS,
  agentActionSchema,
  decisionPriorModifierSchema,
  decisionOptionSchema,
  decisionSchema,
  hashValue,
  intentEnvelopeSchema,
} from "@worldtangle/shared";
import type {
  Agent,
  AgentAction,
  AgentQuarantine,
  DecisionPriorModifier,
  Decision,
  DecisionOption,
  EngineErrorCode,
  EventEnvelope,
  IntentEnvelope,
  TriggerKind,
  TriggerSignal,
} from "@worldtangle/shared";
import { z } from "zod";
import type {
  ActionExecutionContext,
  ActionRejection,
  ActionRegistry,
} from "./action-registry";
import type { WakeSet } from "./trigger-evaluator";

export const RULE_ONLY_ACTION_TYPES: Readonly<Record<TriggerKind, string>> = Object.freeze({
  schedule: "agent.perform_scheduled_task",
  message: "agent.review_message",
  stress: "agent.address_financial_stress",
  news: "agent.review_news",
  goal: "agent.advance_goal",
  policy: "agent.review_policy",
  company: "agent.review_company",
  market: "agent.review_market",
});

export const RULE_ONLY_NO_OP_ACTION = "agent.no_op";

const ruleActionParamsSchema = z.object({
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  triggerKind: z.enum(TRIGGER_KINDS),
  payload: z.record(z.string(), z.unknown()),
}).strict();

const noOpParamsSchema = z.object({
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/).optional(),
}).strict();

export interface RuleOnlyActionReceipt {
  readonly acknowledged: true;
  readonly eventIds: readonly string[];
}

export interface Tier1RuleContext<TState = unknown> {
  readonly runId: string;
  readonly tick: number;
  readonly agent: Agent;
  readonly trigger: TriggerSignal;
  readonly state: TState;
}

export interface Tier1DecisionRule<TState = unknown> {
  readonly id: string;
  readonly triggerKind: TriggerKind;
  buildOptions(context: Tier1RuleContext<TState>): readonly DecisionOption[];
}

export interface Tier0ActionRequest {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Tier0RoutineContext<TState = unknown> {
  readonly runId: string;
  readonly tick: number;
  readonly agent: Agent;
  readonly state: TState;
}

export interface Tier0Routine<TState = unknown> {
  readonly id: string;
  readonly order: number;
  run(context: Tier0RoutineContext<TState>): readonly Tier0ActionRequest[];
}

export interface DecisionObservation {
  readonly summary: string;
  readonly facts?: unknown;
}

export type DecisionObservationProvider<TState = unknown> = (
  context: Tier1RuleContext<TState>,
) => DecisionObservation;

export type DecisionPriorProvider<TState = unknown> = (
  context: Tier1RuleContext<TState>,
) => DecisionPriorModifier | undefined;

export interface DecisionEventOptions {
  readonly actor: { readonly kind: "agent"; readonly id: string };
  readonly correlationId: string;
  readonly causationId?: string;
}

export type DecisionEventEmitter = (
  type: string,
  payload: unknown,
  options: DecisionEventOptions,
) => EventEnvelope | string | void;

export interface DecisionEngineCounter {
  (kind: "decisions" | "llmCalls" | "transactions", amount?: number): void;
}

export interface DecisionRejectionRecord {
  readonly runId: string;
  readonly tick: number;
  readonly agentId: string;
  readonly type: string;
  readonly intentId?: string;
  readonly decisionId?: string;
  readonly code: EngineErrorCode;
  readonly message: string;
}

export interface QuarantineTransition {
  readonly agentId: string;
  readonly tick: number;
  readonly untilTick: number;
  readonly consecutiveFailures: number;
  readonly reason: string;
}

export interface RuleDecisionTickInput<TState = unknown> {
  readonly runId: string;
  readonly tick: number;
  readonly agents: readonly Agent[];
  readonly wakeSet: WakeSet;
  readonly ids: {
    next(prefix: string): string;
  };
  readonly state: TState;
  readonly observationProvider?: DecisionObservationProvider<TState>;
  readonly priorProvider?: DecisionPriorProvider<TState>;
  readonly emit?: DecisionEventEmitter;
  readonly count?: DecisionEngineCounter;
  /** Action slots already consumed or reserved by other deterministic phases. */
  readonly initialActionCounts?: Readonly<Record<string, number>>;
}

export interface RuleDecisionTickResult {
  readonly decisions: readonly Decision[];
  readonly actions: readonly AgentAction[];
  readonly rejections: readonly DecisionRejectionRecord[];
  readonly quarantines: readonly QuarantineTransition[];
  readonly tier0RoutinesRun: number;
  readonly decisionCapDrops: number;
  readonly actionCapDrops: number;
}

export interface RuleDecisionEngineOptions<TState = unknown> {
  readonly registry: ActionRegistry<TState>;
  readonly tier1Rules?: readonly Tier1DecisionRule<TState>[];
  readonly tier0Routines?: readonly Tier0Routine<TState>[];
  readonly maxDecisionsPerAgentPerTick?: number;
  readonly maxActionsPerAgentPerTick?: number;
  readonly failureThreshold?: number;
  readonly quarantineCooldownTicks?: number;
}

export const DEFAULT_MAX_ACTIONS_PER_AGENT_PER_TICK = 3;

interface FailureState {
  consecutiveFailures: number;
  quarantineUntilTick?: number;
}

interface ExecuteIntentInput<TState> {
  readonly intent: IntentEnvelope;
  readonly context: ActionExecutionContext<TState>;
  readonly decisionId?: string;
  readonly sourceEventId?: string;
  readonly emit?: DecisionEventEmitter;
}

interface ExecuteIntentResult {
  readonly action?: AgentAction;
  readonly rejection?: ActionRejection;
  readonly validationApproved: boolean;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePositiveCap(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      name + " must be an integer from 1 to " + maximum + ", got " + value,
    );
  }
  return value;
}

function emittedEventId(value: EventEnvelope | string | void): string | undefined {
  if (typeof value === "string") return /^evt_[0-9a-z]{8,}$/.test(value) ? value : undefined;
  if (value !== undefined && /^evt_[0-9a-z]{8,}$/.test(value.eventId)) return value.eventId;
  return undefined;
}

function receiptEventIds(result: unknown): string[] {
  if (result === null || typeof result !== "object") return [];
  const eventIds = (result as { eventIds?: unknown }).eventIds;
  if (!Array.isArray(eventIds)) return [];
  return eventIds.filter(
    (value): value is string => typeof value === "string" && /^evt_[0-9a-z]{8,}$/.test(value),
  );
}

function rejectionRecord(
  input: ExecuteIntentInput<unknown>,
  rejection: ActionRejection,
): DecisionRejectionRecord {
  return {
    runId: input.context.runId,
    tick: input.context.tick,
    agentId: input.intent.actor.id,
    type: input.intent.type,
    intentId: input.intent.intentId,
    ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
    code: rejection.code,
    message: rejection.message,
  };
}

function actionParamsForTrigger(
  agentId: string,
  trigger: TriggerSignal,
): Readonly<Record<string, unknown>> {
  return {
    agentId,
    sourceEventId: trigger.sourceEventId,
    triggerKind: trigger.kind,
    payload: trigger.payload,
  };
}

function personalityFactor(agent: Agent, trigger: TriggerSignal): number {
  const seed = hashValue({
    agentId: agent.id,
    occupationCode: agent.occupationCode,
    kind: trigger.kind,
  });
  return Number.parseInt(seed.slice(0, 4), 16) % 101;
}

function defaultRule<TState>(kind: TriggerKind): Tier1DecisionRule<TState> {
  const type = RULE_ONLY_ACTION_TYPES[kind];
  return {
    id: "tier1_" + kind + "_utility_v1",
    triggerKind: kind,
    buildOptions: ({ agent, trigger }) => {
      const trait = personalityFactor(agent, trigger);
      const respondUtility = trigger.priority * 10 + trait;
      const noOpUtility = 550 - trigger.priority * 3 + (100 - trait);
      return [
        decisionOptionSchema.parse({
          actionId: kind + ".respond",
          actionType: type,
          params: actionParamsForTrigger(agent.id, trigger),
          utility: respondUtility,
          utilityFactors: {
            triggerPriority: trigger.priority * 10,
            agentDisposition: trait,
          },
        }),
        decisionOptionSchema.parse({
          actionId: kind + ".no_op",
          actionType: RULE_ONLY_NO_OP_ACTION,
          params: {
            agentId: agent.id,
            reason: "utility_below_threshold",
            sourceEventId: trigger.sourceEventId,
          },
          utility: noOpUtility,
          utilityFactors: {
            inactionBaseline: 550,
            urgencyPenalty: -(trigger.priority * 3),
            dispositionReserve: 100 - trait,
          },
        }),
      ];
    },
  };
}

function fallbackNoOpOption(agentId: string, trigger: TriggerSignal): DecisionOption {
  return decisionOptionSchema.parse({
    actionId: trigger.kind + ".fallback_no_op",
    actionType: RULE_ONLY_NO_OP_ACTION,
    params: {
      agentId,
      reason: "tier1_rule_failed",
      sourceEventId: trigger.sourceEventId,
    },
    utility: 0,
    utilityFactors: { fallback: 1 },
  });
}

function chooseOption(options: readonly DecisionOption[]): DecisionOption {
  return [...options].sort((left, right) => {
    const utility = right.utility - left.utility;
    return utility !== 0 ? utility : compareCodeUnit(left.actionId, right.actionId);
  })[0]!;
}

/** Applies only the schema-bounded WS-703 prior delta; engine-authored menu identity is unchanged. */
export function applyDecisionPriorModifier(
  options: readonly DecisionOption[],
  rawModifier: DecisionPriorModifier,
): readonly DecisionOption[] {
  const modifier = decisionPriorModifierSchema.parse(rawModifier);
  return Object.freeze(options.map((rawOption) => {
    const option = decisionOptionSchema.parse(rawOption);
    const delta = option.actionType === RULE_ONLY_NO_OP_ACTION
      ? modifier.noOpDelta
      : modifier.respondDelta;
    return decisionOptionSchema.parse({
      ...option,
      utility: Math.max(-1_000_000, Math.min(1_000_000, option.utility + delta)),
      utilityFactors: {
        ...(option.utilityFactors ?? {}),
        sentimentPriorDelta: delta,
        sentimentIndex: modifier.sentimentValue,
        agentOpinion: modifier.opinionValue,
        sentimentPriorVersion: modifier.rulesetVersion,
      },
    });
  }));
}

export function registerRuleOnlyActionTypes<TState>(
  registry: ActionRegistry<TState>,
): void {
  const selfCapability = (
    params: { agentId: string },
    _context: ActionExecutionContext<TState>,
    intent: IntentEnvelope,
  ): true | ActionRejection => (
    intent.actor.kind === "agent" && intent.actor.id === params.agentId
      ? true
      : {
          code: "PERMISSION_DENIED",
          message: "rule-only action must target its own agent",
        }
  );
  for (const type of Object.values(RULE_ONLY_ACTION_TYPES)) {
    if (registry.has(type)) continue;
    registry.registerActionType(
      type,
      ruleActionParamsSchema,
      selfCapability,
      (): RuleOnlyActionReceipt => ({ acknowledged: true, eventIds: [] }),
    );
  }
  if (!registry.has(RULE_ONLY_NO_OP_ACTION)) {
    registry.registerActionType(
      RULE_ONLY_NO_OP_ACTION,
      noOpParamsSchema,
      selfCapability,
      (): RuleOnlyActionReceipt => ({ acknowledged: true, eventIds: [] }),
    );
  }
}

export class RuleDecisionEngine<TState = unknown> {
  readonly maxDecisionsPerAgentPerTick: number;
  readonly maxActionsPerAgentPerTick: number;
  readonly failureThreshold: number;
  readonly quarantineCooldownTicks: number;
  private readonly registry: ActionRegistry<TState>;
  private readonly tier1Rules = new Map<TriggerKind, Tier1DecisionRule<TState>>();
  private readonly tier0Routines: readonly Tier0Routine<TState>[];
  private readonly failures = new Map<string, FailureState>();

  constructor(options: RuleDecisionEngineOptions<TState>) {
    this.registry = options.registry;
    registerRuleOnlyActionTypes(this.registry);
    this.maxDecisionsPerAgentPerTick = validatePositiveCap(
      "maxDecisionsPerAgentPerTick",
      options.maxDecisionsPerAgentPerTick ?? 2,
      16,
    );
    this.maxActionsPerAgentPerTick = validatePositiveCap(
      "maxActionsPerAgentPerTick",
      options.maxActionsPerAgentPerTick ?? DEFAULT_MAX_ACTIONS_PER_AGENT_PER_TICK,
      32,
    );
    this.failureThreshold = validatePositiveCap(
      "failureThreshold",
      options.failureThreshold ?? 3,
      100,
    );
    this.quarantineCooldownTicks = validatePositiveCap(
      "quarantineCooldownTicks",
      options.quarantineCooldownTicks ?? 30,
      100_000,
    );
    for (const kind of TRIGGER_KINDS) this.tier1Rules.set(kind, defaultRule(kind));
    for (const rule of options.tier1Rules ?? []) this.setTier1Rule(rule);
    this.tier0Routines = Object.freeze([...(options.tier0Routines ?? [])].sort((left, right) => {
      const order = left.order - right.order;
      return order !== 0 ? order : compareCodeUnit(left.id, right.id);
    }));
  }

  setTier1Rule(rule: Tier1DecisionRule<TState>): void {
    if (!/^[a-z][a-z0-9_]*$/.test(rule.id)) {
      throw new EngineError("VALIDATION_FAILED", "invalid Tier 1 rule id: " + rule.id);
    }
    this.tier1Rules.set(rule.triggerKind, rule);
  }

  getQuarantine(agentId: string, tick: number): AgentQuarantine {
    const state = this.failures.get(agentId);
    if (state?.quarantineUntilTick !== undefined && tick > state.quarantineUntilTick) {
      state.quarantineUntilTick = undefined;
      state.consecutiveFailures = 0;
    }
    if (state?.quarantineUntilTick !== undefined) {
      return {
        mode: "tier1_only",
        untilTick: state.quarantineUntilTick,
        consecutiveFailures: Math.max(1, state.consecutiveFailures),
      };
    }
    return { mode: "none" };
  }

  recordAgentFailure(
    agentId: string,
    tick: number,
    reason: string,
  ): QuarantineTransition | undefined {
    const state = this.failures.get(agentId) ?? { consecutiveFailures: 0 };
    if (state.quarantineUntilTick !== undefined && tick > state.quarantineUntilTick) {
      state.quarantineUntilTick = undefined;
      state.consecutiveFailures = 0;
    }
    state.consecutiveFailures += 1;
    if (state.quarantineUntilTick !== undefined && tick <= state.quarantineUntilTick) {
      this.failures.set(agentId, state);
      return undefined;
    }
    if (state.consecutiveFailures < this.failureThreshold) {
      this.failures.set(agentId, state);
      return undefined;
    }
    state.quarantineUntilTick = Math.max(
      state.quarantineUntilTick ?? 0,
      tick + this.quarantineCooldownTicks,
    );
    this.failures.set(agentId, state);
    return {
      agentId,
      tick,
      untilTick: state.quarantineUntilTick,
      consecutiveFailures: state.consecutiveFailures,
      reason,
    };
  }

  recordAgentSuccess(agentId: string): void {
    const state = this.failures.get(agentId);
    if (state !== undefined) state.consecutiveFailures = 0;
  }

  runTick(input: RuleDecisionTickInput<TState>): RuleDecisionTickResult {
    if (!Number.isSafeInteger(input.tick) || input.tick < 1) {
      throw new EngineError("VALIDATION_FAILED", "invalid decision tick: " + input.tick);
    }
    if (input.wakeSet.tick !== input.tick) {
      throw new EngineError("CONFLICT", "wake set tick does not match decision tick");
    }
    const context: ActionExecutionContext<TState> = {
      runId: input.runId,
      tick: input.tick,
      state: input.state,
    };
    const agents = [...input.agents].sort((left, right) => compareCodeUnit(left.id, right.id));
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const actionCounts = new Map<string, number>();
    for (const [agentId, count] of Object.entries(input.initialActionCounts ?? {})
      .sort(([left], [right]) => compareCodeUnit(left, right))) {
      if (!agentsById.has(agentId)) {
        throw new EngineError(
          "VALIDATION_FAILED",
          `initial action count references unknown agent ${agentId}`,
        );
      }
      if (!Number.isSafeInteger(count) || count < 0 || count > this.maxActionsPerAgentPerTick) {
        throw new EngineError(
          "VALIDATION_FAILED",
          `invalid initial action count for ${agentId}: ${count}`,
        );
      }
      if (count > 0) actionCounts.set(agentId, count);
    }
    const decisions: Decision[] = [];
    const actions: AgentAction[] = [];
    const rejections: DecisionRejectionRecord[] = [];
    const quarantines: QuarantineTransition[] = [];
    let tier0RoutinesRun = 0;
    let decisionCapDrops = 0;
    let actionCapDrops = 0;

    const noteFailure = (agentId: string, reason: string): void => {
      const transition = this.recordAgentFailure(agentId, input.tick, reason);
      if (transition === undefined) return;
      quarantines.push(transition);
      input.emit?.(
        "agent.quarantined",
        transition,
        {
          actor: { kind: "agent", id: agentId },
          correlationId: "quarantine_" + agentId + "_" + input.tick,
        },
      );
    };

    const executeIntent = (
      executionInput: ExecuteIntentInput<TState>,
      countAgainstCap = true,
    ): ExecuteIntentResult => {
      const agentId = executionInput.intent.actor.id;
      if (executionInput.intent.actor.kind !== "agent") {
        return {
          validationApproved: false,
          rejection: {
            code: "PERMISSION_DENIED",
            message: "agent decision engine accepts only agent actors",
          },
        };
      }
      if (countAgainstCap && (actionCounts.get(agentId) ?? 0) >= this.maxActionsPerAgentPerTick) {
        actionCapDrops += 1;
        return {
          validationApproved: false,
          rejection: {
            code: "LIMIT_EXCEEDED",
            message: "per-agent action cap reached for this tick",
          },
        };
      }
      const preparation = this.registry.prepare(executionInput.intent, executionInput.context);
      if (!preparation.ok) {
        return {
          validationApproved: false,
          rejection: preparation.rejection,
        };
      }
      actionCounts.set(agentId, (actionCounts.get(agentId) ?? 0) + 1);
      const actionId = input.ids.next("act");
      input.emit?.(
        "agent.action.started",
        {
          actionId,
          decisionId: executionInput.decisionId ?? null,
          type: executionInput.intent.type,
        },
        {
          actor: { kind: "agent", id: agentId },
          correlationId: executionInput.intent.correlationId,
          ...(executionInput.sourceEventId === undefined
            ? {}
            : { causationId: executionInput.sourceEventId }),
        },
      );
      const execution = this.registry.executePrepared(preparation.prepared, executionInput.context);
      if (execution.status === "applied") {
        const resultEventIds = receiptEventIds(execution.result);
        const completed = emittedEventId(input.emit?.(
          "agent.action.completed",
          {
            actionId,
            decisionId: executionInput.decisionId ?? null,
            type: executionInput.intent.type,
          },
          {
            actor: { kind: "agent", id: agentId },
            correlationId: executionInput.intent.correlationId,
            ...(executionInput.sourceEventId === undefined
              ? {}
              : { causationId: executionInput.sourceEventId }),
          },
        ));
        if (completed !== undefined) resultEventIds.push(completed);
        return {
          validationApproved: true,
          action: agentActionSchema.parse({
            id: actionId,
            runId: input.runId,
            ...(executionInput.decisionId === undefined
              ? {}
              : { decisionId: executionInput.decisionId }),
            actorId: agentId,
            type: executionInput.intent.type,
            params: execution.params,
            status: "applied",
            resultEventIds,
          }),
        };
      }
      const failed = emittedEventId(input.emit?.(
        "agent.action.rejected",
        {
          actionId,
          decisionId: executionInput.decisionId ?? null,
          type: executionInput.intent.type,
          code: execution.error.code,
          message: execution.error.message,
          stage: "execution",
        },
        {
          actor: { kind: "agent", id: agentId },
          correlationId: executionInput.intent.correlationId,
          ...(executionInput.sourceEventId === undefined
            ? {}
            : { causationId: executionInput.sourceEventId }),
        },
      ));
      return {
        validationApproved: true,
        rejection: execution.error,
        action: agentActionSchema.parse({
          id: actionId,
          runId: input.runId,
          ...(executionInput.decisionId === undefined
            ? {}
            : { decisionId: executionInput.decisionId }),
          actorId: agentId,
          type: executionInput.intent.type,
          params: execution.params,
          status: "failed",
          resultEventIds: failed === undefined ? [] : [failed],
          error: {
            code: execution.error.code,
            message: execution.error.message,
          },
        }),
      };
    };

    for (const agent of agents) {
      if (!agent.aliveFlags.alive || !agent.aliveFlags.canAct) continue;
      if (agent.quarantine.mode === "tier1_only") {
        const current = this.failures.get(agent.id) ?? {
          consecutiveFailures: agent.quarantine.consecutiveFailures,
        };
        current.consecutiveFailures = Math.max(
          current.consecutiveFailures,
          agent.quarantine.consecutiveFailures,
        );
        current.quarantineUntilTick = Math.max(
          current.quarantineUntilTick ?? 0,
          agent.quarantine.untilTick,
        );
        this.failures.set(agent.id, current);
      }
      for (const routine of this.tier0Routines) {
        tier0RoutinesRun += 1;
        let requests: readonly Tier0ActionRequest[];
        try {
          requests = routine.run({
            runId: input.runId,
            tick: input.tick,
            agent,
            state: input.state,
          });
          if (!Array.isArray(requests)) {
            throw new EngineError(
              "SCHEMA_INVALID",
              "Tier 0 routine must return an array of action requests",
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tier 0 routine failed";
          const rejection: DecisionRejectionRecord = {
            runId: input.runId,
            tick: input.tick,
            agentId: agent.id,
            type: "routine." + routine.id,
            code: "INTERNAL",
            message,
          };
          rejections.push(rejection);
          noteFailure(agent.id, "tier0_routine_failed");
          continue;
        }
        for (const request of requests) {
          let candidate: IntentEnvelope;
          try {
            const intentId = input.ids.next("int");
            candidate = intentEnvelopeSchema.parse({
              intentId,
              type: request.type,
              actor: { kind: "agent", id: agent.id },
              tick: input.tick,
              params: request.params,
              correlationId: intentId,
            }) as IntentEnvelope;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Tier 0 intent is invalid";
            rejections.push({
              runId: input.runId,
              tick: input.tick,
              agentId: agent.id,
              type: typeof request?.type === "string" ? request.type : "routine.invalid_request",
              code: "SCHEMA_INVALID",
              message,
            });
            noteFailure(agent.id, "tier0_intent_invalid");
            continue;
          }
          const outcome = executeIntent({ intent: candidate, context, emit: input.emit });
          if (outcome.action !== undefined) actions.push(outcome.action);
          if (outcome.rejection !== undefined) {
            const record = rejectionRecord(
              { intent: candidate, context, emit: input.emit },
              outcome.rejection,
            );
            rejections.push(record);
            if (!outcome.validationApproved) {
              input.emit?.(
                "agent.action.rejected",
                record,
                {
                  actor: { kind: "agent", id: agent.id },
                  correlationId: candidate.correlationId,
                },
              );
            }
            noteFailure(agent.id, "tier0_action_failed");
          } else {
            this.recordAgentSuccess(agent.id);
          }
        }
      }
    }

    for (const wake of input.wakeSet.entries) {
      const agent = agentsById.get(wake.agentId);
      if (agent === undefined || !agent.aliveFlags.alive || !agent.aliveFlags.canAct) continue;
      const selectedTriggers = wake.triggers.slice(0, this.maxDecisionsPerAgentPerTick);
      decisionCapDrops += wake.triggers.length - selectedTriggers.length;
      for (const trigger of selectedTriggers) {
        const decisionId = input.ids.next("dec");
        const ruleContext: Tier1RuleContext<TState> = {
          runId: input.runId,
          tick: input.tick,
          agent,
          trigger,
          state: input.state,
        };
        let observation: DecisionObservation;
        try {
          observation = input.observationProvider?.(ruleContext) ?? {
            summary: "Agent " + agent.id + " observed a " + trigger.kind + " trigger.",
            facts: {
              employmentStatus: agent.employmentStatus,
              occupationCode: agent.occupationCode,
              triggerPayload: trigger.payload,
            },
          };
          if (observation.summary.trim().length === 0 || observation.summary.length > 4_000) {
            throw new Error("observation summary is empty or too long");
          }
        } catch {
          observation = {
            summary: "Agent " + agent.id + " received a " + trigger.kind + " trigger.",
            facts: { triggerPayload: trigger.payload },
          };
        }

        const rule = this.tier1Rules.get(trigger.kind)!;
        let options: readonly DecisionOption[];
        let ruleFailure: string | undefined;
        let prior: DecisionPriorModifier | undefined;
        let priorFailure = false;
        try {
          const candidate = input.priorProvider?.(ruleContext);
          prior = candidate === undefined
            ? undefined
            : decisionPriorModifierSchema.parse(candidate);
        } catch {
          priorFailure = true;
        }
        try {
          options = rule.buildOptions(ruleContext).map((option) => decisionOptionSchema.parse(option));
          if (options.length === 0 || options.length > 32) {
            throw new EngineError("SCHEMA_INVALID", "Tier 1 rule returned an invalid option count");
          }
          if (prior !== undefined) options = applyDecisionPriorModifier(options, prior);
          options = Object.freeze([...options].sort((left, right) =>
            compareCodeUnit(left.actionId, right.actionId)
          ));
        } catch (error) {
          ruleFailure = error instanceof Error ? error.message : "Tier 1 rule failed";
          options = [fallbackNoOpOption(agent.id, trigger)];
        }
        const chosen = chooseOption(options);
        const intentId = input.ids.next("int");
        const intent = intentEnvelopeSchema.parse({
          intentId,
          type: chosen.actionType,
          actor: { kind: "agent", id: agent.id },
          tick: input.tick,
          params: chosen.params,
          decisionId,
          correlationId: decisionId,
        }) as IntentEnvelope;
        const outcome = executeIntent({
          intent,
          context,
          decisionId,
          sourceEventId: trigger.sourceEventId,
          emit: input.emit,
        });
        if (outcome.action !== undefined) actions.push(outcome.action);
        if (outcome.rejection !== undefined) {
          const record = rejectionRecord({
            intent,
            context,
            decisionId,
            sourceEventId: trigger.sourceEventId,
            emit: input.emit,
          }, outcome.rejection);
          rejections.push(record);
          if (!outcome.validationApproved) {
            input.emit?.(
              "agent.action.rejected",
              record,
              {
                actor: { kind: "agent", id: agent.id },
                correlationId: intent.correlationId,
                causationId: trigger.sourceEventId,
              },
            );
          }
        }
        const validationResult = outcome.validationApproved
          ? { status: "approved" as const }
          : {
              status: "rejected" as const,
              code: outcome.rejection?.code ?? "INTERNAL",
              message: outcome.rejection?.message ?? "action validation failed",
            };
        let observationHash: string;
        try {
          observationHash = hashValue({
            agentId: agent.id,
            tick: input.tick,
            trigger,
            facts: observation.facts ?? null,
            summary: observation.summary,
          });
        } catch {
          observationHash = hashValue({
            agentId: agent.id,
            tick: input.tick,
            trigger,
            summary: observation.summary,
          });
        }
        const decision = decisionSchema.parse({
          id: decisionId,
          runId: input.runId,
          agentId: agent.id,
          tick: input.tick,
          trigger: {
            kind: trigger.kind,
            sourceEventId: trigger.sourceEventId,
            priority: trigger.priority,
          },
          tier: 1,
          observationDigest: {
            hash: observationHash,
            summary: observation.summary,
          },
          optionsOffered: options,
          chosenActionId: chosen.actionId,
          params: chosen.params,
          rationale: ruleFailure === undefined
            ? (
                "rule:" + rule.id + "; selected maximum utility " + chosen.utility +
                (prior === undefined
                  ? priorFailure ? "; sentiment prior invalid and skipped" : ""
                  : `; sentiment prior v${prior.rulesetVersion} delta ${prior.respondDelta}`)
              )
            : "rule:" + rule.id + "; failed: " + ruleFailure + "; deterministic no-op fallback",
          ...(prior === undefined ? {} : { priorModifier: prior }),
          validationResult,
        });
        decisions.push(decision);
        input.count?.("decisions", 1);
        if (ruleFailure !== undefined) {
          noteFailure(agent.id, "tier1_rule_failed");
        } else if (outcome.rejection !== undefined) {
          noteFailure(agent.id, outcome.validationApproved
            ? "tier1_action_execution_failed"
            : "tier1_action_rejected");
        } else {
          this.recordAgentSuccess(agent.id);
        }
      }
    }

    return Object.freeze({
      decisions: Object.freeze(decisions),
      actions: Object.freeze(actions),
      rejections: Object.freeze(rejections),
      quarantines: Object.freeze(quarantines),
      tier0RoutinesRun,
      decisionCapDrops,
      actionCapDrops,
    });
  }
}
