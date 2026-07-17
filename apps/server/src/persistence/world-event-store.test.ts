import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalStringify,
  IdFactory,
  Rng,
  worldEventSchema,
  type EventEnvelope,
  type WorldEventSpec,
} from "@worldtangle/shared";
import {
  generateRiverbendPopulation,
  WORLD_EVENT_CATALOG_VERSION,
  type TickContext,
} from "@worldtangle/engine";
import { createFinancePhaseHandlers } from "../finance-phase";
import { SqliteAgentStore } from "./agent-store";
import { openDatabaseFile, openWorldDatabase, type WorldDatabase } from "./database";
import { SqliteEnergyStore } from "./energy-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";
import { SqliteScheduler } from "./scheduler";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import {
  appendTestTickEvent,
  insertTestRun,
  testSimDate,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";
import {
  SqliteWorldEventStore,
  WORLD_EVENT_TASK_ORDER,
  WORLD_EVENT_TASK_REF,
} from "./world-event-store";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

interface RecordedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly options: unknown;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-world-events-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggers = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggers);
  const ids = IdFactory.restore(population.idState);
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  finance.initialize(population, ids);
  const energy = new SqliteEnergyStore(db, TEST_RUN_ID);
  energy.initialize({
    ids,
    householdBaseTariffCents: "15000",
    sourceEventId: "evt_energygenesis",
  });
  const phase4 = new SqlitePhase4Store(db, TEST_RUN_ID);
  const market = new SqliteMarketStore(db, TEST_RUN_ID);
  const worldEvents = new SqliteWorldEventStore(db, TEST_RUN_ID);
  const scheduler = new SqliteScheduler(db, TEST_RUN_ID);
  const events: RecordedEvent[] = [];
  const contextWithIds = (
    tick: number,
    phase: TickContext["phase"],
    contextIds: IdFactory,
  ): TickContext => ({
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: testSimDate(tick),
    phase,
    ids: contextIds,
    rng: (key) => Rng.root(42).fork(`${tick}.${phase}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const event = appendTestTickEvent(db, {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        ids: contextIds,
        tick,
        simDate: testSimDate(tick),
        phase,
        type,
        payload,
        options,
      });
      events.push({ eventId: event.eventId, type, payload, options });
      return event;
    },
  });
  const context = (tick: number, phase: TickContext["phase"]) =>
    contextWithIds(tick, phase, ids);
  return {
    dataDir,
    db,
    population,
    ids,
    finance,
    energy,
    phase4,
    market,
    worldEvents,
    scheduler,
    events,
    context,
    contextWithIds,
  };
}

function addProducingCompany(base: ReturnType<typeof fixture>) {
  const lawFirmAccount = base.finance.listAccounts().find((account) => (
    account.ownerKind === "company" && account.type === "checking"
  ));
  if (lawFirmAccount === undefined) throw new Error("law-firm account missing");
  const formation = base.phase4.requestCompanyFormation({
    name: "Shockproof Pantry",
    sector: "grocery_retail",
    founderAgentId: "agt_00000001",
    jurisdiction: "Riverbend",
    foundingCapitalCents: "300000",
    totalShares: "1000",
    lawFirmAccountId: lawFirmAccount.id,
    incorporationFeeCents: "10000",
    tick: 0,
    ids: base.ids,
  });
  for (const party of formation.contract.parties) {
    base.phase4.signContract(
      formation.contract.id,
      { kind: party.kind, id: party.id },
      0,
      base.ids,
    );
  }
  for (let tick = 1; tick <= 5; tick++) {
    base.phase4.processLegalObligations(base.context(tick, "obligations"));
    base.phase4.processCompanyFormations(base.context(tick, "execute"));
  }
  const company = base.phase4.getCompany(formation.company.id);
  const job = base.phase4.postJob({
    employerId: company.id,
    occupationCode: "retail_worker",
    title: "Shockproof pantry worker",
    annualWageCents: "4000000",
    requirements: [],
    openings: 1,
    tick: 6,
    ids: base.ids,
  });
  const worker = base.population.residents.find((resident) => (
    resident.agent.employmentStatus !== "employed" &&
    resident.agent.id !== company.founderAgentId
  ));
  if (worker === undefined) throw new Error("unemployed worker missing");
  base.phase4.submitJobApplication({
    jobId: job.id,
    agentId: worker.agent.id,
    reservationWageCents: "2000000",
    tick: 6,
    ids: base.ids,
  });
  base.phase4.processLaborMatching(base.context(6, "clearing"));
  base.market.createProductionOffering({
    companyId: company.id,
    sku: "groceries",
    postedPriceCents: "400",
    unitCostCents: "300",
    laborHoursPerWorker: 8,
    productivityMilliunitsPerLaborHour: 1_250,
    capacityUnitsPerTick: 12,
    tick: 6,
    ids: base.ids,
  });
  const baseline = base.market.processProduction(base.context(7, "execute"));
  return { company, baseline };
}

function scheduleWorldEvent(
  base: ReturnType<typeof fixture>,
  spec: WorldEventSpec,
  scheduledTick: number,
) {
  const id = base.ids.next("wev");
  const taskId = base.ids.next("task");
  const worldEvent = worldEventSchema.parse({
    id,
    runId: TEST_RUN_ID,
    ...spec,
    source: "admin",
    status: "scheduled",
    createdTick: 0,
    scheduledTick,
    appliedTick: null,
    taskId,
    commandEventId: `evt_command${id.slice(4)}`,
    injectedEventId: `evt_injected${id.slice(4)}`,
    appliedEventId: null,
    effectEventIds: [],
    catalogVersion: WORLD_EVENT_CATALOG_VERSION,
  });
  base.worldEvents.recordScheduled(worldEvent);
  base.scheduler.schedule({
    id: taskId,
    dueTick: scheduledTick,
    order: WORLD_EVENT_TASK_ORDER,
    taskRef: WORLD_EVENT_TASK_REF,
    payload: { worldEventId: id },
  });
  return worldEvent;
}

function persistCheckpoint(base: ReturnType<typeof fixture>, tick: number): void {
  base.db.prepare(`
    UPDATE simulation_runs SET current_tick = ?, id_state_canonical = ? WHERE id = ?
  `).run(tick, canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-408 approved world-event effects", () => {
  it("fires all four catalog handlers at the boundary with causal, bounded effects", () => {
    const base = fixture();
    const producing = addProducingCompany(base);
    expect(producing.baseline[0]?.unitsProduced).toBe(10);
    const scheduled = [
      scheduleWorldEvent(base, {
        type: "energy.fuel_price_shock",
        params: { deltaPct: 30 },
      }, 8),
      scheduleWorldEvent(base, {
        type: "row.reference_price_shift",
        params: { sku: "groceries", deltaPct: 30 },
      }, 8),
      scheduleWorldEvent(base, {
        type: "market.demand_shock",
        params: { sku: "groceries", deltaPct: 30, durationTicks: 3 },
      }, 8),
      scheduleWorldEvent(base, {
        type: "business.disaster",
        params: {
          companyId: producing.company.id,
          capacityReductionPct: 50,
          durationTicks: 3,
        },
      }, 8),
    ];

    const fired = base.scheduler.fireDue(8, (task) => {
      base.worldEvents.applyTask(task, base.context(8, "obligations"));
    });
    expect(fired).toHaveLength(4);
    expect(base.worldEvents.list().map((event) => event.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
    expect(base.energy.latestFuelPrice(8).newPriceCents).toBe("130");
    expect(base.worldEvents.rowReferencePriceCents("groceries", 8)).toBe("650");
    expect(base.worldEvents.demandMultiplierBp("groceries", 8)).toBe(13_000);
    expect(base.worldEvents.demandMultiplierBp("groceries", 10)).toBe(13_000);
    expect(base.worldEvents.demandMultiplierBp("groceries", 11)).toBe(10_000);
    expect(base.worldEvents.capacityMultiplierBp(producing.company.id, 8)).toBe(5_000);
    expect(base.worldEvents.capacityMultiplierBp(producing.company.id, 11)).toBe(10_000);

    const disrupted = base.market.processProduction(
      base.context(8, "execute"),
      base.energy.tariff("business", 8).priceCents,
      (companyId, tick) => base.worldEvents.capacityMultiplierBp(companyId, tick),
    );
    expect(disrupted[0]).toMatchObject({ capacityUnits: 6, unitsProduced: 6 });

    const settlement = createFinancePhaseHandlers(base.db, TEST_RUN_ID).find(
      (handler) => handler.phase === "settlement",
    );
    if (settlement === undefined) throw new Error("settlement handler missing");
    settlement.handler.run(base.context(8, "settlement"));
    const foodRequest = base.events.find((event) => (
      event.type === "household.purchase.requested" &&
      (event.payload as { category?: string }).category === "food"
    ));
    expect(foodRequest?.payload).toMatchObject({
      demandMultiplierBp: 13_000,
      rowReferencePriceCents: "650",
    });

    const cpiBeforePassThrough = BigInt(base.finance.recomputeIndicators(29).cpi_index);
    expect(base.energy.processTariffCycle(base.context(30, "obligations"))).toMatchObject([
      { customerClass: "household", priceCents: "17700" },
      { customerClass: "business", priceCents: "59" },
    ]);
    const cpiAfterPassThrough = BigInt(base.finance.recomputeIndicators(30).cpi_index);
    expect(cpiAfterPassThrough - cpiBeforePassThrough).toBe(36n);
    const postPassThroughProduction = base.market.processProduction(
      base.context(30, "execute"),
      base.energy.tariff("business", 30).priceCents,
      (companyId, tick) => base.worldEvents.capacityMultiplierBp(companyId, tick),
    );
    expect(postPassThroughProduction[0]).toMatchObject({
      companyId: producing.company.id,
      unitCostCents: "359",
    });
    expect(BigInt(postPassThroughProduction[0]!.unitCostCents)).toBeGreaterThan(
      BigInt(producing.baseline[0]!.unitCostCents),
    );
    for (const worldEvent of scheduled) {
      const applied = base.events.find((event) => (
        event.type === "world.event.applied" &&
        (event.payload as { worldEventId?: string }).worldEventId === worldEvent.id
      ));
      expect(applied?.options).toMatchObject({ causationId: worldEvent.injectedEventId });
      const persisted = base.worldEvents.get(worldEvent.id);
      expect(persisted.appliedEventId).toBe(applied?.eventId);
      expect(persisted.effectEventIds).toHaveLength(1);
      const effect = base.events.find((event) => event.eventId === persisted.effectEventIds[0]);
      expect(effect?.options).toMatchObject({ causationId: applied?.eventId });
    }
  });

  it("rolls back task claiming and every effect when application fails", () => {
    const base = fixture();
    const worldEvent = scheduleWorldEvent(base, {
      type: "row.reference_price_shift",
      params: { sku: "groceries", deltaPct: 30 },
    }, 1);
    const failing = new SqliteWorldEventStore(base.db, TEST_RUN_ID, {
      beforeApplyTransition: () => {
        throw new Error("injected apply failure");
      },
    });

    expect(() => base.scheduler.fireDue(1, (task) => {
      failing.applyTask(task, base.context(1, "obligations"));
    })).toThrow(/injected apply failure/);
    expect(base.worldEvents.get(worldEvent.id)).toMatchObject({
      status: "scheduled",
      appliedTick: null,
      effectEventIds: [],
    });
    expect(base.worldEvents.listRowReferencePrices()).toEqual([]);
    expect(base.scheduler.listPending()).toHaveLength(1);
    expect(base.scheduler.listPending()[0]?.firedTick).toBeNull();
  });

  it("persists immutable event/effect history across reopen", () => {
    const base = fixture();
    scheduleWorldEvent(base, {
      type: "market.demand_shock",
      params: { sku: "groceries", deltaPct: -20, durationTicks: 5 },
    }, 1);
    base.scheduler.fireDue(1, (task) => {
      base.worldEvents.applyTask(task, base.context(1, "obligations"));
    });
    const expectedEvents = base.worldEvents.list();
    const expectedShocks = base.worldEvents.listDemandShocks();
    expect(() => base.db.prepare(`
      UPDATE market_demand_shocks SET change_bp = 1 WHERE run_id = ?
    `).run(TEST_RUN_ID)).toThrow(/immutable/);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    const store = new SqliteWorldEventStore(reopened, TEST_RUN_ID);
    expect(store.list()).toEqual(expectedEvents);
    expect(store.listDemandShocks()).toEqual(expectedShocks);
  });
});

describe("WS-408 snapshot restore equivalence", () => {
  it("restores a scheduled injection and reproduces its next-boundary state hash", async () => {
    const base = fixture();
    scheduleWorldEvent(base, {
      type: "energy.fuel_price_shock",
      params: { deltaPct: 30 },
    }, 1);
    persistCheckpoint(base, 0);
    const snapshots = new SqliteSnapshotStore(
      base.db,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "world-event-snapshot-wall" });
    const destination = join(base.dataDir, "world-event-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const applyNextBoundary = (db: WorldDatabase): string => {
      const checkpoint = readRunCheckpoint(db, TEST_RUN_ID);
      const ids = IdFactory.restore(checkpoint.idState);
      const store = new SqliteWorldEventStore(db, TEST_RUN_ID);
      const scheduler = new SqliteScheduler(db, TEST_RUN_ID);
      const context: TickContext = {
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        tick: 1,
        simDate: "Y0001-M01-D01",
        phase: "obligations",
        ids,
        rng: (key) => Rng.root(42).fork(`1.obligations.${key}`),
        count: () => undefined,
        setDigestIndicators: () => undefined,
        emit: () => ({ eventId: ids.next("evt") }) as EventEnvelope,
      };
      scheduler.fireDue(1, (task) => store.applyTask(task, context));
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 1, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(db, TEST_RUN_ID);
    };

    const straightHash = applyNextBoundary(base.db);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(new SqliteWorldEventStore(restored, TEST_RUN_ID).list()).toMatchObject([{
      status: "scheduled",
      scheduledTick: 1,
    }]);
    expect(applyNextBoundary(restored)).toBe(straightHash);
  });
});
