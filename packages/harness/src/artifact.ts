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
  AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX,
  AGENT_LAB_TAINT_REASON_LIMIT,
  agentActionReceiptSchema,
  agentIdSchema,
  agentTurnEnvelopeSchema,
  canonicalParse,
  canonicalStringify,
  compareCodeUnit,
  eventEnvelopeSchema,
  experimentScorecardSchema,
  isAgentLabTerminalReceiptStatus,
  runManifestAgentLabSchema,
  sha256Hex,
  taintRecordSchema,
  trialArtifactSchema,
  type ExperimentManifest,
  type ExperimentScorecard,
  type ReplayRun,
  type RunManifestAgentLab,
  type TrialArtifact,
} from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import { z } from "zod";
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
import {
  expectedFixtureMatrixKeys,
  observedFixtureMatrixKeys,
} from "./fixture-matrix";
import {
  validateArchivedExperimentManifest,
  type TrialPlan,
} from "./manifest";
import {
  hermesTurnStatsSchema,
  type HermesTurnStats,
} from "./hermes";

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

function parseHermesTurnStatsEvidence(
  value: unknown,
  index: number,
): HermesTurnStats {
  const parsed = hermesTurnStatsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length === 0
      ? ""
      : ` at ${issue?.path.join(".")}`;
    throw new Error(
      `Hermes run ${index} evidence is invalid${location}: ` +
        (issue?.message ?? "schema validation failed"),
    );
  }
  return Object.freeze({
    ...parsed.data,
    budgetViolations: Object.freeze([...parsed.data.budgetViolations]),
  });
}

function parseHermesRunsForArtifact(
  values: readonly HermesTurnStats[],
  anomalies: string[],
): readonly HermesTurnStats[] {
  const parsed: HermesTurnStats[] = [];
  for (const [index, value] of values.entries()) {
    try {
      parsed.push(parseHermesTurnStatsEvidence(value, index));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      anomalies.push(`Hermes runtime evidence: ${detail}`.slice(0, 900));
    }
  }
  return Object.freeze(parsed);
}

function parseToolCallEvidence(
  path: string,
): readonly { readonly turnId: string | null; readonly agentId: string }[] {
  const identitySchema = z.strictObject({
    turnId: agentTurnEnvelopeSchema.shape.turnId.nullable(),
    agentId: agentIdSchema,
  });
  return parseJsonl(path).map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`tool call ${index} evidence is not an object`);
    }
    const record = row as Readonly<Record<string, unknown>>;
    const parsed = identitySchema.safeParse({
      turnId: record["turnId"],
      agentId: record["agentId"],
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      if (field === "turnId" || field === "agentId") {
        throw new Error(`tool call ${index} ${field} is invalid`);
      }
      throw new Error(`tool call ${index} identity is invalid`);
    }
    return Object.freeze(parsed.data);
  });
}

function fixtureScheduleFor(
  turns: readonly ReturnType<typeof agentTurnEnvelopeSchema.parse>[],
  receipts: readonly ReturnType<typeof agentActionReceiptSchema.parse>[],
): TrialArtifact["statistics"]["fixtureSchedule"] {
  const seenTurnIds = new Set<string>();
  for (const turn of turns) {
    if (seenTurnIds.has(turn.turnId)) {
      throw new Error(`duplicate turn envelope: ${turn.turnId}`);
    }
    seenTurnIds.add(turn.turnId);
  }
  const orphanReceiptTurnIds = [...new Set(
    receipts
      .filter((receipt) => !seenTurnIds.has(receipt.turnId))
      .map((receipt) => receipt.turnId),
  )].sort(compareCodeUnit);
  if (orphanReceiptTurnIds.length > 0) {
    throw new Error(
      `receipt references an unknown turn: ${orphanReceiptTurnIds.join(", ")}`,
    );
  }
  const statusesByTurn = new Map<
    string,
    Array<ReturnType<typeof agentActionReceiptSchema.parse>["status"]>
  >();
  for (const receipt of receipts) {
    const statuses = statusesByTurn.get(receipt.turnId) ?? [];
    statuses.push(receipt.status);
    statusesByTurn.set(receipt.turnId, statuses);
  }
  const receiptViolations: string[] = [];
  const receiptByTurn = new Map(
    [...statusesByTurn]
      .sort(([leftTurnId], [rightTurnId]) =>
        compareCodeUnit(leftTurnId, rightTurnId)
      )
      .map(([turnId, statuses]) => {
        const terminalStatuses = statuses
          .filter(isAgentLabTerminalReceiptStatus)
          .sort(compareCodeUnit);
        const distinctTerminalStatuses = [...new Set(terminalStatuses)];
        if (
          terminalStatuses.length > 1 &&
          distinctTerminalStatuses.length === 1
        ) {
          receiptViolations.push(
            `turn ${turnId} has duplicate terminal receipts: ` +
              terminalStatuses.join(", "),
          );
        } else if (distinctTerminalStatuses.length > 1) {
          receiptViolations.push(
            `turn ${turnId} has conflicting terminal receipts: ` +
              distinctTerminalStatuses.join(", "),
          );
        }
        return [turnId, distinctTerminalStatuses[0] ?? null] as const;
      }),
  );
  if (receiptViolations.length > 0) {
    throw new Error(receiptViolations.sort(compareCodeUnit).join("; "));
  }
  return turns
    .filter((turn) => turn.opportunityKey.startsWith(
      AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX,
    ))
    .map((turn) => ({
      agentId: turn.agentId,
      targetTick: turn.targetTick,
      turnId: turn.turnId,
      receiptStatus: receiptByTurn.get(turn.turnId) ?? null,
    }))
    .sort((left, right) => (
      left.targetTick - right.targetTick ||
      compareCodeUnit(left.agentId, right.agentId) ||
      compareCodeUnit(left.turnId, right.turnId)
    ));
}

function authoritativeFixtureScheduleFor(
  events: readonly ReturnType<typeof eventEnvelopeSchema.parse>[],
  expectedFixtureVersion: string | undefined,
): TrialArtifact["statistics"]["authoritativeFixtureSchedule"] {
  if (expectedFixtureVersion === undefined) return [];
  return events
    .filter((event) => event.type === "agent.goal.commitment_recorded")
    .map((event) => {
      if (
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) {
        throw new Error(`fixture event ${event.eventId} has a malformed payload`);
      }
      const payload = event.payload as Readonly<Record<string, unknown>>;
      const agentId = payload["agentId"];
      const fixtureVersion = payload["fixtureVersion"];
      const actionType = payload["actionType"];
      const opportunityKey = payload["opportunityKey"];
      if (
        typeof agentId !== "string" ||
        event.actor.kind !== "agent" ||
        event.actor.id !== agentId ||
        fixtureVersion !== expectedFixtureVersion ||
        typeof opportunityKey !== "string" ||
        !opportunityKey.startsWith(AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX)
      ) {
        throw new Error(
          `fixture event ${event.eventId} is not pinned to an authenticated slot`,
        );
      }
      if (
        actionType !== "agent.reaffirm_goal" &&
        actionType !== "agent.defer_goal"
      ) {
        throw new Error(
          `fixture event ${event.eventId} has an unrecognized action type`,
        );
      }
      const authenticatedActionType:
        | "agent.reaffirm_goal"
        | "agent.defer_goal" = actionType;
      return {
        agentId,
        targetTick: event.tick,
        eventId: event.eventId,
        actionType: authenticatedActionType,
        opportunityKey,
      };
    })
    .sort((left, right) => (
      left.targetTick - right.targetTick ||
      compareCodeUnit(left.agentId, right.agentId) ||
      compareCodeUnit(left.eventId, right.eventId)
    ));
}

function fixtureHermesEvidenceFor(
  turns: readonly ReturnType<typeof agentTurnEnvelopeSchema.parse>[],
  hermesRuns: readonly HermesTurnStats[],
  toolCalls: readonly {
    readonly turnId: string | null;
    readonly agentId: string;
  }[],
): TrialArtifact["statistics"]["fixtureHermesEvidenceSchedule"] {
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const runsByTurnId = new Map<string, HermesTurnStats>();
  for (const run of hermesRuns) {
    if (run.turnId === undefined) continue;
    const turn = turnsById.get(run.turnId);
    if (turn === undefined) {
      throw new Error(`Hermes evidence references an unknown turn: ${run.turnId}`);
    }
    if (runsByTurnId.has(run.turnId)) {
      throw new Error(`duplicate Hermes evidence for turn: ${run.turnId}`);
    }
    if (
      run.opportunityKey !== turn.opportunityKey ||
      run.agentId !== turn.agentId ||
      run.targetTick !== turn.targetTick
    ) {
      throw new Error(`Hermes evidence does not match turn: ${run.turnId}`);
    }
    runsByTurnId.set(run.turnId, run);
  }
  const toolCallsByTurnId = new Map<string, number>();
  for (const toolCall of toolCalls) {
    if (toolCall.turnId === null) continue;
    const turn = turnsById.get(toolCall.turnId);
    if (turn === undefined) {
      throw new Error(
        `tool-call evidence references an unknown turn: ${toolCall.turnId}`,
      );
    }
    if (turn.agentId !== toolCall.agentId) {
      throw new Error(
        `tool-call evidence does not match turn: ${toolCall.turnId}`,
      );
    }
    toolCallsByTurnId.set(
      toolCall.turnId,
      (toolCallsByTurnId.get(toolCall.turnId) ?? 0) + 1,
    );
  }
  return turns
    .filter((turn) => turn.opportunityKey.startsWith(
      AGENT_LAB_GOAL_COMMITMENT_OPPORTUNITY_PREFIX,
    ))
    .flatMap((turn) => {
      const run = runsByTurnId.get(turn.turnId);
      return run === undefined
        ? []
        : [{
            agentId: turn.agentId,
            targetTick: turn.targetTick,
            turnId: turn.turnId,
            hermesRunId: run.runId,
            status: run.status,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            toolCalls: toolCallsByTurnId.get(turn.turnId) ?? 0,
            budgetViolationCount: run.budgetViolations.length,
          }];
    })
    .sort((left, right) => (
      left.targetTick - right.targetTick ||
      compareCodeUnit(left.agentId, right.agentId) ||
      compareCodeUnit(left.turnId, right.turnId)
    ));
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
  const terminal = rows.receipts.filter((receipt) =>
    isAgentLabTerminalReceiptStatus(receipt.status)
  );
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

function captureArtifactEvidence<T>(
  label: string,
  anomalies: string[],
  collect: () => T,
  fallback: T,
): T {
  try {
    return collect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    anomalies.push(`${label}: ${detail}`.slice(0, 900));
    return fallback;
  }
}

function captureVerificationEvidence<T>(
  label: string,
  issues: string[],
  collect: () => T,
): T | undefined {
  try {
    return collect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push(`${label} is invalid: ${detail}`);
    return undefined;
  }
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
    const evidenceAnomalies: string[] = [];
    const hermesRuns = parseHermesRunsForArtifact(
      input.hermesRuns,
      evidenceAnomalies,
    );
    const score = scorecard(
      manifest,
      plan,
      { ...input, hermesRuns },
      rows,
      db,
    );
    const hermesInputTokens = hermesRuns.reduce(
      (sum, run) => sum + run.inputTokens,
      0,
    );
    const hermesOutputTokens = hermesRuns.reduce(
      (sum, run) => sum + run.outputTokens,
      0,
    );
    const hermesCostMicrocents =
      BigInt(hermesInputTokens) *
        BigInt(Number(manifest.provider.settings["inputMicrocentsPerToken"])) +
      BigInt(hermesOutputTokens) *
        BigInt(Number(manifest.provider.settings["outputMicrocentsPerToken"]));
    const agentLabConfig = captureArtifactEvidence<RunManifestAgentLab | null>(
      "Agent Lab config evidence",
      evidenceAnomalies,
      () => store.config(),
      null,
    );
    const cohortAgentIds = (agentLabConfig?.resolvedAssignments ?? [])
      .map((assignment) => assignment.agentId)
      .sort(compareCodeUnit);
    const persistedEvents = events.list();
    const fixtureSchedule = captureArtifactEvidence(
      "fixture turn and receipt evidence",
      evidenceAnomalies,
      () => fixtureScheduleFor(rows.turns, rows.receipts),
      [],
    );
    const authoritativeFixtureSchedule = captureArtifactEvidence(
      "authoritative fixture event evidence",
      evidenceAnomalies,
      () => authoritativeFixtureScheduleFor(
        persistedEvents,
        manifest.scenario.opportunityFixture?.version,
      ),
      [],
    );
    const fixtureHermesEvidenceSchedule = captureArtifactEvidence(
      "fixture Hermes evidence",
      evidenceAnomalies,
      () => fixtureHermesEvidenceFor(
        rows.turns,
        hermesRuns,
        rows.toolCalls,
      ),
      [],
    );
    const artifactCorruptionReason = evidenceAnomalies.length === 0
      ? []
      : [{
          code: "artifact_corrupt" as const,
          detail: evidenceAnomalies.join("; ").slice(0, 1_000),
          recordedWall: input.completedWall,
        }];
    const reasonSlotsBeforeOmissionMarker =
      AGENT_LAB_TAINT_REASON_LIMIT - artifactCorruptionReason.length;
    const needsOmissionMarker =
      rows.taint.reasons.length > reasonSlotsBeforeOmissionMarker;
    const retainedReasonLimit = Math.max(
      0,
      reasonSlotsBeforeOmissionMarker - (needsOmissionMarker ? 1 : 0),
    );
    const retainedTaintReasons = rows.taint.reasons.slice(
      0,
      retainedReasonLimit,
    );
    const omittedReasonCount =
      rows.taint.reasons.length - retainedTaintReasons.length;
    const omissionReason = omittedReasonCount === 0
      ? []
      : [{
          code: "artifact_corrupt" as const,
          detail:
            `${omittedReasonCount} later taint reason(s) were omitted to preserve ` +
            `the ${AGENT_LAB_TAINT_REASON_LIMIT}-reason artifact limit`,
          recordedWall: input.completedWall,
        }];
    const artifactTaint = taintRecordSchema.parse({
      tainted:
        rows.taint.tainted ||
        evidenceAnomalies.length > 0 ||
        omittedReasonCount > 0,
      reasons: [
        ...retainedTaintReasons,
        ...omissionReason,
        ...artifactCorruptionReason,
      ],
    });
    const statistics = {
      turns: rows.turns.length,
      terminalReceipts: rows.receipts.filter((receipt) =>
        isAgentLabTerminalReceiptStatus(receipt.status)
      ).length,
      fixtureTurns: fixtureSchedule.length,
      fixtureTerminalReceipts: fixtureSchedule.filter((entry) => (
        isAgentLabTerminalReceiptStatus(entry.receiptStatus)
      )).length,
      cohortAgentIds,
      fixtureSchedule,
      authoritativeFixtureSchedule,
      fixtureHermesEvidenceSchedule,
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
      latencyMs: hermesRuns.reduce((sum, run) => sum + run.latencyMs, 0),
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
      taint: artifactTaint,
    };
    writeCanonicalJson(join(input.artifactDirectory, "manifest.json"), manifest);
    writeCanonicalJson(join(input.artifactDirectory, "runtime.json"), {
      simulationId: input.simulationId,
      runId: input.runId,
      replay: input.replay,
      lockfileDigest: input.lockfileDigest,
      externallyInfluenced: rows.externallyInfluenced,
      agentLabConfig,
      hermesRuns,
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
    writeJsonl(join(input.artifactDirectory, "events.jsonl"), persistedEvents);
    writeCanonicalJson(join(input.artifactDirectory, "scorecard.json"), score);
    writeCanonicalJson(join(input.artifactDirectory, "taint.json"), artifactTaint);
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
  let persistedManifest: ExperimentManifest | undefined;
  let runtimeConfig: RunManifestAgentLab | undefined;
  let runtimeHermesRuns: readonly HermesTurnStats[] | undefined;
  let runtimeBudgetViolationCount: number | undefined;
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
    const rawManifest = canonicalParse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    );
    persistedManifest = validateArchivedExperimentManifest(rawManifest);
    if (
      sha256Hex(canonicalStringify(rawManifest)) !==
      artifact.manifestDigest
    ) {
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
    const runtimeValue = canonicalParse(
      readFileSync(join(root, "runtime.json"), "utf8"),
    );
    if (
      typeof runtimeValue !== "object" ||
      runtimeValue === null ||
      Array.isArray(runtimeValue)
    ) {
      throw new Error("runtime.json is not a JSON object");
    }
    const runtime = runtimeValue as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(runtime, "agentLabConfig")) {
      issues.push("runtime evidence is missing agentLabConfig");
    } else {
      const parsedConfig = runManifestAgentLabSchema.safeParse(
        runtime["agentLabConfig"],
      );
      if (parsedConfig.success) {
        runtimeConfig = parsedConfig.data;
      } else {
        issues.push(
          `runtime Agent Lab config is invalid: ${parsedConfig.error.message}`,
        );
      }
    }
    if (
      runtimeConfig !== undefined &&
      (
        runtimeConfig.studyId !== artifact.studyId ||
        runtimeConfig.trialId !== artifact.trialId ||
        runtimeConfig.mode !== artifact.mode ||
        runtimeConfig.experimentManifestDigest !== artifact.manifestDigest
      )
    ) {
      issues.push("runtime Agent Lab config does not match artifact identity");
    }
    if (
      runtimeConfig !== undefined &&
      persistedManifest !== undefined &&
      canonicalStringify(runtimeConfig.opportunityFixture ?? null) !==
      canonicalStringify(persistedManifest.scenario.opportunityFixture ?? null)
    ) {
      issues.push("runtime Agent Lab fixture does not match the pinned manifest");
    }
    const runs = runtime["hermesRuns"];
    if (!Array.isArray(runs)) {
      issues.push("runtime Hermes runs is not an array");
    } else {
      const parsedRuns: HermesTurnStats[] = [];
      let allRunsValid = true;
      for (const [index, run] of runs.entries()) {
        if (typeof run !== "object" || run === null) {
          issues.push(`Hermes run ${index} evidence is not an object`);
          allRunsValid = false;
          continue;
        }
        const violations = (run as Readonly<Record<string, unknown>>)[
          "budgetViolations"
        ];
        if (!Array.isArray(violations)) {
          issues.push(`Hermes run ${index} budgetViolations is not an array`);
          allRunsValid = false;
          continue;
        }
        try {
          parsedRuns.push(parseHermesTurnStatsEvidence(run, index));
        } catch (error) {
          allRunsValid = false;
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (allRunsValid) {
        runtimeHermesRuns = Object.freeze(parsedRuns);
        runtimeBudgetViolationCount = parsedRuns.reduce(
          (sum, run) => sum + run.budgetViolations.length,
          0,
        );
      }
    }
  } catch (error) {
    issues.push(`runtime evidence is invalid: ${String(error)}`);
  }
  const turns = captureVerificationEvidence(
    "turn evidence",
    issues,
    () => parseJsonl(join(root, "agent-lab-turns.jsonl"))
      .map((row) => agentTurnEnvelopeSchema.parse(row)),
  );
  const receipts = captureVerificationEvidence(
    "receipt evidence",
    issues,
    () => parseJsonl(join(root, "agent-lab-receipts.jsonl"))
      .map((row) => agentActionReceiptSchema.parse(row)),
  );
  const persistedEvents = captureVerificationEvidence(
    "event evidence",
    issues,
    () => parseJsonl(join(root, "events.jsonl"))
      .map((row) => eventEnvelopeSchema.parse(row)),
  );
  const toolCalls = captureVerificationEvidence(
    "tool-call evidence",
    issues,
    () => parseToolCallEvidence(join(root, "agent-lab-tool-calls.jsonl")),
  );
  const resolvedCohort = runtimeConfig?.resolvedAssignments
    .map((assignment) => assignment.agentId)
    .sort(compareCodeUnit);
  const uniqueFixtureTicks = persistedManifest === undefined
    ? undefined
    : [...new Set(persistedManifest.scenario.opportunityFixture?.ticks ?? [])];
  if (persistedManifest !== undefined && runtimeConfig === undefined) {
    issues.push(
      "fixture matrix was not verified because runtime Agent Lab config is unavailable",
    );
  }
  if (turns !== undefined && artifact.statistics.turns !== turns.length) {
    issues.push("artifact turn count does not match turn evidence");
  }
  if (receipts !== undefined) {
    const terminalReceipts = receipts.filter(
      (receipt) => isAgentLabTerminalReceiptStatus(receipt.status),
    ).length;
    if (artifact.statistics.terminalReceipts !== terminalReceipts) {
      issues.push("artifact terminal receipt count does not match receipt evidence");
    }
  }
  if (
    resolvedCohort !== undefined &&
    canonicalStringify(artifact.statistics.cohortAgentIds) !==
      canonicalStringify(resolvedCohort)
  ) {
    issues.push("artifact cohort does not match runtime Agent Lab config");
  }
  if (turns !== undefined && receipts !== undefined) {
    const terminalTurnIds = new Set(
      receipts
        .filter((receipt) => isAgentLabTerminalReceiptStatus(receipt.status))
        .map((receipt) => receipt.turnId),
    );
    const nonTerminalTurnIds = turns
      .filter((turn) => !terminalTurnIds.has(turn.turnId))
      .map((turn) => turn.turnId)
      .sort(compareCodeUnit);
    if (nonTerminalTurnIds.length > 0) {
      issues.push(
        `${nonTerminalTurnIds.length} turn(s) have no terminal receipt: ` +
          nonTerminalTurnIds.slice(0, 10).join(", "),
      );
    }
    const observedSchedule = captureVerificationEvidence(
      "fixture turn and receipt evidence",
      issues,
      () => fixtureScheduleFor(turns, receipts),
    );
    if (observedSchedule !== undefined) {
      const fixtureTerminalReceipts = observedSchedule.filter((entry) => (
        isAgentLabTerminalReceiptStatus(entry.receiptStatus)
      )).length;
      if (artifact.statistics.fixtureTurns !== observedSchedule.length) {
        issues.push("artifact fixture turn count does not match turn evidence");
      }
      if (
        artifact.statistics.fixtureTerminalReceipts !==
        fixtureTerminalReceipts
      ) {
        issues.push(
          "artifact fixture terminal receipt count does not match receipt evidence",
        );
      }
      if (
        canonicalStringify(observedSchedule) !==
        canonicalStringify(artifact.statistics.fixtureSchedule)
      ) {
        issues.push(
          "artifact fixture schedule does not match turn and receipt evidence",
        );
      }
      if (uniqueFixtureTicks !== undefined && resolvedCohort !== undefined) {
        const expectedScheduleKeys = artifact.mode === "native"
          ? []
          : expectedFixtureMatrixKeys(uniqueFixtureTicks, resolvedCohort);
        const observedScheduleKeys = observedFixtureMatrixKeys(observedSchedule);
        if (
          canonicalStringify(observedScheduleKeys) !==
          canonicalStringify(expectedScheduleKeys)
        ) {
          issues.push(
            "observed fixture schedule does not match the pinned citizen/tick matrix",
          );
        }
      }
    }
  }
  if (persistedEvents !== undefined && persistedManifest !== undefined) {
    const observedAuthoritativeSchedule = captureVerificationEvidence(
      "authoritative fixture event evidence",
      issues,
      () => authoritativeFixtureScheduleFor(
        persistedEvents,
        persistedManifest.scenario.opportunityFixture?.version,
      ),
    );
    if (observedAuthoritativeSchedule !== undefined) {
      if (
        canonicalStringify(observedAuthoritativeSchedule) !==
        canonicalStringify(artifact.statistics.authoritativeFixtureSchedule)
      ) {
        issues.push(
          "artifact authoritative fixture schedule does not match event evidence",
        );
      }
      if (uniqueFixtureTicks !== undefined && resolvedCohort !== undefined) {
        // Native trials have no Agent Lab sidecar turns, but their deterministic
        // Tier-1 fixture choices still produce authoritative commitment events.
        const authoritativeScheduleKeys = observedFixtureMatrixKeys(
          observedAuthoritativeSchedule,
        );
        const expectedAuthoritativeScheduleKeys = expectedFixtureMatrixKeys(
          uniqueFixtureTicks,
          resolvedCohort,
        );
        if (
          canonicalStringify(authoritativeScheduleKeys) !==
          canonicalStringify(expectedAuthoritativeScheduleKeys)
        ) {
          issues.push(
            "authoritative fixture schedule does not match the pinned citizen/tick matrix",
          );
        }
      }
    }
  }
  if (
    turns !== undefined &&
    runtimeHermesRuns !== undefined &&
    toolCalls !== undefined
  ) {
    const observedHermesEvidenceSchedule = captureVerificationEvidence(
      "fixture Hermes evidence",
      issues,
      () => fixtureHermesEvidenceFor(turns, runtimeHermesRuns, toolCalls),
    );
    if (
      observedHermesEvidenceSchedule !== undefined &&
      canonicalStringify(observedHermesEvidenceSchedule) !==
        canonicalStringify(artifact.statistics.fixtureHermesEvidenceSchedule)
    ) {
      issues.push(
        "artifact fixture Hermes schedule does not match runtime and tool-call evidence",
      );
    }
  }
  if (persistedManifest !== undefined && resolvedCohort !== undefined) {
    if (resolvedCohort.length !== persistedManifest.cohort.size) {
      issues.push(
        `runtime cohort has ${resolvedCohort.length} citizens; ` +
        `manifest pins ${persistedManifest.cohort.size}`,
      );
    }
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
    if (canonicalStringify(taint) !== canonicalStringify(artifact.taint)) {
      issues.push("artifact taint does not match taint evidence");
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
    const budgetViolationMetric = score.operational.find(
      (metric) => metric.metricId === "budget_violations",
    );
    if (invariantMetric?.value !== 1) issues.push("structural invariants did not pass");
    if (replayMetric?.value !== 0) issues.push("strict replay has divergences");
    if (unauthorizedMetric?.value !== 0) issues.push("an unauthorized action was applied");
    if (
      runtimeBudgetViolationCount !== undefined &&
      budgetViolationMetric?.value !== runtimeBudgetViolationCount
    ) {
      issues.push(
        "scorecard budget violation count does not match runtime Hermes evidence",
      );
    }
  } catch (error) {
    issues.push(`scorecard or taint evidence is invalid: ${String(error)}`);
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
