import { execFileSync } from "node:child_process";

export interface HermesRuntimeVersion {
  readonly version: string;
  readonly pythonVersion: string;
  readonly openAiSdkVersion: string;
}

function requiredLine(
  lines: readonly string[],
  prefix: string,
  label: string,
): string {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Hermes --version did not report ${label}`);
  }
  return value;
}

export function parseHermesVersionOutput(output: string): HermesRuntimeVersion {
  const lines = output
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const version = lines[0];
  if (version === undefined || !version.startsWith("Hermes Agent ")) {
    throw new Error("Hermes --version returned an unrecognized version line");
  }
  return Object.freeze({
    version,
    pythonVersion: requiredLine(lines, "Python:", "its Python version"),
    openAiSdkVersion: requiredLine(lines, "OpenAI SDK:", "its OpenAI SDK version"),
  });
}

export function inspectHermesRuntime(
  executable = process.env["HERMES_EXECUTABLE"] ?? "hermes",
): HermesRuntimeVersion {
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return parseHermesVersionOutput(output);
}
