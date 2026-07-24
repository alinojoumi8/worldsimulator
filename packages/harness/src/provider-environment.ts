import type { ExperimentManifest } from "@worldtangle/shared";

const PROVIDER_ENV_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;
const FORBIDDEN_PROVIDER_ENV = new Set([
  "API_SERVER_KEY",
  "HERMES_HOME",
  "HERMES_MAX_ITERATIONS",
  "HERMES_MAX_TOKENS",
  "WT_AGENT_LAB_PAT",
]);

export function providerEnvironmentNames(
  manifest: ExperimentManifest,
): readonly string[] {
  const raw = manifest.provider.settings["providerEnvAllowlist"];
  if (typeof raw !== "string") {
    throw new Error("experiment providerEnvAllowlist must be a comma-separated string");
  }
  const names = [...new Set(
    raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0),
  )].sort();
  if (
    names.length === 0 ||
    names.length > 20 ||
    names.some((name) =>
      !PROVIDER_ENV_PATTERN.test(name) || FORBIDDEN_PROVIDER_ENV.has(name)
    )
  ) {
    throw new Error("experiment providerEnvAllowlist contains an invalid environment name");
  }
  return Object.freeze(names);
}

export function assertProviderEnvironmentAvailable(
  manifest: ExperimentManifest,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const missing = providerEnvironmentNames(manifest).filter((name) => {
    const value = environment[name];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `manifest-pinned provider environment is unavailable: ${missing.join(", ")}`,
    );
  }
}
