import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX,
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PILOT_FIXTURE_TICKS,
  AGENT_LAB_PROTOCOL_VERSION,
  agentActionReceiptSchema,
  agentTurnEnvelopeSchema,
  canonicalStringify,
  eventEnvelopeSchema,
  experimentScorecardSchema,
  runManifestAgentLabSchema,
  sha256Hex,
  trialArtifactSchema,
  type AgentLabReceiptStatus,
  type AgentTurnEnvelope,
  type ExperimentManifest,
  type RunManifestAgentLab,
} from "@worldtangle/shared";
import {
  parseHermesRunsForArtifact,
  sanitizedRejectedHermesValue,
  verifyTrialArtifact,
} from "./artifact";
import { formatCliError, parseArguments } from "./cli";
import {
  createPilotManifest,
  PILOT_EXPECTED_NON_FIXTURE_TURNS_PER_AGENT_PER_FIXTURE_TICK,
} from "./create-manifest";
import {
  agentLabDriverPolicy,
  agentLabDriverPolicyDigest,
  agentLabLegacyDriverPolicyDigest,
  agentLabPromptDigest,
  agentLabToolPins,
  agentLabToolSchemaDigest,
  CITIZEN_TURN_PROMPT,
  MAX_SHADOW_TURNS_PER_CREDENTIAL_PER_TICK,
} from "./driver-policy";
import {
  expectedFixtureMatrixKeys,
  observedFixtureMatrixKeys,
} from "./fixture-matrix";
import {
  buildHermesProfileEnvironment,
  HermesApiTurnDriver,
  HermesBudgetExceededError,
  HermesTurnExecutionError,
  profileConfig,
  redactSecrets,
  terminateHermesProcess,
  type HermesEndpoint,
  type HermesTurnStats,
} from "./hermes";
import {
  experimentManifestDigest,
  loadExperimentManifest,
  planTrials,
  validateArchivedExperimentManifest,
  validateExperimentManifest,
} from "./manifest";
import { releaseIssues } from "./report";
import {
  assertFreshStudyDirectory,
  collectTrialCleanupErrors,
  driveExternalAdvance,
  driveShadowTurns,
  runStudy,
  shadowTurnCircuitBreakerLimit,
} from "./runner";

const inspectHermesRuntimeMock = vi.hoisted(() => vi.fn(() => Object.freeze({
  version: "Hermes Agent v0.18.2 (test) · upstream abcdef0",
  pythonVersion: "3.11.15",
  openAiSdkVersion: "2.24.0",
  mcpSdkVersion: "1.26.0",
  starletteVersion: "1.3.1",
  aiohttpVersion: "3.14.1",
})));

vi.mock("./hermes-version", () => ({
  inspectHermesRuntime: inspectHermesRuntimeMock,
}));

const roots: string[] = [];
const budget = {
  maxAgentLoopIterations: 8,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_000,
  maxToolCalls: 8,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  inspectHermesRuntimeMock.mockClear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function manifest() {
  return {
    schemaVersion: 2 as const,
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: "harness-test",
    scenario: {
      name: "Harness test",
      worldSpec: "riverbend-100@1",
      seeds: [11, 22, 33],
      ticks: 60,
      budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
      policyOverrides: {},
      opportunityFixture: {
        version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
        ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
      },
    },
    cohort: {
      strategy: "stable_stratified_v1" as const,
      size: 8,
      controller: "external" as const,
      strata: ["occupation", "employment_status"] as const,
    },
    interventions: [],
    hypotheses: [{
      id: "h1",
      statement: "The trial remains bounded.",
      metricIds: ["validity"],
    }],
    primaryMetrics: [{
      id: "validity",
      description: "Valid terminal receipts.",
      unit: "count",
      direction: "increase" as const,
    }],
    secondaryMetrics: [],
    attempts: { native: 1, shadow: 3, external: 3 },
    provider: {
      family: "hermes",
      model: "test-model",
      settings: {
        decisionDeadlineMs: 60_000,
        inputMicrocentsPerToken: 100,
        outputMicrocentsPerToken: 300,
        hermesVersion: "Hermes Agent v0.18.2 (test) · upstream abcdef0",
        hermesPythonVersion: "3.11.15",
        hermesOpenAiSdkVersion: "2.24.0",
        hermesMcpSdkVersion: "1.26.0",
        hermesStarletteVersion: "1.3.1",
        hermesAiohttpVersion: "3.14.1",
        providerEnvAllowlist: "MINIMAX_API_KEY",
      },
    },
    generationBudget: budget,
    prompt: {
      bytes: CITIZEN_TURN_PROMPT,
      digest: agentLabPromptDigest(),
    },
    tools: agentLabToolPins(),
    engine: {
      commit: "abcdef0",
      dependencies: {
        node: process.version,
        "pnpm-lock-sha256": "0".repeat(64),
      },
    },
    driverPolicyDigest: agentLabDriverPolicyDigest(budget),
    createdWall: "2026-07-24T12:00:00.000Z",
  };
}

function harnessTurn(
  agentId: string,
  turnDiscriminator: string,
): AgentTurnEnvelope {
  const digest = "a".repeat(64);
  return agentTurnEnvelopeSchema.parse({
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    simulationId: "sim_00000001",
    runId: "run_00000001",
    studyId: "harness-test",
    trialId: "harness-test-shadow-a1",
    turnId: `turn_${sha256Hex(`harness-turn:${turnDiscriminator}`).slice(0, 24)}`,
    agentId,
    controller: "shadow",
    opportunityKey: `goal:${agentId}:10`,
    trigger: {
      kind: "goal",
      agentId,
      sourceEventId: `evt_${turnDiscriminator.repeat(8)}`,
      tick: 10,
      priority: 70,
      payload: {
        goalId: `goal_${turnDiscriminator.repeat(8)}`,
        goalKind: "stability",
      },
    },
    completedTick: 9,
    targetTick: 10,
    observation: {
      policyVersion: "partial_observation_v1",
      ownState: {},
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
    cursor: `tick:10:${agentId}`,
    deadline: "2999-01-01T00:00:00.000Z",
    driverPolicyDigest: digest,
    promptDigest: digest,
    toolSchemaDigest: digest,
  });
}

function harnessEndpoint(
  profileDiscriminator: string,
): HermesEndpoint {
  return {
    baseUrl: "http://127.0.0.1:4010",
    apiKey: `api-key-${profileDiscriminator}`,
    model: "test-model",
    profileId: `profile-${profileDiscriminator}`,
    sessionId: `session-${profileDiscriminator}`,
    sessionKey: `session-key-${profileDiscriminator}`,
    terminateProfile: async () => {},
  };
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function refreshArtifactFileHash(root: string, fileName: string): void {
  const artifactPath = join(root, "artifact.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    files: Record<string, string>;
    hashHeads: { artifact: string };
  };
  artifact.files[fileName] = hash(join(root, fileName));
  artifact.hashHeads.artifact = sha256Hex(canonicalStringify(artifact.files));
  writeFileSync(artifactPath, `${canonicalStringify(artifact)}\n`, "utf8");
}

function cohortAgentIdsFor(size: number): string[] {
  return Array.from(
    { length: size },
    (_, index) => `agt_${(index + 1).toString(36).padStart(8, "0")}`,
  );
}

function releaseTrial(
  mode: "native" | "shadow" | "external",
  seed: number,
  attempt: number,
  overrides: Readonly<{
    turns?: number;
    terminalReceipts?: number;
    fixtureTurns?: number;
    fixtureTerminalReceipts?: number;
    cohortAgentIds?: readonly string[];
    fixtureSchedule?: readonly {
      readonly agentId: string;
      readonly targetTick: number;
      readonly turnId: string;
      readonly receiptStatus: AgentLabReceiptStatus | null;
    }[];
    authoritativeFixtureSchedule?: readonly {
      readonly agentId: string;
      readonly targetTick: number;
      readonly eventId: string;
      readonly actionType: "agent.reaffirm_goal" | "agent.defer_goal";
      readonly opportunityKey: string;
    }[];
    fixtureHermesEvidenceSchedule?: readonly {
      readonly agentId: string;
      readonly targetTick: number;
      readonly turnId: string;
      readonly hermesRunId: string;
      readonly status: "completed" | "failed" | "cancelled";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly toolCalls: number;
      readonly budgetViolationCount: number;
    }[];
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    hermesInputTokens?: number;
    hermesOutputTokens?: number;
    hermesFailedRuns?: number;
    eventLogHash?: string;
    stateHash?: string;
    manifestDigest?: string;
    studyId?: string;
  }> = {},
) {
  const definition = manifest();
  const parsedDefinition = validateExperimentManifest(definition);
  const expectedTurns = mode === "native"
    ? 0
    : definition.cohort.size *
      definition.scenario.opportunityFixture.ticks.length;
  const effectiveTurns = overrides.turns ?? expectedTurns;
  const effectiveTerminalReceipts = overrides.terminalReceipts ?? effectiveTurns;
  const effectiveFixtureTurns = overrides.fixtureTurns ?? effectiveTurns;
  const effectiveFixtureTerminalReceipts =
    overrides.fixtureTerminalReceipts ?? effectiveTerminalReceipts;
  const cohortAgentIds =
    overrides.cohortAgentIds ?? cohortAgentIdsFor(definition.cohort.size);
  const fullFixtureSchedule = mode === "native"
    ? []
    : definition.scenario.opportunityFixture.ticks.flatMap((targetTick) =>
        cohortAgentIds.map((agentId, index) => ({
          agentId,
          targetTick,
          turnId: `turn_${(
            (targetTick * definition.cohort.size) + index
          ).toString(16).padStart(24, "0")}`,
          receiptStatus: (
            mode === "shadow" ? "shadowed" : "applied"
          ) as AgentLabReceiptStatus,
        }))
      );
  const fixtureSchedule = overrides.fixtureSchedule ?? (
    fullFixtureSchedule
      .slice(0, effectiveFixtureTurns)
      .map((entry, index) => ({
        ...entry,
        receiptStatus: index < effectiveFixtureTerminalReceipts
          ? entry.receiptStatus
          : null,
      }))
  );
  const authoritativeFixtureSchedule =
    overrides.authoritativeFixtureSchedule ??
    definition.scenario.opportunityFixture.ticks.flatMap((targetTick) =>
      cohortAgentIds.map((agentId, index) => {
        const eventDigest = sha256Hex(
          `fixture-event:${seed}:${mode}:${attempt}:${targetTick}:${agentId}`,
        );
        return {
          agentId,
          targetTick,
          eventId: `evt_${eventDigest.slice(0, 24)}`,
          actionType: "agent.reaffirm_goal" as const,
          opportunityKey:
            `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
            `${agentId}:goal_${index.toString(36)}:${targetTick}`,
        };
      })
    );
  const fixtureHermesEvidenceSchedule =
    overrides.fixtureHermesEvidenceSchedule ??
    (
      mode === "native"
        ? []
        : fixtureSchedule.map((entry) => ({
            agentId: entry.agentId,
            targetTick: entry.targetTick,
            turnId: entry.turnId,
            hermesRunId: `hermes-${entry.turnId}`,
            status: "completed" as const,
            inputTokens: 100,
            outputTokens: 20,
            toolCalls: 2,
            budgetViolationCount: 0,
          }))
    );
  const seedHash = createHash("sha256").update(`seed:${seed}`).digest("hex");
  const trialId = `harness-test-s${seed}-${mode}-a${attempt}`;
  const artifact = trialArtifactSchema.parse({
    schemaVersion: 1,
    studyId: overrides.studyId ?? definition.studyId,
    trialId,
    mode,
    seed,
    attempt,
    manifestDigest:
      overrides.manifestDigest ?? experimentManifestDigest(parsedDefinition),
    runtime: {
      engineCommit: "abcdef0",
      nodeVersion: process.version,
      platform: process.platform,
      startedWall: "2026-07-24T12:00:00.000Z",
      completedWall: "2026-07-24T12:01:00.000Z",
    },
    files: {},
    hashHeads: {
      eventLog: overrides.eventLogHash ?? seedHash,
      state: overrides.stateHash ?? seedHash,
      cache: "4".repeat(64),
      prompt: agentLabPromptDigest(),
      artifact: "5".repeat(64),
    },
    statistics: {
      turns: effectiveTurns,
      terminalReceipts: effectiveTerminalReceipts,
      fixtureTurns: effectiveFixtureTurns,
      fixtureTerminalReceipts: effectiveFixtureTerminalReceipts,
      cohortAgentIds,
      fixtureSchedule,
      authoritativeFixtureSchedule,
      fixtureHermesEvidenceSchedule,
      validSubmissions: effectiveTurns,
      rejectedSubmissions: 0,
      fallbacks: 0,
      toolCalls: overrides.toolCalls ?? (effectiveTurns * 2),
      inputTokens: overrides.inputTokens ?? (effectiveTurns * 100),
      outputTokens: overrides.outputTokens ?? (effectiveTurns * 20),
      costMicrocents: "0",
      latencyMs: 0,
    },
    taint: { tainted: false, reasons: [] },
  });
  const score = experimentScorecardSchema.parse({
    schemaVersion: 1,
    studyId: "harness-test",
    trialId,
    structural: [
      {
        metricId: "invariants_pass",
        value: 1,
        unit: "boolean",
        evidence: ["fixture"],
      },
      {
        metricId: "replay_divergences",
        value: 0,
        unit: "count",
        evidence: ["fixture"],
      },
      {
        metricId: "unauthorized_applied_actions",
        value: 0,
        unit: "count",
        evidence: ["fixture"],
      },
    ],
    behavioral: [],
    social: [],
    economic: [],
    operational: [
      {
        metricId: "hermes_input_tokens",
        value: overrides.hermesInputTokens ?? (effectiveTurns * 100),
        unit: "tokens",
        evidence: ["runtime.json"],
      },
      {
        metricId: "hermes_output_tokens",
        value: overrides.hermesOutputTokens ?? (effectiveTurns * 20),
        unit: "tokens",
        evidence: ["runtime.json"],
      },
      {
        metricId: "hermes_failed_runs",
        value: overrides.hermesFailedRuns ?? 0,
        unit: "runs",
        evidence: ["runtime.json"],
      },
    ],
  });
  return { artifact, valid: true, score };
}

function releaseTrials() {
  return [11, 22, 33].flatMap((seed) => [
    releaseTrial("native", seed, 1),
    ...[1, 2, 3].map((attempt) => releaseTrial("shadow", seed, attempt)),
    ...[1, 2, 3].map((attempt) => releaseTrial("external", seed, attempt)),
  ]);
}

function releaseTrialIndex(
  trials: ReturnType<typeof releaseTrials>,
  mode: "native" | "shadow" | "external",
  seed: number,
  attempt: number,
): number {
  const index = trials.findIndex((trial) => (
    trial.artifact.mode === mode &&
    trial.artifact.seed === seed &&
    trial.artifact.attempt === attempt
  ));
  if (index < 0) {
    throw new Error(`missing ${mode} trial for seed ${seed}, attempt ${attempt}`);
  }
  return index;
}

function replaceReleaseTrial(
  trials: ReturnType<typeof releaseTrials>,
  mode: "native" | "shadow" | "external",
  seed: number,
  attempt: number,
  replacement: ReturnType<typeof releaseTrial>,
): void {
  trials[releaseTrialIndex(trials, mode, seed, attempt)] = replacement;
}

function artifactRunConfig(mode: "native" | "shadow" | "external") {
  const definition = manifest();
  const cohortAgentIds = cohortAgentIdsFor(definition.cohort.size);
  return runManifestAgentLabSchema.parse({
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: definition.studyId,
    trialId: `harness-test-s11-${mode}-a1`,
    experimentManifestDigest: experimentManifestDigest(
      validateExperimentManifest(definition),
    ),
    mode,
    cohortSelection: {
      strategy: "stable_stratified_v1",
      size: definition.cohort.size,
      controller: mode,
      strata: [...definition.cohort.strata],
    },
    opportunityFixture: definition.scenario.opportunityFixture,
    decisionDeadlineMs: definition.provider.settings.decisionDeadlineMs,
    budget: definition.generationBudget,
    driverPolicyDigest: definition.driverPolicyDigest,
    promptDigest: definition.prompt.digest,
    toolSchemaDigest: agentLabToolSchemaDigest(),
    resolvedAssignments: cohortAgentIds.map((agentId) => ({
      agentId,
      controller: mode,
    })),
  });
}

function validArtifactDirectory(
  mode: "native" | "shadow" | "external" = "native",
): string {
  const root = mkdtempSync(join(tmpdir(), "worldtangle-harness-artifact-"));
  roots.push(root);
  const trialId = `harness-test-s11-${mode}-a1`;
  const agentLabConfig = artifactRunConfig(mode);
  const cohortAgentIds = agentLabConfig.resolvedAssignments.map(
    (assignment) => assignment.agentId,
  );
  const turns = mode === "native"
    ? []
    : agentLabConfig.opportunityFixture!.ticks.flatMap((targetTick) =>
        cohortAgentIds.map((agentId) => {
          const turnDigest = sha256Hex(`${agentId}:${targetTick}`);
          const base = harnessTurn(agentId, "a");
          return agentTurnEnvelopeSchema.parse({
            ...base,
            trialId,
            turnId: `turn_${turnDigest.slice(0, 24)}`,
            controller: mode,
            opportunityKey:
              `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
              `${agentId}:goal_${turnDigest.slice(0, 8)}:${targetTick}`,
            trigger: {
              ...base.trigger,
              sourceEventId: `evt_${turnDigest.slice(0, 8)}`,
              tick: targetTick,
            },
            completedTick: targetTick - 1,
            targetTick,
            cursor: `tick:${targetTick}:${agentId}`,
          });
        })
      );
  const receipts = turns.map((turn) => {
    const receiptDigest = sha256Hex(`receipt:${turn.turnId}`);
    return agentActionReceiptSchema.parse({
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      receiptId: `rcpt_${receiptDigest.slice(0, 24)}`,
      turnId: turn.turnId,
      runId: turn.runId,
      agentId: turn.agentId,
      targetTick: turn.targetTick,
      status: mode === "shadow" ? "shadowed" : "applied",
      validatorResults: [],
      resultEventIds: [],
      createdWall: "2026-07-24T12:00:00.000Z",
      completedWall: "2026-07-24T12:00:01.000Z",
    });
  });
  const toolCalls = turns.map((turn, index) => ({
    sequence: index,
    agentId: turn.agentId,
    toolName: "wt_action_submit",
    turnId: turn.turnId,
    status: "ok",
    calledWall: "2026-07-24T12:00:00.500Z",
  }));
  const hermesRuns: HermesTurnStats[] = turns.map((turn) => ({
    runId: `hermes-${turn.turnId}`,
    turnId: turn.turnId,
    opportunityKey: turn.opportunityKey,
    agentId: turn.agentId,
    targetTick: turn.targetTick,
    status: "completed",
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 10,
    budgetViolations: [],
  }));
  const fixtureSchedule = turns.map((turn) => ({
    agentId: turn.agentId,
    targetTick: turn.targetTick,
    turnId: turn.turnId,
    receiptStatus: receipts.find((receipt) => receipt.turnId === turn.turnId)!.status,
  }));
  const fixtureHermesEvidenceSchedule = turns.map((turn) => ({
    agentId: turn.agentId,
    targetTick: turn.targetTick,
    turnId: turn.turnId,
    hermesRunId: `hermes-${turn.turnId}`,
    status: "completed" as const,
    inputTokens: 100,
    outputTokens: 20,
    toolCalls: 1,
    budgetViolationCount: 0,
  }));
  const authoritativeEvents = agentLabConfig.opportunityFixture!.ticks
    .flatMap((targetTick) =>
      cohortAgentIds.map((agentId) => ({ targetTick, agentId }))
    )
    .map(({ targetTick, agentId }, index) => {
      const eventDigest = sha256Hex(
        `authoritative:${mode}:${targetTick}:${agentId}`,
      );
      const opportunityKey =
        `${AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX}` +
        `${agentId}:goal_${eventDigest.slice(0, 8)}:${targetTick}`;
      return eventEnvelopeSchema.parse({
        eventId: `evt_${eventDigest.slice(0, 24)}`,
        type: "agent.goal.commitment_recorded",
        schemaVersion: 1,
        simulationId: "sim_harness",
        runId: "run_harness",
        seq: index,
        tick: targetTick,
        simDate: `Y2026-M02-D${String((index % 28) + 1).padStart(2, "0")}`,
        wallTime: "2026-07-24T12:00:00.000Z",
        actor: { kind: "agent", id: agentId },
        correlationId: `decision-${eventDigest.slice(0, 24)}`,
        payload: {
          agentId,
          goalId: `goal_${eventDigest.slice(0, 8)}`,
          fixtureVersion: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
          actionType: "agent.reaffirm_goal",
          opportunityKey,
        },
      });
    });
  const authoritativeFixtureSchedule = authoritativeEvents.map((event) => {
    const payload = event.payload as {
      readonly agentId: string;
      readonly actionType: "agent.reaffirm_goal";
      readonly opportunityKey: string;
    };
    return {
      agentId: payload.agentId,
      targetTick: event.tick,
      eventId: event.eventId,
      actionType: payload.actionType,
      opportunityKey: payload.opportunityKey,
    };
  });
  const files: Record<string, unknown> = {
    "manifest.json": manifest(),
    "runtime.json": { agentLabConfig, hermesRuns },
    "agent-lab-turns.jsonl": turns.length === 0
      ? ""
      : `${turns.map((turn) => canonicalStringify(turn)).join("\n")}\n`,
    "agent-lab-submissions.jsonl": "",
    "agent-lab-receipts.jsonl": receipts.length === 0
      ? ""
      : `${receipts.map((receipt) => canonicalStringify(receipt)).join("\n")}\n`,
    "agent-lab-tool-calls.jsonl": toolCalls.length === 0
      ? ""
      : `${toolCalls.map((call) => canonicalStringify(call)).join("\n")}\n`,
    "events.jsonl":
      `${authoritativeEvents.map((event) => canonicalStringify(event)).join("\n")}\n`,
    "scorecard.json": {
      schemaVersion: 1,
      studyId: "harness-test",
      trialId,
      structural: [
        {
          metricId: "invariants_pass",
          value: 1,
          unit: "boolean",
          evidence: ["fixture"],
        },
        {
          metricId: "replay_divergences",
          value: 0,
          unit: "count",
          evidence: ["fixture"],
        },
        {
          metricId: "unauthorized_applied_actions",
          value: 0,
          unit: "count",
          evidence: ["fixture"],
        },
      ],
      behavioral: [],
      social: [],
      economic: [],
      operational: [{
        metricId: "budget_violations",
        value: 0,
        unit: "violations",
        evidence: ["runtime.json"],
      }],
    },
    "taint.json": { tainted: false, reasons: [] },
    "replay.json": {},
    "report.md": "# Test\n",
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(
      join(root, name),
      typeof value === "string" ? value : `${canonicalStringify(value)}\n`,
      "utf8",
    );
  }
  writeFileSync(join(root, "run.db.gz"), gzipSync(Buffer.from("sqlite-fixture")));
  const checksums = Object.fromEntries(
    [...Object.keys(files), "run.db.gz"].map((name) => [name, hash(join(root, name))]),
  );
  const artifact = trialArtifactSchema.parse({
    schemaVersion: 1,
    studyId: "harness-test",
    trialId,
    mode,
    seed: 11,
    attempt: 1,
    manifestDigest: experimentManifestDigest(
      validateExperimentManifest(manifest()),
    ),
    runtime: {
      engineCommit: "abcdef0",
      nodeVersion: process.version,
      platform: process.platform,
      startedWall: "2026-07-24T12:00:00.000Z",
      completedWall: "2026-07-24T12:01:00.000Z",
    },
    files: checksums,
    hashHeads: {
      eventLog: "1".repeat(64),
      state: "2".repeat(64),
      cache: "3".repeat(64),
      prompt: agentLabPromptDigest(),
      artifact: sha256Hex(canonicalStringify(checksums)),
    },
    statistics: {
      turns: turns.length,
      terminalReceipts: receipts.length,
      fixtureTurns: fixtureSchedule.length,
      fixtureTerminalReceipts: fixtureSchedule.length,
      cohortAgentIds,
      fixtureSchedule,
      authoritativeFixtureSchedule,
      fixtureHermesEvidenceSchedule,
      validSubmissions: receipts.length,
      rejectedSubmissions: 0,
      fallbacks: 0,
      toolCalls: toolCalls.length,
      inputTokens: hermesRuns.reduce((sum, run) => sum + run.inputTokens, 0),
      outputTokens: hermesRuns.reduce((sum, run) => sum + run.outputTokens, 0),
      costMicrocents: "0",
      latencyMs: 0,
    },
    taint: { tainted: false, reasons: [] },
  });
  writeFileSync(join(root, "artifact.json"), `${canonicalStringify(artifact)}\n`, "utf8");
  return root;
}

describe("Agent Lab harness", () => {
  it("does not signal a Hermes process that already exited by signal", async () => {
    const kill = vi.fn();
    const child = {
      exitCode: null,
      signalCode: "SIGTERM",
      stdin: null,
      stdout: null,
      stderr: null,
      kill,
    } as unknown as ChildProcess;

    await terminateHermesProcess(child);

    expect(kill).not.toHaveBeenCalled();
  });

  it("waits for retained Hermes stdio after the process exits", async () => {
    let closeListener: (() => void) | undefined;
    const stderr = {
      destroyed: false,
      closed: false,
    };
    const child = {
      exitCode: null,
      signalCode: "SIGTERM",
      stdin: null,
      stdout: null,
      stderr,
      kill: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "close") closeListener = listener;
      }),
    } as unknown as ChildProcess;

    let settled = false;
    const termination = terminateHermesProcess(child).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stderr.destroyed = true;
    stderr.closed = true;
    closeListener?.();
    await termination;

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not escalate after Hermes exits from the requested signal", async () => {
    let closeListener: (() => void) | undefined;
    const state: { signalCode: NodeJS.Signals | null } = { signalCode: null };
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") {
        state.signalCode = "SIGTERM";
        queueMicrotask(() => closeListener?.());
      }
      return true;
    });
    const once = vi.fn((
      event: string,
      listener: () => void,
    ) => {
      if (event === "close") closeListener = listener;
    });
    const child = {
      get exitCode() {
        return null;
      },
      get signalCode() {
        return state.signalCode;
      },
      kill,
      once,
    } as unknown as ChildProcess;

    await terminateHermesProcess(child);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for Hermes to exit after escalating to SIGKILL", async () => {
    vi.useFakeTimers();
    let closeListener: (() => void) | undefined;
    const state: { signalCode: NodeJS.Signals | null } = { signalCode: null };
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        state.signalCode = "SIGKILL";
        queueMicrotask(() => closeListener?.());
      }
      return true;
    });
    const child = {
      get exitCode() {
        return null;
      },
      get signalCode() {
        return state.signalCode;
      },
      kill,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "close") closeListener = listener;
      }),
    } as unknown as ChildProcess;

    const termination = terminateHermesProcess(child);
    await vi.advanceTimersByTimeAsync(3_000);
    await termination;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("treats a Hermes child error as a terminal process outcome", async () => {
    let errorListener: ((error: Error) => void) | undefined;
    const kill = vi.fn(() => {
      queueMicrotask(() => errorListener?.(new Error("spawn failed")));
      return true;
    });
    const child = {
      exitCode: null,
      signalCode: null,
      kill,
      once: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListener = listener;
      }),
    } as unknown as ChildProcess;

    await expect(terminateHermesProcess(child)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("attempts every trial cleanup step and returns all failures", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("profile cleanup failed");
    const secondFailure = new Error("runtime cleanup failed");

    const errors = await collectTrialCleanupErrors([
      () => {
        calls.push("fleet");
        throw firstFailure;
      },
      async () => {
        calls.push("app");
      },
      () => {
        calls.push("runtime");
        throw secondFailure;
      },
    ]);

    expect(calls).toEqual(["fleet", "app", "runtime"]);
    expect(errors).toEqual([firstFailure, secondFailure]);
  });

  it("reports bounded nested cleanup failures without duplicate headlines", () => {
    const error = new AggregateError(
      [
        new Error("profile cleanup failed"),
        new Error("profile cleanup failed"),
        new AggregateError(
          [new Error("runtime cleanup failed")],
          "nested cleanup failed",
        ),
      ],
      "Agent Lab trial failed and cleanup was incomplete",
    );

    expect(formatCliError(error)).toBe([
      "Agent Lab trial failed and cleanup was incomplete",
      "caused by: profile cleanup failed",
      "caused by: nested cleanup failed",
      "caused by: runtime cleanup failed",
    ].join("\n"));
  });

  it("does not replace redaction markers with short secret fragments", () => {
    expect(redactSecrets(
      "[REDACTED] RE long-secret-value wtpat_x",
      ["RE", "long-secret-value"],
    )).toBe("[REDACTED] RE [REDACTED] [REDACTED]");
  });

  it("redacts rejected Hermes credentials from keys and free-form values", () => {
    const providerSecret = "minimax-provider-secret-00000001";
    const sessionSecret = "hermes-session-secret-00000001";
    const sanitized = sanitizedRejectedHermesValue({
      sessionKey: sessionSecret,
      message:
        `authorization failed for Bearer bearer-secret-00000001 and ${providerSecret}`,
      nested: {
        xHermesSessionKey: sessionSecret,
        harmless: providerSecret,
      },
    }, [providerSecret]);
    const serialized = canonicalStringify(sanitized);

    expect(serialized).not.toContain(providerSecret);
    expect(serialized).not.toContain(sessionSecret);
    expect(serialized).not.toContain("bearer-secret-00000001");
    expect(serialized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("redacts credentials from rejected Hermes errors and anomaly details", () => {
    const providerSecret = "minimax-value-00000001";
    const anomalies: string[] = [];
    const evidence = parseHermesRunsForArtifact([{
      runId: "hermes-run-one",
      agentId: "agt_00000001",
      targetTick: 10,
      status: "completed",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 15,
      budgetViolations: [],
      [providerSecret]: "unrecognized field",
    }], anomalies, [providerSecret]);
    const serialized = canonicalStringify({ evidence, anomalies });

    expect(evidence.accepted).toHaveLength(0);
    expect(evidence.rejected).toHaveLength(1);
    expect(serialized).not.toContain(providerSecret);
    expect(evidence.rejected[0]?.error).toContain("[REDACTED]");
    expect(anomalies[0]).toContain("[REDACTED]");
  });

  it("keeps expected and observed fixture matrix ordering aligned", () => {
    const schedule = [
      { targetTick: 10, agentId: "agt_00000001" },
      { targetTick: 10, agentId: "agt_00000002" },
      { targetTick: 30, agentId: "agt_00000001" },
      { targetTick: 30, agentId: "agt_00000002" },
    ] as const;

    expect(observedFixtureMatrixKeys(schedule)).toEqual(
      expectedFixtureMatrixKeys(
        [30, 10],
        ["agt_00000002", "agt_00000001"],
      ),
    );
    expect(() => observedFixtureMatrixKeys([...schedule].reverse())).toThrow(
      "fixture schedule is not canonically ordered",
    );
  });

  it("generates a Hermes API profile with no native or general-purpose toolsets", () => {
    const parsed = validateExperimentManifest(manifest());
    const config = profileConfig(
      parsed,
      "http://127.0.0.1:4000",
    );
    expect(config).toContain("platform_toolsets:\n  api_server: []");
    expect(config).toContain("toolsets: []");
    expect(config).toContain("  max_tokens: 1000");
    expect(config).toContain("    - terminal");
    expect(config).toContain("    - browser");
    expect(config).toContain("    - delegation");
    expect(config).toContain("  worldtangle:");
    expect(config).toContain("        - wt_action_submit");
    expect(config).not.toContain("mcp-worldtangle");
    const environment = buildHermesProfileEnvironment(
      parsed,
      "C:\\isolated-profile",
      {
        PATH: "C:\\bin",
        MINIMAX_API_KEY: "test-provider-key",
        UNRELATED_PARENT_SECRET: "must-not-cross",
      },
    );
    expect(environment["MINIMAX_API_KEY"]).toBe("test-provider-key");
    expect(environment).not.toHaveProperty("UNRELATED_PARENT_SECRET");
    expect(environment["HERMES_HOME"]).toBe("C:\\isolated-profile");
  });

  it("reserves whole-run Hermes budget before concurrent network calls", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          runCostCentsMax: "2",
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
      ["agt_00000002", harnessEndpoint("two")],
    ]);
    let runNumber = 0;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        runNumber += 1;
        return new Response(JSON.stringify({ run_id: `hermes-${runNumber}` }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 0, output_tokens: 0 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const first = driver.runTurn(harnessTurn("agt_00000001", "1"));
    const concurrent = driver.runTurn(harnessTurn("agt_00000002", "2"));

    await expect(concurrent).rejects.toBeInstanceOf(HermesBudgetExceededError);
    await expect(first).resolves.toMatchObject({
      status: "completed",
      budgetViolations: [],
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      init?.method === "POST" && String(input).endsWith("/v1/runs")
    ))).toHaveLength(1);
    await expect(
      driver.runTurn(harnessTurn("agt_00000002", "3")),
    ).resolves.toMatchObject({
      status: "completed",
      budgetViolations: [],
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      init?.method === "POST" && String(input).endsWith("/v1/runs")
    ))).toHaveLength(2);
  });

  it("reserves shadow-turn budget in credential order despite read latency", async () => {
    const credentials = [
      {
        agentId: "agt_00000001",
        token: "trial-token-one",
        credentialId: "cred_00000001",
      },
      {
        agentId: "agt_00000002",
        token: "trial-token-two",
        credentialId: "cred_00000002",
      },
    ] as const;
    const readsByToken = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const token = new Headers(init?.headers).get("authorization") ?? "";
      const readNumber = (readsByToken.get(token) ?? 0) + 1;
      readsByToken.set(token, readNumber);
      if (readNumber > 1) {
        return new Response(JSON.stringify({ turn: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (token === "Bearer trial-token-one") {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      const agentId = token === "Bearer trial-token-one"
        ? credentials[0].agentId
        : credentials[1].agentId;
      return new Response(JSON.stringify({
        turn: harnessTurn(agentId, agentId === credentials[0].agentId ? "1" : "2"),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const reservationOrder: string[] = [];
    const budgetReason = "pinned turn maximum exceeds the remaining run budget";
    const runTurn = vi.fn((turn: AgentTurnEnvelope): Promise<HermesTurnStats> => {
      reservationOrder.push(turn.agentId);
      if (reservationOrder.length > 1) {
        return Promise.reject(new HermesBudgetExceededError(turn, budgetReason));
      }
      return Promise.resolve(Object.freeze({
        runId: `hermes:${turn.turnId}`,
        agentId: turn.agentId,
        targetTick: turn.targetTick,
        status: "completed" as const,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        budgetViolations: [],
      }));
    });
    const hermesRuns: HermesTurnStats[] = [];

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials,
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds: new Set<string>(),
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential: vi.fn(),
    });

    expect(reservationOrder).toEqual([
      credentials[0].agentId,
      credentials[1].agentId,
    ]);
    expect(hermesRuns).toMatchObject([
      {
        agentId: credentials[0].agentId,
        status: "completed",
      },
      {
        agentId: credentials[1].agentId,
        status: "cancelled",
        budgetViolations: [budgetReason],
      },
    ]);
  });

  it("fails closed when a shadow credential receives another agent's turn", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    const misroutedTurn = harnessTurn("agt_00000002", "1");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn: misroutedTurn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const runTurn = vi.fn();
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(hermesRuns).toMatchObject([{
      agentId: credential.agentId,
      targetTick: 10,
      status: "failed",
      failure: expect.stringMatching(
        /turn .* for agt_00000002 was served to credential agt_00000001/,
      ),
    }]);
    expect(disabledAgentIds).toEqual(new Set([credential.agentId]));
    expect(revokeCredential).toHaveBeenCalledWith(credential);
  });

  it("fails closed when a shadow turn targets a different tick", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    const wrongTickTurn = {
      ...harnessTurn(credential.agentId, "1"),
      completedTick: 10,
      targetTick: 11,
    };
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn: wrongTickTurn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const runTurn = vi.fn();
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(hermesRuns).toMatchObject([{
      agentId: credential.agentId,
      targetTick: 10,
      status: "failed",
      failure: expect.stringMatching(
        /targets tick 11; the harness is driving tick 10/,
      ),
    }]);
    expect(disabledAgentIds).toEqual(new Set([credential.agentId]));
    expect(revokeCredential).toHaveBeenCalledWith(credential);
  });

  it("defers external credential revocation until the tick advance settles", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    const turn = harnessTurn(credential.agentId, "1");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    let resolveAdvance:
      ((response: { readonly status: number; readonly body: unknown }) => void) |
      undefined;
    const advance = new Promise<{
      readonly status: number;
      readonly body: unknown;
    }>((resolve) => {
      resolveAdvance = resolve;
    });
    const runTurn = vi.fn(async () => {
      throw new Error("Hermes provider failed");
    });
    const revokeCredential = vi.fn();
    const driven = driveExternalAdvance(
      advance,
      "http://127.0.0.1:4000",
      [credential],
      { runTurn },
      [],
      new Set<string>(),
      new Set<string>(),
      revokeCredential,
    );

    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
    expect(revokeCredential).not.toHaveBeenCalled();
    if (resolveAdvance === undefined) throw new Error("advance resolver was not installed");
    resolveAdvance({ status: 200, body: { currentTick: 10 } });

    await expect(driven).resolves.toEqual({
      status: 200,
      body: { currentTick: 10 },
    });
    expect(revokeCredential).toHaveBeenCalledOnce();
    expect(revokeCredential).toHaveBeenCalledWith(credential);
  });

  it("revokes deferred external credentials when the tick advance rejects", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    const turn = harnessTurn(credential.agentId, "1");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    let rejectAdvance: ((error: Error) => void) | undefined;
    const advance = new Promise<{
      readonly status: number;
      readonly body: unknown;
    }>((_resolve, reject) => {
      rejectAdvance = reject;
    });
    const runTurn = vi.fn(async () => {
      throw new Error("Hermes provider failed");
    });
    const revokeCredential = vi.fn();
    const driven = driveExternalAdvance(
      advance,
      "http://127.0.0.1:4000",
      [credential],
      { runTurn },
      [],
      new Set<string>(),
      new Set<string>(),
      revokeCredential,
    );

    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
    expect(revokeCredential).not.toHaveBeenCalled();
    if (rejectAdvance === undefined) throw new Error("advance rejector was not installed");
    rejectAdvance(new Error("advance failed"));

    await expect(driven).rejects.toThrow("advance failed");
    expect(revokeCredential).toHaveBeenCalledOnce();
    expect(revokeCredential).toHaveBeenCalledWith(credential);
  });

  it("refuses to re-drive an accounted Hermes turn before provider use", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          runCostCentsMax: "2",
          perAgentDailyTokens: 9_100,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let runNumber = 0;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).endsWith("/v1/runs") && init?.method === "POST") {
        runNumber += 1;
        return new Response(JSON.stringify({ run_id: `hermes-retry-${runNumber}` }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 0 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);
    const retriedTurn = harnessTurn("agt_00000001", "1");

    await expect(driver.runTurn(retriedTurn)).resolves.toMatchObject({
      status: "completed",
      budgetViolations: [],
    });
    await expect(driver.runTurn(retriedTurn)).rejects.toThrow(
      `Hermes turn ${retriedTurn.turnId} is already accounted; refusing to re-drive it`,
    );
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      init?.method === "POST" && String(input).endsWith("/v1/runs")
    ))).toHaveLength(1);
    await expect(
      driver.runTurn(harnessTurn("agt_00000001", "2")),
    ).resolves.toMatchObject({
      status: "completed",
      budgetViolations: [],
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      init?.method === "POST" && String(input).endsWith("/v1/runs")
    ))).toHaveLength(2);
  });

  it("fails closed when a shadow credential yields fresh turns forever", async () => {
    const definition = manifest();
    const generationBudget = {
      ...definition.generationBudget,
      maxToolCalls: 2,
    };
    const parsed = validateExperimentManifest({
      ...definition,
      generationBudget,
      driverPolicyDigest: agentLabDriverPolicyDigest(generationBudget),
    });
    const circuitBreakerLimit = shadowTurnCircuitBreakerLimit(parsed);
    expect(circuitBreakerLimit).toBe(32);
    expect(agentLabDriverPolicy(generationBudget)).toMatchObject({
      policyVersion: "stable_driver_v2",
      maxToolCalls: 2,
      maxShadowTurnsPerCredentialPerTick: 32,
    });
    let turnNumber = 0;
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
      turnNumber += 1;
      const discriminator = turnNumber.toString(36);
      return new Response(JSON.stringify({
        turn: harnessTurn("agt_00000001", discriminator),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const runTurn = vi.fn(async (turn: AgentTurnEnvelope) => Object.freeze({
      runId: `hermes:${turn.turnId}`,
      agentId: turn.agentId,
      targetTick: turn.targetTick,
      status: "completed" as const,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      budgetViolations: [],
    }));
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;

    await expect(driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 2,
      revokeCredential,
    })).resolves.toBeUndefined();

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(hermesRuns).toHaveLength(3);
    expect(hermesRuns[2]).toMatchObject({
      agentId: "agt_00000001",
      targetTick: 10,
      status: "failed",
      failure: expect.stringMatching(/2-turn circuit breaker/),
    });
    expect(disabledAgentIds).toContain("agt_00000001");
    expect(revokeCredential).toHaveBeenCalledOnce();

    await expect(driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 11,
      maximumTurnsPerCredential: 2,
      revokeCredential,
    })).resolves.toBeUndefined();
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(hermesRuns).toHaveLength(3);
    expect(revokeCredential).toHaveBeenCalledOnce();
  });

  it("revokes a shadow credential whose completed turn violates a budget", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({
        turn: harnessTurn(credential.agentId, "1"),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const budgetViolation = "run cost exceeded the manifested limit";
    const completedWithViolation = Object.freeze({
      runId: "hermes-budget-violation",
      agentId: credential.agentId,
      targetTick: 10,
      status: "completed" as const,
      inputTokens: 100,
      outputTokens: 10,
      latencyMs: 1,
      budgetViolations: [budgetViolation],
    });
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn: vi.fn(async () => completedWithViolation) },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(hermesRuns).toEqual([completedWithViolation]);
    expect(disabledAgentIds).toEqual(new Set([credential.agentId]));
    expect(revokeCredential).toHaveBeenCalledOnce();
    expect(revokeCredential).toHaveBeenCalledWith(credential);
  });

  it("preserves shadow turn stats when credential revocation throws", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({
        turn: harnessTurn(credential.agentId, "1"),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const completedWithViolation = Object.freeze({
      runId: "hermes-budget-violation",
      agentId: credential.agentId,
      targetTick: 10,
      status: "completed" as const,
      inputTokens: 100,
      outputTokens: 10,
      latencyMs: 1,
      budgetViolations: ["run cost exceeded the manifested limit"],
    });
    const revokeFailure = new Error("credential revocation failed");
    const hermesRuns: HermesTurnStats[] = [];

    await expect(driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: { runTurn: vi.fn(async () => completedWithViolation) },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds: new Set<string>(),
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential: vi.fn(() => {
        throw revokeFailure;
      }),
    })).resolves.toBeUndefined();

    expect(hermesRuns).toEqual([
      completedWithViolation,
      expect.objectContaining({
        agentId: credential.agentId,
        targetTick: 10,
        status: "failed",
        failure: revokeFailure.message,
      }),
    ]);
  });

  it("preserves Hermes budget-block stats when a shadow turn throws", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token",
      credentialId: "cred_00000001",
    } as const;
    const turn = harnessTurn(credential.agentId, "1");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const budgetReason = "pinned turn maximum exceeds the remaining run budget";
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: {
        runTurn: vi.fn(async () => {
          throw new HermesBudgetExceededError(turn, budgetReason);
        }),
      },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(hermesRuns).toEqual([{
      runId: `budget:${turn.turnId}`,
      turnId: turn.turnId,
      opportunityKey: turn.opportunityKey,
      agentId: turn.agentId,
      targetTick: turn.targetTick,
      status: "cancelled",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      budgetViolations: [budgetReason],
    }]);
    expect(hermesRuns[0]).not.toHaveProperty("failure");
    expect(disabledAgentIds).toEqual(new Set([credential.agentId]));
    expect(revokeCredential).toHaveBeenCalledOnce();
  });

  it("redacts credential tokens from unexpected shadow driver failures", async () => {
    const credential = {
      agentId: "agt_00000001",
      token: "trial-token-canary",
      credentialId: "cred_00000001",
    } as const;
    const turn = harnessTurn(credential.agentId, "1");
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(JSON.stringify({ turn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )));
    const hermesRuns: HermesTurnStats[] = [];

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials: [credential],
      driver: {
        runTurn: vi.fn(() => {
          throw new Error(`unexpected gateway failure for ${credential.token}`);
        }),
      },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds: new Set<string>(),
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential: vi.fn(),
    });

    expect(hermesRuns).toMatchObject([{
      agentId: credential.agentId,
      targetTick: 10,
      status: "failed",
      failure: "unexpected gateway failure for [REDACTED]",
    }]);
    expect(JSON.stringify(hermesRuns)).not.toContain(credential.token);
  });

  it("drains shadow peers and preserves ordered stats when one credential fails", async () => {
    const peerFailure = new Error("first credential read failed");
    const credentials = [
      {
        agentId: "agt_00000001",
        token: "trial-token-one",
        credentialId: "cred_00000001",
      },
      {
        agentId: "agt_00000002",
        token: "trial-token-two",
        credentialId: "cred_00000002",
      },
    ] as const;
    const readsByToken = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const token = new Headers(init?.headers).get("authorization") ?? "";
      const readNumber = (readsByToken.get(token) ?? 0) + 1;
      readsByToken.set(token, readNumber);
      if (token === "Bearer trial-token-one" && readNumber === 2) {
        throw peerFailure;
      }
      const turn = token === "Bearer trial-token-one"
        ? harnessTurn("agt_00000001", "1")
        : readNumber <= 2
          ? harnessTurn("agt_00000002", readNumber === 1 ? "2" : "3")
          : null;
      return new Response(JSON.stringify({ turn }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const runTurn = vi.fn(async (turn: AgentTurnEnvelope) => Object.freeze({
      runId: `hermes:${turn.turnId}`,
      agentId: turn.agentId,
      targetTick: turn.targetTick,
      status: "completed" as const,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      budgetViolations: [],
    }));
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials,
      driver: { runTurn },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(hermesRuns.map((run) => run.agentId)).toEqual([
      "agt_00000001",
      "agt_00000001",
      "agt_00000002",
      "agt_00000002",
    ]);
    expect(hermesRuns[1]).toMatchObject({
      status: "failed",
      failure: peerFailure.message,
    });
    expect(disabledAgentIds).toEqual(new Set(["agt_00000001"]));
    expect(revokeCredential).toHaveBeenCalledOnce();
    expect(revokeCredential).toHaveBeenCalledWith(credentials[0]);
  });

  it("preserves every shadow peer failure in credential order", async () => {
    const firstFailure = new Error(
      "first credential read failed for trial-token-one",
    );
    const secondFailure = new Error(
      "second credential read failed for trial-token-two",
    );
    const credentials = [
      {
        agentId: "agt_00000001",
        token: "trial-token-one",
        credentialId: "cred_00000001",
      },
      {
        agentId: "agt_00000002",
        token: "trial-token-two",
        credentialId: "cred_00000002",
      },
    ] as const;
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const token = new Headers(init?.headers).get("authorization") ?? "";
      throw token === "Bearer trial-token-one" ? firstFailure : secondFailure;
    }));
    const hermesRuns: HermesTurnStats[] = [];
    const disabledAgentIds = new Set<string>();
    const revokeCredential = vi.fn();

    await driveShadowTurns({
      baseUrl: "http://127.0.0.1:4000",
      credentials,
      driver: {
        runTurn: vi.fn(async () => {
          throw new Error("no turn should be available");
        }),
      },
      hermesRuns,
      drivenTurnIds: new Set<string>(),
      disabledAgentIds,
      targetTick: 10,
      maximumTurnsPerCredential: 10,
      revokeCredential,
    });

    expect(hermesRuns).toMatchObject([
      {
        agentId: "agt_00000001",
        targetTick: 10,
        status: "failed",
        failure: "first credential read failed for [REDACTED]",
      },
      {
        agentId: "agt_00000002",
        targetTick: 10,
        status: "failed",
        failure: "second credential read failed for [REDACTED]",
      },
    ]);
    expect(JSON.stringify(hermesRuns)).not.toContain("trial-token-");
    expect(disabledAgentIds).toEqual(new Set([
      "agt_00000001",
      "agt_00000002",
    ]));
    expect(revokeCredential.mock.calls).toEqual([
      [credentials[0]],
      [credentials[1]],
    ]);
  });

  it("releases a Hermes budget reservation after a network failure", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          runCostCentsMax: "3",
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
      ["agt_00000002", harnessEndpoint("two")],
    ]);
    let postCount = 0;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) throw new Error("Hermes gateway unavailable");
        return new Response(JSON.stringify({ run_id: "hermes-retry" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 0, output_tokens: 0 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    if (!(failure instanceof HermesTurnExecutionError)) {
      throw new Error("expected a Hermes execution error");
    }
    expect(failure.asStats()).toMatchObject({
      status: "failed",
      inputTokens: budget.maxInputTokens,
      outputTokens: budget.maxOutputTokens,
      failure: "Hermes gateway unavailable",
    });
    await expect(
      driver.runTurn(harnessTurn("agt_00000001", "2")),
    ).resolves.toMatchObject({ status: "completed" });
    expect(postCount).toBe(2);
  });

  it("preserves the original Hermes failure when accounting also fails", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
      (
        parsed.provider.settings as {
          inputMicrocentsPerToken: number;
        }
      ).inputMicrocentsPerToken = -1;
      throw new Error("original Hermes gateway failure");
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats()).toMatchObject({
      status: "failed",
      failure:
        "original Hermes gateway failure; accounting failed: " +
        "manifest inputMicrocentsPerToken must be a non-negative safe integer",
      budgetViolations: [],
    });
  });

  it("does not retry a terminal Hermes result when accounting fails", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "terminal-accounting" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      statusCalls += 1;
      (
        parsed.provider.settings as {
          inputMicrocentsPerToken: number;
        }
      ).inputMicrocentsPerToken = -1;
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect(statusCalls).toBe(1);
    expect((failure as HermesTurnExecutionError).asStats()).toMatchObject({
      status: "failed",
      failure: expect.stringContaining(
        "manifest inputMicrocentsPerToken must be a non-negative safe integer",
      ),
      budgetViolations: [],
    });
  });

  it("rejects oversized successful Hermes response bodies", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const fetchMock = vi.fn(async (): Promise<Response> => (
      new Response("x".repeat(1_100_000), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((failure as HermesTurnExecutionError).asStats()).toMatchObject({
      status: "failed",
      failure: "Hermes start response body exceeds 1048576 bytes",
    });
  });

  it.each([
    { name: "null", body: "null" },
    { name: "malformed JSON", body: "not-json" },
  ])("terminates an accepted profile whose run ID is $name", async ({ body }) => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const terminateProfile = vi.fn(async () => {});
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", {
        ...harnessEndpoint("one"),
        terminateProfile,
      }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(body, {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    )));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toBe(
      "Hermes profile profile-one returned no run_id; isolated profile terminated",
    );
    expect(terminateProfile).toHaveBeenCalledOnce();
    await expect(
      driver.runTurn(harnessTurn("agt_00000001", "2")),
    ).rejects.toThrow("no isolated Hermes profile exists for agt_00000001");
  });

  it("discards and cancels an untrusted Hermes error response body", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const cancelBody = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => (
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `provider echoed ${harnessEndpoint("one").apiKey}`,
          ));
        },
        cancel: cancelBody,
      }), {
        status: 503,
        headers: { "content-type": "text/plain" },
      })
    )));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toBe(
      "Hermes profile profile-one rejected the turn with HTTP 503",
    );
    expect(JSON.stringify((failure as HermesTurnExecutionError).asStats()))
      .not.toContain(harnessEndpoint("one").apiKey);
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("bounds Hermes failure details stored in trial artifacts", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const providerEnvironmentSecret = "provider-env-key-canary";
    vi.stubEnv("MINIMAX_API_KEY", providerEnvironmentSecret);
    const providerFailure =
      "provider failure for api-key-one, session-key-one, and " +
      `${providerEnvironmentSecret}: ${"x".repeat(2_000)}`;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(providerFailure);
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    const stats = (failure as HermesTurnExecutionError).asStats();
    expect(stats.failure).toContain(
      "provider failure for [REDACTED], [REDACTED], and [REDACTED]",
    );
    expect(stats.failure?.length).toBeLessThanOrEqual(1_000);
    const serialized = JSON.stringify(stats);
    for (const secret of [
      "api-key-one",
      "session-key-one",
      providerEnvironmentSecret,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves a failed Hermes terminal status error with valid usage", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([[
      "agt_00000001",
      harnessEndpoint("one"),
    ]]);
    const providerEnvironmentSecret = "terminal-provider-key-canary";
    vi.stubEnv("MINIMAX_API_KEY", providerEnvironmentSecret);
    const providerFailure =
      `provider exploded for ${providerEnvironmentSecret}: ${"x".repeat(1_100)}`;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "hermes-terminal-failure" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "failed",
        error: providerFailure,
        usage: { input_tokens: 123, output_tokens: 45 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const result = await driver.runTurn(harnessTurn("agt_00000001", "1"));
    expect(result).toMatchObject({
      status: "failed",
      inputTokens: 123,
      outputTokens: 45,
      failure: expect.stringContaining("provider exploded for [REDACTED]"),
    });
    expect(JSON.stringify(result)).not.toContain(providerEnvironmentSecret);
  });

  it("preserves provider failure context when Hermes usage is invalid", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([[
      "agt_00000001",
      harnessEndpoint("one"),
    ]]);
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "hermes-invalid-usage" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        status: "failed",
        error: "provider exploded before usage accounting completed",
        usage: { input_tokens: -1, output_tokens: 45 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const result = await driver.runTurn(harnessTurn("agt_00000001", "1"));

    expect(result).toMatchObject({
      status: "failed",
      inputTokens: budget.maxInputTokens,
      outputTokens: budget.maxOutputTokens,
    });
    expect(result.failure).toContain("omitted valid usage");
    expect(result.failure).toContain(
      "provider exploded before usage accounting completed",
    );
    expect(result.failure?.length).toBeLessThanOrEqual(1_000);
  });

  it("retries transient Hermes poll failures within the decision deadline", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let statusAttempts = 0;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "hermes-transient-poll" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/stop")) {
        throw new Error("successful retry must not stop the Hermes run");
      }
      statusAttempts += 1;
      if (statusAttempts === 1) throw new Error("transient socket failure");
      if (statusAttempts === 2) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 123, output_tokens: 45 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    await expect(
      driver.runTurn(harnessTurn("agt_00000001", "1")),
    ).resolves.toMatchObject({
      status: "completed",
      inputTokens: 123,
      outputTokens: 45,
      budgetViolations: [],
    });
    expect(statusAttempts).toBe(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(
      false,
    );
  });

  it("abandons a Hermes run after the bounded transient poll retry limit", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let statusAttempts = 0;
    let stopAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "hermes-poll-exhausted" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/stop")) {
        stopAttempts += 1;
        return new Response(JSON.stringify({ status: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      statusAttempts += 1;
      return new Response("temporarily unavailable", { status: 503 });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toBe(
      "Hermes run hermes-poll-exhausted status failed with HTTP 503",
    );
    expect(statusAttempts).toBe(3);
    expect(stopAttempts).toBe(1);
  });

  it("reports a null Hermes status body without an internal TypeError", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let requestCount = 0;
    let stopRequested = false;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
    ): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ run_id: "hermes-null-status" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).endsWith("/stop")) {
        stopRequested = true;
        return new Response(JSON.stringify({ status: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toBe(
      "Hermes run hermes-null-status returned an unreadable status body",
    );
    expect(stopRequested).toBe(true);
    expect(requestCount).toBe(3);
  });

  it("preserves a status error when best-effort Hermes cancellation fails", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL,
    ): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ run_id: "hermes-abandon-failure" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).endsWith("/stop")) {
        throw new Error("Hermes stop endpoint unavailable");
      }
      return new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const driver = new HermesApiTurnDriver(endpoints, parsed);

    const failure = await driver.runTurn(harnessTurn("agt_00000001", "1"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toBe(
      "Hermes run hermes-abandon-failure returned an unreadable status body",
    );
    expect(requestCount).toBe(3);
  });

  it("rejects a malformed decision deadline before any Hermes request", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);
    const invalidTurn = {
      ...harnessTurn("agt_00000001", "1"),
      deadline: "not-a-date",
    } as AgentTurnEnvelope;

    const failure = await driver.runTurn(invalidTurn).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    expect((failure as HermesTurnExecutionError).asStats().failure).toMatch(
      /invalid decision deadline/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls a subsecond turn instead of consuming its deadline as cleanup reserve", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          runCostCentsMax: "2",
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const startedWall = Date.parse("2026-07-24T12:00:00.000Z");
    let clock = startedWall;
    let performanceClock = 1_000;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        performanceClock += 1;
        return new Response(JSON.stringify({ run_id: "hermes-subsecond" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      clock += 100;
      performanceClock += 1;
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 123, output_tokens: 45 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);
    const deadlineTurn = agentTurnEnvelopeSchema.parse({
      ...harnessTurn("agt_00000001", "1"),
      deadline: new Date(startedWall + 500).toISOString(),
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const performanceSpy = vi.spyOn(performance, "now")
      .mockImplementation(() => performanceClock);
    try {
      await expect(driver.runTurn(deadlineTurn)).resolves.toMatchObject({
        status: "completed",
        inputTokens: 123,
        outputTokens: 45,
        budgetViolations: [],
      });
    } finally {
      performanceSpy.mockRestore();
      nowSpy.mockRestore();
    }
    expect(fetchMock.mock.calls.some(([input, init]) => (
      init?.method !== "POST" && String(input).endsWith("/hermes-subsecond")
    ))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(false);
  });

  it("uses a bounded cleanup window after the decision deadline", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          runCostCentsMax: "2",
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const startedWall = Date.now();
    const decisionDeadline = startedWall + 5_000;
    let clock = startedWall;
    let performanceClock = 1_000;
    const fetchMock = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        clock = decisionDeadline + 1;
        performanceClock += 1;
        return new Response(JSON.stringify({ run_id: "hermes-expired-cleanup" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/stop") && init?.method === "POST") {
        performanceClock += 1;
        return new Response(JSON.stringify({ status: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected Hermes request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);
    const deadlineTurn = agentTurnEnvelopeSchema.parse({
      ...harnessTurn("agt_00000001", "1"),
      deadline: new Date(decisionDeadline).toISOString(),
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const performanceSpy = vi.spyOn(performance, "now")
      .mockImplementation(() => performanceClock);
    try {
      await expect(driver.runTurn(deadlineTurn)).resolves.toMatchObject({
        status: "cancelled",
        inputTokens: budget.maxInputTokens,
        outputTokens: budget.maxOutputTokens,
        failure: "Hermes deadline cleanup had no valid usage; charged pinned worst case",
      });
    } finally {
      performanceSpy.mockRestore();
      nowSpy.mockRestore();
    }
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      init?.method === "POST" && String(input).endsWith("/stop")
    ))).toHaveLength(1);
  });

  it("aborts a hanging Hermes request at the decision deadline", async () => {
    const definition = manifest();
    const parsed = validateExperimentManifest({
      ...definition,
      scenario: {
        ...definition.scenario,
        budgets: {
          ...definition.scenario.budgets,
          perAgentDailyTokens: 20_000,
        },
      },
    });
    const endpoints = new Map<string, HermesEndpoint>([
      ["agt_00000001", harnessEndpoint("one")],
    ]);
    const fetchMock = vi.fn((
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        return Promise.reject(new Error("missing request deadline signal"));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new Error("mock body aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        },
      });
      return Promise.resolve(new Response(body, {
        status: 202,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new HermesApiTurnDriver(endpoints, parsed);
    const startedWall = Date.now();
    const deadlineTurn = agentTurnEnvelopeSchema.parse({
      ...harnessTurn("agt_00000001", "1"),
      deadline: new Date(startedWall + 100).toISOString(),
    });
    let failure: unknown;
    vi.useFakeTimers();
    vi.setSystemTime(startedWall);
    try {
      const pending = driver.runTurn(deadlineTurn)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      failure = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(failure).toBeInstanceOf(HermesTurnExecutionError);
    if (!(failure instanceof HermesTurnExecutionError)) {
      throw new Error("expected a deadline-bound Hermes execution error");
    }
    expect(failure.asStats()).toMatchObject({
      status: "failed",
      inputTokens: budget.maxInputTokens,
      outputTokens: budget.maxOutputTokens,
      failure: "Hermes start request exceeded the decision deadline",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts pnpm's forwarded option separator", () => {
    expect(parseArguments([
      "run",
      "--",
      "--manifest",
      "study.json",
    ])).toEqual({
      command: "run",
      values: { manifest: "study.json" },
    });
  });

  it("creates a runnable pinned pilot manifest for the current checkout", () => {
    const created = createPilotManifest({
      studyId: "phase12-pilot",
      model: "provider/model",
      inputMicrocentsPerToken: 100,
      outputMicrocentsPerToken: 300,
      providerEnvAllowlist: "MINIMAX_API_KEY",
      createdWall: "2026-07-24T12:00:00.000Z",
    });
    expect(validateExperimentManifest(created)).toEqual(created);
    expect(planTrials(created)).toHaveLength(21);
    expect(created.scenario.opportunityFixture).toEqual({
      version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
      ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
    });
    expect(created.generationBudget).toMatchObject({
      maxAgentLoopIterations: 8,
      maxInputTokens: 64_000,
      maxOutputTokens: 8_000,
      maxToolCalls: 8,
    });
    const worstCaseTurnTokens =
      created.generationBudget.maxInputTokens +
      created.generationBudget.maxOutputTokens;
    const fixtureTurnsByTick = new Map<number, number>();
    for (const tick of created.scenario.opportunityFixture?.ticks ?? []) {
      fixtureTurnsByTick.set(tick, (fixtureTurnsByTick.get(tick) ?? 0) + 1);
    }
    const maximumFixtureTurnsPerAgentPerTick = Math.max(
      0,
      ...fixtureTurnsByTick.values(),
    );
    expect(created.scenario.budgets.perAgentDailyTokens).toBe(
      worstCaseTurnTokens * (
        maximumFixtureTurnsPerAgentPerTick +
        PILOT_EXPECTED_NON_FIXTURE_TURNS_PER_AGENT_PER_FIXTURE_TICK
      ),
    );
    expect(created.scenario.budgets.runCostCentsMax).toBe("423");
    const worstCaseTurnMicrocents =
      created.generationBudget.maxInputTokens * 100 +
      created.generationBudget.maxOutputTokens * 300;
    const pinnedTurns =
      (created.scenario.opportunityFixture?.ticks.length ?? 0) *
      created.cohort.size;
    const nonFixtureTurnHeadroom =
      fixtureTurnsByTick.size *
      created.cohort.size *
      PILOT_EXPECTED_NON_FIXTURE_TURNS_PER_AGENT_PER_FIXTURE_TICK;
    expect(
      BigInt(pinnedTurns + nonFixtureTurnHeadroom) *
        BigInt(worstCaseTurnMicrocents),
    ).toBeLessThanOrEqual(
      BigInt(created.scenario.budgets.runCostCentsMax) * 1_000_000n,
    );
    expect(created.cohort.size).toBeLessThanOrEqual(
      MAX_SHADOW_TURNS_PER_CREDENTIAL_PER_TICK,
    );
    expect(inspectHermesRuntimeMock).toHaveBeenCalledOnce();
    expect(created.engine.dependencies["node"]).toBe(process.version);
    expect(created.engine.dependencies["pnpm-lock-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins prompt, tools, driver policy, and the full 21-trial pilot matrix", () => {
    const parsed = validateExperimentManifest(manifest());
    expect(agentLabDriverPolicyDigest(budget)).toBe(
      "42f2fe435143577f41aa6d7a4e5120543cf16235f4a0c3d58df8eb7fecba439b",
    );
    expect(planTrials(parsed)).toHaveLength(21);
    expect(new Set(planTrials(parsed).map((plan) => plan.trialId)).size).toBe(21);
    expect(() => validateExperimentManifest({
      ...manifest(),
      prompt: { ...manifest().prompt, bytes: `${CITIZEN_TURN_PROMPT}\nchanged` },
    })).toThrow(/prompt bytes/);
    expect(() => validateExperimentManifest({
      ...manifest(),
      provider: {
        ...manifest().provider,
        settings: {
          ...manifest().provider.settings,
          apiKey: "must-never-enter-an-artifact",
        },
      },
    })).toThrow(/apiKey is not allowed/);
    expect(() => validateExperimentManifest({
      ...manifest(),
      scenario: {
        ...manifest().scenario,
        seeds: [11, 11, 33],
      },
    })).toThrow();
    expect(() => validateExperimentManifest({
      ...manifest(),
      interventions: [{
        id: "unsafe",
        tick: 1,
        type: "energy.fuel_price_shock",
        params: { apiKey: "api_must_not_cross_the_artifact_boundary" },
      }],
    })).toThrow(/forbidden credential field/);
  });

  it("migrates schema-v1 archives without inventing runtime pins", () => {
    const current = manifest();
    const legacyScenario = Object.fromEntries(
      Object.entries(current.scenario).filter(([key]) =>
        key !== "opportunityFixture"
      ),
    );
    const legacySettings = Object.fromEntries(
      Object.entries(current.provider.settings).filter(([key]) =>
        ![
          "hermesMcpSdkVersion",
          "hermesStarletteVersion",
          "hermesAiohttpVersion",
        ].includes(key)
      ),
    );
    const archivedInput = {
      ...current,
      schemaVersion: 1,
      scenario: legacyScenario,
      provider: {
        ...current.provider,
        settings: legacySettings,
      },
      driverPolicyDigest: agentLabLegacyDriverPolicyDigest(budget),
    };

    expect(() => validateExperimentManifest(archivedInput)).toThrow();
    const archived = validateArchivedExperimentManifest(archivedInput);

    expect(archived.sourceSchemaVersion).toBe(1);
    expect(archived.driverPolicyVersion).toBe("stable_driver_v1");
    expect(archived.manifest).toMatchObject({
      schemaVersion: 2,
      provider: {
        settings: {
          hermesMcpSdkVersion: "unavailable-in-schema-v1",
          hermesStarletteVersion: "unavailable-in-schema-v1",
          hermesAiohttpVersion: "unavailable-in-schema-v1",
        },
      },
    });
    expect(archived.manifest.scenario.opportunityFixture).toBeUndefined();
  });

  it("keeps v1 driver-policy archives verifiable but refuses live execution", async () => {
    expect(agentLabLegacyDriverPolicyDigest(budget)).toBe(
      "e7e543df7d3f0c66c26bc0b307238ae845f43aac33f296f25bf69b4efda5fa67",
    );
    expect(() => validateExperimentManifest({
      ...manifest(),
      driverPolicyDigest: agentLabLegacyDriverPolicyDigest(budget),
    })).toThrow(/current stable_driver_v2/);
    const legacyValidation = validateArchivedExperimentManifest({
      ...manifest(),
      driverPolicyDigest: agentLabLegacyDriverPolicyDigest(budget),
    });
    expect(legacyValidation.driverPolicyVersion).toBe("stable_driver_v1");
    const legacy = legacyValidation.manifest;
    expect(legacy.driverPolicyDigest).toBe(
      agentLabLegacyDriverPolicyDigest(legacy.generationBudget),
    );
    expect(validateArchivedExperimentManifest(manifest()).driverPolicyVersion).toBe(
      "stable_driver_v2",
    );
    const manifestRoot = mkdtempSync(
      join(tmpdir(), "worldtangle-harness-legacy-manifest-"),
    );
    roots.push(manifestRoot);
    const manifestPath = join(manifestRoot, "manifest.json");
    writeFileSync(
      manifestPath,
      `${canonicalStringify(legacy)}\n`,
      "utf8",
    );
    expect(() => loadExperimentManifest(manifestPath)).toThrow(
      /current stable_driver_v2/,
    );
    expect(loadExperimentManifest(manifestPath, {
      allowArchivedDriverPolicy: true,
    })).toEqual(legacy);
    const root = mkdtempSync(join(tmpdir(), "worldtangle-harness-legacy-policy-"));
    roots.push(root);

    await expect(runStudy(legacy, {
      studyDirectory: root,
      allowDirty: true,
    })).rejects.toThrow(
      /legacy driver manifests are verification and offline-replay only/,
    );
  });

  it("deduplicates expected fixture matrix coordinates symmetrically", () => {
    expect(expectedFixtureMatrixKeys(
      [10, 10],
      ["agt_00000001", "agt_00000001"],
    )).toEqual(expectedFixtureMatrixKeys(
      [10],
      ["agt_00000001"],
    ));
  });

  it("keeps native legacy counters readable but rejects missing non-native slots", () => {
    const root = validArtifactDirectory();
    const artifactPath = join(root, "artifact.json");
    const legacy = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      statistics: Record<string, unknown>;
    };
    delete legacy.statistics["fixtureTurns"];
    delete legacy.statistics["fixtureTerminalReceipts"];
    writeFileSync(
      artifactPath,
      `${canonicalStringify(legacy)}\n`,
      "utf8",
    );

    const parsed = trialArtifactSchema.parse(legacy);
    expect(parsed.statistics.fixtureTurns).toBe(0);
    expect(parsed.statistics.fixtureTerminalReceipts).toBe(0);
    expect(verifyTrialArtifact(root)).toMatchObject({ valid: true, issues: [] });

    const trials = releaseTrials();
    const shadowIndex = releaseTrialIndex(trials, "shadow", 11, 1);
    const shadow = trials[shadowIndex]!;
    const legacyShadow = JSON.parse(
      canonicalStringify(shadow.artifact),
    ) as { statistics: Record<string, unknown> };
    delete legacyShadow.statistics["fixtureTurns"];
    delete legacyShadow.statistics["fixtureTerminalReceipts"];
    delete legacyShadow.statistics["fixtureSchedule"];
    delete legacyShadow.statistics["fixtureHermesEvidenceSchedule"];
    const parsedLegacyShadow = trialArtifactSchema.safeParse(legacyShadow);
    expect(parsedLegacyShadow.success).toBe(false);
    if (!parsedLegacyShadow.success) {
      expect(
        parsedLegacyShadow.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("statistics.authoritativeFixtureSchedule");
    }
  });

  it("keeps pre-config schema-v1 artifacts readable but verification-ineligible", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const artifactPath = join(root, "artifact.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      agentLabConfig?: unknown;
    };
    delete runtime.agentLabConfig;
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      files: Record<string, string>;
      hashHeads: { artifact: string };
    };
    artifact.files["runtime.json"] = hash(runtimePath);
    artifact.hashHeads.artifact = sha256Hex(canonicalStringify(artifact.files));
    writeFileSync(artifactPath, `${canonicalStringify(artifact)}\n`, "utf8");

    expect(() => trialArtifactSchema.parse(artifact)).not.toThrow();
    const verification = verifyTrialArtifact(root);
    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain(
      "runtime evidence is missing agentLabConfig",
    );
    expect(verification.issues).toContain(
      "fixture matrix was not verified because runtime Agent Lab config is unavailable",
    );
  });

  it("reports an unverified fixture matrix for malformed runtime config", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      agentLabConfig: unknown;
      hermesRuns: unknown[];
    };
    runtime.agentLabConfig = null;
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    const verification = verifyTrialArtifact(root);

    expect(verification.valid).toBe(false);
    expect(verification.issues.some((issue) => (
      issue.startsWith("runtime Agent Lab config is invalid:")
    ))).toBe(true);
    expect(verification.issues).toContain(
      "fixture matrix was not verified because runtime Agent Lab config is unavailable",
    );
  });

  it("detects schema-valid drift from the pinned manifest digest", () => {
    const root = validArtifactDirectory();
    const manifestPath = join(root, "manifest.json");
    const persisted = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<
      typeof manifest
    >;
    persisted.scenario.name = "Altered harness scenario";
    writeFileSync(manifestPath, `${canonicalStringify(persisted)}\n`, "utf8");
    refreshArtifactFileHash(root, "manifest.json");

    expect(verifyTrialArtifact(root).issues).toContain("manifest digest drift");
  });

  it("reports a non-object runtime artifact explicitly", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    writeFileSync(runtimePath, "null\n", "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "runtime evidence is invalid: Error: runtime.json is not a JSON object",
    );
  });

  it("detects a manifest-allowlisted provider secret in runtime evidence", () => {
    const providerSecret = "minimax-provider-secret-00000001";
    vi.stubEnv("MINIMAX_API_KEY", providerSecret);
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<
      string,
      unknown
    >;
    runtime["providerDiagnostic"] = providerSecret;
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "credential-like material found: runtime.json",
    );
  });

  it("rejects runtime Agent Lab identity that differs from the artifact", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      agentLabConfig: RunManifestAgentLab;
      hermesRuns: unknown[];
    };
    runtime.agentLabConfig = {
      ...runtime.agentLabConfig,
      trialId: "harness-test-s11-native-a2",
    };
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "runtime Agent Lab config does not match artifact identity",
    );
  });

  it("rejects a runtime cohort whose size differs from the manifest", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      agentLabConfig: RunManifestAgentLab;
      hermesRuns: unknown[];
    };
    runtime.agentLabConfig = {
      ...runtime.agentLabConfig,
      resolvedAssignments: runtime.agentLabConfig.resolvedAssignments.slice(0, -1),
    };
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "runtime cohort has 7 citizens; manifest pins 8",
    );
  });

  it("rejects runtime fixture ticks that differ from the pinned manifest", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      agentLabConfig: RunManifestAgentLab;
      hermesRuns: unknown[];
    };
    runtime.agentLabConfig = {
      ...runtime.agentLabConfig,
      opportunityFixture: {
        version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
        ticks: [11, 30, 50],
      },
    };
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "runtime Agent Lab fixture does not match the pinned manifest",
    );
  });

  it("detects checksum corruption and unmanifested artifact files", () => {
    const root = validArtifactDirectory();
    expect(verifyTrialArtifact(root)).toMatchObject({ valid: true, issues: [] });
    writeFileSync(join(root, "report.md"), "# Altered\n", "utf8");
    writeFileSync(join(root, "manual.txt"), "human intervention", "utf8");
    const corrupted = verifyTrialArtifact(root);
    expect(corrupted.valid).toBe(false);
    expect(corrupted.issues).toContain("checksum mismatch: report.md");
    expect(corrupted.issues).toContain("unmanifested artifact file: manual.txt");
  });

  it("cross-checks scorecard budget violations against Hermes runtime evidence", () => {
    const root = validArtifactDirectory("shadow");
    const scorecardPath = join(root, "scorecard.json");
    const scorecard = JSON.parse(readFileSync(scorecardPath, "utf8")) as {
      operational: Array<{ metricId: string; value: number | null }>;
    };
    const metric = scorecard.operational.find(
      (candidate) => candidate.metricId === "budget_violations",
    );
    if (metric === undefined) throw new Error("fixture scorecard is missing budget evidence");
    metric.value = 1;
    writeFileSync(scorecardPath, `${canonicalStringify(scorecard)}\n`, "utf8");
    refreshArtifactFileHash(root, "scorecard.json");

    expect(verifyTrialArtifact(root).issues).toContain(
      "scorecard budget violation count does not match runtime Hermes evidence",
    );
  });

  it("cross-checks the artifact taint summary against taint evidence", () => {
    const root = validArtifactDirectory();
    const taintPath = join(root, "taint.json");
    writeFileSync(
      taintPath,
      `${canonicalStringify({
        tainted: true,
        reasons: [{
          code: "manual_input",
          detail: "test-only taint mismatch",
          recordedWall: "2026-07-24T12:01:00.000Z",
        }],
      })}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "taint.json");

    const verification = verifyTrialArtifact(root);
    expect(verification.issues).toContain(
      "artifact taint does not match taint evidence",
    );
    expect(verification.issues).toContain("trial is tainted: manual_input");
  });

  it("recomputes derived fixture statistics from authenticated evidence", () => {
    const root = validArtifactDirectory("shadow");
    const artifactPath = join(root, "artifact.json");
    const altered = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      statistics: {
        turns: number;
        terminalReceipts: number;
        fixtureTurns: number;
        fixtureTerminalReceipts: number;
        cohortAgentIds: string[];
        fixtureSchedule: Array<{
          agentId: string;
          targetTick: number;
          turnId: string;
          receiptStatus: AgentLabReceiptStatus | null;
        }>;
        authoritativeFixtureSchedule: unknown[];
        fixtureHermesEvidenceSchedule: unknown[];
      };
    };
    altered.statistics.turns = 1;
    altered.statistics.terminalReceipts = 1;
    altered.statistics.fixtureTurns = 1;
    altered.statistics.fixtureTerminalReceipts = 1;
    altered.statistics.fixtureSchedule =
      altered.statistics.fixtureSchedule.slice(0, 1);
    altered.statistics.authoritativeFixtureSchedule =
      altered.statistics.authoritativeFixtureSchedule.slice(0, 1);
    altered.statistics.fixtureHermesEvidenceSchedule =
      altered.statistics.fixtureHermesEvidenceSchedule.slice(0, 1);
    writeFileSync(
      artifactPath,
      `${canonicalStringify(altered)}\n`,
      "utf8",
    );

    const verification = verifyTrialArtifact(root);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain(
      "artifact fixture turn count does not match turn evidence",
    );
  });

  it("prefers a terminal fixture receipt even when a queued receipt is appended later", () => {
    const root = validArtifactDirectory("shadow");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const terminalReceipt = agentActionReceiptSchema.parse(
      JSON.parse(receiptRows[0]!),
    );
    const queuedReceipt = agentActionReceiptSchema.parse({
      ...terminalReceipt,
      receiptId: `rcpt_${"e".repeat(24)}`,
      status: "queued",
    });
    writeFileSync(
      receiptsPath,
      `${receiptRows.join("\n")}\n${canonicalStringify(queuedReceipt)}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-receipts.jsonl");

    expect(verifyTrialArtifact(root)).toMatchObject({
      valid: true,
      issues: [],
    });
  });

  it("records absence instead of inventing a queued status for a nonterminal turn", () => {
    const root = validArtifactDirectory("shadow");
    const artifactPath = join(root, "artifact.json");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const terminalReceipt = agentActionReceiptSchema.parse(
      JSON.parse(receiptRows[0]!),
    );
    const queuedReceipt = agentActionReceiptSchema.parse({
      ...terminalReceipt,
      status: "queued",
    });
    receiptRows[0] = canonicalStringify(queuedReceipt);
    writeFileSync(receiptsPath, `${receiptRows.join("\n")}\n`, "utf8");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      files: Record<string, string>;
      hashHeads: { artifact: string };
      statistics: {
        terminalReceipts: number;
        fixtureTerminalReceipts: number;
        validSubmissions: number;
        fixtureSchedule: Array<{
          turnId: string;
          receiptStatus: AgentLabReceiptStatus | null;
        }>;
      };
    };
    artifact.statistics.terminalReceipts -= 1;
    artifact.statistics.fixtureTerminalReceipts -= 1;
    artifact.statistics.validSubmissions -= 1;
    const scheduleEntry = artifact.statistics.fixtureSchedule.find(
      (entry) => entry.turnId === terminalReceipt.turnId,
    );
    if (scheduleEntry === undefined) {
      throw new Error("fixture artifact has no schedule entry for its first receipt");
    }
    scheduleEntry.receiptStatus = null;
    artifact.files["agent-lab-receipts.jsonl"] = hash(receiptsPath);
    artifact.hashHeads.artifact = sha256Hex(canonicalStringify(artifact.files));
    writeFileSync(artifactPath, `${canonicalStringify(artifact)}\n`, "utf8");

    const verification = verifyTrialArtifact(root);

    expect(verification.issues).toContain(
      `1 turn(s) have no terminal receipt: ${terminalReceipt.turnId}`,
    );
    expect(verification.issues).not.toContain(
      "artifact fixture schedule does not match turn and receipt evidence",
    );
  });

  it("selects conflicting terminal fixture evidence independently of row order", () => {
    const root = validArtifactDirectory("shadow");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const firstReceipt = agentActionReceiptSchema.parse(JSON.parse(receiptRows[0]!));
    const secondReceipt = agentActionReceiptSchema.parse(JSON.parse(receiptRows[1]!));
    const firstConflict = agentActionReceiptSchema.parse({
      ...firstReceipt,
      receiptId: `rcpt_${"d".repeat(24)}`,
      status: "applied",
    });
    const secondConflict = agentActionReceiptSchema.parse({
      ...secondReceipt,
      receiptId: `rcpt_${"e".repeat(24)}`,
      status: "applied",
    });
    const rowsWithConflict = [
      ...receiptRows,
      canonicalStringify(firstConflict),
      canonicalStringify(secondConflict),
    ];
    writeFileSync(receiptsPath, `${rowsWithConflict.join("\n")}\n`, "utf8");
    refreshArtifactFileHash(root, "agent-lab-receipts.jsonl");
    const forward = verifyTrialArtifact(root);

    writeFileSync(
      receiptsPath,
      `${[...rowsWithConflict].reverse().join("\n")}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-receipts.jsonl");
    const reversed = verifyTrialArtifact(root);

    expect(forward.valid).toBe(false);
    expect(reversed.issues).toEqual(forward.issues);
    const conflictMessage = [firstReceipt, secondReceipt]
      .sort((left, right) => (
        left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0
      ))
      .map((receipt) =>
        `turn ${receipt.turnId} has conflicting terminal receipts: applied, shadowed`
      )
      .join("; ");
    expect(forward.issues).toContain(
      `fixture turn and receipt evidence is invalid: ` +
        conflictMessage,
    );
  });

  it("rejects duplicate terminal receipts with the same status", () => {
    const root = validArtifactDirectory("shadow");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const firstReceipt = agentActionReceiptSchema.parse(JSON.parse(receiptRows[0]!));
    const duplicateReceipt = agentActionReceiptSchema.parse({
      ...firstReceipt,
      receiptId: `rcpt_${"e".repeat(24)}`,
    });
    writeFileSync(
      receiptsPath,
      `${receiptRows.join("\n")}\n${canonicalStringify(duplicateReceipt)}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-receipts.jsonl");

    expect(verifyTrialArtifact(root).issues).toContain(
      `fixture turn and receipt evidence is invalid: ` +
        `turn ${firstReceipt.turnId} ` +
        `has duplicate terminal receipts: ${firstReceipt.status}, ${firstReceipt.status}`,
    );
  });

  it("rejects duplicate turn envelopes in authenticated sidecar evidence", () => {
    const root = validArtifactDirectory("shadow");
    const turnsPath = join(root, "agent-lab-turns.jsonl");
    const turnRows = readFileSync(turnsPath, "utf8").trim().split(/\r?\n/);
    const firstTurn = agentTurnEnvelopeSchema.parse(JSON.parse(turnRows[0]!));
    writeFileSync(
      turnsPath,
      `${turnRows.join("\n")}\n${turnRows[0]}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-turns.jsonl");

    expect(verifyTrialArtifact(root).issues).toContain(
      "fixture turn and receipt evidence is invalid: " +
        "duplicate turn envelope: " +
        firstTurn.turnId,
    );
  });

  it("rejects an authenticated receipt that references an unknown turn", () => {
    const root = validArtifactDirectory("shadow");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const firstReceipt = agentActionReceiptSchema.parse(JSON.parse(receiptRows[0]!));
    const orphanTurnId = `turn_${"f".repeat(24)}`;
    const orphanReceipt = agentActionReceiptSchema.parse({
      ...firstReceipt,
      receiptId: `rcpt_${"f".repeat(24)}`,
      turnId: orphanTurnId,
    });
    writeFileSync(
      receiptsPath,
      `${receiptRows.join("\n")}\n${canonicalStringify(orphanReceipt)}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-receipts.jsonl");

    expect(verifyTrialArtifact(root).issues).toContain(
      "fixture turn and receipt evidence is invalid: " +
        `receipt references an unknown turn: ${orphanTurnId}`,
    );
  });

  it("authenticates the native fixture matrix from persisted events", () => {
    const root = validArtifactDirectory("native");
    const eventsPath = join(root, "events.jsonl");
    const eventRows = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/);
    writeFileSync(eventsPath, `${eventRows.slice(1).join("\n")}\n`, "utf8");
    refreshArtifactFileHash(root, "events.jsonl");

    const verification = verifyTrialArtifact(root);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain(
      "artifact authoritative fixture schedule does not match event evidence",
    );
    expect(verification.issues).toContain(
      "authoritative fixture schedule does not match the pinned citizen/tick matrix",
    );
  });

  it("recomputes fixture Hermes coverage from runtime and tool-call evidence", () => {
    const root = validArtifactDirectory("shadow");
    const toolCallsPath = join(root, "agent-lab-tool-calls.jsonl");
    const toolCallRows = readFileSync(toolCallsPath, "utf8")
      .trim()
      .split(/\r?\n/);
    writeFileSync(
      toolCallsPath,
      `${toolCallRows.slice(1).join("\n")}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-tool-calls.jsonl");

    expect(verifyTrialArtifact(root).issues).toContain(
      "artifact fixture Hermes schedule does not match runtime and tool-call evidence",
    );
  });

  it("continues independent event checks when tool-call evidence is invalid", () => {
    const root = validArtifactDirectory("shadow");
    const toolCallsPath = join(root, "agent-lab-tool-calls.jsonl");
    writeFileSync(
      toolCallsPath,
      `${canonicalStringify({
        turnId: "invalid-turn",
        agentId: "agt_00000001",
      })}\n`,
      "utf8",
    );
    refreshArtifactFileHash(root, "agent-lab-tool-calls.jsonl");
    const eventsPath = join(root, "events.jsonl");
    const eventRows = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/);
    writeFileSync(eventsPath, `${eventRows.slice(1).join("\n")}\n`, "utf8");
    refreshArtifactFileHash(root, "events.jsonl");

    const verification = verifyTrialArtifact(root);

    expect(verification.issues).toContain(
      "tool-call evidence is invalid: tool call 0 turnId is invalid",
    );
    expect(verification.issues).toContain(
      "artifact authoritative fixture schedule does not match event evidence",
    );
  });

  it("reports malformed Hermes evidence without treating budgets as corruption", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      hermesRuns: unknown[];
    };
    runtime.hermesRuns = [
      null,
      { budgetViolations: "malformed" },
      {
        budgetViolations: [{ code: "run_cost", observedMicrocents: 101 }],
      },
    ];
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");

    const verification = verifyTrialArtifact(root);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain(
      "Hermes run 0 evidence is not an object",
    );
    expect(verification.issues).toContain(
      "Hermes run 1 budgetViolations is not an array",
    );
    expect(verification.issues.some((issue) =>
      issue.startsWith("Hermes run 2 evidence is invalid")
    )).toBe(true);
    expect(verification.issues.some((issue) =>
      issue.startsWith("Hermes budget violation:")
    )).toBe(false);
  });

  it("retains unlinked trial-level Hermes failures and scores budget breaches", () => {
    const root = validArtifactDirectory();
    const runtimePath = join(root, "runtime.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      hermesRuns: unknown[];
    };
    runtime.hermesRuns = [{
      runId: "hermes-orphan",
      agentId: "agt_00000001",
      targetTick: 10,
      status: "failed",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 10,
      budgetViolations: ["run cost exceeded"],
      failure: "turn lookup failed",
    }];
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    refreshArtifactFileHash(root, "runtime.json");
    const scorecardPath = join(root, "scorecard.json");
    const scorecard = JSON.parse(readFileSync(scorecardPath, "utf8")) as {
      operational: Array<{ metricId: string; value: number | null }>;
    };
    const budgetMetric = scorecard.operational.find(
      (metric) => metric.metricId === "budget_violations",
    );
    if (budgetMetric === undefined) {
      throw new Error("fixture scorecard is missing budget evidence");
    }
    budgetMetric.value = 1;
    writeFileSync(scorecardPath, `${canonicalStringify(scorecard)}\n`, "utf8");
    refreshArtifactFileHash(root, "scorecard.json");

    expect(verifyTrialArtifact(root)).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects a self-consistent fixture sidecar missing a pinned slot", () => {
    const root = validArtifactDirectory("shadow");
    const artifactPath = join(root, "artifact.json");
    const turnsPath = join(root, "agent-lab-turns.jsonl");
    const receiptsPath = join(root, "agent-lab-receipts.jsonl");
    const toolCallsPath = join(root, "agent-lab-tool-calls.jsonl");
    const runtimePath = join(root, "runtime.json");
    const turnRows = readFileSync(turnsPath, "utf8").trim().split(/\r?\n/);
    const receiptRows = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/);
    const removedTurn = agentTurnEnvelopeSchema.parse(
      JSON.parse(turnRows.shift()!),
    );
    const remainingReceipts = receiptRows.filter((row) => (
      agentActionReceiptSchema.parse(JSON.parse(row)).turnId !==
      removedTurn.turnId
    ));
    const remainingToolCalls = readFileSync(toolCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter((row) => (
        (JSON.parse(row) as { turnId?: string }).turnId !== removedTurn.turnId
      ));
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      hermesRuns: Array<{ turnId?: string }>;
    };
    runtime.hermesRuns = runtime.hermesRuns.filter(
      (run) => run.turnId !== removedTurn.turnId,
    );
    writeFileSync(turnsPath, `${turnRows.join("\n")}\n`, "utf8");
    writeFileSync(receiptsPath, `${remainingReceipts.join("\n")}\n`, "utf8");
    writeFileSync(toolCallsPath, `${remainingToolCalls.join("\n")}\n`, "utf8");
    writeFileSync(runtimePath, `${canonicalStringify(runtime)}\n`, "utf8");
    const altered = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      files: Record<string, string>;
      hashHeads: { artifact: string };
      statistics: {
        turns: number;
        terminalReceipts: number;
        fixtureTurns: number;
        fixtureTerminalReceipts: number;
        validSubmissions: number;
        fixtureSchedule: Array<{ turnId: string }>;
        fixtureHermesEvidenceSchedule: Array<{ turnId: string }>;
        authoritativeFixtureSchedule: Array<{
          agentId: string;
          targetTick: number;
        }>;
        toolCalls: number;
        inputTokens: number;
        outputTokens: number;
      };
    };
    altered.statistics.turns -= 1;
    altered.statistics.terminalReceipts -= 1;
    altered.statistics.fixtureTurns -= 1;
    altered.statistics.fixtureTerminalReceipts -= 1;
    altered.statistics.validSubmissions -= 1;
    altered.statistics.toolCalls -= 1;
    altered.statistics.inputTokens -= 100;
    altered.statistics.outputTokens -= 20;
    altered.statistics.fixtureSchedule = altered.statistics.fixtureSchedule.filter(
      (entry) => entry.turnId !== removedTurn.turnId,
    );
    altered.statistics.fixtureHermesEvidenceSchedule =
      altered.statistics.fixtureHermesEvidenceSchedule.filter(
        (entry) => entry.turnId !== removedTurn.turnId,
      );
    altered.statistics.authoritativeFixtureSchedule =
      altered.statistics.authoritativeFixtureSchedule.filter(
        (entry) =>
          entry.agentId !== removedTurn.agentId ||
          entry.targetTick !== removedTurn.targetTick,
      );
    altered.files["agent-lab-turns.jsonl"] = hash(turnsPath);
    altered.files["agent-lab-receipts.jsonl"] = hash(receiptsPath);
    altered.files["agent-lab-tool-calls.jsonl"] = hash(toolCallsPath);
    altered.files["runtime.json"] = hash(runtimePath);
    altered.hashHeads.artifact = sha256Hex(canonicalStringify(altered.files));
    writeFileSync(
      artifactPath,
      `${canonicalStringify(altered)}\n`,
      "utf8",
    );

    const verification = verifyTrialArtifact(root);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain(
      "observed fixture schedule does not match the pinned citizen/tick matrix",
    );
  });

  it("rejects duplicate or drifted MCP tool pins", () => {
    const base = manifest();
    expect(() => validateExperimentManifest({
      ...base,
      tools: [base.tools[0], base.tools[0], base.tools[2], base.tools[3]],
    })).toThrow();
    expect(() => validateExperimentManifest({
      ...base,
      tools: base.tools.map((tool, index) => index === 0
        ? { ...tool, schema: { type: "object", additionalProperties: true } }
        : tool),
    })).toThrow(/schema drifted/);
  });

  it("fails closed instead of reusing crashed or prior trial state", () => {
    const root = mkdtempSync(join(tmpdir(), "worldtangle-harness-isolation-"));
    roots.push(root);
    expect(() => assertFreshStudyDirectory(root)).not.toThrow();
    writeFileSync(join(root, "leftover.db"), "prior trial state", "utf8");
    expect(() => assertFreshStudyDirectory(root)).toThrow(/cannot contaminate the study/);
  });

  it("accepts complete production pilot evidence", () => {
    const parsed = validateExperimentManifest(manifest());
    expect(releaseIssues(parsed, releaseTrials())).toEqual([]);
  });

  it("requires independently authenticated native fixture events", () => {
    const parsed = validateExperimentManifest(manifest());
    const missingNativeEvidence = releaseTrials();
    replaceReleaseTrial(
      missingNativeEvidence,
      "native",
      11,
      1,
      releaseTrial("native", 11, 1, {
        authoritativeFixtureSchedule: [],
      }),
    );

    expect(releaseIssues(parsed, missingNativeEvidence).join("\n")).toMatch(
      /native-a1 authoritative fixture events do not match the pinned citizen\/tick matrix/,
    );
  });

  it("binds every release artifact to the study and canonical manifest digest", () => {
    const parsed = validateExperimentManifest(manifest());
    const mismatched = releaseTrials();
    replaceReleaseTrial(
      mismatched,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        studyId: "different-study",
        manifestDigest: "f".repeat(64),
      }),
    );

    const issues = releaseIssues(parsed, mismatched).join("\n");
    expect(issues).toMatch(/belongs to study different-study; expected harness-test/);
    expect(issues).toMatch(/manifest digest does not match the study manifest/);
  });

  it("rejects duplicate and noncanonical release cohorts", () => {
    const parsed = validateExperimentManifest(manifest());
    const cohortAgentIds = cohortAgentIdsFor(parsed.cohort.size);
    const invalid = releaseTrials();
    const duplicateIndex = releaseTrialIndex(invalid, "shadow", 11, 1);
    const duplicate = invalid[duplicateIndex]!;
    invalid[duplicateIndex] = {
      ...duplicate,
      artifact: {
        ...duplicate.artifact,
        statistics: {
          ...duplicate.artifact.statistics,
          cohortAgentIds: [
            ...cohortAgentIds.slice(0, -1),
            cohortAgentIds[0]!,
          ],
        },
      },
    };
    const reversedIndex = releaseTrialIndex(invalid, "shadow", 11, 2);
    const reversed = invalid[reversedIndex]!;
    invalid[reversedIndex] = {
      ...reversed,
      artifact: {
        ...reversed.artifact,
        statistics: {
          ...reversed.artifact.statistics,
          cohortAgentIds: [...cohortAgentIds].reverse(),
        },
      },
    };

    const issues = releaseIssues(parsed, invalid).join("\n");
    expect(issues).toMatch(/recorded duplicate cohort citizens/);
    expect(issues).toMatch(/recorded a noncanonical cohort order/);
  });

  it("requires every arm for a seed to share one resolved cohort", () => {
    const parsed = validateExperimentManifest(manifest());
    const mismatched = releaseTrials();
    const changedCohort = cohortAgentIdsFor(parsed.cohort.size);
    changedCohort[changedCohort.length - 1] = "agt_00000009";
    replaceReleaseTrial(
      mismatched,
      "native",
      11,
      1,
      releaseTrial("native", 11, 1, {
        cohortAgentIds: changedCohort,
      }),
    );

    const issues = releaseIssues(parsed, mismatched).join("\n");
    expect(issues).toMatch(
      /seed 11 trials do not share one resolved cohort/,
    );
    expect(issues).toMatch(
      /harness-test-s11-shadow-a1 does not use the native matched cohort/,
    );
  });

  it("rejects an artifact whose seed is outside the frozen study set", () => {
    const parsed = validateExperimentManifest(manifest());
    const unexpectedSeed = releaseTrials();
    replaceReleaseTrial(
      unexpectedSeed,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 99, 1),
    );

    expect(releaseIssues(parsed, unexpectedSeed).join("\n")).toMatch(
      /harness-test-s99-shadow-a1 uses seed 99, which is not a frozen study seed/,
    );
  });

  it("rejects a vacuous production pilot", () => {
    const parsed = validateExperimentManifest(manifest());
    const vacuous = releaseTrials();
    replaceReleaseTrial(vacuous, "shadow", 11, 1, releaseTrial("shadow", 11, 1, {
      turns: 0,
      terminalReceipts: 0,
      fixtureTurns: 0,
      fixtureTerminalReceipts: 0,
      authoritativeFixtureSchedule: [],
      fixtureHermesEvidenceSchedule: [],
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      hermesInputTokens: 0,
      hermesOutputTokens: 0,
    }));
    const vacuousIssues = releaseIssues(parsed, vacuous).join("\n");
    expect(vacuousIssues).toMatch(
      /recorded 0 scheduled fixture turns/,
    );
    expect(vacuousIssues).toMatch(/no real Hermes token evidence/);
  });

  it("rejects nonterminal Agent Lab evidence", () => {
    const parsed = validateExperimentManifest(manifest());
    const nonterminal = releaseTrials();
    replaceReleaseTrial(nonterminal, "shadow", 11, 1, releaseTrial("shadow", 11, 1, {
      terminalReceipts: 1,
    }));
    expect(releaseIssues(parsed, nonterminal).join("\n")).toMatch(
      /has a nonterminal Agent Lab turn/,
    );
  });

  it("rejects Agent Lab sidecar evidence in a native artifact", () => {
    const parsed = validateExperimentManifest(manifest());
    const contaminated = releaseTrials();
    replaceReleaseTrial(
      contaminated,
      "native",
      11,
      1,
      releaseTrial("native", 11, 1, {
        turns: 1,
        terminalReceipts: 1,
        fixtureTurns: 0,
        fixtureTerminalReceipts: 0,
        toolCalls: 1,
      }),
    );

    expect(releaseIssues(parsed, contaminated).join("\n")).toMatch(
      /native artifact contains Agent Lab sidecar evidence/,
    );
  });

  it("reports duplicate terminal receipt counts separately", () => {
    const parsed = validateExperimentManifest(manifest());
    const duplicated = releaseTrials();
    const fixture = parsed.scenario.opportunityFixture;
    if (fixture === undefined) throw new Error("test manifest must pin its fixture");
    const expectedTurns =
      parsed.cohort.size *
      fixture.ticks.length;
    replaceReleaseTrial(
      duplicated,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        terminalReceipts: expectedTurns + 1,
        fixtureTerminalReceipts: expectedTurns,
      }),
    );
    expect(releaseIssues(parsed, duplicated).join("\n")).toMatch(
      new RegExp(
        `recorded ${expectedTurns + 1} terminal receipts for ` +
          `${expectedTurns} Agent Lab turns`,
      ),
    );
  });

  it("rejects failed Hermes run evidence", () => {
    const parsed = validateExperimentManifest(manifest());
    const failedHermes = releaseTrials();
    replaceReleaseTrial(failedHermes, "shadow", 11, 1, releaseTrial("shadow", 11, 1, {
      hermesFailedRuns: 1,
    }));
    expect(releaseIssues(parsed, failedHermes).join("\n")).toMatch(
      /has failed or missing Hermes run evidence/,
    );
  });

  it("requires Hermes evidence for every pinned fixture turn", () => {
    const parsed = validateExperimentManifest(manifest());
    const incomplete = releaseTrials();
    const shadow = releaseTrial("shadow", 11, 1);
    replaceReleaseTrial(
      incomplete,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        fixtureHermesEvidenceSchedule:
          shadow.artifact.statistics.fixtureHermesEvidenceSchedule.slice(1),
      }),
    );

    expect(releaseIssues(parsed, incomplete).join("\n")).toMatch(
      /Hermes evidence does not cover every pinned fixture turn/,
    );
  });

  it("requires successful tokens, tools, and budgets for each fixture turn", () => {
    const parsed = validateExperimentManifest(manifest());
    const incomplete = releaseTrials();
    const shadow = releaseTrial("shadow", 11, 1);
    const evidence = shadow.artifact.statistics.fixtureHermesEvidenceSchedule.map(
      (entry, index) => index === 0
        ? {
            ...entry,
            status: "failed" as const,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 0,
            budgetViolationCount: 1,
          }
        : entry,
    );
    replaceReleaseTrial(
      incomplete,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        fixtureHermesEvidenceSchedule: evidence,
      }),
    );

    const issues = releaseIssues(parsed, incomplete).join("\n");
    expect(issues).toMatch(/noncompleted per-turn Hermes evidence/);
    expect(issues).toMatch(/incomplete per-turn Hermes token evidence/);
    expect(issues).toMatch(/fixture turn without Hermes tool evidence/);
    expect(issues).toMatch(/per-turn Hermes budget violation/);
  });

  it("rejects a reduced citizen and tick fixture matrix", () => {
    const parsed = validateExperimentManifest(manifest());
    const expectedTurns =
      parsed.cohort.size *
      (parsed.scenario.opportunityFixture?.ticks.length ?? 0);
    const reducedFixtureTurns = parsed.cohort.size;
    expect(reducedFixtureTurns).toBeLessThan(expectedTurns);
    const nonspecific = releaseTrials();
    const complete = releaseTrial("shadow", 11, 1);
    replaceReleaseTrial(nonspecific, "shadow", 11, 1, releaseTrial("shadow", 11, 1, {
      turns: expectedTurns,
      terminalReceipts: expectedTurns,
      fixtureTurns: reducedFixtureTurns,
      fixtureTerminalReceipts: reducedFixtureTurns,
      authoritativeFixtureSchedule:
        complete.artifact.statistics.authoritativeFixtureSchedule.slice(
          0,
          reducedFixtureTurns,
        ),
    }));
    expect(releaseIssues(parsed, nonspecific).join("\n")).toMatch(
      new RegExp(`recorded ${reducedFixtureTurns} scheduled fixture turns`),
    );
  });

  it("rejects shadow-mode authoritative state divergence", () => {
    const parsed = validateExperimentManifest(manifest());
    const divergent = releaseTrials();
    replaceReleaseTrial(divergent, "shadow", 11, 1, releaseTrial("shadow", 11, 1, {
      stateHash: "f".repeat(64),
    }));
    expect(releaseIssues(parsed, divergent).join("\n")).toMatch(
      /changed authoritative state in shadow mode/,
    );
  });

  it("rejects copied trial artifacts", () => {
    const parsed = validateExperimentManifest(manifest());
    const copied = releaseTrials();
    const sourceIndex = releaseTrialIndex(copied, "shadow", 11, 1);
    const replacementIndex = releaseTrialIndex(copied, "shadow", 11, 2);
    const source = copied[sourceIndex]!;
    const replacement = copied[replacementIndex]!;
    copied[replacementIndex] = {
      ...replacement,
      artifact: {
        ...replacement.artifact,
        trialId: source.artifact.trialId,
      },
    };
    expect(releaseIssues(parsed, copied).join("\n")).toMatch(
      /duplicate trial artifact/,
    );
  });

  it("rejects an altered citizen and tick fixture matrix", () => {
    const parsed = validateExperimentManifest(manifest());
    const altered = releaseTrials();
    const alteredIndex = releaseTrialIndex(altered, "shadow", 11, 1);
    const original = altered[alteredIndex]!;
    const pinnedTick = AGENT_LAB_PILOT_FIXTURE_TICKS[0]!;
    const driftedTick = pinnedTick - 1;
    const alteredSchedule = original.artifact.statistics.fixtureSchedule.map(
      (entry) => entry.targetTick === pinnedTick
        ? { ...entry, targetTick: driftedTick }
        : entry,
    );
    const alteredAuthoritativeSchedule =
      original.artifact.statistics.authoritativeFixtureSchedule.map(
        (entry) => entry.targetTick === pinnedTick
          ? {
              ...entry,
              targetTick: driftedTick,
              opportunityKey: entry.opportunityKey.replace(
                `:${pinnedTick}`,
                `:${driftedTick}`,
              ),
            }
          : entry,
      );
    replaceReleaseTrial(
      altered,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        fixtureSchedule: alteredSchedule,
        authoritativeFixtureSchedule: alteredAuthoritativeSchedule,
      }),
    );
    expect(releaseIssues(parsed, altered).join("\n")).toMatch(
      /fixture schedule does not match the pinned citizen\/tick matrix/,
    );
  });

  it("rejects a drifted pilot fixture tick set", () => {
    const base = manifest();
    const drifted = validateExperimentManifest({
      ...base,
      scenario: {
        ...base.scenario,
        opportunityFixture: {
          version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
          ticks: [10, 30],
        },
      },
    });
    const driftIssues = releaseIssues(drifted, releaseTrials());
    expect(driftIssues).toContain(
      "production pilot requires the goal-commitment fixture " +
        `${AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION} at ticks ` +
        AGENT_LAB_PILOT_FIXTURE_TICKS.join(", "),
    );
  });

  it("rejects an unknown opportunity fixture version during validation", () => {
    const base = manifest();
    expect(() => validateExperimentManifest({
      ...base,
      scenario: {
        ...base.scenario,
        opportunityFixture: {
          version: "goal_commitment_choice_v0",
          ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
        },
      },
    })).toThrow();
  });

  it("rejects fixture version drift that bypasses manifest validation", () => {
    const base = manifest();
    const parsedBase = validateExperimentManifest(base);
    const versionDrift = {
      ...parsedBase,
      scenario: {
        ...parsedBase.scenario,
        opportunityFixture: {
          version: "goal_commitment_choice_v0",
          ticks: [...AGENT_LAB_PILOT_FIXTURE_TICKS],
        },
      },
    } as unknown as ExperimentManifest;
    expect(releaseIssues(versionDrift, releaseTrials()).join("\n")).toMatch(
      /requires the goal-commitment fixture/,
    );
  });

  it("rejects a fixtureless production scenario", () => {
    const base = manifest();
    const {
      opportunityFixture,
      ...fixturelessScenario
    } = base.scenario;
    expect(opportunityFixture).toBeDefined();
    const fixtureless = validateExperimentManifest({
      ...base,
      scenario: fixturelessScenario,
    });
    expect(releaseIssues(fixtureless, releaseTrials()).join("\n")).toMatch(
      /has no pinned fixture turns to verify/,
    );
  });

  it("rejects a missing shadow artifact matrix", () => {
    const parsed = validateExperimentManifest(manifest());
    const missingShadow = releaseTrials().filter((trial) => !(
      trial.artifact.seed === 11 &&
      trial.artifact.mode === "shadow"
    ));
    expect(releaseIssues(parsed, missingShadow).join("\n")).toMatch(
      /seed 11 requires 3 shadow artifacts, received 0/,
    );
  });

  it("rejects a missing native attempt-one artifact", () => {
    const parsed = validateExperimentManifest(manifest());
    const trials = releaseTrials();
    replaceReleaseTrial(
      trials,
      "shadow",
      11,
      1,
      releaseTrial("shadow", 11, 1, {
        turns: 25,
        terminalReceipts: 24,
        fixtureTurns: 24,
        fixtureTerminalReceipts: 24,
        toolCalls: 24,
      }),
    );
    const missingNative = trials.filter((trial) => !(
      trial.artifact.seed === 11 &&
      trial.artifact.mode === "native"
    ));
    const issues = releaseIssues(parsed, missingNative).join("\n");
    expect(issues).toMatch(
      /harness-test-s11-shadow-a1 has no native attempt-1 artifact to match against/,
    );
    expect(issues).toMatch(
      /harness-test-s11-shadow-a1 fixture matrix was not verified because the native attempt-1 cohort is unavailable/,
    );
    expect(issues).toMatch(
      /harness-test-s11-shadow-a1 has a nonterminal Agent Lab turn/,
    );
    expect(issues).toMatch(
      /harness-test-s11-shadow-a1 recorded fewer Hermes tool calls than Agent Lab turns/,
    );
  });
});
