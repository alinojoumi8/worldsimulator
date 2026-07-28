import { describe, expect, it } from "vitest";
import {
  AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX,
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PILOT_FIXTURE_TICKS,
  AGENT_LAB_PROTOCOL_VERSION,
  AGENT_LAB_RECEIPT_STATUSES,
  AGENT_LAB_TERMINAL_RECEIPT_STATUSES,
  agentActionSubmissionSchema,
  agentLabScenarioSchema,
  agentTurnEnvelopeSchema,
  experimentManifestSchema,
  isAgentLabTerminalReceiptStatus,
  recordedAgentLabSubmissionSchema,
  runManifestAgentLabSchema,
  trialArtifactSchema,
} from "./agent-lab";
import { createSimulationRequestSchema } from "./api";
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
    opportunityFixture: {
      version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
      ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
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

function nativeScenario() {
  return {
    ...scenario(),
    mode: "native",
    cohortSelection: {
      ...scenario().cohortSelection,
      controller: "native",
    },
  } as const;
}

describe("Agent Lab contracts", () => {
  it("defines terminal receipt states positively", () => {
    expect(AGENT_LAB_TERMINAL_RECEIPT_STATUSES).toEqual([
      "shadowed",
      "applied",
      "rejected",
      "stale",
      "fallback",
    ]);
    for (const status of AGENT_LAB_RECEIPT_STATUSES) {
      expect(isAgentLabTerminalReceiptStatus(status)).toBe(status !== "queued");
    }
    expect(isAgentLabTerminalReceiptStatus(null)).toBe(false);
    expect(isAgentLabTerminalReceiptStatus(undefined)).toBe(false);
  });

  it("requires an explicit or stratified cohort outside native mode", () => {
    const noCohort = agentLabScenarioSchema.safeParse({
      ...scenario(),
      cohortSelection: undefined,
      opportunityFixture: undefined,
    });
    expect(noCohort.success).toBe(false);
    if (!noCohort.success) {
      expect(noCohort.error.issues.map((issue) => issue.path.join("."))).toContain(
        "controllerAssignments",
      );
    }
    expect(agentLabScenarioSchema.parse(scenario()).mode).toBe("shadow");
  });

  it("allows a matched native cohort and requires every fixture to name a cohort", () => {
    const native = nativeScenario();
    expect(agentLabScenarioSchema.parse(native).cohortSelection?.controller).toBe("native");
    const mismatchedController = agentLabScenarioSchema.safeParse({
      ...native,
      cohortSelection: {
        ...native.cohortSelection,
        controller: "shadow",
      },
    });
    expect(mismatchedController.success).toBe(false);
    if (!mismatchedController.success) {
      expect(
        mismatchedController.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ).toContainEqual({
        path: "cohortSelection.controller",
        message: "the cohort controller must match the trial mode",
      });
    }
    const fixtureWithoutCohort = agentLabScenarioSchema.safeParse({
      ...native,
      cohortSelection: undefined,
    });
    expect(fixtureWithoutCohort.success).toBe(false);
    if (!fixtureWithoutCohort.success) {
      expect(
        fixtureWithoutCohort.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("opportunityFixture");
    }
    expect(agentLabScenarioSchema.safeParse({
      ...native,
      cohortSelection: undefined,
      opportunityFixture: undefined,
    }).success).toBe(true);
    expect(agentLabScenarioSchema.safeParse({
      ...native,
      cohortSelection: undefined,
      controllerAssignments: [{
        agentId: "agt_00000001",
        controller: "native",
      }],
    }).success).toBe(true);
    const fixtureWithEmptyAssignments = agentLabScenarioSchema.safeParse({
      ...native,
      cohortSelection: undefined,
      controllerAssignments: [],
    });
    expect(fixtureWithEmptyAssignments.success).toBe(false);
    if (!fixtureWithEmptyAssignments.success) {
      expect(
        fixtureWithEmptyAssignments.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("opportunityFixture");
    }
  });

  it("requires fixture ticks to be unique and strictly ascending", () => {
    const native = nativeScenario();
    for (const ticks of [[10, 10], [30, 10]]) {
      const unordered = agentLabScenarioSchema.safeParse({
        ...native,
        opportunityFixture: {
          version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
          ticks,
        },
      });
      expect(unordered.success).toBe(false);
      if (!unordered.success) {
        expect(unordered.error.issues.map((issue) => issue.path.join("."))).toContain(
          "opportunityFixture.ticks",
        );
      }
    }
  });

  it("pins the supported fixture version", () => {
    const native = nativeScenario();
    const wrongFixtureVersion = agentLabScenarioSchema.safeParse({
      ...native,
      opportunityFixture: {
        version: "goal_commitment_choice_v0",
        ticks: [10],
      },
    });
    expect(wrongFixtureVersion.success).toBe(false);
    if (!wrongFixtureVersion.success) {
      expect(
        wrongFixtureVersion.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("opportunityFixture.version");
    }
  });

  it("requires every simulation fixture tick to occur on or before the run end", () => {
    const request = {
      name: "Fixture range",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: {
          runCostCentsMax: "100",
          perAgentDailyTokens: 1_000,
        },
        policyOverrides: {},
        endTick: 20,
        agentLab: {
          ...nativeScenario(),
          opportunityFixture: {
            version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
            ticks: [20],
          },
        },
      },
    } as const;
    expect(createSimulationRequestSchema.safeParse(request).success).toBe(true);
    const outOfRange = createSimulationRequestSchema.safeParse({
      ...request,
      scenario: {
        ...request.scenario,
        agentLab: {
          ...request.scenario.agentLab,
          opportunityFixture: {
            version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
            ticks: [10, 21],
          },
        },
      },
    });
    expect(outOfRange.success).toBe(false);
    if (!outOfRange.success) {
      expect(outOfRange.error.issues.map((issue) => issue.path.join("."))).toContain(
        "scenario.agentLab.opportunityFixture.ticks",
      );
    }
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

  it("requires unique cohort strata", () => {
    const duplicateStrata = agentLabScenarioSchema.safeParse({
      ...scenario(),
      cohortSelection: {
        ...scenario().cohortSelection,
        strata: ["occupation", "occupation"],
      },
    });
    expect(duplicateStrata.success).toBe(false);
    if (!duplicateStrata.success) {
      expect(
        duplicateStrata.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ).toContainEqual({
        path: "cohortSelection.strata",
        message: "cohort strata must be unique",
      });
    }
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
        opportunityFixture: {
          version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
          ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
        },
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
    const duplicateCohortStrata = experimentManifestSchema.safeParse({
      ...manifest,
      cohort: {
        ...manifest.cohort,
        strata: ["occupation", "occupation"],
      },
    });
    expect(duplicateCohortStrata.success).toBe(false);
    if (!duplicateCohortStrata.success) {
      expect(
        duplicateCohortStrata.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ).toContainEqual({
        path: "cohort.strata",
        message: "cohort strata must be unique",
      });
    }
    const outOfRange = experimentManifestSchema.safeParse({
      ...manifest,
      scenario: {
        ...manifest.scenario,
        opportunityFixture: {
          version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
          ticks: [10, 70],
        },
      },
    });
    expect(outOfRange.success).toBe(false);
    if (!outOfRange.success) {
      expect(outOfRange.error.issues.map((issue) => issue.path.join("."))).toContain(
        "scenario.opportunityFixture.ticks",
      );
    }
  });

  describe("trial artifact fixture statistics", () => {
    const legacyArtifact = {
      schemaVersion: 1,
      studyId: "riverbend-realism",
      trialId: "seed-42-shadow-1",
      mode: "shadow",
      seed: 42,
      attempt: 1,
      manifestDigest: digest,
      runtime: {
        engineCommit: "abcdef1",
        nodeVersion: "v24.0.0",
        platform: "win32-x64",
        startedWall: "2026-07-24T12:00:00.000Z",
        completedWall: "2026-07-24T12:01:00.000Z",
      },
      files: {},
      hashHeads: {
        eventLog: digest,
        state: digest,
        cache: digest,
        prompt: digest,
        artifact: digest,
      },
      statistics: {
        turns: 24,
        terminalReceipts: 24,
        validSubmissions: 24,
        rejectedSubmissions: 0,
        fallbacks: 0,
        toolCalls: 96,
        inputTokens: 1_000,
        outputTokens: 500,
        costMicrocents: "90000",
        latencyMs: 10_000,
      },
      taint: {
        tainted: false,
        reasons: [],
      },
    } as const;
    const fixtureSchedule = [
      {
        agentId: "agt_00000001",
        targetTick: 10,
        turnId: `turn_${"1".repeat(24)}`,
        receiptStatus: null,
      },
      {
        agentId: "agt_00000002",
        targetTick: 30,
        turnId: `turn_${"2".repeat(24)}`,
        receiptStatus: "applied",
      },
    ] as const;
    const authoritativeFixtureSchedule = fixtureSchedule.map((entry, index) => ({
      agentId: entry.agentId,
      targetTick: entry.targetTick,
      eventId: `evt_${(index + 1).toString().repeat(8)}`,
      actionType: index === 0
        ? "agent.reaffirm_goal" as const
        : "agent.defer_goal" as const,
      opportunityKey:
        `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
        `${entry.agentId}:goal_${index + 1}:${entry.targetTick}`,
    }));
    const fixtureHermesEvidenceSchedule = fixtureSchedule.map((entry, index) => ({
      agentId: entry.agentId,
      targetTick: entry.targetTick,
      turnId: entry.turnId,
      hermesRunId: `hermes-run-${index + 1}`,
      status: "completed" as const,
      inputTokens: 100,
      outputTokens: 20,
      toolCalls: 2,
      budgetViolationCount: 0,
    }));

    function populatedStatistics() {
      return trialArtifactSchema.parse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          fixtureTurns: fixtureSchedule.length,
          fixtureTerminalReceipts: 1,
          cohortAgentIds: ["agt_00000001", "agt_00000002"],
          fixtureSchedule,
          authoritativeFixtureSchedule,
          fixtureHermesEvidenceSchedule,
        },
      }).statistics;
    }

    it("defaults legacy fixture counters and evidence collections", () => {
      const parsedLegacy = trialArtifactSchema.parse(legacyArtifact);
      expect(parsedLegacy.statistics.fixtureTurns).toBe(0);
      expect(parsedLegacy.statistics.fixtureTerminalReceipts).toBe(0);
      expect(parsedLegacy.statistics.cohortAgentIds).toEqual([]);
      expect(parsedLegacy.statistics.fixtureSchedule).toEqual([]);
      expect(parsedLegacy.statistics.authoritativeFixtureSchedule).toEqual([]);
      expect(parsedLegacy.statistics.fixtureHermesEvidenceSchedule).toEqual([]);
    });

    it("accepts populated fixture evidence and preserves absent receipts", () => {
      const populated = populatedStatistics();
      expect(populated).toMatchObject({
        fixtureTurns: 2,
        fixtureTerminalReceipts: 1,
        cohortAgentIds: ["agt_00000001", "agt_00000002"],
      });
      expect(populated.fixtureSchedule[0]?.receiptStatus).toBeNull();
    });

    it("requires an explicit receipt status on every schedule entry", () => {
      const { receiptStatus, ...withoutStatus } = fixtureSchedule[0];
      expect(receiptStatus).toBeNull();
      const missing = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          fixtureTurns: 1,
          fixtureTerminalReceipts: 0,
          cohortAgentIds: ["agt_00000001"],
          fixtureSchedule: [withoutStatus],
        },
      });
      expect(missing.success).toBe(false);
      if (!missing.success) {
        expect(missing.error.issues.map((issue) => issue.path.join("."))).toContain(
          "statistics.fixtureSchedule.0.receiptStatus",
        );
      }
    });

    it.each([
      {
        name: "an unknown receipt status",
        entry: { ...fixtureSchedule[0], receiptStatus: "settled" },
        expectedPath: "statistics.fixtureSchedule.0.receiptStatus",
        expectedCode: "invalid_value",
      },
      {
        name: "an extra applied tick field",
        entry: { ...fixtureSchedule[0], appliedTick: 11 },
        expectedPath: "statistics.fixtureSchedule.0",
        expectedCode: "unrecognized_keys",
      },
    ])("rejects $name", ({ entry, expectedPath, expectedCode }) => {
      const invalid = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          fixtureTurns: 1,
          fixtureTerminalReceipts: 0,
          cohortAgentIds: ["agt_00000001"],
          fixtureSchedule: [entry],
        },
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(
          invalid.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.join("."),
          })),
        ).toContainEqual({
          code: expectedCode,
          path: expectedPath,
        });
      }
    });

    it.each([
      {
        name: "negative fixture turn count",
        patch: { fixtureTurns: -1 },
        expectedPath: "statistics.fixtureTurns",
        expectedCode: "too_small",
      },
      {
        name: "negative fixture terminal receipt count",
        patch: { fixtureTerminalReceipts: -1 },
        expectedPath: "statistics.fixtureTerminalReceipts",
        expectedCode: "too_small",
      },
      {
        name: "fixture turns above all turns",
        patch: { fixtureTurns: 25 },
        expectedPath: "statistics.fixtureTurns",
        expectedMessage: "fixture turns cannot exceed total turns",
      },
      {
        name: "fixture receipts above all terminal receipts",
        patch: { fixtureTerminalReceipts: 25 },
        expectedPath: "statistics.fixtureTerminalReceipts",
        expectedMessage:
          "fixture terminal receipts cannot exceed total terminal receipts",
      },
      {
        name: "fixture receipts above fixture turns",
        patch: { fixtureTurns: 1, fixtureTerminalReceipts: 2 },
        expectedPath: "statistics.fixtureTerminalReceipts",
        expectedMessage: "fixture terminal receipts cannot exceed fixture turns",
      },
    ])("rejects $name", (testCase) => {
      const { patch, expectedPath } = testCase;
      const invalid = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          ...patch,
        },
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        if ("expectedCode" in testCase) {
          expect(
            invalid.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          ).toContainEqual({
            path: expectedPath,
            code: testCase.expectedCode,
          });
        } else {
          expect(
            invalid.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          ).toContainEqual({
            path: expectedPath,
            message: testCase.expectedMessage,
          });
        }
      }
    });

    it("bounds the recorded cohort", () => {
      const maxCohort = Array.from(
        { length: 100 },
        (_, index) => `agt_${(index + 1).toString().padStart(8, "0")}`,
      );
      expect(trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          cohortAgentIds: maxCohort,
        },
      }).success).toBe(true);
      const oversizedCohort = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          cohortAgentIds: [
            ...maxCohort,
            "agt_00000101",
          ],
        },
      });
      expect(oversizedCohort.success).toBe(false);
      if (!oversizedCohort.success) {
        expect(
          oversizedCohort.error.issues.map((issue) => issue.path.join(".")),
        ).toContain("statistics.cohortAgentIds");
      }
    });

    it.each([
      {
        name: "a non-positive fixture tick",
        entry: { ...fixtureSchedule[0], targetTick: 0 },
        expectedPath: "statistics.fixtureSchedule.0.targetTick",
      },
      {
        name: "a malformed fixture turn ID",
        entry: { ...fixtureSchedule[0], turnId: "not-a-turn-id" },
        expectedPath: "statistics.fixtureSchedule.0.turnId",
      },
    ])("rejects $name", ({ entry, expectedPath }) => {
      const invalidScheduleEntry = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          fixtureTurns: 1,
          fixtureTerminalReceipts: 0,
          cohortAgentIds: ["agt_00000001"],
          fixtureSchedule: [entry],
        },
      });
      expect(invalidScheduleEntry.success).toBe(false);
      if (!invalidScheduleEntry.success) {
        expect(
          invalidScheduleEntry.error.issues.map((issue) => issue.path.join(".")),
        ).toContain(expectedPath);
      }
    });

    it.each([
      {
        name: "an unknown authoritative action type",
        entry: {
          ...authoritativeFixtureSchedule[0],
          actionType: "agent.erase_goal",
        },
        expectedPath:
          "statistics.authoritativeFixtureSchedule.0.actionType",
      },
      {
        name: "an authoritative opportunity without the fixture prefix",
        entry: {
          ...authoritativeFixtureSchedule[0],
          opportunityKey: "05-goal-activation:agt_00000001",
        },
        expectedPath:
          "statistics.authoritativeFixtureSchedule.0.opportunityKey",
      },
      {
        name: "an overlong authoritative event ID",
        entry: {
          ...authoritativeFixtureSchedule[0],
          eventId: `evt_${"a".repeat(65)}`,
        },
        expectedPath:
          "statistics.authoritativeFixtureSchedule.0.eventId",
      },
      {
        name: "an overlong authoritative opportunity key",
        entry: {
          ...authoritativeFixtureSchedule[0],
          opportunityKey:
            `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}${"a".repeat(241)}`,
        },
        expectedPath:
          "statistics.authoritativeFixtureSchedule.0.opportunityKey",
      },
      {
        name: "a blank Hermes run ID",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          hermesRunId: "",
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.hermesRunId",
        schedule: "hermes" as const,
      },
      {
        name: "a negative per-turn Hermes token count",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          inputTokens: -1,
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.inputTokens",
        schedule: "hermes" as const,
      },
      {
        name: "an unsupported per-turn Hermes status",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          status: "queued",
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.status",
        schedule: "hermes" as const,
      },
      {
        name: "a negative per-turn Hermes output count",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          outputTokens: -1,
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.outputTokens",
        schedule: "hermes" as const,
      },
      {
        name: "a negative per-turn Hermes tool-call count",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          toolCalls: -1,
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.toolCalls",
        schedule: "hermes" as const,
      },
      {
        name: "a negative per-turn Hermes budget-violation count",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          budgetViolationCount: -1,
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.budgetViolationCount",
        schedule: "hermes" as const,
      },
      {
        name: "an invalid per-turn Hermes target tick",
        entry: {
          ...fixtureHermesEvidenceSchedule[0],
          targetTick: 0,
        },
        expectedPath:
          "statistics.fixtureHermesEvidenceSchedule.0.targetTick",
        schedule: "hermes" as const,
      },
    ])("rejects $name", (testCase) => {
      const { entry, expectedPath } = testCase;
      const isHermesEvidence =
        "schedule" in testCase && testCase.schedule === "hermes";
      const invalidEntry = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...legacyArtifact.statistics,
          cohortAgentIds: ["agt_00000001"],
          ...(isHermesEvidence
            ? {
                fixtureTurns: 1,
                fixtureTerminalReceipts: 0,
                fixtureSchedule: [fixtureSchedule[0]],
                fixtureHermesEvidenceSchedule: [entry],
              }
            : { authoritativeFixtureSchedule: [entry] }),
        },
      });
      expect(invalidEntry.success).toBe(false);
      if (!invalidEntry.success) {
        expect(
          invalidEntry.error.issues.map((issue) => issue.path.join(".")),
        ).toContain(expectedPath);
      }
    });

    it.each([
      {
        name: "duplicate agent and tick slots",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureTerminalReceipts: 0,
          fixtureSchedule: [
            fixtureSchedule[0],
            { ...fixtureSchedule[0], turnId: `turn_${"3".repeat(24)}` },
          ],
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage:
          "fixture schedule entries must be unique per agent and target tick",
      },
      {
        name: "duplicate turn IDs",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureSchedule: [
            fixtureSchedule[0],
            { ...fixtureSchedule[1], turnId: fixtureSchedule[0].turnId },
          ],
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage: "fixture schedule turn IDs must be unique",
      },
      {
        name: "non-canonical fixture ordering",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureSchedule: [...fixtureSchedule].reverse(),
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage:
          "fixture schedule must be canonically ordered by target tick then agent",
      },
      {
        name: "a fixture schedule length mismatch",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureTurns: 1,
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage: "fixture schedule length must equal fixture turn count",
      },
      {
        name: "a fixture terminal count mismatch",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureTerminalReceipts: 0,
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage:
          "fixture schedule terminal statuses must equal the terminal receipt count",
      },
      {
        name: "non-canonical cohort ordering",
        buildStatistics: () => ({
          ...populatedStatistics(),
          cohortAgentIds: ["agt_00000002", "agt_00000001"],
        }),
        expectedPath: "statistics.cohortAgentIds",
        expectedMessage: "cohort agent IDs must be canonically ordered",
      },
      {
        name: "duplicate cohort members",
        buildStatistics: () => ({
          ...populatedStatistics(),
          cohortAgentIds: [
            "agt_00000001",
            "agt_00000001",
            "agt_00000002",
          ],
        }),
        expectedPath: "statistics.cohortAgentIds",
        expectedMessage: "cohort agent IDs must be unique",
      },
      {
        name: "a scheduled agent outside the cohort",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureSchedule: [
            fixtureSchedule[0],
            { ...fixtureSchedule[1], agentId: "agt_00000003" },
          ],
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage:
          "every fixture schedule agent must belong to the recorded cohort",
      },
      {
        name: "scheduled agents with an empty cohort",
        buildStatistics: () => ({
          ...populatedStatistics(),
          cohortAgentIds: [],
        }),
        expectedPath: "statistics.fixtureSchedule",
        expectedMessage:
          "every fixture schedule agent must belong to the recorded cohort",
      },
      {
        name: "duplicate authoritative agent and tick slots",
        buildStatistics: () => ({
          ...populatedStatistics(),
          authoritativeFixtureSchedule: [
            authoritativeFixtureSchedule[0],
            {
              ...authoritativeFixtureSchedule[0],
              eventId: `evt_${"3".repeat(8)}`,
            },
          ],
        }),
        expectedPath: "statistics.authoritativeFixtureSchedule",
        expectedMessage:
          "authoritative fixture entries must be unique per agent and target tick",
      },
      {
        name: "duplicate authoritative event IDs",
        buildStatistics: () => ({
          ...populatedStatistics(),
          authoritativeFixtureSchedule: [
            authoritativeFixtureSchedule[0],
            {
              ...authoritativeFixtureSchedule[1],
              eventId: authoritativeFixtureSchedule[0]!.eventId,
            },
          ],
        }),
        expectedPath: "statistics.authoritativeFixtureSchedule",
        expectedMessage: "authoritative fixture event IDs must be unique",
      },
      {
        name: "non-canonical authoritative ordering",
        buildStatistics: () => ({
          ...populatedStatistics(),
          authoritativeFixtureSchedule:
            [...authoritativeFixtureSchedule].reverse(),
        }),
        expectedPath: "statistics.authoritativeFixtureSchedule",
        expectedMessage:
          "authoritative fixture schedule must be ordered by target tick then agent",
      },
      {
        name: "an authoritative agent outside the cohort",
        buildStatistics: () => ({
          ...populatedStatistics(),
          authoritativeFixtureSchedule: [
            authoritativeFixtureSchedule[0],
            {
              ...authoritativeFixtureSchedule[1],
              agentId: "agt_00000003",
              opportunityKey:
                `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
                "agt_00000003:goal_2:30",
            },
          ],
        }),
        expectedPath: "statistics.authoritativeFixtureSchedule",
        expectedMessage:
          "every authoritative fixture agent must belong to the recorded cohort",
      },
      {
        name: "an authoritative slot without a scheduled fixture turn",
        buildStatistics: () => ({
          ...populatedStatistics(),
          authoritativeFixtureSchedule: [
            authoritativeFixtureSchedule[0],
            {
              ...authoritativeFixtureSchedule[1],
              targetTick: 40,
              opportunityKey:
                `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
                "agt_00000002:goal_2:40",
            },
          ],
        }),
        expectedPath: "statistics.authoritativeFixtureSchedule",
        expectedMessage:
          "every authoritative fixture entry must reference a fixture turn slot",
      },
      {
        name: "duplicate Hermes evidence slots",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            fixtureHermesEvidenceSchedule[0],
            {
              ...fixtureHermesEvidenceSchedule[0],
              turnId: fixtureSchedule[1]!.turnId,
              hermesRunId: "hermes-run-3",
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage:
          "fixture Hermes evidence must be unique per agent and target tick",
      },
      {
        name: "duplicate Hermes evidence turn IDs",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            fixtureHermesEvidenceSchedule[0],
            {
              ...fixtureHermesEvidenceSchedule[1],
              turnId: fixtureHermesEvidenceSchedule[0]!.turnId,
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage: "fixture Hermes evidence turn IDs must be unique",
      },
      {
        name: "duplicate Hermes run IDs",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            fixtureHermesEvidenceSchedule[0],
            {
              ...fixtureHermesEvidenceSchedule[1],
              hermesRunId:
                fixtureHermesEvidenceSchedule[0]!.hermesRunId,
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage: "fixture Hermes run IDs must be unique",
      },
      {
        name: "non-canonical Hermes evidence ordering",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule:
            [...fixtureHermesEvidenceSchedule].reverse(),
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage:
          "fixture Hermes evidence must be ordered by target tick then agent",
      },
      {
        name: "Hermes evidence for an agent outside the cohort",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            fixtureHermesEvidenceSchedule[0],
            {
              ...fixtureHermesEvidenceSchedule[1],
              agentId: "agt_00000003",
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage:
          "every fixture Hermes evidence agent must belong to the cohort",
      },
      {
        name: "Hermes evidence for a non-fixture turn",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            fixtureHermesEvidenceSchedule[0],
            {
              ...fixtureHermesEvidenceSchedule[1],
              turnId: `turn_${"9".repeat(24)}`,
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage:
          "every fixture Hermes evidence row must reference a fixture turn",
      },
      {
        name: "Hermes evidence cross-linked to the wrong fixture slots",
        buildStatistics: () => ({
          ...populatedStatistics(),
          fixtureHermesEvidenceSchedule: [
            {
              ...fixtureHermesEvidenceSchedule[0],
              turnId: fixtureSchedule[1]!.turnId,
            },
            {
              ...fixtureHermesEvidenceSchedule[1],
              turnId: fixtureSchedule[0]!.turnId,
            },
          ],
        }),
        expectedPath: "statistics.fixtureHermesEvidenceSchedule",
        expectedMessage:
          "every fixture Hermes evidence row must reference a fixture turn",
      },
    ])("rejects $name", ({ buildStatistics, expectedPath, expectedMessage }) => {
      const invalidArtifact = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        mode: "shadow",
        statistics: buildStatistics(),
      });
      expect(invalidArtifact.success).toBe(false);
      if (!invalidArtifact.success) {
        expect(
          invalidArtifact.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ).toContainEqual({
          path: expectedPath,
          message: expectedMessage,
        });
      }
    });

    it("rejects non-native authoritative evidence when the fixture schedule is empty", () => {
      const invalidArtifact = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        mode: "shadow",
        statistics: {
          ...populatedStatistics(),
          turns: 0,
          terminalReceipts: 0,
          validSubmissions: 0,
          rejectedSubmissions: 0,
          fallbacks: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: "0",
          latencyMs: 0,
          fixtureTurns: 0,
          fixtureTerminalReceipts: 0,
          fixtureSchedule: [],
          fixtureHermesEvidenceSchedule: [],
        },
      });

      expect(invalidArtifact.success).toBe(false);
      if (!invalidArtifact.success) {
        expect(
          invalidArtifact.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ).toContainEqual({
          path: "statistics.authoritativeFixtureSchedule",
          message:
            "every authoritative fixture entry must reference a fixture turn slot",
        });
      }
    });

    it("allows native authoritative evidence without a sidecar fixture schedule", () => {
      expect(() => trialArtifactSchema.parse({
        ...legacyArtifact,
        mode: "native",
        statistics: {
          ...populatedStatistics(),
          turns: 0,
          terminalReceipts: 0,
          validSubmissions: 0,
          rejectedSubmissions: 0,
          fallbacks: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: "0",
          latencyMs: 0,
          fixtureTurns: 0,
          fixtureTerminalReceipts: 0,
          fixtureSchedule: [],
          fixtureHermesEvidenceSchedule: [],
        },
      })).not.toThrow();
    });

    it("rejects native fixture-turn and Hermes sidecar evidence", () => {
      const invalidArtifact = trialArtifactSchema.safeParse({
        ...legacyArtifact,
        mode: "native",
        statistics: populatedStatistics(),
      });

      expect(invalidArtifact.success).toBe(false);
      if (!invalidArtifact.success) {
        expect(invalidArtifact.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }))).toEqual(expect.arrayContaining([
          {
            path: "statistics.fixtureSchedule",
            message: "native trials must not record fixture turns",
          },
          {
            path: "statistics.fixtureHermesEvidenceSchedule",
            message: "native trials must not record fixture Hermes evidence",
          },
        ]));
      }
    });

    it("does not count queued fixture receipts as terminal", () => {
      expect(trialArtifactSchema.safeParse({
        ...legacyArtifact,
        statistics: {
          ...populatedStatistics(),
          fixtureSchedule: [
            fixtureSchedule[0],
            { ...fixtureSchedule[1], receiptStatus: "queued" },
          ],
          fixtureTerminalReceipts: 0,
        },
      }).success).toBe(true);
    });
  });
});
