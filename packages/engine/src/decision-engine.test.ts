import { describe, expect, it } from "vitest";
import {
  IdFactory,
  agentSchema,
  hashValue,
} from "@worldtangle/shared";
import type {
  Agent,
  Decision,
  AgentAction,
  DecisionPriorModifier,
  TriggerKind,
  TriggerSignal,
} from "@worldtangle/shared";
import { ActionRegistry } from "./action-registry";
import {
  RULE_ONLY_NO_OP_ACTION,
  RuleDecisionEngine,
} from "./decision-engine";
import type { Tier1DecisionRule } from "./decision-engine";
import { EventBus } from "./bus";
import { InMemoryEventLog } from "./event-log";
import { SimLoop } from "./sim-loop";
import { TriggerEvaluator } from "./trigger-evaluator";
import { generateRiverbendPopulation } from "./world-generator";
import { buildDecisionPriorModifier } from "./sentiment";

function agent(index: number): Agent {
  const suffix = index.toString(36).padStart(8, "0");
  return agentSchema.parse({
    id: "agt_" + suffix,
    runId: "run_00000001",
    personaId: "per_" + suffix,
    householdId: "hh_" + suffix,
    occupationCode: index === 1 ? "unemployed" : "teacher",
    employmentStatus: index === 1 ? "unemployed" : "employed",
    creditScore: 650,
    quarantine: { mode: "none" },
    aliveFlags: { alive: true, canAct: true },
  });
}

function trigger(
  kind: TriggerKind,
  agentId: string,
  eventIndex: number,
  priority = 50,
  tick = 7,
): TriggerSignal {
  const payloads = {
    schedule: { taskRef: "daily_review", dueTick: tick },
    message: { messageId: "msg_00000001" },
    stress: { balanceCents: "100", bufferDays: 1 },
    news: { storyId: "story_00000001", relevanceScore: 90 },
    goal: { goalId: "gol_00000001", goalKind: "find_job" },
    policy: { policyId: "pol_00000001", changeKind: "tax_changed" },
    company: { companyId: "biz_ironvale", eventKind: "cash_warning" },
    market: { marketId: "mkt_riverbend", movementBp: 300 },
  } as const;
  return {
    kind,
    agentId,
    sourceEventId: "evt_" + eventIndex.toString(36).padStart(8, "0"),
    tick,
    priority,
    payload: payloads[kind],
  } as TriggerSignal;
}

function emptyStateEngine(options: {
  rules?: readonly Tier1DecisionRule<Record<string, never>>[];
  routines?: ConstructorParameters<typeof RuleDecisionEngine<Record<string, never>>>[0]["tier0Routines"];
  maxDecisions?: number;
  maxActions?: number;
  failureThreshold?: number;
  cooldown?: number;
} = {}): RuleDecisionEngine<Record<string, never>> {
  return new RuleDecisionEngine({
    registry: new ActionRegistry<Record<string, never>>(),
    tier1Rules: options.rules,
    tier0Routines: options.routines,
    maxDecisionsPerAgentPerTick: options.maxDecisions,
    maxActionsPerAgentPerTick: options.maxActions,
    failureThreshold: options.failureThreshold,
    quarantineCooldownTicks: options.cooldown,
  });
}

describe("RuleDecisionEngine", () => {
  it("records a deterministic Tier 1 decision and applied action for every trigger kind", () => {
    const agents = Array.from({ length: 9 }, (_, index) => agent(index + 1));
    const kinds = [
      "schedule",
      "message",
      "stress",
      "news",
      "goal",
      "policy",
      "company",
      "market",
    ] as const;
    const signals = kinds.map((kind, index) => trigger(kind, agents[index]!.id, index + 1, 80));
    const wakeSet = new TriggerEvaluator().evaluateTriggers(
      7,
      signals,
      new Set(agents.map((item) => item.id)),
    );
    const result = emptyStateEngine().runTick({
      runId: "run_00000001",
      tick: 7,
      agents,
      wakeSet,
      ids: new IdFactory(),
      state: {},
    });

    expect(result.decisions).toHaveLength(8);
    expect(result.actions).toHaveLength(8);
    expect(result.rejections).toEqual([]);
    expect(result.decisions.every((item) =>
      item.tier === 1 &&
      item.optionsOffered.length === 2 &&
      item.rationale.startsWith("rule:") &&
      item.validationResult.status === "approved"
    )).toBe(true);
    expect(result.actions.every((item) =>
      item.status === "applied" && item.decisionId !== undefined
    )).toBe(true);
    expect(result.decisions.some((item) => item.agentId === agents[8]!.id)).toBe(false);
  });

  it("uses stable max-utility selection and a deterministic no-op for low urgency", () => {
    const agents = [agent(1), agent(2)];
    const wakeSet = new TriggerEvaluator().evaluateTriggers(7, [
      trigger("goal", agents[0]!.id, 1, 100),
      trigger("goal", agents[1]!.id, 2, 0),
    ]);
    const result = emptyStateEngine().runTick({
      runId: "run_00000001",
      tick: 7,
      agents,
      wakeSet,
      ids: new IdFactory(),
      state: {},
    });

    expect(result.decisions[0]!.chosenActionId).toBe("goal.respond");
    expect(result.decisions[1]!.chosenActionId).toBe("goal.no_op");
    expect(result.actions[1]!.type).toBe(RULE_ONLY_NO_OP_ACTION);
  });

  it("applies only bounded sentiment priors and records their utility evidence", () => {
    const currentAgent = agent(1);
    const signal = trigger("goal", currentAgent.id, 1, 50);
    const wakeSet = new TriggerEvaluator().evaluateTriggers(7, [signal]);
    const run = (priorProvider?: () => DecisionPriorModifier) => emptyStateEngine().runTick({
      runId: "run_00000001",
      tick: 7,
      agents: [currentAgent],
      wakeSet,
      ids: new IdFactory(),
      state: {},
      ...(priorProvider === undefined ? {} : { priorProvider }),
    }).decisions[0]!;
    const baseline = run();
    const prior = buildDecisionPriorModifier({
      topic: "economy",
      sentimentValue: 10_000,
      contributingStoryIds: [],
      opinionAxis: "economicOptimism",
      opinionValue: 100,
    });
    const modified = run(() => prior);
    const baselineRespond = baseline.optionsOffered.find((option) => option.actionId === "goal.respond")!;
    const baselineNoOp = baseline.optionsOffered.find((option) => option.actionId === "goal.no_op")!;
    const modifiedRespond = modified.optionsOffered.find((option) => option.actionId === "goal.respond")!;
    const modifiedNoOp = modified.optionsOffered.find((option) => option.actionId === "goal.no_op")!;

    expect(modifiedRespond.utility).toBe(baselineRespond.utility + 25);
    expect(modifiedNoOp.utility).toBe(baselineNoOp.utility - 25);
    expect(modifiedRespond.utilityFactors).toMatchObject({
      sentimentPriorDelta: 25,
      sentimentIndex: 10_000,
      agentOpinion: 100,
      sentimentPriorVersion: 1,
    });
    expect(modified.rationale).toContain("sentiment prior v1 delta 25");

    const forged = { ...prior, noOpDelta: 25 } as unknown as DecisionPriorModifier;
    const skipped = run(() => forged);
    expect(skipped.optionsOffered).toEqual(baseline.optionsOffered);
    expect(skipped.rationale).toContain("sentiment prior invalid and skipped");
  });

  it("runs scripted Tier 0 routines without creating Decision records", () => {
    const agents = [agent(1), agent(2), agent(3)];
    const engine = emptyStateEngine({
      routines: [{
        id: "daily_check",
        order: 10,
        run: ({ agent: current }) => [{
          type: RULE_ONLY_NO_OP_ACTION,
          params: { agentId: current.id, reason: "daily_routine" },
        }],
      }],
    });
    const result = engine.runTick({
      runId: "run_00000001",
      tick: 7,
      agents,
      wakeSet: new TriggerEvaluator().evaluateTriggers(7, []),
      ids: new IdFactory(),
      state: {},
    });

    expect(result.decisions).toEqual([]);
    expect(result.actions).toHaveLength(3);
    expect(result.actions.every((item) => item.decisionId === undefined)).toBe(true);
    expect(result.tier0RoutinesRun).toBe(3);
  });

  it("enforces decision/action caps and keeps one agent failure from stalling peers", () => {
    const agents = [agent(1), agent(2), agent(3)];
    const engine = emptyStateEngine({
      maxDecisions: 1,
      maxActions: 1,
      routines: [{
        id: "isolated_routine",
        order: 1,
        run: ({ agent: current }) => {
          if (current.id === agents[0]!.id) throw new Error("injected one-agent failure");
          return [{
            type: RULE_ONLY_NO_OP_ACTION,
            params: { agentId: current.id, reason: "daily_routine" },
          }];
        },
      }],
    });
    const wakeSet = new TriggerEvaluator({ maxTriggersPerAgentPerTick: 3 }).evaluateTriggers(7, [
      trigger("news", agents[1]!.id, 1, 90),
      trigger("goal", agents[1]!.id, 2, 80),
    ]);
    const result = engine.runTick({
      runId: "run_00000001",
      tick: 7,
      agents,
      wakeSet,
      ids: new IdFactory(),
      state: {},
    });

    expect(result.decisionCapDrops).toBe(1);
    expect(result.actionCapDrops).toBe(1);
    expect(result.actions).toHaveLength(2);
    expect(result.rejections.some((item) =>
      item.agentId === agents[0]!.id && item.code === "INTERNAL"
    )).toBe(true);
    expect(result.rejections.some((item) => item.code === "LIMIT_EXCEEDED")).toBe(true);
  });

  it("honors action slots consumed or reserved by earlier and later phases", () => {
    const currentAgent = agent(1);
    const engine = emptyStateEngine({ maxDecisions: 2, maxActions: 3 });
    const wakeSet = new TriggerEvaluator({ maxTriggersPerAgentPerTick: 3 }).evaluateTriggers(7, [
      trigger("news", currentAgent.id, 1, 90),
      trigger("goal", currentAgent.id, 2, 80),
    ]);
    const result = engine.runTick({
      runId: "run_00000001",
      tick: 7,
      agents: [currentAgent],
      wakeSet,
      ids: new IdFactory(),
      state: {},
      initialActionCounts: { [currentAgent.id]: 2 },
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actionCapDrops).toBe(1);
    expect(result.rejections.filter((item) => item.code === "LIMIT_EXCEEDED")).toHaveLength(1);
    expect(() => engine.runTick({
      runId: "run_00000001",
      tick: 7,
      agents: [currentAgent],
      wakeSet,
      ids: new IdFactory(),
      state: {},
      initialActionCounts: { [currentAgent.id]: 4 },
    })).toThrow(/invalid initial action count/);
  });

  it("falls back, records rejection, and quarantines after consecutive failures", () => {
    const currentAgent = agent(1);
    const brokenRule: Tier1DecisionRule<Record<string, never>> = {
      id: "always_unknown_action",
      triggerKind: "news",
      buildOptions: ({ agent: selected, trigger: selectedTrigger }) => [{
        actionId: "news.unknown",
        actionType: "unknown.action",
        params: {
          agentId: selected.id,
          sourceEventId: selectedTrigger.sourceEventId,
        },
        utility: 100,
      }],
    };
    const engine = emptyStateEngine({
      rules: [brokenRule],
      failureThreshold: 3,
      cooldown: 5,
    });
    const ids = new IdFactory();
    const transitions = [];
    for (let tick = 1; tick <= 3; tick++) {
      const result = engine.runTick({
        runId: "run_00000001",
        tick,
        agents: [currentAgent],
        wakeSet: new TriggerEvaluator().evaluateTriggers(tick, [
          trigger("news", currentAgent.id, tick, 90, tick),
        ]),
        ids,
        state: {},
      });
      expect(result.decisions[0]!.validationResult).toMatchObject({
        status: "rejected",
        code: "NOT_FOUND",
      });
      transitions.push(...result.quarantines);
    }

    expect(transitions).toEqual([{
      agentId: currentAgent.id,
      tick: 3,
      untilTick: 8,
      consecutiveFailures: 3,
      reason: "tier1_action_rejected",
    }]);
    expect(engine.getQuarantine(currentAgent.id, 3)).toMatchObject({
      mode: "tier1_only",
      untilTick: 8,
    });
    expect(engine.getQuarantine(currentAgent.id, 9)).toEqual({ mode: "none" });
    expect(engine.recordAgentFailure(currentAgent.id, 10, "fresh_failure")).toBeUndefined();
    expect(engine.getQuarantine(currentAgent.id, 10)).toEqual({ mode: "none" });
  });

  it("completes a canonical 360-tick Riverbend rule-only run twice", () => {
    const run = (): {
      eventHash: string;
      recordHash: string;
      decisions: Decision[];
      actions: AgentAction[];
      completionDecisionCounts: number[];
    } => {
      const population = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });
      const agents = population.residents.map((resident) => resident.agent);
      const known = new Set(agents.map((item) => item.id));
      const evaluator = new TriggerEvaluator();
      const registry = new ActionRegistry<Record<string, never>>();
      const engine = new RuleDecisionEngine({
        registry,
        tier0Routines: [{
          id: "monthly_routine",
          order: 1,
          run: ({ agent: current, tick }) => tick % 30 === 0
            ? [{
                type: RULE_ONLY_NO_OP_ACTION,
                params: { agentId: current.id, reason: "monthly_routine" },
              }]
            : [],
        }],
      });
      const bus = new EventBus();
      const log = new InMemoryEventLog();
      const loop = new SimLoop({
        simulationId: "sim_00000001",
        runId: "run_00000001",
        seed: 42,
        bus,
        log,
        wallClock: () => "2026-01-01T00:00:00.000Z",
      });
      const decisions: Decision[] = [];
      const actions: AgentAction[] = [];
      loop.registerPhase("decisions", {
        module: "M04-agent-decisions",
        order: 100,
        run: (ctx) => {
          const selected = agents[(ctx.tick - 1) % agents.length]!;
          const source = ctx.emit("agent.trigger.generated", {
            agentId: selected.id,
            kind: "schedule",
          });
          const wakeSet = evaluator.evaluateTriggers(ctx.tick, [{
            kind: "schedule",
            agentId: selected.id,
            sourceEventId: source.eventId,
            tick: ctx.tick,
            priority: 60,
            payload: { taskRef: "daily_review", dueTick: ctx.tick },
          }], known);
          const result = engine.runTick({
            runId: ctx.runId,
            tick: ctx.tick,
            agents,
            wakeSet,
            ids: ctx.ids,
            state: {},
            count: ctx.count,
            emit: (type, payload, options) => ctx.emit(type, payload, options),
          });
          decisions.push(...result.decisions);
          actions.push(...result.actions);
        },
      });
      loop.advance(360);
      const completionDecisionCounts = log.list({ type: "simulation.tick.completed" }).map(
        (event) => (event.payload as { counts: { decisions: number } }).counts.decisions,
      );
      return {
        eventHash: log.logHash(),
        recordHash: hashValue({ decisions, actions }),
        decisions,
        actions,
        completionDecisionCounts,
      };
    };

    const first = run();
    const second = run();
    expect(first.decisions).toHaveLength(360);
    expect(first.actions).toHaveLength(1_560);
    expect(first.decisions.every((item) =>
      item.optionsOffered.length > 0 && item.rationale.length > 0
    )).toBe(true);
    expect(first.completionDecisionCounts).toEqual(Array.from({ length: 360 }, () => 1));
    expect(second.eventHash).toBe(first.eventHash);
    expect(second.recordHash).toBe(first.recordHash);
  });
});
