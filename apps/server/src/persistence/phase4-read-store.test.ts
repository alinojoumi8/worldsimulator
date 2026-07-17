import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  companyDetailResponseSchema,
  companyListQuerySchema,
  companyListResponseSchema,
  contractDetailResponseSchema,
  contractListQuerySchema,
  contractListResponseSchema,
  goodsMarketResponseSchema,
  IdFactory,
  institutionDetailResponseSchema,
  institutionListQuerySchema,
  institutionListResponseSchema,
  jobDetailResponseSchema,
  jobListQuerySchema,
  jobListResponseSchema,
  Rng,
} from "@worldtangle/shared";
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteInsolvencyStore } from "./insolvency-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4ReadStore } from "./phase4-read-store";
import { SqlitePhase4Store } from "./phase4-store";
import { computeLogicalStateHash } from "./snapshot-store";
import {
  appendTestTickEvent,
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";

const META = { simulated: true, apiVersion: 1 } as const;
const directories: string[] = [];
const databases: WorldDatabase[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-phase4-read-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggerEvents);
  const ids = IdFactory.restore(population.idState);
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);
  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const market = new SqliteMarketStore(db, TEST_RUN_ID);
  const context = (tick: number, phase: TickContext["phase"]): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
    phase,
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => appendTestTickEvent(db, {
      simulationId: TEST_SIMULATION_ID,
      runId: TEST_RUN_ID,
      ids,
      tick,
      simDate: `Y0001-M01-D${String(tick + 1).padStart(2, "0")}`,
      phase,
      type,
      payload,
      options,
    }),
  });
  const lawFirmAccount = finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = phase4.requestCompanyFormation({
    name: "Riverbend Pantry",
    sector: "grocery_retail",
    founderAgentId: "agt_00000001",
    jurisdiction: "Riverbend",
    foundingCapitalCents: "200000",
    totalShares: "1000",
    lawFirmAccountId: lawFirmAccount.id,
    incorporationFeeCents: "10000",
    tick: 0,
    ids,
  });
  for (const party of formation.contract.parties) {
    phase4.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, ids);
  }
  for (let tick = 1; tick <= 5; tick++) {
    phase4.processLegalObligations(context(tick, "obligations"));
    phase4.processCompanyFormations(context(tick, "execute"));
  }
  const job = phase4.postJob({
    employerId: formation.company.id,
    occupationCode: "retail_worker",
    title: "Pantry worker",
    annualWageCents: "4000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids,
  });
  const worker = population.residents.find((resident) => (
    resident.agent.employmentStatus !== "employed" &&
    resident.agent.id !== formation.company.founderAgentId
  ));
  if (worker === undefined) throw new Error("worker missing");
  phase4.submitJobApplication({
    jobId: job.id,
    agentId: worker.agent.id,
    reservationWageCents: "2000000",
    tick: 6,
    ids,
  });
  phase4.processLaborMatching(context(6, "clearing"));
  market.createProductionOffering({
    companyId: formation.company.id,
    sku: "groceries",
    postedPriceCents: "400",
    unitCostCents: "300",
    laborHoursPerWorker: 8,
    productivityMilliunitsPerLaborHour: 1_250,
    capacityUnitsPerTick: 12,
    tick: 6,
    ids,
  });
  market.processProduction(context(7, "execute"));
  new SqliteInsolvencyStore(db, TEST_RUN_ID).assessCompany(
    formation.company.id,
    context(7, "obligations"),
  );
  db.prepare("UPDATE simulation_runs SET current_tick = 7 WHERE id = ?").run(TEST_RUN_ID);
  return { db, dataDir, companyId: formation.company.id, jobId: job.id };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WS-409 Phase 4 read projections", () => {
  it("serves contract-valid company, contract, job, institution, and market views", () => {
    const { db, companyId, jobId } = fixture();
    const store = new SqlitePhase4ReadStore(db, TEST_RUN_ID);
    const companies = store.listCompanies(companyListQuerySchema.parse({}));
    expect(companyListResponseSchema.parse({ items: companies, nextCursor: null, meta: META }))
      .toMatchObject({ items: [{ id: companyId, employees: 1 }] });

    const company = companyDetailResponseSchema.parse({ ...store.getCompany(companyId), meta: META });
    expect(company.company.status).toBe("active");
    expect(company.staff).toHaveLength(1);
    expect(company.offerings).toMatchObject([{ sku: "groceries", inventory: 10 }]);
    expect(company.timeline.map((item) => item.type)).toEqual(expect.arrayContaining([
      "company.formation.requested",
      "company.activated",
      "employment.created",
      "production.started",
      "company.solvency.assessed",
    ]));

    const contracts = store.listContracts(contractListQuerySchema.parse({}));
    expect(contractListResponseSchema.parse({ items: contracts, nextCursor: null, meta: META }).items)
      .toHaveLength(2);
    const contractId = String(contracts[0]!["id"]);
    expect(contractDetailResponseSchema.parse({ ...store.getContract(contractId), meta: META }).partyDetails)
      .toHaveLength(2);

    const jobs = store.listJobs(jobListQuerySchema.parse({}));
    expect(jobListResponseSchema.parse({ items: jobs, nextCursor: null, meta: META }))
      .toMatchObject({ items: [{ id: jobId, applicationCount: 1, filledCount: 1 }] });
    expect(jobDetailResponseSchema.parse({ ...store.getJob(jobId), meta: META }))
      .toMatchObject({ applications: [{ application: { status: "selected" } }] });

    const institutions = store.listInstitutions(institutionListQuerySchema.parse({}));
    expect(institutionListResponseSchema.parse({ items: institutions, nextCursor: null, meta: META }).items)
      .toHaveLength(8);
    expect(institutionDetailResponseSchema.parse({
      ...store.getInstitution("inst_first_ledger_bank"),
      meta: META,
    })).toMatchObject({ institution: { kind: "bank", staffCount: 4 } });

    expect(goodsMarketResponseSchema.parse({ ...store.goodsMarket(), meta: META }))
      .toMatchObject({ market: { tick: 7 }, products: expect.arrayContaining([
        expect.objectContaining({ product: expect.objectContaining({ sku: "groceries" }) }),
      ]) });
  });

  it("is read-only, deterministic across reopen, and rejects missing entities", () => {
    const { db, dataDir, companyId } = fixture();
    const before = computeLogicalStateHash(db, TEST_RUN_ID);
    const first = new SqlitePhase4ReadStore(db, TEST_RUN_ID).getCompany(companyId);
    expect(computeLogicalStateHash(db, TEST_RUN_ID)).toBe(before);
    expect(() => new SqlitePhase4ReadStore(db, TEST_RUN_ID).getCompany("co_zzzzzzzz"))
      .toThrow(/does not exist/);
    db.close();

    const reopened = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    expect(new SqlitePhase4ReadStore(reopened, TEST_RUN_ID).getCompany(companyId)).toEqual(first);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(before);
  });
});
