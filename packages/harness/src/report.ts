import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PILOT_FIXTURE_TICKS,
  canonicalParse,
  canonicalStringify,
  compareCodeUnit,
  experimentScorecardSchema,
  isAgentLabTerminalReceiptStatus,
  trialArtifactSchema,
  type AgentLabMode,
  type ExperimentManifest,
} from "@worldtangle/shared";
import { verifyTrialArtifact } from "./artifact";
import {
  expectedFixtureMatrixKeys,
  observedFixtureMatrixKeys,
} from "./fixture-matrix";
import {
  experimentManifestDigest,
  validateExperimentManifest,
} from "./manifest";

interface MetricAggregate {
  readonly metricId: string;
  readonly unit: string;
  readonly count: number;
  readonly mean: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
}

interface ArmSummary {
  readonly mode: AgentLabMode;
  readonly includedTrials: number;
  readonly excludedTrials: number;
  readonly vectors: Readonly<Record<string, readonly MetricAggregate[]>>;
}

export interface StudyReport {
  readonly schemaVersion: 1;
  readonly studyId: string;
  readonly generatedWall: string;
  readonly manifestDigest: string;
  readonly trialCount: number;
  readonly validTrialCount: number;
  readonly taintedTrialCount: number;
  readonly invalidTrialCount: number;
  readonly arms: readonly ArmSummary[];
  readonly releaseGate: {
    readonly eligible: boolean;
    readonly issues: readonly string[];
  };
}

function aggregateMetrics(
  rows: readonly {
    metricId: string;
    unit: string;
    value: number | null;
  }[],
): readonly MetricAggregate[] {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.metricId}\u0000${row.unit}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const values = group
      .map((row) => row.value)
      .filter((value): value is number => value !== null);
    return Object.freeze({
      metricId: first.metricId,
      unit: first.unit,
      count: values.length,
      mean: values.length === 0
        ? null
        : values.reduce((sum, value) => sum + value, 0) / values.length,
      minimum: values.length === 0 ? null : Math.min(...values),
      maximum: values.length === 0 ? null : Math.max(...values),
    });
  }).sort((left, right) =>
    left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0
  );
}

export interface ReleaseTrialEvidence {
  readonly artifact: ReturnType<typeof trialArtifactSchema.parse>;
  readonly valid: boolean;
  readonly score: ReturnType<typeof experimentScorecardSchema.parse>;
}

function cohortEvidenceIssues(
  trial: ReleaseTrialEvidence,
  expectedSize: number,
): string[] {
  const issues: string[] = [];
  const cohort = trial.artifact.statistics.cohortAgentIds;
  if (cohort.length !== expectedSize) {
    issues.push(
      `${trial.artifact.trialId} recorded ${cohort.length} cohort citizens; ` +
      `expected ${expectedSize}`,
    );
  }
  if (new Set(cohort).size !== cohort.length) {
    issues.push(`${trial.artifact.trialId} recorded duplicate cohort citizens`);
  }
  if (canonicalStringify(cohort) !== canonicalStringify([...cohort].sort(compareCodeUnit))) {
    issues.push(`${trial.artifact.trialId} recorded a noncanonical cohort order`);
  }
  return issues;
}

function turnEvidenceIssues(trial: ReleaseTrialEvidence): string[] {
  const issues: string[] = [];
  if (
    trial.artifact.mode === "native" &&
    (
      trial.artifact.statistics.turns !== 0 ||
      trial.artifact.statistics.terminalReceipts !== 0 ||
      trial.artifact.statistics.fixtureTurns !== 0 ||
      trial.artifact.statistics.fixtureTerminalReceipts !== 0 ||
      trial.artifact.statistics.toolCalls !== 0 ||
      trial.artifact.statistics.fixtureSchedule.length !== 0 ||
      trial.artifact.statistics.fixtureHermesEvidenceSchedule.length !== 0
    )
  ) {
    issues.push(
      `${trial.artifact.trialId} native artifact contains Agent Lab sidecar evidence`,
    );
  }
  if (
    trial.artifact.statistics.terminalReceipts <
      trial.artifact.statistics.turns
  ) {
    issues.push(`${trial.artifact.trialId} has a nonterminal Agent Lab turn`);
  }
  if (
    trial.artifact.statistics.terminalReceipts >
      trial.artifact.statistics.turns
  ) {
    issues.push(
      `${trial.artifact.trialId} recorded ` +
        `${trial.artifact.statistics.terminalReceipts} terminal receipts for ` +
        `${trial.artifact.statistics.turns} Agent Lab turns`,
    );
  }
  if (trial.artifact.statistics.toolCalls < trial.artifact.statistics.turns) {
    issues.push(
      `${trial.artifact.trialId} recorded fewer Hermes tool calls than Agent Lab turns`,
    );
  }
  return issues;
}

function matchesFixtureMatrix(
  entries: readonly {
    readonly agentId: string;
    readonly targetTick: number;
  }[],
  identities: readonly string[],
  expectedCount: number,
  expectedKeys: readonly string[],
): boolean {
  let actualKeys: readonly string[];
  try {
    actualKeys = observedFixtureMatrixKeys(entries);
  } catch {
    return false;
  }
  return entries.length === expectedCount &&
    new Set(identities).size === entries.length &&
    new Set(actualKeys).size === actualKeys.length &&
    canonicalStringify(actualKeys) === canonicalStringify(expectedKeys);
}

function nonNativeFixtureEvidenceIssues(
  trial: ReleaseTrialEvidence,
  expectedTicks: readonly number[],
  expectedCohort: readonly string[],
  expectedCohortSize: number,
): string[] {
  const issues: string[] = [];
  if (expectedCohort.length !== expectedCohortSize) {
    issues.push(
      `${trial.artifact.trialId} cannot verify pinned fixture turns ` +
      `against a ${expectedCohort.length}-citizen cohort`,
    );
    return issues;
  }
  const uniqueExpectedTicks = [...new Set(expectedTicks)];
  if (uniqueExpectedTicks.length !== expectedTicks.length) {
    issues.push(`${trial.artifact.trialId} has a pinned fixture tick list with duplicates`);
    return issues;
  }
  const expectedAgentTurns = expectedCohortSize * uniqueExpectedTicks.length;
  if (expectedAgentTurns <= 0) {
    issues.push(`${trial.artifact.trialId} has no pinned fixture turns to verify`);
    return issues;
  }
  if (trial.artifact.statistics.fixtureTurns !== expectedAgentTurns) {
    issues.push(
      `${trial.artifact.trialId} recorded ` +
        `${trial.artifact.statistics.fixtureTurns} scheduled fixture turns; ` +
        `expected ${expectedAgentTurns}`,
    );
  }
  if (trial.artifact.statistics.fixtureTerminalReceipts !== expectedAgentTurns) {
    issues.push(
      `${trial.artifact.trialId} recorded ` +
        `${trial.artifact.statistics.fixtureTerminalReceipts} terminal fixture receipts; ` +
      `expected ${expectedAgentTurns}`,
    );
  }
  const schedule = trial.artifact.statistics.fixtureSchedule;
  const expectedKeys = expectedFixtureMatrixKeys(
    uniqueExpectedTicks,
    expectedCohort,
  );
  if (!matchesFixtureMatrix(
    schedule,
    schedule.map((entry) => entry.turnId),
    expectedAgentTurns,
    expectedKeys,
  )) {
    issues.push(
      `${trial.artifact.trialId} fixture schedule does not match the pinned ` +
      "citizen/tick matrix",
    );
  }
  if (schedule.some((entry) => (
    !isAgentLabTerminalReceiptStatus(entry.receiptStatus)
  ))) {
    issues.push(`${trial.artifact.trialId} fixture schedule has a nonterminal receipt`);
  }
  const hermesEvidence = trial.artifact.statistics.fixtureHermesEvidenceSchedule;
  const hermesEvidenceKeys = observedFixtureMatrixKeys(hermesEvidence);
  const fixtureTurnIds = schedule.map((entry) => entry.turnId);
  const hermesEvidenceTurnIds = hermesEvidence.map((entry) => entry.turnId);
  if (
    hermesEvidence.length !== expectedAgentTurns ||
    new Set(hermesEvidenceKeys).size !== hermesEvidenceKeys.length ||
    new Set(hermesEvidenceTurnIds).size !== hermesEvidenceTurnIds.length ||
    canonicalStringify(hermesEvidenceKeys) !== canonicalStringify(expectedKeys) ||
    canonicalStringify(hermesEvidenceTurnIds) !== canonicalStringify(fixtureTurnIds)
  ) {
    issues.push(
      `${trial.artifact.trialId} Hermes evidence does not cover every ` +
        "pinned fixture turn",
    );
  }
  if (hermesEvidence.some((entry) => entry.status !== "completed")) {
    issues.push(
      `${trial.artifact.trialId} has noncompleted per-turn Hermes evidence`,
    );
  }
  if (hermesEvidence.some((entry) => (
    entry.inputTokens <= 0 || entry.outputTokens <= 0
  ))) {
    issues.push(
      `${trial.artifact.trialId} has incomplete per-turn Hermes token evidence`,
    );
  }
  if (hermesEvidence.some((entry) => entry.toolCalls <= 0)) {
    issues.push(
      `${trial.artifact.trialId} has a fixture turn without Hermes tool evidence`,
    );
  }
  if (hermesEvidence.some((entry) => entry.budgetViolationCount > 0)) {
    issues.push(
      `${trial.artifact.trialId} has a per-turn Hermes budget violation`,
    );
  }
  const hermesInputTokens = trial.score.operational.find(
    (metric) => metric.metricId === "hermes_input_tokens",
  );
  const hermesOutputTokens = trial.score.operational.find(
    (metric) => metric.metricId === "hermes_output_tokens",
  );
  if (
    hermesInputTokens?.value === null ||
    hermesInputTokens?.value === undefined ||
    hermesInputTokens.value <= 0 ||
    hermesOutputTokens?.value === null ||
    hermesOutputTokens?.value === undefined ||
    hermesOutputTokens.value <= 0
  ) {
    issues.push(`${trial.artifact.trialId} has no real Hermes token evidence`);
  }
  const failedHermesRuns = trial.score.operational.find(
    (metric) => metric.metricId === "hermes_failed_runs",
  );
  if (failedHermesRuns?.value !== 0) {
    issues.push(`${trial.artifact.trialId} has failed or missing Hermes run evidence`);
  }
  return issues;
}

function authoritativeFixtureEvidenceIssues(
  trial: ReleaseTrialEvidence,
  expectedTicks: readonly number[],
  expectedCohort: readonly string[],
  expectedCohortSize: number,
): string[] {
  const issues: string[] = [];
  const uniqueExpectedTicks = [...new Set(expectedTicks)];
  const expectedAgentTurns = expectedCohortSize * uniqueExpectedTicks.length;
  const schedule = trial.artifact.statistics.authoritativeFixtureSchedule;
  const expectedKeys = expectedFixtureMatrixKeys(
    uniqueExpectedTicks,
    expectedCohort,
  );
  if (
    expectedCohort.length !== expectedCohortSize ||
    expectedAgentTurns <= 0 ||
    !matchesFixtureMatrix(
      schedule,
      schedule.map((entry) => entry.eventId),
      expectedAgentTurns,
      expectedKeys,
    )
  ) {
    issues.push(
      `${trial.artifact.trialId} authoritative fixture events do not match ` +
        "the pinned citizen/tick matrix",
    );
  }
  return issues;
}

export function releaseIssues(
  manifest: ExperimentManifest,
  trials: readonly ReleaseTrialEvidence[],
): string[] {
  const issues: string[] = [];
  const studyManifestDigest = experimentManifestDigest(manifest);
  const frozenSeeds = new Set(manifest.scenario.seeds);
  if (manifest.scenario.seeds.length !== 3) {
    issues.push("production pilot requires exactly three frozen seeds");
  }
  if (manifest.scenario.ticks !== 60) {
    issues.push("production pilot requires exactly 60 ticks");
  }
  const opportunityFixture = manifest.scenario.opportunityFixture;
  if (
    opportunityFixture?.version !== AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION ||
    opportunityFixture.ticks.length !== AGENT_LAB_PILOT_FIXTURE_TICKS.length ||
    opportunityFixture.ticks.some(
      (tick, index) => tick !== AGENT_LAB_PILOT_FIXTURE_TICKS[index],
    )
  ) {
    issues.push(
      "production pilot requires the goal-commitment fixture " +
        `${AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION} at ticks ` +
        AGENT_LAB_PILOT_FIXTURE_TICKS.join(", "),
    );
  }
  if (manifest.cohort.size !== 8 || manifest.cohort.strategy !== "stable_stratified_v1") {
    issues.push("production pilot requires eight stable-stratified citizens");
  }
  if (
    manifest.attempts.native !== 1 ||
    manifest.attempts.shadow !== 3 ||
    manifest.attempts.external !== 3
  ) {
    issues.push("production pilot requires 1 native, 3 shadow, and 3 active attempts per seed");
  }
  const expectedTrialCount = manifest.scenario.seeds.length * (
    manifest.attempts.native +
    manifest.attempts.shadow +
    manifest.attempts.external
  );
  if (trials.length !== expectedTrialCount) {
    issues.push(
      `production pilot requires ${expectedTrialCount} artifacts, received ${trials.length}`,
    );
  }
  const seenTrialIds = new Set<string>();
  for (const trial of trials) {
    if (seenTrialIds.has(trial.artifact.trialId)) {
      issues.push(`duplicate trial artifact ${trial.artifact.trialId}`);
    }
    seenTrialIds.add(trial.artifact.trialId);
  }
  for (const seed of manifest.scenario.seeds) {
    for (const mode of ["native", "shadow", "external"] as const) {
      const expected = manifest.attempts[mode];
      const matching = trials.filter(
        (trial) => trial.artifact.seed === seed && trial.artifact.mode === mode,
      );
      if (matching.length !== expected) {
        issues.push(
          `seed ${seed} requires ${expected} ${mode} artifacts, received ${matching.length}`,
        );
      }
      const expectedAttempts = Array.from(
        { length: expected },
        (_, index) => index + 1,
      );
      const actualAttempts = matching
        .map((trial) => trial.artifact.attempt)
        .sort((left, right) => left - right);
      if (canonicalStringify(actualAttempts) !== canonicalStringify(expectedAttempts)) {
        issues.push(
          `seed ${seed} ${mode} artifacts do not cover attempts ` +
          expectedAttempts.join(", "),
        );
      }
    }
  }
  const cohortBySeed = new Map<number, readonly string[]>();
  for (const seed of manifest.scenario.seeds) {
    const seedTrials = trials
      .filter((trial) => trial.artifact.seed === seed)
      .sort((left, right) =>
        compareCodeUnit(left.artifact.trialId, right.artifact.trialId)
      );
    const distinctCohorts = new Set(
      seedTrials.map((trial) =>
        canonicalStringify(trial.artifact.statistics.cohortAgentIds)
      ),
    );
    if (distinctCohorts.size > 1) {
      issues.push(`seed ${seed} trials do not share one resolved cohort`);
    }
    const baseline = seedTrials.find((trial) => (
      trial.artifact.mode === "native" &&
      trial.artifact.attempt === 1
    )) ?? seedTrials[0];
    if (baseline !== undefined) {
      cohortBySeed.set(seed, baseline.artifact.statistics.cohortAgentIds);
    }
  }
  for (const trial of trials) {
    if (trial.artifact.studyId !== manifest.studyId) {
      issues.push(
        `${trial.artifact.trialId} belongs to study ${trial.artifact.studyId}; ` +
        `expected ${manifest.studyId}`,
      );
    }
    if (trial.artifact.manifestDigest !== studyManifestDigest) {
      issues.push(
        `${trial.artifact.trialId} manifest digest does not match the study manifest`,
      );
    }
    if (!frozenSeeds.has(trial.artifact.seed)) {
      issues.push(
        `${trial.artifact.trialId} uses seed ${trial.artifact.seed}, ` +
          "which is not a frozen study seed",
      );
      continue;
    }
    if (!trial.valid) issues.push(`${trial.artifact.trialId} failed artifact verification`);
    if (trial.artifact.taint.tainted) issues.push(`${trial.artifact.trialId} is tainted`);
    issues.push(...cohortEvidenceIssues(trial, manifest.cohort.size));
    issues.push(...turnEvidenceIssues(trial));
    const replay = trial.score.structural.find(
      (metric) => metric.metricId === "replay_divergences",
    );
    if (replay?.value !== 0) {
      issues.push(`${trial.artifact.trialId} did not achieve zero-divergence replay`);
    }
    const invariants = trial.score.structural.find(
      (metric) => metric.metricId === "invariants_pass",
    );
    if (trial.artifact.mode === "external" && invariants?.value !== 1) {
      issues.push(`${trial.artifact.trialId} failed active invariant checks`);
    }
    const unauthorized = trial.score.structural.find(
      (metric) => metric.metricId === "unauthorized_applied_actions",
    );
    if (trial.artifact.mode === "external" && unauthorized?.value !== 0) {
      issues.push(`${trial.artifact.trialId} applied an unauthorized action`);
    }
    const expectedCohort = cohortBySeed.get(trial.artifact.seed) ?? [];
    issues.push(...authoritativeFixtureEvidenceIssues(
      trial,
      opportunityFixture?.ticks ?? [],
      expectedCohort,
      manifest.cohort.size,
    ));
    if (trial.artifact.mode !== "native") {
      const native = trials.find((candidate) => (
        candidate.artifact.seed === trial.artifact.seed &&
        candidate.artifact.mode === "native" &&
        candidate.artifact.attempt === 1
      ));
      if (native === undefined) {
        issues.push(
          `${trial.artifact.trialId} has no native attempt-1 artifact to match against`,
        );
        issues.push(
          `${trial.artifact.trialId} fixture matrix was not verified because ` +
            "the native attempt-1 cohort is unavailable",
        );
      } else {
        if (
          canonicalStringify(trial.artifact.statistics.cohortAgentIds) !==
          canonicalStringify(expectedCohort)
        ) {
          issues.push(`${trial.artifact.trialId} does not use the native matched cohort`);
        }
        issues.push(...nonNativeFixtureEvidenceIssues(
          trial,
          opportunityFixture?.ticks ?? [],
          expectedCohort,
          manifest.cohort.size,
        ));
      }
    }
  }
  for (const seed of manifest.scenario.seeds) {
    const native = trials.find(
      (trial) =>
        trial.artifact.seed === seed &&
        trial.artifact.mode === "native" &&
        trial.artifact.attempt === 1,
    );
    if (native === undefined) continue;
    for (const shadow of trials.filter(
      (trial) => trial.artifact.seed === seed && trial.artifact.mode === "shadow",
    )) {
      if (shadow.artifact.hashHeads.state !== native.artifact.hashHeads.state) {
        issues.push(
          `${shadow.artifact.trialId} changed authoritative state in shadow mode`,
        );
      }
    }
  }
  return issues;
}

export function reportStudy(studyDirectory: string): StudyReport {
  const root = resolve(studyDirectory);
  const manifest = validateExperimentManifest(
    canonicalParse(readFileSync(join(root, "manifest.json"), "utf8")),
  );
  const trialRoot = join(root, "trials");
  const trialDirectories = existsSync(trialRoot)
    ? readdirSync(trialRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(trialRoot, entry.name))
      .sort()
    : [];
  const trials = trialDirectories.map((directory) => {
    const verification = verifyTrialArtifact(directory);
    const artifact = trialArtifactSchema.parse(
      canonicalParse(readFileSync(join(directory, "artifact.json"), "utf8")),
    );
    const score = experimentScorecardSchema.parse(
      canonicalParse(readFileSync(join(directory, "scorecard.json"), "utf8")),
    );
    return { directory, verification, artifact, score };
  });
  const arms: ArmSummary[] = (["native", "shadow", "external"] as const).map((mode) => {
    const matching = trials.filter((trial) => trial.artifact.mode === mode);
    const included = matching.filter(
      (trial) => trial.verification.valid && !trial.artifact.taint.tainted,
    );
    const vectors: Record<string, readonly MetricAggregate[]> = {};
    for (const vector of [
      "structural",
      "behavioral",
      "social",
      "economic",
      "operational",
    ] as const) {
      vectors[vector] = aggregateMetrics(included.flatMap((trial) => trial.score[vector]));
    }
    return Object.freeze({
      mode,
      includedTrials: included.length,
      excludedTrials: matching.length - included.length,
      vectors: Object.freeze(vectors),
    });
  });
  const issues = releaseIssues(
    manifest,
    trials.map((trial) => ({
      artifact: trial.artifact,
      valid: trial.verification.valid,
      score: trial.score,
    })),
  );
  const report: StudyReport = Object.freeze({
    schemaVersion: 1,
    studyId: manifest.studyId,
    generatedWall: new Date().toISOString(),
    manifestDigest: trials[0]?.artifact.manifestDigest ??
      experimentManifestDigest(manifest),
    trialCount: trials.length,
    validTrialCount: trials.filter((trial) => trial.verification.valid).length,
    taintedTrialCount: trials.filter((trial) => trial.artifact.taint.tainted).length,
    invalidTrialCount: trials.filter((trial) => !trial.verification.valid).length,
    arms: Object.freeze(arms),
    releaseGate: Object.freeze({
      eligible: issues.length === 0,
      issues: Object.freeze(issues),
    }),
  });
  writeFileSync(
    join(root, "study-report.json"),
    `${canonicalStringify(report)}\n`,
    "utf8",
  );
  const lines = [
    `# Agent Lab study ${report.studyId}`,
    "",
    `Trials: ${report.validTrialCount}/${report.trialCount} verified  `,
    `Tainted: ${report.taintedTrialCount}  `,
    `Release gate: ${report.releaseGate.eligible ? "eligible" : "not eligible"}`,
    "",
    "## Vector summary",
    "",
  ];
  for (const arm of report.arms) {
    lines.push(
      `### ${arm.mode}`,
      "",
      `Included: ${arm.includedTrials}; excluded: ${arm.excludedTrials}`,
      "",
    );
    for (const [vector, metrics] of Object.entries(arm.vectors)) {
      lines.push(`#### ${vector}`, "", "| Metric | Mean | N | Unit |", "|---|---:|---:|---|");
      for (const metric of metrics) {
        lines.push(
          `| ${metric.metricId} | ${metric.mean ?? "not scored"} | ` +
            `${metric.count} | ${metric.unit} |`,
        );
      }
      lines.push("");
    }
  }
  if (report.releaseGate.issues.length > 0) {
    lines.push(
      "## Release-gate issues",
      "",
      ...report.releaseGate.issues.map((issue) => `- ${issue}`),
      "",
    );
  }
  lines.push(
    "The report keeps structural, behavioral, social, economic, and operational",
    "evidence separate. It does not produce a single realism score.",
    "",
  );
  writeFileSync(join(root, "study-report.md"), lines.join("\n"), "utf8");
  return report;
}
