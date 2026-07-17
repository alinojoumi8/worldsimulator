/** Atomic SQLite snapshots and deterministic logical state hashing (WS-106). */

import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import Database from "better-sqlite3";
import {
  canonicalParse,
  canonicalStringify,
  EVENT_SCHEMA_VERSION,
  EngineError,
  IdFactory,
  runIdSchema,
  sha256Hex,
  simulationIdSchema,
} from "@worldtangle/shared";
import type { EventEnvelope, IdFactoryState } from "@worldtangle/shared";
import { simDateForTick } from "@worldtangle/engine";
import { toSafeNumber, worldDatabasePath } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";

const SNAPSHOT_ID_PATTERN = /^snap_[0-9a-z]{8,}$/;
const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/;

interface LogicalRunRow {
  current_tick: bigint;
  end_tick: bigint;
  manifest_canonical: string;
  id_state_canonical: string;
  scenario_canonical: string;
}

interface ScheduledTaskStateRow {
  id: string;
  due_tick: bigint;
  task_order: bigint;
  task_ref: string;
  payload_canonical: string;
  fired_tick: bigint | null;
}

type LogicalCell = string | bigint | null;

function logicalRows(
  db: WorldDatabase,
  runId: string,
  query: string,
): readonly Readonly<Record<string, unknown>>[] {
  return normalizeLogicalRows(
    db.prepare<[string], Record<string, LogicalCell>>(query).all(runId),
  );
}

function logicalStaticRows(
  db: WorldDatabase,
  query: string,
): readonly Readonly<Record<string, unknown>>[] {
  return normalizeLogicalRows(db.prepare<[], Record<string, LogicalCell>>(query).all());
}

function withoutOperationalIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOperationalIdentity);
  if (typeof value !== "object" || value === null) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (
      key === "runId" ||
      key === "simulationId" ||
      key === "createdWall" ||
      key === "correlationId"
    ) continue;
    normalized[key] = withoutOperationalIdentity(
      (value as Readonly<Record<string, unknown>>)[key],
    );
  }
  return normalized;
}

function logicalPhase7Rows(
  db: WorldDatabase,
  runId: string,
  query: string,
): readonly Readonly<Record<string, unknown>>[] {
  return logicalRows(db, runId, query).map((row) => (
    Object.freeze(withoutOperationalIdentity(row) as Readonly<Record<string, unknown>>)
  ));
}

function normalizeLogicalRows(
  rows: readonly Readonly<Record<string, LogicalCell>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) {
      const value = row[key];
      if (key.endsWith("_canonical")) {
        if (value === null) {
          normalized[key] = null;
          continue;
        }
        if (typeof value !== "string") {
          throw new EngineError("INTERNAL", `persisted ${key} is not text`);
        }
        const parsed = parseCanonical(value, key);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const logical = { ...(parsed as Record<string, unknown>) };
          delete logical["runId"];
          delete logical["simulationId"];
          delete logical["createdWall"];
          normalized[key] = logical;
        } else {
          normalized[key] = parsed;
        }
      } else {
        normalized[key] = value;
      }
    }
    return Object.freeze(normalized);
  });
}

interface RunIdentityRow {
  simulation_id: string;
  current_tick: bigint;
}

interface SnapshotCheckpointRow {
  simulation_id: string;
  current_tick: bigint;
  next_event_seq: bigint;
  id_state_canonical: string;
}

interface SnapshotRow {
  id: string;
  run_id: string;
  tick: bigint;
  state_hash: string;
  relative_path: string;
  created_wall: string;
}

export interface SnapshotRecord {
  readonly id: string;
  readonly runId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly relativePath: string;
  readonly createdWall: string;
}

export interface CreateSnapshotInput {
  /** Injected informational wall time; excluded from the logical state hash. */
  readonly createdWall: string;
}

export interface SqliteSnapshotStoreOptions {
  /** Test seam after SQLite has completed and closed the temporary backup. */
  readonly afterBackup?: (temporaryPath: string) => void;
  /** Test seam after the temporary file is durable but before its atomic rename. */
  readonly beforeRename?: (temporaryPath: string, finalPath: string) => void;
  /** Test seam after rename but before the metadata transaction. */
  readonly afterRename?: (finalPath: string) => void;
}

interface DatabaseInspection {
  readonly tick: number;
  readonly stateHash: string;
}

interface SnapshotCheckpoint {
  readonly simulationId: string;
  readonly tick: number;
  readonly nextEventSeq: number;
  readonly idStateCanonical: string;
  readonly idState: IdFactoryState;
}

interface SnapshotPlan {
  readonly record: SnapshotRecord;
  readonly events: readonly EventEnvelope[];
  readonly initial: DatabaseInspection;
  readonly checkpoint: SnapshotCheckpoint;
  readonly finalIdState: IdFactoryState;
}

function assertSimulationId(value: string): void {
  if (!simulationIdSchema.safeParse(value).success) {
    throw new EngineError("VALIDATION_FAILED", `invalid simulation ID: ${value}`);
  }
}

function assertRunId(value: string): void {
  if (!runIdSchema.safeParse(value).success) {
    throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${value}`);
  }
}

function assertSnapshotId(value: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `invalid snapshot ID: ${value}`);
  }
}

function parseCanonical(text: string, field: string): unknown {
  try {
    const parsed = canonicalParse(text);
    if (canonicalStringify(parsed) !== text) throw new Error("stored value is not canonical");
    return parsed;
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${field} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function logicalManifest(text: string): Record<string, unknown> {
  const parsed = parseCanonical(text, "run manifest");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("INTERNAL", "persisted run manifest is not an object");
  }
  const manifest = { ...(parsed as Record<string, unknown>) };
  // Run identity and wall-clock provenance must not make equal seeded worlds hash differently.
  delete manifest["runId"];
  delete manifest["simulationId"];
  delete manifest["createdWall"];
  return manifest;
}

/**
 * Hash the authoritative world projection, not storage metadata.
 * Events, snapshot rows, schema migrations, operational status, the LLM
 * response cache and its independent audit stream, and all wall times are
 * intentionally excluded. New authoritative entity tables must be added to
 * this versioned projection when their migrations are introduced.
 */
function logicalStateHash(
  db: WorldDatabase,
  runId: string,
  idStateOverride?: IdFactoryState,
): string {
  assertRunId(runId);
  const run = db.prepare<[string], LogicalRunRow>(`
    SELECT
      r.current_tick,
      r.end_tick,
      r.manifest_canonical,
      r.id_state_canonical,
      s.scenario_canonical
    FROM simulation_runs r
    JOIN simulations s ON s.id = r.simulation_id
    WHERE r.id = ?
  `).get(runId);
  if (!run) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);

  const scheduledTasks = db.prepare<[string], ScheduledTaskStateRow>(`
    SELECT id, due_tick, task_order, task_ref, payload_canonical, fired_tick
    FROM scheduled_tasks
    WHERE run_id = ?
    ORDER BY due_tick ASC, task_order ASC, id ASC
  `).all(runId).map((task) => ({
    id: task.id,
    dueTick: toSafeNumber(task.due_tick, "scheduled task due tick"),
    order: toSafeNumber(task.task_order, "scheduled task order"),
    taskRef: task.task_ref,
    payload: parseCanonical(task.payload_canonical, `scheduled task ${task.id} payload`),
    firedTick: task.fired_tick === null
      ? null
      : toSafeNumber(task.fired_tick, "scheduled task fired tick"),
  }));

  const phase2 = {
    worldGenerations: logicalRows(db, runId, `
      SELECT world_spec, spec_hash, population_hash, report_canonical
      FROM world_generations WHERE run_id = ? ORDER BY world_spec
    `),
    households: logicalRows(db, runId, `
      SELECT id, member_ids_canonical, structure, housing_tier, budget_policy_canonical
      FROM households WHERE run_id = ? ORDER BY id
    `),
    agents: logicalRows(db, runId, `
      SELECT id, persona_id, household_id, occupation_code, employment_status,
        credit_score, quarantine_canonical, alive_flags_canonical,
        annual_income_cents, role_code, organization_id, segment
      FROM agents WHERE run_id = ? ORDER BY id
    `),
    personas: logicalRows(db, runId, `
      SELECT id, agent_id, name, age, gender, education, skills_canonical,
        personality_canonical, opinions_canonical, bio_summary, prompt_version
      FROM personas WHERE run_id = ? ORDER BY id
    `),
    goals: logicalRows(db, runId, `
      SELECT id, agent_id, kind, params_canonical, priority, status,
        activation_rule, progress_millionths, trigger_event_id,
        activated_tick, terminal_tick
      FROM goals WHERE run_id = ? ORDER BY id
    `),
    relationships: logicalRows(db, runId, `
      SELECT id, from_agent_id, to_agent_id, type, strength, last_interaction_tick
      FROM relationships WHERE run_id = ? ORDER BY id
    `),
    openingAccounts: logicalRows(db, runId, `
      SELECT id, owner_kind, owner_id, account_type, balance_cents
      FROM opening_accounts WHERE run_id = ? ORDER BY id
    `),
    openingMintTransactions: logicalRows(db, runId, `
      SELECT id, account_id, amount_cents, kind
      FROM opening_mint_transactions WHERE run_id = ? ORDER BY id
    `),
    seedLoans: logicalRows(db, runId, `
      SELECT id, borrower_kind, borrower_id, status,
        outstanding_principal_cents, loan_canonical
      FROM seed_loans WHERE run_id = ? ORDER BY id
    `),
    memories: logicalRows(db, runId, `
      SELECT id, agent_id, tick, kind, content, importance,
        references_canonical, source_memory_ids_canonical
      FROM memories WHERE run_id = ? ORDER BY id
    `),
    memoryCompactions: logicalRows(db, runId, `
      SELECT agent_id, source_memory_id, summary_memory_id
      FROM memory_compactions WHERE run_id = ?
      ORDER BY source_memory_id, summary_memory_id
    `),
    decisions: logicalRows(db, runId, `
      SELECT id, agent_id, tick, tier, decision_canonical
      FROM decisions WHERE run_id = ? ORDER BY id
    `),
    actions: logicalRows(db, runId, `
      SELECT id, decision_id, actor_id, type, status, action_canonical
      FROM agent_actions WHERE run_id = ? ORDER BY id
    `),
  };

  const phase3 = {
    banks: logicalRows(db, runId, `
      SELECT id, name, capital_cents, reserve_cents, reserve_ratio_bp,
        capital_ratio_min_bp, base_lending_rate_bp, exposure_cap_cents, status
      FROM banks WHERE run_id = ? ORDER BY id
    `),
    accounts: logicalRows(db, runId, `
      SELECT id, bank_id, owner_kind, owner_id, account_type, balance_cents,
        floor_cents, status, opened_tick
      FROM bank_accounts WHERE run_id = ? ORDER BY id
    `),
    transactions: logicalRows(db, runId, `
      SELECT id, tick, kind, actor_kind, actor_id, reason,
        idempotency_key
      FROM ledger_transactions WHERE run_id = ? ORDER BY id
    `),
    transactionLegs: logicalRows(db, runId, `
      SELECT transaction_id, leg_index, account_id, direction, amount_cents
      FROM ledger_transaction_legs WHERE run_id = ?
      ORDER BY transaction_id, leg_index
    `),
    governments: logicalRows(db, runId, `
      SELECT id, name, treasury_account_id, officeholders_canonical,
        employee_agent_ids_canonical
      FROM government_institutions WHERE run_id = ? ORDER BY id
    `),
    employments: logicalRows(db, runId, `
      SELECT id, employer_id, employer_account_id, employee_agent_id,
        annual_wage_cents, start_tick, end_tick, notice_days, status, legal_contract_id
      FROM employment_contracts WHERE run_id = ? ORDER BY id
    `),
    openingCompanyEquity: logicalRows(db, runId, `
      SELECT company_id, total_shares
      FROM opening_company_equity WHERE run_id = ? ORDER BY company_id
    `),
    openingCompanyEquityStakes: logicalRows(db, runId, `
      SELECT company_id, owner_agent_id, shares
      FROM opening_company_equity_stakes WHERE run_id = ?
      ORDER BY company_id, owner_agent_id
    `),
    seedLoanLinks: logicalRows(db, runId, `
      SELECT loan_id, bank_asset_account_id, borrower_deposit_account_id,
        disbursement_transaction_id
      FROM seed_loan_ledger_links WHERE run_id = ? ORDER BY loan_id
    `),
    policies: logicalRows(db, runId, `
      SELECT id, policy_key, value_integer, effective_tick, source,
        previous_value_integer, cause_event_id
      FROM policies WHERE run_id = ? ORDER BY effective_tick, id
    `),
    rowReferenceSkus: logicalRows(db, runId, `
      SELECT sku, category, unit, reference_price_cents, active
      FROM row_reference_skus WHERE run_id = ? ORDER BY sku
    `),
    taxes: logicalRows(db, runId, `
      SELECT id, kind, payer_id, period, base_cents, rate_bp,
        amount_cents, transaction_id, tick
      FROM tax_records WHERE run_id = ? ORDER BY id
    `),
    indicators: logicalRows(db, runId, `
      SELECT tick, indicator_key, value_integer, formula_version, inputs_digest
      FROM indicator_points WHERE run_id = ? ORDER BY tick, indicator_key
    `),
  };

  const phase4 = {
    legalContracts: logicalRows(db, runId, `
      SELECT id, contract_type, status, terms_canonical, drafted_by_kind,
        drafted_by_id, fee_cents, created_tick, effective_tick, terminal_tick
      FROM legal_contracts WHERE run_id = ? ORDER BY id
    `),
    legalContractParties: logicalRows(db, runId, `
      SELECT contract_id, party_index, party_kind, party_id, role, signed_tick
      FROM legal_contract_parties WHERE run_id = ? ORDER BY contract_id, party_index
    `),
    legalObligations: logicalRows(db, runId, `
      SELECT id, contract_id, due_tick, recurrence_ticks, obligation_kind,
        params_canonical, status, fired_tick, completed_tick
      FROM legal_obligations WHERE run_id = ? ORDER BY id
    `),
    legalObligationExecutions: logicalRows(db, runId, `
      SELECT id, obligation_id, contract_id, tick
      FROM legal_obligation_executions WHERE run_id = ? ORDER BY id
    `),
    legalBreaches: logicalRows(db, runId, `
      SELECT id, contract_id, predicate, tick, details_canonical
      FROM legal_contract_breaches WHERE run_id = ? ORDER BY id
    `),
    legalTimeline: logicalRows(db, runId, `
      SELECT id, contract_id, tick, event_type, payload_canonical
      FROM legal_contract_timeline WHERE run_id = ? ORDER BY id
    `),
    companies: logicalRows(db, runId, `
      SELECT id, name, normalized_name, sector, founder_agent_id, status,
        formation_stage, incorporation_contract_id, business_account_id,
        law_firm_account_id, incorporation_fee_cents, founding_capital_cents,
        total_shares, founded_tick, registered_tick, activated_tick, failure_reason
      FROM companies WHERE run_id = ? ORDER BY id
    `),
    companyEquity: logicalRows(db, runId, `
      SELECT company_id, owner_agent_id, shares, issued_tick
      FROM company_equity_stakes WHERE run_id = ? ORDER BY company_id, owner_agent_id
    `),
    companyTimeline: logicalRows(db, runId, `
      SELECT id, company_id, tick, event_type, payload_canonical
      FROM company_timeline WHERE run_id = ? ORDER BY id
    `),
    jobs: logicalRows(db, runId, `
      SELECT id, employer_id, occupation_code, title, annual_wage_cents,
        requirements_canonical, openings, filled_count, status, posted_tick,
        expires_tick, payroll_risk
      FROM jobs WHERE run_id = ? ORDER BY id
    `),
    jobApplications: logicalRows(db, runId, `
      SELECT id, job_id, agent_id, reservation_wage_cents, status, score,
        submitted_tick, decided_tick
      FROM job_applications WHERE run_id = ? ORDER BY id
    `),
    employmentTerminations: logicalRows(db, runId, `
      SELECT id, employment_contract_id, initiated_by_kind, initiated_by_id,
        reason, initiated_tick, effective_tick, status
      FROM employment_terminations WHERE run_id = ? ORDER BY id
    `),
    products: logicalStaticRows(db, `
      SELECT sku, name, kind, unit, basket_category, inventoried,
        basket_weight_bp, row_reference_price_cents, ruleset_version
      FROM market_products ORDER BY sku
    `),
    marketOfferings: logicalRows(db, runId, `
      SELECT id, company_id, sku, posted_price_cents, active, created_tick
      FROM market_offerings WHERE run_id = ? ORDER BY id
    `),
    productionProfiles: logicalRows(db, runId, `
      SELECT company_id, sku, labor_hours_per_worker,
        productivity_milliunits_per_labor_hour, capacity_units_per_tick,
        unit_cost_cents
      FROM company_production_profiles WHERE run_id = ? ORDER BY company_id, sku
    `),
    inventories: logicalRows(db, runId, `
      SELECT id, company_id, sku, quantity, average_unit_cost_cents, updated_tick
      FROM company_inventory WHERE run_id = ? ORDER BY id
    `),
    productionRuns: logicalRows(db, runId, `
      SELECT id, company_id, sku, tick, worker_count, labor_hours,
        productivity_milliunits_per_labor_hour, capacity_units, units_produced,
        inventory_before, inventory_after, unit_cost_cents, source_event_id
      FROM production_runs WHERE run_id = ? ORDER BY id
    `),
    inventoryMovements: logicalRows(db, runId, `
      SELECT id, inventory_id, company_id, sku, tick, kind, quantity_delta,
        quantity_after, unit_cost_cents, source_ref, source_event_id
      FROM inventory_movements WHERE run_id = ? ORDER BY id
    `),
    goodsOrders: logicalRows(db, runId, `
      SELECT id, buyer_kind, buyer_id, buyer_account_ids_canonical, seller_id,
        offering_id, sku, requested_quantity, filled_quantity, unit_price_cents,
        total_cents, status, rejection_reason, placed_tick, settled_tick,
        request_event_id, settlement_transaction_id
      FROM goods_orders WHERE run_id = ? ORDER BY id
    `),
    marketStockouts: logicalRows(db, runId, `
      SELECT id, order_id, offering_id, company_id, sku, buyer_kind, buyer_id,
        tick, requested_quantity, available_quantity, request_event_id
      FROM market_stockouts WHERE run_id = ? ORDER BY id
    `),
    marketPriceHistory: logicalRows(db, runId, `
      SELECT id, offering_id, company_id, sku, tick, old_price_cents,
        new_price_cents, unit_cost_cents, inventory_quantity, units_sold,
        unfilled_units, inventory_sales_ratio_bp, source, decision_id,
        rule_signal, source_event_id
      FROM market_price_history WHERE run_id = ? ORDER BY tick, id
    `),
    energySystems: logicalRows(db, runId, `
      SELECT utility_id, utility_account_id, row_account_id,
        billing_interval_ticks, pass_through_bp, minimum_tariff_bp,
        maximum_tariff_bp, minimum_fuel_price_bp, maximum_fuel_price_bp,
        reference_fuel_price_cents, household_base_tariff_cents,
        business_base_tariff_cents, ruleset_version, source_event_id
      FROM energy_systems WHERE run_id = ? ORDER BY utility_id
    `),
    energyTariffs: logicalRows(db, runId, `
      SELECT id, customer_class, effective_tick, price_cents, fuel_price_cents,
        source, cause_event_id, source_event_id, ruleset_version
      FROM energy_tariff_history WHERE run_id = ?
      ORDER BY effective_tick, customer_class, id
    `),
    energyFuelPrices: logicalRows(db, runId, `
      SELECT id, tick, old_price_cents, new_price_cents, change_bp,
        next_tariff_tick, source, cause_event_id, source_event_id
      FROM energy_fuel_price_history WHERE run_id = ? ORDER BY tick, id
    `),
    energyBills: logicalRows(db, runId, `
      SELECT id, customer_class, customer_id, customer_account_ids_canonical,
        tariff_id, tick, units, unit_price_cents, amount_cents, fuel_milliunits,
        status, rejection_reason, transaction_id, evidence_refs_canonical,
        request_event_id, source_event_id
      FROM energy_bills WHERE run_id = ? ORDER BY tick, id
    `),
    energyFuelPurchases: logicalRows(db, runId, `
      SELECT id, tick, fuel_price_id, fuel_milliunits, unit_price_cents,
        total_cents, bill_ids_canonical, transaction_id, source_event_id
      FROM energy_fuel_purchases WHERE run_id = ? ORDER BY tick, id
    `),
    companySolvencyAssessments: logicalRows(db, runId, `
      SELECT id, company_id, tick, cash_cents, obligation_cents,
        shortfall_cents, consecutive_shortfall_days, insolvent,
        ruleset_version, source_event_id
      FROM company_solvency_assessments
      WHERE run_id = ? ORDER BY tick, company_id, id
    `),
    companyCreditorClaims: logicalRows(db, runId, `
      SELECT id, company_id, creditor_kind, creditor_id, creditor_account_id,
        seniority, amount_cents, origin_kind, origin_id, registered_tick,
        source_event_id
      FROM company_creditor_claims
      WHERE run_id = ? ORDER BY company_id, seniority, registered_tick, id
    `),
    companyCreditorRecoveries: logicalRows(db, runId, `
      SELECT id, company_id, claim_id, tick, amount_cents,
        transaction_id, source_event_id
      FROM company_creditor_recoveries WHERE run_id = ? ORDER BY company_id, tick, id
    `),
    companyCreditorWriteOffs: logicalRows(db, runId, `
      SELECT id, company_id, claim_id, tick, amount_cents, source_event_id
      FROM company_creditor_write_offs WHERE run_id = ? ORDER BY company_id, tick, id
    `),
    companyInventorySalvages: logicalRows(db, runId, `
      SELECT id, company_id, inventory_id, sku, tick, quantity,
        unit_price_cents, total_cents, transaction_id, source_event_id
      FROM company_inventory_salvages WHERE run_id = ? ORDER BY company_id, tick, id
    `),
    companyWindDowns: logicalRows(db, runId, `
      SELECT id, company_id, started_tick, completed_tick, opening_cash_cents,
        salvage_proceeds_cents, liquidation_pool_cents, creditor_recoveries_cents,
        written_off_cents, employees_terminated, contracts_terminated,
        jobs_withdrawn, offerings_deactivated, accounts_closed_canonical,
        cause_chain_canonical, source_event_id
      FROM company_wind_downs WHERE run_id = ? ORDER BY completed_tick, id
    `),
    worldEvents: logicalRows(db, runId, `
      SELECT id, type, params_canonical, source, status, created_tick,
        scheduled_tick, applied_tick, task_id, command_event_id,
        injected_event_id, applied_event_id, effect_event_ids_canonical,
        catalog_version
      FROM world_events WHERE run_id = ? ORDER BY scheduled_tick, id
    `),
    rowReferencePrices: logicalRows(db, runId, `
      SELECT id, world_event_id, sku, effective_tick, old_price_cents,
        new_price_cents, change_bp, source_event_id
      FROM row_reference_price_history
      WHERE run_id = ? ORDER BY effective_tick, id
    `),
    marketDemandShocks: logicalRows(db, runId, `
      SELECT id, world_event_id, sku, effective_tick, expires_tick,
        change_bp, source_event_id
      FROM market_demand_shocks WHERE run_id = ? ORDER BY effective_tick, id
    `),
    companyCapacityDisasters: logicalRows(db, runId, `
      SELECT id, world_event_id, company_id, effective_tick, expires_tick,
        capacity_reduction_bp, source_event_id
      FROM company_capacity_disasters WHERE run_id = ? ORDER BY effective_tick, id
    `),
  };

  const phase5 = {
    bankLendingAssessments: logicalRows(db, runId, `
      SELECT id, bank_id, application_id, decision_id, stage, borrower_kind,
        borrower_id, assessed_tick, policy_version, bank_status_before,
        bank_status_after, deposit_cents, projected_deposit_cents, reserve_cents,
        reserve_ratio_bp, projected_reserve_ratio_bp, reserve_ratio_min_bp,
        effective_capital_cents, capital_ratio_bp, projected_capital_ratio_bp,
        capital_ratio_min_bp, borrower_exposure_cents,
        projected_borrower_exposure_cents, borrower_exposure_cap_cents,
        requested_amount_cents, bank_open, reserve_passed, capital_passed,
        exposure_passed, systemic_passed, allowed, failed_breakers_canonical,
        source_event_id
      FROM bank_lending_assessments
      WHERE run_id = ? ORDER BY assessed_tick, stage, id
    `),
    loanApplications: logicalRows(db, runId, `
      SELECT id, applicant_kind, applicant_id, bank_id, purpose, amount_cents,
        term_months, status, submitted_tick, decided_tick, source_event_id
      FROM loan_applications WHERE run_id = ? ORDER BY submitted_tick, id
    `),
    creditScoreAssessments: logicalRows(db, runId, `
      SELECT id, application_id, model_version, inputs_canonical, system_score,
        breakdown_canonical, computed_tick, source_event_id
      FROM credit_score_assessments WHERE run_id = ? ORDER BY computed_tick, id
    `),
    loanApplicationReviews: logicalRows(db, runId, `
      SELECT id, application_id, officer_agent_id, review_tier,
        started_tick, source_event_id
      FROM loan_application_reviews WHERE run_id = ? ORDER BY started_tick, id
    `),
    loanApplicationDecisions: logicalRows(db, runId, `
      SELECT id, application_id, assessment_id, review_id, officer_agent_id,
        review_tier, policy_version, system_score, officer_adjustment, final_score,
        rationale, policy_checks_canonical, outcome, offered_rate_bp, decided_tick,
        source_event_id
      FROM loan_application_decisions WHERE run_id = ? ORDER BY decided_tick, id
    `),
    loans: logicalRows(db, runId, `
      SELECT id, application_id, decision_id, borrower_kind, borrower_id,
        bank_id, principal_cents, annual_rate_bp, term_months, disbursed_tick,
        maturity_tick, outstanding_principal_cents, consecutive_misses, status,
        bank_asset_account_id, borrower_deposit_account_id,
        disbursement_transaction_id, schedule_digest, source_event_id
      FROM loans WHERE run_id = ? ORDER BY disbursed_tick, id
    `),
    loanInstallments: logicalRows(db, runId, `
      SELECT id, loan_id, installment_number, due_tick, opening_principal_cents,
        principal_due_cents, interest_due_cents, total_due_cents, status,
        paid_tick, transaction_id, source_event_id
      FROM loan_installments
      WHERE run_id = ? ORDER BY due_tick, loan_id, installment_number
    `),
    loanDefaults: logicalRows(db, runId, `
      SELECT id, loan_id, borrower_kind, borrower_id, bank_id, default_tick,
        outstanding_principal_cents, missed_installment_ids_canonical,
        write_down_transaction_id, credit_score_before,
        credit_score_penalty_points, credit_score_after, source_event_id
      FROM loan_defaults WHERE run_id = ? ORDER BY default_tick, id
    `),
  };

  const phase6 = {
    llmRuntimeBudgets: logicalRows(db, runId, `
      SELECT run_cost_ceiling_cents, per_agent_daily_tokens, input_tokens,
        cached_input_tokens, output_tokens, cost_microcents, warning_emitted, exhausted_emitted,
        auto_paused, llm_enabled, updated_tick, revision, source_event_id
      FROM llm_runtime_budgets WHERE run_id = ?
    `),
    llmAgentDailyUsage: logicalRows(db, runId, `
      SELECT agent_id, day_tick, input_tokens, cached_input_tokens, output_tokens,
        warning_emitted, exhausted_emitted, revision, source_event_id
      FROM llm_agent_daily_usage
      WHERE run_id = ? ORDER BY day_tick, agent_id
    `),
    llmModuleControls: logicalRows(db, runId, `
      SELECT module_id, frozen, updated_tick, revision, source_event_id
      FROM llm_module_controls WHERE run_id = ? ORDER BY module_id
    `),
    llmControlHistory: logicalRows(db, runId, `
      SELECT seq, command, target_kind, target_id, previous_canonical,
        next_canonical, tick, command_event_id, source_event_id
      FROM llm_control_history WHERE run_id = ? ORDER BY seq
    `),
    llmCallRecords: logicalRows(db, runId, `
      -- Operational latency and per-call cost are intentionally excluded.
      -- They are restored by the SQLite backup but never shape replay hashes.
      SELECT id, decision_id, agent_id, tick, module_id, purpose, status,
        provider, model, request_hash, record_canonical, source_event_id
      FROM llm_call_records WHERE run_id = ? ORDER BY tick, id
    `),
    conversations: logicalRows(db, runId, `
      SELECT id, participant_a_id, participant_b_id, topic,
        initiating_trigger_event_id, term_bounds_canonical, max_turns,
        output_token_budget, output_tokens_used, turns, status,
        outcome_canonical, close_reason, start_tick, end_tick, revision,
        source_event_id, terminal_event_id
      FROM conversations WHERE run_id = ? ORDER BY start_tick, id
    `),
    conversationMessages: logicalRows(db, runId, `
      SELECT id, conversation_id, sender_agent_id, recipient_agent_id, turn,
        action_id, kind, content, structured_terms_canonical, tick, delivery_tick,
        decision_id, llm_call_id, output_tokens, source_event_id
      FROM conversation_messages WHERE run_id = ? ORDER BY conversation_id, turn
    `),
    conversationInbox: logicalRows(db, runId, `
      SELECT conversation_id, message_id, recipient_agent_id, delivery_tick,
        delivered_tick, read_tick, revision, source_event_id
      FROM conversation_inbox
      WHERE run_id = ? ORDER BY delivery_tick, message_id, recipient_agent_id
    `),
    conversationRelationshipHistory: logicalRows(db, runId, `
      SELECT id, conversation_id, relationship_id, from_agent_id, to_agent_id,
        prior_strength, next_strength, prior_interaction_tick,
        next_interaction_tick, source_event_id
      FROM conversation_relationship_history
      WHERE run_id = ? ORDER BY conversation_id, id
    `),
    conversationBindings: logicalRows(db, runId, `
      SELECT id, conversation_id, topic, status, structured_terms_canonical,
        domain_reference_id, result_kind, result_id, rejection_reason,
        binding_tick, evidence_event_ids_canonical, source_event_id
      FROM conversation_bindings
      WHERE run_id = ? ORDER BY binding_tick, id
    `),
  };

  const phase7 = {
    newsOrganizations: logicalPhase7Rows(db, runId, `
      SELECT id, name, editor_agent_id, journalist_agent_ids_canonical,
        daily_story_cap, stance_bias, created_tick, organization_canonical,
        source_event_id
      FROM news_organizations WHERE run_id = ? ORDER BY id
    `),
    newsDigests: logicalPhase7Rows(db, runId, `
      SELECT id, source_tick, publication_tick, scoring_version, digest_hash,
        total_candidate_count, selected_event_ids_canonical, digest_canonical,
        source_event_id
      FROM news_digests WHERE run_id = ? ORDER BY source_tick, id
    `),
    newsStories: logicalPhase7Rows(db, runId, `
      SELECT id, org_id, author_agent_id, tick, source_tick, topic, status,
        decision_id, llm_call_id, story_canonical, source_event_id
      FROM news_stories WHERE run_id = ? ORDER BY tick, id
    `),
    newsStoryCitations: logicalPhase7Rows(db, runId, `
      SELECT story_id, org_id, source_tick, event_id, event_fact_hash
      FROM news_story_citations
      WHERE run_id = ? ORDER BY story_id, event_id
    `),
    sentimentUpdates: logicalPhase7Rows(db, runId, `
      SELECT id, topic, tick, previous_tick, previous_value, decayed_value,
        story_delta, value, contributing_story_ids_canonical,
        contribution_ids_canonical, update_canonical, source_event_id
      FROM sentiment_updates WHERE run_id = ? ORDER BY tick, topic, id
    `),
    sentimentStoryContributions: logicalPhase7Rows(db, runId, `
      SELECT id, update_id, story_id, story_topic, topic, tick, stance, reach,
        outcome_score, stance_delta, outcome_delta, delta,
        cited_event_ids_canonical, contribution_canonical, source_event_id
      FROM sentiment_story_contributions
      WHERE run_id = ? ORDER BY tick, topic, story_id, id
    `),
    agentOpinionUpdates: logicalPhase7Rows(db, runId, `
      SELECT id, agent_id, axis, tick, previous_value, delta, value,
        cause_story_ids_canonical, cause_contribution_ids_canonical,
        source_sentiment_update_ids_canonical, update_canonical, source_event_id
      FROM agent_opinion_updates
      WHERE run_id = ? ORDER BY tick, agent_id, axis, id
    `),
    agentOpinionCauses: logicalPhase7Rows(db, runId, `
      SELECT opinion_update_id, story_id, contribution_id, sentiment_update_id
      FROM agent_opinion_causes
      WHERE run_id = ? ORDER BY opinion_update_id, contribution_id
    `),
  };

  return sha256Hex(canonicalStringify({
    stateHashVersion: 22,
    tick: toSafeNumber(run.current_tick, "run current tick"),
    endTick: toSafeNumber(run.end_tick, "run end tick"),
    scenario: parseCanonical(run.scenario_canonical, "simulation scenario"),
    manifest: logicalManifest(run.manifest_canonical),
    idState:
      idStateOverride ?? parseCanonical(run.id_state_canonical, "run ID checkpoint"),
    scheduledTasks,
    phase2,
    phase3,
    phase4,
    phase5,
    phase6,
    phase7,
  }));
}

export function computeLogicalStateHash(db: WorldDatabase, runId: string): string {
  return logicalStateHash(db, runId);
}

function parseIdState(text: string): IdFactoryState {
  const parsed = parseCanonical(text, "run ID checkpoint");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("INTERNAL", "persisted run ID checkpoint is not an object");
  }
  const state = parsed as IdFactoryState;
  try {
    IdFactory.restore(state);
  } catch (error) {
    throw new EngineError("INTERNAL", "persisted run ID checkpoint is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return state;
}

function readSnapshotCheckpoint(db: WorldDatabase, runId: string): SnapshotCheckpoint {
  const row = db.prepare<[string], SnapshotCheckpointRow>(`
    SELECT simulation_id, current_tick, next_event_seq, id_state_canonical
    FROM simulation_runs
    WHERE id = ?
  `).get(runId);
  if (!row) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  return {
    simulationId: row.simulation_id,
    tick: toSafeNumber(row.current_tick, "run current tick"),
    nextEventSeq: toSafeNumber(row.next_event_seq, "run next event sequence"),
    idStateCanonical: row.id_state_canonical,
    idState: parseIdState(row.id_state_canonical),
  };
}

function sameInspection(left: DatabaseInspection, right: DatabaseInspection): boolean {
  return left.tick === right.tick && left.stateHash === right.stateHash;
}

function sameCheckpoint(left: SnapshotCheckpoint, right: SnapshotCheckpoint): boolean {
  return (
    left.simulationId === right.simulationId &&
    left.tick === right.tick &&
    left.nextEventSeq === right.nextEventSeq &&
    left.idStateCanonical === right.idStateCanonical
  );
}

function buildSnapshotPlan(
  db: WorldDatabase,
  runId: string,
  recordInput: Omit<SnapshotRecord, "stateHash">,
  initial: DatabaseInspection,
  checkpoint: SnapshotCheckpoint,
): SnapshotPlan {
  const ids = IdFactory.restore(checkpoint.idState);
  const stateHashEventId = ids.next("evt");
  const snapshotEventId = ids.next("evt");
  const finalIdState = ids.serialize();
  const stateHash = logicalStateHash(db, runId, finalIdState);
  const record = Object.freeze({ ...recordInput, stateHash });
  const eventBase = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    simulationId: checkpoint.simulationId,
    runId,
    tick: checkpoint.tick,
    simDate: simDateForTick(checkpoint.tick),
    wallTime: record.createdWall,
    actor: { kind: "system", id: "snapshot-store" } as const,
    correlationId: record.id,
  };
  const events: readonly EventEnvelope[] = Object.freeze([
    Object.freeze({
      ...eventBase,
      eventId: stateHashEventId,
      type: "simulation.statehash.computed",
      seq: checkpoint.nextEventSeq,
      payload: { tick: checkpoint.tick, stateHash },
    }),
    Object.freeze({
      ...eventBase,
      eventId: snapshotEventId,
      type: "simulation.snapshot.created",
      seq: checkpoint.nextEventSeq + 1,
      payload: { snapshotId: record.id, tick: checkpoint.tick, stateHash },
    }),
  ]);
  return { record, events, initial, checkpoint, finalIdState };
}

function applySnapshotPlan(db: WorldDatabase, plan: SnapshotPlan): void {
  const checkpoint = readSnapshotCheckpoint(db, plan.record.runId);
  const inspection = {
    tick: checkpoint.tick,
    stateHash: computeLogicalStateHash(db, plan.record.runId),
  };
  if (!sameCheckpoint(checkpoint, plan.checkpoint) || !sameInspection(inspection, plan.initial)) {
    throw new EngineError("CONFLICT", "run changed while its snapshot was being finalized");
  }

  db.prepare(`
    INSERT INTO snapshots(id, run_id, tick, state_hash, relative_path, created_wall)
    VALUES (@id, @runId, @tick, @stateHash, @relativePath, @createdWall)
  `).run(plan.record);
  new SqliteEventStore(db, plan.record.runId).appendBatch(plan.events);
  const updated = db.prepare(`
    UPDATE simulation_runs
    SET id_state_canonical = @finalIdState
    WHERE id = @runId
      AND current_tick = @tick
      AND next_event_seq = @nextEventSeq
      AND id_state_canonical = @initialIdState
  `).run({
    runId: plan.record.runId,
    tick: plan.record.tick,
    nextEventSeq: plan.checkpoint.nextEventSeq + plan.events.length,
    initialIdState: plan.checkpoint.idStateCanonical,
    finalIdState: canonicalStringify(plan.finalIdState),
  });
  if (updated.changes !== 1) {
    throw new EngineError("CONFLICT", "stale snapshot event checkpoint");
  }
  if (computeLogicalStateHash(db, plan.record.runId) !== plan.record.stateHash) {
    throw new EngineError("CONFLICT", "snapshot state hash changed during finalization");
  }
}

function finalizeSnapshotDatabase(filePath: string, plan: SnapshotPlan): void {
  const snapshotDb = new Database(filePath, { fileMustExist: true });
  try {
    snapshotDb.defaultSafeIntegers(true);
    snapshotDb.pragma("journal_mode = DELETE");
    snapshotDb.pragma("foreign_keys = ON");
    snapshotDb.transaction(() => applySnapshotPlan(snapshotDb, plan)).immediate();
    const integrity = snapshotDb.pragma("quick_check", { simple: true });
    if (integrity !== "ok") {
      throw new EngineError("CONFLICT", "finalized snapshot failed SQLite quick_check", {
        result: integrity,
      });
    }
  } finally {
    snapshotDb.close();
  }
}

function snapshotIdForTick(tick: number): string {
  return `snap_${tick.toString(36).padStart(8, "0")}`;
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

export function snapshotFilePath(
  dataDir: string,
  simulationId: string,
  runId: string,
  snapshotId: string,
): string {
  assertSimulationId(simulationId);
  assertRunId(runId);
  assertSnapshotId(snapshotId);
  const root = resolve(dataDir);
  const livePath = worldDatabasePath(root, simulationId, runId);
  const path = resolve(join(dirname(livePath), "snapshots", `${snapshotId}.db`));
  if (!pathWithinRoot(root, path)) {
    throw new EngineError("VALIDATION_FAILED", "snapshot path escapes the data directory");
  }
  return path;
}

function flushFile(filePath: string): void {
  // Windows requires a writable handle for FlushFileBuffers/fsync.
  const descriptor = openSync(filePath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isWindowsDirectoryFlushUnsupported(error: unknown): boolean {
  if (process.platform !== "win32" || typeof error !== "object" || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EINVAL";
}

/** Flush the rename's directory entry where the host exposes directory fsync. */
function flushDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Windows does not expose FlushFileBuffers for directory handles through node:fs.
    if (!isWindowsDirectoryFlushUnsupported(error)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function inspectDatabaseFile(filePath: string, runId: string): DatabaseInspection {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.defaultSafeIntegers(true);
    const integrity = db.pragma("quick_check", { simple: true });
    if (integrity !== "ok") {
      throw new EngineError("CONFLICT", "snapshot database failed SQLite quick_check", {
        result: integrity,
      });
    }
    const row = db.prepare<[string], { current_tick: bigint }>(
      "SELECT current_tick FROM simulation_runs WHERE id = ?",
    ).get(runId);
    if (!row) throw new EngineError("CONFLICT", `snapshot does not contain run ${runId}`);
    return {
      tick: toSafeNumber(row.current_tick, "snapshot current tick"),
      stateHash: computeLogicalStateHash(db, runId),
    };
  } finally {
    db.close();
  }
}

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  const tick = toSafeNumber(row.tick, "snapshot tick");
  if (
    !SNAPSHOT_ID_PATTERN.test(row.id) ||
    !runIdSchema.safeParse(row.run_id).success ||
    tick < 0 ||
    !STATE_HASH_PATTERN.test(row.state_hash) ||
    row.created_wall.length === 0
  ) {
    throw new EngineError("INTERNAL", `persisted snapshot ${row.id} is invalid`);
  }
  return Object.freeze({
    id: row.id,
    runId: row.run_id,
    tick,
    stateHash: row.state_hash,
    relativePath: row.relative_path,
    createdWall: row.created_wall,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeDatabaseFiles(filePath: string): void {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

export class SqliteSnapshotStore {
  private readonly root: string;
  private readonly livePath: string;

  constructor(
    private readonly db: WorldDatabase,
    readonly dataDir: string,
    readonly simulationId: string,
    readonly runId: string,
    private readonly options: SqliteSnapshotStoreOptions = {},
  ) {
    assertSimulationId(simulationId);
    assertRunId(runId);
    this.root = resolve(dataDir);
    this.livePath = worldDatabasePath(this.root, simulationId, runId);
    if (resolve(db.name) !== this.livePath) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "snapshot store database is not the authoritative run database",
      );
    }
    const run = db.prepare<[string], RunIdentityRow>(`
      SELECT simulation_id, current_tick FROM simulation_runs WHERE id = ?
    `).get(runId);
    if (!run) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
    if (run.simulation_id !== simulationId) {
      throw new EngineError("CONFLICT", `run ${runId} belongs to another simulation`);
    }
  }

  stateHash(): string {
    return computeLogicalStateHash(this.db, this.runId);
  }

  get(snapshotId: string): SnapshotRecord {
    assertSnapshotId(snapshotId);
    const row = this.db.prepare<[string, string], SnapshotRow>(`
      SELECT id, run_id, tick, state_hash, relative_path, created_wall
      FROM snapshots WHERE run_id = ? AND id = ?
    `).get(this.runId, snapshotId);
    if (!row) throw new EngineError("NOT_FOUND", `snapshot ${snapshotId} does not exist`);
    const snapshot = mapSnapshot(row);
    this.resolveRecordedPath(snapshot);
    return snapshot;
  }

  list(): readonly SnapshotRecord[] {
    return this.db.prepare<[string], SnapshotRow>(`
      SELECT id, run_id, tick, state_hash, relative_path, created_wall
      FROM snapshots WHERE run_id = ? ORDER BY tick DESC, id DESC
    `).all(this.runId).map((row) => {
      const snapshot = mapSnapshot(row);
      this.resolveRecordedPath(snapshot);
      return snapshot;
    });
  }

  getAtTick(tick: number): SnapshotRecord | null {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", `invalid snapshot tick: ${tick}`);
    }
    const row = this.db.prepare<[string, number], SnapshotRow>(`
      SELECT id, run_id, tick, state_hash, relative_path, created_wall
      FROM snapshots WHERE run_id = ? AND tick = ?
    `).get(this.runId, tick);
    if (!row) return null;
    const snapshot = mapSnapshot(row);
    this.resolveRecordedPath(snapshot);
    return snapshot;
  }

  async create(input: CreateSnapshotInput): Promise<SnapshotRecord> {
    if (typeof input.createdWall !== "string" || input.createdWall.length === 0) {
      throw new EngineError("VALIDATION_FAILED", "snapshot createdWall must be non-empty");
    }
    if (!this.db.open) throw new EngineError("CONFLICT", "cannot snapshot a closed database");
    if (this.db.inTransaction) {
      throw new EngineError("CONFLICT", "snapshot requires a fully committed tick boundary");
    }

    const initial = this.inspectLiveDatabase();
    const checkpoint = readSnapshotCheckpoint(this.db, this.runId);
    if (
      checkpoint.simulationId !== this.simulationId ||
      checkpoint.tick !== initial.tick
    ) {
      throw new EngineError("CONFLICT", "run identity changed before snapshot creation");
    }
    const snapshotId = snapshotIdForTick(initial.tick);
    if (this.getAtTick(initial.tick) !== null) {
      throw new EngineError("CONFLICT", `run ${this.runId} already has a snapshot at tick ${initial.tick}`);
    }

    const finalPath = snapshotFilePath(
      this.root,
      this.simulationId,
      this.runId,
      snapshotId,
    );
    const snapshotDirectory = dirname(finalPath);
    const temporaryPath = `${finalPath}.tmp`;
    const relativePath = relative(this.root, finalPath).split(sep).join("/");
    const plan = buildSnapshotPlan(
      this.db,
      this.runId,
      {
        id: snapshotId,
        runId: this.runId,
        tick: initial.tick,
        relativePath,
        createdWall: input.createdWall,
      },
      initial,
      checkpoint,
    );
    mkdirSync(snapshotDirectory, { recursive: true });
    // With no metadata row, either file can only be residue from an interrupted
    // single-writer snapshot. Removing it makes the post-rename crash window retryable.
    removeDatabaseFiles(temporaryPath);
    removeDatabaseFiles(finalPath);

    let renamed = false;
    let metadataCommitted = false;
    try {
      await this.db.backup(temporaryPath);
      this.options.afterBackup?.(temporaryPath);

      const backup = inspectDatabaseFile(temporaryPath, this.runId);
      const current = this.inspectLiveDatabase();
      const currentCheckpoint = readSnapshotCheckpoint(this.db, this.runId);
      if (
        !sameInspection(backup, initial) ||
        !sameInspection(current, initial) ||
        !sameCheckpoint(currentCheckpoint, checkpoint)
      ) {
        throw new EngineError("CONFLICT", "run changed while its snapshot was being created");
      }

      // The backup must be independently resumable: include its own immutable
      // metadata, state-hash event, snapshot-created event, and ID/seq checkpoint.
      finalizeSnapshotDatabase(temporaryPath, plan);
      const finalized = inspectDatabaseFile(temporaryPath, this.runId);
      if (
        finalized.tick !== plan.record.tick ||
        finalized.stateHash !== plan.record.stateHash
      ) {
        throw new EngineError("CONFLICT", "snapshot finalization produced a different state");
      }

      flushFile(temporaryPath);
      if (existsSync(finalPath)) {
        throw new EngineError("CONFLICT", `snapshot file ${snapshotId} already exists`);
      }
      this.options.beforeRename?.(temporaryPath, finalPath);
      renameSync(temporaryPath, finalPath);
      renamed = true;
      flushDirectory(snapshotDirectory);
      this.options.afterRename?.(finalPath);

      this.db.transaction(() => {
        applySnapshotPlan(this.db, plan);
      }).immediate();
      metadataCommitted = true;
      return this.get(snapshotId);
    } catch (error) {
      const cleanupErrors: string[] = [];
      try {
        removeDatabaseFiles(temporaryPath);
      } catch (cleanupError) {
        cleanupErrors.push(errorMessage(cleanupError));
      }
      if (renamed && !metadataCommitted) {
        try {
          removeDatabaseFiles(finalPath);
          flushDirectory(snapshotDirectory);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (cleanupErrors.length > 0) {
        throw new EngineError("INTERNAL", "snapshot creation and cleanup failed", {
          cause: errorMessage(error),
          cleanupErrors,
        });
      }
      if (error instanceof EngineError) throw error;
      throw new EngineError("INTERNAL", "snapshot creation failed", {
        cause: errorMessage(error),
      });
    }
  }

  /**
   * Copy a verified snapshot to a fresh database path. Existing destinations
   * are always rejected, which makes overwriting an open live database impossible.
   */
  restoreTo(snapshotId: string, destinationFile: string): string {
    const snapshot = this.get(snapshotId);
    const sourcePath = this.resolveRecordedPath(snapshot);
    if (!existsSync(sourcePath)) {
      throw new EngineError("NOT_FOUND", `snapshot file ${snapshot.id} is missing`);
    }
    const source = inspectDatabaseFile(sourcePath, this.runId);
    this.assertInspectionMatches(snapshot, source);

    const destinationPath = resolve(destinationFile);
    if (!pathWithinRoot(this.root, destinationPath) || extname(destinationPath) !== ".db") {
      throw new EngineError(
        "VALIDATION_FAILED",
        "restore destination must be a .db file inside the data directory",
      );
    }
    if (destinationPath === this.livePath) {
      throw new EngineError("CONFLICT", "restore cannot replace the authoritative live database");
    }
    if (existsSync(destinationPath)) {
      throw new EngineError("CONFLICT", "restore destination already exists");
    }

    const destinationDirectory = dirname(destinationPath);
    const temporaryPath = `${destinationPath}.tmp`;
    mkdirSync(destinationDirectory, { recursive: true });
    rmSync(temporaryPath, { force: true });
    let renamed = false;
    try {
      copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      const copied = inspectDatabaseFile(temporaryPath, this.runId);
      this.assertInspectionMatches(snapshot, copied);
      flushFile(temporaryPath);
      if (existsSync(destinationPath)) {
        throw new EngineError("CONFLICT", "restore destination already exists");
      }
      renameSync(temporaryPath, destinationPath);
      renamed = true;
      flushDirectory(destinationDirectory);
      const restored = inspectDatabaseFile(destinationPath, this.runId);
      this.assertInspectionMatches(snapshot, restored);
      return destinationPath;
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if (renamed) rmSync(destinationPath, { force: true });
      if (error instanceof EngineError) throw error;
      throw new EngineError("INTERNAL", "snapshot restore failed", {
        cause: errorMessage(error),
      });
    }
  }

  private inspectLiveDatabase(): DatabaseInspection {
    const row = this.db.prepare<[string], { current_tick: bigint }>(
      "SELECT current_tick FROM simulation_runs WHERE id = ?",
    ).get(this.runId);
    if (!row) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    return {
      tick: toSafeNumber(row.current_tick, "run current tick"),
      stateHash: computeLogicalStateHash(this.db, this.runId),
    };
  }

  private resolveRecordedPath(snapshot: SnapshotRecord): string {
    const expected = snapshotFilePath(
      this.root,
      this.simulationId,
      this.runId,
      snapshot.id,
    );
    const recorded = resolve(this.root, snapshot.relativePath);
    if (recorded !== expected || !pathWithinRoot(this.root, recorded)) {
      throw new EngineError("INTERNAL", `snapshot ${snapshot.id} has an unsafe stored path`);
    }
    return recorded;
  }

  private assertInspectionMatches(
    snapshot: SnapshotRecord,
    inspection: DatabaseInspection,
  ): void {
    if (inspection.tick !== snapshot.tick || inspection.stateHash !== snapshot.stateHash) {
      throw new EngineError("CONFLICT", `snapshot ${snapshot.id} failed logical hash verification`);
    }
  }
}
