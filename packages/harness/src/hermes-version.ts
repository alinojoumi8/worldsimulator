import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface HermesRuntimeVersion {
  readonly version: string;
  readonly pythonVersion: string;
  readonly openAiSdkVersion: string;
  readonly mcpSdkVersion: string;
  readonly starletteVersion: string;
  readonly aiohttpVersion: string;
}

interface HermesCliVersion {
  readonly version: string;
  readonly installDirectory: string;
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

function versionLines(output: string): readonly string[] {
  return output
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseHermesCliVersion(output: string): HermesCliVersion {
  const lines = versionLines(output);
  const version = lines[0];
  if (version === undefined || !version.startsWith("Hermes Agent ")) {
    throw new Error("Hermes --version returned an unrecognized version line");
  }
  return Object.freeze({
    version,
    installDirectory: requiredLine(
      lines,
      "Install directory:",
      "its install directory",
    ),
    pythonVersion: requiredLine(lines, "Python:", "its Python version"),
    openAiSdkVersion: requiredLine(lines, "OpenAI SDK:", "its OpenAI SDK version"),
  });
}

function hermesPythonExecutable(
  executable: string,
  installDirectory: string,
): string {
  const candidates = process.platform === "win32"
    ? [
        join(installDirectory, "venv", "Scripts", "python.exe"),
        ...(isAbsolute(executable)
          ? [join(dirname(executable), "python.exe")]
          : []),
      ]
    : [
        join(installDirectory, "venv", "bin", "python"),
        ...(isAbsolute(executable)
          ? [join(dirname(executable), "python")]
          : []),
      ];
  const python = candidates.find((candidate) => existsSync(candidate));
  if (python === undefined) {
    throw new Error(
      "Hermes runtime Python could not be located from its pinned install directory",
    );
  }
  return python;
}

export function parseHermesDependencyInspectionOutput(
  output: string,
): Readonly<{
  mcpSdkVersion: string;
  starletteVersion: string;
  aiohttpVersion: string;
}> {
  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = JSON.parse(
      output.trim().split(/\r?\n/).at(-1) ?? "",
    ) as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(
      "Hermes runtime dependency inspection did not return JSON; " +
        "ensure the pinned venv Python starts cleanly: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const required = (name: string): string => {
    const value = parsed[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Hermes runtime is missing required optional dependency ${name}; ` +
          "install the pinned Hermes MCP/API-server extras",
      );
    }
    return value;
  };
  return Object.freeze({
    mcpSdkVersion: required("mcp"),
    starletteVersion: required("starlette"),
    aiohttpVersion: required("aiohttp"),
  });
}

function inspectPythonPackages(
  executable: string,
  installDirectory: string,
): ReturnType<typeof parseHermesDependencyInspectionOutput> {
  const python = hermesPythonExecutable(executable, installDirectory);
  const script = [
    "import importlib.metadata as metadata",
    "import json",
    "result = {}",
    "for name in ('mcp', 'starlette', 'aiohttp'):",
    "    try:",
    "        result[name] = metadata.version(name)",
    "    except metadata.PackageNotFoundError:",
    "        result[name] = None",
    "print(json.dumps(result, sort_keys=True))",
  ].join("\n");
  const output = execFileSync(python, ["-c", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return parseHermesDependencyInspectionOutput(output);
}

export function inspectHermesRuntime(
  executable = process.env["HERMES_EXECUTABLE"] ?? "hermes",
): HermesRuntimeVersion {
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const cli = parseHermesCliVersion(output);
  return Object.freeze({
    version: cli.version,
    pythonVersion: cli.pythonVersion,
    openAiSdkVersion: cli.openAiSdkVersion,
    ...inspectPythonPackages(executable, cli.installDirectory),
  });
}
