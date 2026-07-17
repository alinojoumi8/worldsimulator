import { describe, expect, it } from "vitest";
import type { Goal } from "@worldtangle/shared";
import {
  GoalLifecycleEngine,
  InMemoryGoalLifecycleRepository,
} from "./goal-lifecycle";

const agentId = "agt_00000001";

function goal(
  id: string,
  status: Goal["status"],
  priority = 3,
  activationRule = "budget_review_due",
): Goal {
  return {
    id,
    agentId,
    kind: "save_amount",
    params: { targetCents: "500000" },
    priority,
    status,
    activationRule,
    progress: 0,
  };
}

function emitter(types: string[]) {
  let counter = 10;
  return (type: string) => {
    types.push(type);
    counter += 1;
    return `evt_${counter.toString(36).padStart(8, "0")}`;
  };
}

describe("GoalLifecycleEngine", () => {
  it("activates eligible goals deterministically and exposes them as triggers", () => {
    const repository = new InMemoryGoalLifecycleRepository([
      { goal: goal("gol_00000001", "dormant", 2), triggerEventId: "evt_00000001", activatedTick: null, terminalTick: null },
      { goal: goal("gol_00000002", "dormant", 5), triggerEventId: "evt_00000002", activatedTick: null, terminalTick: null },
    ]);
    const engine = new GoalLifecycleEngine({ repository, maxActiveGoals: 1 });
    const events: string[] = [];
    const activated = engine.activateEligible(agentId, 1, {}, emitter(events));
    expect(activated.map((record) => record.goal.id)).toEqual(["gol_00000002"]);
    expect(events).toEqual(["agent.goal.activated"]);
    expect(engine.activeTriggers(agentId, 1)).toEqual([expect.objectContaining({
      kind: "goal",
      priority: 100,
      payload: { goalId: "gol_00000002", goalKind: "save_amount" },
    })]);
  });

  it("activates exactly the selected eligible goal and leaves other menu choices dormant", () => {
    const repository = new InMemoryGoalLifecycleRepository([
      { goal: goal("gol_00000001", "dormant", 2, "always_for_test"), triggerEventId: "evt_00000001", activatedTick: null, terminalTick: null },
      { goal: goal("gol_00000002", "dormant", 5, "always_for_test"), triggerEventId: "evt_00000002", activatedTick: null, terminalTick: null },
    ]);
    const engine = new GoalLifecycleEngine({
      repository,
      maxActiveGoals: 2,
      activationRules: { always_for_test: () => true },
    });
    expect(engine.eligibleForActivation(agentId, 1, {}).map((record) => record.goal.id))
      .toEqual(["gol_00000002", "gol_00000001"]);
    const events: string[] = [];

    const activated = engine.activateSelected("gol_00000001", 1, {}, emitter(events));

    expect(activated.goal).toMatchObject({ id: "gol_00000001", status: "active" });
    expect(repository.get("gol_00000002")?.goal.status).toBe("dormant");
    expect(events).toEqual(["agent.goal.activated"]);
  });

  it("rejects a goal outside the engine-authored menu without emitting or transitioning", () => {
    const repository = new InMemoryGoalLifecycleRepository([
      { goal: goal("gol_00000001", "dormant", 5, "blocked_for_test"), triggerEventId: "evt_00000001", activatedTick: null, terminalTick: null },
    ]);
    const engine = new GoalLifecycleEngine({
      repository,
      activationRules: { blocked_for_test: () => false },
    });
    const events: string[] = [];

    expect(() => engine.activateSelected("gol_00000001", 1, {}, emitter(events)))
      .toThrow(/not eligible for activation/);
    expect(repository.get("gol_00000001")?.goal.status).toBe("dormant");
    expect(events).toEqual([]);
  });

  it("tracks progress and emits the achieved terminal transition", () => {
    const repository = new InMemoryGoalLifecycleRepository([
      { goal: goal("gol_00000001", "active"), triggerEventId: "evt_00000001", activatedTick: 0, terminalTick: null },
    ]);
    const engine = new GoalLifecycleEngine({ repository });
    const events: string[] = [];
    const emit = emitter(events);
    const progressed = engine.advance("gol_00000001", 0.4, {
      tick: 2,
      rationale: "rule_progress",
      emit,
    });
    const achieved = engine.advance("gol_00000001", 0.6, {
      tick: 3,
      rationale: "rule_progress",
      emit,
    });
    expect(progressed.goal).toMatchObject({ progress: 0.4, status: "active" });
    expect(achieved.goal).toMatchObject({ progress: 1, status: "achieved" });
    expect(achieved.terminalTick).toBe(3);
    expect(events).toEqual(["agent.goal.progressed", "agent.goal.achieved"]);
    expect(engine.activeTriggers(agentId, 4)).toEqual([]);
  });

  it("events abandonment and rejects further terminal transitions", () => {
    const repository = new InMemoryGoalLifecycleRepository([
      { goal: goal("gol_00000001", "active"), triggerEventId: "evt_00000001", activatedTick: 0, terminalTick: null },
    ]);
    const engine = new GoalLifecycleEngine({ repository });
    const events: string[] = [];
    const abandoned = engine.abandon("gol_00000001", {
      tick: 8,
      rationale: "infeasible",
      emit: emitter(events),
    });
    expect(abandoned.goal.status).toBe("abandoned");
    expect(events).toEqual(["agent.goal.abandoned"]);
    expect(() => engine.abandon("gol_00000001", {
      tick: 9,
      rationale: "again",
      emit: emitter(events),
    })).toThrow(/already terminal/);
  });
});
