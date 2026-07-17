/** SQLite bootstrap and migration runner for M20 (ADR-0004). */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  EngineError,
  runIdSchema,
  sha256Hex,
  simulationIdSchema,
} from "@worldtangle/shared";

export type WorldDatabase = Database.Database;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL_SCHEMA = `
CREATE TABLE simulations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'active', 'archived')),
  scenario_version INTEGER NOT NULL CHECK (scenario_version >= 1),
  scenario_canonical TEXT NOT NULL,
  created_wall TEXT NOT NULL
);

CREATE TABLE simulation_runs (
  id TEXT PRIMARY KEY,
  simulation_id TEXT NOT NULL REFERENCES simulations(id),
  status TEXT NOT NULL CHECK (status IN ('created', 'running', 'paused', 'completed', 'failed', 'stopped')),
  current_tick INTEGER NOT NULL DEFAULT 0 CHECK (current_tick >= 0),
  next_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_event_seq >= 0),
  end_tick INTEGER NOT NULL CHECK (end_tick >= 1),
  manifest_canonical TEXT NOT NULL,
  id_state_canonical TEXT NOT NULL,
  started_wall TEXT,
  ended_wall TEXT
);

CREATE TRIGGER simulation_runs_manifest_immutable
BEFORE UPDATE OF simulation_id, manifest_canonical ON simulation_runs
BEGIN
  SELECT RAISE(ABORT, 'run manifest is immutable');
END;

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  sim_date TEXT NOT NULL,
  wall_time TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, event_id)
);

CREATE INDEX events_type_seq ON events(run_id, type, seq);
CREATE INDEX events_tick_seq ON events(run_id, tick, seq);
CREATE INDEX events_correlation_seq ON events(run_id, correlation_id, seq);
CREATE INDEX events_causation_seq ON events(run_id, causation_id, seq);

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  state_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_wall TEXT NOT NULL,
  UNIQUE (run_id, tick)
);

CREATE TABLE scheduled_tasks (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  due_tick INTEGER NOT NULL CHECK (due_tick >= 1),
  task_order INTEGER NOT NULL,
  task_ref TEXT NOT NULL,
  payload_canonical TEXT NOT NULL,
  fired_tick INTEGER,
  PRIMARY KEY (run_id, id)
);

CREATE INDEX scheduled_tasks_due
  ON scheduled_tasks(run_id, due_tick, task_order, id);
`;

const IMMUTABLE_SNAPSHOTS = `
CREATE TRIGGER snapshots_no_update
BEFORE UPDATE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;

CREATE TRIGGER snapshots_no_delete
BEFORE DELETE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;
`;

const API_TASKS = `
CREATE TABLE api_tasks (
  id TEXT PRIMARY KEY
    CHECK (
      substr(id, 1, 5) = 'task_' AND
      length(id) >= 13 AND
      substr(id, 6) NOT GLOB '*[^0-9a-z]*'
    ),
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  kind TEXT NOT NULL CHECK (kind = 'advance'),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  start_tick INTEGER NOT NULL CHECK (start_tick >= 0),
  target_tick INTEGER NOT NULL CHECK (target_tick > start_tick),
  created_wall TEXT NOT NULL CHECK (length(trim(created_wall)) > 0),
  updated_wall TEXT NOT NULL CHECK (length(trim(updated_wall)) > 0),
  error_text TEXT,
  CHECK (
    (status = 'failed' AND error_text IS NOT NULL AND length(trim(error_text)) > 0) OR
    (status <> 'failed' AND error_text IS NULL)
  )
);

CREATE UNIQUE INDEX api_tasks_one_active_per_run
  ON api_tasks(run_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX api_tasks_run_latest
  ON api_tasks(run_id, created_wall DESC, id DESC);

CREATE INDEX api_tasks_status_updated
  ON api_tasks(status, updated_wall, id);

CREATE TRIGGER api_tasks_valid_run_checkpoint
BEFORE INSERT ON api_tasks
WHEN NOT EXISTS (
  SELECT 1
  FROM simulation_runs
  WHERE id = NEW.run_id
    AND current_tick = NEW.start_tick
    AND NEW.target_tick <= end_tick
)
BEGIN
  SELECT RAISE(ABORT, 'advance task does not match the run checkpoint');
END;

CREATE TRIGGER api_tasks_identity_immutable
BEFORE UPDATE OF id, run_id, kind, start_tick, target_tick, created_wall ON api_tasks
BEGIN
  SELECT RAISE(ABORT, 'api task identity and target are immutable');
END;

CREATE TRIGGER api_tasks_no_delete
BEFORE DELETE ON api_tasks
BEGIN
  SELECT RAISE(ABORT, 'api task history is append-only');
END;

CREATE TRIGGER api_tasks_status_transition
BEFORE UPDATE OF status ON api_tasks
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('running', 'failed')) OR
  (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid api task status transition');
END;

CREATE TRIGGER api_tasks_complete_at_target
BEFORE UPDATE OF status ON api_tasks
WHEN NEW.status = 'completed' AND (
  SELECT current_tick FROM simulation_runs WHERE id = OLD.run_id
) <> OLD.target_tick
BEGIN
  SELECT RAISE(ABORT, 'advance task has not reached its target tick');
END;
`;

const PHASE_2_AGENT_FRAMEWORK = `
CREATE TABLE world_generations (
  run_id TEXT PRIMARY KEY REFERENCES simulation_runs(id),
  world_spec TEXT NOT NULL,
  spec_hash TEXT NOT NULL CHECK (length(spec_hash) = 64),
  population_hash TEXT NOT NULL CHECK (length(population_hash) = 64),
  report_canonical TEXT NOT NULL
);

CREATE TABLE households (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  member_ids_canonical TEXT NOT NULL,
  structure TEXT NOT NULL CHECK (structure IN ('single', 'couple', 'family', 'shared')),
  housing_tier TEXT NOT NULL CHECK (housing_tier IN ('modest', 'standard', 'comfortable')),
  budget_policy_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE agents (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  occupation_code TEXT NOT NULL,
  employment_status TEXT NOT NULL
    CHECK (employment_status IN ('employed', 'unemployed', 'student', 'retired', 'homemaker')),
  credit_score INTEGER NOT NULL CHECK (credit_score BETWEEN 300 AND 850),
  quarantine_canonical TEXT NOT NULL,
  alive_flags_canonical TEXT NOT NULL,
  annual_income_cents TEXT NOT NULL CHECK (annual_income_cents NOT GLOB '*[^0-9]*'),
  role_code TEXT NOT NULL,
  organization_id TEXT,
  segment TEXT NOT NULL CHECK (segment IN ('institution', 'business', 'independent')),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, persona_id),
  FOREIGN KEY (run_id, household_id) REFERENCES households(run_id, id)
);

CREATE INDEX agents_directory
  ON agents(run_id, occupation_code, employment_status, id);

CREATE TABLE personas (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT,
  education TEXT NOT NULL CHECK (education IN ('none', 'hs', 'college', 'graduate')),
  skills_canonical TEXT NOT NULL,
  personality_canonical TEXT NOT NULL,
  opinions_canonical TEXT NOT NULL,
  bio_summary TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, agent_id),
  UNIQUE (run_id, name),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX personas_name ON personas(run_id, name, agent_id);

CREATE TABLE goals (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  params_canonical TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  status TEXT NOT NULL CHECK (status IN ('dormant', 'active', 'achieved', 'abandoned')),
  activation_rule TEXT NOT NULL,
  progress_millionths INTEGER NOT NULL CHECK (progress_millionths BETWEEN 0 AND 1000000),
  trigger_event_id TEXT NOT NULL,
  activated_tick INTEGER,
  terminal_tick INTEGER,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX goals_agent_status ON goals(run_id, agent_id, status, priority DESC, id);

CREATE TABLE relationships (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('family', 'friend', 'colleague', 'business', 'adversary')),
  strength INTEGER NOT NULL CHECK (strength BETWEEN -100 AND 100),
  last_interaction_tick INTEGER NOT NULL CHECK (last_interaction_tick >= 0),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, from_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, to_agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX relationships_from_strength
  ON relationships(run_id, from_agent_id, strength DESC, to_agent_id);

CREATE TABLE opening_accounts (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('agent', 'business')),
  owner_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type = 'checking'),
  balance_cents TEXT NOT NULL CHECK (balance_cents NOT GLOB '*[^0-9]*'),
  PRIMARY KEY (run_id, id)
);

CREATE INDEX opening_accounts_owner ON opening_accounts(run_id, owner_kind, owner_id, id);

CREATE TABLE opening_mint_transactions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_cents TEXT NOT NULL CHECK (amount_cents NOT GLOB '*[^0-9]*'),
  kind TEXT NOT NULL CHECK (kind = 'world_gen_mint'),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, account_id) REFERENCES opening_accounts(run_id, id)
);

CREATE TABLE seed_loans (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  borrower_kind TEXT NOT NULL CHECK (borrower_kind IN ('agent', 'business')),
  borrower_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'delinquent')),
  outstanding_principal_cents TEXT NOT NULL
    CHECK (outstanding_principal_cents NOT GLOB '*[^0-9]*'),
  loan_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE INDEX seed_loans_borrower ON seed_loans(run_id, borrower_kind, borrower_id, id);

CREATE TABLE memories (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('event', 'conversation', 'outcome', 'reflection')),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 2000),
  importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
  references_canonical TEXT NOT NULL,
  source_memory_ids_canonical TEXT,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX memories_agent_tick ON memories(run_id, agent_id, tick, id);

CREATE TABLE memory_compactions (
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  summary_memory_id TEXT NOT NULL,
  PRIMARY KEY (run_id, source_memory_id),
  FOREIGN KEY (run_id, source_memory_id) REFERENCES memories(run_id, id),
  FOREIGN KEY (run_id, summary_memory_id) REFERENCES memories(run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id),
  CHECK (source_memory_id <> summary_memory_id)
);

CREATE INDEX memory_compactions_summary
  ON memory_compactions(run_id, agent_id, summary_memory_id, source_memory_id);

CREATE TABLE decisions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 1),
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  decision_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX decisions_agent_feed ON decisions(run_id, agent_id, tick DESC, id DESC);

CREATE TABLE agent_actions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  decision_id TEXT,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('validated', 'applied', 'failed')),
  action_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, actor_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES decisions(run_id, id)
);

CREATE INDEX agent_actions_actor ON agent_actions(run_id, actor_id, id);

CREATE TRIGGER world_generations_no_update BEFORE UPDATE ON world_generations
BEGIN SELECT RAISE(ABORT, 'world generations are immutable'); END;
CREATE TRIGGER world_generations_no_delete BEFORE DELETE ON world_generations
BEGIN SELECT RAISE(ABORT, 'world generations are immutable'); END;
CREATE TRIGGER personas_no_update BEFORE UPDATE ON personas
BEGIN SELECT RAISE(ABORT, 'personas are immutable'); END;
CREATE TRIGGER personas_no_delete BEFORE DELETE ON personas
BEGIN SELECT RAISE(ABORT, 'personas are immutable'); END;
CREATE TRIGGER memories_no_update BEFORE UPDATE ON memories
BEGIN SELECT RAISE(ABORT, 'memories are append-only'); END;
CREATE TRIGGER memories_no_delete BEFORE DELETE ON memories
BEGIN SELECT RAISE(ABORT, 'memories are append-only'); END;
CREATE TRIGGER memory_compactions_no_update BEFORE UPDATE ON memory_compactions
BEGIN SELECT RAISE(ABORT, 'memory compactions are append-only'); END;
CREATE TRIGGER memory_compactions_no_delete BEFORE DELETE ON memory_compactions
BEGIN SELECT RAISE(ABORT, 'memory compactions are append-only'); END;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER agent_actions_no_update BEFORE UPDATE ON agent_actions
BEGIN SELECT RAISE(ABORT, 'agent actions are immutable'); END;
CREATE TRIGGER agent_actions_no_delete BEFORE DELETE ON agent_actions
BEGIN SELECT RAISE(ABORT, 'agent actions are immutable'); END;
CREATE TRIGGER agents_identity_immutable
BEFORE UPDATE OF run_id, id, persona_id, household_id, occupation_code ON agents
BEGIN SELECT RAISE(ABORT, 'agent identity is immutable'); END;
CREATE TRIGGER goals_identity_immutable
BEFORE UPDATE OF run_id, id, agent_id, kind, params_canonical, priority, activation_rule ON goals
BEGIN SELECT RAISE(ABORT, 'goal identity is immutable'); END;
`;

const PHASE_3_AUTHORITATIVE_FINANCE = `
CREATE TABLE banks (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  capital_cents TEXT NOT NULL,
  reserve_ratio_bp INTEGER NOT NULL CHECK (reserve_ratio_bp BETWEEN 0 AND 10000),
  capital_ratio_min_bp INTEGER NOT NULL CHECK (capital_ratio_min_bp BETWEEN 0 AND 10000),
  base_lending_rate_bp INTEGER NOT NULL CHECK (base_lending_rate_bp >= 0),
  exposure_cap_cents TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'lending_halted', 'closed')),
  PRIMARY KEY (run_id, id)
);

CREATE TABLE bank_accounts (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL
    CHECK (owner_kind IN ('agent', 'company', 'government', 'bank_internal', 'system_row')),
  owner_id TEXT NOT NULL,
  account_type TEXT NOT NULL
    CHECK (account_type IN (
      'checking', 'internal_asset', 'internal_liability',
      'internal_income', 'internal_expense', 'equity'
    )),
  balance_cents TEXT NOT NULL,
  floor_cents TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  opened_tick INTEGER NOT NULL CHECK (opened_tick >= 0),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, bank_id) REFERENCES banks(run_id, id)
);

CREATE INDEX bank_accounts_owner
  ON bank_accounts(run_id, owner_kind, owner_id, account_type, id);

CREATE TRIGGER bank_accounts_ownership_immutable
BEFORE UPDATE OF run_id, id, bank_id, owner_kind, owner_id, account_type, opened_tick
ON bank_accounts
BEGIN SELECT RAISE(ABORT, 'bank account ownership and identity are immutable'); END;

CREATE TRIGGER bank_accounts_no_delete BEFORE DELETE ON bank_accounts
BEGIN SELECT RAISE(ABORT, 'bank accounts cannot be deleted'); END;

CREATE TABLE ledger_transactions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'payroll', 'purchase', 'loan_disbursement', 'loan_payment', 'tax',
    'benefit', 'transfer', 'fee', 'dividend', 'mint', 'row_settlement'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'institution', 'system', 'admin')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  source_event_id TEXT,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, idempotency_key)
);

CREATE INDEX ledger_transactions_feed
  ON ledger_transactions(run_id, tick DESC, id DESC);
CREATE INDEX ledger_transactions_kind
  ON ledger_transactions(run_id, kind, tick DESC, id DESC);
CREATE INDEX ledger_transactions_correlation
  ON ledger_transactions(run_id, correlation_id, tick DESC, id DESC);

CREATE TABLE ledger_transaction_legs (
  run_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  leg_index INTEGER NOT NULL CHECK (leg_index >= 0),
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents TEXT NOT NULL CHECK (
    length(amount_cents) > 0 AND amount_cents NOT GLOB '*[^0-9]*' AND amount_cents <> '0'
  ),
  PRIMARY KEY (run_id, transaction_id, leg_index),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id),
  FOREIGN KEY (run_id, account_id) REFERENCES bank_accounts(run_id, id)
);

CREATE INDEX ledger_legs_account
  ON ledger_transaction_legs(run_id, account_id, transaction_id, leg_index);

CREATE TRIGGER ledger_transactions_no_update BEFORE UPDATE ON ledger_transactions
BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;
CREATE TRIGGER ledger_transactions_no_delete BEFORE DELETE ON ledger_transactions
BEGIN SELECT RAISE(ABORT, 'ledger transactions are immutable'); END;
CREATE TRIGGER ledger_legs_no_update BEFORE UPDATE ON ledger_transaction_legs
BEGIN SELECT RAISE(ABORT, 'ledger legs are immutable'); END;
CREATE TRIGGER ledger_legs_no_delete BEFORE DELETE ON ledger_transaction_legs
BEGIN SELECT RAISE(ABORT, 'ledger legs are immutable'); END;

CREATE TABLE government_institutions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  treasury_account_id TEXT NOT NULL,
  officeholders_canonical TEXT NOT NULL,
  employee_agent_ids_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, treasury_account_id) REFERENCES bank_accounts(run_id, id)
);

CREATE TABLE employment_contracts (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  employer_id TEXT NOT NULL,
  employer_account_id TEXT NOT NULL,
  employee_agent_id TEXT NOT NULL,
  annual_wage_cents TEXT NOT NULL,
  start_tick INTEGER NOT NULL CHECK (start_tick >= 0),
  end_tick INTEGER,
  notice_days INTEGER NOT NULL CHECK (notice_days >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  legal_contract_id TEXT,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, employer_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, employee_agent_id) REFERENCES agents(run_id, id),
  CHECK (end_tick IS NULL OR end_tick >= start_tick)
);

CREATE UNIQUE INDEX employment_one_active_per_agent
  ON employment_contracts(run_id, employee_agent_id) WHERE status = 'active';

CREATE TRIGGER employment_contracts_identity_immutable
BEFORE UPDATE OF run_id, id, employer_id, employer_account_id, employee_agent_id,
  annual_wage_cents, start_tick, legal_contract_id
ON employment_contracts
BEGIN SELECT RAISE(ABORT, 'employment contract identity and terms are immutable'); END;

CREATE TABLE opening_company_equity (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  company_id TEXT NOT NULL,
  total_shares TEXT NOT NULL,
  PRIMARY KEY (run_id, company_id)
);

CREATE TABLE opening_company_equity_stakes (
  run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  shares TEXT NOT NULL,
  PRIMARY KEY (run_id, company_id, owner_agent_id),
  FOREIGN KEY (run_id, company_id) REFERENCES opening_company_equity(run_id, company_id),
  FOREIGN KEY (run_id, owner_agent_id) REFERENCES agents(run_id, id)
);

CREATE TRIGGER opening_company_equity_no_update BEFORE UPDATE ON opening_company_equity
BEGIN SELECT RAISE(ABORT, 'opening company equity is immutable'); END;
CREATE TRIGGER opening_company_equity_no_delete BEFORE DELETE ON opening_company_equity
BEGIN SELECT RAISE(ABORT, 'opening company equity is immutable'); END;
CREATE TRIGGER opening_company_equity_stakes_no_update BEFORE UPDATE ON opening_company_equity_stakes
BEGIN SELECT RAISE(ABORT, 'opening company equity stakes are immutable'); END;
CREATE TRIGGER opening_company_equity_stakes_no_delete BEFORE DELETE ON opening_company_equity_stakes
BEGIN SELECT RAISE(ABORT, 'opening company equity stakes are immutable'); END;

CREATE TABLE seed_loan_ledger_links (
  run_id TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  bank_asset_account_id TEXT NOT NULL,
  borrower_deposit_account_id TEXT NOT NULL,
  disbursement_transaction_id TEXT NOT NULL,
  PRIMARY KEY (run_id, loan_id),
  FOREIGN KEY (run_id, loan_id) REFERENCES seed_loans(run_id, id),
  FOREIGN KEY (run_id, bank_asset_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, borrower_deposit_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, disbursement_transaction_id) REFERENCES ledger_transactions(run_id, id)
);

CREATE TRIGGER seed_loan_ledger_links_no_update BEFORE UPDATE ON seed_loan_ledger_links
BEGIN SELECT RAISE(ABORT, 'seed loan ledger links are immutable'); END;
CREATE TRIGGER seed_loan_ledger_links_no_delete BEFORE DELETE ON seed_loan_ledger_links
BEGIN SELECT RAISE(ABORT, 'seed loan ledger links are immutable'); END;

CREATE TABLE policies (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  policy_key TEXT NOT NULL CHECK (policy_key IN (
    'personal_withholding_rate_bp', 'unemployment_benefit_annual_cents',
    'food_monthly_per_person_cents', 'utilities_monthly_cents'
  )),
  value_integer TEXT NOT NULL,
  effective_tick INTEGER NOT NULL CHECK (effective_tick >= 0),
  source TEXT NOT NULL CHECK (source IN ('world_gen', 'admin', 'schedule')),
  previous_value_integer TEXT,
  cause_event_id TEXT,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, policy_key, effective_tick)
);

CREATE INDEX policies_effective
  ON policies(run_id, policy_key, effective_tick DESC, id DESC);
CREATE TRIGGER policies_no_update BEFORE UPDATE ON policies
BEGIN SELECT RAISE(ABORT, 'policy history is append-only'); END;
CREATE TRIGGER policies_no_delete BEFORE DELETE ON policies
BEGIN SELECT RAISE(ABORT, 'policy history is append-only'); END;

CREATE TABLE row_reference_skus (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  sku TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('food', 'utilities', 'rent', 'discretionary')),
  unit TEXT NOT NULL,
  reference_price_cents TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (run_id, sku)
);

CREATE TRIGGER row_reference_skus_no_update BEFORE UPDATE ON row_reference_skus
BEGIN SELECT RAISE(ABORT, 'ROW reference SKUs are immutable'); END;
CREATE TRIGGER row_reference_skus_no_delete BEFORE DELETE ON row_reference_skus
BEGIN SELECT RAISE(ABORT, 'ROW reference SKUs are immutable'); END;

CREATE TABLE tax_records (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal_withholding', 'corporate')),
  payer_id TEXT NOT NULL,
  period TEXT NOT NULL,
  base_cents TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  amount_cents TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id)
);

CREATE TRIGGER tax_records_no_update BEFORE UPDATE ON tax_records
BEGIN SELECT RAISE(ABORT, 'tax records are immutable'); END;
CREATE TRIGGER tax_records_no_delete BEFORE DELETE ON tax_records
BEGIN SELECT RAISE(ABORT, 'tax records are immutable'); END;

CREATE TABLE indicator_points (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  indicator_key TEXT NOT NULL CHECK (indicator_key IN (
    'm1_cents', 'average_wage_cents', 'unemployment_rate_bp', 'treasury_balance_cents'
  )),
  value_integer TEXT NOT NULL,
  PRIMARY KEY (run_id, tick, indicator_key)
);

CREATE INDEX indicator_points_series
  ON indicator_points(run_id, indicator_key, tick);
CREATE TRIGGER indicator_points_no_update BEFORE UPDATE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
CREATE TRIGGER indicator_points_no_delete BEFORE DELETE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
`;

const PHASE_4_LEGAL_COMPANIES_LABOR = `
CREATE TABLE legal_contracts (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  contract_type TEXT NOT NULL
    CHECK (contract_type IN ('incorporation', 'employment', 'service', 'lease')),
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'signed', 'active', 'completed', 'terminated', 'breached')),
  terms_canonical TEXT NOT NULL,
  drafted_by_kind TEXT NOT NULL
    CHECK (drafted_by_kind IN ('agent', 'institution', 'system', 'admin')),
  drafted_by_id TEXT NOT NULL,
  fee_cents TEXT NOT NULL,
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  effective_tick INTEGER NOT NULL CHECK (effective_tick >= created_tick),
  terminal_tick INTEGER,
  PRIMARY KEY (run_id, id),
  CHECK (terminal_tick IS NULL OR terminal_tick >= created_tick)
);

CREATE INDEX legal_contracts_status
  ON legal_contracts(run_id, status, effective_tick, id);

CREATE TABLE legal_contract_parties (
  run_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  party_index INTEGER NOT NULL CHECK (party_index >= 0),
  party_kind TEXT NOT NULL CHECK (party_kind IN ('agent', 'company', 'institution')),
  party_id TEXT NOT NULL,
  role TEXT NOT NULL,
  signed_tick INTEGER,
  PRIMARY KEY (run_id, contract_id, party_index),
  UNIQUE (run_id, contract_id, party_kind, party_id),
  FOREIGN KEY (run_id, contract_id) REFERENCES legal_contracts(run_id, id),
  CHECK (signed_tick IS NULL OR signed_tick >= 0)
);

CREATE TABLE legal_obligations (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  due_tick INTEGER NOT NULL CHECK (due_tick >= 0),
  recurrence_ticks INTEGER CHECK (recurrence_ticks IS NULL OR recurrence_ticks > 0),
  obligation_kind TEXT NOT NULL CHECK (obligation_kind IN ('payment', 'deliverable', 'notice')),
  params_canonical TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'completed', 'waived')),
  fired_tick INTEGER,
  completed_tick INTEGER,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, contract_id) REFERENCES legal_contracts(run_id, id)
);

CREATE INDEX legal_obligations_due
  ON legal_obligations(run_id, status, due_tick, id);

CREATE TABLE legal_obligation_executions (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, obligation_id) REFERENCES legal_obligations(run_id, id),
  FOREIGN KEY (run_id, contract_id) REFERENCES legal_contracts(run_id, id)
);

CREATE TABLE legal_contract_breaches (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  predicate TEXT NOT NULL
    CHECK (predicate IN ('overdue_obligation', 'invalid_transition', 'missing_signature')),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  details_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, contract_id) REFERENCES legal_contracts(run_id, id)
);

CREATE TABLE legal_contract_timeline (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  event_type TEXT NOT NULL,
  payload_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, contract_id) REFERENCES legal_contracts(run_id, id)
);

CREATE INDEX legal_contract_timeline_feed
  ON legal_contract_timeline(run_id, contract_id, tick, id);

CREATE TABLE companies (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) >= 2),
  normalized_name TEXT NOT NULL,
  sector TEXT NOT NULL,
  founder_agent_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('forming', 'registered', 'active', 'insolvent', 'winding_down', 'closed')),
  formation_stage TEXT NOT NULL
    CHECK (formation_stage IN (
      'agreement_drafted', 'fee_paid', 'registered',
      'account_opened', 'capitalized', 'active'
    )),
  incorporation_contract_id TEXT NOT NULL,
  business_account_id TEXT,
  law_firm_account_id TEXT NOT NULL,
  incorporation_fee_cents TEXT NOT NULL,
  founding_capital_cents TEXT NOT NULL,
  total_shares TEXT NOT NULL,
  founded_tick INTEGER NOT NULL CHECK (founded_tick >= 0),
  registered_tick INTEGER,
  activated_tick INTEGER,
  failure_reason TEXT,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, normalized_name),
  FOREIGN KEY (run_id, founder_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, incorporation_contract_id) REFERENCES legal_contracts(run_id, id),
  FOREIGN KEY (run_id, business_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, law_firm_account_id) REFERENCES bank_accounts(run_id, id)
);

CREATE INDEX companies_status ON companies(run_id, status, id);

CREATE TABLE company_equity_stakes (
  run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  shares TEXT NOT NULL,
  issued_tick INTEGER NOT NULL CHECK (issued_tick >= 0),
  PRIMARY KEY (run_id, company_id, owner_agent_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, owner_agent_id) REFERENCES agents(run_id, id)
);

CREATE TABLE company_timeline (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  event_type TEXT NOT NULL,
  payload_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE INDEX company_timeline_feed
  ON company_timeline(run_id, company_id, tick, id);

CREATE TABLE jobs (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  employer_id TEXT NOT NULL,
  occupation_code TEXT NOT NULL,
  title TEXT NOT NULL,
  annual_wage_cents TEXT NOT NULL,
  requirements_canonical TEXT NOT NULL,
  openings INTEGER NOT NULL CHECK (openings > 0),
  filled_count INTEGER NOT NULL CHECK (filled_count BETWEEN 0 AND openings),
  status TEXT NOT NULL CHECK (status IN ('open', 'filled', 'withdrawn', 'expired')),
  posted_tick INTEGER NOT NULL CHECK (posted_tick >= 0),
  expires_tick INTEGER,
  payroll_risk INTEGER NOT NULL CHECK (payroll_risk IN (0, 1)),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, employer_id) REFERENCES companies(run_id, id),
  CHECK (expires_tick IS NULL OR expires_tick >= posted_tick)
);

CREATE INDEX jobs_open ON jobs(run_id, status, posted_tick, id);

CREATE TABLE job_applications (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reservation_wage_cents TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'selected', 'declined', 'withdrawn')),
  score INTEGER,
  submitted_tick INTEGER NOT NULL CHECK (submitted_tick >= 0),
  decided_tick INTEGER,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, job_id, agent_id),
  FOREIGN KEY (run_id, job_id) REFERENCES jobs(run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX job_applications_pending
  ON job_applications(run_id, job_id, status, agent_id, id);

CREATE TABLE employment_terminations (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  employment_contract_id TEXT NOT NULL,
  initiated_by_kind TEXT NOT NULL CHECK (initiated_by_kind IN ('agent', 'company', 'system')),
  initiated_by_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('quit', 'layoff', 'company_failure')),
  initiated_tick INTEGER NOT NULL CHECK (initiated_tick >= 0),
  effective_tick INTEGER NOT NULL CHECK (effective_tick >= initiated_tick),
  status TEXT NOT NULL CHECK (status IN ('pending', 'effective')),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, employment_contract_id),
  FOREIGN KEY (run_id, employment_contract_id) REFERENCES employment_contracts(run_id, id)
);

CREATE INDEX employment_terminations_due
  ON employment_terminations(run_id, status, effective_tick, id);

CREATE TRIGGER legal_obligation_executions_no_update BEFORE UPDATE ON legal_obligation_executions
BEGIN SELECT RAISE(ABORT, 'legal obligation executions are immutable'); END;
CREATE TRIGGER legal_obligation_executions_no_delete BEFORE DELETE ON legal_obligation_executions
BEGIN SELECT RAISE(ABORT, 'legal obligation executions are immutable'); END;
CREATE TRIGGER legal_contract_breaches_no_update BEFORE UPDATE ON legal_contract_breaches
BEGIN SELECT RAISE(ABORT, 'legal breaches are immutable'); END;
CREATE TRIGGER legal_contract_breaches_no_delete BEFORE DELETE ON legal_contract_breaches
BEGIN SELECT RAISE(ABORT, 'legal breaches are immutable'); END;
CREATE TRIGGER company_timeline_no_update BEFORE UPDATE ON company_timeline
BEGIN SELECT RAISE(ABORT, 'company timeline is append-only'); END;
CREATE TRIGGER company_timeline_no_delete BEFORE DELETE ON company_timeline
BEGIN SELECT RAISE(ABORT, 'company timeline is append-only'); END;
`;

const PHASE_4_PRODUCTION_INVENTORY_MARKET = `
CREATE TABLE market_products (
  sku TEXT PRIMARY KEY CHECK (sku IN (
    'groceries', 'meals', 'durable_goods', 'repair_services',
    'healthcare_visit', 'tuition', 'electricity'
  )),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('good', 'service')),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
  basket_category TEXT NOT NULL CHECK (basket_category IN ('food', 'discretionary', 'utilities')),
  inventoried INTEGER NOT NULL CHECK (inventoried IN (0, 1)),
  basket_weight_bp INTEGER NOT NULL CHECK (basket_weight_bp BETWEEN 0 AND 10000),
  row_reference_price_cents TEXT NOT NULL CHECK (
    length(row_reference_price_cents) > 0 AND
    row_reference_price_cents NOT GLOB '*[^0-9]*' AND
    row_reference_price_cents <> '0'
  ),
  ruleset_version INTEGER NOT NULL CHECK (ruleset_version >= 1),
  CHECK ((kind = 'good' AND inventoried = 1) OR (kind = 'service' AND inventoried = 0))
);

INSERT INTO market_products(
  sku, name, kind, unit, basket_category, inventoried,
  basket_weight_bp, row_reference_price_cents, ruleset_version
) VALUES
  ('groceries', 'Groceries', 'good', 'basket', 'food', 1, 3500, '500', 1),
  ('meals', 'Prepared meals', 'good', 'meal', 'food', 1, 1000, '1500', 1),
  ('durable_goods', 'Durable goods', 'good', 'item', 'discretionary', 1, 500, '50000', 1),
  ('repair_services', 'Repair service', 'service', 'visit', 'discretionary', 0, 500, '15000', 1),
  ('healthcare_visit', 'Healthcare visit', 'service', 'visit', 'discretionary', 0, 1500, '20000', 1),
  ('tuition', 'Tuition', 'service', 'month', 'discretionary', 0, 1000, '50000', 1),
  ('electricity', 'Electricity', 'service', 'monthly_bill', 'utilities', 0, 2000, '15000', 1);

CREATE TRIGGER market_products_no_update BEFORE UPDATE ON market_products
BEGIN SELECT RAISE(ABORT, 'market product catalog is immutable'); END;
CREATE TRIGGER market_products_no_delete BEFORE DELETE ON market_products
BEGIN SELECT RAISE(ABORT, 'market product catalog is immutable'); END;

CREATE TABLE market_offerings (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES market_products(sku),
  posted_price_cents TEXT NOT NULL CHECK (
    length(posted_price_cents) > 0 AND
    posted_price_cents NOT GLOB '*[^0-9]*' AND
    posted_price_cents <> '0'
  ),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id, sku),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE INDEX market_offerings_sku
  ON market_offerings(run_id, sku, active, id);

CREATE TABLE company_production_profiles (
  run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  labor_hours_per_worker INTEGER NOT NULL CHECK (labor_hours_per_worker BETWEEN 1 AND 24),
  productivity_milliunits_per_labor_hour INTEGER NOT NULL
    CHECK (productivity_milliunits_per_labor_hour > 0),
  capacity_units_per_tick INTEGER NOT NULL CHECK (capacity_units_per_tick > 0),
  unit_cost_cents TEXT NOT NULL CHECK (
    length(unit_cost_cents) > 0 AND
    unit_cost_cents NOT GLOB '*[^0-9]*' AND
    unit_cost_cents <> '0'
  ),
  PRIMARY KEY (run_id, company_id, sku),
  FOREIGN KEY (run_id, company_id, sku)
    REFERENCES market_offerings(run_id, company_id, sku)
);

CREATE TABLE company_inventory (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  average_unit_cost_cents TEXT NOT NULL CHECK (
    length(average_unit_cost_cents) > 0 AND
    average_unit_cost_cents NOT GLOB '*[^0-9]*'
  ),
  updated_tick INTEGER NOT NULL CHECK (updated_tick >= 0),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id, sku),
  FOREIGN KEY (run_id, company_id, sku)
    REFERENCES market_offerings(run_id, company_id, sku)
);

CREATE INDEX company_inventory_company
  ON company_inventory(run_id, company_id, sku);

CREATE TABLE production_runs (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 1),
  worker_count INTEGER NOT NULL CHECK (worker_count > 0),
  labor_hours INTEGER NOT NULL CHECK (labor_hours > 0),
  productivity_milliunits_per_labor_hour INTEGER NOT NULL
    CHECK (productivity_milliunits_per_labor_hour > 0),
  capacity_units INTEGER NOT NULL CHECK (capacity_units > 0),
  units_produced INTEGER NOT NULL CHECK (units_produced > 0),
  inventory_before INTEGER NOT NULL CHECK (inventory_before >= 0),
  inventory_after INTEGER NOT NULL CHECK (
    inventory_after = inventory_before + units_produced
  ),
  unit_cost_cents TEXT NOT NULL CHECK (
    length(unit_cost_cents) > 0 AND
    unit_cost_cents NOT GLOB '*[^0-9]*' AND
    unit_cost_cents <> '0'
  ),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id, sku, tick),
  FOREIGN KEY (run_id, company_id, sku)
    REFERENCES company_inventory(run_id, company_id, sku)
);

CREATE TABLE inventory_movements (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('production', 'sale')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  unit_cost_cents TEXT NOT NULL CHECK (
    length(unit_cost_cents) > 0 AND
    unit_cost_cents NOT GLOB '*[^0-9]*'
  ),
  source_ref TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, inventory_id) REFERENCES company_inventory(run_id, id),
  FOREIGN KEY (run_id, company_id, sku)
    REFERENCES company_inventory(run_id, company_id, sku)
);

CREATE INDEX inventory_movements_inventory
  ON inventory_movements(run_id, inventory_id, tick, id);

CREATE TABLE goods_orders (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  buyer_kind TEXT NOT NULL CHECK (buyer_kind IN ('agent', 'household', 'company')),
  buyer_id TEXT NOT NULL,
  buyer_account_ids_canonical TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  filled_quantity INTEGER NOT NULL CHECK (
    filled_quantity >= 0 AND filled_quantity <= requested_quantity
  ),
  unit_price_cents TEXT NOT NULL CHECK (
    length(unit_price_cents) > 0 AND
    unit_price_cents NOT GLOB '*[^0-9]*' AND
    unit_price_cents <> '0'
  ),
  total_cents TEXT NOT NULL CHECK (
    length(total_cents) > 0 AND
    total_cents NOT GLOB '*[^0-9]*' AND
    total_cents <> '0'
  ),
  status TEXT NOT NULL CHECK (status IN ('placed', 'filled', 'rejected')),
  rejection_reason TEXT CHECK (rejection_reason IN (
    'stockout', 'insufficient_funds', 'inactive_offering',
    'invalid_buyer', 'price_changed'
  )),
  placed_tick INTEGER NOT NULL CHECK (placed_tick >= 0),
  settled_tick INTEGER CHECK (settled_tick IS NULL OR settled_tick >= placed_tick),
  request_event_id TEXT NOT NULL,
  settlement_transaction_id TEXT,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, seller_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, offering_id) REFERENCES market_offerings(run_id, id),
  FOREIGN KEY (run_id, settlement_transaction_id)
    REFERENCES ledger_transactions(run_id, id),
  CHECK (
    (status = 'placed' AND filled_quantity = 0 AND rejection_reason IS NULL AND
      settled_tick IS NULL AND settlement_transaction_id IS NULL) OR
    (status = 'filled' AND filled_quantity = requested_quantity AND
      rejection_reason IS NULL AND settled_tick IS NOT NULL AND
      settlement_transaction_id IS NOT NULL) OR
    (status = 'rejected' AND filled_quantity = 0 AND rejection_reason IS NOT NULL AND
      settled_tick IS NOT NULL AND settlement_transaction_id IS NULL)
  )
);

CREATE INDEX goods_orders_buyer
  ON goods_orders(run_id, buyer_kind, buyer_id, placed_tick, id);
CREATE INDEX goods_orders_seller
  ON goods_orders(run_id, seller_id, sku, placed_tick, id);
CREATE INDEX goods_orders_status
  ON goods_orders(run_id, status, placed_tick, id);

CREATE TABLE market_stockouts (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  buyer_kind TEXT NOT NULL CHECK (buyer_kind IN ('agent', 'household', 'company')),
  buyer_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  available_quantity INTEGER NOT NULL CHECK (
    available_quantity >= 0 AND available_quantity < requested_quantity
  ),
  request_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, order_id),
  FOREIGN KEY (run_id, order_id) REFERENCES goods_orders(run_id, id),
  FOREIGN KEY (run_id, offering_id) REFERENCES market_offerings(run_id, id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE INDEX market_stockouts_feed
  ON market_stockouts(run_id, tick, company_id, sku, id);

CREATE TRIGGER market_offerings_identity_immutable
BEFORE UPDATE OF run_id, id, company_id, sku, created_tick ON market_offerings
BEGIN SELECT RAISE(ABORT, 'market offering identity is immutable'); END;
CREATE TRIGGER market_offerings_no_delete BEFORE DELETE ON market_offerings
BEGIN SELECT RAISE(ABORT, 'market offerings cannot be deleted'); END;
CREATE TRIGGER production_profiles_identity_immutable
BEFORE UPDATE OF run_id, company_id, sku ON company_production_profiles
BEGIN SELECT RAISE(ABORT, 'production profile identity is immutable'); END;
CREATE TRIGGER production_profiles_no_delete BEFORE DELETE ON company_production_profiles
BEGIN SELECT RAISE(ABORT, 'production profiles cannot be deleted'); END;
CREATE TRIGGER company_inventory_identity_immutable
BEFORE UPDATE OF run_id, id, company_id, sku ON company_inventory
BEGIN SELECT RAISE(ABORT, 'inventory identity is immutable'); END;
CREATE TRIGGER company_inventory_no_delete BEFORE DELETE ON company_inventory
BEGIN SELECT RAISE(ABORT, 'inventory cannot be deleted'); END;
CREATE TRIGGER production_runs_no_update BEFORE UPDATE ON production_runs
BEGIN SELECT RAISE(ABORT, 'production runs are immutable'); END;
CREATE TRIGGER production_runs_no_delete BEFORE DELETE ON production_runs
BEGIN SELECT RAISE(ABORT, 'production runs are immutable'); END;
CREATE TRIGGER inventory_movements_no_update BEFORE UPDATE ON inventory_movements
BEGIN SELECT RAISE(ABORT, 'inventory movements are immutable'); END;
CREATE TRIGGER inventory_movements_no_delete BEFORE DELETE ON inventory_movements
BEGIN SELECT RAISE(ABORT, 'inventory movements are immutable'); END;
CREATE TRIGGER goods_orders_identity_immutable
BEFORE UPDATE OF run_id, id, buyer_kind, buyer_id, buyer_account_ids_canonical,
  seller_id, offering_id, sku, requested_quantity, unit_price_cents, total_cents,
  placed_tick, request_event_id
ON goods_orders
BEGIN SELECT RAISE(ABORT, 'goods order identity and terms are immutable'); END;
CREATE TRIGGER goods_orders_status_transition
BEFORE UPDATE OF status ON goods_orders
WHEN OLD.status <> 'placed' OR NEW.status NOT IN ('filled', 'rejected')
BEGIN SELECT RAISE(ABORT, 'invalid goods order status transition'); END;
CREATE TRIGGER goods_orders_no_delete BEFORE DELETE ON goods_orders
BEGIN SELECT RAISE(ABORT, 'goods orders cannot be deleted'); END;
CREATE TRIGGER market_stockouts_no_update BEFORE UPDATE ON market_stockouts
BEGIN SELECT RAISE(ABORT, 'stockouts are immutable'); END;
CREATE TRIGGER market_stockouts_no_delete BEFORE DELETE ON market_stockouts
BEGIN SELECT RAISE(ABORT, 'stockouts are immutable'); END;
`;

const PHASE_4_MARKET_PRICING = `
CREATE TABLE market_price_history (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  old_price_cents TEXT NOT NULL CHECK (
    old_price_cents <> '' AND old_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(old_price_cents AS INTEGER) > 0
  ),
  new_price_cents TEXT NOT NULL CHECK (
    new_price_cents <> '' AND new_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(new_price_cents AS INTEGER) > 0
  ),
  unit_cost_cents TEXT NOT NULL CHECK (
    unit_cost_cents <> '' AND unit_cost_cents NOT GLOB '*[^0-9]*'
    AND CAST(unit_cost_cents AS INTEGER) > 0
  ),
  inventory_quantity INTEGER NOT NULL CHECK (inventory_quantity >= 0),
  units_sold INTEGER NOT NULL CHECK (units_sold >= 0),
  unfilled_units INTEGER NOT NULL CHECK (unfilled_units >= 0),
  inventory_sales_ratio_bp INTEGER CHECK (inventory_sales_ratio_bp >= 0),
  source TEXT NOT NULL CHECK (source IN ('rule', 'decision')),
  decision_id TEXT,
  rule_signal TEXT CHECK (rule_signal IN (
    'bound_correction', 'stockout', 'low_inventory', 'balanced',
    'excess_inventory', 'no_sales', 'no_activity'
  )),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, source_event_id),
  UNIQUE (run_id, offering_id, tick, source),
  CHECK (old_price_cents <> new_price_cents),
  CHECK (
    (source = 'rule' AND decision_id IS NULL AND rule_signal IS NOT NULL)
    OR (source = 'decision' AND decision_id IS NOT NULL AND rule_signal IS NULL)
  ),
  FOREIGN KEY (run_id) REFERENCES simulation_runs(id),
  FOREIGN KEY (run_id, offering_id) REFERENCES market_offerings(run_id, id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES decisions(run_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX market_price_history_feed
  ON market_price_history(run_id, offering_id, tick, id);
CREATE INDEX market_price_history_company_feed
  ON market_price_history(run_id, company_id, sku, tick, id);

CREATE TRIGGER market_price_history_no_update BEFORE UPDATE ON market_price_history
BEGIN SELECT RAISE(ABORT, 'market price history is immutable'); END;
CREATE TRIGGER market_price_history_no_delete BEFORE DELETE ON market_price_history
BEGIN SELECT RAISE(ABORT, 'market price history is immutable'); END;
`;

const PHASE_4_ENERGY_TARIFFS_BILLING = `
CREATE TABLE energy_systems (
  run_id TEXT PRIMARY KEY REFERENCES simulation_runs(id),
  utility_id TEXT NOT NULL CHECK (utility_id = 'inst_riverbend_power'),
  utility_account_id TEXT NOT NULL,
  row_account_id TEXT NOT NULL,
  billing_interval_ticks INTEGER NOT NULL CHECK (billing_interval_ticks > 0),
  pass_through_bp INTEGER NOT NULL CHECK (pass_through_bp BETWEEN 0 AND 10000),
  minimum_tariff_bp INTEGER NOT NULL CHECK (minimum_tariff_bp BETWEEN 1 AND 10000),
  maximum_tariff_bp INTEGER NOT NULL CHECK (maximum_tariff_bp BETWEEN 10000 AND 100000),
  minimum_fuel_price_bp INTEGER NOT NULL CHECK (minimum_fuel_price_bp BETWEEN 1 AND 10000),
  maximum_fuel_price_bp INTEGER NOT NULL CHECK (maximum_fuel_price_bp BETWEEN 10000 AND 100000),
  reference_fuel_price_cents TEXT NOT NULL CHECK (
    reference_fuel_price_cents <> ''
    AND reference_fuel_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(reference_fuel_price_cents AS INTEGER) > 0
  ),
  household_base_tariff_cents TEXT NOT NULL CHECK (
    household_base_tariff_cents <> ''
    AND household_base_tariff_cents NOT GLOB '*[^0-9]*'
    AND CAST(household_base_tariff_cents AS INTEGER) > 0
  ),
  business_base_tariff_cents TEXT NOT NULL CHECK (
    business_base_tariff_cents <> ''
    AND business_base_tariff_cents NOT GLOB '*[^0-9]*'
    AND CAST(business_base_tariff_cents AS INTEGER) > 0
  ),
  ruleset_version INTEGER NOT NULL CHECK (ruleset_version > 0),
  source_event_id TEXT NOT NULL,
  CHECK (minimum_tariff_bp <= maximum_tariff_bp),
  CHECK (minimum_fuel_price_bp <= maximum_fuel_price_bp),
  FOREIGN KEY (run_id, utility_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, row_account_id) REFERENCES bank_accounts(run_id, id)
);

CREATE TABLE energy_tariff_history (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  customer_class TEXT NOT NULL CHECK (customer_class IN ('household', 'business')),
  effective_tick INTEGER NOT NULL CHECK (effective_tick >= 0),
  price_cents TEXT NOT NULL CHECK (
    price_cents <> '' AND price_cents NOT GLOB '*[^0-9]*'
    AND CAST(price_cents AS INTEGER) > 0
  ),
  fuel_price_cents TEXT NOT NULL CHECK (
    fuel_price_cents <> '' AND fuel_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(fuel_price_cents AS INTEGER) > 0
  ),
  source TEXT NOT NULL CHECK (source IN ('world_gen', 'fuel_pass_through')),
  cause_event_id TEXT,
  source_event_id TEXT NOT NULL,
  ruleset_version INTEGER NOT NULL CHECK (ruleset_version > 0),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, customer_class, effective_tick)
);

CREATE INDEX energy_tariff_history_lookup
  ON energy_tariff_history(run_id, customer_class, effective_tick DESC, id DESC);

CREATE TABLE energy_fuel_price_history (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  old_price_cents TEXT,
  new_price_cents TEXT NOT NULL CHECK (
    new_price_cents <> '' AND new_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(new_price_cents AS INTEGER) > 0
  ),
  change_bp INTEGER NOT NULL CHECK (change_bp BETWEEN -9999 AND 100000),
  next_tariff_tick INTEGER NOT NULL CHECK (next_tariff_tick >= 0),
  source TEXT NOT NULL CHECK (source IN ('world_gen', 'world_event', 'test')),
  cause_event_id TEXT,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, source_event_id),
  CHECK (
    (source = 'world_gen' AND old_price_cents IS NULL)
    OR (
      source <> 'world_gen' AND old_price_cents IS NOT NULL
      AND old_price_cents <> '' AND old_price_cents NOT GLOB '*[^0-9]*'
      AND CAST(old_price_cents AS INTEGER) > 0
    )
  )
);

CREATE INDEX energy_fuel_price_history_lookup
  ON energy_fuel_price_history(run_id, tick DESC, id DESC);

CREATE TABLE energy_bills (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  customer_class TEXT NOT NULL CHECK (customer_class IN ('household', 'business')),
  customer_id TEXT NOT NULL,
  customer_account_ids_canonical TEXT NOT NULL,
  tariff_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick > 0),
  units INTEGER NOT NULL CHECK (units > 0),
  unit_price_cents TEXT NOT NULL CHECK (
    unit_price_cents <> '' AND unit_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(unit_price_cents AS INTEGER) > 0
  ),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents <> '' AND amount_cents NOT GLOB '*[^0-9]*'
    AND CAST(amount_cents AS INTEGER) > 0
  ),
  fuel_milliunits INTEGER NOT NULL CHECK (fuel_milliunits > 0),
  status TEXT NOT NULL CHECK (status IN ('paid', 'rejected')),
  rejection_reason TEXT CHECK (rejection_reason = 'insufficient_funds'),
  transaction_id TEXT,
  evidence_refs_canonical TEXT NOT NULL,
  request_event_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, customer_class, customer_id, tick),
  UNIQUE (run_id, source_event_id),
  CHECK (
    (status = 'paid' AND rejection_reason IS NULL AND transaction_id IS NOT NULL)
    OR (status = 'rejected' AND rejection_reason IS NOT NULL AND transaction_id IS NULL)
  ),
  FOREIGN KEY (run_id, tariff_id) REFERENCES energy_tariff_history(run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX energy_bills_customer_feed
  ON energy_bills(run_id, customer_class, customer_id, tick, id);
CREATE INDEX energy_bills_tick_feed
  ON energy_bills(run_id, tick, status, id);

CREATE TABLE energy_fuel_purchases (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick > 0),
  fuel_price_id TEXT NOT NULL,
  fuel_milliunits INTEGER NOT NULL CHECK (fuel_milliunits > 0),
  unit_price_cents TEXT NOT NULL CHECK (
    unit_price_cents <> '' AND unit_price_cents NOT GLOB '*[^0-9]*'
    AND CAST(unit_price_cents AS INTEGER) > 0
  ),
  total_cents TEXT NOT NULL CHECK (
    total_cents <> '' AND total_cents NOT GLOB '*[^0-9]*'
    AND CAST(total_cents AS INTEGER) > 0
  ),
  bill_ids_canonical TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, tick),
  UNIQUE (run_id, transaction_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, fuel_price_id) REFERENCES energy_fuel_price_history(run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER energy_systems_no_update BEFORE UPDATE ON energy_systems
BEGIN SELECT RAISE(ABORT, 'energy systems are immutable'); END;
CREATE TRIGGER energy_systems_no_delete BEFORE DELETE ON energy_systems
BEGIN SELECT RAISE(ABORT, 'energy systems are immutable'); END;
CREATE TRIGGER energy_tariff_history_no_update BEFORE UPDATE ON energy_tariff_history
BEGIN SELECT RAISE(ABORT, 'energy tariff history is immutable'); END;
CREATE TRIGGER energy_tariff_history_no_delete BEFORE DELETE ON energy_tariff_history
BEGIN SELECT RAISE(ABORT, 'energy tariff history is immutable'); END;
CREATE TRIGGER energy_fuel_price_history_no_update BEFORE UPDATE ON energy_fuel_price_history
BEGIN SELECT RAISE(ABORT, 'energy fuel-price history is immutable'); END;
CREATE TRIGGER energy_fuel_price_history_no_delete BEFORE DELETE ON energy_fuel_price_history
BEGIN SELECT RAISE(ABORT, 'energy fuel-price history is immutable'); END;
CREATE TRIGGER energy_bills_no_update BEFORE UPDATE ON energy_bills
BEGIN SELECT RAISE(ABORT, 'energy bills are immutable'); END;
CREATE TRIGGER energy_bills_no_delete BEFORE DELETE ON energy_bills
BEGIN SELECT RAISE(ABORT, 'energy bills are immutable'); END;
CREATE TRIGGER energy_fuel_purchases_no_update BEFORE UPDATE ON energy_fuel_purchases
BEGIN SELECT RAISE(ABORT, 'energy fuel purchases are immutable'); END;
CREATE TRIGGER energy_fuel_purchases_no_delete BEFORE DELETE ON energy_fuel_purchases
BEGIN SELECT RAISE(ABORT, 'energy fuel purchases are immutable'); END;
`;

const PHASE_4_INSOLVENCY_WIND_DOWN = `
CREATE TABLE company_solvency_assessments (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  cash_cents TEXT NOT NULL CHECK (cash_cents <> '' AND cash_cents NOT GLOB '*[^0-9]*'),
  obligation_cents TEXT NOT NULL CHECK (
    obligation_cents <> '' AND obligation_cents NOT GLOB '*[^0-9]*'
  ),
  shortfall_cents TEXT NOT NULL CHECK (
    shortfall_cents <> '' AND shortfall_cents NOT GLOB '*[^0-9]*'
  ),
  consecutive_shortfall_days INTEGER NOT NULL CHECK (consecutive_shortfall_days >= 0),
  insolvent INTEGER NOT NULL CHECK (insolvent IN (0, 1)),
  ruleset_version INTEGER NOT NULL CHECK (ruleset_version > 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id, tick),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE INDEX company_solvency_assessments_feed
  ON company_solvency_assessments(run_id, company_id, tick DESC, id DESC);

CREATE TABLE company_creditor_claims (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  creditor_kind TEXT NOT NULL CHECK (creditor_kind IN (
    'employee_wage', 'secured_debt', 'tax', 'trade',
    'unsecured_debt', 'equity_residual'
  )),
  creditor_id TEXT NOT NULL CHECK (length(trim(creditor_id)) > 0),
  creditor_account_id TEXT NOT NULL,
  seniority INTEGER NOT NULL CHECK (seniority BETWEEN 1 AND 10000),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents <> '' AND amount_cents NOT GLOB '*[^0-9]*' AND amount_cents <> '0'
  ),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'employment', 'energy_bill', 'legal_obligation',
    'loan', 'manual', 'equity_residual'
  )),
  origin_id TEXT NOT NULL CHECK (length(trim(origin_id)) > 0),
  registered_tick INTEGER NOT NULL CHECK (registered_tick >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id, origin_kind, origin_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, creditor_account_id) REFERENCES bank_accounts(run_id, id)
);

CREATE INDEX company_creditor_claims_waterfall
  ON company_creditor_claims(run_id, company_id, seniority, registered_tick, id);

CREATE TABLE company_creditor_recoveries (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents <> '' AND amount_cents NOT GLOB '*[^0-9]*' AND amount_cents <> '0'
  ),
  transaction_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, claim_id),
  UNIQUE (run_id, transaction_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, claim_id) REFERENCES company_creditor_claims(run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE company_creditor_write_offs (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents <> '' AND amount_cents NOT GLOB '*[^0-9]*' AND amount_cents <> '0'
  ),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, claim_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, claim_id) REFERENCES company_creditor_claims(run_id, id)
);

CREATE TABLE company_inventory_salvages (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents TEXT NOT NULL CHECK (
    unit_price_cents <> '' AND unit_price_cents NOT GLOB '*[^0-9]*'
    AND unit_price_cents <> '0'
  ),
  total_cents TEXT NOT NULL CHECK (
    total_cents <> '' AND total_cents NOT GLOB '*[^0-9]*' AND total_cents <> '0'
  ),
  transaction_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, inventory_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id),
  FOREIGN KEY (run_id, inventory_id) REFERENCES company_inventory(run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX company_inventory_salvages_feed
  ON company_inventory_salvages(run_id, company_id, tick, id);

CREATE TABLE company_wind_downs (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  started_tick INTEGER NOT NULL CHECK (started_tick >= 0),
  completed_tick INTEGER NOT NULL CHECK (completed_tick >= started_tick),
  opening_cash_cents TEXT NOT NULL CHECK (
    opening_cash_cents <> '' AND opening_cash_cents NOT GLOB '*[^0-9]*'
  ),
  salvage_proceeds_cents TEXT NOT NULL CHECK (
    salvage_proceeds_cents <> '' AND salvage_proceeds_cents NOT GLOB '*[^0-9]*'
  ),
  liquidation_pool_cents TEXT NOT NULL CHECK (
    liquidation_pool_cents <> '' AND liquidation_pool_cents NOT GLOB '*[^0-9]*'
  ),
  creditor_recoveries_cents TEXT NOT NULL CHECK (
    creditor_recoveries_cents <> '' AND creditor_recoveries_cents NOT GLOB '*[^0-9]*'
  ),
  written_off_cents TEXT NOT NULL CHECK (
    written_off_cents <> '' AND written_off_cents NOT GLOB '*[^0-9]*'
  ),
  employees_terminated INTEGER NOT NULL CHECK (employees_terminated >= 0),
  contracts_terminated INTEGER NOT NULL CHECK (contracts_terminated >= 0),
  jobs_withdrawn INTEGER NOT NULL CHECK (jobs_withdrawn >= 0),
  offerings_deactivated INTEGER NOT NULL CHECK (offerings_deactivated >= 0),
  accounts_closed_canonical TEXT NOT NULL,
  cause_chain_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, company_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE TRIGGER company_solvency_assessments_no_update
BEFORE UPDATE ON company_solvency_assessments
BEGIN SELECT RAISE(ABORT, 'company solvency assessments are immutable'); END;
CREATE TRIGGER company_solvency_assessments_no_delete
BEFORE DELETE ON company_solvency_assessments
BEGIN SELECT RAISE(ABORT, 'company solvency assessments are immutable'); END;
CREATE TRIGGER company_creditor_claims_no_update BEFORE UPDATE ON company_creditor_claims
BEGIN SELECT RAISE(ABORT, 'company creditor claims are immutable'); END;
CREATE TRIGGER company_creditor_claims_no_delete BEFORE DELETE ON company_creditor_claims
BEGIN SELECT RAISE(ABORT, 'company creditor claims are immutable'); END;
CREATE TRIGGER company_creditor_recoveries_no_update BEFORE UPDATE ON company_creditor_recoveries
BEGIN SELECT RAISE(ABORT, 'company creditor recoveries are immutable'); END;
CREATE TRIGGER company_creditor_recoveries_no_delete BEFORE DELETE ON company_creditor_recoveries
BEGIN SELECT RAISE(ABORT, 'company creditor recoveries are immutable'); END;
CREATE TRIGGER company_creditor_write_offs_no_update BEFORE UPDATE ON company_creditor_write_offs
BEGIN SELECT RAISE(ABORT, 'company creditor write-offs are immutable'); END;
CREATE TRIGGER company_creditor_write_offs_no_delete BEFORE DELETE ON company_creditor_write_offs
BEGIN SELECT RAISE(ABORT, 'company creditor write-offs are immutable'); END;
CREATE TRIGGER company_inventory_salvages_no_update BEFORE UPDATE ON company_inventory_salvages
BEGIN SELECT RAISE(ABORT, 'company inventory salvages are immutable'); END;
CREATE TRIGGER company_inventory_salvages_no_delete BEFORE DELETE ON company_inventory_salvages
BEGIN SELECT RAISE(ABORT, 'company inventory salvages are immutable'); END;
CREATE TRIGGER company_wind_downs_no_update BEFORE UPDATE ON company_wind_downs
BEGIN SELECT RAISE(ABORT, 'company wind-downs are immutable'); END;
CREATE TRIGGER company_wind_downs_no_delete BEFORE DELETE ON company_wind_downs
BEGIN SELECT RAISE(ABORT, 'company wind-downs are immutable'); END;
`;

const PHASE_4_WORLD_EVENT_INJECTION = `
CREATE TABLE world_events (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'energy.fuel_price_shock', 'row.reference_price_shift',
    'market.demand_shock', 'business.disaster'
  )),
  params_canonical TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'scenario')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'applied', 'cancelled')),
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  scheduled_tick INTEGER NOT NULL CHECK (scheduled_tick > created_tick),
  applied_tick INTEGER,
  task_id TEXT NOT NULL,
  command_event_id TEXT NOT NULL,
  injected_event_id TEXT NOT NULL,
  applied_event_id TEXT,
  effect_event_ids_canonical TEXT NOT NULL,
  catalog_version INTEGER NOT NULL CHECK (catalog_version > 0),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, task_id),
  UNIQUE (run_id, command_event_id),
  UNIQUE (run_id, injected_event_id),
  UNIQUE (run_id, applied_event_id),
  CHECK (
    (status = 'scheduled' AND applied_tick IS NULL AND applied_event_id IS NULL) OR
    (status = 'applied' AND applied_tick IS NOT NULL AND applied_event_id IS NOT NULL) OR
    (status = 'cancelled' AND applied_tick IS NULL AND applied_event_id IS NULL)
  )
);

CREATE INDEX world_events_schedule
  ON world_events(run_id, status, scheduled_tick, id);

CREATE TABLE row_reference_price_history (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  world_event_id TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES market_products(sku),
  effective_tick INTEGER NOT NULL CHECK (effective_tick > 0),
  old_price_cents TEXT NOT NULL CHECK (
    old_price_cents <> '' AND old_price_cents NOT GLOB '*[^0-9]*'
    AND old_price_cents <> '0'
  ),
  new_price_cents TEXT NOT NULL CHECK (
    new_price_cents <> '' AND new_price_cents NOT GLOB '*[^0-9]*'
    AND new_price_cents <> '0'
  ),
  change_bp INTEGER NOT NULL CHECK (change_bp BETWEEN -9000 AND 50000),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, world_event_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, world_event_id) REFERENCES world_events(run_id, id)
);

CREATE INDEX row_reference_price_history_feed
  ON row_reference_price_history(run_id, sku, effective_tick DESC, id DESC);

CREATE TABLE market_demand_shocks (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  world_event_id TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES market_products(sku),
  effective_tick INTEGER NOT NULL CHECK (effective_tick > 0),
  expires_tick INTEGER NOT NULL CHECK (expires_tick >= effective_tick),
  change_bp INTEGER NOT NULL CHECK (change_bp BETWEEN -9000 AND 50000),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, world_event_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, world_event_id) REFERENCES world_events(run_id, id)
);

CREATE INDEX market_demand_shocks_active
  ON market_demand_shocks(run_id, sku, effective_tick, expires_tick, id);

CREATE TABLE company_capacity_disasters (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  world_event_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  effective_tick INTEGER NOT NULL CHECK (effective_tick > 0),
  expires_tick INTEGER NOT NULL CHECK (expires_tick >= effective_tick),
  capacity_reduction_bp INTEGER NOT NULL CHECK (
    capacity_reduction_bp BETWEEN 100 AND 10000
  ),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, world_event_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, world_event_id) REFERENCES world_events(run_id, id),
  FOREIGN KEY (run_id, company_id) REFERENCES companies(run_id, id)
);

CREATE INDEX company_capacity_disasters_active
  ON company_capacity_disasters(run_id, company_id, effective_tick, expires_tick, id);

CREATE TRIGGER world_events_transition_only
BEFORE UPDATE ON world_events
WHEN
  OLD.status <> 'scheduled' OR
  NEW.status NOT IN ('applied', 'cancelled') OR
  NEW.run_id <> OLD.run_id OR NEW.id <> OLD.id OR NEW.type <> OLD.type OR
  NEW.params_canonical <> OLD.params_canonical OR NEW.source <> OLD.source OR
  NEW.created_tick <> OLD.created_tick OR NEW.scheduled_tick <> OLD.scheduled_tick OR
  NEW.task_id <> OLD.task_id OR NEW.command_event_id <> OLD.command_event_id OR
  NEW.injected_event_id <> OLD.injected_event_id OR
  NEW.catalog_version <> OLD.catalog_version
BEGIN
  SELECT RAISE(ABORT, 'world events allow only one terminal transition');
END;

CREATE TRIGGER world_events_no_delete BEFORE DELETE ON world_events
BEGIN SELECT RAISE(ABORT, 'world events cannot be deleted'); END;
CREATE TRIGGER row_reference_price_history_no_update BEFORE UPDATE ON row_reference_price_history
BEGIN SELECT RAISE(ABORT, 'ROW reference-price history is immutable'); END;
CREATE TRIGGER row_reference_price_history_no_delete BEFORE DELETE ON row_reference_price_history
BEGIN SELECT RAISE(ABORT, 'ROW reference-price history is immutable'); END;
CREATE TRIGGER market_demand_shocks_no_update BEFORE UPDATE ON market_demand_shocks
BEGIN SELECT RAISE(ABORT, 'market demand shocks are immutable'); END;
CREATE TRIGGER market_demand_shocks_no_delete BEFORE DELETE ON market_demand_shocks
BEGIN SELECT RAISE(ABORT, 'market demand shocks are immutable'); END;
CREATE TRIGGER company_capacity_disasters_no_update BEFORE UPDATE ON company_capacity_disasters
BEGIN SELECT RAISE(ABORT, 'company capacity disasters are immutable'); END;
CREATE TRIGGER company_capacity_disasters_no_delete BEFORE DELETE ON company_capacity_disasters
BEGIN SELECT RAISE(ABORT, 'company capacity disasters are immutable'); END;
`;

const PHASE_5_CREDIT_SCORING = `
CREATE TABLE loan_applications (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  applicant_kind TEXT NOT NULL CHECK (applicant_kind IN ('agent', 'company')),
  applicant_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 500),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents GLOB '[1-9]*' AND amount_cents NOT GLOB '*[^0-9]*'
  ),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 360),
  status TEXT NOT NULL CHECK (
    status IN ('submitted', 'under_review', 'approved', 'rejected', 'withdrawn')
  ),
  submitted_tick INTEGER NOT NULL CHECK (submitted_tick >= 0),
  decided_tick INTEGER CHECK (decided_tick >= submitted_tick),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, bank_id) REFERENCES banks(run_id, id),
  CHECK (
    (status IN ('submitted', 'under_review') AND decided_tick IS NULL) OR
    (status IN ('approved', 'rejected', 'withdrawn') AND decided_tick IS NOT NULL)
  )
);

CREATE INDEX loan_applications_applicant
  ON loan_applications(run_id, applicant_kind, applicant_id, submitted_tick DESC, id DESC);
CREATE INDEX loan_applications_review_queue
  ON loan_applications(run_id, bank_id, status, submitted_tick, id);

CREATE TABLE credit_score_assessments (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  model_version INTEGER NOT NULL CHECK (model_version = 1),
  inputs_canonical TEXT NOT NULL,
  system_score INTEGER NOT NULL CHECK (system_score BETWEEN 300 AND 850),
  breakdown_canonical TEXT NOT NULL,
  computed_tick INTEGER NOT NULL CHECK (computed_tick >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, application_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, application_id) REFERENCES loan_applications(run_id, id)
);

CREATE INDEX credit_score_assessments_score
  ON credit_score_assessments(run_id, system_score DESC, application_id);

CREATE TRIGGER loan_applications_core_immutable
BEFORE UPDATE ON loan_applications
WHEN
  NEW.run_id <> OLD.run_id OR NEW.id <> OLD.id OR
  NEW.applicant_kind <> OLD.applicant_kind OR NEW.applicant_id <> OLD.applicant_id OR
  NEW.bank_id <> OLD.bank_id OR NEW.purpose <> OLD.purpose OR
  NEW.amount_cents <> OLD.amount_cents OR NEW.term_months <> OLD.term_months OR
  NEW.submitted_tick <> OLD.submitted_tick OR NEW.source_event_id <> OLD.source_event_id
BEGIN
  SELECT RAISE(ABORT, 'loan application inputs are immutable');
END;

CREATE TRIGGER loan_applications_no_delete BEFORE DELETE ON loan_applications
BEGIN SELECT RAISE(ABORT, 'loan applications cannot be deleted'); END;
CREATE TRIGGER credit_score_assessments_no_update BEFORE UPDATE ON credit_score_assessments
BEGIN SELECT RAISE(ABORT, 'credit score assessments are immutable'); END;
CREATE TRIGGER credit_score_assessments_no_delete BEFORE DELETE ON credit_score_assessments
BEGIN SELECT RAISE(ABORT, 'credit score assessments cannot be deleted'); END;
`;

const PHASE_5_APPLICATION_WORKFLOW = `
CREATE TABLE loan_application_reviews (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  officer_agent_id TEXT NOT NULL,
  review_tier TEXT NOT NULL CHECK (review_tier IN ('tier1', 'tier2')),
  started_tick INTEGER NOT NULL CHECK (started_tick >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, application_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, application_id) REFERENCES loan_applications(run_id, id),
  FOREIGN KEY (run_id, officer_agent_id) REFERENCES agents(run_id, id)
);

CREATE INDEX loan_application_reviews_officer
  ON loan_application_reviews(run_id, officer_agent_id, started_tick, id);

CREATE TABLE loan_application_decisions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  officer_agent_id TEXT NOT NULL,
  review_tier TEXT NOT NULL CHECK (review_tier IN ('tier1', 'tier2')),
  policy_version INTEGER NOT NULL CHECK (policy_version = 1),
  system_score INTEGER NOT NULL CHECK (system_score BETWEEN 300 AND 850),
  officer_adjustment INTEGER NOT NULL CHECK (officer_adjustment BETWEEN -5 AND 5),
  final_score INTEGER NOT NULL CHECK (
    final_score BETWEEN 295 AND 855 AND final_score = system_score + officer_adjustment
  ),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 1000),
  policy_checks_canonical TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  offered_rate_bp INTEGER CHECK (offered_rate_bp BETWEEN 0 AND 100000),
  decided_tick INTEGER NOT NULL CHECK (decided_tick >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, application_id),
  UNIQUE (run_id, review_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, application_id) REFERENCES loan_applications(run_id, id),
  FOREIGN KEY (run_id, assessment_id) REFERENCES credit_score_assessments(run_id, id),
  FOREIGN KEY (run_id, review_id) REFERENCES loan_application_reviews(run_id, id),
  FOREIGN KEY (run_id, officer_agent_id) REFERENCES agents(run_id, id),
  CHECK (
    (outcome = 'approved' AND offered_rate_bp IS NOT NULL) OR
    (outcome = 'rejected' AND offered_rate_bp IS NULL)
  ),
  CHECK (review_tier <> 'tier1' OR officer_adjustment = 0)
);

CREATE INDEX loan_application_decisions_outcome
  ON loan_application_decisions(run_id, outcome, decided_tick, id);

CREATE TRIGGER loan_application_reviews_valid_insert
BEFORE INSERT ON loan_application_reviews
WHEN
  COALESCE((
    SELECT status FROM loan_applications
    WHERE run_id = NEW.run_id AND id = NEW.application_id
  ), '') <> 'submitted' OR
  COALESCE((
    SELECT role_code FROM agents
    WHERE run_id = NEW.run_id AND id = NEW.officer_agent_id
      AND organization_id = 'inst_first_ledger_bank' AND employment_status = 'employed'
  ), '') <> 'bank.loan_officer'
BEGIN
  SELECT RAISE(ABORT, 'loan review requires a submitted application and active officer');
END;

CREATE TRIGGER loan_application_decisions_valid_insert
BEFORE INSERT ON loan_application_decisions
WHEN
  COALESCE((
    SELECT status FROM loan_applications
    WHERE run_id = NEW.run_id AND id = NEW.application_id
  ), '') <> 'under_review' OR
  COALESCE((
    SELECT application_id FROM credit_score_assessments
    WHERE run_id = NEW.run_id AND id = NEW.assessment_id
  ), '') <> NEW.application_id OR
  NOT EXISTS (
    SELECT 1 FROM loan_application_reviews
    WHERE run_id = NEW.run_id AND id = NEW.review_id
      AND application_id = NEW.application_id
      AND officer_agent_id = NEW.officer_agent_id
      AND review_tier = NEW.review_tier
  )
BEGIN
  SELECT RAISE(ABORT, 'loan decision does not match its application, score, or review');
END;

CREATE TRIGGER loan_applications_status_transition
BEFORE UPDATE OF status, decided_tick ON loan_applications
WHEN NOT (
  (OLD.status = 'submitted' AND NEW.status = 'under_review' AND NEW.decided_tick IS NULL) OR
  (OLD.status = 'submitted' AND NEW.status = 'withdrawn' AND NEW.decided_tick IS NOT NULL) OR
  (OLD.status = 'under_review' AND NEW.status IN ('approved', 'rejected', 'withdrawn')
    AND NEW.decided_tick IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid loan application status transition');
END;

CREATE TRIGGER loan_application_review_required
BEFORE UPDATE OF status ON loan_applications
WHEN NEW.status = 'under_review' AND NOT EXISTS (
  SELECT 1 FROM loan_application_reviews
  WHERE run_id = NEW.run_id AND application_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'loan application review record is required');
END;

CREATE TRIGGER loan_application_decision_required
BEFORE UPDATE OF status ON loan_applications
WHEN NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
  SELECT 1 FROM loan_application_decisions
  WHERE run_id = NEW.run_id AND application_id = NEW.id AND outcome = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'loan application decision record is required');
END;

CREATE TRIGGER loan_application_reviews_no_update BEFORE UPDATE ON loan_application_reviews
BEGIN SELECT RAISE(ABORT, 'loan application reviews are immutable'); END;
CREATE TRIGGER loan_application_reviews_no_delete BEFORE DELETE ON loan_application_reviews
BEGIN SELECT RAISE(ABORT, 'loan application reviews cannot be deleted'); END;
CREATE TRIGGER loan_application_decisions_no_update BEFORE UPDATE ON loan_application_decisions
BEGIN SELECT RAISE(ABORT, 'loan application decisions are immutable'); END;
CREATE TRIGGER loan_application_decisions_no_delete BEFORE DELETE ON loan_application_decisions
BEGIN SELECT RAISE(ABORT, 'loan application decisions cannot be deleted'); END;
`;

const PHASE_5_LOAN_DISBURSEMENT = `
CREATE TABLE loans (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  borrower_kind TEXT NOT NULL CHECK (borrower_kind IN ('agent', 'company')),
  borrower_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  principal_cents TEXT NOT NULL CHECK (
    principal_cents GLOB '[1-9]*' AND principal_cents NOT GLOB '*[^0-9]*'
  ),
  annual_rate_bp INTEGER NOT NULL CHECK (annual_rate_bp BETWEEN 0 AND 100000),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 360),
  disbursed_tick INTEGER NOT NULL CHECK (disbursed_tick >= 0),
  maturity_tick INTEGER NOT NULL CHECK (maturity_tick = disbursed_tick + term_months * 30),
  outstanding_principal_cents TEXT NOT NULL CHECK (
    length(outstanding_principal_cents) > 0 AND
    outstanding_principal_cents NOT GLOB '*[^0-9]*'
  ),
  consecutive_misses INTEGER NOT NULL CHECK (consecutive_misses >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('disbursed', 'repaying', 'paid_off', 'defaulted', 'written_off', 'collected')
  ),
  bank_asset_account_id TEXT NOT NULL,
  borrower_deposit_account_id TEXT NOT NULL,
  disbursement_transaction_id TEXT NOT NULL,
  schedule_digest TEXT NOT NULL CHECK (
    length(schedule_digest) = 64 AND schedule_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, application_id),
  UNIQUE (run_id, decision_id),
  UNIQUE (run_id, disbursement_transaction_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, application_id) REFERENCES loan_applications(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES loan_application_decisions(run_id, id),
  FOREIGN KEY (run_id, bank_id) REFERENCES banks(run_id, id),
  FOREIGN KEY (run_id, bank_asset_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, borrower_deposit_account_id) REFERENCES bank_accounts(run_id, id),
  FOREIGN KEY (run_id, disbursement_transaction_id) REFERENCES ledger_transactions(run_id, id)
);

CREATE INDEX loans_borrower
  ON loans(run_id, borrower_kind, borrower_id, status, id);
CREATE INDEX loans_bank_status
  ON loans(run_id, bank_id, status, maturity_tick, id);

CREATE TABLE loan_installments (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number BETWEEN 1 AND 360),
  due_tick INTEGER NOT NULL CHECK (due_tick >= 0),
  opening_principal_cents TEXT NOT NULL CHECK (
    length(opening_principal_cents) > 0 AND opening_principal_cents NOT GLOB '*[^0-9]*'
  ),
  principal_due_cents TEXT NOT NULL CHECK (
    length(principal_due_cents) > 0 AND principal_due_cents NOT GLOB '*[^0-9]*'
  ),
  interest_due_cents TEXT NOT NULL CHECK (
    length(interest_due_cents) > 0 AND interest_due_cents NOT GLOB '*[^0-9]*'
  ),
  total_due_cents TEXT NOT NULL CHECK (
    length(total_due_cents) > 0 AND total_due_cents NOT GLOB '*[^0-9]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('due', 'completed', 'missed')),
  paid_tick INTEGER,
  transaction_id TEXT,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, loan_id, installment_number),
  UNIQUE (run_id, loan_id, due_tick),
  FOREIGN KEY (run_id, loan_id) REFERENCES loans(run_id, id),
  FOREIGN KEY (run_id, transaction_id) REFERENCES ledger_transactions(run_id, id),
  CHECK (
    (status = 'completed' AND paid_tick IS NOT NULL AND transaction_id IS NOT NULL) OR
    (status IN ('due', 'missed') AND paid_tick IS NULL AND transaction_id IS NULL)
  )
);

CREATE INDEX loan_installments_due
  ON loan_installments(run_id, status, due_tick, loan_id, installment_number);

CREATE TRIGGER loans_valid_insert
BEFORE INSERT ON loans
WHEN
  NOT EXISTS (
    SELECT 1 FROM loan_applications a
    JOIN loan_application_decisions d
      ON d.run_id = a.run_id AND d.application_id = a.id
    WHERE a.run_id = NEW.run_id AND a.id = NEW.application_id
      AND a.status = 'approved' AND d.id = NEW.decision_id
      AND d.outcome = 'approved' AND d.offered_rate_bp = NEW.annual_rate_bp
      AND a.applicant_kind = NEW.borrower_kind AND a.applicant_id = NEW.borrower_id
      AND a.bank_id = NEW.bank_id AND a.amount_cents = NEW.principal_cents
      AND a.term_months = NEW.term_months
  ) OR
  NOT EXISTS (
    SELECT 1 FROM bank_accounts asset
    WHERE asset.run_id = NEW.run_id AND asset.id = NEW.bank_asset_account_id
      AND asset.bank_id = NEW.bank_id AND asset.owner_kind = 'bank_internal'
      AND asset.owner_id = NEW.id AND asset.account_type = 'internal_asset'
      AND asset.status = 'active'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM bank_accounts deposit
    WHERE deposit.run_id = NEW.run_id AND deposit.id = NEW.borrower_deposit_account_id
      AND deposit.bank_id = NEW.bank_id AND deposit.owner_kind = NEW.borrower_kind
      AND deposit.owner_id = NEW.borrower_id AND deposit.account_type = 'checking'
      AND deposit.status = 'active'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transactions t
    WHERE t.run_id = NEW.run_id AND t.id = NEW.disbursement_transaction_id
      AND t.kind = 'loan_disbursement' AND t.tick = NEW.disbursed_tick
      AND t.actor_kind = 'system' AND t.actor_id = 'credit'
      AND t.source_event_id = NEW.source_event_id
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs l
    WHERE l.run_id = NEW.run_id AND l.transaction_id = NEW.disbursement_transaction_id
      AND l.account_id = NEW.bank_asset_account_id AND l.direction = 'debit'
      AND l.amount_cents = NEW.principal_cents
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs l
    WHERE l.run_id = NEW.run_id AND l.transaction_id = NEW.disbursement_transaction_id
      AND l.account_id = NEW.borrower_deposit_account_id AND l.direction = 'debit'
      AND l.amount_cents = NEW.principal_cents
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs l
    JOIN bank_accounts source
      ON source.run_id = l.run_id AND source.id = l.account_id
    WHERE l.run_id = NEW.run_id AND l.transaction_id = NEW.disbursement_transaction_id
      AND source.bank_id = NEW.bank_id AND source.owner_kind = 'bank_internal'
      AND source.owner_id = NEW.bank_id || ':loan_source'
      AND source.account_type = 'internal_liability' AND source.status = 'active'
      AND l.direction = 'credit'
      AND CAST(l.amount_cents AS INTEGER) = CAST(NEW.principal_cents AS INTEGER) * 2
  ) OR
  (
    SELECT COUNT(*) FROM ledger_transaction_legs l
    WHERE l.run_id = NEW.run_id AND l.transaction_id = NEW.disbursement_transaction_id
  ) <> 3
BEGIN
  SELECT RAISE(ABORT, 'loan disbursement records are inconsistent');
END;

CREATE TRIGGER loan_installments_valid_insert
BEFORE INSERT ON loan_installments
WHEN NOT EXISTS (
  SELECT 1 FROM loans l
  WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
    AND NEW.installment_number <= l.term_months
    AND NEW.due_tick = l.disbursed_tick + NEW.installment_number * 30
)
BEGIN
  SELECT RAISE(ABORT, 'loan installment does not match loan terms');
END;

CREATE TRIGGER loans_terms_immutable
BEFORE UPDATE OF
  run_id, id, application_id, decision_id, borrower_kind, borrower_id, bank_id,
  principal_cents, annual_rate_bp, term_months, disbursed_tick, maturity_tick,
  bank_asset_account_id, borrower_deposit_account_id, disbursement_transaction_id,
  schedule_digest, source_event_id
ON loans
BEGIN SELECT RAISE(ABORT, 'loan terms and disbursement records are immutable'); END;
CREATE TRIGGER loans_no_delete BEFORE DELETE ON loans
BEGIN SELECT RAISE(ABORT, 'loans cannot be deleted'); END;

CREATE TRIGGER loan_installments_core_immutable
BEFORE UPDATE OF
  run_id, id, loan_id, installment_number, due_tick, opening_principal_cents,
  principal_due_cents, interest_due_cents, total_due_cents, source_event_id
ON loan_installments
BEGIN SELECT RAISE(ABORT, 'loan installment schedule is immutable'); END;
CREATE TRIGGER loan_installments_no_delete BEFORE DELETE ON loan_installments
BEGIN SELECT RAISE(ABORT, 'loan installments cannot be deleted'); END;
`;

const PHASE_5_LOAN_COLLECTIONS = `
CREATE TABLE loan_defaults (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  borrower_kind TEXT NOT NULL CHECK (borrower_kind IN ('agent', 'company')),
  borrower_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  default_tick INTEGER NOT NULL CHECK (default_tick >= 0),
  outstanding_principal_cents TEXT NOT NULL CHECK (
    outstanding_principal_cents GLOB '[1-9]*' AND
    outstanding_principal_cents NOT GLOB '*[^0-9]*'
  ),
  missed_installment_ids_canonical TEXT NOT NULL,
  write_down_transaction_id TEXT NOT NULL,
  credit_score_before INTEGER CHECK (credit_score_before BETWEEN 300 AND 850),
  credit_score_penalty_points INTEGER NOT NULL CHECK (
    credit_score_penalty_points BETWEEN 0 AND 550
  ),
  credit_score_after INTEGER CHECK (credit_score_after BETWEEN 300 AND 850),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, loan_id),
  UNIQUE (run_id, write_down_transaction_id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, loan_id) REFERENCES loans(run_id, id),
  FOREIGN KEY (run_id, bank_id) REFERENCES banks(run_id, id),
  FOREIGN KEY (run_id, write_down_transaction_id)
    REFERENCES ledger_transactions(run_id, id),
  CHECK (
    (borrower_kind = 'agent' AND credit_score_before IS NOT NULL
      AND credit_score_penalty_points > 0 AND credit_score_after IS NOT NULL) OR
    (borrower_kind = 'company' AND credit_score_before IS NULL
      AND credit_score_penalty_points = 0 AND credit_score_after IS NULL)
  )
);

CREATE INDEX loan_defaults_borrower
  ON loan_defaults(run_id, borrower_kind, borrower_id, default_tick, id);
CREATE INDEX loan_defaults_bank
  ON loan_defaults(run_id, bank_id, default_tick, id);

CREATE TRIGGER loan_installments_collection_transition
BEFORE UPDATE OF status, paid_tick, transaction_id ON loan_installments
WHEN NOT (
  (OLD.status = 'due' AND NEW.status = 'missed'
    AND NEW.paid_tick IS NULL AND NEW.transaction_id IS NULL) OR
  (OLD.status IN ('due', 'missed') AND NEW.status = 'completed'
    AND NEW.paid_tick IS NOT NULL AND NEW.transaction_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid loan installment collection transition');
END;

CREATE TRIGGER loan_installments_payment_valid
BEFORE UPDATE OF status, paid_tick, transaction_id ON loan_installments
WHEN NEW.status = 'completed' AND NOT (
  EXISTS (
    SELECT 1 FROM loans l
    JOIN ledger_transactions t
      ON t.run_id = l.run_id AND t.id = NEW.transaction_id
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND t.kind = 'loan_payment' AND t.tick = NEW.paid_tick
      AND t.actor_kind = 'system' AND t.actor_id = 'credit'
      AND t.reason = 'loan.installment.payment'
  ) AND
  EXISTS (
    SELECT 1 FROM loans l
    JOIN ledger_transaction_legs leg
      ON leg.run_id = l.run_id AND leg.transaction_id = NEW.transaction_id
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND leg.account_id = l.borrower_deposit_account_id
      AND leg.direction = 'credit' AND leg.amount_cents = NEW.total_due_cents
  ) AND
  EXISTS (
    SELECT 1 FROM loans l
    JOIN ledger_transaction_legs leg
      ON leg.run_id = l.run_id AND leg.transaction_id = NEW.transaction_id
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND leg.account_id = l.bank_asset_account_id
      AND leg.direction = 'credit' AND leg.amount_cents = NEW.principal_due_cents
  ) AND
  EXISTS (
    SELECT 1 FROM loans l
    JOIN ledger_transaction_legs leg
      ON leg.run_id = l.run_id AND leg.transaction_id = NEW.transaction_id
    JOIN bank_accounts source
      ON source.run_id = leg.run_id AND source.id = leg.account_id
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND source.bank_id = l.bank_id AND source.owner_kind = 'bank_internal'
      AND source.owner_id = l.bank_id || ':loan_source'
      AND source.account_type = 'internal_liability' AND source.status = 'active'
      AND leg.direction = 'debit'
      AND CAST(leg.amount_cents AS INTEGER) = CAST(NEW.principal_due_cents AS INTEGER) * 2
  ) AND
  (
    NEW.interest_due_cents = '0' OR EXISTS (
      SELECT 1 FROM loans l
      JOIN ledger_transaction_legs leg
        ON leg.run_id = l.run_id AND leg.transaction_id = NEW.transaction_id
      JOIN bank_accounts income
        ON income.run_id = leg.run_id AND income.id = leg.account_id
      WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
        AND income.bank_id = l.bank_id AND income.owner_kind = 'bank_internal'
        AND income.owner_id = l.bank_id || ':interest_income'
        AND income.account_type = 'internal_income' AND income.status = 'active'
        AND leg.direction = 'debit' AND leg.amount_cents = NEW.interest_due_cents
    )
  ) AND
  (
    SELECT COUNT(*) FROM ledger_transaction_legs leg
    WHERE leg.run_id = NEW.run_id AND leg.transaction_id = NEW.transaction_id
  ) = CASE WHEN NEW.interest_due_cents = '0' THEN 3 ELSE 4 END
)
BEGIN
  SELECT RAISE(ABORT, 'loan installment payment is inconsistent');
END;

CREATE TRIGGER loans_collection_transition
BEFORE UPDATE OF outstanding_principal_cents, consecutive_misses, status ON loans
WHEN NOT (
  OLD.status IN ('disbursed', 'repaying') AND (
    (NEW.status = 'repaying' AND NEW.outstanding_principal_cents = OLD.outstanding_principal_cents
      AND NEW.consecutive_misses = OLD.consecutive_misses + 1
      AND NEW.consecutive_misses < 3) OR
    (NEW.status = 'repaying'
      AND CAST(NEW.outstanding_principal_cents AS INTEGER) <
        CAST(OLD.outstanding_principal_cents AS INTEGER)
      AND NEW.consecutive_misses = 0) OR
    (NEW.status = 'paid_off' AND NEW.outstanding_principal_cents = '0'
      AND NEW.consecutive_misses = 0) OR
    (NEW.status = 'defaulted'
      AND NEW.outstanding_principal_cents = OLD.outstanding_principal_cents
      AND NEW.consecutive_misses = OLD.consecutive_misses + 1
      AND NEW.consecutive_misses >= 3)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid loan collection transition');
END;

CREATE TRIGGER loans_outstanding_matches_installments
BEFORE UPDATE OF outstanding_principal_cents, consecutive_misses, status ON loans
WHEN CAST(NEW.outstanding_principal_cents AS INTEGER) <>
  CAST(NEW.principal_cents AS INTEGER) - COALESCE((
    SELECT SUM(CAST(i.principal_due_cents AS INTEGER))
    FROM loan_installments i
    WHERE i.run_id = NEW.run_id AND i.loan_id = NEW.id AND i.status = 'completed'
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'loan outstanding principal does not match completed installments');
END;

CREATE TRIGGER loan_defaults_valid_insert
BEFORE INSERT ON loan_defaults
WHEN
  NOT EXISTS (
    SELECT 1 FROM loans l
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND l.status = 'defaulted' AND l.borrower_kind = NEW.borrower_kind
      AND l.borrower_id = NEW.borrower_id AND l.bank_id = NEW.bank_id
      AND l.outstanding_principal_cents = NEW.outstanding_principal_cents
      AND l.consecutive_misses >= 3
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transactions t
    WHERE t.run_id = NEW.run_id AND t.id = NEW.write_down_transaction_id
      AND t.tick = NEW.default_tick AND t.kind = 'loan_payment'
      AND t.actor_kind = 'system' AND t.actor_id = 'credit'
      AND t.reason = 'loan.default.write_down'
      AND t.source_event_id = NEW.source_event_id
  ) OR
  NOT EXISTS (
    SELECT 1 FROM loans l
    JOIN ledger_transaction_legs leg
      ON leg.run_id = l.run_id AND leg.transaction_id = NEW.write_down_transaction_id
    WHERE l.run_id = NEW.run_id AND l.id = NEW.loan_id
      AND leg.account_id = l.bank_asset_account_id AND leg.direction = 'credit'
      AND leg.amount_cents = NEW.outstanding_principal_cents
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs leg
    JOIN bank_accounts expense
      ON expense.run_id = leg.run_id AND expense.id = leg.account_id
    WHERE leg.run_id = NEW.run_id AND leg.transaction_id = NEW.write_down_transaction_id
      AND expense.bank_id = NEW.bank_id AND expense.owner_kind = 'bank_internal'
      AND expense.owner_id = NEW.bank_id || ':credit_loss'
      AND expense.account_type = 'internal_expense' AND expense.status = 'active'
      AND leg.direction = 'debit'
      AND leg.amount_cents = NEW.outstanding_principal_cents
  ) OR
  (
    SELECT COUNT(*) FROM ledger_transaction_legs leg
    WHERE leg.run_id = NEW.run_id AND leg.transaction_id = NEW.write_down_transaction_id
  ) <> 2 OR
  (
    NEW.borrower_kind = 'agent' AND NOT EXISTS (
      SELECT 1 FROM agents a
      WHERE a.run_id = NEW.run_id AND a.id = NEW.borrower_id
        AND a.credit_score = NEW.credit_score_after
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'loan default record is inconsistent');
END;

CREATE TRIGGER loan_defaults_no_update BEFORE UPDATE ON loan_defaults
BEGIN SELECT RAISE(ABORT, 'loan defaults are immutable'); END;
CREATE TRIGGER loan_defaults_no_delete BEFORE DELETE ON loan_defaults
BEGIN SELECT RAISE(ABORT, 'loan defaults cannot be deleted'); END;
`;

const PHASE_5_BANK_CIRCUIT_BREAKERS = `
ALTER TABLE banks ADD COLUMN reserve_cents TEXT NOT NULL DEFAULT '95040000'
  CHECK (reserve_cents NOT GLOB '*[^0-9]*' AND length(reserve_cents) > 0);

UPDATE banks
SET reserve_ratio_bp = 1200,
    capital_ratio_min_bp = 1000;

CREATE TABLE bank_lending_assessments (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  decision_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('approval', 'disbursement')),
  borrower_kind TEXT NOT NULL CHECK (borrower_kind IN ('agent', 'company')),
  borrower_id TEXT NOT NULL,
  assessed_tick INTEGER NOT NULL CHECK (assessed_tick >= 0),
  policy_version INTEGER NOT NULL CHECK (policy_version = 1),
  bank_status_before TEXT NOT NULL
    CHECK (bank_status_before IN ('active', 'lending_halted', 'closed')),
  bank_status_after TEXT NOT NULL
    CHECK (bank_status_after IN ('active', 'lending_halted', 'closed')),
  deposit_cents TEXT NOT NULL
    CHECK (deposit_cents NOT GLOB '*[^0-9]*' AND length(deposit_cents) > 0),
  projected_deposit_cents TEXT NOT NULL
    CHECK (projected_deposit_cents NOT GLOB '*[^0-9]*' AND length(projected_deposit_cents) > 0),
  reserve_cents TEXT NOT NULL
    CHECK (reserve_cents NOT GLOB '*[^0-9]*' AND length(reserve_cents) > 0),
  reserve_ratio_bp INTEGER NOT NULL CHECK (reserve_ratio_bp BETWEEN 0 AND 100000),
  projected_reserve_ratio_bp INTEGER NOT NULL
    CHECK (projected_reserve_ratio_bp BETWEEN 0 AND 100000),
  reserve_ratio_min_bp INTEGER NOT NULL CHECK (reserve_ratio_min_bp BETWEEN 0 AND 10000),
  effective_capital_cents TEXT NOT NULL
    CHECK (effective_capital_cents NOT GLOB '*[^0-9]*' AND length(effective_capital_cents) > 0),
  capital_ratio_bp INTEGER NOT NULL CHECK (capital_ratio_bp BETWEEN 0 AND 100000),
  projected_capital_ratio_bp INTEGER NOT NULL
    CHECK (projected_capital_ratio_bp BETWEEN 0 AND 100000),
  capital_ratio_min_bp INTEGER NOT NULL CHECK (capital_ratio_min_bp BETWEEN 0 AND 10000),
  borrower_exposure_cents TEXT NOT NULL
    CHECK (borrower_exposure_cents NOT GLOB '*[^0-9]*' AND length(borrower_exposure_cents) > 0),
  projected_borrower_exposure_cents TEXT NOT NULL
    CHECK (
      projected_borrower_exposure_cents NOT GLOB '*[^0-9]*' AND
      length(projected_borrower_exposure_cents) > 0
    ),
  borrower_exposure_cap_cents TEXT NOT NULL
    CHECK (
      borrower_exposure_cap_cents NOT GLOB '*[^0-9]*' AND
      length(borrower_exposure_cap_cents) > 0
    ),
  requested_amount_cents TEXT NOT NULL
    CHECK (
      requested_amount_cents NOT GLOB '*[^0-9]*' AND
      length(requested_amount_cents) > 0 AND
      CAST(requested_amount_cents AS INTEGER) > 0
    ),
  bank_open INTEGER NOT NULL CHECK (bank_open IN (0, 1)),
  reserve_passed INTEGER NOT NULL CHECK (reserve_passed IN (0, 1)),
  capital_passed INTEGER NOT NULL CHECK (capital_passed IN (0, 1)),
  exposure_passed INTEGER NOT NULL CHECK (exposure_passed IN (0, 1)),
  systemic_passed INTEGER NOT NULL CHECK (systemic_passed IN (0, 1)),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  failed_breakers_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, bank_id) REFERENCES banks(run_id, id),
  FOREIGN KEY (run_id, application_id) REFERENCES loan_applications(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES loan_application_decisions(run_id, id),
  CHECK (
    (stage = 'approval' AND decision_id IS NULL) OR
    (stage = 'disbursement' AND decision_id IS NOT NULL)
  ),
  CHECK (
    CAST(projected_deposit_cents AS INTEGER) =
      CAST(deposit_cents AS INTEGER) + CAST(requested_amount_cents AS INTEGER)
  ),
  CHECK (
    CAST(projected_borrower_exposure_cents AS INTEGER) =
      CAST(borrower_exposure_cents AS INTEGER) + CAST(requested_amount_cents AS INTEGER)
  ),
  CHECK (bank_open = (bank_status_before <> 'closed')),
  CHECK (systemic_passed = (bank_open AND reserve_passed AND capital_passed)),
  CHECK (allowed = (systemic_passed AND exposure_passed)),
  CHECK (
    bank_status_after = CASE
      WHEN bank_open = 0 THEN 'closed'
      WHEN systemic_passed = 1 THEN 'active'
      ELSE 'lending_halted'
    END
  )
);

CREATE INDEX bank_lending_assessments_application
  ON bank_lending_assessments(run_id, application_id, stage, assessed_tick, id);
CREATE INDEX bank_lending_assessments_bank
  ON bank_lending_assessments(run_id, bank_id, assessed_tick, id);

CREATE TRIGGER bank_lending_assessments_valid_insert
BEFORE INSERT ON bank_lending_assessments
WHEN
  NOT EXISTS (
    SELECT 1 FROM loan_applications a
    WHERE a.run_id = NEW.run_id AND a.id = NEW.application_id
      AND a.bank_id = NEW.bank_id AND a.applicant_kind = NEW.borrower_kind
      AND a.applicant_id = NEW.borrower_id
      AND a.amount_cents = NEW.requested_amount_cents
  ) OR
  NOT EXISTS (
    SELECT 1 FROM banks b
    WHERE b.run_id = NEW.run_id AND b.id = NEW.bank_id
      AND b.reserve_cents = NEW.reserve_cents
      AND b.reserve_ratio_bp = NEW.reserve_ratio_min_bp
      AND b.capital_ratio_min_bp = NEW.capital_ratio_min_bp
      AND b.exposure_cap_cents = NEW.borrower_exposure_cap_cents
  ) OR
  NEW.bank_status_before <> COALESCE((
    SELECT b.status FROM banks b
    WHERE b.run_id = NEW.run_id AND b.id = NEW.bank_id
  ), '') OR
  CAST(NEW.deposit_cents AS INTEGER) <> COALESCE((
    SELECT SUM(CAST(a.balance_cents AS INTEGER)) FROM bank_accounts a
    WHERE a.run_id = NEW.run_id AND a.bank_id = NEW.bank_id
      AND a.account_type = 'checking'
      AND a.owner_kind IN ('agent', 'company', 'government')
  ), 0) OR
  CAST(NEW.effective_capital_cents AS INTEGER) <> MAX(0,
    COALESCE((
      SELECT CAST(b.capital_cents AS INTEGER) FROM banks b
      WHERE b.run_id = NEW.run_id AND b.id = NEW.bank_id
    ), 0) + COALESCE((
      SELECT SUM(CASE
        WHEN a.account_type = 'internal_income' THEN CAST(a.balance_cents AS INTEGER)
        ELSE -CAST(a.balance_cents AS INTEGER)
      END)
      FROM bank_accounts a
      WHERE a.run_id = NEW.run_id AND a.bank_id = NEW.bank_id
        AND a.owner_kind = 'bank_internal'
        AND a.account_type IN ('internal_income', 'internal_expense')
    ), 0)
  ) OR
  CAST(NEW.borrower_exposure_cents AS INTEGER) <> (
    COALESCE((
      SELECT SUM(CAST(seed.outstanding_principal_cents AS INTEGER))
      FROM seed_loans seed
      JOIN seed_loan_ledger_links link
        ON link.run_id = seed.run_id AND link.loan_id = seed.id
      JOIN bank_accounts asset
        ON asset.run_id = link.run_id AND asset.id = link.bank_asset_account_id
      WHERE seed.run_id = NEW.run_id AND asset.bank_id = NEW.bank_id
        AND seed.borrower_id = NEW.borrower_id
    ), 0) + COALESCE((
      SELECT SUM(CAST(l.outstanding_principal_cents AS INTEGER)) FROM loans l
      WHERE l.run_id = NEW.run_id AND l.bank_id = NEW.bank_id
        AND l.borrower_id = NEW.borrower_id
        AND CAST(l.outstanding_principal_cents AS INTEGER) > 0
    ), 0)
  ) OR
  NEW.reserve_ratio_bp <> CASE
    WHEN CAST(NEW.deposit_cents AS INTEGER) = 0 THEN 10000
    ELSE MIN(
      100000,
      CAST(NEW.reserve_cents AS INTEGER) * 10000 / CAST(NEW.deposit_cents AS INTEGER)
    )
  END OR
  NEW.projected_reserve_ratio_bp <> MIN(
    100000,
    CAST(NEW.reserve_cents AS INTEGER) * 10000 /
      CAST(NEW.projected_deposit_cents AS INTEGER)
  ) OR
  NEW.capital_ratio_bp <> CASE
    WHEN CAST(NEW.deposit_cents AS INTEGER) = 0 THEN 10000
    ELSE MIN(
      100000,
      CAST(NEW.effective_capital_cents AS INTEGER) * 10000 /
        CAST(NEW.deposit_cents AS INTEGER)
    )
  END OR
  NEW.projected_capital_ratio_bp <> MIN(
    100000,
    CAST(NEW.effective_capital_cents AS INTEGER) * 10000 /
      CAST(NEW.projected_deposit_cents AS INTEGER)
  ) OR
  NEW.reserve_passed <> (
    NEW.projected_reserve_ratio_bp >= NEW.reserve_ratio_min_bp
  ) OR
  NEW.capital_passed <> (
    NEW.projected_capital_ratio_bp >= NEW.capital_ratio_min_bp
  ) OR
  NEW.exposure_passed <> (
    CAST(NEW.projected_borrower_exposure_cents AS INTEGER) <=
      CAST(NEW.borrower_exposure_cap_cents AS INTEGER)
  ) OR
  (
    NEW.stage = 'disbursement' AND NOT EXISTS (
      SELECT 1 FROM loan_application_decisions d
      WHERE d.run_id = NEW.run_id AND d.id = NEW.decision_id
        AND d.application_id = NEW.application_id AND d.outcome = 'approved'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'bank lending assessment is inconsistent');
END;

CREATE TRIGGER bank_lending_assessments_no_update
BEFORE UPDATE ON bank_lending_assessments
BEGIN SELECT RAISE(ABORT, 'bank lending assessments are immutable'); END;
CREATE TRIGGER bank_lending_assessments_no_delete
BEFORE DELETE ON bank_lending_assessments
BEGIN SELECT RAISE(ABORT, 'bank lending assessments cannot be deleted'); END;

CREATE TRIGGER bank_lending_status_requires_assessment
BEFORE UPDATE OF status ON banks
WHEN OLD.status <> NEW.status
  AND OLD.status IN ('active', 'lending_halted')
  AND NEW.status IN ('active', 'lending_halted')
  AND NOT EXISTS (
    SELECT 1 FROM bank_lending_assessments a
    WHERE a.run_id = NEW.run_id AND a.bank_id = NEW.id
      AND a.bank_status_before = OLD.status AND a.bank_status_after = NEW.status
  )
BEGIN
  SELECT RAISE(ABORT, 'bank lending status transition requires an assessment');
END;

CREATE TRIGGER loan_decisions_require_circuit_assessment
BEFORE INSERT ON loan_application_decisions
WHEN
  NOT EXISTS (
    SELECT 1 FROM bank_lending_assessments a
    WHERE a.run_id = NEW.run_id AND a.application_id = NEW.application_id
      AND a.stage = 'approval' AND a.assessed_tick = NEW.decided_tick
  ) OR
  (
    NEW.outcome = 'approved' AND NOT EXISTS (
      SELECT 1 FROM bank_lending_assessments a
      WHERE a.run_id = NEW.run_id AND a.application_id = NEW.application_id
        AND a.stage = 'approval' AND a.assessed_tick = NEW.decided_tick
        AND a.allowed = 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'loan decision requires a compatible circuit assessment');
END;

CREATE TRIGGER loans_require_circuit_assessment
BEFORE INSERT ON loans
WHEN NOT EXISTS (
  SELECT 1 FROM bank_lending_assessments a
  WHERE a.run_id = NEW.run_id AND a.application_id = NEW.application_id
    AND a.decision_id = NEW.decision_id AND a.bank_id = NEW.bank_id
    AND a.stage = 'disbursement' AND a.assessed_tick = NEW.disbursed_tick
    AND a.requested_amount_cents = NEW.principal_cents AND a.allowed = 1
)
BEGIN
  SELECT RAISE(ABORT, 'loan disbursement requires an allowed circuit assessment');
END;
`;

const PHASE_5_SEEDED_CREDIT_STATE = `
CREATE TRIGGER seed_loans_valid_insert
BEFORE INSERT ON seed_loans
WHEN
  json_valid(NEW.loan_canonical) <> 1 OR
  json_extract(NEW.loan_canonical, '$.id') <> NEW.id OR
  json_extract(NEW.loan_canonical, '$.runId') <> NEW.run_id OR
  json_extract(NEW.loan_canonical, '$.borrowerKind') <> NEW.borrower_kind OR
  json_extract(NEW.loan_canonical, '$.borrowerId') <> NEW.borrower_id OR
  json_extract(NEW.loan_canonical, '$.status') <> NEW.status OR
  json_extract(NEW.loan_canonical, '$.outstandingPrincipalCents') <>
    NEW.outstanding_principal_cents OR
  json_type(NEW.loan_canonical, '$.originalPrincipalCents') <> 'text' OR
  json_extract(NEW.loan_canonical, '$.originalPrincipalCents') NOT GLOB '[1-9]*' OR
  json_extract(NEW.loan_canonical, '$.originalPrincipalCents') GLOB '*[^0-9]*' OR
  json_type(NEW.loan_canonical, '$.annualRateBp') <> 'integer' OR
  CAST(json_extract(NEW.loan_canonical, '$.annualRateBp') AS INTEGER) < 0 OR
  json_type(NEW.loan_canonical, '$.termMonths') <> 'integer' OR
  CAST(json_extract(NEW.loan_canonical, '$.termMonths') AS INTEGER) NOT BETWEEN 1 AND 360 OR
  json_type(NEW.loan_canonical, '$.seasonedMonths') <> 'integer' OR
  CAST(json_extract(NEW.loan_canonical, '$.seasonedMonths') AS INTEGER) NOT BETWEEN 1 AND
    CAST(json_extract(NEW.loan_canonical, '$.termMonths') AS INTEGER) - 1 OR
  json_type(NEW.loan_canonical, '$.missedPayments') <> 'integer' OR
  json_type(NEW.loan_canonical, '$.installments') <> 'array' OR
  json_array_length(NEW.loan_canonical, '$.installments') <>
    CAST(json_extract(NEW.loan_canonical, '$.termMonths') AS INTEGER) OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.loan_canonical, '$.installments') installment
    WHERE
      json_type(installment.value, '$.installment') <> 'integer' OR
      CAST(json_extract(installment.value, '$.installment') AS INTEGER) < 1 OR
      json_type(installment.value, '$.principalCents') <> 'text' OR
      json_extract(installment.value, '$.principalCents') NOT GLOB '[1-9]*' OR
      json_extract(installment.value, '$.principalCents') GLOB '*[^0-9]*' OR
      json_type(installment.value, '$.interestCents') <> 'text' OR
      length(json_extract(installment.value, '$.interestCents')) = 0 OR
      json_extract(installment.value, '$.interestCents') GLOB '*[^0-9]*' OR
      json_extract(installment.value, '$.status') NOT IN ('paid', 'missed', 'scheduled')
  ) OR
  CAST(json_extract(NEW.loan_canonical, '$.originalPrincipalCents') AS INTEGER) <>
    COALESCE((
      SELECT SUM(CAST(json_extract(installment.value, '$.principalCents') AS INTEGER))
      FROM json_each(NEW.loan_canonical, '$.installments') installment
    ), 0) OR
  CAST(NEW.outstanding_principal_cents AS INTEGER) <> COALESCE((
    SELECT SUM(CAST(json_extract(installment.value, '$.principalCents') AS INTEGER))
    FROM json_each(NEW.loan_canonical, '$.installments') installment
    WHERE json_extract(installment.value, '$.status') <> 'paid'
  ), 0) OR
  CAST(json_extract(NEW.loan_canonical, '$.missedPayments') AS INTEGER) <> (
    SELECT COUNT(*) FROM json_each(NEW.loan_canonical, '$.installments') installment
    WHERE json_extract(installment.value, '$.status') = 'missed'
  ) OR
  (
    NEW.status = 'current' AND
    CAST(json_extract(NEW.loan_canonical, '$.missedPayments') AS INTEGER) <> 0
  ) OR
  (
    NEW.status = 'delinquent' AND
    CAST(json_extract(NEW.loan_canonical, '$.missedPayments') AS INTEGER) <> 1
  ) OR
  (
    NEW.borrower_kind = 'agent' AND NOT EXISTS (
      SELECT 1 FROM agents a
      WHERE a.run_id = NEW.run_id AND a.id = NEW.borrower_id
    )
  ) OR
  (
    NEW.borrower_kind = 'business' AND NOT EXISTS (
      SELECT 1 FROM opening_accounts a
      WHERE a.run_id = NEW.run_id AND a.owner_kind = 'business'
        AND a.owner_id = NEW.borrower_id AND a.account_type = 'checking'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'seed loan history is inconsistent');
END;

CREATE TRIGGER seed_loans_no_update BEFORE UPDATE ON seed_loans
BEGIN SELECT RAISE(ABORT, 'seed loans are immutable'); END;
CREATE TRIGGER seed_loans_no_delete BEFORE DELETE ON seed_loans
BEGIN SELECT RAISE(ABORT, 'seed loans cannot be deleted'); END;

CREATE TRIGGER seed_loan_ledger_links_valid_insert
BEFORE INSERT ON seed_loan_ledger_links
WHEN
  NOT EXISTS (
    SELECT 1 FROM seed_loans loan
    JOIN bank_accounts asset
      ON asset.run_id = loan.run_id AND asset.id = NEW.bank_asset_account_id
    JOIN bank_accounts borrower
      ON borrower.run_id = loan.run_id AND borrower.id = NEW.borrower_deposit_account_id
    WHERE loan.run_id = NEW.run_id AND loan.id = NEW.loan_id
      AND asset.owner_kind = 'bank_internal' AND asset.owner_id = loan.id
      AND asset.account_type = 'internal_asset' AND asset.status = 'active'
      AND asset.balance_cents = loan.outstanding_principal_cents
      AND borrower.bank_id = asset.bank_id AND borrower.account_type = 'checking'
      AND borrower.status = 'active' AND borrower.owner_id = loan.borrower_id
      AND borrower.owner_kind = CASE loan.borrower_kind
        WHEN 'business' THEN 'company' ELSE 'agent'
      END
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transactions transaction_row
    WHERE transaction_row.run_id = NEW.run_id
      AND transaction_row.id = NEW.disbursement_transaction_id
      AND transaction_row.tick = 0 AND transaction_row.kind = 'loan_disbursement'
      AND transaction_row.actor_kind = 'system' AND transaction_row.actor_id = 'finance'
      AND transaction_row.reason = 'world_gen.seed_loan_recognition'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs leg
    JOIN seed_loans loan
      ON loan.run_id = leg.run_id AND loan.id = NEW.loan_id
    WHERE leg.run_id = NEW.run_id
      AND leg.transaction_id = NEW.disbursement_transaction_id
      AND leg.account_id = NEW.bank_asset_account_id AND leg.direction = 'debit'
      AND leg.amount_cents = loan.outstanding_principal_cents
  ) OR
  NOT EXISTS (
    SELECT 1 FROM ledger_transaction_legs leg
    JOIN bank_accounts source
      ON source.run_id = leg.run_id AND source.id = leg.account_id
    JOIN bank_accounts asset
      ON asset.run_id = leg.run_id AND asset.id = NEW.bank_asset_account_id
    JOIN seed_loans loan
      ON loan.run_id = leg.run_id AND loan.id = NEW.loan_id
    WHERE leg.run_id = NEW.run_id
      AND leg.transaction_id = NEW.disbursement_transaction_id
      AND leg.direction = 'credit' AND leg.amount_cents = loan.outstanding_principal_cents
      AND source.bank_id = asset.bank_id AND source.owner_kind = 'bank_internal'
      AND source.owner_id = asset.bank_id || ':loan_source'
      AND source.account_type = 'internal_liability' AND source.status = 'active'
  ) OR
  (
    SELECT COUNT(*) FROM ledger_transaction_legs leg
    WHERE leg.run_id = NEW.run_id
      AND leg.transaction_id = NEW.disbursement_transaction_id
  ) <> 2
BEGIN
  SELECT RAISE(ABORT, 'seed loan ledger recognition is inconsistent');
END;
`;

const PHASE_5_CREDIT_READ_MODEL = `
DROP TRIGGER indicator_points_no_update;
DROP TRIGGER indicator_points_no_delete;
ALTER TABLE indicator_points RENAME TO indicator_points_before_credit;

CREATE TABLE indicator_points (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  indicator_key TEXT NOT NULL CHECK (indicator_key IN (
    'm1_cents', 'average_wage_cents', 'unemployment_rate_bp', 'treasury_balance_cents',
    'credit_outstanding_cents', 'default_rate_bp'
  )),
  value_integer TEXT NOT NULL,
  PRIMARY KEY (run_id, tick, indicator_key)
);

INSERT INTO indicator_points(run_id, tick, indicator_key, value_integer)
SELECT run_id, tick, indicator_key, value_integer
FROM indicator_points_before_credit
ORDER BY run_id, tick, indicator_key;

DROP TABLE indicator_points_before_credit;
CREATE INDEX indicator_points_series
  ON indicator_points(run_id, indicator_key, tick);
CREATE TRIGGER indicator_points_no_update BEFORE UPDATE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
CREATE TRIGGER indicator_points_no_delete BEFORE DELETE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
`;

const PHASE_6_LLM_RESPONSE_CACHE = `
CREATE TABLE llm_cache_events (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'llm.cache.hit', 'llm.cache.miss', 'llm.cache.stored',
    'llm.cache.corrupt', 'llm.cache.imported'
  )),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'system'),
  actor_id TEXT NOT NULL CHECK (actor_id = 'llm_gateway'),
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  payload_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, event_id)
);

CREATE INDEX llm_cache_events_type_seq
  ON llm_cache_events(run_id, type, seq);
CREATE INDEX llm_cache_events_correlation_seq
  ON llm_cache_events(run_id, correlation_id, seq);
CREATE TRIGGER llm_cache_events_no_update BEFORE UPDATE ON llm_cache_events
BEGIN SELECT RAISE(ABORT, 'LLM cache events are append-only'); END;
CREATE TRIGGER llm_cache_events_no_delete BEFORE DELETE ON llm_cache_events
BEGIN SELECT RAISE(ABORT, 'LLM cache events are append-only'); END;

CREATE TABLE llm_response_cache (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_pack_version INTEGER NOT NULL CHECK (prompt_pack_version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  response_canonical TEXT NOT NULL,
  response_model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 2),
  stored_tick INTEGER NOT NULL CHECK (stored_tick >= 0),
  origin_run_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, key_hash),
  UNIQUE (
    run_id, provider, model, prompt_pack_version, schema_version, request_hash
  ),
  FOREIGN KEY (run_id, source_event_id)
    REFERENCES llm_cache_events(run_id, event_id)
);

CREATE INDEX llm_response_cache_request
  ON llm_response_cache(run_id, request_hash);
CREATE TRIGGER llm_response_cache_no_update BEFORE UPDATE ON llm_response_cache
BEGIN SELECT RAISE(ABORT, 'LLM response cache is immutable'); END;
CREATE TRIGGER llm_response_cache_no_delete BEFORE DELETE ON llm_response_cache
BEGIN SELECT RAISE(ABORT, 'LLM response cache is immutable'); END;
`;

const PHASE_6_LLM_BUDGETS_CONTROLS = `
CREATE TABLE llm_runtime_budgets (
  run_id TEXT PRIMARY KEY REFERENCES simulation_runs(id),
  run_cost_ceiling_cents TEXT NOT NULL CHECK (
    run_cost_ceiling_cents <> '' AND
    run_cost_ceiling_cents NOT GLOB '*[^0-9]*' AND
    substr(run_cost_ceiling_cents, 1, 1) <> '0'
  ),
  per_agent_daily_tokens INTEGER NOT NULL CHECK (per_agent_daily_tokens > 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_microcents TEXT NOT NULL DEFAULT '0' CHECK (
    cost_microcents = '0' OR (
      cost_microcents NOT GLOB '*[^0-9]*' AND
      substr(cost_microcents, 1, 1) <> '0'
    )
  ),
  warning_emitted INTEGER NOT NULL DEFAULT 0 CHECK (warning_emitted IN (0, 1)),
  exhausted_emitted INTEGER NOT NULL DEFAULT 0 CHECK (exhausted_emitted IN (0, 1)),
  auto_paused INTEGER NOT NULL DEFAULT 0 CHECK (auto_paused IN (0, 1)),
  llm_enabled INTEGER NOT NULL CHECK (llm_enabled IN (0, 1)),
  updated_tick INTEGER NOT NULL CHECK (updated_tick >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  source_event_id TEXT NOT NULL,
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
);

CREATE TRIGGER llm_runtime_budget_policy_immutable
BEFORE UPDATE OF run_id, run_cost_ceiling_cents, per_agent_daily_tokens
ON llm_runtime_budgets
BEGIN SELECT RAISE(ABORT, 'LLM budget policy is immutable'); END;
CREATE TRIGGER llm_runtime_budget_monotonic
BEFORE UPDATE ON llm_runtime_budgets
WHEN NEW.input_tokens < OLD.input_tokens OR
     NEW.output_tokens < OLD.output_tokens OR
     length(NEW.cost_microcents) < length(OLD.cost_microcents) OR
     (length(NEW.cost_microcents) = length(OLD.cost_microcents) AND
      NEW.cost_microcents < OLD.cost_microcents) OR
     NEW.warning_emitted < OLD.warning_emitted OR
     NEW.exhausted_emitted < OLD.exhausted_emitted OR
     NEW.auto_paused < OLD.auto_paused OR
     NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'LLM budget state must advance monotonically'); END;
CREATE TRIGGER llm_runtime_budgets_no_delete BEFORE DELETE ON llm_runtime_budgets
BEGIN SELECT RAISE(ABORT, 'LLM budget state cannot be deleted'); END;

CREATE TABLE llm_agent_daily_usage (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  agent_id TEXT NOT NULL,
  day_tick INTEGER NOT NULL CHECK (day_tick >= 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  warning_emitted INTEGER NOT NULL CHECK (warning_emitted IN (0, 1)),
  exhausted_emitted INTEGER NOT NULL CHECK (exhausted_emitted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id, day_tick),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
);
CREATE TRIGGER llm_agent_daily_identity_immutable
BEFORE UPDATE OF run_id, agent_id, day_tick ON llm_agent_daily_usage
BEGIN SELECT RAISE(ABORT, 'LLM agent-day identity is immutable'); END;
CREATE TRIGGER llm_agent_daily_monotonic
BEFORE UPDATE ON llm_agent_daily_usage
WHEN NEW.input_tokens < OLD.input_tokens OR
     NEW.output_tokens < OLD.output_tokens OR
     NEW.warning_emitted < OLD.warning_emitted OR
     NEW.exhausted_emitted < OLD.exhausted_emitted OR
     NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'LLM agent-day usage must advance monotonically'); END;
CREATE TRIGGER llm_agent_daily_no_delete BEFORE DELETE ON llm_agent_daily_usage
BEGIN SELECT RAISE(ABORT, 'LLM agent-day usage cannot be deleted'); END;

CREATE TABLE llm_module_controls (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  module_id TEXT NOT NULL CHECK (module_id IN ('agent_decisions', 'conversations', 'news')),
  frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  updated_tick INTEGER NOT NULL CHECK (updated_tick >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, module_id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
);
CREATE TRIGGER llm_module_control_identity_immutable
BEFORE UPDATE OF run_id, module_id ON llm_module_controls
BEGIN SELECT RAISE(ABORT, 'LLM module control identity is immutable'); END;
CREATE TRIGGER llm_module_control_revision
BEFORE UPDATE ON llm_module_controls
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'LLM module control revision must advance by one'); END;
CREATE TRIGGER llm_module_controls_no_delete BEFORE DELETE ON llm_module_controls
BEGIN SELECT RAISE(ABORT, 'LLM module controls cannot be deleted'); END;

CREATE TABLE llm_control_history (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  command TEXT NOT NULL CHECK (command IN (
    'set_llm_enabled', 'set_module_frozen', 'set_agent_quarantine'
  )),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('run', 'module', 'agent')),
  target_id TEXT NOT NULL,
  previous_canonical TEXT NOT NULL,
  next_canonical TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  command_event_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, source_event_id),
  FOREIGN KEY (run_id, command_event_id) REFERENCES events(run_id, event_id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
);
CREATE TRIGGER llm_control_history_no_update BEFORE UPDATE ON llm_control_history
BEGIN SELECT RAISE(ABORT, 'LLM control history is immutable'); END;
CREATE TRIGGER llm_control_history_no_delete BEFORE DELETE ON llm_control_history
BEGIN SELECT RAISE(ABORT, 'LLM control history is immutable'); END;

INSERT INTO llm_runtime_budgets(
  run_id, run_cost_ceiling_cents, per_agent_daily_tokens, llm_enabled,
  updated_tick, source_event_id
)
SELECT
  r.id,
  CAST(json_extract(s.scenario_canonical, '$.budgets.runCostCentsMax') AS TEXT),
  CAST(json_extract(s.scenario_canonical, '$.budgets.perAgentDailyTokens') AS INTEGER),
  CASE json_extract(s.scenario_canonical, '$.llmMode') WHEN 'off' THEN 0 ELSE 1 END,
  r.current_tick,
  (
    SELECT e.event_id FROM events e
    WHERE e.run_id = r.id AND e.type = 'simulation.created'
    ORDER BY e.seq LIMIT 1
  )
FROM simulation_runs r
JOIN simulations s ON s.id = r.simulation_id
WHERE json_extract(s.scenario_canonical, '$.budgets.runCostCentsMax') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.run_id = r.id AND e.type = 'simulation.created'
  );

INSERT INTO llm_module_controls(
  run_id, module_id, frozen, updated_tick, revision, source_event_id
)
SELECT b.run_id, modules.module_id, 0, b.updated_tick, 0, b.source_event_id
FROM llm_runtime_budgets b
CROSS JOIN (
  SELECT 'agent_decisions' AS module_id
  UNION ALL SELECT 'conversations'
  UNION ALL SELECT 'news'
) modules;
`;

const PHASE_6_TIER2_LLM_CALL_RECORDS = `
ALTER TABLE loan_application_decisions ADD COLUMN agent_decision_id TEXT;
CREATE INDEX loan_application_decisions_agent_decision
  ON loan_application_decisions(run_id, agent_decision_id);

CREATE TABLE llm_call_records (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'llm_[0-9a-z]*' AND length(id) >= 12),
  decision_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  module_id TEXT NOT NULL CHECK (module_id IN ('agent_decisions', 'conversations', 'news')),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'fallback')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  record_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, decision_id),
  FOREIGN KEY (run_id, decision_id) REFERENCES decisions(run_id, id),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX llm_call_records_tick
  ON llm_call_records(run_id, tick, id);
CREATE INDEX llm_call_records_status
  ON llm_call_records(run_id, status, tick, id);
CREATE TRIGGER llm_call_records_no_update BEFORE UPDATE ON llm_call_records
BEGIN SELECT RAISE(ABORT, 'LLM call records are immutable'); END;
CREATE TRIGGER llm_call_records_no_delete BEFORE DELETE ON llm_call_records
BEGIN SELECT RAISE(ABORT, 'LLM call records are immutable'); END;
`;

const PHASE_6_BOUNDED_CONVERSATIONS = `
CREATE TABLE conversations (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'cnv_[0-9a-z]*' AND length(id) >= 12),
  participant_a_id TEXT NOT NULL,
  participant_b_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN ('purchase', 'job')),
  initiating_trigger_event_id TEXT NOT NULL,
  term_bounds_canonical TEXT NOT NULL,
  max_turns INTEGER NOT NULL CHECK (max_turns BETWEEN 1 AND 6),
  output_token_budget INTEGER NOT NULL CHECK (output_token_budget BETWEEN 1 AND 4096),
  output_tokens_used INTEGER NOT NULL DEFAULT 0
    CHECK (output_tokens_used BETWEEN 0 AND output_token_budget),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns BETWEEN 0 AND max_turns),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'concluded', 'expired', 'force_closed')),
  outcome_canonical TEXT,
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN (
    'agreement', 'declined', 'max_turns', 'token_budget', 'no_progress',
    'provider_fallback', 'invalid_proposal'
  )),
  start_tick INTEGER NOT NULL CHECK (start_tick >= 0),
  end_tick INTEGER CHECK (end_tick IS NULL OR end_tick >= start_tick),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  source_event_id TEXT NOT NULL,
  terminal_event_id TEXT,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, participant_a_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, participant_b_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, initiating_trigger_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (run_id, terminal_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (participant_a_id <> participant_b_id),
  CHECK (
    (status = 'active' AND outcome_canonical IS NULL AND close_reason IS NULL
      AND end_tick IS NULL AND terminal_event_id IS NULL) OR
    (status <> 'active' AND outcome_canonical IS NOT NULL AND close_reason IS NOT NULL
      AND end_tick IS NOT NULL AND terminal_event_id IS NOT NULL)
  )
);

CREATE INDEX conversations_active
  ON conversations(run_id, status, start_tick, id);
CREATE INDEX conversations_participant_a
  ON conversations(run_id, participant_a_id, start_tick DESC, id DESC);
CREATE INDEX conversations_participant_b
  ON conversations(run_id, participant_b_id, start_tick DESC, id DESC);

CREATE TABLE conversation_messages (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'msg_[0-9a-z]*' AND length(id) >= 12),
  conversation_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 6),
  action_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'counter', 'accept', 'decline', 'clarify')),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 2000),
  structured_terms_canonical TEXT,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  delivery_tick INTEGER NOT NULL CHECK (delivery_tick = tick + 1),
  decision_id TEXT NOT NULL,
  llm_call_id TEXT,
  output_tokens INTEGER NOT NULL CHECK (output_tokens BETWEEN 0 AND 4096),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, conversation_id, turn),
  UNIQUE (run_id, decision_id),
  UNIQUE (run_id, llm_call_id),
  FOREIGN KEY (run_id, conversation_id) REFERENCES conversations(run_id, id),
  FOREIGN KEY (run_id, sender_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, recipient_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES decisions(run_id, id),
  FOREIGN KEY (run_id, llm_call_id) REFERENCES llm_call_records(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (sender_agent_id <> recipient_agent_id),
  CHECK (
    (kind IN ('offer', 'counter', 'accept') AND structured_terms_canonical IS NOT NULL) OR
    (kind IN ('decline', 'clarify') AND structured_terms_canonical IS NULL)
  )
);

CREATE INDEX conversation_messages_conversation
  ON conversation_messages(run_id, conversation_id, turn);
CREATE INDEX conversation_messages_sender
  ON conversation_messages(run_id, sender_agent_id, tick, id);

CREATE TABLE conversation_inbox (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  delivery_tick INTEGER NOT NULL CHECK (delivery_tick >= 0),
  delivered_tick INTEGER CHECK (delivered_tick IS NULL OR delivered_tick >= delivery_tick),
  read_tick INTEGER CHECK (
    read_tick IS NULL OR (delivered_tick IS NOT NULL AND read_tick >= delivered_tick)
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, message_id, recipient_agent_id),
  FOREIGN KEY (run_id, conversation_id) REFERENCES conversations(run_id, id),
  FOREIGN KEY (run_id, message_id) REFERENCES conversation_messages(run_id, id),
  FOREIGN KEY (run_id, recipient_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX conversation_inbox_recipient
  ON conversation_inbox(run_id, recipient_agent_id, delivery_tick, message_id);

CREATE TABLE conversation_relationship_history (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'rch_[0-9a-z]*' AND length(id) >= 12),
  conversation_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  prior_strength INTEGER NOT NULL CHECK (prior_strength BETWEEN -100 AND 100),
  next_strength INTEGER NOT NULL CHECK (next_strength BETWEEN -100 AND 100),
  prior_interaction_tick INTEGER NOT NULL CHECK (prior_interaction_tick >= 0),
  next_interaction_tick INTEGER NOT NULL CHECK (next_interaction_tick >= prior_interaction_tick),
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, conversation_id, relationship_id),
  FOREIGN KEY (run_id, conversation_id) REFERENCES conversations(run_id, id),
  FOREIGN KEY (run_id, relationship_id) REFERENCES relationships(run_id, id),
  FOREIGN KEY (run_id, from_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, to_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (from_agent_id <> to_agent_id)
);

CREATE INDEX conversation_relationship_history_conversation
  ON conversation_relationship_history(run_id, conversation_id, id);

CREATE TRIGGER conversations_identity_immutable
BEFORE UPDATE OF run_id, id, participant_a_id, participant_b_id, topic,
  initiating_trigger_event_id, term_bounds_canonical, max_turns,
  output_token_budget, start_tick, source_event_id ON conversations
BEGIN SELECT RAISE(ABORT, 'conversation identity and limits are immutable'); END;
CREATE TRIGGER conversations_transition_valid
BEFORE UPDATE ON conversations
WHEN OLD.status <> 'active' OR NEW.revision <> OLD.revision + 1 OR
  NEW.turns < OLD.turns OR NEW.output_tokens_used < OLD.output_tokens_used
BEGIN SELECT RAISE(ABORT, 'invalid conversation transition'); END;
CREATE TRIGGER conversations_no_delete BEFORE DELETE ON conversations
BEGIN SELECT RAISE(ABORT, 'conversations cannot be deleted'); END;

CREATE TRIGGER conversation_messages_no_update BEFORE UPDATE ON conversation_messages
BEGIN SELECT RAISE(ABORT, 'conversation messages are immutable'); END;
CREATE TRIGGER conversation_messages_no_delete BEFORE DELETE ON conversation_messages
BEGIN SELECT RAISE(ABORT, 'conversation messages are immutable'); END;

CREATE TRIGGER conversation_inbox_identity_immutable
BEFORE UPDATE OF run_id, conversation_id, message_id, recipient_agent_id,
  delivery_tick, source_event_id ON conversation_inbox
BEGIN SELECT RAISE(ABORT, 'conversation inbox identity is immutable'); END;
CREATE TRIGGER conversation_inbox_transition_valid
BEFORE UPDATE ON conversation_inbox
WHEN NEW.revision <> OLD.revision + 1 OR
  (OLD.delivered_tick IS NOT NULL AND NEW.delivered_tick <> OLD.delivered_tick) OR
  (OLD.read_tick IS NOT NULL AND NEW.read_tick <> OLD.read_tick)
BEGIN SELECT RAISE(ABORT, 'invalid conversation inbox transition'); END;
CREATE TRIGGER conversation_inbox_no_delete BEFORE DELETE ON conversation_inbox
BEGIN SELECT RAISE(ABORT, 'conversation inbox rows cannot be deleted'); END;

CREATE TRIGGER conversation_relationship_history_no_update
BEFORE UPDATE ON conversation_relationship_history
BEGIN SELECT RAISE(ABORT, 'conversation relationship history is immutable'); END;
CREATE TRIGGER conversation_relationship_history_no_delete
BEFORE DELETE ON conversation_relationship_history
BEGIN SELECT RAISE(ABORT, 'conversation relationship history is immutable'); END;
`;

const PHASE_6_NEGOTIATION_BINDINGS = `
CREATE TABLE conversation_bindings (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'cnb_[0-9a-z]*' AND length(id) >= 12),
  conversation_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN ('purchase', 'job')),
  status TEXT NOT NULL CHECK (status IN ('bound', 'rejected')),
  structured_terms_canonical TEXT,
  domain_reference_id TEXT NOT NULL CHECK (length(trim(domain_reference_id)) BETWEEN 1 AND 160),
  result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('goods_order', 'employment')),
  result_id TEXT CHECK (result_id IS NULL OR length(trim(result_id)) BETWEEN 1 AND 160),
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR rejection_reason IN (
    'not_agreement', 'terms_mismatch', 'participant_mismatch',
    'inactive_offering', 'invalid_buyer', 'insufficient_funds',
    'stockout', 'price_changed', 'application_unavailable',
    'vacancy_unavailable', 'wage_out_of_bounds'
  )),
  binding_tick INTEGER NOT NULL CHECK (binding_tick >= 0),
  evidence_event_ids_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, conversation_id),
  FOREIGN KEY (run_id, conversation_id) REFERENCES conversations(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (status = 'bound' AND structured_terms_canonical IS NOT NULL
      AND result_kind IS NOT NULL AND result_id IS NOT NULL
      AND rejection_reason IS NULL
      AND ((topic = 'purchase' AND result_kind = 'goods_order')
        OR (topic = 'job' AND result_kind = 'employment'))) OR
    (status = 'rejected' AND result_kind IS NULL AND result_id IS NULL
      AND rejection_reason IS NOT NULL)
  )
);

CREATE INDEX conversation_bindings_tick
  ON conversation_bindings(run_id, binding_tick, id);
CREATE INDEX conversation_bindings_status
  ON conversation_bindings(run_id, status, topic, binding_tick, id);

CREATE TRIGGER conversation_bindings_no_update BEFORE UPDATE ON conversation_bindings
BEGIN SELECT RAISE(ABORT, 'conversation bindings are immutable'); END;
CREATE TRIGGER conversation_bindings_no_delete BEFORE DELETE ON conversation_bindings
BEGIN SELECT RAISE(ABORT, 'conversation bindings are immutable'); END;
`;

const PHASE_6_LLM_OBSERVABILITY = `
ALTER TABLE llm_call_records ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0
  CHECK (latency_ms >= 0);
ALTER TABLE llm_call_records ADD COLUMN cost_microcents TEXT NOT NULL DEFAULT '0'
  CHECK (
    cost_microcents <> ''
    AND cost_microcents NOT GLOB '*[^0-9]*'
    AND (cost_microcents = '0' OR substr(cost_microcents, 1, 1) <> '0')
  );
CREATE INDEX llm_call_records_observability
  ON llm_call_records(run_id, tick DESC, id DESC, status, provider, model);
`;

const PHASE_6_PROVIDER_CACHE_ACCOUNTING = `
ALTER TABLE llm_runtime_budgets
  ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (cached_input_tokens >= 0);
ALTER TABLE llm_agent_daily_usage
  ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (cached_input_tokens >= 0);

DROP TRIGGER IF EXISTS llm_runtime_budget_monotonic;
CREATE TRIGGER llm_runtime_budget_monotonic
BEFORE UPDATE ON llm_runtime_budgets
WHEN NEW.input_tokens < OLD.input_tokens OR
     NEW.cached_input_tokens < OLD.cached_input_tokens OR
     NEW.cached_input_tokens > NEW.input_tokens OR
     NEW.output_tokens < OLD.output_tokens OR
     length(NEW.cost_microcents) < length(OLD.cost_microcents) OR
     (length(NEW.cost_microcents) = length(OLD.cost_microcents) AND
      NEW.cost_microcents < OLD.cost_microcents) OR
     NEW.warning_emitted < OLD.warning_emitted OR
     NEW.exhausted_emitted < OLD.exhausted_emitted OR
     NEW.auto_paused < OLD.auto_paused OR
     NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'LLM budget state must advance monotonically'); END;

DROP TRIGGER IF EXISTS llm_agent_daily_monotonic;
CREATE TRIGGER llm_agent_daily_monotonic
BEFORE UPDATE ON llm_agent_daily_usage
WHEN NEW.input_tokens < OLD.input_tokens OR
     NEW.cached_input_tokens < OLD.cached_input_tokens OR
     NEW.cached_input_tokens > NEW.input_tokens OR
     NEW.output_tokens < OLD.output_tokens OR
     NEW.warning_emitted < OLD.warning_emitted OR
     NEW.exhausted_emitted < OLD.exhausted_emitted OR
     NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'LLM agent-day usage must advance monotonically'); END;
`;

const PHASE_7_NEWS_STORY_PIPELINE = `
CREATE TABLE news_organizations (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'norg_[0-9a-z_]*' AND length(id) BETWEEN 13 AND 69),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  editor_agent_id TEXT NOT NULL,
  journalist_agent_ids_canonical TEXT NOT NULL,
  daily_story_cap INTEGER NOT NULL CHECK (daily_story_cap BETWEEN 1 AND 3),
  stance_bias INTEGER NOT NULL CHECK (stance_bias BETWEEN -2 AND 2),
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  organization_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, editor_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE news_digests (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'ndg_[0-9a-z]*' AND length(id) = 12),
  source_tick INTEGER NOT NULL CHECK (source_tick >= 0),
  publication_tick INTEGER NOT NULL CHECK (publication_tick = source_tick + 1),
  scoring_version INTEGER NOT NULL CHECK (scoring_version >= 1),
  digest_hash TEXT NOT NULL CHECK (length(digest_hash) = 64),
  total_candidate_count INTEGER NOT NULL CHECK (total_candidate_count >= 0),
  selected_event_ids_canonical TEXT NOT NULL,
  digest_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, source_tick),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE news_stories (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'nws_[0-9a-z]*' AND length(id) = 12),
  org_id TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 1),
  source_tick INTEGER NOT NULL CHECK (tick = source_tick + 1),
  topic TEXT NOT NULL CHECK (topic IN ('economy', 'employment', 'institutions', 'market')),
  status TEXT NOT NULL CHECK (status IN ('published', 'spiked')),
  decision_id TEXT NOT NULL,
  llm_call_id TEXT,
  story_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, org_id, source_tick, topic),
  FOREIGN KEY (run_id, org_id) REFERENCES news_organizations(run_id, id),
  FOREIGN KEY (run_id, author_agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, decision_id) REFERENCES decisions(run_id, id),
  FOREIGN KEY (run_id, llm_call_id) REFERENCES llm_call_records(run_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE news_story_citations (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  story_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  source_tick INTEGER NOT NULL CHECK (source_tick >= 0),
  event_id TEXT NOT NULL,
  event_fact_hash TEXT NOT NULL CHECK (length(event_fact_hash) = 64),
  PRIMARY KEY (run_id, story_id, event_id),
  UNIQUE (run_id, org_id, source_tick, event_id),
  FOREIGN KEY (run_id, story_id) REFERENCES news_stories(run_id, id),
  FOREIGN KEY (run_id, org_id) REFERENCES news_organizations(run_id, id),
  FOREIGN KEY (run_id, event_id) REFERENCES events(run_id, event_id)
);

CREATE INDEX news_stories_tick
  ON news_stories(run_id, tick, status, id);
CREATE INDEX news_stories_author
  ON news_stories(run_id, author_agent_id, tick, id);
CREATE INDEX news_story_citations_event
  ON news_story_citations(run_id, event_id, story_id);

CREATE TRIGGER news_organizations_no_update BEFORE UPDATE ON news_organizations
BEGIN SELECT RAISE(ABORT, 'news organizations are immutable'); END;
CREATE TRIGGER news_organizations_no_delete BEFORE DELETE ON news_organizations
BEGIN SELECT RAISE(ABORT, 'news organizations cannot be deleted'); END;
CREATE TRIGGER news_digests_no_update BEFORE UPDATE ON news_digests
BEGIN SELECT RAISE(ABORT, 'news digests are immutable'); END;
CREATE TRIGGER news_digests_no_delete BEFORE DELETE ON news_digests
BEGIN SELECT RAISE(ABORT, 'news digests cannot be deleted'); END;
CREATE TRIGGER news_stories_no_update BEFORE UPDATE ON news_stories
BEGIN SELECT RAISE(ABORT, 'news stories are immutable'); END;
CREATE TRIGGER news_stories_no_delete BEFORE DELETE ON news_stories
BEGIN SELECT RAISE(ABORT, 'news stories cannot be deleted'); END;
CREATE TRIGGER news_story_citations_no_update BEFORE UPDATE ON news_story_citations
BEGIN SELECT RAISE(ABORT, 'news citations are immutable'); END;
CREATE TRIGGER news_story_citations_no_delete BEFORE DELETE ON news_story_citations
BEGIN SELECT RAISE(ABORT, 'news citations cannot be deleted'); END;
`;

const PHASE_7_SENTIMENT_ENGINE = `
CREATE TABLE sentiment_updates (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'snt_[0-9a-z]*' AND length(id) = 12),
  topic TEXT NOT NULL CHECK (topic IN ('economy', 'employment', 'institutions')),
  tick INTEGER NOT NULL CHECK (tick >= 1),
  previous_tick INTEGER CHECK (previous_tick IS NULL OR (previous_tick >= 1 AND previous_tick < tick)),
  previous_value INTEGER NOT NULL CHECK (previous_value BETWEEN -10000 AND 10000),
  decayed_value INTEGER NOT NULL CHECK (decayed_value BETWEEN -10000 AND 10000),
  story_delta INTEGER NOT NULL CHECK (story_delta BETWEEN -2500 AND 2500),
  value INTEGER NOT NULL CHECK (value BETWEEN -10000 AND 10000),
  contributing_story_ids_canonical TEXT NOT NULL,
  contribution_ids_canonical TEXT NOT NULL,
  update_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, topic, tick),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sentiment_story_contributions (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'sct_[0-9a-z]*' AND length(id) = 12),
  update_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  story_topic TEXT NOT NULL CHECK (story_topic IN ('economy', 'employment', 'institutions', 'market')),
  topic TEXT NOT NULL CHECK (topic IN ('economy', 'employment', 'institutions')),
  tick INTEGER NOT NULL CHECK (tick >= 1),
  stance INTEGER NOT NULL CHECK (stance BETWEEN -2 AND 2),
  reach INTEGER NOT NULL CHECK (reach BETWEEN 1 AND 100000),
  outcome_score INTEGER NOT NULL CHECK (outcome_score BETWEEN -1000 AND 1000),
  stance_delta INTEGER NOT NULL CHECK (stance_delta BETWEEN -1800 AND 1800),
  outcome_delta INTEGER NOT NULL CHECK (outcome_delta BETWEEN -200 AND 200),
  delta INTEGER NOT NULL CHECK (delta BETWEEN -2000 AND 2000),
  cited_event_ids_canonical TEXT NOT NULL,
  contribution_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, story_id),
  FOREIGN KEY (run_id, update_id) REFERENCES sentiment_updates(run_id, id),
  FOREIGN KEY (run_id, story_id) REFERENCES news_stories(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE agent_opinion_updates (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (id GLOB 'opu_[0-9a-z]*' AND length(id) = 12),
  agent_id TEXT NOT NULL,
  axis TEXT NOT NULL CHECK (axis IN (
    'redistribution', 'regulation', 'institutionalTrust', 'economicOptimism'
  )),
  tick INTEGER NOT NULL CHECK (tick >= 1),
  previous_value INTEGER NOT NULL CHECK (previous_value BETWEEN -100 AND 100),
  delta INTEGER NOT NULL CHECK (delta BETWEEN -5 AND 5 AND delta <> 0),
  value INTEGER NOT NULL CHECK (value BETWEEN -100 AND 100),
  cause_story_ids_canonical TEXT NOT NULL,
  cause_contribution_ids_canonical TEXT NOT NULL,
  source_sentiment_update_ids_canonical TEXT NOT NULL,
  update_canonical TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, agent_id, axis, tick),
  FOREIGN KEY (run_id, agent_id) REFERENCES agents(run_id, id),
  FOREIGN KEY (run_id, source_event_id) REFERENCES events(run_id, event_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE agent_opinion_causes (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  opinion_update_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  sentiment_update_id TEXT NOT NULL,
  PRIMARY KEY (run_id, opinion_update_id, contribution_id),
  FOREIGN KEY (run_id, opinion_update_id) REFERENCES agent_opinion_updates(run_id, id),
  FOREIGN KEY (run_id, story_id) REFERENCES news_stories(run_id, id),
  FOREIGN KEY (run_id, contribution_id) REFERENCES sentiment_story_contributions(run_id, id),
  FOREIGN KEY (run_id, sentiment_update_id) REFERENCES sentiment_updates(run_id, id)
);

CREATE INDEX sentiment_updates_topic_tick
  ON sentiment_updates(run_id, topic, tick DESC, id);
CREATE INDEX sentiment_contributions_tick
  ON sentiment_story_contributions(run_id, tick, topic, id);
CREATE INDEX agent_opinion_updates_agent_axis
  ON agent_opinion_updates(run_id, agent_id, axis, tick DESC, id);
CREATE INDEX agent_opinion_causes_story
  ON agent_opinion_causes(run_id, story_id, opinion_update_id);

CREATE TRIGGER sentiment_updates_no_update BEFORE UPDATE ON sentiment_updates
BEGIN SELECT RAISE(ABORT, 'sentiment updates are immutable'); END;
CREATE TRIGGER sentiment_updates_no_delete BEFORE DELETE ON sentiment_updates
BEGIN SELECT RAISE(ABORT, 'sentiment updates cannot be deleted'); END;
CREATE TRIGGER sentiment_story_contributions_no_update BEFORE UPDATE ON sentiment_story_contributions
BEGIN SELECT RAISE(ABORT, 'sentiment contributions are immutable'); END;
CREATE TRIGGER sentiment_story_contributions_no_delete BEFORE DELETE ON sentiment_story_contributions
BEGIN SELECT RAISE(ABORT, 'sentiment contributions cannot be deleted'); END;
CREATE TRIGGER agent_opinion_updates_no_update BEFORE UPDATE ON agent_opinion_updates
BEGIN SELECT RAISE(ABORT, 'opinion updates are immutable'); END;
CREATE TRIGGER agent_opinion_updates_no_delete BEFORE DELETE ON agent_opinion_updates
BEGIN SELECT RAISE(ABORT, 'opinion updates cannot be deleted'); END;
CREATE TRIGGER agent_opinion_causes_no_update BEFORE UPDATE ON agent_opinion_causes
BEGIN SELECT RAISE(ABORT, 'opinion causes are immutable'); END;
CREATE TRIGGER agent_opinion_causes_no_delete BEFORE DELETE ON agent_opinion_causes
BEGIN SELECT RAISE(ABORT, 'opinion causes cannot be deleted'); END;
`;

const PHASE_7_FULL_INDICATORS = `
DROP TRIGGER indicator_points_no_update;
DROP TRIGGER indicator_points_no_delete;
ALTER TABLE indicator_points RENAME TO indicator_points_before_full_set;

CREATE TABLE indicator_points (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  indicator_key TEXT NOT NULL CHECK (indicator_key IN (
    'gdp_proxy_cents', 'cpi_index', 'm1_cents', 'average_wage_cents',
    'unemployment_rate_bp', 'credit_outstanding_cents', 'default_rate_bp',
    'active_business_count', 'treasury_balance_cents', 'sentiment_index_bp'
  )),
  value_integer TEXT NOT NULL CHECK (
    (value_integer <> '' AND value_integer NOT GLOB '*[^0-9]*') OR
    (
      substr(value_integer, 1, 1) = '-' AND substr(value_integer, 2) <> '' AND
      substr(value_integer, 2) NOT GLOB '*[^0-9]*'
    )
  ),
  formula_version INTEGER NOT NULL CHECK (formula_version BETWEEN 0 AND 1),
  inputs_digest TEXT NOT NULL CHECK (
    length(inputs_digest) = 64 AND inputs_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (run_id, tick, indicator_key)
);

INSERT INTO indicator_points(
  run_id, tick, indicator_key, value_integer, formula_version, inputs_digest
)
SELECT
  run_id, tick, indicator_key, value_integer, 0,
  '0000000000000000000000000000000000000000000000000000000000000000'
FROM indicator_points_before_full_set
ORDER BY run_id, tick, indicator_key;

DROP TABLE indicator_points_before_full_set;
CREATE INDEX indicator_points_series
  ON indicator_points(run_id, indicator_key, tick);
CREATE TRIGGER indicator_points_no_update BEFORE UPDATE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
CREATE TRIGGER indicator_points_no_delete BEFORE DELETE ON indicator_points
BEGIN SELECT RAISE(ABORT, 'indicator history is immutable'); END;
`;

const PHASE_7_REPLAY_EXECUTOR = `
CREATE TABLE replay_runs (
  run_id TEXT PRIMARY KEY REFERENCES simulation_runs(id),
  source_simulation_id TEXT NOT NULL CHECK (
    source_simulation_id GLOB 'sim_[0-9a-z]*' AND length(source_simulation_id) = 12
  ),
  source_run_id TEXT NOT NULL CHECK (
    source_run_id GLOB 'run_[0-9a-z]*' AND length(source_run_id) = 12
  ),
  mode TEXT NOT NULL CHECK (mode IN ('strict', 'observe')),
  to_tick INTEGER NOT NULL CHECK (to_tick >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'diverged', 'failed')),
  current_tick INTEGER NOT NULL DEFAULT 0 CHECK (current_tick >= 0 AND current_tick <= to_tick),
  last_compared_seq INTEGER NOT NULL DEFAULT -1 CHECK (last_compared_seq >= -1),
  cache_artifact_digest TEXT NOT NULL CHECK (
    length(cache_artifact_digest) = 64 AND cache_artifact_digest NOT GLOB '*[^0-9a-f]*'
  ),
  journal_digest TEXT NOT NULL CHECK (
    length(journal_digest) = 64 AND journal_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_state_hash TEXT CHECK (
    source_state_hash IS NULL OR (
      length(source_state_hash) = 64 AND source_state_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  replay_state_hash TEXT CHECK (
    replay_state_hash IS NULL OR (
      length(replay_state_hash) = 64 AND replay_state_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  started_wall TEXT NOT NULL CHECK (length(trim(started_wall)) > 0),
  completed_wall TEXT,
  error_code TEXT,
  error_message TEXT,
  CHECK (
    (status = 'running' AND completed_wall IS NULL) OR
    (status <> 'running' AND completed_wall IS NOT NULL AND length(trim(completed_wall)) > 0)
  ),
  CHECK (
    (status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL
      AND length(trim(error_code)) > 0 AND length(trim(error_message)) > 0) OR
    (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)
  )
);

CREATE INDEX replay_runs_source
  ON replay_runs(source_simulation_id, source_run_id, started_wall, run_id);
CREATE INDEX replay_runs_status
  ON replay_runs(status, started_wall, run_id);
CREATE TRIGGER replay_runs_identity_immutable
BEFORE UPDATE OF source_simulation_id, source_run_id, mode, to_tick,
  cache_artifact_digest, journal_digest, started_wall ON replay_runs
BEGIN SELECT RAISE(ABORT, 'replay identity is immutable'); END;
CREATE TRIGGER replay_runs_status_transition
BEFORE UPDATE OF status ON replay_runs
WHEN OLD.status <> 'running' OR NEW.status NOT IN ('completed', 'diverged', 'failed')
BEGIN SELECT RAISE(ABORT, 'invalid replay status transition'); END;
CREATE TRIGGER replay_runs_no_delete BEFORE DELETE ON replay_runs
BEGIN SELECT RAISE(ABORT, 'replay records are immutable'); END;

CREATE TABLE replay_divergences (
  run_id TEXT NOT NULL REFERENCES replay_runs(run_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'cache_incomplete', 'event_mismatch', 'state_hash_mismatch',
    'unsupported_journal_command'
  )),
  expected_hash TEXT CHECK (
    expected_hash IS NULL OR (
      length(expected_hash) = 64 AND expected_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  actual_hash TEXT CHECK (
    actual_hash IS NULL OR (
      length(actual_hash) = 64 AND actual_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  details_canonical TEXT NOT NULL,
  created_wall TEXT NOT NULL CHECK (length(trim(created_wall)) > 0),
  PRIMARY KEY (run_id, sequence)
);
CREATE INDEX replay_divergences_tick
  ON replay_divergences(run_id, tick, sequence);
CREATE TRIGGER replay_divergences_no_update BEFORE UPDATE ON replay_divergences
BEGIN SELECT RAISE(ABORT, 'replay divergences are immutable'); END;
CREATE TRIGGER replay_divergences_no_delete BEFORE DELETE ON replay_divergences
BEGIN SELECT RAISE(ABORT, 'replay divergences are immutable'); END;

CREATE TABLE replay_llm_expectations (
  run_id TEXT NOT NULL REFERENCES replay_runs(run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  record_canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, ordinal)
);
CREATE INDEX replay_llm_expectations_request
  ON replay_llm_expectations(run_id, request_hash, ordinal);
CREATE TRIGGER replay_llm_expectations_no_update BEFORE UPDATE ON replay_llm_expectations
BEGIN SELECT RAISE(ABORT, 'replay LLM expectations are immutable'); END;
CREATE TRIGGER replay_llm_expectations_no_delete BEFORE DELETE ON replay_llm_expectations
BEGIN SELECT RAISE(ABORT, 'replay LLM expectations are immutable'); END;
`;

const PHASE_7_EXPORT_JOBS = `
CREATE TABLE export_jobs (
  id TEXT NOT NULL CHECK (
    substr(id, 1, 4) = 'xpt_' AND length(id) = 20 AND
    substr(id, 5) NOT GLOB '*[^0-9a-z]*'
  ),
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  simulation_id TEXT NOT NULL CHECK (
    simulation_id GLOB 'sim_[0-9a-z]*' AND length(simulation_id) = 12
  ),
  format TEXT NOT NULL CHECK (format IN ('jsonl', 'csv')),
  datasets_canonical TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  source_tick INTEGER NOT NULL CHECK (source_tick >= 0),
  source_state_hash TEXT NOT NULL CHECK (
    length(source_state_hash) = 64 AND source_state_hash NOT GLOB '*[^0-9a-f]*'
  ),
  disclaimer TEXT NOT NULL CHECK (length(trim(disclaimer)) > 0),
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  created_wall TEXT NOT NULL CHECK (length(trim(created_wall)) > 0),
  started_wall TEXT,
  completed_wall TEXT,
  error_code TEXT,
  error_message TEXT,
  manifest_path TEXT,
  manifest_bytes INTEGER CHECK (manifest_bytes IS NULL OR manifest_bytes > 0),
  manifest_sha256 TEXT CHECK (
    manifest_sha256 IS NULL OR (
      length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY (run_id, id),
  CHECK (
    (status = 'queued' AND started_wall IS NULL AND completed_wall IS NULL) OR
    (status = 'running' AND started_wall IS NOT NULL AND completed_wall IS NULL) OR
    (status IN ('completed', 'failed') AND completed_wall IS NOT NULL)
  ),
  CHECK (
    (status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL
      AND length(trim(error_code)) > 0 AND length(trim(error_message)) > 0) OR
    (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)
  ),
  CHECK (
    (status = 'completed' AND manifest_path IS NOT NULL AND manifest_bytes IS NOT NULL
      AND manifest_sha256 IS NOT NULL) OR
    (status <> 'completed' AND manifest_path IS NULL AND manifest_bytes IS NULL
      AND manifest_sha256 IS NULL)
  )
);

CREATE INDEX export_jobs_status
  ON export_jobs(status, created_wall, run_id, id);
CREATE INDEX export_jobs_simulation
  ON export_jobs(simulation_id, created_wall, run_id, id);
CREATE TRIGGER export_jobs_run_identity
BEFORE INSERT ON export_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM simulation_runs
  WHERE id = NEW.run_id AND simulation_id = NEW.simulation_id
    AND current_tick = NEW.source_tick
)
BEGIN SELECT RAISE(ABORT, 'export source does not match the run checkpoint'); END;
CREATE TRIGGER export_jobs_identity_immutable
BEFORE UPDATE OF id, run_id, simulation_id, format, datasets_canonical,
  source_tick, source_state_hash, disclaimer, correlation_id, created_wall
ON export_jobs
BEGIN SELECT RAISE(ABORT, 'export identity is immutable'); END;
CREATE TRIGGER export_jobs_status_transition
BEFORE UPDATE OF status ON export_jobs
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'failed')) OR
  (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid export status transition'); END;
CREATE TRIGGER export_jobs_no_delete BEFORE DELETE ON export_jobs
BEGIN SELECT RAISE(ABORT, 'export jobs are append-only'); END;

CREATE TABLE export_files (
  run_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset IN ('events', 'transactions', 'indicators')),
  format TEXT NOT NULL CHECK (format IN ('jsonl', 'csv')),
  relative_path TEXT NOT NULL CHECK (
    relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%\\%' AND
    relative_path NOT LIKE '%..%'
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (run_id, export_id, dataset),
  UNIQUE (run_id, export_id, relative_path),
  FOREIGN KEY (run_id, export_id) REFERENCES export_jobs(run_id, id)
);
CREATE TRIGGER export_files_parent_running
BEFORE INSERT ON export_files
WHEN NOT EXISTS (
  SELECT 1 FROM export_jobs
  WHERE run_id = NEW.run_id AND id = NEW.export_id
    AND status = 'running' AND format = NEW.format
)
BEGIN SELECT RAISE(ABORT, 'export files require a running matching job'); END;
CREATE TRIGGER export_files_no_update BEFORE UPDATE ON export_files
BEGIN SELECT RAISE(ABORT, 'export files are immutable'); END;
CREATE TRIGGER export_files_no_delete BEFORE DELETE ON export_files
BEGIN SELECT RAISE(ABORT, 'export files are immutable'); END;

CREATE TABLE export_events (
  run_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL CHECK (
    substr(event_id, 1, 4) = 'xev_' AND length(event_id) = 28 AND
    substr(event_id, 5) NOT GLOB '*[^0-9a-z]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (type IN (
    'export.job.queued', 'export.job.started',
    'export.job.completed', 'export.job.failed'
  )),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'admin')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  causation_id TEXT,
  evidence_canonical TEXT NOT NULL,
  wall_time TEXT NOT NULL CHECK (length(trim(wall_time)) > 0),
  PRIMARY KEY (run_id, export_id, sequence),
  UNIQUE (run_id, event_id),
  FOREIGN KEY (run_id, export_id) REFERENCES export_jobs(run_id, id)
);
CREATE INDEX export_events_type
  ON export_events(run_id, export_id, type, sequence);
CREATE TRIGGER export_events_no_update BEFORE UPDATE ON export_events
BEGIN SELECT RAISE(ABORT, 'export events are append-only'); END;
CREATE TRIGGER export_events_no_delete BEFORE DELETE ON export_events
BEGIN SELECT RAISE(ABORT, 'export events are append-only'); END;
`;

const PHASE_8_VENTURE_FUNDS = `
CREATE TABLE vc_firms (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  id TEXT NOT NULL CHECK (substr(id, 1, 5) = 'inst_' AND length(id) >= 8),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  source_event_id TEXT NOT NULL CHECK (
    substr(source_event_id, 1, 4) = 'evt_' AND length(source_event_id) >= 12
  ),
  PRIMARY KEY (run_id, id)
);
CREATE TRIGGER vc_firms_identity_immutable
BEFORE UPDATE OF run_id, id, name, created_tick, source_event_id ON vc_firms
BEGIN SELECT RAISE(ABORT, 'venture firm identity is immutable'); END;
CREATE TRIGGER vc_firms_no_delete BEFORE DELETE ON vc_firms
BEGIN SELECT RAISE(ABORT, 'venture firms cannot be deleted'); END;

CREATE TABLE vc_funds (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (substr(id, 1, 6) = 'vfund_' AND length(id) >= 14),
  firm_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  fund_size_cents TEXT NOT NULL CHECK (
    fund_size_cents GLOB '[1-9]*' AND fund_size_cents NOT GLOB '*[^0-9]*' AND
    (length(fund_size_cents) < 19 OR
      (length(fund_size_cents) = 19 AND fund_size_cents <= '9223372036854775807'))
  ),
  deployed_cents TEXT NOT NULL CHECK (
    deployed_cents = '0' OR (
      deployed_cents GLOB '[1-9]*' AND deployed_cents NOT GLOB '*[^0-9]*' AND
      (length(deployed_cents) < 19 OR
        (length(deployed_cents) = 19 AND deployed_cents <= '9223372036854775807'))
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'fully_deployed', 'closed')),
  created_tick INTEGER NOT NULL CHECK (created_tick >= 0),
  source_event_id TEXT NOT NULL CHECK (
    substr(source_event_id, 1, 4) = 'evt_' AND length(source_event_id) >= 12
  ),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, firm_id, name),
  FOREIGN KEY (run_id, firm_id) REFERENCES vc_firms(run_id, id),
  CHECK (CAST(deployed_cents AS INTEGER) <= CAST(fund_size_cents AS INTEGER)),
  CHECK (
    (status = 'open' AND CAST(deployed_cents AS INTEGER) < CAST(fund_size_cents AS INTEGER)) OR
    (status = 'fully_deployed' AND deployed_cents = fund_size_cents) OR
    status = 'closed'
  )
);
CREATE INDEX vc_funds_firm_status ON vc_funds(run_id, firm_id, status, id);
CREATE TRIGGER vc_funds_identity_immutable
BEFORE UPDATE OF run_id, id, firm_id, name, fund_size_cents, created_tick, source_event_id
ON vc_funds
BEGIN SELECT RAISE(ABORT, 'venture fund identity is immutable'); END;
CREATE TRIGGER vc_funds_deployed_monotonic
BEFORE UPDATE OF deployed_cents ON vc_funds
WHEN CAST(NEW.deployed_cents AS INTEGER) < CAST(OLD.deployed_cents AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'venture fund deployed capital is monotonic'); END;
CREATE TRIGGER vc_funds_deployment_chain_guard
BEFORE UPDATE OF deployed_cents ON vc_funds
WHEN NEW.deployed_cents <> OLD.deployed_cents AND NOT EXISTS (
  SELECT 1 FROM vc_fund_deployments d
  WHERE d.run_id = OLD.run_id AND d.fund_id = OLD.id
    AND d.deployed_before_cents = OLD.deployed_cents
    AND d.deployed_after_cents = NEW.deployed_cents
)
BEGIN SELECT RAISE(ABORT, 'venture fund totals require an immutable deployment'); END;
CREATE TRIGGER vc_funds_no_delete BEFORE DELETE ON vc_funds
BEGIN SELECT RAISE(ABORT, 'venture funds cannot be deleted'); END;

CREATE TABLE vc_fund_deployments (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (substr(id, 1, 5) = 'vdep_' AND length(id) >= 13),
  fund_id TEXT NOT NULL,
  target_company_id TEXT NOT NULL CHECK (
    (substr(target_company_id, 1, 3) = 'co_' AND length(target_company_id) >= 11) OR
    (substr(target_company_id, 1, 4) = 'biz_' AND length(target_company_id) >= 7)
  ),
  reference_id TEXT NOT NULL CHECK (length(trim(reference_id)) BETWEEN 1 AND 160),
  amount_cents TEXT NOT NULL CHECK (
    amount_cents GLOB '[1-9]*' AND amount_cents NOT GLOB '*[^0-9]*' AND
    (length(amount_cents) < 19 OR
      (length(amount_cents) = 19 AND amount_cents <= '9223372036854775807'))
  ),
  deployed_before_cents TEXT NOT NULL CHECK (
    deployed_before_cents = '0' OR (
      deployed_before_cents GLOB '[1-9]*' AND
      deployed_before_cents NOT GLOB '*[^0-9]*'
    )
  ),
  deployed_after_cents TEXT NOT NULL CHECK (
    deployed_after_cents GLOB '[1-9]*' AND
    deployed_after_cents NOT GLOB '*[^0-9]*'
  ),
  deployed_tick INTEGER NOT NULL CHECK (deployed_tick >= 0),
  source_event_id TEXT NOT NULL CHECK (
    substr(source_event_id, 1, 4) = 'evt_' AND length(source_event_id) >= 12
  ),
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, fund_id, reference_id),
  FOREIGN KEY (run_id, fund_id) REFERENCES vc_funds(run_id, id),
  CHECK (
    CAST(deployed_before_cents AS INTEGER) + CAST(amount_cents AS INTEGER) =
    CAST(deployed_after_cents AS INTEGER)
  )
);
CREATE INDEX vc_fund_deployments_fund
  ON vc_fund_deployments(run_id, fund_id, deployed_tick, id);
CREATE TRIGGER vc_fund_deployments_validate_parent
BEFORE INSERT ON vc_fund_deployments
WHEN NOT EXISTS (
  SELECT 1 FROM vc_funds f
  WHERE f.run_id = NEW.run_id AND f.id = NEW.fund_id
    AND f.status = 'open'
    AND f.deployed_cents = NEW.deployed_before_cents
    AND CAST(NEW.deployed_after_cents AS INTEGER) <= CAST(f.fund_size_cents AS INTEGER)
)
BEGIN SELECT RAISE(ABORT, 'venture deployment exceeds available fund capital'); END;
CREATE TRIGGER vc_fund_deployments_validate_company
BEFORE INSERT ON vc_fund_deployments
WHEN NOT EXISTS (
  SELECT 1 FROM opening_company_equity o
  WHERE o.run_id = NEW.run_id AND o.company_id = NEW.target_company_id
) AND NOT EXISTS (
  SELECT 1 FROM companies c
  WHERE c.run_id = NEW.run_id AND c.id = NEW.target_company_id
)
BEGIN SELECT RAISE(ABORT, 'venture deployment target company does not exist'); END;
CREATE TRIGGER vc_fund_deployments_apply_total
AFTER INSERT ON vc_fund_deployments
BEGIN
  UPDATE vc_funds
  SET deployed_cents = NEW.deployed_after_cents,
    status = CASE
      WHEN NEW.deployed_after_cents = fund_size_cents THEN 'fully_deployed'
      ELSE 'open'
    END
  WHERE run_id = NEW.run_id AND id = NEW.fund_id;
END;
CREATE TRIGGER vc_fund_deployments_no_update BEFORE UPDATE ON vc_fund_deployments
BEGIN SELECT RAISE(ABORT, 'venture fund deployments are immutable'); END;
CREATE TRIGGER vc_fund_deployments_no_delete BEFORE DELETE ON vc_fund_deployments
BEGIN SELECT RAISE(ABORT, 'venture fund deployments are immutable'); END;
`;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial_phase_1_schema", sql: INITIAL_SCHEMA },
  { version: 2, name: "immutable_snapshots", sql: IMMUTABLE_SNAPSHOTS },
  { version: 3, name: "durable_api_tasks", sql: API_TASKS },
  { version: 4, name: "phase_2_agent_framework", sql: PHASE_2_AGENT_FRAMEWORK },
  { version: 5, name: "phase_3_authoritative_finance", sql: PHASE_3_AUTHORITATIVE_FINANCE },
  { version: 6, name: "phase_4_legal_companies_labor", sql: PHASE_4_LEGAL_COMPANIES_LABOR },
  {
    version: 7,
    name: "phase_4_production_inventory_market",
    sql: PHASE_4_PRODUCTION_INVENTORY_MARKET,
  },
  { version: 8, name: "phase_4_market_pricing", sql: PHASE_4_MARKET_PRICING },
  {
    version: 9,
    name: "phase_4_energy_tariffs_billing",
    sql: PHASE_4_ENERGY_TARIFFS_BILLING,
  },
  {
    version: 10,
    name: "phase_4_insolvency_wind_down",
    sql: PHASE_4_INSOLVENCY_WIND_DOWN,
  },
  {
    version: 11,
    name: "phase_4_world_event_injection",
    sql: PHASE_4_WORLD_EVENT_INJECTION,
  },
  {
    version: 12,
    name: "phase_5_credit_scoring",
    sql: PHASE_5_CREDIT_SCORING,
  },
  {
    version: 13,
    name: "phase_5_application_workflow",
    sql: PHASE_5_APPLICATION_WORKFLOW,
  },
  {
    version: 14,
    name: "phase_5_loan_disbursement",
    sql: PHASE_5_LOAN_DISBURSEMENT,
  },
  {
    version: 15,
    name: "phase_5_loan_collections",
    sql: PHASE_5_LOAN_COLLECTIONS,
  },
  {
    version: 16,
    name: "phase_5_bank_circuit_breakers",
    sql: PHASE_5_BANK_CIRCUIT_BREAKERS,
  },
  {
    version: 17,
    name: "phase_5_seeded_credit_state",
    sql: PHASE_5_SEEDED_CREDIT_STATE,
  },
  {
    version: 18,
    name: "phase_5_credit_read_model",
    sql: PHASE_5_CREDIT_READ_MODEL,
  },
  {
    version: 19,
    name: "phase_6_llm_response_cache",
    sql: PHASE_6_LLM_RESPONSE_CACHE,
  },
  {
    version: 20,
    name: "phase_6_llm_budgets_controls",
    sql: PHASE_6_LLM_BUDGETS_CONTROLS,
  },
  {
    version: 21,
    name: "phase_6_tier2_llm_call_records",
    sql: PHASE_6_TIER2_LLM_CALL_RECORDS,
  },
  {
    version: 22,
    name: "phase_6_bounded_conversations",
    sql: PHASE_6_BOUNDED_CONVERSATIONS,
  },
  {
    version: 23,
    name: "phase_6_negotiation_bindings",
    sql: PHASE_6_NEGOTIATION_BINDINGS,
  },
  {
    version: 24,
    name: "phase_6_llm_observability",
    sql: PHASE_6_LLM_OBSERVABILITY,
  },
  {
    version: 25,
    name: "phase_6_provider_cache_accounting",
    sql: PHASE_6_PROVIDER_CACHE_ACCOUNTING,
  },
  {
    version: 26,
    name: "phase_7_news_story_pipeline",
    sql: PHASE_7_NEWS_STORY_PIPELINE,
  },
  {
    version: 27,
    name: "phase_7_sentiment_engine",
    sql: PHASE_7_SENTIMENT_ENGINE,
  },
  {
    version: 28,
    name: "phase_7_full_indicators",
    sql: PHASE_7_FULL_INDICATORS,
  },
  {
    version: 29,
    name: "phase_7_replay_executor",
    sql: PHASE_7_REPLAY_EXECUTOR,
  },
  {
    version: 30,
    name: "phase_7_export_jobs",
    sql: PHASE_7_EXPORT_JOBS,
  },
  {
    version: 31,
    name: "phase_8_venture_funds",
    sql: PHASE_8_VENTURE_FUNDS,
  },
];

interface AppliedMigrationRow {
  version: bigint;
  name: string;
  checksum: string;
}

export function toSafeNumber(value: bigint, field: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new EngineError("INTERNAL", `${field} is outside the safe integer range`, {
      field,
      value: value.toString(),
    });
  }
  return numberValue;
}

export function worldDatabasePath(
  dataDir: string,
  simulationId: string,
  runId: string,
): string {
  const parsedSimulationId = simulationIdSchema.safeParse(simulationId);
  const parsedRunId = runIdSchema.safeParse(runId);
  if (!parsedSimulationId.success || !parsedRunId.success) {
    throw new EngineError("VALIDATION_FAILED", "invalid simulation or run ID for data path");
  }

  const root = resolve(dataDir);
  const path = resolve(join(root, simulationId, runId, "world.db"));
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new EngineError("VALIDATION_FAILED", "world database path escapes the data directory");
  }
  return path;
}

export function runMigrations(db: WorldDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);

  const applied = db
    .prepare<[], AppliedMigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all();
  for (const row of applied) {
    const version = toSafeNumber(row.version, "migration version");
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) {
      throw new EngineError("CONFLICT", `database has unknown migration version ${version}`);
    }
    const checksum = sha256Hex(migration.sql);
    if (row.name !== migration.name || row.checksum !== checksum) {
      throw new EngineError("CONFLICT", `migration ${version} checksum does not match`);
    }
  }

  const appliedVersions = new Set(applied.map((row) => toSafeNumber(row.version, "version")));
  const insert = db.prepare(
    "INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, sha256Hex(migration.sql));
    }).immediate();
  }
}

export function openDatabaseFile(filePath: string): WorldDatabase {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.defaultSafeIntegers(true);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = FULL");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openWorldDatabase(
  dataDir: string,
  simulationId: string,
  runId: string,
): WorldDatabase {
  return openDatabaseFile(worldDatabasePath(dataDir, simulationId, runId));
}
