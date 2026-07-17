import { describe, expect, it } from "vitest";
import type { ActorRef, EventEnvelope } from "@worldtangle/shared";
import {
  buildNewsworthinessDigest,
  isNewsDigestCandidate,
  scoreNewsworthiness,
} from "./newsworthiness";

const SIMULATION_ID = "sim_00000001";
const RUN_ID = "run_00000001";

function event(
  seq: number,
  tick: number,
  type: string,
  payload: unknown,
  actor: ActorRef = { kind: "system", id: "engine" },
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: `evt_${(seq + 1).toString(36).padStart(8, "0")}`,
    type,
    schemaVersion: 1,
    simulationId: SIMULATION_ID,
    runId: RUN_ID,
    seq,
    tick,
    simDate: `Y0001-M01-D${String(Math.max(1, tick)).padStart(2, "0")}`,
    wallTime: `WS701-T${seq}`,
    actor,
    correlationId: `cor_${(seq + 1).toString(36).padStart(8, "0")}`,
    payload,
    ...overrides,
  };
}

describe("scoreNewsworthiness", () => {
  it("locks the money, rarity, and affected-count scoring goldens", () => {
    const insolvency = scoreNewsworthiness(event(0, 7, "company.insolvency.closed", {
      companyId: "co_00000001",
      salvageProceedsCents: "12500000",
      affectedAgentIds: Array.from(
        { length: 12 },
        (_, index) => `agt_${(index + 1).toString(36).padStart(8, "0")}`,
      ),
    }), 1);
    expect(insolvency).toEqual({
      totalPoints: 9_500,
      components: {
        maxAbsMoneyCents: "12500000",
        moneyPoints: 3_500,
        typeOccurrences: 1,
        rarityPoints: 3_500,
        affectedCount: 13,
        affectedPoints: 2_500,
      },
    });

    const payroll = scoreNewsworthiness(event(1, 7, "payroll.executed", {
      employeeAgentId: "agt_00000001",
      grossCents: "250000",
      withholdingCents: "50000",
      netCents: "200000",
    }), 10);
    expect(payroll).toEqual({
      totalPoints: 3_100,
      components: {
        maxAbsMoneyCents: "250000",
        moneyPoints: 2_500,
        typeOccurrences: 10,
        rarityPoints: 350,
        affectedCount: 1,
        affectedPoints: 250,
      },
    });

    expect(scoreNewsworthiness(event(2, 7, "policy.changed", { policy: "tax" }), 4))
      .toEqual({
        totalPoints: 875,
        components: {
          maxAbsMoneyCents: "0",
          moneyPoints: 0,
          typeOccurrences: 4,
          rarityPoints: 875,
          affectedCount: 0,
          affectedPoints: 0,
        },
      });
  });

  it("uses the largest absolute cents fact, ignores microcents, and dedupes entities", () => {
    const result = scoreNewsworthiness(event(0, 1, "market.trade.executed", {
      buyerAgentId: "agt_00000001",
      sellerAgentId: "agt_00000001",
      legs: [
        { amountCents: "-99999" },
        { amountCents: "99999" },
      ],
      providerCostMicrocents: "999999999999",
      affectedCount: 4,
    }, { kind: "agent", id: "agt_00000001" }), 2);

    expect(result.components).toEqual({
      maxAbsMoneyCents: "99999",
      moneyPoints: 2_000,
      typeOccurrences: 2,
      rarityPoints: 1_750,
      affectedCount: 4,
      affectedPoints: 1_000,
    });
    expect(result.totalPoints).toBe(4_750);
  });
});

describe("buildNewsworthinessDigest", () => {
  it("produces the same ranked hash for the same events in any input order", () => {
    const events = [
      event(0, 1, "job.offer.created", { companyId: "co_00000001", wageCents: "5000000" }),
      event(1, 2, "job.offer.created", { companyId: "co_00000002", wageCents: "6000000" }),
      event(2, 2, "company.insolvency.closed", {
        companyId: "co_00000003",
        salvageProceedsCents: "10000000",
        affectedCount: 8,
      }),
      event(3, 2, "policy.changed", { policy: "minimum_wage" }),
    ];
    const input = {
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 2,
      events,
      lookbackTicks: 30,
      limit: 2,
    } as const;

    const forward = buildNewsworthinessDigest(input);
    const reversed = buildNewsworthinessDigest({ ...input, events: [...events].reverse() });

    expect(reversed).toEqual(forward);
    expect(forward.totalCandidateCount).toBe(3);
    expect(forward.candidates.map((candidate) => candidate.eventType)).toEqual([
      "company.insolvency.closed",
      "job.offer.created",
    ]);
    expect(forward.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(forward.digestHash).toBe(
      "0f641c2d3c289f6313460cf7d4c5d7aa9f059378c88a6e7180d2066ea09c3350",
    );
  });

  it("counts rarity only inside the lookback and ignores future and operational events", () => {
    const events = [
      event(0, 1, "loan.defaulted", { amountCents: "10000" }),
      event(1, 8, "loan.defaulted", { amountCents: "10000" }),
      event(2, 10, "loan.defaulted", { amountCents: "10000" }),
      event(3, 10, "simulation.tick.completed", { tick: 10 }),
      event(4, 11, "loan.defaulted", { amountCents: "10000" }),
    ];
    const digest = buildNewsworthinessDigest({
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 10,
      events,
      lookbackTicks: 3,
    });

    expect(digest.windowStartTick).toBe(8);
    expect(digest.totalCandidateCount).toBe(1);
    expect(digest.candidates[0]?.components.typeOccurrences).toBe(2);
    expect(digest.candidates[0]?.components.rarityPoints).toBe(1_750);
    expect(isNewsDigestCandidate(events[3]!)).toBe(false);
    for (const operationalType of [
      "agent.decision.recorded",
      "llm.call.recorded",
      "memory.created",
      "news.digest.created",
      "scheduler.task.fired",
      "transaction.posted",
    ]) {
      expect(isNewsDigestCandidate(event(10, 10, operationalType, {}))).toBe(false);
    }

    const preAggregated = buildNewsworthinessDigest({
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 10,
      events: events.filter((candidate) => candidate.tick === 10),
      lookbackTicks: 3,
      windowTypeOccurrences: [
        { eventType: "loan.defaulted", count: 2 },
        { eventType: "simulation.tick.completed", count: 1 },
      ],
    });
    expect(preAggregated).toEqual(digest);
  });

  it("uses event type then event ID as deterministic score tie-breakers", () => {
    const digest = buildNewsworthinessDigest({
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 3,
      events: [
        event(3, 3, "zeta.changed", {}),
        event(2, 3, "alpha.changed", {}),
        event(1, 3, "alpha.changed", {}, undefined, { eventId: "evt_zzzzzzzz" }),
      ],
    });

    expect(digest.candidates.map((candidate) => candidate.eventId)).toEqual([
      "evt_00000004",
      "evt_00000003",
      "evt_zzzzzzzz",
    ]);
  });

  it("excludes wall time from the digest hash", () => {
    const original = event(0, 1, "energy.tariff.changed", { priceCents: "1234" });
    const changedWall = { ...original, wallTime: "a-different-informational-clock" };
    const build = (candidate: EventEnvelope) => buildNewsworthinessDigest({
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 1,
      events: [candidate],
    });

    expect(build(changedWall).digestHash).toBe(build(original).digestHash);
    expect(build(changedWall).candidates[0]?.eventFactHash).toBe(
      build(original).candidates[0]?.eventFactHash,
    );
  });

  it("excludes run and operational correlation identity from fact and digest hashes", () => {
    const original = event(0, 1, "energy.tariff.changed", { priceCents: "1234" });
    const alternate = {
      ...original,
      simulationId: "sim_00000002",
      runId: "run_00000002",
      wallTime: "another-wall-clock",
      correlationId: "another-request-correlation",
    };
    const first = buildNewsworthinessDigest({
      simulationId: original.simulationId,
      runId: original.runId,
      tick: 1,
      events: [original],
    });
    const second = buildNewsworthinessDigest({
      simulationId: alternate.simulationId,
      runId: alternate.runId,
      tick: 1,
      events: [alternate],
    });

    expect(second.digestHash).toBe(first.digestHash);
    expect(second.candidates[0]?.eventFactHash).toBe(first.candidates[0]?.eventFactHash);
  });

  it("excludes nested replay metadata but preserves provider cost as a source fact", () => {
    const original = event(0, 1, "energy.tariff.changed", {
      priceCents: "1234",
      evidence: {
        simulationId: SIMULATION_ID,
        runId: RUN_ID,
        correlationId: "source-correlation",
        wallTime: "source-wall-time",
        createdWall: "source-created-wall",
        latencyMs: 91,
        costMicrocents: "1250",
      },
    });
    const alternate = {
      ...original,
      payload: {
        priceCents: "1234",
        evidence: {
          simulationId: "sim_00000002",
          runId: "run_00000002",
          correlationId: "replay-correlation",
          wallTime: "replay-wall-time",
          createdWall: "replay-created-wall",
          latencyMs: 0,
          costMicrocents: "1250",
        },
      },
    };
    const changedCost = {
      ...alternate,
      payload: {
        ...alternate.payload,
        evidence: { ...alternate.payload.evidence, costMicrocents: "1251" },
      },
    };
    const hash = (candidate: EventEnvelope) => buildNewsworthinessDigest({
      simulationId: candidate.simulationId,
      runId: candidate.runId,
      tick: 1,
      events: [candidate],
    }).digestHash;

    expect(hash(alternate)).toBe(hash(original));
    expect(hash(changedCost)).not.toBe(hash(original));
  });

  it("changes the digest when source facts change inside the same score bucket", () => {
    const original = event(0, 1, "energy.tariff.changed", { priceCents: "1234" });
    const changedFact = { ...original, payload: { priceCents: "1235" } };
    const build = (candidate: EventEnvelope) => buildNewsworthinessDigest({
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 1,
      events: [candidate],
    });

    expect(build(changedFact).candidates[0]?.totalPoints).toBe(
      build(original).candidates[0]?.totalPoints,
    );
    expect(build(changedFact).digestHash).not.toBe(build(original).digestHash);
  });

  it("rejects invalid policy values, duplicate events, and mixed run identity", () => {
    const candidate = event(0, 1, "policy.changed", {});
    const input = {
      simulationId: SIMULATION_ID,
      runId: RUN_ID,
      tick: 1,
      events: [candidate],
    } as const;

    expect(() => buildNewsworthinessDigest({ ...input, lookbackTicks: 0 })).toThrow(
      "lookbackTicks must be a positive safe integer",
    );
    expect(() => buildNewsworthinessDigest({ ...input, events: [candidate, candidate] })).toThrow(
      "duplicate event",
    );
    expect(() => buildNewsworthinessDigest({
      ...input,
      windowTypeOccurrences: [{ eventType: candidate.type, count: 1 }, {
        eventType: candidate.type,
        count: 1,
      }],
    })).toThrow("duplicate event type occurrence");
    expect(() => buildNewsworthinessDigest({
      ...input,
      windowTypeOccurrences: [{ eventType: "another.event", count: 1 }],
    })).toThrow("undercounts supplied events");
    expect(() => buildNewsworthinessDigest({
      ...input,
      events: [{ ...candidate, runId: "run_00000002" }],
    })).toThrow("cannot mix simulations or runs");
    expect(() => scoreNewsworthiness(candidate, 0)).toThrow(
      "typeOccurrences must be a positive safe integer",
    );
  });
});
