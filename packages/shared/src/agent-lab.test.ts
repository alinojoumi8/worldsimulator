import { describe, expect, it } from "vitest";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  agentActionSubmissionSchema,
  agentLabScenarioSchema,
  agentTurnEnvelopeSchema,
  experimentManifestSchema,
  recordedAgentLabSubmissionSchema,
  runManifestAgentLabSchema,
} from "./agent-lab";
import { hashValue } from "./codec";

const digest = "a".repeat(64);

function scenario() {
  return {
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: "riverbend-realism",
    trialId: "seed-42-shadow-1",
    experimentManifestDigest: digest,
    mode: "shadow",
    cohortSelection: {
      strategy: "stable_stratified_v1",
      size: 8,
      controller: "shadow",
      strata: ["occupation", "employment_status"],
    },
    decisionDeadlineMs: 5_000,
    budget: {
      maxAgentLoopIterations: 8,
      maxInputTokens: 16_000,
      maxOutputTokens: 1_000,
      maxToolCalls: 8,
    },
    driverPolicyDigest: digest,
    promptDigest: digest,
    toolSchemaDigest: digest,
  } as const;
}

describe("Agent Lab contracts", () => {
  it("requires an explicit or stratified cohort outside native mode", () => {
    expect(agentLabScenarioSchema.safeParse({
      ...scenario(),
      cohortSelection: undefined,
    }).success).toBe(false);
    expect(agentLabScenarioSchema.parse(scenario()).mode).toBe("shadow");
  });

  it("requires every assigned controller to match the declared trial arm", () => {
    expect(agentLabScenarioSchema.safeParse({
      ...scenario(),
      cohortSelection: {
        ...scenario().cohortSelection,
        controller: "external",
      },
    }).success).toBe(false);
    expect(agentLabScenarioSchema.safeParse({
      ...scenario(),
      mode: "external",
      cohortSelection: undefined,
      controllerAssignments: [{
        agentId: "agt_00000001",
        controller: "shadow",
      }],
    }).success).toBe(false);
    expect(runManifestAgentLabSchema.safeParse({
      ...scenario(),
      resolvedAssignments: [
        { agentId: "agt_00000001", controller: "shadow" },
        { agentId: "agt_00000001", controller: "shadow" },
      ],
    }).success).toBe(false);
    expect(runManifestAgentLabSchema.safeParse({
      ...scenario(),
      resolvedAssignments: [{
        agentId: "agt_00000001",
        controller: "external",
      }],
    }).success).toBe(false);
  });

  it("rejects unknown submission fields and stale-shaped hashes", () => {
    const submission = {
      turnId: `turn_${"1".repeat(24)}`,
      targetTick: 4,
      observedProjectionHash: digest,
      observedMenuHash: digest,
      idempotencyKey: "hermes-4",
      action: {
        actionId: "goal.defer",
        params: {},
        rationale: "Preserve cash until the next observation.",
      },
      driverPolicyDigest: digest,
    };
    expect(agentActionSubmissionSchema.parse(submission)).toEqual(submission);
    expect(agentActionSubmissionSchema.safeParse({
      ...submission,
      privatePrompt: "must not cross the boundary",
    }).success).toBe(false);
    expect(agentActionSubmissionSchema.safeParse({
      ...submission,
      observedMenuHash: "stale",
    }).success).toBe(false);
  });

  it("binds replayable external input bytes to their proposal digest", () => {
    const proposal = {
      actionId: "goal.defer",
      params: { agentId: "agt_00000001", reason: "defer_activation" },
      rationale: "Preserve optionality until the next cited observation.",
    };
    const recorded = {
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      studyId: "riverbend-realism",
      trialId: "seed-42-external-1",
      turnId: `turn_${"1".repeat(24)}`,
      agentId: "agt_00000001",
      opportunityKey: "goal:agt_00000001:4",
      targetTick: 4,
      projectionHash: digest,
      menuHash: digest,
      requestHash: digest,
      proposalDigest: hashValue(proposal),
      proposal,
      actionId: proposal.actionId,
      params: proposal.params,
      driverPolicyDigest: digest,
    };
    expect(recordedAgentLabSubmissionSchema.parse(recorded)).toEqual(recorded);
    expect(recordedAgentLabSubmissionSchema.safeParse({
      ...recorded,
      params: { ...proposal.params, invented: true },
    }).success).toBe(false);
    expect(recordedAgentLabSubmissionSchema.safeParse({
      ...recorded,
      proposalDigest: digest,
    }).success).toBe(false);
  });

  it("keeps turn observations scoped and menus strict", () => {
    const turn = {
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      simulationId: "sim_00000001",
      runId: "run_00000001",
      studyId: "riverbend-realism",
      trialId: "seed-42-shadow-1",
      turnId: `turn_${"1".repeat(24)}`,
      agentId: "agt_00000001",
      controller: "shadow",
      opportunityKey: "goal:agt_00000001:4",
      trigger: {
        kind: "goal",
        agentId: "agt_00000001",
        sourceEventId: "evt_00000001",
        tick: 4,
        priority: 70,
        payload: { goalId: "goal_00000001", goalKind: "stability" },
      },
      completedTick: 3,
      targetTick: 4,
      observation: {
        policyVersion: "partial_observation_v1",
        ownState: { cashCents: "10000" },
        learnedFacts: [],
        deliveredItems: [],
        publicPrices: [],
        citedMemories: [],
      },
      offeredOptions: [{
        actionId: "goal.defer",
        actionType: "goal.defer",
        params: {},
        utility: 10,
      }],
      projectionHash: digest,
      menuHash: digest,
      cursor: "tick:4:goal",
      deadline: "2026-07-24T12:00:05.000Z",
      driverPolicyDigest: digest,
      promptDigest: digest,
      toolSchemaDigest: digest,
    };
    expect(agentTurnEnvelopeSchema.parse(turn)).toEqual(turn);
    expect(agentTurnEnvelopeSchema.safeParse({
      ...turn,
      observation: { ...turn.observation, privateCanary: "leak" },
    }).success).toBe(false);
  });

  it("pins prompt bytes, tool schemas, engine, and attempts", () => {
    const manifest = {
      schemaVersion: 1,
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      studyId: "riverbend-realism",
      scenario: {
        name: "Riverbend realism",
        worldSpec: "riverbend-100@1",
        seeds: [42, 77, 103],
        ticks: 60,
        budgets: {
          runCostCentsMax: "10000",
          perAgentDailyTokens: 10_000,
        },
        policyOverrides: {},
      },
      cohort: {
        strategy: "stable_stratified_v1",
        size: 8,
        controller: "external",
        strata: ["occupation"],
      },
      interventions: [],
      hypotheses: [{
        id: "plan-continuity",
        statement: "Persistent sessions improve plan continuity.",
        metricIds: ["plan-continuity-rate"],
      }],
      primaryMetrics: [{
        id: "plan-continuity-rate",
        description: "Share of decisions consistent with a cited plan.",
        unit: "ratio",
        direction: "increase",
      }],
      secondaryMetrics: [],
      attempts: { native: 1, shadow: 3, external: 3 },
      provider: {
        family: "hermes",
        model: "pinned-model",
        settings: {
          decisionDeadlineMs: 5_000,
          inputMicrocentsPerToken: 100,
          outputMicrocentsPerToken: 300,
          hermesVersion: "Hermes Agent v0.18.2 · upstream abcdef0",
          hermesPythonVersion: "3.11.15",
          hermesOpenAiSdkVersion: "2.24.0",
          providerEnvAllowlist: "MINIMAX_API_KEY",
        },
      },
      generationBudget: {
        maxAgentLoopIterations: 8,
        maxInputTokens: 16_000,
        maxOutputTokens: 1_000,
        maxToolCalls: 8,
      },
      prompt: { bytes: "Use only the four WorldTangle tools.", digest },
      tools: [
        "wt_identity_get",
        "wt_turn_wait",
        "wt_action_submit",
        "wt_receipt_get",
      ].map((name) => ({ name, schema: { type: "object" }, digest })),
      engine: { commit: "abcdef1", dependencies: { node: "22.0.0" } },
      driverPolicyDigest: digest,
      createdWall: "2026-07-24T12:00:00.000Z",
    };
    expect(experimentManifestSchema.parse(manifest).scenario.ticks).toBe(60);
  });
});
