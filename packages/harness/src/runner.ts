import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_LAB_PROTOCOL_VERSION,
  canonicalStringify,
  createSimulationResponseSchema,
  replaySimulationResponseSchema,
  simulationStatusResponseSchema,
  type AgentTurnEnvelope,
  type ExperimentManifest,
  type ReplayRun,
  type TrialArtifact,
} from "@worldtangle/shared";
import { buildApp } from "../../../apps/server/src/app";
import {
  openWorldDatabase,
  SqliteAgentLabStore,
} from "../../../apps/server/src/persistence";
import { writeTrialArtifact } from "./artifact";
import {
  agentLabToolSchemaDigest,
} from "./driver-policy";
import {
  HermesApiTurnDriver,
  HermesBudgetExceededError,
  HermesProfileFleet,
  type HermesTurnStats,
} from "./hermes";
import { inspectHermesRuntime } from "./hermes-version";
import { assertProviderEnvironmentAvailable } from "./provider-environment";
import {
  experimentManifestDigest,
  planTrials,
  type TrialPlan,
} from "./manifest";

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

interface TrialCredential {
  readonly agentId: string;
  readonly token: string;
  readonly credentialId: string;
}

export function assertFreshStudyDirectory(studyDirectory: string): void {
  const root = resolve(studyDirectory);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(
      `Agent Lab study directory is not empty: ${root}. ` +
        "Use a new directory so crashed or prior trials cannot contaminate the study.",
    );
  }
}

export interface RunStudyOptions {
  readonly studyDirectory: string;
  readonly allowDirty?: boolean;
  readonly keepRuntime?: boolean;
  readonly hermesExecutable?: string;
}

export interface StudyRunResult {
  readonly studyDirectory: string;
  readonly artifacts: readonly TrialArtifact[];
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function dirtyPaths(): string[] {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  }).split(/\r?\n/).filter((line) => line.length > 0);
}

function validateRuntimePins(
  manifest: ExperimentManifest,
  allowDirty: boolean,
  hermesExecutable?: string,
): string {
  const commit = currentCommit();
  if (commit !== manifest.engine.commit) {
    throw new Error(
      `manifest engine commit ${manifest.engine.commit} does not match checkout ${commit}`,
    );
  }
  const dirty = dirtyPaths();
  if (dirty.length > 0 && !allowDirty) {
    throw new Error(
      "Agent Lab trials require a clean checkout so the pinned engine commit describes " +
        `the executed bytes (${dirty.length} dirty path(s) found)`,
    );
  }
  const lockfile = resolve("pnpm-lock.yaml");
  const lockfileDigest = hashFile(lockfile);
  const pinnedLock = manifest.engine.dependencies["pnpm-lock-sha256"];
  if (pinnedLock !== lockfileDigest) {
    throw new Error("manifest pnpm-lock-sha256 does not match the current lockfile");
  }
  const pinnedNode = manifest.engine.dependencies["node"];
  if (pinnedNode !== process.version) {
    throw new Error(`manifest Node version ${pinnedNode ?? "missing"} is not ${process.version}`);
  }
  const hermes = inspectHermesRuntime(hermesExecutable);
  const hermesPins = {
    hermesVersion: hermes.version,
    hermesPythonVersion: hermes.pythonVersion,
    hermesOpenAiSdkVersion: hermes.openAiSdkVersion,
  } as const;
  for (const key of Object.keys(hermesPins) as Array<keyof typeof hermesPins>) {
    const current = hermesPins[key];
    const pinned = manifest.provider.settings[key];
    if (pinned !== current) {
      throw new Error(
        `manifest ${key} ${String(pinned ?? "missing")} does not match runtime ${current}`,
      );
    }
  }
  assertProviderEnvironmentAvailable(manifest);
  return lockfileDigest;
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  payload?: unknown,
  token?: string,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2_000) };
    }
  }
  return { status: response.status, body };
}

function requireStatus(response: JsonResponse, expected: number, operation: string): unknown {
  if (response.status !== expected) {
    throw new Error(
      `${operation} returned HTTP ${response.status}: ${canonicalStringify(response.body)}`,
    );
  }
  return response.body;
}

async function readTurn(
  baseUrl: string,
  token: string,
): Promise<AgentTurnEnvelope | null> {
  const response = await jsonRequest(
    baseUrl,
    "GET",
    "/api/v1/agent-lab/turn?waitMs=0",
    undefined,
    token,
  );
  const body = requireStatus(response, 200, "Agent Lab turn read") as {
    turn?: unknown;
  };
  return body.turn === null || body.turn === undefined
    ? null
    : body.turn as AgentTurnEnvelope;
}

async function driveExternalAdvance(
  advance: Promise<JsonResponse>,
  baseUrl: string,
  credentials: readonly TrialCredential[],
  driver: HermesApiTurnDriver,
  hermesRuns: HermesTurnStats[],
  drivenTurnIds: Set<string>,
  disabledAgentIds: Set<string>,
  revokeCredential: (credential: TrialCredential) => void,
): Promise<JsonResponse> {
  let settled = false;
  void advance.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const revokeAfterAdvance = new Map<string, TrialCredential>();
  while (!settled) {
    let drove = false;
    for (const credential of credentials) {
      if (disabledAgentIds.has(credential.agentId)) continue;
      const turn = await readTurn(baseUrl, credential.token);
      if (turn === null || drivenTurnIds.has(turn.turnId)) continue;
      drivenTurnIds.add(turn.turnId);
      try {
        const result = await driver.runTurn(turn);
        hermesRuns.push(result);
        if (result.budgetViolations.length > 0) {
          disabledAgentIds.add(credential.agentId);
          revokeAfterAdvance.set(credential.agentId, credential);
        }
      } catch (error) {
        disabledAgentIds.add(credential.agentId);
        if (error instanceof HermesBudgetExceededError) {
          hermesRuns.push(error.asStats());
        } else {
          hermesRuns.push(Object.freeze({
            runId: `failed:${turn.turnId}`,
            agentId: turn.agentId,
            targetTick: turn.targetTick,
            status: "failed",
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            budgetViolations: [],
            failure: error instanceof Error ? error.message : String(error),
          }));
        }
        revokeCredential(credential);
      }
      drove = true;
    }
    if (!drove) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const response = await advance;
  for (const credential of revokeAfterAdvance.values()) {
    revokeCredential(credential);
  }
  return response;
}

async function driveShadowTurns(
  baseUrl: string,
  credentials: readonly TrialCredential[],
  driver: HermesApiTurnDriver,
  hermesRuns: HermesTurnStats[],
  drivenTurnIds: Set<string>,
  disabledAgentIds: Set<string>,
  revokeCredential: (credential: TrialCredential) => void,
): Promise<void> {
  for (const credential of credentials) {
    if (disabledAgentIds.has(credential.agentId)) continue;
    while (!disabledAgentIds.has(credential.agentId)) {
      const turn = await readTurn(baseUrl, credential.token);
      if (turn === null) break;
      if (drivenTurnIds.has(turn.turnId)) {
        throw new Error(`shadow turn ${turn.turnId} remained open after it was driven`);
      }
      drivenTurnIds.add(turn.turnId);
      try {
        const result = await driver.runTurn(turn);
        hermesRuns.push(result);
        if (result.budgetViolations.length > 0) {
          disabledAgentIds.add(credential.agentId);
          revokeCredential(credential);
        }
      } catch (error) {
        disabledAgentIds.add(credential.agentId);
        if (error instanceof HermesBudgetExceededError) {
          hermesRuns.push(error.asStats());
        } else {
          hermesRuns.push(Object.freeze({
            runId: `failed:${turn.turnId}`,
            agentId: turn.agentId,
            targetTick: turn.targetTick,
            status: "failed",
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            budgetViolations: [],
            failure: error instanceof Error ? error.message : String(error),
          }));
        }
        revokeCredential(credential);
      }
    }
  }
}

async function waitForReplay(
  baseUrl: string,
  simulationId: string,
  replayRunId: string,
): Promise<ReplayRun> {
  const deadline = performance.now() + 900_000;
  while (performance.now() < deadline) {
    const response = await jsonRequest(
      baseUrl,
      "GET",
      `/api/v1/simulations/${simulationId}/status?runId=${replayRunId}`,
    );
    const body = simulationStatusResponseSchema.parse(
      requireStatus(response, 200, "replay status"),
    );
    if (
      body.replay !== undefined &&
      body.replay !== null &&
      body.replay.status !== "running"
    ) return body.replay;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`strict replay ${replayRunId} did not become terminal`);
}

async function runTrial(
  manifest: ExperimentManifest,
  plan: TrialPlan,
  studyRoot: string,
  lockfileDigest: string,
  options: RunStudyOptions,
): Promise<TrialArtifact> {
  const runtimeRoot = join(studyRoot, ".runtime", plan.trialId);
  const dataDir = join(runtimeRoot, "data");
  const artifactDirectory = join(studyRoot, "trials", plan.trialId);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  const startedWall = new Date().toISOString();
  const app = buildApp({
    dataDir,
    wallClock: () => new Date().toISOString(),
    tickIntervalMs: 60_000,
    enableNewsPipeline: true,
    webRoot: false,
  });
  const fleet = new HermesProfileFleet(runtimeRoot, options.hermesExecutable);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = new URL(address).origin;
    const manifestDigest = experimentManifestDigest(manifest);
    const create = await jsonRequest(baseUrl, "POST", "/api/v1/simulations", {
      name: `${manifest.scenario.name} (${plan.trialId})`,
      scenario: {
        worldSpec: manifest.scenario.worldSpec,
        seed: plan.seed,
        llmMode: "mock",
        budgets: manifest.scenario.budgets,
        policyOverrides: manifest.scenario.policyOverrides,
        endTick: manifest.scenario.ticks,
        agentLab: {
          protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
          studyId: manifest.studyId,
          trialId: plan.trialId,
          experimentManifestDigest: manifestDigest,
          mode: plan.mode,
          ...(plan.mode === "native"
            ? {}
            : {
                cohortSelection: {
                  ...manifest.cohort,
                  controller: plan.mode,
                },
              }),
          decisionDeadlineMs: Math.min(
            120_000,
            Math.max(50, Number(manifest.provider.settings["decisionDeadlineMs"] ?? 60_000)),
          ),
          budget: manifest.generationBudget,
          driverPolicyDigest: manifest.driverPolicyDigest,
          promptDigest: manifest.prompt.digest,
          toolSchemaDigest: agentLabToolSchemaDigest(),
        },
      },
    });
    const created = createSimulationResponseSchema.parse(
      requireStatus(create, 201, "simulation creation"),
    );
    const credentials: TrialCredential[] = [];
    if (plan.mode !== "native") {
      const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
      try {
        const store = new SqliteAgentLabStore(db, created.run.id);
        for (const assignment of store.config().resolvedAssignments) {
          credentials.push(store.issueCredential({
            agentId: assignment.agentId,
            createdWall: new Date().toISOString(),
          }));
        }
      } finally {
        db.close();
      }
    }
    let driver: HermesApiTurnDriver | undefined;
    if (credentials.length > 0) {
      const endpoints = await fleet.start(manifest, baseUrl, credentials);
      driver = new HermesApiTurnDriver(endpoints, manifest, manifest.prompt.bytes);
    }
    const disabledAgentIds = new Set<string>();
    const revokeCredential = (credential: TrialCredential): void => {
      if (disabledAgentIds.has(credential.agentId)) {
        const db = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
        try {
          const store = new SqliteAgentLabStore(db, created.run.id);
          try {
            store.revokeCredential(credential.credentialId, new Date().toISOString());
          } catch {
            // Idempotent harness cleanup: the credential may already be revoked.
          }
        } finally {
          db.close();
        }
      }
    };
    for (const control of ["start", "pause"] as const) {
      requireStatus(
        await jsonRequest(
          baseUrl,
          "POST",
          `/api/v1/simulations/${created.simulation.id}/${control}`,
          { runId: created.run.id },
        ),
        202,
        `simulation ${control}`,
      );
    }
    const drivenTurnIds = new Set<string>();
    const hermesRuns: HermesTurnStats[] = [];
    for (let tick = 1; tick <= manifest.scenario.ticks; tick += 1) {
      for (const intervention of manifest.interventions.filter(
        (candidate) => candidate.tick === tick,
      )) {
        requireStatus(
          await jsonRequest(
            baseUrl,
            "POST",
            `/api/v1/simulations/${created.simulation.id}/world-events`,
            {
              runId: created.run.id,
              type: intervention.type,
              params: intervention.params,
              scheduleTick: intervention.tick,
            },
          ),
          202,
          `intervention ${intervention.id}`,
        );
      }
      const advance = jsonRequest(
        baseUrl,
        "POST",
        `/api/v1/simulations/${created.simulation.id}/advance`,
        { runId: created.run.id, ticks: 1 },
      );
      const advanced = plan.mode === "external" && driver !== undefined
        ? await driveExternalAdvance(
            advance,
            baseUrl,
            credentials,
            driver,
            hermesRuns,
            drivenTurnIds,
            disabledAgentIds,
            revokeCredential,
          )
        : await advance;
      requireStatus(advanced, 200, `advance to tick ${tick}`);
      if (plan.mode === "shadow" && driver !== undefined) {
        await driveShadowTurns(
          baseUrl,
          credentials,
          driver,
          hermesRuns,
          drivenTurnIds,
          disabledAgentIds,
          revokeCredential,
        );
      }
    }
    const sourceDb = openWorldDatabase(dataDir, created.simulation.id, created.run.id);
    try {
      const store = new SqliteAgentLabStore(sourceDb, created.run.id);
      for (const credential of credentials) {
        try {
          store.revokeCredential(credential.credentialId, new Date().toISOString());
        } catch {
          // A terminal run may already have revoked or closed the credential.
        }
      }
    } finally {
      sourceDb.close();
    }

    // Prove replay is independent of Hermes by stopping every profile before
    // requesting the strict source-run replay.
    await fleet.stop();
    const replayAccepted = replaySimulationResponseSchema.parse(requireStatus(
      await jsonRequest(
        baseUrl,
        "POST",
        `/api/v1/simulations/${created.simulation.id}/runs/${created.run.id}/replay`,
        { mode: "strict" },
      ),
      202,
      "strict replay request",
    ));
    const replay = await waitForReplay(
      baseUrl,
      created.simulation.id,
      replayAccepted.replayRun.id,
    );
    const completedWall = new Date().toISOString();
    return writeTrialArtifact(manifest, plan, {
      dataDir,
      simulationId: created.simulation.id,
      runId: created.run.id,
      artifactDirectory,
      startedWall,
      completedWall,
      lockfileDigest,
      replay,
      hermesRuns,
    });
  } finally {
    await fleet.stop();
    await app.close();
    if (!options.keepRuntime) {
      rmSync(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

export async function runStudy(
  manifest: ExperimentManifest,
  options: RunStudyOptions,
): Promise<StudyRunResult> {
  const studyRoot = resolve(options.studyDirectory);
  const lockfileDigest = validateRuntimePins(
    manifest,
    options.allowDirty ?? false,
    options.hermesExecutable,
  );
  assertFreshStudyDirectory(studyRoot);
  mkdirSync(join(studyRoot, "trials"), { recursive: true });
  writeFileSync(
    join(studyRoot, "manifest.json"),
    `${canonicalStringify(manifest)}\n`,
    "utf8",
  );
  const artifacts: TrialArtifact[] = [];
  for (const plan of planTrials(manifest)) {
    artifacts.push(await runTrial(manifest, plan, studyRoot, lockfileDigest, options));
  }
  writeFileSync(
    join(studyRoot, "study-index.json"),
    `${canonicalStringify({
      schemaVersion: 1,
      studyId: manifest.studyId,
      manifestDigest: experimentManifestDigest(manifest),
      trials: artifacts.map((artifact) => ({
        trialId: artifact.trialId,
        mode: artifact.mode,
        seed: artifact.seed,
        attempt: artifact.attempt,
        tainted: artifact.taint.tainted,
        artifactHead: artifact.hashHeads.artifact,
      })),
    })}\n`,
    "utf8",
  );
  return { studyDirectory: studyRoot, artifacts: Object.freeze(artifacts) };
}
