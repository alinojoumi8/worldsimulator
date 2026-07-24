/** Authoritative SQLite adapter for the WS-709 default-scenario envelope. */

import type {
  BaselineIndicatorKey,
  RiverbendBaselineObservation,
} from "@worldtangle/engine";
import { auditM1Attribution } from "@worldtangle/engine";
import { EngineError } from "@worldtangle/shared";
import type { WorldDatabase } from "../persistence/database";
import { toSafeNumber } from "../persistence/database";
import { SqliteRunRepository } from "../persistence/run-repository";
import { readRunM1AttributionInput } from "./m1-attribution-probe";

interface IndicatorRow {
  readonly tick: bigint;
  readonly indicator_key: BaselineIndicatorKey;
  readonly value_integer: string;
}

interface IdRow {
  readonly id: string;
}

interface TickRow {
  readonly tick: bigint;
}

interface AgentLabBaselineRow {
  readonly externally_influenced: bigint;
  readonly tainted: bigint;
}

export function readRiverbendBaselineObservation(
  db: WorldDatabase,
  runId: string,
): RiverbendBaselineObservation {
  const repository = new SqliteRunRepository(db);
  const run = repository.getRun(runId);
  const agentLab = db.prepare<[string], AgentLabBaselineRow>(`
    SELECT externally_influenced, tainted
    FROM agent_lab_trials
    WHERE run_id = ?
  `).get(runId);
  if (agentLab?.externally_influenced === 1n) {
    throw new EngineError(
      "PERMISSION_DENIED",
      "externally influenced Agent Lab runs cannot replace the Riverbend release baseline",
    );
  }
  if (agentLab?.tainted === 1n) {
    throw new EngineError(
      "PERMISSION_DENIED",
      "tainted Agent Lab runs cannot replace the Riverbend release baseline",
    );
  }
  const simulation = repository.getSimulation(run.simulationId);
  const worldSpec = simulation.scenario["worldSpec"];
  if (typeof worldSpec !== "string") {
    throw new TypeError(`simulation ${simulation.id} scenario is missing worldSpec`);
  }
  const indicatorPoints = db.prepare<[string], IndicatorRow>(`
    SELECT tick, indicator_key, value_integer
    FROM indicator_points
    WHERE run_id = ?
      AND indicator_key IN (
        'unemployment_rate_bp',
        'cpi_index',
        'treasury_balance_cents'
      )
    ORDER BY indicator_key, tick
  `).all(runId).map((row) => ({
    tick: toSafeNumber(row.tick, `indicator ${row.indicator_key} tick`),
    key: row.indicator_key,
    valueInteger: row.value_integer,
  }));
  const m1 = auditM1Attribution(readRunM1AttributionInput(db, runId));
  return {
    worldSpec,
    seed: run.manifest.seed,
    llmMode: run.manifest.llmMode,
    throughTick: run.currentTick,
    indicatorPoints,
    businessFailureIds: db.prepare<[string], IdRow>(`
      SELECT id FROM companies
      WHERE run_id = ? AND failure_reason IS NOT NULL
      ORDER BY id
    `).all(runId).map((row) => row.id),
    newCompanyIds: db.prepare<[string], IdRow>(`
      SELECT id FROM companies
      WHERE run_id = ? AND founded_tick > 0
      ORDER BY id
    `).all(runId).map((row) => row.id),
    loanDefaultIds: db.prepare<[string], IdRow>(`
      SELECT id FROM loans
      WHERE run_id = ? AND status = 'defaulted'
      ORDER BY id
    `).all(runId).map((row) => row.id),
    benefitSuspensionTicks: db.prepare<[string], TickRow>(`
      SELECT DISTINCT tick FROM events
      WHERE run_id = ? AND type = 'benefit.suspended'
      ORDER BY tick
    `).all(runId).map((row) => toSafeNumber(row.tick, "benefit suspension tick")),
    m1: {
      complete: m1.complete,
      attributionRateBp: m1.attributionRateBp,
      unattributedM1DeltaCents: m1.unattributedM1DeltaCents,
      grossUnattributedM1ChangeCents: m1.grossUnattributedM1ChangeCents,
    },
  };
}
