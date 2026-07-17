import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentFinancesResponseSchema,
  agentProfileResponseSchema,
  canonicalStringify,
  companyDetailResponseSchema,
  companyListResponseSchema,
  contractDetailResponseSchema,
  contractListResponseSchema,
  goodsMarketResponseSchema,
  IdFactory,
  institutionDetailResponseSchema,
  institutionListResponseSchema,
  jobDetailResponseSchema,
  jobListResponseSchema,
} from "@worldtangle/shared";
import { buildApp } from "./app";
import {
  openWorldDatabase,
  readRunCheckpoint,
  SqliteFinanceStore,
  SqliteMarketStore,
  SqlitePhase4Store,
} from "./persistence";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function checkpointIds(db: ReturnType<typeof openWorldDatabase>, runId: string, ids: IdFactory) {
  db.prepare("UPDATE simulation_runs SET id_state_canonical = ? WHERE id = ?")
    .run(canonicalStringify(ids.serialize()), runId);
}

describe("WS-409 Phase 4 HTTP contracts", () => {
  it("makes formation through production explorable across every public read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-phase4-api-"));
    directories.push(dataDir);
    const app = buildApp({
      dataDir,
      webRoot: false,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      tickIntervalMs: 60_000,
    });
    try {
      const created = (await app.inject({
        method: "POST",
        url: "/api/v1/simulations",
        payload: {
          name: "phase-4-explorer",
          scenario: {
            worldSpec: "riverbend-100@1",
            seed: 409,
            llmMode: "off",
            budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
            policyOverrides: {},
            endTick: 60,
          },
        },
      })).json();
      const simulationId = created.simulation.id as string;
      const runId = created.run.id as string;

      let companyId: string;
      {
        const db = openWorldDatabase(dataDir, simulationId, runId);
        try {
          const ids = IdFactory.restore(readRunCheckpoint(db, runId).idState);
          const finance = new SqliteFinanceStore(db, runId);
          const phase4 = new SqlitePhase4Store(db, runId);
          const lawFirmAccount = finance.listAccounts().find((account) => (
            account.ownerKind === "company" && account.type === "checking"
          ));
          if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
          const formation = phase4.requestCompanyFormation({
            name: "Causal Pantry",
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
          companyId = formation.company.id;
          for (const party of formation.contract.parties) {
            phase4.signContract(formation.contract.id, { kind: party.kind, id: party.id }, 0, ids);
          }
          checkpointIds(db, runId, ids);
        } finally {
          db.close();
        }
      }

      expect((await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/start`,
        payload: { runId },
      })).statusCode).toBe(202);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/pause`,
        payload: { runId },
      })).statusCode).toBe(202);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/advance`,
        payload: { runId, ticks: 5 },
      })).statusCode).toBe(200);

      let jobId: string;
      let workerId: string;
      {
        const db = openWorldDatabase(dataDir, simulationId, runId);
        try {
          const ids = IdFactory.restore(readRunCheckpoint(db, runId).idState);
          const phase4 = new SqlitePhase4Store(db, runId);
          const market = new SqliteMarketStore(db, runId);
          const worker = db.prepare<[string], { id: string }>(`
            SELECT id FROM agents WHERE run_id = ? AND employment_status = 'unemployed'
            ORDER BY id LIMIT 1
          `).get(runId);
          if (worker === undefined) throw new Error("unemployed worker missing");
          workerId = worker.id;
          const job = phase4.postJob({
            employerId: companyId,
            occupationCode: "retail_worker",
            title: "Pantry worker",
            annualWageCents: "4000000",
            requirements: [],
            openings: 1,
            tick: 6,
            ids,
          });
          jobId = job.id;
          phase4.submitJobApplication({
            jobId,
            agentId: workerId,
            reservationWageCents: "2000000",
            tick: 6,
            ids,
          });
          market.createProductionOffering({
            companyId,
            sku: "groceries",
            postedPriceCents: "400",
            unitCostCents: "300",
            laborHoursPerWorker: 8,
            productivityMilliunitsPerLaborHour: 1_250,
            capacityUnitsPerTick: 12,
            tick: 6,
            ids,
          });
          checkpointIds(db, runId, ids);
        } finally {
          db.close();
        }
      }
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/advance`,
        payload: { runId, ticks: 2 },
      })).statusCode).toBe(200);

      const companyList = companyListResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/companies?runId=${runId}`,
      })).json());
      expect(companyList.items).toMatchObject([{ id: companyId, status: "active", employees: 1 }]);
      const company = companyDetailResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/companies/${companyId}?runId=${runId}`,
      })).json());
      expect(company.timeline.map((item) => item.type)).toEqual(expect.arrayContaining([
        "company.activated",
        "employment.created",
        "production.started",
      ]));
      expect(company.offerings[0]).toMatchObject({ sku: "groceries", active: true });
      expect(BigInt(company.financials.revenue30Cents)).toBeGreaterThan(0n);

      const contracts = contractListResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/contracts?runId=${runId}`,
      })).json());
      expect(contracts.items.length).toBeGreaterThanOrEqual(2);
      expect(contractDetailResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/contracts/${contracts.items[0]!.id}?runId=${runId}`,
      })).json()).partyDetails.length).toBeGreaterThanOrEqual(2);

      const jobs = jobListResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/jobs?runId=${runId}`,
      })).json());
      expect(jobs.items).toMatchObject([{ id: jobId, filledCount: 1, applicationCount: 1 }]);
      expect(jobDetailResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/jobs/${jobId}?runId=${runId}`,
      })).json()).employmentContracts).toHaveLength(1);

      const institutions = institutionListResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/institutions?runId=${runId}`,
      })).json());
      expect(institutions.items).toHaveLength(8);
      expect(institutionDetailResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/institutions/inst_riverbend_power?runId=${runId}`,
      })).json())).toMatchObject({ institution: { kind: "energy_co", staffCount: 5 } });

      expect(goodsMarketResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/markets/goods?runId=${runId}`,
      })).json())).toMatchObject({ market: { tick: 7 }, energy: { fuelPriceCents: expect.any(String) } });
      expect(agentProfileResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/agents/${workerId}?runId=${runId}`,
      })).json()).agent.employmentStatus).toBe("employed");
      expect(agentFinancesResponseSchema.parse((await app.inject({
        method: "GET",
        url: `/api/v1/simulations/${simulationId}/agents/${workerId}/finances?runId=${runId}`,
      })).json()).employment?.employer.id).toBe(companyId);
    } finally {
      await app.close();
    }
  }, 30_000);
});
