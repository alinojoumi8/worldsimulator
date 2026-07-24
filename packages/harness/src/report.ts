import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalParse,
  canonicalStringify,
  experimentManifestSchema,
  experimentScorecardSchema,
  trialArtifactSchema,
  type AgentLabMode,
} from "@worldtangle/shared";
import { verifyTrialArtifact } from "./artifact";
import { experimentManifestDigest } from "./manifest";

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

function releaseIssues(
  manifest: ReturnType<typeof experimentManifestSchema.parse>,
  trials: readonly {
    artifact: ReturnType<typeof trialArtifactSchema.parse>;
    valid: boolean;
    score: ReturnType<typeof experimentScorecardSchema.parse>;
  }[],
): string[] {
  const issues: string[] = [];
  if (manifest.scenario.seeds.length !== 3) {
    issues.push("production pilot requires exactly three frozen seeds");
  }
  if (manifest.scenario.ticks !== 60) {
    issues.push("production pilot requires exactly 60 ticks");
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
  for (const trial of trials) {
    if (!trial.valid) issues.push(`${trial.artifact.trialId} failed artifact verification`);
    if (trial.artifact.taint.tainted) issues.push(`${trial.artifact.trialId} is tainted`);
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
  }
  return issues;
}

export function reportStudy(studyDirectory: string): StudyReport {
  const root = resolve(studyDirectory);
  const manifest = experimentManifestSchema.parse(
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
