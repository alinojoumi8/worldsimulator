/** Durable Phase 2 goal activation, memory-backed decisions, and action persistence. */

import { canonicalStringify, EngineError } from "@worldtangle/shared";
import type { DecisionPriorModifier, EventEnvelope, TriggerSignal } from "@worldtangle/shared";
import {
  ActionRegistry,
  buildDecisionPriorModifier,
  DeterministicMemoryStore,
  GoalLifecycleEngine,
  opinionAxisForSentimentTopic,
  RuleDecisionEngine,
  sentimentTopicForTrigger,
  TriggerEvaluator,
} from "@worldtangle/engine";
import type {
  ActionRejection,
  PhaseHandler,
  TickContext,
} from "@worldtangle/engine";
import { z } from "zod";
import { SqliteAgentStore, SqliteSentimentStore } from "./persistence";
import type { WorldDatabase } from "./persistence";

const GOAL_DECISION_CADENCE_TICKS = 30;
const GOAL_PROGRESS_DELTA = 0.1;

const goalActionParamsSchema = z.object({
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  triggerKind: z.literal("goal"),
  payload: z.object({
    goalId: z.string().regex(/^gol_[0-9a-z]{8}$/),
    goalKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }).strict(),
}).strict();

interface AgentPhaseState {
  readonly store: SqliteAgentStore;
  readonly lifecycle: GoalLifecycleEngine<Record<string, never>>;
  readonly emit: TickContext["emit"];
}

interface PersistedActionCountRow {
  readonly actor_id: string;
  readonly actions: bigint;
}

export interface AgentDecisionPhaseOptions {
  readonly reservedActionCountsForTick?: (
    tick: number,
  ) => Readonly<Record<string, number>>;
}

export function goalDecisionDue(tick: number): boolean {
  return (tick - 1) % GOAL_DECISION_CADENCE_TICKS === 0;
}

function eventId(value: EventEnvelope | string | void): string | undefined {
  if (typeof value === "string") return /^evt_[0-9a-z]{8,}$/.test(value) ? value : undefined;
  return value?.eventId;
}

function createLifecycle(store: SqliteAgentStore): GoalLifecycleEngine<Record<string, never>> {
  return new GoalLifecycleEngine({ repository: store });
}

export function createGoalActivationPhaseHandler(
  db: WorldDatabase,
  runId: string,
  options: { readonly automatic?: boolean } = {},
): PhaseHandler {
  const store = new SqliteAgentStore(db, runId);
  return {
    module: "M02-goal-lifecycle",
    order: 100,
    run(ctx) {
      if (!store.hasPopulation() || options.automatic === false) return;
      const lifecycle = createLifecycle(store);
      for (const agent of store.listAgentEntities()) {
        lifecycle.activateEligible(agent.id, ctx.tick, {}, ctx.emit);
      }
    },
  };
}

export function createAgentDecisionPhaseHandler(
  db: WorldDatabase,
  runId: string,
  options: AgentDecisionPhaseOptions = {},
): PhaseHandler {
  const store = new SqliteAgentStore(db, runId);
  const sentimentStore = new SqliteSentimentStore(db, runId);
  return {
    module: "M04-agent-decisions",
    order: 100,
    run(ctx) {
      if (!store.hasPopulation() || !goalDecisionDue(ctx.tick)) return;
      const agents = store.listAgentEntities();
      const lifecycle = createLifecycle(store);
      const signals: TriggerSignal[] = [];
      for (const agent of agents) signals.push(...lifecycle.activeTriggers(agent.id, ctx.tick));
      const wakeSet = new TriggerEvaluator({ maxTriggersPerAgentPerTick: 3 }).evaluateTriggers(
        ctx.tick,
        signals,
        new Set(agents.map((agent) => agent.id)),
      );
      const state: AgentPhaseState = { store, lifecycle, emit: ctx.emit };
      const registry = new ActionRegistry<AgentPhaseState>({
        capabilityCheck: ({ actor, params }) => {
          const parsed = goalActionParamsSchema.safeParse(params);
          if (
            parsed.success &&
            (actor.kind !== "agent" || actor.id !== parsed.data.agentId)
          ) {
            return {
              code: "PERMISSION_DENIED",
              message: "an agent may advance only its own goal",
            };
          }
          return true;
        },
      });
      registry.registerActionType(
        "agent.advance_goal",
        goalActionParamsSchema,
        (params): true | ActionRejection => {
          const record = store.get(params.payload.goalId);
          if (record === null) {
            return { code: "NOT_FOUND", message: `goal ${params.payload.goalId} does not exist` };
          }
          if (record.goal.agentId !== params.agentId) {
            return { code: "PERMISSION_DENIED", message: "goal belongs to another agent" };
          }
          if (record.goal.status !== "active") {
            return { code: "CONFLICT", message: "goal is not active" };
          }
          return true;
        },
        (params, context) => {
          const advanced = context.state.lifecycle.advance(params.payload.goalId, GOAL_PROGRESS_DELTA, {
            tick: context.tick,
            sourceEventId: params.sourceEventId,
            rationale: "tier1_goal_progress_v1",
            emit: context.state.emit,
          });
          return { acknowledged: true, eventIds: [advanced.triggerEventId] };
        },
      );
      const memoryStore = new DeterministicMemoryStore({
        repository: store,
        ids: ctx.ids,
      });
      const priors = new Map<string, DecisionPriorModifier | undefined>();
      const priorFor = (agentId: string, trigger: TriggerSignal): DecisionPriorModifier | undefined => {
        const key = agentId + ":" + trigger.sourceEventId;
        if (priors.has(key)) return priors.get(key);
        const topic = sentimentTopicForTrigger(trigger.kind, trigger.payload);
        const sentiment = sentimentStore.getEffectiveSentiment(topic, ctx.tick - 1);
        if (sentiment === null) {
          priors.set(key, undefined);
          return undefined;
        }
        const opinionAxis = opinionAxisForSentimentTopic(topic);
        const opinion = sentimentStore.getCurrentOpinion(agentId, opinionAxis, ctx.tick - 1);
        const prior = buildDecisionPriorModifier({
          topic,
          sentimentValue: sentiment.value,
          sentimentUpdate: sentiment.update,
          contributingStoryIds: sentimentStore.listRecentContributingStoryIds(topic),
          opinionAxis,
          opinionValue: opinion.value,
          ...(opinion.update === null ? {} : { opinionUpdate: opinion.update }),
        });
        priors.set(key, prior);
        return prior;
      };
      const engine = new RuleDecisionEngine({ registry });
      const initialActionCounts: Record<string, number> = {};
      for (const row of db.prepare<[string, number], PersistedActionCountRow>(`
        SELECT a.actor_id, COUNT(*) AS actions
        FROM agent_actions a
        JOIN decisions d
          ON d.run_id = a.run_id AND d.id = a.decision_id
        WHERE a.run_id = ? AND d.tick = ?
        GROUP BY a.actor_id ORDER BY a.actor_id
      `).all(runId, ctx.tick)) {
        const actions = Number(row.actions);
        if (!Number.isSafeInteger(actions) || actions < 0) {
          throw new EngineError("INTERNAL", `invalid persisted action count for ${row.actor_id}`);
        }
        initialActionCounts[row.actor_id] = actions;
      }
      const reservations = options.reservedActionCountsForTick?.(ctx.tick) ?? {};
      for (const [agentId, reserved] of Object.entries(reservations)) {
        initialActionCounts[agentId] = (initialActionCounts[agentId] ?? 0) + reserved;
      }
      const result = engine.runTick({
        runId,
        tick: ctx.tick,
        agents,
        wakeSet,
        ids: ctx.ids,
        state,
        initialActionCounts,
        count: ctx.count,
        emit: ctx.emit,
        priorProvider: ({ agent, trigger }) => priorFor(agent.id, trigger),
        observationProvider: ({ agent, trigger }) => {
          const memories = memoryStore.retrieve(agent.id, {
            tick: ctx.tick,
            triggerKind: trigger.kind,
            queryText: canonicalStringify(trigger.payload),
            referenceIds: [trigger.sourceEventId],
            preferredKinds: ["event", "outcome"],
          }, 5);
          const facts = {
            employmentStatus: agent.employmentStatus,
            occupationCode: agent.occupationCode,
            triggerPayload: trigger.payload,
            sentimentPrior: priorFor(agent.id, trigger) ?? null,
            memories: memories.map(({ memory, score }) => ({
              id: memory.id,
              tick: memory.tick,
              kind: memory.kind,
              content: memory.content,
              importance: memory.importance,
              score,
            })),
          };
          return {
            summary: canonicalStringify({
              agentId: agent.id,
              triggerKind: trigger.kind,
              memoryIds: memories.map(({ memory }) => memory.id),
            }),
            facts,
          };
        },
      });
      store.saveDecisionResult(result.decisions, result.actions);
      for (const quarantine of result.quarantines) {
        store.setAgentQuarantine(quarantine.agentId, {
          mode: "tier1_only",
          untilTick: quarantine.untilTick,
          consecutiveFailures: quarantine.consecutiveFailures,
        });
      }
      const actionsByDecision = new Map(
        result.actions
          .filter((action) => action.decisionId !== undefined)
          .map((action) => [action.decisionId!, action]),
      );
      for (const decision of result.decisions) {
        const action = actionsByDecision.get(decision.id);
        const recorded = memoryStore.record({
          runId,
          agentId: decision.agentId,
          tick: ctx.tick,
          kind: "outcome",
          content: (
            `At tick ${ctx.tick}, the rule policy selected ` +
            `${decision.chosenActionId ?? "no_action"} for a ${decision.trigger.kind} trigger.`
          ),
          importance: Math.min(100, decision.trigger.priority),
          references: [
            decision.trigger.sourceEventId,
            ...(action?.resultEventIds ?? []),
          ].filter((value, index, values) => values.indexOf(value) === index),
        });
        if (recorded.compaction !== undefined) {
          const emitted = ctx.emit(
            "agent.memory.compacted",
            {
              agentId: decision.agentId,
              summaryMemoryId: recorded.compaction.summary.id,
              sourceMemoryIds: recorded.compaction.sourceMemoryIds,
              activeMemoryCount: store.listActive(decision.agentId).length,
            },
            {
              actor: { kind: "agent", id: decision.agentId },
              correlationId: recorded.compaction.summary.id,
            },
          );
          if (eventId(emitted) === undefined) {
            throw new EngineError("INTERNAL", "memory compaction telemetry lacked an event ID");
          }
        }
      }
    },
  };
}
