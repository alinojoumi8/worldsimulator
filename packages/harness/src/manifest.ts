import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_LAB_MCP_TOOL_DEFINITIONS,
  canonicalStringify,
  compareCodeUnit,
  experimentManifestSchema,
  sha256Hex,
  type AgentLabMode,
  type ExperimentManifest,
} from "@worldtangle/shared";
import {
  agentLabDriverPolicyDigest,
  agentLabLegacyDriverPolicyDigest,
  agentLabPromptDigest,
  agentLabToolSchemaDigest,
} from "./driver-policy";
import { providerEnvironmentNames } from "./provider-environment";

export interface TrialPlan {
  readonly studyId: string;
  readonly trialId: string;
  readonly mode: AgentLabMode;
  readonly seed: number;
  readonly attempt: number;
}

const FORBIDDEN_MANIFEST_KEYS = new Set([
  "accesstoken",
  "apikey",
  "credential",
  "password",
  "providerkey",
  "refreshtoken",
  "secret",
  "token",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function assertNoCredentialMaterial(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (
      /wtpat_[A-Za-z0-9._-]{20,}/.test(value) ||
      /authorization\s*:\s*bearer\s+[A-Za-z0-9._-]{16,}/i.test(value) ||
      /\b(?:sk|api)[-_][A-Za-z0-9_-]{24,}\b/i.test(value)
    ) {
      throw new Error(`experiment manifest contains credential-like material at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (FORBIDDEN_MANIFEST_KEYS.has(normalizedKey(key))) {
      throw new Error(
        `experiment manifest contains forbidden credential field ${path}.${key}; ` +
          `${key} is not allowed`,
      );
    }
    assertNoCredentialMaterial(item, `${path}.${key}`);
  }
}

export function experimentManifestDigest(manifest: ExperimentManifest): string {
  return sha256Hex(canonicalStringify(manifest));
}

function validateExperimentManifestWithPolicy(
  input: unknown,
  allowLegacyDriverPolicy: boolean,
): ExperimentManifest {
  assertNoCredentialMaterial(input);
  const manifest = experimentManifestSchema.parse(input);
  if (manifest.provider.family !== "hermes") {
    throw new Error("Agent Lab harness requires the Hermes provider family");
  }
  const allowedProviderSettings = new Set([
    "decisionDeadlineMs",
    "inputMicrocentsPerToken",
    "outputMicrocentsPerToken",
    "hermesVersion",
    "hermesPythonVersion",
    "hermesOpenAiSdkVersion",
    "hermesMcpSdkVersion",
    "hermesStarletteVersion",
    "hermesAiohttpVersion",
    "providerEnvAllowlist",
  ]);
  const unknownProviderSetting = Object.keys(manifest.provider.settings).find(
    (key) => !allowedProviderSettings.has(key),
  );
  if (unknownProviderSetting !== undefined) {
    throw new Error(
      `experiment provider setting ${unknownProviderSetting} is not allowed`,
    );
  }
  const decisionDeadlineMs = manifest.provider.settings["decisionDeadlineMs"];
  if (
    !Number.isSafeInteger(decisionDeadlineMs) ||
    Number(decisionDeadlineMs) < 50 ||
    Number(decisionDeadlineMs) > 120_000
  ) {
    throw new Error(
      "experiment provider setting decisionDeadlineMs must be an integer from 50 to 120000",
    );
  }
  for (const key of [
    "inputMicrocentsPerToken",
    "outputMicrocentsPerToken",
  ] as const) {
    const value = manifest.provider.settings[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(
        `experiment provider setting ${key} must be a nonnegative safe integer`,
      );
    }
  }
  providerEnvironmentNames(manifest);
  for (const key of [
    "hermesVersion",
    "hermesPythonVersion",
    "hermesOpenAiSdkVersion",
    "hermesMcpSdkVersion",
    "hermesStarletteVersion",
    "hermesAiohttpVersion",
  ] as const) {
    const value = manifest.provider.settings[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`experiment provider setting ${key} must pin a version`);
    }
  }
  if (agentLabPromptDigest(manifest.prompt.bytes) !== manifest.prompt.digest) {
    throw new Error("experiment prompt bytes do not match their pinned digest");
  }
  const currentDriverPolicyDigest = agentLabDriverPolicyDigest(
    manifest.generationBudget,
  );
  if (manifest.driverPolicyDigest !== currentDriverPolicyDigest) {
    const legacyDriverPolicyDigest = agentLabLegacyDriverPolicyDigest(
      manifest.generationBudget,
    );
    if (
      !allowLegacyDriverPolicy ||
      manifest.driverPolicyDigest !== legacyDriverPolicyDigest
    ) {
      throw new Error(
        allowLegacyDriverPolicy
          ? "experiment driver policy does not match a supported archive digest"
          : "experiment driver policy must match the current stable_driver_v2 digest",
      );
    }
  }
  const definitions = new Map(
    AGENT_LAB_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema]),
  );
  for (const tool of manifest.tools) {
    const expected = definitions.get(tool.name);
    if (expected === undefined || canonicalStringify(tool.schema) !== canonicalStringify(expected)) {
      throw new Error(`experiment tool schema drifted for ${tool.name}`);
    }
    if (sha256Hex(canonicalStringify(tool.schema)) !== tool.digest) {
      throw new Error(`experiment tool digest is invalid for ${tool.name}`);
    }
  }
  const combinedDigest = sha256Hex(canonicalStringify(
    [...manifest.tools].sort((left, right) => compareCodeUnit(left.name, right.name)),
  ));
  if (combinedDigest !== agentLabToolSchemaDigest()) {
    throw new Error("experiment combined Agent Lab tool schema digest drifted");
  }
  return manifest;
}

export function validateExperimentManifest(input: unknown): ExperimentManifest {
  return validateExperimentManifestWithPolicy(input, false);
}

export interface ArchivedExperimentManifestValidation {
  readonly manifest: ExperimentManifest;
  readonly driverPolicyVersion: "stable_driver_v1" | "stable_driver_v2";
}

export function validateArchivedExperimentManifest(
  input: unknown,
): ArchivedExperimentManifestValidation {
  const manifest = validateExperimentManifestWithPolicy(input, true);
  return Object.freeze({
    manifest,
    driverPolicyVersion:
      manifest.driverPolicyDigest ===
        agentLabDriverPolicyDigest(manifest.generationBudget)
        ? "stable_driver_v2"
        : "stable_driver_v1",
  });
}

export function loadExperimentManifest(
  path: string,
  options: Readonly<{ allowArchivedDriverPolicy?: boolean }> = {},
): ExperimentManifest {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read experiment manifest ${absolute}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return options.allowArchivedDriverPolicy === true
    ? validateArchivedExperimentManifest(parsed).manifest
    : validateExperimentManifest(parsed);
}

export function planTrials(manifest: ExperimentManifest): readonly TrialPlan[] {
  const plans: TrialPlan[] = [];
  for (const seed of manifest.scenario.seeds) {
    for (const mode of ["native", "shadow", "external"] as const) {
      const attempts = manifest.attempts[mode];
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        plans.push(Object.freeze({
          studyId: manifest.studyId,
          trialId: `${manifest.studyId}-s${seed}-${mode}-a${attempt}`,
          mode,
          seed,
          attempt,
        }));
      }
    }
  }
  return Object.freeze(plans);
}
