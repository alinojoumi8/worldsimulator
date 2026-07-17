/** Deterministic, all-or-nothing Riverbend population generation (M02). */

import {
  OCCUPATIONS_BY_CODE,
  PUBLIC_FIGURE_NAME_BLOCKLIST,
  SKILL_CATALOG,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  agentSchema,
  allocate,
  assertSyntheticNameAllowed,
  goalSchema,
  hashValue,
  householdSchema,
  money,
  mulDiv,
  normalizeSyntheticName,
  personaSchema,
  relationshipSchema,
  EngineError,
  IdFactory,
  Rng,
} from "@worldtangle/shared";
import type {
  Agent,
  EducationLevel,
  Goal,
  Household,
  Occupation,
  OpinionAxes,
  Persona,
  Personality,
  Relationship,
} from "@worldtangle/shared";
import {
  RIVERBEND_BUSINESS_IDS,
  RIVERBEND_ROLE_COUNTS,
  RIVERBEND_ROLE_SLOTS,
  RIVERBEND_WORLD_SPEC,
} from "./riverbend-spec";
import type { RiverbendRoleSlot, RiverbendSegment } from "./riverbend-spec";

const PERSON_DEPOSIT_TOTAL_CENTS = 420_000_000n;
const BUSINESS_DEPOSIT_TOTAL_CENTS = 90_000_000n;
const TARGET_TOTAL_ANNUAL_INCOME_CENTS = 530_000_000n;
const STUDENT_DEPOSIT_TOTAL_CENTS = 1_100_000n;
const TOP_DEPOSITS_CENTS = [55_000_000n, 50_000_000n, 45_000_000n] as const;
const TARGET_UNDIRECTED_RELATIONSHIPS = 300;

const EDUCATION_RANK: Readonly<Record<EducationLevel, number>> = {
  none: 0,
  hs: 1,
  college: 2,
  graduate: 3,
};

const EDUCATION_TARGETS: Readonly<Record<EducationLevel, number>> = {
  none: 8,
  hs: 42,
  college: 38,
  graduate: 12,
};

const PERSONALITY_KEYS = [
  "openness",
  "conscientiousness",
  "extraversion",
  "agreeableness",
  "neuroticism",
  "riskTolerance",
  "timePreference",
  "ambition",
] as const satisfies readonly (keyof Personality)[];

const OPINION_KEYS = [
  "redistribution",
  "regulation",
  "institutionalTrust",
  "economicOptimism",
] as const satisfies readonly (keyof OpinionAxes)[];

export interface RiverbendResident {
  readonly rosterIndex: number;
  readonly roleCode: string;
  readonly organizationId: string | null;
  readonly segment: RiverbendSegment;
  readonly agent: Agent;
  readonly persona: Persona;
  readonly annualIncomeCents: string;
}

export interface OpeningAccount {
  readonly id: string;
  readonly runId: string;
  readonly ownerKind: "agent" | "business";
  readonly ownerId: string;
  readonly accountType: "checking";
  readonly balanceCents: string;
}

export interface OpeningMintTransaction {
  readonly id: string;
  readonly runId: string;
  readonly accountId: string;
  readonly amountCents: string;
  readonly kind: "world_gen_mint";
}

export type SeedLoanInstallmentStatus = "paid" | "missed" | "scheduled";

export interface SeedLoanInstallment {
  readonly installment: number;
  readonly principalCents: string;
  readonly interestCents: string;
  readonly status: SeedLoanInstallmentStatus;
}

export interface SeedLoan {
  readonly id: string;
  readonly runId: string;
  readonly borrowerKind: "agent" | "business";
  readonly borrowerId: string;
  readonly purpose: "working_capital" | "vehicle" | "appliance";
  readonly originalPrincipalCents: string;
  readonly outstandingPrincipalCents: string;
  readonly annualRateBp: number;
  readonly termMonths: number;
  readonly seasonedMonths: number;
  readonly status: "current" | "delinquent";
  readonly missedPayments: number;
  readonly installments: readonly SeedLoanInstallment[];
}

export interface RiverbendGenerationStats {
  readonly population: number;
  readonly roleCounts: Readonly<Record<string, number>>;
  readonly ageBands: Readonly<Record<string, number>>;
  readonly educationCounts: Readonly<Record<EducationLevel, number>>;
  readonly meanAnnualIncomeCents: string;
  readonly personDepositsCents: string;
  readonly businessDepositsCents: string;
  readonly wealthGiniMillionths: number;
  readonly householdCounts: Readonly<Record<Household["structure"], number>>;
  readonly undirectedRelationships: number;
  readonly meanRelationshipDegreeMilli: number;
  readonly minRelationshipDegree: number;
  readonly maxRelationshipDegree: number;
  readonly activeFounderGoals: number;
  readonly delinquentPersonalLoans: number;
  readonly creditOutstandingCents: string;
}

export interface RiverbendGenerationReport {
  readonly worldSpec: typeof RIVERBEND_WORLD_SPEC;
  readonly seed: number | string;
  readonly specHash: string;
  readonly populationHash: string;
  readonly validation: "passed";
  readonly stats: RiverbendGenerationStats;
}

export interface RiverbendPopulationData {
  readonly residents: readonly RiverbendResident[];
  readonly households: readonly Household[];
  readonly accounts: readonly OpeningAccount[];
  readonly mintTransactions: readonly OpeningMintTransaction[];
  readonly loans: readonly SeedLoan[];
  readonly relationships: readonly Relationship[];
  readonly goals: readonly Goal[];
  /** Checkpoint for every deterministic ID prefix consumed during generation. */
  readonly idState: Readonly<Record<string, number>>;
}

export interface RiverbendPopulation extends RiverbendPopulationData {
  readonly report: RiverbendGenerationReport;
}

export interface GenerateRiverbendPopulationOptions {
  readonly runId: string;
  readonly seed: number | string;
  readonly nameBlocklist?: readonly string[];
}

export interface RiverbendValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface ResidentDraft {
  readonly rosterIndex: number;
  readonly slot: RiverbendRoleSlot;
  readonly agentId: string;
  readonly personaId: string;
  readonly name: string;
  readonly age: number;
  readonly education: EducationLevel;
  readonly occupation: Readonly<Occupation>;
  personality: Personality;
  opinions: OpinionAxes;
  readonly skills: Readonly<Record<string, number>>;
  annualIncomeCents: bigint;
  householdId?: string;
}

interface PopulationDraft extends RiverbendPopulationData {
  readonly residents: RiverbendResident[];
  readonly households: Household[];
  readonly accounts: OpeningAccount[];
  readonly mintTransactions: OpeningMintTransaction[];
  readonly loans: SeedLoan[];
  readonly relationships: Relationship[];
  readonly goals: Goal[];
}

interface SocialEdge {
  readonly left: string;
  readonly right: string;
  readonly type: Relationship["type"];
  readonly strength: number;
}

const SPEC_HASH = hashValue({
  generationRulesVersion: 1,
  occupations: [...OCCUPATIONS_BY_CODE.values()],
  roleSlots: RIVERBEND_ROLE_SLOTS,
  skills: SKILL_CATALOG,
  worldSpec: RIVERBEND_WORLD_SPEC,
});

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sumBigints(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

function approximateNormal(rng: Rng, mean: number, standardDeviation: number): number {
  let centered = -600;
  for (let draw = 0; draw < 12; draw++) centered += rng.int(0, 100);
  return mean + Math.round((centered * standardDeviation) / 100);
}

function assignAges(slots: readonly RiverbendRoleSlot[], rng: Rng): number[] {
  const ages = Array<number>(slots.length);
  const studentIndices: number[] = [];
  const retireeIndices: number[] = [];
  const remainingIndices: number[] = [];

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!;
    if (slot.employmentStatus === "student") studentIndices.push(index);
    else if (slot.employmentStatus === "retired") retireeIndices.push(index);
    else remainingIndices.push(index);
  }

  const studentAges = Array.from({ length: 11 }, () => rng.int(16, 22));
  const retireeAges = Array.from({ length: 9 }, () => rng.int(65, 82));
  const remainingAges = [
    ...Array.from({ length: 30 }, () => rng.int(23, 34)),
    ...Array.from({ length: 31 }, () => rng.int(35, 49)),
    ...Array.from({ length: 19 }, () => rng.int(50, 64)),
  ];

  rng.shuffle(studentAges);
  rng.shuffle(retireeAges);
  rng.shuffle(remainingAges);
  for (let index = 0; index < studentIndices.length; index++) {
    ages[studentIndices[index]!] = studentAges[index]!;
  }
  for (let index = 0; index < retireeIndices.length; index++) {
    ages[retireeIndices[index]!] = retireeAges[index]!;
  }

  const shuffledIndices = rng.shuffle([...remainingIndices]);
  shuffledIndices.sort((left, right) => {
    const leftMinimum = OCCUPATIONS_BY_CODE.get(slots[left]!.occupationCode)?.minimumAge ?? 16;
    const rightMinimum = OCCUPATIONS_BY_CODE.get(slots[right]!.occupationCode)?.minimumAge ?? 16;
    return rightMinimum - leftMinimum;
  });

  for (const slotIndex of shuffledIndices) {
    const slot = slots[slotIndex]!;
    const minimum = OCCUPATIONS_BY_CODE.get(slot.occupationCode)?.minimumAge ?? 16;
    const maximum = slot.maxAge ?? 100;
    const eligible: number[] = [];
    for (let ageIndex = 0; ageIndex < remainingAges.length; ageIndex++) {
      const age = remainingAges[ageIndex]!;
      if (age >= minimum && age <= maximum) eligible.push(ageIndex);
    }
    if (eligible.length === 0) {
      throw new EngineError("VALIDATION_FAILED", "age assignment has no feasible match", {
        roleCode: slot.roleCode,
        minimum,
        maximum,
      });
    }
    const selectedPoolIndex = eligible[rng.int(0, eligible.length - 1)]!;
    ages[slotIndex] = remainingAges[selectedPoolIndex]!;
    remainingAges.splice(selectedPoolIndex, 1);
  }
  return ages;
}

function assignEducation(slots: readonly RiverbendRoleSlot[], rng: Rng): EducationLevel[] {
  const available: Record<EducationLevel, number> = { ...EDUCATION_TARGETS };
  const education = Array<EducationLevel>(slots.length);
  const tieOrder = new Map<number, number>();
  rng.shuffle(Array.from({ length: slots.length }, (_, index) => index)).forEach((slot, order) => {
    tieOrder.set(slot, order);
  });

  const indices = Array.from({ length: slots.length }, (_, index) => index);
  indices.sort((left, right) => {
    const leftSlot = slots[left]!;
    const rightSlot = slots[right]!;
    const leftMinimum = OCCUPATIONS_BY_CODE.get(leftSlot.occupationCode)?.minimumEducation ?? "none";
    const rightMinimum = OCCUPATIONS_BY_CODE.get(rightSlot.occupationCode)?.minimumEducation ?? "none";
    const minimumDifference = EDUCATION_RANK[rightMinimum] - EDUCATION_RANK[leftMinimum];
    if (minimumDifference !== 0) return minimumDifference;
    if (leftSlot.employmentStatus === "student" && rightSlot.employmentStatus !== "student") return -1;
    if (rightSlot.employmentStatus === "student" && leftSlot.employmentStatus !== "student") return 1;
    return tieOrder.get(left)! - tieOrder.get(right)!;
  });

  const levels = ["none", "hs", "college", "graduate"] as const;
  for (const index of indices) {
    const minimum = OCCUPATIONS_BY_CODE.get(slots[index]!.occupationCode)?.minimumEducation ?? "none";
    const level = levels.find(
      (candidate) => EDUCATION_RANK[candidate] >= EDUCATION_RANK[minimum] && available[candidate] > 0,
    );
    if (level === undefined) {
      throw new EngineError("VALIDATION_FAILED", "education assignment has no feasible match", {
        roleCode: slots[index]!.roleCode,
        minimum,
        available,
      });
    }
    education[index] = level;
    available[level] -= 1;
  }
  return education;
}

function assignNames(
  count: number,
  rng: Rng,
  blocklist: readonly string[],
): string[] {
  const candidates: string[] = [];
  for (const first of SYNTHETIC_FIRST_NAMES) {
    for (const last of SYNTHETIC_LAST_NAMES) candidates.push(`${first} ${last}`);
  }
  rng.shuffle(candidates);
  const blocked = new Set(blocklist.map(normalizeSyntheticName));
  const names: string[] = [];
  for (const candidate of candidates) {
    if (blocked.has(normalizeSyntheticName(candidate))) continue;
    assertSyntheticNameAllowed(candidate, blocklist);
    names.push(candidate);
    if (names.length === count) return names;
  }
  throw new EngineError("VALIDATION_FAILED", "name catalog has too few allowed unique names", {
    requested: count,
    available: names.length,
  });
}

function sampleSkills(occupation: Readonly<Occupation>, rng: Rng): Readonly<Record<string, number>> {
  if (occupation.code === "student") {
    const choices = rng.shuffle(SKILL_CATALOG.map((skill) => skill.code));
    return {
      [choices[0]!]: rng.int(10, 35),
      [choices[1]!]: rng.int(10, 35),
    };
  }

  const primary = occupation.requiredSkills[0]!;
  const secondary = occupation.requiredSkills[1] ?? primary;
  const remaining = SKILL_CATALOG.map((skill) => skill.code).filter(
    (skill) => skill !== primary && skill !== secondary,
  );
  const general = rng.pick(remaining);
  return {
    [primary]: rng.int(55, 85),
    [secondary]: rng.int(30, 60),
    [general]: rng.int(20, 50),
  };
}

function samplePersonality(occupation: Readonly<Occupation>, rng: Rng): Personality {
  const values: Record<keyof Personality, number> = {
    openness: approximateNormal(rng, 50, 15),
    conscientiousness: approximateNormal(rng, 50, 15),
    extraversion: approximateNormal(rng, 50, 15),
    agreeableness: approximateNormal(rng, 50, 15),
    neuroticism: approximateNormal(rng, 50, 15),
    riskTolerance: approximateNormal(rng, 50, 15),
    timePreference: approximateNormal(rng, 50, 15),
    ambition: approximateNormal(rng, 50, 15),
  };

  for (const tag of occupation.personalityTags) {
    if (tag === "owner_founder") {
      values.ambition += 20;
      values.riskTolerance += 15;
      values.conscientiousness += 5;
    } else if (tag === "financial_care") {
      values.conscientiousness += 15;
      values.riskTolerance -= 10;
    } else if (tag === "journalist_freelancer") {
      values.openness += 15;
    } else if (tag === "vc_partner") {
      values.riskTolerance += 20;
      values.ambition += 15;
    } else if (tag === "care_worker") {
      values.agreeableness += 10;
    }
  }
  values.timePreference += Math.round((values.conscientiousness - 50) * 0.3);

  return Object.fromEntries(
    PERSONALITY_KEYS.map((key) => [key, clamp(values[key], 5, 95)]),
  ) as unknown as Personality;
}

function sampleOpinions(
  slot: RiverbendRoleSlot,
  occupation: Readonly<Occupation>,
  annualIncomeCents: bigint,
  rng: Rng,
): OpinionAxes {
  const opinions: OpinionAxes = {
    redistribution: approximateNormal(rng, 0, 35),
    regulation: approximateNormal(rng, 0, 35),
    institutionalTrust: approximateNormal(rng, 0, 35),
    economicOptimism: approximateNormal(rng, 0, 35),
  };
  if (annualIncomeCents >= 8_000_000n) opinions.redistribution -= 15;
  if (occupation.personalityTags.includes("public_employee")) opinions.institutionalTrust += 10;
  if (occupation.code === "business_owner") opinions.regulation -= 15;
  if (slot.employmentStatus === "retired") opinions.economicOptimism -= 5;
  for (const key of OPINION_KEYS) opinions[key] = clamp(opinions[key], -90, 90);
  return opinions;
}

function adjustIncomes(drafts: ResidentDraft[]): void {
  const current = sumBigints(drafts.map((draft) => draft.annualIncomeCents));
  const delta = TARGET_TOTAL_ANNUAL_INCOME_CENTS - current;
  if (delta === 0n) return;

  const capacities = drafts.map((draft) => {
    const band = draft.occupation.baseWageBand;
    const boundary = delta > 0n ? BigInt(band.maxAnnualCents) : BigInt(band.minAnnualCents);
    return delta > 0n
      ? boundary - draft.annualIncomeCents
      : draft.annualIncomeCents - boundary;
  });
  const totalCapacity = sumBigints(capacities);
  const magnitude = delta < 0n ? -delta : delta;
  if (totalCapacity < magnitude) {
    throw new EngineError("VALIDATION_FAILED", "income target is outside occupation-band capacity", {
      current: current.toString(),
      target: TARGET_TOTAL_ANNUAL_INCOME_CENTS.toString(),
      capacity: totalCapacity.toString(),
    });
  }
  const adjustments = allocate(money(magnitude), capacities);
  for (let index = 0; index < drafts.length; index++) {
    drafts[index]!.annualIncomeCents += delta > 0n ? adjustments[index]! : -adjustments[index]!;
  }
}

function ensureOpinionDiversity(drafts: ResidentDraft[]): void {
  for (const key of OPINION_KEYS) {
    let positive = drafts.filter((draft) => draft.opinions[key] > 0).length;
    let negative = drafts.filter((draft) => draft.opinions[key] < 0).length;
    if (positive < 15) {
      const candidates = drafts
        .filter((draft) => draft.opinions[key] <= 0)
        .sort((left, right) => {
          const leftZero = left.opinions[key] === 0 ? 0 : 1;
          const rightZero = right.opinions[key] === 0 ? 0 : 1;
          return leftZero - rightZero || right.opinions[key] - left.opinions[key];
        });
      for (const draft of candidates) {
        if (positive >= 15) break;
        const previous = draft.opinions[key];
        if (previous < 0 && negative <= 15) continue;
        draft.opinions = { ...draft.opinions, [key]: 1 };
        positive += 1;
        if (previous < 0) negative -= 1;
      }
    }
    if (negative < 15) {
      const candidates = drafts
        .filter((draft) => draft.opinions[key] >= 0)
        .sort((left, right) => {
          const leftZero = left.opinions[key] === 0 ? 0 : 1;
          const rightZero = right.opinions[key] === 0 ? 0 : 1;
          return leftZero - rightZero || left.opinions[key] - right.opinions[key];
        });
      for (const draft of candidates) {
        if (negative >= 15) break;
        const previous = draft.opinions[key];
        if (previous > 0 && positive <= 15) continue;
        draft.opinions = { ...draft.opinions, [key]: -1 };
        negative += 1;
        if (previous > 0) positive -= 1;
      }
    }
  }
}

function selectFounderCandidates(drafts: ResidentDraft[]): Set<string> {
  const candidates = drafts
    .filter(
      (draft) =>
        draft.slot.employmentStatus === "employed" &&
        draft.occupation.code !== "business_owner" &&
        draft.occupation.code !== "vc_partner",
    )
    .sort((left, right) => {
      const ambition = right.personality.ambition - left.personality.ambition;
      return ambition !== 0 ? ambition : compareCodeUnit(left.agentId, right.agentId);
    })
    .slice(0, 4);
  for (const draft of candidates) {
    if (draft.personality.ambition < 70) {
      draft.personality = { ...draft.personality, ambition: 70 };
    }
  }
  return new Set(candidates.map((draft) => draft.agentId));
}

function sampleCreditScore(draft: ResidentDraft, rng: Rng): number {
  let score = 620 + rng.int(-55, 55);
  if (draft.slot.employmentStatus === "employed") score += 45;
  if (draft.slot.employmentStatus === "retired") score += 35;
  if (draft.slot.employmentStatus === "unemployed") score -= 55;
  if (draft.slot.employmentStatus === "student") score -= 15;
  if (draft.annualIncomeCents >= 8_000_000n) score += 35;
  return clamp(score, 300, 850);
}

function assembleHouseholds(
  runId: string,
  drafts: ResidentDraft[],
  idFactory: IdFactory,
  rng: Rng,
): Household[] {
  const students = rng.shuffle(
    drafts.filter((draft) => draft.slot.employmentStatus === "student").map((draft) => draft.agentId),
  );
  const adults = rng.shuffle(
    drafts.filter((draft) => draft.slot.employmentStatus !== "student").map((draft) => draft.agentId),
  );
  const groups: { structure: Household["structure"]; members: string[] }[] = [];

  const familySizes = rng.shuffle([4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3]);
  for (let index = 0; index < 12; index++) {
    const members = index < 9 ? [students[index]!] : [];
    while (members.length < familySizes[index]!) members.push(adults.shift()!);
    groups.push({ structure: "family", members });
  }
  for (let index = 0; index < 4; index++) {
    const members = index < 2
      ? [students[9 + index]!, adults.shift()!]
      : [adults.shift()!, adults.shift()!];
    groups.push({ structure: "shared", members });
  }
  for (let index = 0; index < 14; index++) {
    groups.push({ structure: "couple", members: [adults.shift()!, adults.shift()!] });
  }
  for (let index = 0; index < 22; index++) {
    groups.push({ structure: "single", members: [adults.shift()!] });
  }
  if (adults.length !== 0) throw new EngineError("VALIDATION_FAILED", "household assembly left adults unassigned");

  const incomeByAgent = new Map(drafts.map((draft) => [draft.agentId, draft.annualIncomeCents]));
  const householdDrafts = groups.map((group) => ({
    ...group,
    id: idFactory.next("hh"),
    income: sumBigints(group.members.map((id) => incomeByAgent.get(id) ?? 0n)),
  }));
  const incomeOrder = [...householdDrafts].sort((left, right) =>
    left.income < right.income
      ? -1
      : left.income > right.income
        ? 1
        : compareCodeUnit(left.id, right.id),
  );
  const tierById = new Map<string, Household["housingTier"]>();
  for (let index = 0; index < incomeOrder.length; index++) {
    tierById.set(
      incomeOrder[index]!.id,
      index < 18 ? "modest" : index < 35 ? "standard" : "comfortable",
    );
  }

  const households = householdDrafts.map((draft) => householdSchema.parse({
    id: draft.id,
    runId,
    memberAgentIds: draft.members,
    structure: draft.structure,
    housingTier: tierById.get(draft.id),
    budgetPolicy: {
      bufferDays: draft.structure === "single" ? 30 : draft.structure === "family" ? 45 : 35,
      discretionaryPropensityBp: draft.structure === "family" ? 1_800 : 2_200,
    },
  }));
  for (const household of households) {
    for (const agentId of household.memberAgentIds) {
      const draft = drafts.find((candidate) => candidate.agentId === agentId)!;
      draft.householdId = household.id;
    }
  }
  return households;
}

function assignPersonDeposits(
  drafts: readonly ResidentDraft[],
  rng: Rng,
): Map<string, bigint> {
  const top = [
    drafts.find((draft) => draft.slot.roleCode === "ironvale.owner")!,
    ...drafts.filter((draft) => draft.slot.roleCode === "vc.partner"),
  ];
  const topIds = new Set(top.map((draft) => draft.agentId));
  const students = drafts.filter((draft) => draft.slot.employmentStatus === "student");
  const others = drafts.filter(
    (draft) => !topIds.has(draft.agentId) && draft.slot.employmentStatus !== "student",
  );
  const balances = new Map<string, bigint>();
  for (let index = 0; index < top.length; index++) balances.set(top[index]!.agentId, TOP_DEPOSITS_CENTS[index]!);

  const studentOrder = rng.shuffle([...students]);
  const studentAllocations = allocate(
    money(STUDENT_DEPOSIT_TOTAL_CENTS),
    studentOrder.map((_, index) => BigInt(index + 1)),
  );
  for (let index = 0; index < studentOrder.length; index++) {
    balances.set(studentOrder[index]!.agentId, studentAllocations[index]!);
  }

  const remainingTotal =
    PERSON_DEPOSIT_TOTAL_CENTS - STUDENT_DEPOSIT_TOTAL_CENTS - sumBigints(TOP_DEPOSITS_CENTS);
  const wealthNoise = rng.fork("rank-noise");
  const ranked = others
    .map((draft) => ({
      draft,
      score:
        Number(draft.annualIncomeCents / 100n) +
        draft.age * 20_000 +
        wealthNoise.int(0, 500_000),
    }))
    .sort((left, right) => {
      const score = left.score - right.score;
      return score !== 0 ? score : compareCodeUnit(left.draft.agentId, right.draft.agentId);
    });
  const allocations = allocate(
    money(remainingTotal),
    ranked.map((_, index) => BigInt(index + 1)),
  );
  for (let index = 0; index < ranked.length; index++) {
    balances.set(ranked[index]!.draft.agentId, allocations[index]!);
  }
  return balances;
}

function createOpeningBooks(
  runId: string,
  drafts: readonly ResidentDraft[],
  idFactory: IdFactory,
  rng: Rng,
): { accounts: OpeningAccount[]; mintTransactions: OpeningMintTransaction[] } {
  const personBalances = assignPersonDeposits(drafts, rng.fork("person-deposits"));
  const businessAllocations = allocate(
    money(BUSINESS_DEPOSIT_TOTAL_CENTS),
    RIVERBEND_BUSINESS_IDS.map((_, index) => BigInt(RIVERBEND_BUSINESS_IDS.length - index)),
  );
  const accounts: OpeningAccount[] = [];

  for (const draft of drafts) {
    accounts.push({
      id: idFactory.next("acct"),
      runId,
      ownerKind: "agent",
      ownerId: draft.agentId,
      accountType: "checking",
      balanceCents: personBalances.get(draft.agentId)!.toString(),
    });
  }
  for (let index = 0; index < RIVERBEND_BUSINESS_IDS.length; index++) {
    accounts.push({
      id: idFactory.next("acct"),
      runId,
      ownerKind: "business",
      ownerId: RIVERBEND_BUSINESS_IDS[index]!,
      accountType: "checking",
      balanceCents: businessAllocations[index]!.toString(),
    });
  }
  const mintTransactions = accounts.map((account) => ({
    id: idFactory.next("txn"),
    runId,
    accountId: account.id,
    amountCents: account.balanceCents,
    kind: "world_gen_mint" as const,
  }));
  return { accounts, mintTransactions };
}

function fixedPrincipalInstallments(
  principalCents: bigint,
  termMonths: number,
  annualRateBp: number,
  seasonedMonths: number,
  delinquent: boolean,
): SeedLoanInstallment[] {
  const principalParts = allocate(
    money(principalCents),
    Array.from({ length: termMonths }, () => 1n),
  );
  let scheduledOutstanding = principalCents;
  return principalParts.map((principal, index) => {
    const installment = index + 1;
    const interest = mulDiv(
      money(scheduledOutstanding),
      BigInt(annualRateBp),
      120_000n,
      "HALF_EVEN",
    );
    let status: SeedLoanInstallmentStatus = "scheduled";
    if (installment <= seasonedMonths) status = "paid";
    if (delinquent && installment === seasonedMonths) status = "missed";
    scheduledOutstanding -= principal;
    return {
      installment,
      principalCents: principal.toString(),
      interestCents: interest.toString(),
      status,
    };
  });
}

function createSeedLoan(
  idFactory: IdFactory,
  input: Omit<SeedLoan, "id" | "outstandingPrincipalCents" | "installments" | "missedPayments">,
): SeedLoan {
  const principal = BigInt(input.originalPrincipalCents);
  const installments = fixedPrincipalInstallments(
    principal,
    input.termMonths,
    input.annualRateBp,
    input.seasonedMonths,
    input.status === "delinquent",
  );
  const outstanding = sumBigints(
    installments
      .filter((installment) => installment.status !== "paid")
      .map((installment) => BigInt(installment.principalCents)),
  );
  return {
    ...input,
    id: idFactory.next("loan"),
    outstandingPrincipalCents: outstanding.toString(),
    missedPayments: input.status === "delinquent" ? 1 : 0,
    installments,
  };
}

function seedLoans(
  runId: string,
  drafts: readonly ResidentDraft[],
  idFactory: IdFactory,
  rng: Rng,
): SeedLoan[] {
  const loans: SeedLoan[] = [
    createSeedLoan(idFactory, {
      runId,
      borrowerKind: "business",
      borrowerId: "biz_ironvale",
      purpose: "working_capital",
      originalPrincipalCents: "30000000",
      annualRateBp: 650,
      termMonths: 36,
      seasonedMonths: 22,
      status: "current",
    }),
  ];
  const candidates = rng.shuffle(
    drafts.filter(
      (draft) =>
        draft.age >= 23 &&
        draft.slot.employmentStatus !== "retired" &&
        draft.slot.employmentStatus !== "student" &&
        draft.slot.roleCode !== "ironvale.owner",
    ),
  ).slice(0, 7);
  for (let index = 0; index < candidates.length; index++) {
    const original = BigInt(rng.int(6, 24)) * 50_000n;
    const delinquent = index === candidates.length - 1;
    loans.push(createSeedLoan(idFactory, {
      runId,
      borrowerKind: "agent",
      borrowerId: candidates[index]!.agentId,
      purpose: index % 2 === 0 ? "vehicle" : "appliance",
      originalPrincipalCents: original.toString(),
      annualRateBp: rng.int(575, 1_050),
      termMonths: 24,
      seasonedMonths: rng.int(5, 12),
      status: delinquent ? "delinquent" : "current",
    }));
  }
  return loans;
}

function edgeKey(left: string, right: string): string {
  return compareCodeUnit(left, right) < 0 ? `${left}|${right}` : `${right}|${left}`;
}

function seedSocialGraph(
  runId: string,
  drafts: readonly ResidentDraft[],
  households: readonly Household[],
  idFactory: IdFactory,
  rng: Rng,
): Relationship[] {
  const edges = new Map<string, SocialEdge>();
  const degrees = new Map(drafts.map((draft) => [draft.agentId, 0]));
  const add = (
    left: string,
    right: string,
    type: Relationship["type"],
    strength: number,
    replace = false,
  ): boolean => {
    if (left === right) return false;
    const key = edgeKey(left, right);
    const existing = edges.get(key);
    const ordered = compareCodeUnit(left, right) < 0 ? [left, right] as const : [right, left] as const;
    if (existing !== undefined) {
      if (replace) edges.set(key, { left: ordered[0], right: ordered[1], type, strength });
      return false;
    }
    if ((degrees.get(left) ?? 0) >= 15 || (degrees.get(right) ?? 0) >= 15) return false;
    edges.set(key, { left: ordered[0], right: ordered[1], type, strength });
    degrees.set(left, (degrees.get(left) ?? 0) + 1);
    degrees.set(right, (degrees.get(right) ?? 0) + 1);
    return true;
  };

  const ring = rng.shuffle(drafts.map((draft) => draft.agentId));
  for (let index = 0; index < ring.length; index++) {
    add(ring[index]!, ring[(index + 1) % ring.length]!, "friend", rng.int(25, 65));
  }
  for (const household of households) {
    for (let left = 0; left < household.memberAgentIds.length; left++) {
      for (let right = left + 1; right < household.memberAgentIds.length; right++) {
        add(
          household.memberAgentIds[left]!,
          household.memberAgentIds[right]!,
          "family",
          rng.int(50, 90),
          true,
        );
      }
    }
  }

  const organizationGroups = new Map<string, string[]>();
  for (const draft of drafts) {
    if (draft.slot.organizationId === null || draft.slot.employmentStatus !== "employed") continue;
    const group = organizationGroups.get(draft.slot.organizationId) ?? [];
    group.push(draft.agentId);
    organizationGroups.set(draft.slot.organizationId, group);
  }
  for (const group of organizationGroups.values()) {
    if (group.length <= 6) {
      for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) {
          add(group[left]!, group[right]!, "colleague", rng.int(20, 60));
        }
      }
    } else {
      const order = rng.shuffle([...group]);
      for (let index = 0; index < order.length; index++) {
        add(order[index]!, order[(index + 1) % order.length]!, "colleague", rng.int(20, 60));
        add(order[index]!, order[(index + 2) % order.length]!, "colleague", rng.int(20, 60));
      }
    }
  }

  const roleAgents = (roleCode: string): string[] =>
    drafts.filter((draft) => draft.slot.roleCode === roleCode).map((draft) => draft.agentId);
  const owners = drafts
    .filter((draft) => draft.occupation.code === "business_owner")
    .map((draft) => draft.agentId);
  const adversaries: readonly (readonly [string, string])[] = [
    [owners[1]!, owners[2]!],
    [roleAgents("government.mayor")[0]!, roleAgents("independent.investor")[0]!],
    [roleAgents("news.journalist")[0]!, owners[0]!],
  ];
  for (const [left, right] of adversaries) add(left, right, "adversary", rng.int(-60, -20), true);

  let attempts = 0;
  while (edges.size < TARGET_UNDIRECTED_RELATIONSHIPS && attempts < 100_000) {
    attempts += 1;
    const left = rng.pick(drafts).agentId;
    const right = rng.pick(drafts).agentId;
    add(left, right, "friend", rng.int(20, 75));
  }
  if (edges.size !== TARGET_UNDIRECTED_RELATIONSHIPS) {
    throw new EngineError("VALIDATION_FAILED", "social graph could not reach target degree", {
      edges: edges.size,
      attempts,
    });
  }

  const relationships: Relationship[] = [];
  const sortedEdges = [...edges.values()].sort((left, right) =>
    compareCodeUnit(edgeKey(left.left, left.right), edgeKey(right.left, right.right)),
  );
  for (const edge of sortedEdges) {
    relationships.push(relationshipSchema.parse({
      id: idFactory.next("rel"),
      runId,
      fromAgentId: edge.left,
      toAgentId: edge.right,
      type: edge.type,
      strength: edge.strength,
      lastInteractionTick: 0,
    }));
    relationships.push(relationshipSchema.parse({
      id: idFactory.next("rel"),
      runId,
      fromAgentId: edge.right,
      toAgentId: edge.left,
      type: edge.type,
      strength: edge.strength,
      lastInteractionTick: 0,
    }));
  }
  return relationships;
}

function seedGoals(
  drafts: readonly ResidentDraft[],
  founderCandidates: ReadonlySet<string>,
  idFactory: IdFactory,
  rng: Rng,
): Goal[] {
  const goals: Goal[] = [];
  for (const draft of drafts) {
    const count = rng.int(1, 3);
    const selected: { kind: string; params: Record<string, unknown>; activationRule: string }[] = [];
    if (founderCandidates.has(draft.agentId)) {
      selected.push({
        kind: "start_business",
        params: {
          sector: rng.pick(["retail", "food_service", "professional_services", "technology"]),
          targetSavingsCents: "1500000",
        },
        activationRule: "savings_and_ambition_ready",
      });
    }

    const pool: { kind: string; params: Record<string, unknown>; activationRule: string }[] = [];
    if (draft.slot.employmentStatus === "student") {
      pool.push({ kind: "finish_school", params: {}, activationRule: "school_progress_due" });
    } else if (draft.slot.employmentStatus === "unemployed") {
      pool.push({ kind: "find_job", params: {}, activationRule: "job_opening_seen" });
    } else if (draft.occupation.code === "business_owner") {
      pool.push(
        { kind: "grow_business", params: { targetRevenueGrowthBp: 1_000 }, activationRule: "growth_opportunity_seen" },
        { kind: "pay_off_loan", params: {}, activationRule: "cash_buffer_ready" },
      );
    } else if (draft.age >= 55) {
      pool.push({ kind: "retire_comfortably", params: { targetSavingsCents: "25000000" }, activationRule: "retirement_review_due" });
    }
    pool.push(
      { kind: "save_amount", params: { targetCents: "500000" }, activationRule: "budget_review_due" },
      { kind: "buy_durable", params: { targetCents: "150000" }, activationRule: "durable_need_detected" },
      { kind: "find_better_job", params: {}, activationRule: "career_review_due" },
    );
    for (const candidate of rng.shuffle(pool)) {
      if (selected.length >= count) break;
      if (!selected.some((goal) => goal.kind === candidate.kind)) selected.push(candidate);
    }
    for (let index = 0; index < selected.length; index++) {
      const selectedGoal = selected[index]!;
      goals.push(goalSchema.parse({
        id: idFactory.next("gol"),
        agentId: draft.agentId,
        kind: selectedGoal.kind,
        params: selectedGoal.params,
        priority: selectedGoal.kind === "start_business" ? 5 : rng.int(1, 4),
        status: index === 0 ? "active" : "dormant",
        activationRule: selectedGoal.activationRule,
        progress: 0,
      }));
    }
  }
  return goals;
}

function ageBandCounts(residents: readonly RiverbendResident[]): Record<string, number> {
  const counts = { "16_22": 0, "23_34": 0, "35_49": 0, "50_64": 0, "65_plus": 0 };
  for (const resident of residents) {
    const age = resident.persona.age;
    if (age <= 22) counts["16_22"] += 1;
    else if (age <= 34) counts["23_34"] += 1;
    else if (age <= 49) counts["35_49"] += 1;
    else if (age <= 64) counts["50_64"] += 1;
    else counts["65_plus"] += 1;
  }
  return counts;
}

function wealthGiniMillionths(balances: readonly bigint[]): number {
  const sorted = [...balances].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const total = sumBigints(sorted);
  if (total === 0n) return 0;
  let weighted = 0n;
  for (let index = 0; index < sorted.length; index++) weighted += BigInt(index + 1) * sorted[index]!;
  const count = BigInt(sorted.length);
  const numerator = 2n * weighted - (count + 1n) * total;
  return Number((numerator * 1_000_000n) / (count * total));
}

function graphStats(relationships: readonly Relationship[], agentIds: readonly string[]): {
  undirected: number;
  meanDegreeMilli: number;
  minDegree: number;
  maxDegree: number;
  connected: boolean;
  symmetric: boolean;
} {
  const neighbors = new Map(agentIds.map((id) => [id, new Set<string>()]));
  const directions = new Set<string>();
  for (const relationship of relationships) {
    neighbors.get(relationship.fromAgentId)?.add(relationship.toAgentId);
    directions.add(`${relationship.fromAgentId}|${relationship.toAgentId}|${relationship.type}|${relationship.strength}`);
  }
  let symmetric = true;
  for (const relationship of relationships) {
    if (!directions.has(`${relationship.toAgentId}|${relationship.fromAgentId}|${relationship.type}|${relationship.strength}`)) {
      symmetric = false;
      break;
    }
  }
  const degrees = [...neighbors.values()].map((set) => set.size);
  const visited = new Set<string>();
  const queue = agentIds.length === 0 ? [] : [agentIds[0]!];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of neighbors.get(current) ?? []) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  const degreeTotal = degrees.reduce((total, degree) => total + degree, 0);
  return {
    undirected: degreeTotal / 2,
    meanDegreeMilli: degrees.length === 0 ? 0 : Math.round((degreeTotal * 1_000) / degrees.length),
    minDegree: degrees.length === 0 ? 0 : Math.min(...degrees),
    maxDegree: degrees.length === 0 ? 0 : Math.max(...degrees),
    connected: visited.size === agentIds.length,
    symmetric,
  };
}

function buildStats(draft: RiverbendPopulationData): RiverbendGenerationStats {
  const ageBands = ageBandCounts(draft.residents);
  const educationCounts: Record<EducationLevel, number> = { none: 0, hs: 0, college: 0, graduate: 0 };
  const roleCounts: Record<string, number> = {};
  for (const resident of draft.residents) {
    educationCounts[resident.persona.education] += 1;
    roleCounts[resident.roleCode] = (roleCounts[resident.roleCode] ?? 0) + 1;
  }
  const personBalances = draft.accounts
    .filter((account) => account.ownerKind === "agent")
    .map((account) => BigInt(account.balanceCents));
  const businessBalances = draft.accounts
    .filter((account) => account.ownerKind === "business")
    .map((account) => BigInt(account.balanceCents));
  const householdCounts: Record<Household["structure"], number> = {
    single: 0,
    couple: 0,
    family: 0,
    shared: 0,
  };
  for (const household of draft.households) householdCounts[household.structure] += 1;
  const graph = graphStats(draft.relationships, draft.residents.map((resident) => resident.agent.id));
  const annualIncome = sumBigints(draft.residents.map((resident) => BigInt(resident.annualIncomeCents)));
  return {
    population: draft.residents.length,
    roleCounts,
    ageBands,
    educationCounts,
    meanAnnualIncomeCents: (annualIncome / BigInt(draft.residents.length)).toString(),
    personDepositsCents: sumBigints(personBalances).toString(),
    businessDepositsCents: sumBigints(businessBalances).toString(),
    wealthGiniMillionths: wealthGiniMillionths(personBalances),
    householdCounts,
    undirectedRelationships: graph.undirected,
    meanRelationshipDegreeMilli: graph.meanDegreeMilli,
    minRelationshipDegree: graph.minDegree,
    maxRelationshipDegree: graph.maxDegree,
    activeFounderGoals: draft.goals.filter(
      (goal) => goal.kind === "start_business" && goal.status === "active",
    ).length,
    delinquentPersonalLoans: draft.loans.filter(
      (loan) => loan.borrowerKind === "agent" && loan.status === "delinquent",
    ).length,
    creditOutstandingCents: sumBigints(
      draft.loans.map((loan) => BigInt(loan.outstandingPrincipalCents)),
    ).toString(),
  };
}

function addIssue(
  issues: RiverbendValidationIssue[],
  code: string,
  message: string,
  path?: string,
): void {
  issues.push(path === undefined ? { code, message } : { code, message, path });
}

export function validateRiverbendPopulation(
  draft: RiverbendPopulationData,
): readonly RiverbendValidationIssue[] {
  const issues: RiverbendValidationIssue[] = [];
  if (draft.residents.length !== 100) addIssue(issues, "population.count", "population must contain exactly 100 residents");
  const expectedIdCounts: Readonly<Record<string, number>> = {
    agt: draft.residents.length,
    per: draft.residents.length,
    hh: draft.households.length,
    acct: draft.accounts.length,
    txn: draft.mintTransactions.length,
    loan: draft.loans.length,
    rel: draft.relationships.length,
    gol: draft.goals.length,
  };
  for (const [prefix, expected] of Object.entries(expectedIdCounts)) {
    if (draft.idState[prefix] !== expected) {
      addIssue(
        issues,
        "ids.checkpoint",
        "ID checkpoint for " + prefix + " must equal generated entity count " + expected,
      );
    }
  }

  for (let index = 0; index < draft.residents.length; index++) {
    const resident = draft.residents[index]!;
    const agentResult = agentSchema.safeParse(resident.agent);
    const personaResult = personaSchema.safeParse(resident.persona);
    if (!agentResult.success) addIssue(issues, "schema.agent", agentResult.error.message, `residents.${index}.agent`);
    if (!personaResult.success) addIssue(issues, "schema.persona", personaResult.error.message, `residents.${index}.persona`);
    const slot = RIVERBEND_ROLE_SLOTS[resident.rosterIndex];
    const occupation = OCCUPATIONS_BY_CODE.get(resident.agent.occupationCode);
    if (slot === undefined || resident.roleCode !== slot.roleCode) {
      addIssue(issues, "roster.slot", "resident does not match its versioned roster slot", `residents.${index}`);
    }
    if (occupation === undefined) {
      addIssue(issues, "occupation.unknown", "resident occupation is not cataloged", `residents.${index}`);
      continue;
    }
    if (resident.persona.age < occupation.minimumAge || resident.persona.age > (slot?.maxAge ?? 100)) {
      addIssue(issues, "persona.age_role", "resident age violates role bounds", `residents.${index}.persona.age`);
    }
    if (EDUCATION_RANK[resident.persona.education] < EDUCATION_RANK[occupation.minimumEducation]) {
      addIssue(issues, "persona.education_role", "resident education violates role minimum", `residents.${index}.persona.education`);
    }
    const income = BigInt(resident.annualIncomeCents);
    if (income < BigInt(occupation.baseWageBand.minAnnualCents) || income > BigInt(occupation.baseWageBand.maxAnnualCents)) {
      addIssue(issues, "income.band", "annual income is outside the occupation band", `residents.${index}.annualIncomeCents`);
    }
  }

  const actualRoleCounts: Record<string, number> = {};
  for (const resident of draft.residents) actualRoleCounts[resident.roleCode] = (actualRoleCounts[resident.roleCode] ?? 0) + 1;
  for (const [roleCode, expected] of Object.entries(RIVERBEND_ROLE_COUNTS)) {
    if (actualRoleCounts[roleCode] !== expected) addIssue(issues, "roster.count", `role ${roleCode} must occur ${expected} times`);
  }

  const normalizedNames = draft.residents.map((resident) => normalizeSyntheticName(resident.persona.name));
  if (new Set(normalizedNames).size !== normalizedNames.length) addIssue(issues, "names.unique", "resident names must be unique");

  const membership = new Map<string, number>();
  const householdCounts: Record<Household["structure"], number> = { single: 0, couple: 0, family: 0, shared: 0 };
  for (let index = 0; index < draft.households.length; index++) {
    const household = draft.households[index]!;
    const result = householdSchema.safeParse(household);
    if (!result.success) addIssue(issues, "schema.household", result.error.message, `households.${index}`);
    householdCounts[household.structure] += 1;
    for (const agentId of household.memberAgentIds) membership.set(agentId, (membership.get(agentId) ?? 0) + 1);
  }
  const expectedHouseholds: Record<Household["structure"], number> = { single: 22, couple: 14, family: 12, shared: 4 };
  for (const structure of Object.keys(expectedHouseholds) as Household["structure"][]) {
    if (householdCounts[structure] !== expectedHouseholds[structure]) addIssue(issues, "household.count", `${structure} household count is invalid`);
  }
  for (const resident of draft.residents) {
    if (membership.get(resident.agent.id) !== 1) {
      addIssue(issues, "household.membership", "every resident must belong to exactly one household", resident.agent.id);
    }
    const household = draft.households.find((candidate) => candidate.id === resident.agent.householdId);
    if (household === undefined || !household.memberAgentIds.includes(resident.agent.id)) {
      addIssue(issues, "household.link", "agent household link is inconsistent", resident.agent.id);
    }
  }
  const studentIds = new Set(
    draft.residents.filter((resident) => resident.agent.employmentStatus === "student").map((resident) => resident.agent.id),
  );
  const familyStudents = draft.households
    .filter((household) => household.structure === "family")
    .flatMap((household) => household.memberAgentIds)
    .filter((id) => studentIds.has(id)).length;
  const sharedStudents = draft.households
    .filter((household) => household.structure === "shared")
    .flatMap((household) => household.memberAgentIds)
    .filter((id) => studentIds.has(id)).length;
  if (familyStudents !== 9 || sharedStudents !== 2) addIssue(issues, "household.students", "students must be split 9 family and 2 shared");

  const accountIds = new Set(draft.accounts.map((account) => account.id));
  const balanceTotal = sumBigints(draft.accounts.map((account) => BigInt(account.balanceCents)));
  const mintTotal = sumBigints(draft.mintTransactions.map((transaction) => BigInt(transaction.amountCents)));
  if (balanceTotal !== mintTotal) addIssue(issues, "books.mint_balance", "mint transactions must equal opening account balances");
  if (draft.mintTransactions.some((transaction) => !accountIds.has(transaction.accountId))) addIssue(issues, "books.mint_account", "mint transaction references an unknown account");
  const personTotal = sumBigints(draft.accounts.filter((account) => account.ownerKind === "agent").map((account) => BigInt(account.balanceCents)));
  const businessTotal = sumBigints(draft.accounts.filter((account) => account.ownerKind === "business").map((account) => BigInt(account.balanceCents)));
  if (personTotal !== PERSON_DEPOSIT_TOTAL_CENTS) addIssue(issues, "books.person_total", "person deposits must total $4.2M");
  if (businessTotal !== BUSINESS_DEPOSIT_TOTAL_CENTS) addIssue(issues, "books.business_total", "business deposits must total $0.9M");

  for (const loan of draft.loans) {
    const principalTotal = sumBigints(loan.installments.map((installment) => BigInt(installment.principalCents)));
    const outstanding = sumBigints(loan.installments.filter((installment) => installment.status !== "paid").map((installment) => BigInt(installment.principalCents)));
    if (principalTotal !== BigInt(loan.originalPrincipalCents) || outstanding !== BigInt(loan.outstandingPrincipalCents)) {
      addIssue(issues, "loan.schedule", "loan schedule and outstanding principal are inconsistent", loan.id);
    }
    const missed = loan.installments.filter((installment) => installment.status === "missed").length;
    if (missed !== loan.missedPayments || (loan.status === "delinquent") !== (missed === 1)) {
      addIssue(issues, "loan.delinquency", "loan delinquency status is inconsistent", loan.id);
    }
  }
  if (draft.loans.filter((loan) => loan.borrowerKind === "agent").length !== 7) addIssue(issues, "loan.personal_count", "opening state must contain seven personal loans");
  if (draft.loans.filter((loan) => loan.borrowerKind === "agent" && loan.status === "delinquent").length !== 1) addIssue(issues, "loan.storyline", "opening state must contain one delinquent personal loan");

  const ageCounts = ageBandCounts(draft.residents);
  const expectedAges: Record<string, number> = { "16_22": 11, "23_34": 30, "35_49": 31, "50_64": 19, "65_plus": 9 };
  for (const [band, expected] of Object.entries(expectedAges)) {
    if (ageCounts[band] !== expected) addIssue(issues, "distribution.age", `age band ${band} must contain ${expected}`);
  }
  const educationCounts: Record<EducationLevel, number> = { none: 0, hs: 0, college: 0, graduate: 0 };
  for (const resident of draft.residents) educationCounts[resident.persona.education] += 1;
  for (const level of Object.keys(EDUCATION_TARGETS) as EducationLevel[]) {
    if (educationCounts[level] !== EDUCATION_TARGETS[level]) addIssue(issues, "distribution.education", `${level} education count is invalid`);
  }
  const totalIncome = sumBigints(draft.residents.map((resident) => BigInt(resident.annualIncomeCents)));
  const meanIncome = totalIncome / BigInt(draft.residents.length);
  if (meanIncome < 5_000_000n || meanIncome > 5_600_000n) addIssue(issues, "distribution.income", "mean annual income must be $50k-$56k");
  const gini = wealthGiniMillionths(
    draft.accounts.filter((account) => account.ownerKind === "agent").map((account) => BigInt(account.balanceCents)),
  );
  if (gini < 500_000 || gini > 600_000) addIssue(issues, "distribution.gini", `wealth Gini ${gini} is outside 0.50-0.60`);

  for (const key of PERSONALITY_KEYS) {
    const mean = draft.residents.reduce((total, resident) => total + resident.persona.personality[key], 0) / draft.residents.length;
    if (mean < 42 || mean > 58) addIssue(issues, "distribution.personality", `${key} mean ${mean} is outside 50 +/- 8`);
  }
  for (const key of OPINION_KEYS) {
    const positive = draft.residents.filter((resident) => resident.persona.opinions[key] > 0).length;
    const negative = draft.residents.filter((resident) => resident.persona.opinions[key] < 0).length;
    if (positive < 15 || negative < 15) addIssue(issues, "distribution.opinions", `${key} lacks opinion diversity`);
  }

  const graph = graphStats(draft.relationships, draft.residents.map((resident) => resident.agent.id));
  if (!graph.connected) addIssue(issues, "graph.connected", "social graph must be connected");
  if (!graph.symmetric) addIssue(issues, "graph.symmetric", "social relationships must be symmetric");
  if (graph.minDegree < 2 || graph.maxDegree > 15 || graph.meanDegreeMilli < 4_000 || graph.meanDegreeMilli > 8_000) {
    addIssue(issues, "graph.degree", "social graph degree bounds are invalid");
  }
  if (draft.relationships.filter((relationship) => relationship.type === "adversary").length !== 6) addIssue(issues, "graph.adversaries", "social graph must contain three symmetric adversary pairs");

  for (let index = 0; index < draft.relationships.length; index++) {
    const result = relationshipSchema.safeParse(draft.relationships[index]);
    if (!result.success) addIssue(issues, "schema.relationship", result.error.message, `relationships.${index}`);
  }
  for (let index = 0; index < draft.goals.length; index++) {
    const result = goalSchema.safeParse(draft.goals[index]);
    if (!result.success) addIssue(issues, "schema.goal", result.error.message, `goals.${index}`);
  }
  for (const resident of draft.residents) {
    const count = draft.goals.filter((goal) => goal.agentId === resident.agent.id).length;
    if (count < 1 || count > 3) addIssue(issues, "goals.count", "each resident must have one to three goals", resident.agent.id);
  }
  const activeFounders = draft.goals.filter((goal) => goal.kind === "start_business" && goal.status === "active").length;
  if (activeFounders < 3 || activeFounders > 5) addIssue(issues, "goals.founders", "three to five active start-business goals are required");
  if (draft.residents.filter((resident) => resident.agent.employmentStatus === "unemployed").length !== 5) addIssue(issues, "storyline.unemployment", "opening state must contain five unemployed residents");
  return issues;
}

function omitRunIdentity<T extends object>(value: T): Omit<T, "runId"> {
  const copy = { ...value } as T & { runId?: unknown };
  delete copy.runId;
  return copy;
}

function populationHashInput(draft: RiverbendPopulationData): unknown {
  return {
    residents: draft.residents.map((resident) => ({
      ...resident,
      agent: omitRunIdentity(resident.agent),
    })),
    households: draft.households.map(omitRunIdentity),
    accounts: draft.accounts.map(omitRunIdentity),
    mintTransactions: draft.mintTransactions.map(omitRunIdentity),
    loans: draft.loans.map(omitRunIdentity),
    relationships: draft.relationships.map(omitRunIdentity),
    goals: draft.goals,
    idState: draft.idState,
  };
}

export function generateRiverbendPopulation(
  options: GenerateRiverbendPopulationOptions,
): RiverbendPopulation {
  const root = Rng.root(options.seed).fork(`${RIVERBEND_WORLD_SPEC}/${SPEC_HASH}`);
  const idFactory = new IdFactory();
  const ages = assignAges(RIVERBEND_ROLE_SLOTS, root.fork("gen.age"));
  const education = assignEducation(RIVERBEND_ROLE_SLOTS, root.fork("gen.education"));
  const names = assignNames(
    RIVERBEND_ROLE_SLOTS.length,
    root.fork("gen.names"),
    options.nameBlocklist ?? PUBLIC_FIGURE_NAME_BLOCKLIST,
  );

  const drafts: ResidentDraft[] = RIVERBEND_ROLE_SLOTS.map((slot, rosterIndex) => {
    const occupation = OCCUPATIONS_BY_CODE.get(slot.occupationCode);
    if (occupation === undefined) {
      throw new EngineError("VALIDATION_FAILED", `unknown roster occupation: ${slot.occupationCode}`);
    }
    const incomeRng = root.fork(`gen.income/${rosterIndex}`);
    const minimumIncome = BigInt(occupation.baseWageBand.minAnnualCents);
    const maximumIncome = BigInt(occupation.baseWageBand.maxAnnualCents);
    const annualIncomeCents = minimumIncome + BigInt(incomeRng.int(0, Number(maximumIncome - minimumIncome)));
    return {
      rosterIndex,
      slot,
      agentId: idFactory.next("agt"),
      personaId: idFactory.next("per"),
      name: names[rosterIndex]!,
      age: ages[rosterIndex]!,
      education: education[rosterIndex]!,
      occupation,
      personality: samplePersonality(occupation, root.fork(`gen.personality/${rosterIndex}`)),
      opinions: sampleOpinions(slot, occupation, annualIncomeCents, root.fork(`gen.opinions/${rosterIndex}`)),
      skills: sampleSkills(occupation, root.fork(`gen.skills/${rosterIndex}`)),
      annualIncomeCents,
    };
  });
  adjustIncomes(drafts);
  ensureOpinionDiversity(drafts);
  const founderCandidates = selectFounderCandidates(drafts);
  const households = assembleHouseholds(options.runId, drafts, idFactory, root.fork("gen.households"));

  const residents = drafts.map((draft): RiverbendResident => {
    const persona = personaSchema.parse({
      id: draft.personaId,
      agentId: draft.agentId,
      name: draft.name,
      age: draft.age,
      education: draft.education,
      skills: draft.skills,
      personality: draft.personality,
      opinions: draft.opinions,
      bioSummary: `${draft.name} is a synthetic Riverbend resident working as ${draft.occupation.title.toLowerCase()}.`,
      promptVersion: 1,
    });
    const agent = agentSchema.parse({
      id: draft.agentId,
      runId: options.runId,
      personaId: draft.personaId,
      householdId: draft.householdId,
      occupationCode: draft.occupation.code,
      employmentStatus: draft.slot.employmentStatus,
      creditScore: sampleCreditScore(draft, root.fork(`gen.credit-score/${draft.rosterIndex}`)),
      quarantine: { mode: "none" },
      aliveFlags: { alive: true, canAct: true },
    });
    return {
      rosterIndex: draft.rosterIndex,
      roleCode: draft.slot.roleCode,
      organizationId: draft.slot.organizationId,
      segment: draft.slot.segment,
      agent,
      persona,
      annualIncomeCents: draft.annualIncomeCents.toString(),
    };
  });
  const books = createOpeningBooks(options.runId, drafts, idFactory, root.fork("gen.finances"));
  const loans = seedLoans(options.runId, drafts, idFactory, root.fork("gen.credit"));
  const relationships = seedSocialGraph(
    options.runId,
    drafts,
    households,
    idFactory,
    root.fork("gen.social"),
  );
  const goals = seedGoals(drafts, founderCandidates, idFactory, root.fork("gen.goals"));
  const draft: PopulationDraft = {
    residents,
    households,
    accounts: books.accounts,
    mintTransactions: books.mintTransactions,
    loans,
    relationships,
    goals,
    idState: idFactory.serialize(),
  };
  const issues = validateRiverbendPopulation(draft);
  if (issues.length > 0) {
    throw new EngineError("VALIDATION_FAILED", "Riverbend population failed the all-or-nothing generation gate", {
      worldSpec: RIVERBEND_WORLD_SPEC,
      seed: options.seed,
      specHash: SPEC_HASH,
      issues,
    });
  }
  const report: RiverbendGenerationReport = {
    worldSpec: RIVERBEND_WORLD_SPEC,
    seed: options.seed,
    specHash: SPEC_HASH,
    populationHash: hashValue(populationHashInput(draft)),
    validation: "passed",
    stats: buildStats(draft),
  };
  return { ...draft, report };
}

export const RIVERBEND_SPEC_HASH = SPEC_HASH;
