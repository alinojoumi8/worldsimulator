import { describe, expect, it } from "vitest";
import {
  agentSchema,
  occupationSchema,
  personaSchema,
  relationshipSchema,
} from "./agent";
import {
  assertSyntheticNameAllowed,
  OCCUPATION_CATALOG,
  PUBLIC_FIGURE_NAME_BLOCKLIST,
  SKILL_CATALOG,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
} from "./agent-catalogs";
import { EngineError } from "./envelope";

const initialWorldOccupationCodes = [
  "branch_manager",
  "loan_officer",
  "teller",
  "vc_partner",
  "vc_analyst",
  "lawyer",
  "paralegal",
  "school_principal",
  "teacher",
  "news_editor",
  "journalist",
  "mayor",
  "treasurer",
  "town_economist",
  "town_clerk",
  "maintenance_worker",
  "exchange_operations_manager",
  "plant_manager",
  "engineer",
  "energy_technician",
  "doctor",
  "nurse",
  "receptionist",
  "business_owner",
  "operations_manager",
  "accountant",
  "factory_worker",
  "retail_worker",
  "service_worker",
  "cook_server",
  "construction_worker",
  "junior_accountant",
  "freelance_software_engineer",
  "independent_investor",
  "freelance_journalist",
  "gig_delivery_worker",
  "student",
  "unemployed",
  "retiree",
  "homemaker",
] as const;

describe("agent and persona schemas", () => {
  it("accepts a complete synthetic agent identity", () => {
    const persona = personaSchema.parse({
      id: "per_00000001",
      agentId: "agt_00000001",
      name: "Aven Alderwick",
      age: 34,
      education: "college",
      skills: { finance: 72, communication: 61 },
      personality: {
        openness: 55,
        conscientiousness: 70,
        extraversion: 48,
        agreeableness: 62,
        neuroticism: 31,
        riskTolerance: 44,
        timePreference: 68,
        ambition: 73,
      },
      opinions: {
        redistribution: 10,
        regulation: -20,
        institutionalTrust: 35,
        economicOptimism: 5,
      },
      bioSummary: "A synthetic Riverbend resident working in banking.",
      promptVersion: 1,
    });
    expect(persona.name).toBe("Aven Alderwick");

    expect(
      agentSchema.parse({
        id: persona.agentId,
        runId: "run_00000001",
        personaId: persona.id,
        householdId: "hh_00000001",
        occupationCode: "loan_officer",
        employmentStatus: "employed",
        creditScore: 710,
        quarantine: { mode: "none" },
        aliveFlags: { alive: true, canAct: true },
      }),
    ).toMatchObject({ id: "agt_00000001", creditScore: 710 });
  });

  it("rejects out-of-range persona and relationship fields", () => {
    const base = {
      id: "per_00000001",
      agentId: "agt_00000001",
      name: "Aven Alderwick",
      age: 34,
      education: "college",
      skills: { finance: 72 },
      personality: {
        openness: 55,
        conscientiousness: 70,
        extraversion: 48,
        agreeableness: 62,
        neuroticism: 31,
        riskTolerance: 44,
        timePreference: 68,
        ambition: 73,
      },
      opinions: {
        redistribution: 10,
        regulation: -20,
        institutionalTrust: 35,
        economicOptimism: 5,
      },
      bioSummary: "Synthetic resident.",
      promptVersion: 1,
    };
    expect(personaSchema.safeParse({ ...base, age: 15 }).success).toBe(false);
    expect(
      personaSchema.safeParse({
        ...base,
        personality: { ...base.personality, ambition: 101 },
      }).success,
    ).toBe(false);
    expect(
      relationshipSchema.safeParse({
        id: "rel_00000001",
        runId: "run_00000001",
        fromAgentId: "agt_00000001",
        toAgentId: "agt_00000001",
        type: "friend",
        strength: 50,
        lastInteractionTick: 0,
      }).success,
    ).toBe(false);
  });
});

describe("M02 catalogs and synthetic names", () => {
  it("covers every INITIAL_WORLD role with valid wage and skill references", () => {
    const occupations = new Map(OCCUPATION_CATALOG.map((entry) => [entry.code, entry]));
    const skills = new Set(SKILL_CATALOG.map((entry) => entry.code));
    expect(new Set(occupations.keys()).size).toBe(OCCUPATION_CATALOG.length);
    expect(new Set(skills).size).toBe(SKILL_CATALOG.length);
    for (const code of initialWorldOccupationCodes) {
      const occupation = occupations.get(code);
      expect(occupation, `missing occupation ${code}`).toBeDefined();
      expect(occupationSchema.safeParse(occupation).success).toBe(true);
      expect(BigInt(occupation!.baseWageBand.minAnnualCents)).toBeLessThanOrEqual(
        BigInt(occupation!.baseWageBand.maxAnnualCents),
      );
      expect(occupation!.requiredSkills.every((skill) => skills.has(skill))).toBe(true);
    }
  });

  it("uses unique curated name components and rejects blocklist hits", () => {
    expect(new Set(SYNTHETIC_FIRST_NAMES).size).toBe(SYNTHETIC_FIRST_NAMES.length);
    expect(new Set(SYNTHETIC_LAST_NAMES).size).toBe(SYNTHETIC_LAST_NAMES.length);
    expect(() => assertSyntheticNameAllowed("Aven Alderwick")).not.toThrow();
    for (const blocked of PUBLIC_FIGURE_NAME_BLOCKLIST) {
      expect(() => assertSyntheticNameAllowed(blocked)).toThrow(EngineError);
    }
  });
});
