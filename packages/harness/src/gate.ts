import {
  AGENT_LAB_PROTOCOL_VERSION,
  canonicalStringify,
  sha256Hex,
} from "@worldtangle/shared";
import {
  agentLabDriverPolicyDigest,
  agentLabPromptDigest,
  agentLabToolPins,
  CITIZEN_TURN_PROMPT,
} from "./driver-policy";
import { planTrials, validateExperimentManifest } from "./manifest";

const budget = {
  maxAgentLoopIterations: 8,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_000,
  maxToolCalls: 8,
};
const manifest = validateExperimentManifest({
  schemaVersion: 1,
  protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
  studyId: "agent-lab-offline-gate",
  scenario: {
    name: "Agent Lab offline contract gate",
    worldSpec: "riverbend-100@1",
    seeds: [11, 22, 33],
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
    strata: ["occupation", "employment_status", "household"],
  },
  interventions: [{
    id: "fuel-shock",
    tick: 2,
    type: "energy.fuel_price_shock",
    params: { deltaPct: 30 },
  }],
  hypotheses: [{
    id: "h1",
    statement: "External decisions remain valid, bounded, and replayable.",
    metricIds: ["validity-rate"],
  }],
  primaryMetrics: [{
    id: "validity-rate",
    description: "Share of terminal external receipts that apply validly.",
    unit: "basis_points",
    direction: "increase",
  }],
  secondaryMetrics: [],
  attempts: { native: 1, shadow: 3, external: 3 },
  provider: {
    family: "hermes",
    model: "configured-by-release-operator",
    settings: {
      decisionDeadlineMs: 60_000,
      inputMicrocentsPerToken: 100,
      outputMicrocentsPerToken: 300,
      hermesVersion: "Hermes Agent v0.18.2 (gate) · upstream abcdef0",
      hermesPythonVersion: "3.11.15",
      hermesOpenAiSdkVersion: "2.24.0",
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
});
const plans = planTrials(manifest);
if (plans.length !== 21) throw new Error(`expected 21 pilot trials, received ${plans.length}`);
if (new Set(plans.map((plan) => plan.trialId)).size !== plans.length) {
  throw new Error("trial planner produced duplicate trial IDs");
}
process.stdout.write(`${canonicalStringify({
  gate: "agent-lab",
  protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
  manifestDigest: sha256Hex(canonicalStringify(manifest)),
  plannedTrials: plans.length,
  status: "passed",
})}\n`);
