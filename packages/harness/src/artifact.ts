import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { basename, join, relative, resolve } from "node:path";
import {
  agentActionReceiptSchema,
  agentTurnEnvelopeSchema,
  canonicalParse,
  canonicalStringify,
  experimentScorecardSchema,
  sha256Hex,
  taintRecordSchema,
  trialArtifactSchema,
  type ExperimentManifest,
  type ExperimentScorecard,
  type ReplayRun,
  type TrialArtifact,
} from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteAgentLabStore,
  SqliteEventStore,
  SqliteLlmCallStore,
  SqliteLlmResponseCache,
  worldDatabasePath,
} from "../../../apps/server/src/persistence";
import { readRunInvariantSnapshot } from "../../../apps/server/src/testing/run-invariant-probe";
import type { TrialPlan } from "./manifest";
import type { HermesTurnStats } from "./hermes";

export interface ArtifactRuntimeInput {
  readonly dataDir: string;
  readonly simulationId: string;
  readonly runId: string;
  readonly artifactDirectory: string;
  readonly startedWall: string;
  readonly completedWall: string;
  readonly lockfileDigest: string;
  readonly replay: ReplayRun;
  readonly hermesRuns: readonly HermesTurnStats[];
}

export interface ArtifactVerification {
  readonly valid: boolean;
  readonly artifactDirectory: string;
  readonly issues: readonly string[];
  readonly artifact?: TrialArtifact;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeCanonicalJson(path: string, value: unknown): void {
  writeFileSync(path, `${canonicalStringify(value)}\n`, "utf8");
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  const body = rows.map((row) => canonicalStringify(row)).join("\n");
  writeFileSync(path, body.length === 0 ? "" : `${body}\n`, "utf8");
}

function parseJsonl(path: string): unknown[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0
    ? []
    : text.split(/\r?\n/).map((line) => canonicalParse(line));
}

function lastIndicator(
  db: ReturnType<typeof openWorldDatabase>,
  runId: string,
  key: string,
): number | null {
  const row = db.prepare<[string, string], { value_integer: string }>(`
    SELECT value_integer
    FROM indicator_points
    WHERE run_id = ? AND indicator_key = ?
    ORDER BY tick DESC
    LIMIT 1
  `).get(runId, key);
  if (row === undefined) return null;
  const value = Number(row.value_integer);
  return Number.isFinite(value) ? value : null;
}

function scorecard(
  manifest: ExperimentManifest,
  plan: TrialPlan,
  input: ArtifactRuntimeInput,
  rows: ReturnType<SqliteAgentLabStore["artifactRows"]>,
  db: ReturnType<typeof openWorldDatabase>,
): ExperimentScorecard {
  const invariants = checkInvariants(readRunInvariantSnapshot(db, input.runId));
  const terminal = rows.receipts.filter((receipt) => receipt.status !== "queued");
  const accepted = terminal.filter((receipt) =>
    receipt.status === "applied" || receipt.status === "shadowed"
  ).length;
  const fallbacks = terminal.filter((receipt) => receipt.status === "fallback").length;
  const validityRateBp = terminal.length === 0
    ? null
    : Math.floor((accepted * 10_000) / terminal.length);
  const fallbackRateBp = terminal.length === 0
    ? null
    : Math.floor((fallbacks * 10_000) / terminal.length);
  return experimentScorecardSchema.parse({
    schemaVersion: 1,
    studyId: manifest.studyId,
    trialId: plan.trialId,
    structural: [
      {
        metricId: "invariants_pass",
        value: invariants.passed ? 1 : 0,
        unit: "boolean",
        evidence: invariants.violations.map((violation) => violation.invariant),
      },
      {
        metricId: "replay_divergences",
        value: input.replay.divergenceCount,
        unit: "count",
        evidence: input.replay.firstDivergence === null
          ? ["strict replay completed without a first divergence"]
          : [canonicalStringify(input.replay.firstDivergence)],
      },
      {
        metricId: "privacy_boundary_rejections",
        value: rows.receipts.filter((receipt) =>
          receipt.validatorResults.some((result) =>
            result.code === "PERMISSION_DENIED" || result.code === "POLICY_MISMATCH"
          )
        ).length,
        unit: "count",
        evidence: ["agent-lab-receipts.jsonl"],
      },
      {
        metricId: "unauthorized_applied_actions",
        value: rows.receipts.filter((receipt) =>
          receipt.status === "applied" &&
          receipt.validatorResults.some((result) => !result.ok)
        ).length,
        unit: "count",
        evidence: ["agent-lab-receipts.jsonl"],
      },
    ],
    behavioral: [
      {
        metricId: "persona_counterfactual_consistency",
        value: null,
        unit: "unscored",
        evidence: ["requires a separately manifested counterfactual condition"],
      },
      {
        metricId: "plan_continuity",
        value: null,
        unit: "unscored",
        evidence: ["structured-plan condition is not enabled in this trial"],
      },
      {
        metricId: "cited_memory_use",
        value: rows.turns.filter((turn) => turn.observation.citedMemories.length > 0).length,
        unit: "turns",
        evidence: ["agent-lab-turns.jsonl"],
      },
    ],
    social: [
      {
        metricId: "relationship_diffusion",
        value: null,
        unit: "unscored",
        evidence: ["relationship-diffusion condition is not enabled in this trial"],
      },
    ],
    economic: [
      {
        metricId: "unemployment_rate_bp",
        value: lastIndicator(db, input.runId, "unemployment_rate_bp"),
        unit: "basis_points",
        evidence: ["indicator_points:unemployment_rate_bp"],
      },
      {
        metricId: "cpi_index",
        value: lastIndicator(db, input.runId, "cpi_index"),
        unit: "index",
        evidence: ["indicator_points:cpi_index"],
      },
      {
        metricId: "loan_defaults",
        value: Number(db.prepare<[string], { count: bigint }>(`
          SELECT COUNT(*) AS count
          FROM loans
          WHERE run_id = ? AND status = 'defaulted'
        `).get(input.runId)?.count ?? 0n),
        unit: "count",
        evidence: ["loans:status=defaulted"],
      },
    ],
    operational: [
      {
        metricId: "validity_rate_bp",
        value: validityRateBp,
        unit: "basis_points",
        evidence: ["agent-lab-receipts.jsonl"],
      },
      {
        metricId: "fallback_rate_bp",
        value: fallbackRateBp,
        unit: "basis_points",
        evidence: ["agent-lab-receipts.jsonl"],
      },
      {
        metricId: "hermes_latency_ms",
        value: input.hermesRuns.reduce((sum, run) => sum + run.latencyMs, 0),
        unit: "milliseconds",
        evidence: ["runtime.json"],
      },
      {
        metricId: "hermes_input_tokens",
        value: input.hermesRuns.reduce((sum, run) => sum + run.inputTokens, 0),
        unit: "tokens",
        evidence: ["runtime.json"],
      },
      {
        metricId: "hermes_output_tokens",
        value: input.hermesRuns.reduce((sum, run) => sum + run.outputTokens, 0),
        unit: "tokens",
        evidence: ["runtime.json"],
      },
      {
        metricId: "hermes_failed_runs",
        value: input.hermesRuns.filter((run) => run.status !== "completed").length,
        unit: "runs",
        evidence: ["runtime.json"],
      },
      {
        metricId: "budget_violations",
        value: input.hermesRuns.reduce(
          (sum, run) => sum + run.budgetViolations.length,
          0,
        ),
        unit: "violations",
        evidence: ["runtime.json"],
      },
    ],
  });
}

function detectAndRecordTaint(
  db: ReturnType<typeof openWorldDatabase>,
  runId: string,
  manifest: ExperimentManifest,
  completedWall: string,
): void {
  const store = new SqliteAgentLabStore(db, runId);
  const current = store.artifactRows().taint;
  if (current.tainted) return;
  const actualInterventions = db.prepare<
    [string],
    {
      type: string;
      params_canonical: string;
      scheduled_tick: number;
    }
  >(`
    SELECT type, params_canonical, scheduled_tick
    FROM world_events
    WHERE run_id = ? AND source = 'admin'
    ORDER BY scheduled_tick, type, params_canonical
  `).all(runId).map((row) => canonicalStringify({
    type: row.type,
    params: canonicalParse(row.params_canonical),
    tick: Number(row.scheduled_tick),
  })).sort();
  const expectedInterventions = manifest.interventions
    .map((intervention) => canonicalStringify({
      type: intervention.type,
      params: intervention.params,
      tick: intervention.tick,
    }))
    .sort();
  if (
    canonicalStringify(actualInterventions) !==
    canonicalStringify(expectedInterventions)
  ) {
    store.markTainted(
      "unmanifested_intervention",
      "admin intervention bytes or schedule differ from the canonical manifest",
      completedWall,
    );
  }
  const allowed = new Set(["create", "start", "pause", "advance", "world_event.inject"]);
  const commands = new SqliteEventStore(db, runId).list({
    type: "admin.command.received",
  });
  const unrecognized = commands.find((event) => {
    const payload = event.payload as Readonly<Record<string, unknown>>;
    return typeof payload["command"] !== "string" || !allowed.has(payload["command"]);
  });
  if (unrecognized !== undefined) {
    store.markTainted(
      "manual_input",
      `unmanifested admin command at event ${unrecognized.eventId}`,
      completedWall,
    );
  }
}

function markdownReport(
  artifact: Omit<TrialArtifact, "files" | "hashHeads">,
  score: ExperimentScorecard,
  replay: ReplayRun,
): string {
  const metricRows = [
    ...score.structural,
    ...score.behavioral,
    ...score.social,
    ...score.economic,
    ...score.operational,
  ].map((metric) =>
    `| ${metric.metricId} | ${metric.value === null ? "not scored" : metric.value} | ` +
      `${metric.unit} |`
  );
  return [
    `# Agent Lab trial ${artifact.trialId}`,
    "",
    `Mode: ${artifact.mode}  `,
    `Seed: ${artifact.seed}  `,
    `Attempt: ${artifact.attempt}  `,
    `Tainted: ${artifact.taint.tainted ? "yes" : "no"}  `,
    `Replay: ${replay.status}, ${replay.divergenceCount} divergence(s)`,
    "",
    "| Metric | Value | Unit |",
    "|---|---:|---|",
    ...metricRows,
    "",
    "This is evidence from a fictional simulated world. It is not a financial, legal,",
    "political, or real-world prediction.",
    "",
  ].join("\n");
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return files.sort();
}

export function writeTrialArtifact(
  manifest: ExperimentManifest,
  plan: TrialPlan,
  input: ArtifactRuntimeInput,
): TrialArtifact {
  mkdirSync(input.artifactDirectory, { recursive: true });
  const db = openWorldDatabase(input.dataDir, input.simulationId, input.runId);
  let artifact: TrialArtifact;
  try {
    detectAndRecordTaint(db, input.runId, manifest, input.completedWall);
    const store = new SqliteAgentLabStore(db, input.runId);
    const rows = store.artifactRows();
    const events = new SqliteEventStore(db, input.runId);
    const llm = new SqliteLlmCallStore(db, input.runId).summary();
    const cache = new SqliteLlmResponseCache(db, input.runId).exportArtifact();
    const score = scorecard(manifest, plan, input, rows, db);
    const hermesInputTokens = input.hermesRuns.reduce(
      (sum, run) => sum + run.inputTokens,
      0,
    );
    const hermesOutputTokens = input.hermesRuns.reduce(
      (sum, run) => sum + run.outputTokens,
      0,
    );
    const hermesCostMicrocents =
      BigInt(hermesInputTokens) *
        BigInt(Number(manifest.provider.settings["inputMicrocentsPerToken"])) +
      BigInt(hermesOutputTokens) *
        BigInt(Number(manifest.provider.settings["outputMicrocentsPerToken"]));
    const statistics = {
      turns: rows.turns.length,
      terminalReceipts: rows.receipts.filter((receipt) => receipt.status !== "queued").length,
      validSubmissions: rows.receipts.filter((receipt) =>
        receipt.status === "applied" || receipt.status === "shadowed"
      ).length,
      rejectedSubmissions: rows.receipts.filter((receipt) =>
        receipt.status === "rejected" || receipt.status === "stale"
      ).length,
      fallbacks: rows.receipts.filter((receipt) => receipt.status === "fallback").length,
      toolCalls: rows.toolCalls.length,
      inputTokens: llm.inputTokens + hermesInputTokens,
      outputTokens: llm.outputTokens + hermesOutputTokens,
      costMicrocents: (BigInt(llm.costMicrocents) + hermesCostMicrocents).toString(),
      latencyMs: input.hermesRuns.reduce((sum, run) => sum + run.latencyMs, 0),
    };
    const artifactBase = {
      schemaVersion: 1 as const,
      studyId: manifest.studyId,
      trialId: plan.trialId,
      mode: plan.mode,
      seed: plan.seed,
      attempt: plan.attempt,
      manifestDigest: sha256Hex(canonicalStringify(manifest)),
      runtime: {
        engineCommit: manifest.engine.commit,
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        startedWall: input.startedWall,
        completedWall: input.completedWall,
      },
      statistics,
      taint: rows.taint,
    };
    writeCanonicalJson(join(input.artifactDirectory, "manifest.json"), manifest);
    writeCanonicalJson(join(input.artifactDirectory, "runtime.json"), {
      simulationId: input.simulationId,
      runId: input.runId,
      replay: input.replay,
      lockfileDigest: input.lockfileDigest,
      externallyInfluenced: rows.externallyInfluenced,
      hermesRuns: input.hermesRuns,
    });
    writeJsonl(join(input.artifactDirectory, "agent-lab-turns.jsonl"), rows.turns);
    writeJsonl(
      join(input.artifactDirectory, "agent-lab-submissions.jsonl"),
      rows.submissions,
    );
    writeJsonl(
      join(input.artifactDirectory, "agent-lab-receipts.jsonl"),
      rows.receipts,
    );
    writeJsonl(
      join(input.artifactDirectory, "agent-lab-tool-calls.jsonl"),
      rows.toolCalls,
    );
    writeJsonl(join(input.artifactDirectory, "events.jsonl"), events.list());
    writeCanonicalJson(join(input.artifactDirectory, "scorecard.json"), score);
    writeCanonicalJson(join(input.artifactDirectory, "taint.json"), rows.taint);
    writeCanonicalJson(join(input.artifactDirectory, "replay.json"), input.replay);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const databasePath = worldDatabasePath(
      input.dataDir,
      input.simulationId,
      input.runId,
    );
    writeFileSync(
      join(input.artifactDirectory, "run.db.gz"),
      gzipSync(readFileSync(databasePath), { level: 9 }),
    );
    writeFileSync(
      join(input.artifactDirectory, "report.md"),
      markdownReport(artifactBase, score, input.replay),
      "utf8",
    );
    const files = Object.fromEntries(
      collectFiles(input.artifactDirectory)
        .filter((path) => path !== "artifact.json")
        .map((path) => [path, fileHash(join(input.artifactDirectory, path))]),
    );
    artifact = trialArtifactSchema.parse({
      ...artifactBase,
      files,
      hashHeads: {
        eventLog: events.logHash(),
        state: computeLogicalStateHash(db, input.runId),
        cache: cache.digest,
        prompt: manifest.prompt.digest,
        artifact: sha256Hex(canonicalStringify(files)),
      },
    });
    writeCanonicalJson(join(input.artifactDirectory, "artifact.json"), artifact);
  } finally {
    db.close();
  }
  return artifact;
}

function secretLeak(buffer: Buffer): boolean {
  const text = buffer.toString("latin1");
  return /wtpat_[A-Za-z0-9._-]{20,}/.test(text) ||
    /authorization\s*:\s*bearer\s+[A-Za-z0-9._-]{16,}/i.test(text) ||
    /\b(?:sk|api)[-_][A-Za-z0-9_-]{24,}\b/i.test(text);
}

export function verifyTrialArtifact(directory: string): ArtifactVerification {
  const root = resolve(directory);
  const issues: string[] = [];
  let artifact: TrialArtifact | undefined;
  try {
    artifact = trialArtifactSchema.parse(
      canonicalParse(readFileSync(join(root, "artifact.json"), "utf8")),
    );
  } catch (error) {
    return {
      valid: false,
      artifactDirectory: root,
      issues: [`artifact.json is invalid: ${error instanceof Error ? error.message : error}`],
    };
  }
  for (const [path, expected] of Object.entries(artifact.files)) {
    const absolute = join(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      issues.push(`missing artifact file: ${path}`);
      continue;
    }
    const buffer = readFileSync(absolute);
    if (fileHash(absolute) !== expected) issues.push(`checksum mismatch: ${path}`);
    if (secretLeak(buffer)) issues.push(`credential-like material found: ${path}`);
  }
  const unexpected = collectFiles(root).filter(
    (path) => path !== "artifact.json" && artifact?.files[path] === undefined,
  );
  issues.push(...unexpected.map((path) => `unmanifested artifact file: ${path}`));
  if (artifact.hashHeads.artifact !== sha256Hex(canonicalStringify(artifact.files))) {
    issues.push("artifact hash-chain head does not match the file manifest");
  }
  try {
    const manifest = canonicalParse(readFileSync(join(root, "manifest.json"), "utf8"));
    if (sha256Hex(canonicalStringify(manifest)) !== artifact.manifestDigest) {
      issues.push("manifest digest drift");
    }
  } catch {
    issues.push("manifest.json cannot be parsed canonically");
  }
  try {
    gunzipSync(readFileSync(join(root, "run.db.gz")));
  } catch {
    issues.push("compressed run database is corrupt");
  }
  try {
    const turns = parseJsonl(join(root, "agent-lab-turns.jsonl"))
      .map((row) => agentTurnEnvelopeSchema.parse(row));
    const receipts = parseJsonl(join(root, "agent-lab-receipts.jsonl"))
      .map((row) => agentActionReceiptSchema.parse(row));
    const terminalTurnIds = new Set(
      receipts.filter((receipt) => receipt.status !== "queued").map((receipt) => receipt.turnId),
    );
    for (const turn of turns) {
      if (!terminalTurnIds.has(turn.turnId)) {
        issues.push(`turn has no terminal receipt: ${turn.turnId}`);
      }
    }
  } catch (error) {
    issues.push(
      `turn or receipt evidence is invalid: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    const taint = taintRecordSchema.parse(
      canonicalParse(readFileSync(join(root, "taint.json"), "utf8")),
    );
    if (taint.tainted) {
      issues.push(
        `trial is tainted: ${taint.reasons.map((reason) => reason.code).join(", ")}`,
      );
    }
    const score = experimentScorecardSchema.parse(
      canonicalParse(readFileSync(join(root, "scorecard.json"), "utf8")),
    );
    const invariantMetric = score.structural.find(
      (metric) => metric.metricId === "invariants_pass",
    );
    const replayMetric = score.structural.find(
      (metric) => metric.metricId === "replay_divergences",
    );
    const unauthorizedMetric = score.structural.find(
      (metric) => metric.metricId === "unauthorized_applied_actions",
    );
    if (invariantMetric?.value !== 1) issues.push("structural invariants did not pass");
    if (replayMetric?.value !== 0) issues.push("strict replay has divergences");
    if (unauthorizedMetric?.value !== 0) issues.push("an unauthorized action was applied");
  } catch (error) {
    issues.push(`scorecard or taint evidence is invalid: ${String(error)}`);
  }
  try {
    const runtime = canonicalParse(
      readFileSync(join(root, "runtime.json"), "utf8"),
    ) as Readonly<Record<string, unknown>>;
    const runs = runtime["hermesRuns"];
    if (!Array.isArray(runs)) throw new Error("hermesRuns is not an array");
    for (const run of runs) {
      if (typeof run !== "object" || run === null) {
        throw new Error("Hermes run evidence is not an object");
      }
      const violations = (run as Readonly<Record<string, unknown>>)["budgetViolations"];
      if (!Array.isArray(violations)) {
        throw new Error("Hermes run budgetViolations is not an array");
      }
      for (const violation of violations) {
        issues.push(`Hermes budget violation: ${String(violation)}`);
      }
    }
  } catch (error) {
    issues.push(`runtime evidence is invalid: ${String(error)}`);
  }
  return {
    valid: issues.length === 0,
    artifactDirectory: root,
    issues: Object.freeze(issues),
    artifact,
  };
}

export function artifactLabel(directory: string): string {
  return basename(resolve(directory));
}
