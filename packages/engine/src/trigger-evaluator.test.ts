import { describe, expect, it } from "vitest";
import type { TriggerKind, TriggerSignal } from "@worldtangle/shared";
import { TriggerEvaluator } from "./trigger-evaluator";

function signal(
  kind: TriggerKind,
  agentIndex: number,
  eventIndex: number,
  overrides: Partial<TriggerSignal> = {},
): TriggerSignal {
  const common = {
    kind,
    agentId: "agt_" + agentIndex.toString(36).padStart(8, "0"),
    sourceEventId: "evt_" + eventIndex.toString(36).padStart(8, "0"),
    tick: 7,
    priority: 50,
  };
  const payloadByKind = {
    schedule: { taskRef: "daily_review", dueTick: 7 },
    message: { messageId: "msg_00000001" },
    stress: { balanceCents: "1200", bufferDays: 2 },
    news: { storyId: "story_00000001", relevanceScore: 80 },
    goal: { goalId: "gol_00000001", goalKind: "start_business" },
    policy: { policyId: "pol_00000001", changeKind: "income_tax_changed" },
    company: { companyId: "biz_ironvale", eventKind: "cash_warning" },
    market: { marketId: "mkt_riverbend", movementBp: -450 },
  } as const;
  return { ...common, payload: payloadByKind[kind], ...overrides } as TriggerSignal;
}

describe("TriggerEvaluator", () => {
  it("evaluates every trigger catalog kind into a wake set", () => {
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
    const signals = kinds.map((kind, index) => signal(kind, index + 1, index + 1));
    const known = new Set(signals.map((item) => item.agentId));

    const result = new TriggerEvaluator().evaluateTriggers(7, signals, known);

    expect(result.entries).toHaveLength(8);
    expect(result.entries.flatMap((entry) => entry.triggers.map((item) => item.kind))).toEqual(kinds);
    expect(result.dropped).toEqual([]);
  });

  it("wakes no untriggered agent and reports inactive or invalid inputs", () => {
    const evaluator = new TriggerEvaluator();
    const known = new Set(["agt_00000001", "agt_00000002"]);
    const result = evaluator.evaluateTriggers(7, [
      signal("schedule", 1, 1, {
        payload: { taskRef: "future", dueTick: 8 },
      } as Partial<TriggerSignal>),
      signal("news", 2, 2, { tick: 6 }),
      { kind: "news", broken: true },
    ], known);

    expect(result.entries).toEqual([]);
    expect(result.dropped.map((item) => item.reason).sort()).toEqual([
      "invalid",
      "not_due",
      "stale",
    ]);
  });

  it("deduplicates and enforces the per-agent cap by stable priority order", () => {
    const evaluator = new TriggerEvaluator({ maxTriggersPerAgentPerTick: 2 });
    const inputs = [
      signal("news", 1, 1, { priority: 20 }),
      signal("stress", 1, 2, { priority: 90 }),
      signal("goal", 1, 3, { priority: 70 }),
      signal("stress", 1, 2, { priority: 1 }),
    ];

    const result = evaluator.evaluateTriggers(7, inputs);

    expect(result.entries[0]!.triggers.map((item) => item.kind)).toEqual(["stress", "goal"]);
    expect(result.dropped.map((item) => item.reason).sort()).toEqual([
      "duplicate",
      "per_agent_cap",
    ]);
  });

  it("is permutation-independent and rejects unknown agents", () => {
    const evaluator = new TriggerEvaluator();
    const inputs = [
      signal("goal", 2, 3, { priority: 60 }),
      signal("message", 1, 2, { priority: 80 }),
      signal("news", 1, 1, { priority: 40 }),
    ];
    const known = new Set(["agt_00000001"]);
    const first = evaluator.evaluateTriggers(7, inputs, known);
    const second = evaluator.evaluateTriggers(7, [...inputs].reverse(), known);

    expect(second.wakeSetHash).toBe(first.wakeSetHash);
    expect(second.entries).toEqual(first.entries);
    expect(first.dropped).toHaveLength(1);
    expect(first.dropped[0]!.reason).toBe("unknown_agent");
  });

  it("rejects nonsensical cap configuration", () => {
    expect(() => new TriggerEvaluator({ maxTriggersPerAgentPerTick: 0 })).toThrow(
      /integer from 1 to 32/,
    );
  });

  it("contains non-canonical invalid inputs instead of stalling evaluation", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const result = new TriggerEvaluator().evaluateTriggers(7, [
      circular,
      signal("goal", 1, 1),
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.dropped).toMatchObject([{ reason: "invalid" }]);
  });
});
