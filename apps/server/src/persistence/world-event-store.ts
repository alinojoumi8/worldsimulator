import { z } from "zod";
import {
  canonicalParse,
  canonicalStringify,
  companyCapacityDisasterSchema,
  EngineError,
  marketDemandShockSchema,
  money,
  productSkuSchema,
  rowReferencePriceChangeSchema,
  runIdSchema,
  worldEventSchema,
  worldEventSpecSchema,
  type CompanyCapacityDisaster,
  type MarketDemandShock,
  type ProductSku,
  type RowReferencePriceChange,
  type WorldEvent,
  type WorldEventSpec,
} from "@worldtangle/shared";
import {
  changedReferencePrice,
  combinedCapacityMultiplierBp,
  combinedDemandMultiplierBp,
  percentageToBasisPoints,
  WORLD_EVENT_CATALOG_VERSION,
  type TickContext,
} from "@worldtangle/engine";
import type { ScheduledTask } from "./scheduler";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteEnergyStore } from "./energy-store";

export const WORLD_EVENT_TASK_REF = "world.event.apply";
export const WORLD_EVENT_TASK_ORDER = -100;

const worldEventTaskPayloadSchema = z.object({
  worldEventId: z.string().regex(/^wev_[0-9a-z]{8,}$/),
}).strict();

interface WorldEventRow {
  run_id: string;
  id: string;
  type: string;
  params_canonical: string;
  source: string;
  status: string;
  created_tick: bigint;
  scheduled_tick: bigint;
  applied_tick: bigint | null;
  task_id: string;
  command_event_id: string;
  injected_event_id: string;
  applied_event_id: string | null;
  effect_event_ids_canonical: string;
  catalog_version: bigint;
}

interface RowReferencePriceRow {
  run_id: string;
  id: string;
  world_event_id: string;
  sku: string;
  effective_tick: bigint;
  old_price_cents: string;
  new_price_cents: string;
  change_bp: bigint;
  source_event_id: string;
}

interface DemandShockRow {
  run_id: string;
  id: string;
  world_event_id: string;
  sku: string;
  effective_tick: bigint;
  expires_tick: bigint;
  change_bp: bigint;
  source_event_id: string;
}

interface CapacityDisasterRow {
  run_id: string;
  id: string;
  world_event_id: string;
  company_id: string;
  effective_tick: bigint;
  expires_tick: bigint;
  capacity_reduction_bp: bigint;
  source_event_id: string;
}

interface ProductPriceRow {
  row_reference_price_cents: string;
}

interface PriceHistoryValueRow {
  new_price_cents: string;
}

interface BasisPointRow {
  value: bigint;
}

interface ExistenceRow {
  present: bigint;
}

function parseStringArray(canonical: string, field: string): readonly string[] {
  const parsed = canonicalParse(canonical);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new EngineError("INTERNAL", `persisted ${field} is invalid`);
  }
  return Object.freeze([...parsed]);
}

function mapWorldEvent(row: WorldEventRow): WorldEvent {
  return worldEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    params: canonicalParse(row.params_canonical),
    source: row.source,
    status: row.status,
    createdTick: toSafeNumber(row.created_tick, "world-event created tick"),
    scheduledTick: toSafeNumber(row.scheduled_tick, "world-event scheduled tick"),
    appliedTick: row.applied_tick === null
      ? null
      : toSafeNumber(row.applied_tick, "world-event applied tick"),
    taskId: row.task_id,
    commandEventId: row.command_event_id,
    injectedEventId: row.injected_event_id,
    appliedEventId: row.applied_event_id,
    effectEventIds: parseStringArray(
      row.effect_event_ids_canonical,
      `world event ${row.id} effect event IDs`,
    ),
    catalogVersion: toSafeNumber(row.catalog_version, "world-event catalog version"),
  });
}

function mapRowPrice(row: RowReferencePriceRow): RowReferencePriceChange {
  return rowReferencePriceChangeSchema.parse({
    id: row.id,
    runId: row.run_id,
    worldEventId: row.world_event_id,
    sku: row.sku,
    effectiveTick: toSafeNumber(row.effective_tick, "ROW price effective tick"),
    oldPriceCents: row.old_price_cents,
    newPriceCents: row.new_price_cents,
    changeBp: toSafeNumber(row.change_bp, "ROW price change"),
    sourceEventId: row.source_event_id,
  });
}

function mapDemandShock(row: DemandShockRow): MarketDemandShock {
  return marketDemandShockSchema.parse({
    id: row.id,
    runId: row.run_id,
    worldEventId: row.world_event_id,
    sku: row.sku,
    effectiveTick: toSafeNumber(row.effective_tick, "demand-shock effective tick"),
    expiresTick: toSafeNumber(row.expires_tick, "demand-shock expiry tick"),
    changeBp: toSafeNumber(row.change_bp, "demand-shock change"),
    sourceEventId: row.source_event_id,
  });
}

function mapCapacityDisaster(row: CapacityDisasterRow): CompanyCapacityDisaster {
  return companyCapacityDisasterSchema.parse({
    id: row.id,
    runId: row.run_id,
    worldEventId: row.world_event_id,
    companyId: row.company_id,
    effectiveTick: toSafeNumber(row.effective_tick, "capacity-disaster effective tick"),
    expiresTick: toSafeNumber(row.expires_tick, "capacity-disaster expiry tick"),
    capacityReductionBp: toSafeNumber(
      row.capacity_reduction_bp,
      "capacity-disaster reduction",
    ),
    sourceEventId: row.source_event_id,
  });
}

export interface SqliteWorldEventStoreOptions {
  readonly beforeApplyTransition?: (worldEvent: WorldEvent) => void;
}

export class SqliteWorldEventStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
    private readonly options: SqliteWorldEventStoreOptions = {},
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    const run = this.db.prepare<[string], ExistenceRow>(`
      SELECT COUNT(*) AS present FROM simulation_runs WHERE id = ?
    `).get(runId);
    if (run?.present !== 1n) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  }

  validateSpecTargets(input: WorldEventSpec): void {
    const spec = worldEventSpecSchema.parse(input);
    if (spec.type === "energy.fuel_price_shock") {
      const row = this.db.prepare<[string], ExistenceRow>(`
        SELECT COUNT(*) AS present FROM energy_systems WHERE run_id = ?
      `).get(this.runId);
      if (row?.present !== 1n) {
        throw new EngineError("CONFLICT", "energy system is not initialized");
      }
      return;
    }
    if (spec.type === "business.disaster") {
      const row = this.db.prepare<[string, string], ExistenceRow>(`
        SELECT COUNT(*) AS present FROM companies WHERE run_id = ? AND id = ?
      `).get(this.runId, spec.params.companyId);
      if (row?.present !== 1n) {
        throw new EngineError("NOT_FOUND", `company ${spec.params.companyId} does not exist`);
      }
      return;
    }
    const row = this.db.prepare<[string], ExistenceRow>(`
      SELECT COUNT(*) AS present FROM market_products WHERE sku = ?
    `).get(spec.params.sku);
    if (row?.present !== 1n) {
      throw new EngineError("NOT_FOUND", `product ${spec.params.sku} does not exist`);
    }
  }

  recordScheduled(worldEvent: WorldEvent): WorldEvent {
    const parsed = worldEventSchema.parse(worldEvent);
    if (parsed.runId !== this.runId || parsed.status !== "scheduled" ||
      parsed.appliedTick !== null || parsed.appliedEventId !== null ||
      parsed.effectEventIds.length !== 0 ||
      parsed.catalogVersion !== WORLD_EVENT_CATALOG_VERSION) {
      throw new EngineError("VALIDATION_FAILED", "invalid scheduled world event");
    }
    this.validateSpecTargets({ type: parsed.type, params: parsed.params } as WorldEventSpec);
    this.db.prepare(`
      INSERT INTO world_events(
        run_id, id, type, params_canonical, source, status, created_tick,
        scheduled_tick, applied_tick, task_id, command_event_id,
        injected_event_id, applied_event_id, effect_event_ids_canonical,
        catalog_version
      ) VALUES (
        @runId, @id, @type, @paramsCanonical, @source, @status, @createdTick,
        @scheduledTick, NULL, @taskId, @commandEventId,
        @injectedEventId, NULL, @effectEventIdsCanonical, @catalogVersion
      )
    `).run({
      runId: parsed.runId,
      id: parsed.id,
      type: parsed.type,
      paramsCanonical: canonicalStringify(parsed.params),
      source: parsed.source,
      status: parsed.status,
      createdTick: parsed.createdTick,
      scheduledTick: parsed.scheduledTick,
      taskId: parsed.taskId,
      commandEventId: parsed.commandEventId,
      injectedEventId: parsed.injectedEventId,
      effectEventIdsCanonical: canonicalStringify([]),
      catalogVersion: parsed.catalogVersion,
    });
    return this.get(parsed.id);
  }

  get(worldEventId: string): WorldEvent {
    const row = this.db.prepare<[string, string], WorldEventRow>(`
      SELECT run_id, id, type, params_canonical, source, status, created_tick,
        scheduled_tick, applied_tick, task_id, command_event_id,
        injected_event_id, applied_event_id, effect_event_ids_canonical,
        catalog_version
      FROM world_events WHERE run_id = ? AND id = ?
    `).get(this.runId, worldEventId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `world event ${worldEventId} does not exist`);
    }
    return mapWorldEvent(row);
  }

  list(): readonly WorldEvent[] {
    const rows = this.db.prepare<[string], WorldEventRow>(`
      SELECT run_id, id, type, params_canonical, source, status, created_tick,
        scheduled_tick, applied_tick, task_id, command_event_id,
        injected_event_id, applied_event_id, effect_event_ids_canonical,
        catalog_version
      FROM world_events WHERE run_id = ? ORDER BY scheduled_tick, id
    `).all(this.runId);
    return Object.freeze(rows.map(mapWorldEvent));
  }

  listRowReferencePrices(): readonly RowReferencePriceChange[] {
    const rows = this.db.prepare<[string], RowReferencePriceRow>(`
      SELECT run_id, id, world_event_id, sku, effective_tick, old_price_cents,
        new_price_cents, change_bp, source_event_id
      FROM row_reference_price_history WHERE run_id = ? ORDER BY effective_tick, id
    `).all(this.runId);
    return Object.freeze(rows.map(mapRowPrice));
  }

  listDemandShocks(): readonly MarketDemandShock[] {
    const rows = this.db.prepare<[string], DemandShockRow>(`
      SELECT run_id, id, world_event_id, sku, effective_tick, expires_tick,
        change_bp, source_event_id
      FROM market_demand_shocks WHERE run_id = ? ORDER BY effective_tick, id
    `).all(this.runId);
    return Object.freeze(rows.map(mapDemandShock));
  }

  listCapacityDisasters(): readonly CompanyCapacityDisaster[] {
    const rows = this.db.prepare<[string], CapacityDisasterRow>(`
      SELECT run_id, id, world_event_id, company_id, effective_tick, expires_tick,
        capacity_reduction_bp, source_event_id
      FROM company_capacity_disasters WHERE run_id = ? ORDER BY effective_tick, id
    `).all(this.runId);
    return Object.freeze(rows.map(mapCapacityDisaster));
  }

  rowReferencePriceCents(sku: ProductSku, tick: number): string {
    const parsedSku = productSkuSchema.parse(sku);
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "ROW reference-price tick is invalid");
    }
    const changed = this.db.prepare<[string, string, number], PriceHistoryValueRow>(`
      SELECT new_price_cents
      FROM row_reference_price_history
      WHERE run_id = ? AND sku = ? AND effective_tick <= ?
      ORDER BY effective_tick DESC, id DESC LIMIT 1
    `).get(this.runId, parsedSku, tick);
    if (changed !== undefined) return changed.new_price_cents;
    const base = this.db.prepare<[string], ProductPriceRow>(`
      SELECT row_reference_price_cents FROM market_products WHERE sku = ?
    `).get(parsedSku);
    if (base === undefined) throw new EngineError("NOT_FOUND", `product ${parsedSku} does not exist`);
    return base.row_reference_price_cents;
  }

  demandMultiplierBp(sku: ProductSku, tick: number): number {
    const parsedSku = productSkuSchema.parse(sku);
    const rows = this.db.prepare<[string, string, number, number], BasisPointRow>(`
      SELECT change_bp AS value
      FROM market_demand_shocks
      WHERE run_id = ? AND sku = ? AND effective_tick <= ? AND expires_tick >= ?
      ORDER BY effective_tick, id
    `).all(this.runId, parsedSku, tick, tick);
    return combinedDemandMultiplierBp(
      rows.map((row) => toSafeNumber(row.value, "active demand change")),
    );
  }

  capacityMultiplierBp(companyId: string, tick: number): number {
    const rows = this.db.prepare<[string, string, number, number], BasisPointRow>(`
      SELECT capacity_reduction_bp AS value
      FROM company_capacity_disasters
      WHERE run_id = ? AND company_id = ?
        AND effective_tick <= ? AND expires_tick >= ?
      ORDER BY effective_tick, id
    `).all(this.runId, companyId, tick, tick);
    return combinedCapacityMultiplierBp(
      rows.map((row) => toSafeNumber(row.value, "active capacity reduction")),
    );
  }

  applyTask(task: ScheduledTask, ctx: TickContext): WorldEvent {
    if (task.runId !== this.runId || ctx.runId !== this.runId ||
      task.taskRef !== WORLD_EVENT_TASK_REF) {
      throw new EngineError("VALIDATION_FAILED", "scheduled world-event task is invalid");
    }
    const payload = worldEventTaskPayloadSchema.parse(task.payload);
    const apply = (): WorldEvent => {
      const worldEvent = this.get(payload.worldEventId);
      if (worldEvent.status !== "scheduled") {
        throw new EngineError("CONFLICT", `world event ${worldEvent.id} is already terminal`);
      }
      if (worldEvent.taskId !== task.id || worldEvent.scheduledTick !== task.dueTick ||
        ctx.tick < worldEvent.scheduledTick) {
        throw new EngineError("CONFLICT", `world event ${worldEvent.id} schedule does not match its task`);
      }
      const correlationId = `world-event:${worldEvent.id}`;
      const appliedEvent = ctx.emit("world.event.applied", {
        worldEventId: worldEvent.id,
        type: worldEvent.type,
        params: worldEvent.params,
        scheduledTick: worldEvent.scheduledTick,
        appliedTick: ctx.tick,
        effectCount: 1,
      }, {
        correlationId,
        causationId: worldEvent.injectedEventId,
      });
      const effectEventIds = this.applyEffect(worldEvent, ctx, appliedEvent.eventId, correlationId);
      this.options.beforeApplyTransition?.(worldEvent);
      const updated = this.db.prepare(`
        UPDATE world_events
        SET status = 'applied', applied_tick = @appliedTick,
          applied_event_id = @appliedEventId,
          effect_event_ids_canonical = @effectEventIdsCanonical
        WHERE run_id = @runId AND id = @id AND status = 'scheduled'
      `).run({
        runId: this.runId,
        id: worldEvent.id,
        appliedTick: ctx.tick,
        appliedEventId: appliedEvent.eventId,
        effectEventIdsCanonical: canonicalStringify(effectEventIds),
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `world event ${worldEvent.id} was applied concurrently`);
      }
      return this.get(worldEvent.id);
    };
    return this.db.transaction(apply).immediate();
  }

  private applyEffect(
    worldEvent: WorldEvent,
    ctx: TickContext,
    appliedEventId: string,
    correlationId: string,
  ): readonly string[] {
    switch (worldEvent.type) {
      case "energy.fuel_price_shock": {
        const fuelPrice = new SqliteEnergyStore(this.db, this.runId).applyFuelShock(ctx, {
          changeBp: percentageToBasisPoints(worldEvent.params.deltaPct),
          source: "world_event",
          causeEventId: appliedEventId,
        });
        return Object.freeze([fuelPrice.sourceEventId]);
      }
      case "row.reference_price_shift": {
        const changeBp = percentageToBasisPoints(worldEvent.params.deltaPct);
        const oldPriceCents = this.rowReferencePriceCents(worldEvent.params.sku, ctx.tick);
        const newPriceCents = changedReferencePrice(money(oldPriceCents), changeBp).toString();
        const sourceEvent = ctx.emit("market.row_reference_price.changed", {
          worldEventId: worldEvent.id,
          sku: worldEvent.params.sku,
          oldPriceCents,
          newPriceCents,
          changeBp,
        }, { correlationId, causationId: appliedEventId });
        const change = rowReferencePriceChangeSchema.parse({
          id: ctx.ids.next("wrp"),
          runId: this.runId,
          worldEventId: worldEvent.id,
          sku: worldEvent.params.sku,
          effectiveTick: ctx.tick,
          oldPriceCents,
          newPriceCents,
          changeBp,
          sourceEventId: sourceEvent.eventId,
        });
        this.db.prepare(`
          INSERT INTO row_reference_price_history(
            run_id, id, world_event_id, sku, effective_tick, old_price_cents,
            new_price_cents, change_bp, source_event_id
          ) VALUES (
            @runId, @id, @worldEventId, @sku, @effectiveTick, @oldPriceCents,
            @newPriceCents, @changeBp, @sourceEventId
          )
        `).run(change);
        return Object.freeze([sourceEvent.eventId]);
      }
      case "market.demand_shock": {
        const changeBp = percentageToBasisPoints(worldEvent.params.deltaPct);
        const priorMultiplierBp = this.demandMultiplierBp(worldEvent.params.sku, ctx.tick);
        const expiresTick = ctx.tick + worldEvent.params.durationTicks - 1;
        const nextMultiplierBp = combinedDemandMultiplierBp([
          priorMultiplierBp - 10_000,
          changeBp,
        ]);
        const sourceEvent = ctx.emit("market.demand.changed", {
          worldEventId: worldEvent.id,
          sku: worldEvent.params.sku,
          changeBp,
          priorMultiplierBp,
          nextMultiplierBp,
          effectiveTick: ctx.tick,
          expiresTick,
        }, { correlationId, causationId: appliedEventId });
        const shock = marketDemandShockSchema.parse({
          id: ctx.ids.next("dsh"),
          runId: this.runId,
          worldEventId: worldEvent.id,
          sku: worldEvent.params.sku,
          effectiveTick: ctx.tick,
          expiresTick,
          changeBp,
          sourceEventId: sourceEvent.eventId,
        });
        this.db.prepare(`
          INSERT INTO market_demand_shocks(
            run_id, id, world_event_id, sku, effective_tick, expires_tick,
            change_bp, source_event_id
          ) VALUES (
            @runId, @id, @worldEventId, @sku, @effectiveTick, @expiresTick,
            @changeBp, @sourceEventId
          )
        `).run(shock);
        return Object.freeze([sourceEvent.eventId]);
      }
      case "business.disaster": {
        const capacityReductionBp = worldEvent.params.capacityReductionPct * 100;
        const priorMultiplierBp = this.capacityMultiplierBp(worldEvent.params.companyId, ctx.tick);
        const expiresTick = ctx.tick + worldEvent.params.durationTicks - 1;
        const nextMultiplierBp = combinedCapacityMultiplierBp([
          10_000 - priorMultiplierBp,
          capacityReductionBp,
        ]);
        const sourceEvent = ctx.emit("company.capacity.disrupted", {
          worldEventId: worldEvent.id,
          companyId: worldEvent.params.companyId,
          capacityReductionBp,
          priorMultiplierBp,
          nextMultiplierBp,
          effectiveTick: ctx.tick,
          expiresTick,
        }, { correlationId, causationId: appliedEventId });
        const disaster = companyCapacityDisasterSchema.parse({
          id: ctx.ids.next("bds"),
          runId: this.runId,
          worldEventId: worldEvent.id,
          companyId: worldEvent.params.companyId,
          effectiveTick: ctx.tick,
          expiresTick,
          capacityReductionBp,
          sourceEventId: sourceEvent.eventId,
        });
        this.db.prepare(`
          INSERT INTO company_capacity_disasters(
            run_id, id, world_event_id, company_id, effective_tick, expires_tick,
            capacity_reduction_bp, source_event_id
          ) VALUES (
            @runId, @id, @worldEventId, @companyId, @effectiveTick, @expiresTick,
            @capacityReductionBp, @sourceEventId
          )
        `).run(disaster);
        return Object.freeze([sourceEvent.eventId]);
      }
    }
  }
}
