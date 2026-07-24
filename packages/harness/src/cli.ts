import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyTrialArtifact } from "./artifact";
import { writePilotManifest } from "./create-manifest";
import { loadExperimentManifest } from "./manifest";
import { reportStudy } from "./report";
import { runStudy } from "./runner";

interface Arguments {
  readonly command: string;
  readonly values: Readonly<Record<string, string | boolean>>;
}

export function parseArguments(argv: readonly string[]): Arguments {
  const command = argv[0] ?? "";
  const values: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === "--") continue;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const name = item.slice(2);
    if (name === "allow-dirty" || name === "keep-runtime") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`argument --${name} requires a value`);
    }
    values[name] = value;
    index += 1;
  }
  return { command, values };
}

function required(values: Arguments["values"], name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requiredNonnegativeInteger(
  values: Arguments["values"],
  name: string,
): number {
  const raw = required(values, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a nonnegative safe integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "init") {
    const destination = writePilotManifest(
      required(args.values, "out"),
      {
        studyId: required(args.values, "study-id"),
        model: required(args.values, "model"),
        inputMicrocentsPerToken: requiredNonnegativeInteger(
          args.values,
          "input-microcents-per-token",
        ),
        outputMicrocentsPerToken: requiredNonnegativeInteger(
          args.values,
          "output-microcents-per-token",
        ),
        providerEnvAllowlist: required(args.values, "provider-env"),
        ...(typeof args.values["hermes-executable"] === "string"
          ? { hermesExecutable: args.values["hermes-executable"] }
          : {}),
      },
    );
    process.stdout.write(`${JSON.stringify({ manifest: destination })}\n`);
    return;
  }
  if (args.command === "run") {
    const manifestPath = required(args.values, "manifest");
    const manifest = loadExperimentManifest(manifestPath);
    const studyDirectory = typeof args.values["out"] === "string"
      ? resolve(args.values["out"])
      : resolve("artifacts", "agent-lab", manifest.studyId);
    const result = await runStudy(manifest, {
      studyDirectory,
      allowDirty: args.values["allow-dirty"] === true,
      keepRuntime: args.values["keep-runtime"] === true,
      ...(typeof args.values["hermes-executable"] === "string"
        ? { hermesExecutable: args.values["hermes-executable"] }
        : {}),
    });
    process.stdout.write(`${JSON.stringify({
      studyDirectory: result.studyDirectory,
      trials: result.artifacts.length,
    })}\n`);
    return;
  }
  if (args.command === "verify") {
    const result = verifyTrialArtifact(required(args.values, "artifact"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (args.command === "report") {
    const report = reportStudy(required(args.values, "study"));
    process.stdout.write(`${JSON.stringify({
      studyId: report.studyId,
      trials: report.trialCount,
      valid: report.validTrialCount,
      tainted: report.taintedTrialCount,
      releaseEligible: report.releaseGate.eligible,
    })}\n`);
    return;
  }
  throw new Error(
    "usage: cli.ts init --out <file> --study-id <id> --model <model> " +
      "--provider-env <NAME[,NAME]> --input-microcents-per-token <int> " +
      "--output-microcents-per-token <int> [--hermes-executable <path>] | " +
      "run --manifest <file> [--out <directory>] [--hermes-executable <path>] | " +
      "verify --artifact <directory> | report --study <directory>",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
