import { hashValue } from "@worldtangle/shared";

export const RIVERBEND_BASELINE_ENVELOPE_VERSION = 2;

export const RIVERBEND_BASELINE_ENVELOPE = Object.freeze({
  worldSpec: "riverbend-100@1",
  seed: 42,
  llmMode: "mock",
  throughTick: 360,
  unemploymentRateBp: Object.freeze({ minimum: 300, maximum: 1_200 }),
  cpiIndex: Object.freeze({ minimum: 950, maximum: 1_200 }),
  businessFailures: Object.freeze({ minimum: 0, maximum: 3 }),
  newCompanies: Object.freeze({ minimum: 1, maximum: 4 }),
  loanDefaults: Object.freeze({ minimum: 0, maximum: 4 }),
  m1AttributionRateBp: 10_000,
  minimumTreasuryBalanceCents: "0",
  maximumBenefitSuspensionTicks: 30,
});

export const RIVERBEND_BASELINE_ENVELOPE_HASH = hashValue(RIVERBEND_BASELINE_ENVELOPE);

export type BaselineIndicatorKey =
  | "unemployment_rate_bp"
  | "cpi_index"
  | "treasury_balance_cents";

export interface BaselineIndicatorPoint {
  readonly tick: number;
  readonly key: BaselineIndicatorKey;
  readonly valueInteger: string;
}

export interface RiverbendBaselineObservation {
  readonly worldSpec: string;
  readonly seed: number;
  readonly llmMode: string;
  readonly throughTick: number;
  readonly indicatorPoints: readonly BaselineIndicatorPoint[];
  readonly businessFailureIds: readonly string[];
  readonly newCompanyIds: readonly string[];
  readonly loanDefaultIds: readonly string[];
  readonly benefitSuspensionTicks: readonly number[];
  readonly m1: {
    readonly complete: boolean;
    readonly attributionRateBp: number;
    readonly unattributedM1DeltaCents: string;
    readonly grossUnattributedM1ChangeCents: string;
  };
}

export interface ScenarioEnvelopeViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ScenarioRangeSummary {
  readonly minimum: { readonly tick: number; readonly valueInteger: string } | null;
  readonly maximum: { readonly tick: number; readonly valueInteger: string } | null;
  readonly pointCount: number;
}

export interface RiverbendBaselineReport {
  readonly version: number;
  readonly envelopeHash: string;
  readonly observationHash: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly unemploymentRateBp: ScenarioRangeSummary;
    readonly cpiIndex: ScenarioRangeSummary;
    readonly treasuryBalanceCents: ScenarioRangeSummary;
    readonly businessFailures: number;
    readonly newCompanies: number;
    readonly loanDefaults: number;
    readonly benefitSuspensionTicks: number;
    readonly m1AttributionRateBp: number;
  };
  readonly violations: readonly ScenarioEnvelopeViolation[];
}

const INDICATOR_KEYS: readonly BaselineIndicatorKey[] = Object.freeze([
  "unemployment_rate_bp",
  "cpi_index",
  "treasury_balance_cents",
]);

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addViolation(
  target: ScenarioEnvelopeViolation[],
  code: string,
  path: string,
  message: string,
): void {
  target.push(Object.freeze({ code, path, message }));
}

function canonicalObservation(input: RiverbendBaselineObservation): RiverbendBaselineObservation {
  return {
    ...input,
    indicatorPoints: [...input.indicatorPoints].sort((left, right) => (
      compareCodeUnit(left.key, right.key) || left.tick - right.tick ||
      compareCodeUnit(left.valueInteger, right.valueInteger)
    )),
    businessFailureIds: [...input.businessFailureIds].sort(compareCodeUnit),
    newCompanyIds: [...input.newCompanyIds].sort(compareCodeUnit),
    loanDefaultIds: [...input.loanDefaultIds].sort(compareCodeUnit),
    benefitSuspensionTicks: [...input.benefitSuspensionTicks].sort((left, right) => left - right),
  };
}

function integerValue(
  value: string,
  path: string,
  violations: ScenarioEnvelopeViolation[],
): bigint | null {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) {
    addViolation(violations, "indicator.invalid_integer", path, `${value} is not a canonical integer`);
    return null;
  }
  return BigInt(value);
}

function rangeSummary(
  points: readonly BaselineIndicatorPoint[],
  key: BaselineIndicatorKey,
  throughTick: number,
  violations: ScenarioEnvelopeViolation[],
): { readonly summary: ScenarioRangeSummary; readonly values: readonly bigint[] } {
  const rows = points.filter((point) => point.key === key)
    .sort((left, right) => left.tick - right.tick || compareCodeUnit(left.valueInteger, right.valueInteger));
  const byTick = new Map<number, number>();
  const valid: { readonly point: BaselineIndicatorPoint; readonly value: bigint }[] = [];
  for (const point of rows) {
    if (!Number.isSafeInteger(point.tick) || point.tick < 0 || point.tick > throughTick) {
      addViolation(
        violations,
        "indicator.invalid_tick",
        `indicatorPoints.${key}`,
        `tick ${point.tick} is outside 0..${throughTick}`,
      );
      continue;
    }
    byTick.set(point.tick, (byTick.get(point.tick) ?? 0) + 1);
    const value = integerValue(
      point.valueInteger,
      `indicatorPoints.${key}.${point.tick}`,
      violations,
    );
    if (value !== null) valid.push({ point, value });
  }
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (let tick = 0; tick <= throughTick; tick++) {
    const count = byTick.get(tick) ?? 0;
    if (count === 0) missing.push(tick);
    if (count > 1) duplicated.push(tick);
  }
  if (missing.length > 0 || duplicated.length > 0) {
    addViolation(
      violations,
      "indicator.coverage",
      `indicatorPoints.${key}`,
      `expected one point for every tick 0..${throughTick}; missing=${missing.join(",") || "none"}; duplicated=${duplicated.join(",") || "none"}`,
    );
  }
  let minimum = valid[0] ?? null;
  let maximum = valid[0] ?? null;
  for (const candidate of valid.slice(1)) {
    if (minimum === null || candidate.value < minimum.value) minimum = candidate;
    if (maximum === null || candidate.value > maximum.value) maximum = candidate;
  }
  return {
    summary: Object.freeze({
      minimum: minimum === null
        ? null
        : Object.freeze({ tick: minimum.point.tick, valueInteger: minimum.value.toString() }),
      maximum: maximum === null
        ? null
        : Object.freeze({ tick: maximum.point.tick, valueInteger: maximum.value.toString() }),
      pointCount: rows.length,
    }),
    values: Object.freeze(valid.map((entry) => entry.value)),
  };
}

function assertUniqueEvidence(
  values: readonly string[],
  path: string,
  violations: ScenarioEnvelopeViolation[],
): number {
  const unique = new Set(values);
  if (unique.size !== values.length || values.some((value) => value.length === 0)) {
    addViolation(
      violations,
      "evidence.invalid_ids",
      path,
      "evidence IDs must be non-empty and unique",
    );
  }
  return unique.size;
}

function assertCountEnvelope(
  count: number,
  minimum: number,
  maximum: number,
  path: string,
  violations: ScenarioEnvelopeViolation[],
): void {
  if (count < minimum || count > maximum) {
    addViolation(
      violations,
      "metric.outside_envelope",
      path,
      `${count} is outside inclusive envelope ${minimum}..${maximum}`,
    );
  }
}

export function evaluateRiverbendBaseline(
  input: RiverbendBaselineObservation,
): RiverbendBaselineReport {
  const observation = canonicalObservation(input);
  const violations: ScenarioEnvelopeViolation[] = [];
  if (
    observation.worldSpec !== RIVERBEND_BASELINE_ENVELOPE.worldSpec ||
    observation.seed !== RIVERBEND_BASELINE_ENVELOPE.seed ||
    observation.llmMode !== RIVERBEND_BASELINE_ENVELOPE.llmMode ||
    observation.throughTick !== RIVERBEND_BASELINE_ENVELOPE.throughTick
  ) {
    addViolation(
      violations,
      "scenario.identity",
      "scenario",
      "baseline must be riverbend-100@1 seed 42 mock through tick 360",
    );
  }
  const ranges = new Map(INDICATOR_KEYS.map((key) => [
    key,
    rangeSummary(observation.indicatorPoints, key, observation.throughTick, violations),
  ]));
  const unemployment = ranges.get("unemployment_rate_bp")!;
  for (const value of unemployment.values) {
    if (
      value < BigInt(RIVERBEND_BASELINE_ENVELOPE.unemploymentRateBp.minimum) ||
      value > BigInt(RIVERBEND_BASELINE_ENVELOPE.unemploymentRateBp.maximum)
    ) {
      addViolation(
        violations,
        "unemployment.outside_envelope",
        "indicatorPoints.unemployment_rate_bp",
        `unemployment ${value} bp is outside 300..1200 bp`,
      );
      break;
    }
  }
  const cpi = ranges.get("cpi_index")!;
  for (const value of cpi.values) {
    if (
      value < BigInt(RIVERBEND_BASELINE_ENVELOPE.cpiIndex.minimum) ||
      value > BigInt(RIVERBEND_BASELINE_ENVELOPE.cpiIndex.maximum)
    ) {
      addViolation(
        violations,
        "cpi.outside_envelope",
        "indicatorPoints.cpi_index",
        `CPI ${value} is outside ${RIVERBEND_BASELINE_ENVELOPE.cpiIndex.minimum}..${RIVERBEND_BASELINE_ENVELOPE.cpiIndex.maximum}`,
      );
      break;
    }
  }
  const treasury = ranges.get("treasury_balance_cents")!;
  if (treasury.values.some((value) => value < 0n)) {
    addViolation(
      violations,
      "treasury.negative",
      "indicatorPoints.treasury_balance_cents",
      "treasury balance became negative",
    );
  }
  const businessFailures = assertUniqueEvidence(
    observation.businessFailureIds,
    "businessFailureIds",
    violations,
  );
  const newCompanies = assertUniqueEvidence(
    observation.newCompanyIds,
    "newCompanyIds",
    violations,
  );
  const loanDefaults = assertUniqueEvidence(
    observation.loanDefaultIds,
    "loanDefaultIds",
    violations,
  );
  assertCountEnvelope(
    businessFailures,
    RIVERBEND_BASELINE_ENVELOPE.businessFailures.minimum,
    RIVERBEND_BASELINE_ENVELOPE.businessFailures.maximum,
    "businessFailures",
    violations,
  );
  assertCountEnvelope(
    newCompanies,
    RIVERBEND_BASELINE_ENVELOPE.newCompanies.minimum,
    RIVERBEND_BASELINE_ENVELOPE.newCompanies.maximum,
    "newCompanies",
    violations,
  );
  assertCountEnvelope(
    loanDefaults,
    RIVERBEND_BASELINE_ENVELOPE.loanDefaults.minimum,
    RIVERBEND_BASELINE_ENVELOPE.loanDefaults.maximum,
    "loanDefaults",
    violations,
  );
  const suspensionTicks = new Set(observation.benefitSuspensionTicks);
  if (
    suspensionTicks.size !== observation.benefitSuspensionTicks.length ||
    observation.benefitSuspensionTicks.some((tick) => (
      !Number.isSafeInteger(tick) || tick < 0 || tick > observation.throughTick
    ))
  ) {
    addViolation(
      violations,
      "benefits.invalid_ticks",
      "benefitSuspensionTicks",
      "benefit-suspension ticks must be unique and within the run",
    );
  }
  if (suspensionTicks.size > RIVERBEND_BASELINE_ENVELOPE.maximumBenefitSuspensionTicks) {
    addViolation(
      violations,
      "benefits.too_many_suspensions",
      "benefitSuspensionTicks",
      `${suspensionTicks.size} suspended ticks exceeds the maximum 30`,
    );
  }
  let m1Zero = false;
  try {
    m1Zero = BigInt(observation.m1.unattributedM1DeltaCents) === 0n &&
      BigInt(observation.m1.grossUnattributedM1ChangeCents) === 0n;
  } catch {
    m1Zero = false;
  }
  if (
    !observation.m1.complete ||
    observation.m1.attributionRateBp !== RIVERBEND_BASELINE_ENVELOPE.m1AttributionRateBp ||
    !m1Zero
  ) {
    addViolation(
      violations,
      "m1.incomplete_attribution",
      "m1",
      "M1 changes must be attributed 100% with zero unexplained delta",
    );
  }
  return Object.freeze({
    version: RIVERBEND_BASELINE_ENVELOPE_VERSION,
    envelopeHash: RIVERBEND_BASELINE_ENVELOPE_HASH,
    observationHash: hashValue(observation),
    passed: violations.length === 0,
    metrics: Object.freeze({
      unemploymentRateBp: unemployment.summary,
      cpiIndex: cpi.summary,
      treasuryBalanceCents: treasury.summary,
      businessFailures,
      newCompanies,
      loanDefaults,
      benefitSuspensionTicks: suspensionTicks.size,
      m1AttributionRateBp: observation.m1.attributionRateBp,
    }),
    violations: Object.freeze(violations),
  });
}
