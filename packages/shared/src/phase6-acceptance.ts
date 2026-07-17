/** Strict, checksummed evidence contracts for the Phase 6 live acceptance gate. */

import { z } from "zod";
import { canonicalStringify, hashValue } from "./codec";
import { tier2DecisionProposalSchema } from "./decision";
import { runIdSchema, simulationIdSchema } from "./simulation";

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const integerStringSchema = z.string().regex(/^\d+$/);
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
const executedAtSchema = z.string().datetime({ offset: true });
const modelSchema = z.string().trim().min(1).max(200);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const positiveSafeIntegerSchema = z.number().int().positive().safe();

const modelPriceSchema = z.object({
  inputMicrocentsPerToken: integerStringSchema,
  cachedInputMicrocentsPerToken: integerStringSchema,
  outputMicrocentsPerToken: integerStringSchema,
}).strict();

const ws609LiveBudgetArtifactBaseSchema = z.object({
  artifactSchemaVersion: z.literal(2),
  acceptanceCriterion: z.literal("AC-2"),
  status: z.literal("passed"),
  executedAt: executedAtSchema,
  transport: z.literal(
    "Fastify on an ephemeral 127.0.0.1 listener with real MiniMax/Kimi transport",
  ),
  scenario: z.object({
    worldSpec: z.literal("riverbend-100@1"),
    seed: z.literal(42),
    llmMode: z.literal("live"),
    endTick: z.literal(360),
    runCostCentsMax: z.literal("200"),
    perAgentDailyTokens: z.literal(128_000),
  }).strict(),
  simulationId: simulationIdSchema,
  runId: runIdSchema,
  models: z.object({
    tier2: modelSchema,
    tier3: modelSchema,
  }).strict(),
  providers: z.object({
    tier2: z.literal("minimax"),
    tier3: z.literal("kimi"),
  }).strict(),
  prices: z.record(modelSchema, modelPriceSchema),
  pause: z.object({
    tick: z.number().int().min(1).max(360).safe(),
    runStatus: z.literal("paused"),
    autoPaused: z.literal(true),
    effectiveTier: z.literal(1),
    budgetPct: z.literal(100),
    thresholdEventId: eventIdSchema,
    pauseEventId: eventIdSchema,
    pauseCausationId: eventIdSchema,
  }).strict(),
  providerUsage: z.object({
    callRecords: positiveSafeIntegerSchema,
    providerAttempts: positiveSafeIntegerSchema,
    cacheHits: nonnegativeSafeIntegerSchema,
    inputTokens: positiveSafeIntegerSchema,
    cachedInputTokens: nonnegativeSafeIntegerSchema,
    outputTokens: positiveSafeIntegerSchema,
  }).strict(),
  spendReconciliation: z.object({
    recordedCostMicrocents: integerStringSchema,
    independentlyPricedMicrocents: integerStringSchema,
    absoluteDifferenceMicrocents: integerStringSchema,
    differenceBasisPoints: z.number().int().min(0).max(500).safe(),
    withinFivePercent: z.literal(true),
    displayedCostCentsEstimate: integerStringSchema,
  }).strict(),
  postPauseProbe: z.object({
    graceMs: z.number().int().min(500).max(30_000).safe(),
    providerAttemptsAtPause: positiveSafeIntegerSchema,
    providerAttemptsAfterGrace: positiveSafeIntegerSchema,
    additionalProviderAttempts: z.literal(0),
    remainedPaused: z.literal(true),
  }).strict(),
}).strict();

export const ws609LiveBudgetArtifactSchema = ws609LiveBudgetArtifactBaseSchema.extend({
  evidenceDigest: hashSchema,
}).strict();

export type Ws609LiveBudgetArtifactBase = z.infer<typeof ws609LiveBudgetArtifactBaseSchema>;
export type Ws609LiveBudgetArtifact = z.infer<typeof ws609LiveBudgetArtifactSchema>;

export const PHASE6_PARITY_SECTIONS = [
  "calls",
  "decisions",
  "actions",
  "events",
  "agentState",
] as const;

const phase6ParitySectionSchema = z.enum(PHASE6_PARITY_SECTIONS);
const phase6ParitySectionComparisonSchema = z.object({
  section: phase6ParitySectionSchema,
  leftDigest: hashSchema,
  rightDigest: hashSchema,
  equal: z.literal(true),
}).strict();

const ws610LiveParityArtifactBaseSchema = z.object({
  artifactSchemaVersion: z.literal(2),
  ticket: z.literal("WS-610"),
  status: z.literal("passed"),
  executedAt: executedAtSchema,
  scenario: z.object({
    worldSpec: z.literal("riverbend-100@1"),
    seed: z.literal(42),
    decisionTick: z.literal(1),
    fixture: z.literal("one seeded agent with all goals dormant before the first tick"),
  }).strict(),
  live: z.object({
    provider: z.literal("minimax"),
    model: modelSchema,
    requestHash: hashSchema,
    attempts: z.number().int().min(1).max(2).safe(),
    inputTokens: positiveSafeIntegerSchema,
    cachedInputTokens: nonnegativeSafeIntegerSchema,
    outputTokens: positiveSafeIntegerSchema,
    logicalStateHash: hashSchema,
    activeGoalCount: nonnegativeSafeIntegerSchema,
  }).strict(),
  mock: z.object({
    provider: z.literal("mock"),
    model: modelSchema,
    requestHash: hashSchema,
    attempts: z.literal(1),
    inputTokens: positiveSafeIntegerSchema,
    cachedInputTokens: nonnegativeSafeIntegerSchema,
    outputTokens: positiveSafeIntegerSchema,
    logicalStateHash: hashSchema,
    activeGoalCount: nonnegativeSafeIntegerSchema,
  }).strict(),
  replayedProposal: tier2DecisionProposalSchema.extend({
    proposalHash: hashSchema,
  }).strict(),
  providerNeutral: z.object({
    projectionDigest: hashSchema,
    sections: z.array(phase6ParitySectionComparisonSchema).length(PHASE6_PARITY_SECTIONS.length),
    mismatches: z.array(phase6ParitySectionSchema).length(0),
  }).strict(),
  checklist: z.object({
    liveDecisionValid: z.literal(true),
    distinctProviderReceipts: z.literal(true),
    providerBoundLogicalHashesRemainDistinct: z.literal(true),
    callShapeEqual: z.literal(true),
    decisionShapeEqual: z.literal(true),
    actionShapeEqual: z.literal(true),
    causalEventFlowEqual: z.literal(true),
    affectedAgentStateEqual: z.literal(true),
  }).strict(),
}).strict();

export const ws610LiveParityArtifactSchema = ws610LiveParityArtifactBaseSchema.extend({
  evidenceDigest: hashSchema,
}).strict();

export type Ws610LiveParityArtifactBase = z.infer<typeof ws610LiveParityArtifactBaseSchema>;
export type Ws610LiveParityArtifact = z.infer<typeof ws610LiveParityArtifactSchema>;

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function assertNonzeroPrice(
  artifact: Ws609LiveBudgetArtifact,
  model: string,
): void {
  const price = artifact.prices[model];
  if (price === undefined) throw new Error(`WS-609 artifact is missing price evidence for ${model}`);
  if (
    BigInt(price.inputMicrocentsPerToken) === 0n &&
    BigInt(price.cachedInputMicrocentsPerToken) === 0n &&
    BigInt(price.outputMicrocentsPerToken) === 0n
  ) {
    throw new Error(`WS-609 artifact has an all-zero price for ${model}`);
  }
}

function assertWs609Semantics(artifact: Ws609LiveBudgetArtifact): void {
  assertNonzeroPrice(artifact, artifact.models.tier2);
  assertNonzeroPrice(artifact, artifact.models.tier3);
  if (artifact.providerUsage.cachedInputTokens > artifact.providerUsage.inputTokens) {
    throw new Error("WS-609 cached input usage exceeds total input usage");
  }
  if (artifact.pause.pauseCausationId !== artifact.pause.thresholdEventId) {
    throw new Error("WS-609 pause event is not caused by the 100% threshold event");
  }
  if (
    artifact.postPauseProbe.providerAttemptsAtPause !== artifact.providerUsage.providerAttempts ||
    artifact.postPauseProbe.providerAttemptsAfterGrace !== artifact.providerUsage.providerAttempts
  ) {
    throw new Error("WS-609 provider-attempt counts do not remain stable after auto-pause");
  }
  const recorded = BigInt(artifact.spendReconciliation.recordedCostMicrocents);
  const independent = BigInt(artifact.spendReconciliation.independentlyPricedMicrocents);
  const difference = absoluteDifference(recorded, independent);
  if (recorded < 200_000_000n) {
    throw new Error("WS-609 recorded spend did not reach the $2 ceiling");
  }
  if (independent === 0n || difference * 100n > independent * 5n) {
    throw new Error("WS-609 recorded and independent spend differ by more than 5%");
  }
  if (difference.toString() !== artifact.spendReconciliation.absoluteDifferenceMicrocents) {
    throw new Error("WS-609 absolute spend difference is inconsistent");
  }
  const expectedBasisPoints = Number(difference * 10_000n / independent);
  if (artifact.spendReconciliation.differenceBasisPoints !== expectedBasisPoints) {
    throw new Error("WS-609 spend difference basis points are inconsistent");
  }
  const expectedDisplayedCents = (recorded + 999_999n) / 1_000_000n;
  if (
    artifact.spendReconciliation.displayedCostCentsEstimate !==
      expectedDisplayedCents.toString()
  ) {
    throw new Error("WS-609 displayed whole-cent spend is not the exact round-up");
  }
}

function assertWs610Semantics(artifact: Ws610LiveParityArtifact): void {
  if (artifact.live.cachedInputTokens > artifact.live.inputTokens) {
    throw new Error("WS-610 live cached input usage exceeds total input usage");
  }
  if (artifact.mock.cachedInputTokens > artifact.mock.inputTokens) {
    throw new Error("WS-610 mock cached input usage exceeds total input usage");
  }
  if (artifact.live.requestHash !== artifact.mock.requestHash) {
    throw new Error("WS-610 live and mock canonical request hashes differ");
  }
  if (artifact.live.logicalStateHash === artifact.mock.logicalStateHash) {
    throw new Error("WS-610 provider-bound logical hashes must remain distinct");
  }
  if (artifact.live.activeGoalCount !== artifact.mock.activeGoalCount) {
    throw new Error("WS-610 affected-agent goal state differs");
  }
  const sectionNames = artifact.providerNeutral.sections.map((section) => section.section);
  if (canonicalStringify(sectionNames) !== canonicalStringify(PHASE6_PARITY_SECTIONS)) {
    throw new Error("WS-610 parity sections are missing or out of canonical order");
  }
  for (const section of artifact.providerNeutral.sections) {
    if (section.leftDigest !== section.rightDigest) {
      throw new Error(`WS-610 ${section.section} section digests differ`);
    }
  }
  const proposal = {
    actionId: artifact.replayedProposal.actionId,
    params: artifact.replayedProposal.params,
    rationale: artifact.replayedProposal.rationale,
  };
  if (hashValue(proposal) !== artifact.replayedProposal.proposalHash) {
    throw new Error("WS-610 replayed proposal checksum does not match");
  }
}

export function validateWs609LiveBudgetArtifact(input: unknown): Ws609LiveBudgetArtifact {
  const parsed = ws609LiveBudgetArtifactSchema.parse(input);
  const { evidenceDigest, ...base } = parsed;
  if (evidenceDigest !== hashValue(base)) {
    throw new Error("WS-609 evidence checksum does not match");
  }
  assertWs609Semantics(parsed);
  return parsed;
}

export function createWs609LiveBudgetArtifact(input: unknown): Ws609LiveBudgetArtifact {
  const base = ws609LiveBudgetArtifactBaseSchema.parse(input);
  return validateWs609LiveBudgetArtifact({ ...base, evidenceDigest: hashValue(base) });
}

export function validateWs610LiveParityArtifact(input: unknown): Ws610LiveParityArtifact {
  const parsed = ws610LiveParityArtifactSchema.parse(input);
  const { evidenceDigest, ...base } = parsed;
  if (evidenceDigest !== hashValue(base)) {
    throw new Error("WS-610 evidence checksum does not match");
  }
  assertWs610Semantics(parsed);
  return parsed;
}

export function createWs610LiveParityArtifact(input: unknown): Ws610LiveParityArtifact {
  const base = ws610LiveParityArtifactBaseSchema.parse(input);
  return validateWs610LiveParityArtifact({ ...base, evidenceDigest: hashValue(base) });
}
