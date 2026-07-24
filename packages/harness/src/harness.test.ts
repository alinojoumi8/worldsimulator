import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  canonicalStringify,
  sha256Hex,
  trialArtifactSchema,
} from "@worldtangle/shared";
import { verifyTrialArtifact } from "./artifact";
import { parseArguments } from "./cli";
import { createPilotManifest } from "./create-manifest";
import {
  agentLabDriverPolicyDigest,
  agentLabPromptDigest,
  agentLabToolPins,
  CITIZEN_TURN_PROMPT,
} from "./driver-policy";
import {
  buildHermesProfileEnvironment,
  profileConfig,
} from "./hermes";
import {
  planTrials,
  validateExperimentManifest,
} from "./manifest";
import { assertFreshStudyDirectory } from "./runner";

const roots: string[] = [];
const budget = {
  maxAgentLoopIterations: 8,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_000,
  maxToolCalls: 8,
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function manifest() {
  return {
    schemaVersion: 1 as const,
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: "harness-test",
    scenario: {
      name: "Harness test",
      worldSpec: "riverbend-100@1",
      seeds: [11, 22, 33],
      ticks: 60,
      budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
      policyOverrides: {},
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

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validArtifactDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "worldtangle-harness-artifact-"));
  roots.push(root);
  const files: Record<string, unknown> = {
    "manifest.json": manifest(),
    "runtime.json": { hermesRuns: [] },
    "agent-lab-turns.jsonl": "",
    "agent-lab-submissions.jsonl": "",
    "agent-lab-receipts.jsonl": "",
    "agent-lab-tool-calls.jsonl": "",
    "events.jsonl": "",
    "scorecard.json": {
      schemaVersion: 1,
      studyId: "harness-test",
      trialId: "harness-test-s11-native-a1",
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
      operational: [],
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
    trialId: "harness-test-s11-native-a1",
    mode: "native",
    seed: 11,
    attempt: 1,
    manifestDigest: sha256Hex(canonicalStringify(manifest())),
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
    },
    taint: { tainted: false, reasons: [] },
  });
  writeFileSync(join(root, "artifact.json"), `${canonicalStringify(artifact)}\n`, "utf8");
  return root;
}

describe("Agent Lab harness", () => {
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
      hermesVersionOutput: [
        "Hermes Agent v0.18.2 (test) · upstream abcdef0",
        "Python: 3.11.15",
        "OpenAI SDK: 2.24.0",
      ].join("\n"),
      createdWall: "2026-07-24T12:00:00.000Z",
    });
    expect(validateExperimentManifest(created)).toEqual(created);
    expect(planTrials(created)).toHaveLength(21);
    expect(created.engine.dependencies["node"]).toBe(process.version);
    expect(created.engine.dependencies["pnpm-lock-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins prompt, tools, driver policy, and the full 21-trial pilot matrix", () => {
    const parsed = validateExperimentManifest(manifest());
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
});
