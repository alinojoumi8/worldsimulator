import { describe, expect, it } from "vitest";
import { hashValue } from "./codec";
import {
  PHASE6_PARITY_SECTIONS,
  createWs609LiveBudgetArtifact,
  createWs610LiveParityArtifact,
  validateWs609LiveBudgetArtifact,
  validateWs610LiveParityArtifact,
} from "./phase6-acceptance";

function ws609Base() {
  return {
    artifactSchemaVersion: 2,
    acceptanceCriterion: "AC-2",
    status: "passed",
    executedAt: "2026-07-16T12:00:00.000Z",
    transport: "Fastify on an ephemeral 127.0.0.1 listener with real MiniMax/Kimi transport",
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      llmMode: "live",
      endTick: 360,
      runCostCentsMax: "200",
      perAgentDailyTokens: 128_000,
    },
    simulationId: "sim_00000001",
    runId: "run_00000001",
    models: { tier2: "MiniMax-M3", tier3: "kimi-k2.6" },
    providers: { tier2: "minimax", tier3: "kimi" },
    prices: {
      "MiniMax-M3": {
        inputMicrocentsPerToken: "100000",
        cachedInputMicrocentsPerToken: "20000",
        outputMicrocentsPerToken: "200000",
      },
      "kimi-k2.6": {
        inputMicrocentsPerToken: "300000",
        cachedInputMicrocentsPerToken: "50000",
        outputMicrocentsPerToken: "400000",
      },
    },
    pause: {
      tick: 10,
      runStatus: "paused",
      autoPaused: true,
      effectiveTier: 1,
      budgetPct: 100,
      thresholdEventId: "evt_00000001",
      pauseEventId: "evt_00000002",
      pauseCausationId: "evt_00000001",
    },
    providerUsage: {
      callRecords: 1,
      providerAttempts: 2,
      cacheHits: 0,
      inputTokens: 1_000,
      cachedInputTokens: 100,
      outputTokens: 500,
    },
    spendReconciliation: {
      recordedCostMicrocents: "200000000",
      independentlyPricedMicrocents: "200000000",
      absoluteDifferenceMicrocents: "0",
      differenceBasisPoints: 0,
      withinFivePercent: true,
      displayedCostCentsEstimate: "200",
    },
    postPauseProbe: {
      graceMs: 2_000,
      providerAttemptsAtPause: 2,
      providerAttemptsAfterGrace: 2,
      additionalProviderAttempts: 0,
      remainedPaused: true,
    },
  };
}

function ws610Base() {
  const proposal = {
    actionId: "goal.activate_0001",
    params: { goalId: "goal_00000001" },
    rationale: "activate the bounded goal",
  };
  return {
    artifactSchemaVersion: 2,
    ticket: "WS-610",
    status: "passed",
    executedAt: "2026-07-16T12:00:00.000Z",
    scenario: {
      worldSpec: "riverbend-100@1",
      seed: 42,
      decisionTick: 1,
      fixture: "one seeded agent with all goals dormant before the first tick",
    },
    live: {
      provider: "minimax",
      model: "MiniMax-M3",
      requestHash: "c".repeat(64),
      attempts: 1,
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 100,
      logicalStateHash: "a".repeat(64),
      activeGoalCount: 1,
    },
    mock: {
      provider: "mock",
      model: "mock-llm-v1",
      requestHash: "c".repeat(64),
      attempts: 1,
      inputTokens: 900,
      cachedInputTokens: 0,
      outputTokens: 90,
      logicalStateHash: "b".repeat(64),
      activeGoalCount: 1,
    },
    replayedProposal: { ...proposal, proposalHash: hashValue(proposal) },
    providerNeutral: {
      projectionDigest: "d".repeat(64),
      sections: PHASE6_PARITY_SECTIONS.map((section, index) => ({
        section,
        leftDigest: (index + 1).toString().repeat(64),
        rightDigest: (index + 1).toString().repeat(64),
        equal: true,
      })),
      mismatches: [],
    },
    checklist: {
      liveDecisionValid: true,
      distinctProviderReceipts: true,
      providerBoundLogicalHashesRemainDistinct: true,
      callShapeEqual: true,
      decisionShapeEqual: true,
      actionShapeEqual: true,
      causalEventFlowEqual: true,
      affectedAgentStateEqual: true,
    },
  };
}

describe("Phase 6 live acceptance artifacts", () => {
  it("creates and validates strict checksummed WS-609 and WS-610 evidence", () => {
    const ws609 = createWs609LiveBudgetArtifact(ws609Base());
    const ws610 = createWs610LiveParityArtifact(ws610Base());

    expect(validateWs609LiveBudgetArtifact(JSON.parse(JSON.stringify(ws609)))).toEqual(ws609);
    expect(validateWs610LiveParityArtifact(JSON.parse(JSON.stringify(ws610)))).toEqual(ws610);
  });

  it("rejects a modified artifact whose evidence digest was not recomputed", () => {
    const artifact = createWs609LiveBudgetArtifact(ws609Base());
    const tampered = {
      ...artifact,
      spendReconciliation: {
        ...artifact.spendReconciliation,
        recordedCostMicrocents: "300000000",
      },
    };

    expect(() => validateWs609LiveBudgetArtifact(tampered)).toThrow(
      "WS-609 evidence checksum does not match",
    );
  });

  it("rejects internally inconsistent WS-609 evidence even with a fresh checksum", () => {
    const base = ws609Base();
    const inconsistent = {
      ...base,
      pause: { ...base.pause, pauseCausationId: "evt_00000003" },
    };

    expect(() => createWs609LiveBudgetArtifact(inconsistent)).toThrow(
      "WS-609 pause event is not caused by the 100% threshold event",
    );
  });

  it("rejects WS-610 request, proposal, and section-shape drift", () => {
    const base = ws610Base();
    expect(() => createWs610LiveParityArtifact({
      ...base,
      mock: { ...base.mock, requestHash: "e".repeat(64) },
    })).toThrow("WS-610 live and mock canonical request hashes differ");
    expect(() => createWs610LiveParityArtifact({
      ...base,
      replayedProposal: { ...base.replayedProposal, proposalHash: "f".repeat(64) },
    })).toThrow("WS-610 replayed proposal checksum does not match");
    expect(() => createWs610LiveParityArtifact({
      ...base,
      providerNeutral: {
        ...base.providerNeutral,
        sections: [...base.providerNeutral.sections].reverse(),
      },
    })).toThrow("WS-610 parity sections are missing or out of canonical order");
  });
});
