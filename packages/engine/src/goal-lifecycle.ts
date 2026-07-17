/** WS-208 deterministic goal activation, progress, terminal states, and triggers. */

import { EngineError, goalSchema } from "@worldtangle/shared";
import type { EventEnvelope, Goal, TriggerSignal } from "@worldtangle/shared";

export interface GoalLifecycleRecord {
  readonly goal: Goal;
  /** Event that most recently activated or progressed this goal. */
  readonly triggerEventId: string;
  readonly activatedTick: number | null;
  readonly terminalTick: number | null;
}

export interface GoalLifecycleRepository {
  get(goalId: string): GoalLifecycleRecord | null;
  listByAgent(agentId: string): readonly GoalLifecycleRecord[];
  transition(
    previous: GoalLifecycleRecord,
    next: GoalLifecycleRecord,
  ): void;
}

export interface GoalActivationContext<TFacts = unknown> {
  readonly tick: number;
  readonly goal: Goal;
  readonly activeGoals: readonly Goal[];
  readonly allGoals: readonly Goal[];
  readonly facts: TFacts;
}

export type GoalActivationRule<TFacts = unknown> = (
  context: GoalActivationContext<TFacts>,
) => boolean;

export interface GoalLifecycleEventOptions {
  readonly actor: { readonly kind: "agent"; readonly id: string };
  readonly correlationId: string;
  readonly causationId?: string;
}

export type GoalLifecycleEventEmitter = (
  type: string,
  payload: unknown,
  options: GoalLifecycleEventOptions,
) => EventEnvelope | string | void;

export interface GoalLifecycleOptions<TFacts = unknown> {
  readonly repository: GoalLifecycleRepository;
  readonly activationRules?: Readonly<Record<string, GoalActivationRule<TFacts>>>;
  readonly maxActiveGoals?: number;
}

export interface GoalTransitionInput {
  readonly tick: number;
  readonly sourceEventId?: string;
  readonly rationale: string;
  readonly emit: GoalLifecycleEventEmitter;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emittedEventId(value: EventEnvelope | string | void): string | undefined {
  if (typeof value === "string") return /^evt_[0-9a-z]{8,}$/.test(value) ? value : undefined;
  if (value !== undefined && /^evt_[0-9a-z]{8,}$/.test(value.eventId)) return value.eventId;
  return undefined;
}

function requireTransitionEvent(
  value: EventEnvelope | string | void,
  type: string,
): string {
  const eventId = emittedEventId(value);
  if (eventId === undefined) {
    throw new EngineError("INTERNAL", `${type} transition did not produce an event ID`);
  }
  return eventId;
}

function validateTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 1) {
    throw new EngineError("VALIDATION_FAILED", `invalid goal lifecycle tick: ${tick}`);
  }
}

function validateRecord(record: GoalLifecycleRecord): GoalLifecycleRecord {
  const goal = goalSchema.parse(record.goal);
  if (!/^evt_[0-9a-z]{8,}$/.test(record.triggerEventId)) {
    throw new EngineError("VALIDATION_FAILED", "goal trigger event ID is invalid");
  }
  for (const [name, value] of [
    ["activatedTick", record.activatedTick],
    ["terminalTick", record.terminalTick],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new EngineError("VALIDATION_FAILED", `${name} must be a nonnegative tick or null`);
    }
  }
  return Object.freeze({ ...record, goal });
}

/** Deterministic MVP rules for Riverbend's cataloged activation predicates. */
export function defaultGoalActivationRule(
  context: GoalActivationContext<unknown>,
): boolean {
  if (context.activeGoals.length > 0) return false;
  const fastRules = new Set(["job_opening_seen", "durable_need_detected"]);
  if (fastRules.has(context.goal.activationRule)) return true;
  const quarterlyRules = new Set(["career_review_due", "retirement_review_due"]);
  if (quarterlyRules.has(context.goal.activationRule)) return (context.tick - 1) % 90 === 0;
  return (context.tick - 1) % 30 === 0;
}

export class GoalLifecycleEngine<TFacts = unknown> {
  readonly maxActiveGoals: number;
  private readonly repository: GoalLifecycleRepository;
  private readonly activationRules: Readonly<Record<string, GoalActivationRule<TFacts>>>;

  constructor(options: GoalLifecycleOptions<TFacts>) {
    this.repository = options.repository;
    this.activationRules = options.activationRules ?? {};
    this.maxActiveGoals = options.maxActiveGoals ?? 3;
    if (!Number.isSafeInteger(this.maxActiveGoals) || this.maxActiveGoals < 1 || this.maxActiveGoals > 10) {
      throw new EngineError("VALIDATION_FAILED", "maxActiveGoals must be an integer from 1 to 10");
    }
  }

  /** Read-only, deterministic menu source for Tier-2 goal activation. */
  eligibleForActivation(
    agentId: string,
    tick: number,
    facts: TFacts,
  ): readonly GoalLifecycleRecord[] {
    validateTick(tick);
    const records = this.repository.listByAgent(agentId).map(validateRecord);
    const allGoals = records.map((record) => record.goal);
    const active = records.filter((record) => record.goal.status === "active");
    const available = Math.max(0, this.maxActiveGoals - active.length);
    if (available === 0) return Object.freeze([]);
    const candidates = records
      .filter((record) => record.goal.status === "dormant")
      .sort((left, right) =>
        right.goal.priority - left.goal.priority || compareCodeUnit(left.goal.id, right.goal.id)
      );
    const eligible: GoalLifecycleRecord[] = [];
    for (const record of candidates) {
      if (eligible.length >= available) break;
      const rule = this.activationRules[record.goal.activationRule] ??
        (defaultGoalActivationRule as GoalActivationRule<TFacts>);
      if (rule({
          tick,
          goal: record.goal,
          activeGoals: [...active, ...eligible].map((item) => item.goal),
          allGoals,
          facts,
        })) {
        eligible.push(record);
      }
    }
    return Object.freeze(eligible);
  }

  /** Activate exactly one engine-eligible goal selected from a bounded menu. */
  activateSelected(
    goalId: string,
    tick: number,
    facts: TFacts,
    emit: GoalLifecycleEventEmitter,
  ): GoalLifecycleRecord {
    validateTick(tick);
    const current = this.repository.get(goalId);
    if (current === null) throw new EngineError("NOT_FOUND", `goal ${goalId} does not exist`);
    const record = validateRecord(current);
    if (record.goal.status !== "dormant") {
      throw new EngineError("CONFLICT", `goal ${goalId} is not dormant`);
    }
    const eligible = this.eligibleForActivation(record.goal.agentId, tick, facts);
    if (!eligible.some((candidate) => candidate.goal.id === goalId)) {
      throw new EngineError("VALIDATION_FAILED", `goal ${goalId} is not eligible for activation`);
    }
    const eventId = requireTransitionEvent(emit(
      "agent.goal.activated",
      {
        agentId: record.goal.agentId,
        goalId: record.goal.id,
        kind: record.goal.kind,
        previousStatus: "dormant",
        status: "active",
        activationRule: record.goal.activationRule,
      },
      {
        actor: { kind: "agent", id: record.goal.agentId },
        correlationId: record.goal.id,
        causationId: record.triggerEventId,
      },
    ), "agent.goal.activated");
    const next = validateRecord({
      goal: { ...record.goal, status: "active" },
      triggerEventId: eventId,
      activatedTick: tick,
      terminalTick: null,
    });
    this.repository.transition(record, next);
    return next;
  }

  activateEligible(
    agentId: string,
    tick: number,
    facts: TFacts,
    emit: GoalLifecycleEventEmitter,
  ): readonly GoalLifecycleRecord[] {
    validateTick(tick);
    const activated: GoalLifecycleRecord[] = [];
    for (const record of this.eligibleForActivation(agentId, tick, facts)) {
      activated.push(this.activateSelected(record.goal.id, tick, facts, emit));
    }
    return Object.freeze(activated);
  }

  advance(goalId: string, delta: number, input: GoalTransitionInput): GoalLifecycleRecord {
    validateTick(input.tick);
    if (!Number.isFinite(delta) || delta <= 0 || delta > 1) {
      throw new EngineError("VALIDATION_FAILED", "goal progress delta must be greater than 0 and at most 1");
    }
    const current = this.getRequired(goalId);
    if (current.goal.status !== "active") {
      throw new EngineError("CONFLICT", `goal ${goalId} is not active`);
    }
    const progress = Math.min(1, Math.round((current.goal.progress + delta) * 1_000_000) / 1_000_000);
    const achieved = progress === 1;
    const type = achieved ? "agent.goal.achieved" : "agent.goal.progressed";
    const eventId = requireTransitionEvent(input.emit(
      type,
      {
        agentId: current.goal.agentId,
        goalId,
        kind: current.goal.kind,
        previousProgress: current.goal.progress,
        progress,
        previousStatus: current.goal.status,
        status: achieved ? "achieved" : "active",
        rationale: input.rationale,
      },
      {
        actor: { kind: "agent", id: current.goal.agentId },
        correlationId: goalId,
        causationId: input.sourceEventId ?? current.triggerEventId,
      },
    ), type);
    const next = validateRecord({
      goal: {
        ...current.goal,
        progress,
        status: achieved ? "achieved" : "active",
      },
      triggerEventId: eventId,
      activatedTick: current.activatedTick,
      terminalTick: achieved ? input.tick : null,
    });
    this.repository.transition(current, next);
    return next;
  }

  abandon(goalId: string, input: GoalTransitionInput): GoalLifecycleRecord {
    validateTick(input.tick);
    const current = this.getRequired(goalId);
    if (current.goal.status === "achieved" || current.goal.status === "abandoned") {
      throw new EngineError("CONFLICT", `goal ${goalId} is already terminal`);
    }
    const eventId = requireTransitionEvent(input.emit(
      "agent.goal.abandoned",
      {
        agentId: current.goal.agentId,
        goalId,
        kind: current.goal.kind,
        previousStatus: current.goal.status,
        status: "abandoned",
        progress: current.goal.progress,
        rationale: input.rationale,
      },
      {
        actor: { kind: "agent", id: current.goal.agentId },
        correlationId: goalId,
        causationId: input.sourceEventId ?? current.triggerEventId,
      },
    ), "agent.goal.abandoned");
    const next = validateRecord({
      goal: { ...current.goal, status: "abandoned" },
      triggerEventId: eventId,
      activatedTick: current.activatedTick,
      terminalTick: input.tick,
    });
    this.repository.transition(current, next);
    return next;
  }

  activeTriggers(agentId: string, tick: number): readonly TriggerSignal[] {
    validateTick(tick);
    return this.repository.listByAgent(agentId)
      .map(validateRecord)
      .filter((record) => record.goal.status === "active")
      .sort((left, right) =>
        right.goal.priority - left.goal.priority || compareCodeUnit(left.goal.id, right.goal.id)
      )
      .map((record): TriggerSignal => ({
        kind: "goal",
        agentId,
        sourceEventId: record.triggerEventId,
        tick,
        priority: record.goal.priority * 20,
        payload: { goalId: record.goal.id, goalKind: record.goal.kind },
      }));
  }

  private getRequired(goalId: string): GoalLifecycleRecord {
    const record = this.repository.get(goalId);
    if (record === null) throw new EngineError("NOT_FOUND", `goal ${goalId} does not exist`);
    return validateRecord(record);
  }
}

export class InMemoryGoalLifecycleRepository implements GoalLifecycleRepository {
  private readonly records = new Map<string, GoalLifecycleRecord>();

  constructor(records: readonly GoalLifecycleRecord[] = []) {
    for (const record of records) {
      const validated = validateRecord(record);
      if (this.records.has(validated.goal.id)) {
        throw new EngineError("CONFLICT", `duplicate goal ${validated.goal.id}`);
      }
      this.records.set(validated.goal.id, validated);
    }
  }

  get(goalId: string): GoalLifecycleRecord | null {
    return this.records.get(goalId) ?? null;
  }

  listByAgent(agentId: string): readonly GoalLifecycleRecord[] {
    return [...this.records.values()]
      .filter((record) => record.goal.agentId === agentId)
      .sort((left, right) => compareCodeUnit(left.goal.id, right.goal.id));
  }

  transition(previous: GoalLifecycleRecord, next: GoalLifecycleRecord): void {
    const current = this.records.get(previous.goal.id);
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new EngineError("CONFLICT", `stale goal transition for ${previous.goal.id}`);
    }
    if (next.goal.id !== previous.goal.id || next.goal.agentId !== previous.goal.agentId) {
      throw new EngineError("VALIDATION_FAILED", "goal identity is immutable");
    }
    this.records.set(next.goal.id, validateRecord(next));
  }
}
