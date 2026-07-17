import { describe, expect, it } from "vitest";
import {
  OCCUPATIONS_BY_CODE,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  canonicalStringify,
} from "@worldtangle/shared";
import {
  RIVERBEND_ROLE_COUNTS,
  RIVERBEND_SPEC_HASH,
  generateRiverbendPopulation,
} from "./index";

describe("Riverbend population generator", () => {
  it("produces the same canonical population for the same run and seed", () => {
    const first = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });
    const second = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.report.populationHash).toBe(first.report.populationHash);
    expect(second.report.specHash).toBe(RIVERBEND_SPEC_HASH);
    expect(generateRiverbendPopulation({ runId: "run_00000001", seed: 43 }).report.populationHash)
      .not.toBe(first.report.populationHash);
  });

  it("keeps the population hash independent of the enclosing run identity", () => {
    const first = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });
    const second = generateRiverbendPopulation({ runId: "run_00000002", seed: 42 });

    expect(second.report.populationHash).toBe(first.report.populationHash);
  });

  it("meets every exact roster, household, opening-book, and storyline gate", () => {
    const population = generateRiverbendPopulation({ runId: "run_00000001", seed: 42 });
    const stats = population.report.stats;

    expect(population.report.validation).toBe("passed");
    expect(stats.population).toBe(100);
    expect(stats.roleCounts).toEqual(RIVERBEND_ROLE_COUNTS);
    expect(stats.ageBands).toEqual({
      "16_22": 11,
      "23_34": 30,
      "35_49": 31,
      "50_64": 19,
      "65_plus": 9,
    });
    expect(stats.educationCounts).toEqual({ none: 8, hs: 42, college: 38, graduate: 12 });
    expect(stats.householdCounts).toEqual({ single: 22, couple: 14, family: 12, shared: 4 });
    expect(stats.meanAnnualIncomeCents).toBe("5300000");
    expect(stats.personDepositsCents).toBe("420000000");
    expect(stats.businessDepositsCents).toBe("90000000");
    expect(stats.wealthGiniMillionths).toBeGreaterThanOrEqual(500_000);
    expect(stats.wealthGiniMillionths).toBeLessThanOrEqual(600_000);
    expect(stats.undirectedRelationships).toBe(300);
    expect(stats.meanRelationshipDegreeMilli).toBe(6_000);
    expect(stats.minRelationshipDegree).toBeGreaterThanOrEqual(2);
    expect(stats.maxRelationshipDegree).toBeLessThanOrEqual(15);
    expect(stats.activeFounderGoals).toBe(4);
    expect(stats.delinquentPersonalLoans).toBe(1);
    expect(population.loans).toHaveLength(8);
    expect(population.idState).toMatchObject({
      agt: 100,
      per: 100,
      hh: 52,
      acct: 106,
      txn: 106,
      loan: 8,
      rel: 600,
      gol: population.goals.length,
    });

    const balanceTotal = population.accounts.reduce(
      (total, account) => total + BigInt(account.balanceCents),
      0n,
    );
    const mintTotal = population.mintTransactions.reduce(
      (total, transaction) => total + BigInt(transaction.amountCents),
      0n,
    );
    expect(mintTotal).toBe(balanceTotal);
  });

  it("honors role constraints and produces complete persona contracts", () => {
    const population = generateRiverbendPopulation({ runId: "run_00000001", seed: "persona" });
    const names = new Set<string>();

    for (const resident of population.residents) {
      const occupation = OCCUPATIONS_BY_CODE.get(resident.agent.occupationCode)!;
      expect(resident.persona.age).toBeGreaterThanOrEqual(occupation.minimumAge);
      expect(BigInt(resident.annualIncomeCents)).toBeGreaterThanOrEqual(
        BigInt(occupation.baseWageBand.minAnnualCents),
      );
      expect(BigInt(resident.annualIncomeCents)).toBeLessThanOrEqual(
        BigInt(occupation.baseWageBand.maxAnnualCents),
      );
      expect(Object.keys(resident.persona.skills).length).toBeGreaterThanOrEqual(2);
      names.add(resident.persona.name.toLowerCase());
    }
    expect(names.size).toBe(100);
    expect(population.relationships).toHaveLength(600);
    expect(population.goals.length).toBeGreaterThanOrEqual(100);
    expect(population.goals.length).toBeLessThanOrEqual(300);
  });

  it.each([0, 1, 2, 7, 19, 42, 99, 404, "alpha", "riverbend"])(
    "stays inside every hard envelope for seed %s",
    (seed) => {
      const population = generateRiverbendPopulation({ runId: "run_00000001", seed });
      expect(population.report.validation).toBe("passed");
      expect(population.report.stats.population).toBe(100);
    },
  );

  it("aborts without a partial population when no synthetic name is allowed", () => {
    const allNames = SYNTHETIC_FIRST_NAMES.flatMap((first) =>
      SYNTHETIC_LAST_NAMES.map((last) => `${first} ${last}`),
    );
    expect(() => generateRiverbendPopulation({
      runId: "run_00000001",
      seed: 42,
      nameBlocklist: allNames,
    })).toThrow(/too few allowed unique names/);
  });
});
