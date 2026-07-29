import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  canonicalStringify,
  experimentManifestSchema,
  type ExperimentManifest,
} from "@worldtangle/shared";
import {
  CITIZEN_TURN_PROMPT,
  MAX_SHADOW_TURNS_PER_CREDENTIAL_PER_TICK,
  agentLabDriverPolicyDigest,
  agentLabPilotOpportunityFixture,
  agentLabPromptDigest,
  agentLabToolPins,
} from "./driver-policy";
import { inspectHermesRuntime } from "./hermes-version";

const DEFAULT_GENERATION_BUDGET = Object.freeze({
  maxAgentLoopIterations: 8,
  // Hermes reports usage for the complete multi-iteration run, not one model
  // request. These limits therefore cover the whole bounded citizen turn.
  maxInputTokens: 64_000,
  maxOutputTokens: 8_000,
  maxToolCalls: 8,
});
const PILOT_COHORT_SIZE = 8;
const MICROCENTS_PER_CENT = 1_000_000n;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve("."),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

export function createPilotManifest(input: Readonly<{
  studyId: string;
  model: string;
  inputMicrocentsPerToken: number;
  outputMicrocentsPerToken: number;
  providerEnvAllowlist: string;
  hermesExecutable?: string;
  createdWall?: string;
}>): ExperimentManifest {
  const generationBudget = DEFAULT_GENERATION_BUDGET;
  const hermes = inspectHermesRuntime(input.hermesExecutable);
  const opportunityFixture = agentLabPilotOpportunityFixture();
  if (PILOT_COHORT_SIZE > MAX_SHADOW_TURNS_PER_CREDENTIAL_PER_TICK) {
    throw new Error(
      "pilot cohort exceeds the pinned shadow-turn credential limit",
    );
  }
  for (const [label, value] of [
    ["inputMicrocentsPerToken", input.inputMicrocentsPerToken],
    ["outputMicrocentsPerToken", input.outputMicrocentsPerToken],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a nonnegative safe integer`);
    }
  }
  const worstCaseTurnTokens =
    generationBudget.maxInputTokens + generationBudget.maxOutputTokens;
  const worstCaseTurnMicrocents =
    BigInt(generationBudget.maxInputTokens) *
      BigInt(input.inputMicrocentsPerToken) +
    BigInt(generationBudget.maxOutputTokens) *
      BigInt(input.outputMicrocentsPerToken);
  const pinnedTurnCount =
    new Set(opportunityFixture.ticks).size * PILOT_COHORT_SIZE;
  const pinnedRunMicrocents =
    BigInt(pinnedTurnCount) * worstCaseTurnMicrocents;
  const runCostCentsMax = pinnedRunMicrocents === 0n
    ? 1n
    : (
        pinnedRunMicrocents + MICROCENTS_PER_CENT - 1n
      ) / MICROCENTS_PER_CENT;
  return experimentManifestSchema.parse({
    schemaVersion: 2,
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: input.studyId,
    scenario: {
      name: "Riverbend matched eight-citizen pilot",
      worldSpec: "riverbend-100@1",
      seeds: [41, 42, 43],
      ticks: 60,
      budgets: {
        runCostCentsMax: runCostCentsMax.toString(),
        perAgentDailyTokens: worstCaseTurnTokens,
      },
      policyOverrides: {},
      opportunityFixture,
    },
    cohort: {
      strategy: "stable_stratified_v1",
      size: PILOT_COHORT_SIZE,
      controller: "shadow",
      strata: ["occupation", "employment_status", "household"],
    },
    interventions: [{
      id: "fuel-price-shock",
      tick: 15,
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30 },
    }],
    hypotheses: [{
      id: "h1-bounded-agency",
      statement:
        "External choices remain valid, replayable, and bounded while changing behavioral outcomes.",
      metricIds: [
        "invariants_pass",
        "replay_divergences",
        "validity_rate_bp",
        "fallback_rate_bp",
      ],
    }],
    primaryMetrics: [
      {
        id: "invariants_pass",
        description: "All active WorldTangle invariants pass.",
        unit: "boolean",
        direction: "target",
      },
      {
        id: "replay_divergences",
        description: "Strict offline replay divergences.",
        unit: "count",
        direction: "decrease",
      },
      {
        id: "validity_rate_bp",
        description: "Terminal receipts accepted as applied or shadowed.",
        unit: "basis_points",
        direction: "increase",
      },
      {
        id: "fallback_rate_bp",
        description: "External turns resolved through deterministic fallback.",
        unit: "basis_points",
        direction: "decrease",
      },
    ],
    secondaryMetrics: [
      {
        id: "cited_memory_use",
        description: "Turns whose observation contains a cited memory.",
        unit: "turns",
        direction: "descriptive",
      },
      {
        id: "cpi_index",
        description: "Terminal simulated Riverbend CPI index.",
        unit: "index",
        direction: "descriptive",
      },
      {
        id: "loan_defaults",
        description: "Terminal simulated defaulted-loan count.",
        unit: "count",
        direction: "descriptive",
      },
    ],
    attempts: {
      native: 1,
      shadow: 3,
      external: 3,
    },
    provider: {
      family: "hermes",
      model: input.model,
      settings: {
        decisionDeadlineMs: 60_000,
        inputMicrocentsPerToken: input.inputMicrocentsPerToken,
        outputMicrocentsPerToken: input.outputMicrocentsPerToken,
        hermesVersion: hermes.version,
        hermesPythonVersion: hermes.pythonVersion,
        hermesOpenAiSdkVersion: hermes.openAiSdkVersion,
        hermesMcpSdkVersion: hermes.mcpSdkVersion,
        hermesStarletteVersion: hermes.starletteVersion,
        hermesAiohttpVersion: hermes.aiohttpVersion,
        providerEnvAllowlist: input.providerEnvAllowlist,
      },
    },
    generationBudget,
    prompt: {
      bytes: CITIZEN_TURN_PROMPT,
      digest: agentLabPromptDigest(),
    },
    tools: agentLabToolPins(),
    engine: {
      commit: currentCommit(),
      dependencies: {
        node: process.version,
        "pnpm-lock-sha256": sha256File(resolve("pnpm-lock.yaml")),
      },
    },
    driverPolicyDigest: agentLabDriverPolicyDigest(generationBudget),
    createdWall: input.createdWall ?? new Date().toISOString(),
  });
}

export function writePilotManifest(
  outputPath: string,
  input: Parameters<typeof createPilotManifest>[0],
): string {
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    `${canonicalStringify(createPilotManifest(input))}\n`,
    "utf8",
  );
  return destination;
}
