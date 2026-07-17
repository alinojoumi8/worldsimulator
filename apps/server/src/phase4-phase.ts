/** Phase registration for legal obligations, formation, production, and labor matching. */

import type { PhaseHandler } from "@worldtangle/engine";
import type { WorldDatabase } from "./persistence";
import {
  SqliteEnergyStore,
  SqliteFounderVentureStore,
  SqliteInsolvencyStore,
  SqliteMarketStore,
  SqlitePhase4Store,
  SqliteWorldEventStore,
} from "./persistence";

export function createPhase4Handlers(
  db: WorldDatabase,
  runId: string,
  options: { readonly laborDecisionMode?: "tier1" | "tier2" } = {},
): readonly {
  readonly phase: "obligations" | "execute" | "clearing" | "settlement" | "metrics";
  readonly handler: PhaseHandler;
}[] {
  const store = new SqlitePhase4Store(db, runId);
  const market = new SqliteMarketStore(db, runId);
  const energy = new SqliteEnergyStore(db, runId);
  const insolvency = new SqliteInsolvencyStore(db, runId);
  const worldEvents = new SqliteWorldEventStore(db, runId);
  const founderVentures = new SqliteFounderVentureStore(db, runId);
  return [
    {
      phase: "obligations",
      handler: {
        module: "M17-energy-tariffs",
        order: 10,
        run: (ctx) => energy.processTariffCycle(ctx),
      },
    },
    {
      phase: "obligations",
      handler: {
        module: "M11-legal-contracts",
        order: 25,
        run: (ctx) => store.processLegalObligations(ctx),
      },
    },
    {
      phase: "execute",
      handler: {
        module: "M08-founder-formation",
        order: 10,
        run: (ctx) => { store.processAchievedFounderGoals(ctx); },
      },
    },
    {
      phase: "execute",
      handler: {
        module: "M08-company-formation",
        order: 25,
        run: (ctx) => store.processCompanyFormations(ctx),
      },
    },
    {
      phase: "execute",
      handler: {
        module: "M08-founder-venture-launch",
        order: 35,
        run: (ctx) => founderVentures.processLaunches(ctx),
      },
    },
    {
      phase: "execute",
      handler: {
        module: "M15-founder-venture-credit",
        order: 40,
        run: (ctx) => founderVentures.processCreditLifecycle(ctx),
      },
    },
    {
      phase: "execute",
      handler: {
        module: "M08-production-inventory",
        order: 50,
        run: (ctx) => market.processProduction(
          ctx,
          energy.isInitialized() ? energy.tariff("business", ctx.tick).priceCents : "0",
          (companyId, tick) => worldEvents.capacityMultiplierBp(companyId, tick),
        ),
      },
    },
    {
      phase: "clearing",
      handler: {
        module: "M07-labor-matching",
        order: 25,
        run: (ctx) => options.laborDecisionMode === "tier2"
          ? store.processTier2LaborHousekeeping(ctx)
          : store.processLaborMatching(ctx),
      },
    },
    {
      phase: "settlement",
      handler: {
        module: "M17-energy-billing",
        order: 60,
        run: (ctx) => {
          energy.billBusinessProduction(ctx);
          energy.purchaseFuelForTick(ctx);
        },
      },
    },
    {
      phase: "settlement",
      handler: {
        module: "M08-weekly-pricing",
        order: 75,
        run: (ctx) => market.processWeeklyPricing(ctx),
      },
    },
    {
      phase: "metrics",
      handler: {
        module: "M08-insolvency-wind-down",
        order: 25,
        run: (ctx) => insolvency.assessAll(ctx),
      },
    },
  ];
}
