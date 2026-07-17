/** SQLite M08 daily solvency assessments and atomic company liquidation. */

import {
  CREDITOR_SENIORITY,
  INSOLVENCY_OBLIGATION_HORIZON_TICKS,
  INSOLVENCY_RULESET_VERSION,
  allocateCreditorWaterfall,
  assessCompanySolvency,
  inventorySalvageTotal,
  inventorySalvageUnitPrice,
  payrollGrossForPeriod,
} from "@worldtangle/engine";
import type { TickContext } from "@worldtangle/engine";
import {
  canonicalParse,
  canonicalStringify,
  companyCreditorClaimSchema,
  companyCreditorRecoverySchema,
  companyCreditorWriteOffSchema,
  companyInventorySalvageSchema,
  companySolvencyAssessmentSchema,
  companyWindDownSchema,
  EngineError,
  ledgerTransactionSchema,
  money,
} from "@worldtangle/shared";
import type {
  CompanyClaimOriginKind,
  CompanyCreditorClaim,
  CompanyCreditorKind,
  CompanyCreditorRecovery,
  CompanyCreditorWriteOff,
  CompanyInventorySalvage,
  CompanySolvencyAssessment,
  CompanyWindDown,
  LedgerTransaction,
  Money,
  ProductSku,
} from "@worldtangle/shared";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { SqlitePhase4Store } from "./phase4-store";

interface AssessmentRow {
  id: string;
  company_id: string;
  tick: bigint;
  cash_cents: string;
  obligation_cents: string;
  shortfall_cents: string;
  consecutive_shortfall_days: bigint;
  insolvent: bigint;
  ruleset_version: bigint;
  source_event_id: string;
}

interface ClaimRow {
  id: string;
  company_id: string;
  creditor_kind: CompanyCreditorKind;
  creditor_id: string;
  creditor_account_id: string;
  seniority: bigint;
  amount_cents: string;
  origin_kind: CompanyClaimOriginKind;
  origin_id: string;
  registered_tick: bigint;
  source_event_id: string;
}

interface RecoveryRow {
  id: string;
  company_id: string;
  claim_id: string;
  tick: bigint;
  amount_cents: string;
  transaction_id: string;
  source_event_id: string;
}

interface WriteOffRow {
  id: string;
  company_id: string;
  claim_id: string;
  tick: bigint;
  amount_cents: string;
  source_event_id: string;
}

interface SalvageRow {
  id: string;
  company_id: string;
  inventory_id: string;
  sku: ProductSku;
  tick: bigint;
  quantity: bigint;
  unit_price_cents: string;
  total_cents: string;
  transaction_id: string;
  source_event_id: string;
}

interface WindDownRow {
  id: string;
  company_id: string;
  started_tick: bigint;
  completed_tick: bigint;
  opening_cash_cents: string;
  salvage_proceeds_cents: string;
  liquidation_pool_cents: string;
  creditor_recoveries_cents: string;
  written_off_cents: string;
  employees_terminated: bigint;
  contracts_terminated: bigint;
  jobs_withdrawn: bigint;
  offerings_deactivated: bigint;
  accounts_closed_canonical: string;
  cause_chain_canonical: string;
  source_event_id: string;
}

interface CompanyRow {
  id: string;
  founder_agent_id: string;
  status: "forming" | "registered" | "active" | "insolvent" | "winding_down" | "closed";
  business_account_id: string | null;
}

interface AccountRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  balance_cents: string;
  floor_cents: string;
  status: "active" | "frozen" | "closed";
}

interface EmploymentObligationRow {
  id: string;
  employee_agent_id: string;
  annual_wage_cents: string;
  creditor_account_id: string;
}

interface EnergyObligationRow {
  id: string;
  amount_cents: string;
  utility_id: string;
  utility_account_id: string;
}

interface LegalObligationRow {
  id: string;
  contract_id: string;
  params_canonical: string;
}

interface InventoryRow {
  id: string;
  sku: ProductSku;
  quantity: bigint;
  row_reference_price_cents: string;
}

interface OfferingRow {
  id: string;
  sku: ProductSku;
}

interface AutomaticClaim {
  readonly creditorKind: CompanyCreditorKind;
  readonly creditorId: string;
  readonly creditorAccountId: string;
  readonly amountCents: string;
  readonly originKind: CompanyClaimOriginKind;
  readonly originId: string;
}

interface ObligationSnapshot {
  readonly totalCents: Money;
  readonly automaticClaims: readonly AutomaticClaim[];
}

export interface RegisterCompanyCreditorClaimInput {
  readonly companyId: string;
  readonly creditorKind: Exclude<CompanyCreditorKind, "equity_residual">;
  readonly creditorId: string;
  readonly creditorAccountId: string;
  readonly amountCents: string;
  readonly originKind: Exclude<CompanyClaimOriginKind, "equity_residual">;
  readonly originId: string;
}

interface InsertCompanyCreditorClaimInput {
  readonly companyId: string;
  readonly creditorKind: CompanyCreditorKind;
  readonly creditorId: string;
  readonly creditorAccountId: string;
  readonly seniority: number;
  readonly amountCents: string;
  readonly originKind: CompanyClaimOriginKind;
  readonly originId: string;
}

export interface SqliteInsolvencyStoreOptions {
  /** Test seam after liquidation postings and before account closure. */
  readonly beforeAccountClose?: (companyId: string) => void;
}

function parseStringArray(value: string, field: string): readonly string[] {
  const parsed = canonicalParse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new EngineError("INTERNAL", `${field} is not a canonical string array`);
  }
  return Object.freeze([...parsed]);
}

function mapAssessment(runId: string, row: AssessmentRow): CompanySolvencyAssessment {
  return companySolvencyAssessmentSchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    tick: toSafeNumber(row.tick, "solvency tick"),
    cashCents: row.cash_cents,
    obligationCents: row.obligation_cents,
    shortfallCents: row.shortfall_cents,
    consecutiveShortfallDays: toSafeNumber(
      row.consecutive_shortfall_days,
      "solvency shortfall days",
    ),
    insolvent: row.insolvent === 1n,
    rulesetVersion: toSafeNumber(row.ruleset_version, "solvency ruleset version"),
    sourceEventId: row.source_event_id,
  });
}

function mapClaim(runId: string, row: ClaimRow): CompanyCreditorClaim {
  return companyCreditorClaimSchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    creditorKind: row.creditor_kind,
    creditorId: row.creditor_id,
    creditorAccountId: row.creditor_account_id,
    seniority: toSafeNumber(row.seniority, "creditor seniority"),
    amountCents: row.amount_cents,
    originKind: row.origin_kind,
    originId: row.origin_id,
    registeredTick: toSafeNumber(row.registered_tick, "claim registered tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapRecovery(runId: string, row: RecoveryRow): CompanyCreditorRecovery {
  return companyCreditorRecoverySchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    claimId: row.claim_id,
    tick: toSafeNumber(row.tick, "creditor recovery tick"),
    amountCents: row.amount_cents,
    transactionId: row.transaction_id,
    sourceEventId: row.source_event_id,
  });
}

function mapWriteOff(runId: string, row: WriteOffRow): CompanyCreditorWriteOff {
  return companyCreditorWriteOffSchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    claimId: row.claim_id,
    tick: toSafeNumber(row.tick, "creditor write-off tick"),
    amountCents: row.amount_cents,
    sourceEventId: row.source_event_id,
  });
}

function mapSalvage(runId: string, row: SalvageRow): CompanyInventorySalvage {
  return companyInventorySalvageSchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    inventoryId: row.inventory_id,
    sku: row.sku,
    tick: toSafeNumber(row.tick, "inventory salvage tick"),
    quantity: toSafeNumber(row.quantity, "inventory salvage quantity"),
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    transactionId: row.transaction_id,
    sourceEventId: row.source_event_id,
  });
}

function mapWindDown(runId: string, row: WindDownRow): CompanyWindDown {
  return companyWindDownSchema.parse({
    id: row.id,
    runId,
    companyId: row.company_id,
    startedTick: toSafeNumber(row.started_tick, "wind-down start tick"),
    completedTick: toSafeNumber(row.completed_tick, "wind-down completion tick"),
    openingCashCents: row.opening_cash_cents,
    salvageProceedsCents: row.salvage_proceeds_cents,
    liquidationPoolCents: row.liquidation_pool_cents,
    creditorRecoveriesCents: row.creditor_recoveries_cents,
    writtenOffCents: row.written_off_cents,
    employeesTerminated: toSafeNumber(row.employees_terminated, "employees terminated"),
    contractsTerminated: toSafeNumber(row.contracts_terminated, "contracts terminated"),
    jobsWithdrawn: toSafeNumber(row.jobs_withdrawn, "jobs withdrawn"),
    offeringsDeactivated: toSafeNumber(
      row.offerings_deactivated,
      "offerings deactivated",
    ),
    accountsClosed: parseStringArray(row.accounts_closed_canonical, "closed accounts"),
    causeChain: parseStringArray(row.cause_chain_canonical, "wind-down cause chain"),
    sourceEventId: row.source_event_id,
  });
}

function emitTransactionPosted(
  ctx: TickContext,
  transaction: LedgerTransaction,
  duplicate: boolean,
): ReturnType<TickContext["emit"]> {
  ctx.count("transactions");
  return ctx.emit("transaction.posted", {
    transactionId: transaction.id,
    kind: transaction.kind,
    legs: transaction.legs,
    reason: transaction.reason,
    sourceEventId: transaction.sourceEventId,
    duplicate,
  }, {
    correlationId: transaction.correlationId,
    causationId: transaction.sourceEventId ?? undefined,
  });
}

export class SqliteInsolvencyStore {
  private readonly finance: SqliteFinanceStore;
  private readonly phase4: SqlitePhase4Store;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
    private readonly options: SqliteInsolvencyStoreOptions = {},
  ) {
    this.finance = new SqliteFinanceStore(db, runId);
    this.phase4 = new SqlitePhase4Store(db, runId);
  }

  listAssessments(companyId?: string): readonly CompanySolvencyAssessment[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], AssessmentRow>(`
          SELECT * FROM company_solvency_assessments
          WHERE run_id = ? ORDER BY tick, company_id, id
        `).all(this.runId)
      : this.db.prepare<[string, string], AssessmentRow>(`
          SELECT * FROM company_solvency_assessments
          WHERE run_id = ? AND company_id = ? ORDER BY tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => mapAssessment(this.runId, row)));
  }

  listClaims(companyId?: string): readonly CompanyCreditorClaim[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], ClaimRow>(`
          SELECT * FROM company_creditor_claims
          WHERE run_id = ? ORDER BY company_id, seniority, registered_tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], ClaimRow>(`
          SELECT * FROM company_creditor_claims
          WHERE run_id = ? AND company_id = ? ORDER BY seniority, registered_tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => mapClaim(this.runId, row)));
  }

  listRecoveries(companyId?: string): readonly CompanyCreditorRecovery[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], RecoveryRow>(`
          SELECT * FROM company_creditor_recoveries
          WHERE run_id = ? ORDER BY company_id, tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], RecoveryRow>(`
          SELECT * FROM company_creditor_recoveries
          WHERE run_id = ? AND company_id = ? ORDER BY tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => mapRecovery(this.runId, row)));
  }

  listWriteOffs(companyId?: string): readonly CompanyCreditorWriteOff[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], WriteOffRow>(`
          SELECT * FROM company_creditor_write_offs
          WHERE run_id = ? ORDER BY company_id, tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], WriteOffRow>(`
          SELECT * FROM company_creditor_write_offs
          WHERE run_id = ? AND company_id = ? ORDER BY tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => mapWriteOff(this.runId, row)));
  }

  listSalvages(companyId?: string): readonly CompanyInventorySalvage[] {
    const rows = companyId === undefined
      ? this.db.prepare<[string], SalvageRow>(`
          SELECT * FROM company_inventory_salvages
          WHERE run_id = ? ORDER BY company_id, tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], SalvageRow>(`
          SELECT * FROM company_inventory_salvages
          WHERE run_id = ? AND company_id = ? ORDER BY tick, id
        `).all(this.runId, companyId);
    return Object.freeze(rows.map((row) => mapSalvage(this.runId, row)));
  }

  listWindDowns(): readonly CompanyWindDown[] {
    return Object.freeze(this.db.prepare<[string], WindDownRow>(`
      SELECT * FROM company_wind_downs WHERE run_id = ? ORDER BY completed_tick, id
    `).all(this.runId).map((row) => mapWindDown(this.runId, row)));
  }

  getWindDown(companyId: string): CompanyWindDown | null {
    const row = this.db.prepare<[string, string], WindDownRow>(`
      SELECT * FROM company_wind_downs WHERE run_id = ? AND company_id = ?
    `).get(this.runId, companyId);
    return row === undefined ? null : mapWindDown(this.runId, row);
  }

  registerClaim(
    input: RegisterCompanyCreditorClaimInput,
    ctx: TickContext,
    causationId?: string,
  ): CompanyCreditorClaim {
    const company = this.company(input.companyId);
    if (!["active", "insolvent", "winding_down"].includes(company.status)) {
      throw new EngineError("CONFLICT", `company ${company.id} cannot accept creditor claims`);
    }
    return this.insertClaim({
      ...input,
      seniority: CREDITOR_SENIORITY[input.creditorKind],
    }, ctx, causationId);
  }

  assessAll(ctx: TickContext): readonly CompanySolvencyAssessment[] {
    return this.db.transaction(() => {
      const companies = this.db.prepare<[string], { id: string }>(`
        SELECT id FROM companies WHERE run_id = ? AND status = 'active' ORDER BY id
      `).all(this.runId);
      return Object.freeze(companies.map((company) => this.assessCompany(company.id, ctx)));
    })();
  }

  assessCompany(companyId: string, ctx: TickContext): CompanySolvencyAssessment {
    const existing = this.db.prepare<[string, string, number], AssessmentRow>(`
      SELECT * FROM company_solvency_assessments
      WHERE run_id = ? AND company_id = ? AND tick = ?
    `).get(this.runId, companyId, ctx.tick);
    if (existing !== undefined) return mapAssessment(this.runId, existing);
    const company = this.company(companyId);
    if (company.status !== "active") {
      throw new EngineError("CONFLICT", `company ${companyId} is not active`);
    }
    const cashCents = this.companyCash(companyId);
    const obligations = this.obligationSnapshot(companyId, ctx.tick);
    const prior = this.db.prepare<[string, string], AssessmentRow>(`
      SELECT * FROM company_solvency_assessments
      WHERE run_id = ? AND company_id = ?
      ORDER BY tick DESC, id DESC LIMIT 1
    `).get(this.runId, companyId);
    const result = assessCompanySolvency({
      cashCents,
      obligationCents: obligations.totalCents,
      priorConsecutiveShortfallDays: prior === undefined
        ? 0
        : toSafeNumber(prior.consecutive_shortfall_days, "prior shortfall streak"),
    });
    const assessmentId = ctx.ids.next("solv");
    const correlationId = `company-solvency:${companyId}:${ctx.tick}`;
    const event = ctx.emit("company.solvency.assessed", {
      assessmentId,
      companyId,
      tick: ctx.tick,
      cashCents: result.cashCents.toString(),
      obligationCents: result.obligationCents.toString(),
      shortfallCents: result.shortfallCents.toString(),
      consecutiveShortfallDays: result.consecutiveShortfallDays,
      insolvent: result.insolvent,
      rulesetVersion: INSOLVENCY_RULESET_VERSION,
    }, { correlationId });
    const assessment = companySolvencyAssessmentSchema.parse({
      id: assessmentId,
      runId: this.runId,
      companyId,
      tick: ctx.tick,
      cashCents: result.cashCents.toString(),
      obligationCents: result.obligationCents.toString(),
      shortfallCents: result.shortfallCents.toString(),
      consecutiveShortfallDays: result.consecutiveShortfallDays,
      insolvent: result.insolvent,
      rulesetVersion: INSOLVENCY_RULESET_VERSION,
      sourceEventId: event.eventId,
    });
    this.db.prepare(`
      INSERT INTO company_solvency_assessments(
        run_id, id, company_id, tick, cash_cents, obligation_cents,
        shortfall_cents, consecutive_shortfall_days, insolvent,
        ruleset_version, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessment.runId,
      assessment.id,
      assessment.companyId,
      assessment.tick,
      assessment.cashCents,
      assessment.obligationCents,
      assessment.shortfallCents,
      assessment.consecutiveShortfallDays,
      assessment.insolvent ? 1 : 0,
      assessment.rulesetVersion,
      assessment.sourceEventId,
    );
    if (assessment.insolvent) {
      this.windDown(company, obligations, ctx, event.eventId);
    }
    return assessment;
  }

  private company(companyId: string): CompanyRow {
    const row = this.db.prepare<[string, string], CompanyRow>(`
      SELECT id, founder_agent_id, status, business_account_id
      FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, companyId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `company ${companyId} does not exist`);
    return row;
  }

  private companyAccounts(companyId: string): readonly AccountRow[] {
    return this.db.prepare<[string, string], AccountRow>(`
      SELECT id, owner_kind, owner_id, balance_cents, floor_cents, status
      FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company' AND owner_id = ? AND status = 'active'
      ORDER BY id
    `).all(this.runId, companyId);
  }

  private companyCash(companyId: string): Money {
    return money(this.companyAccounts(companyId).reduce((sum, account) => {
      const balance = BigInt(account.balance_cents);
      if (balance < 0n) {
        throw new EngineError("INTERNAL", `company account ${account.id} is negative`);
      }
      return sum + balance;
    }, 0n));
  }

  private obligationSnapshot(companyId: string, tick: number): ObligationSnapshot {
    const claims = this.listClaims(companyId);
    const recoveries = new Map(this.listRecoveries(companyId).map((row) => [row.claimId, row]));
    const writeOffs = new Map(this.listWriteOffs(companyId).map((row) => [row.claimId, row]));
    const origins = new Set(claims.map((claim) => `${claim.originKind}:${claim.originId}`));
    let total = claims.reduce((sum, claim) => {
      const resolved = BigInt(recoveries.get(claim.id)?.amountCents ?? "0") +
        BigInt(writeOffs.get(claim.id)?.amountCents ?? "0");
      return sum + BigInt(claim.amountCents) - resolved;
    }, 0n);
    const automaticClaims: AutomaticClaim[] = [];
    const payrollPeriodIndex = Math.floor(tick / 15) % 24;
    const employments = this.db.prepare<[string, string], EmploymentObligationRow>(`
      SELECT e.id, e.employee_agent_id, e.annual_wage_cents,
        a.id AS creditor_account_id
      FROM employment_contracts e
      JOIN bank_accounts a
        ON a.run_id = e.run_id AND a.owner_kind = 'agent'
        AND a.owner_id = e.employee_agent_id AND a.account_type = 'checking'
        AND a.status = 'active'
      WHERE e.run_id = ? AND e.employer_id = ? AND e.status = 'active'
      ORDER BY e.employee_agent_id, e.id
    `).all(this.runId, companyId);
    for (const employment of employments) {
      if (origins.has(`employment:${employment.id}`)) continue;
      const amount = payrollGrossForPeriod(money(employment.annual_wage_cents), payrollPeriodIndex);
      total += amount;
      automaticClaims.push({
        creditorKind: "employee_wage",
        creditorId: employment.employee_agent_id,
        creditorAccountId: employment.creditor_account_id,
        amountCents: amount.toString(),
        originKind: "employment",
        originId: employment.id,
      });
    }
    const energyBills = this.db.prepare<[string, string], EnergyObligationRow>(`
      SELECT b.id, b.amount_cents, s.utility_id, s.utility_account_id
      FROM energy_bills b
      JOIN energy_systems s ON s.run_id = b.run_id
      WHERE b.run_id = ? AND b.customer_class = 'business'
        AND b.customer_id = ? AND b.status = 'rejected'
      ORDER BY b.tick, b.id
    `).all(this.runId, companyId);
    for (const bill of energyBills) {
      if (origins.has(`energy_bill:${bill.id}`)) continue;
      total += BigInt(bill.amount_cents);
      automaticClaims.push({
        creditorKind: "trade",
        creditorId: bill.utility_id,
        creditorAccountId: bill.utility_account_id,
        amountCents: bill.amount_cents,
        originKind: "energy_bill",
        originId: bill.id,
      });
    }
    const legalObligations = this.db.prepare<[string, string, number], LegalObligationRow>(`
      SELECT DISTINCT o.id, o.contract_id, o.params_canonical
      FROM legal_obligations o
      JOIN legal_contracts c
        ON c.run_id = o.run_id AND c.id = o.contract_id AND c.status = 'active'
      JOIN legal_contract_parties p
        ON p.run_id = c.run_id AND p.contract_id = c.id
      WHERE o.run_id = ? AND p.party_kind = 'company' AND p.party_id = ?
        AND o.obligation_kind = 'payment' AND o.status IN ('pending', 'fired')
        AND o.due_tick <= ?
      ORDER BY o.id
    `).all(this.runId, companyId, tick + INSOLVENCY_OBLIGATION_HORIZON_TICKS);
    for (const obligation of legalObligations) {
      if (origins.has(`legal_obligation:${obligation.id}`)) continue;
      const params = canonicalParse(obligation.params_canonical);
      const amountValue = typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)["amountCents"]
        : undefined;
      if (typeof amountValue !== "string" || !/^[1-9]\d*$/.test(amountValue)) continue;
      const counterparty = this.contractCounterparty(obligation.contract_id, companyId);
      total += BigInt(amountValue);
      automaticClaims.push({
        creditorKind: "trade",
        creditorId: counterparty.id,
        creditorAccountId: counterparty.accountId,
        amountCents: amountValue,
        originKind: "legal_obligation",
        originId: obligation.id,
      });
    }
    return Object.freeze({ totalCents: money(total), automaticClaims: Object.freeze(automaticClaims) });
  }

  private contractCounterparty(
    contractId: string,
    companyId: string,
  ): { readonly id: string; readonly accountId: string } {
    const party = this.db.prepare<[string, string, string], { party_id: string }>(`
      SELECT party_id FROM legal_contract_parties
      WHERE run_id = ? AND contract_id = ?
        AND NOT (party_kind = 'company' AND party_id = ?)
      ORDER BY party_index LIMIT 1
    `).get(this.runId, contractId, companyId);
    const fallback = this.finance.systemAccount("system_row", "row_riverbend");
    if (party === undefined) return { id: "row_riverbend", accountId: fallback.id };
    const account = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM bank_accounts
      WHERE run_id = ? AND owner_id = ? AND account_type = 'checking' AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(this.runId, party.party_id);
    return { id: party.party_id, accountId: account?.id ?? fallback.id };
  }

  private insertClaim(
    input: InsertCompanyCreditorClaimInput,
    ctx: TickContext,
    causationId?: string,
  ): CompanyCreditorClaim {
    const existing = this.db.prepare<[string, string, string, string], ClaimRow>(`
      SELECT * FROM company_creditor_claims
      WHERE run_id = ? AND company_id = ? AND origin_kind = ? AND origin_id = ?
    `).get(this.runId, input.companyId, input.originKind, input.originId);
    if (existing !== undefined) {
      const claim = mapClaim(this.runId, existing);
      if (claim.creditorKind !== input.creditorKind ||
        claim.creditorId !== input.creditorId ||
        claim.creditorAccountId !== input.creditorAccountId ||
        claim.amountCents !== input.amountCents ||
        claim.seniority !== input.seniority) {
        throw new EngineError("CONFLICT", `creditor claim origin ${input.originId} changed`);
      }
      return claim;
    }
    const account = this.db.prepare<[string, string], AccountRow>(`
      SELECT id, owner_kind, owner_id, balance_cents, floor_cents, status
      FROM bank_accounts WHERE run_id = ? AND id = ?
    `).get(this.runId, input.creditorAccountId);
    if (account === undefined || account.status !== "active") {
      throw new EngineError("VALIDATION_FAILED", "creditor account must be active");
    }
    if (account.owner_kind === "company" && account.owner_id === input.companyId) {
      throw new EngineError("VALIDATION_FAILED", "a company cannot be its own creditor");
    }
    const claimId = ctx.ids.next("clm");
    const correlationId = `company-claim:${input.companyId}:${input.originKind}:${input.originId}`;
    const event = ctx.emit("company.creditor_claim.registered", {
      claimId,
      companyId: input.companyId,
      creditorKind: input.creditorKind,
      creditorId: input.creditorId,
      creditorAccountId: input.creditorAccountId,
      seniority: input.seniority,
      amountCents: input.amountCents,
      originKind: input.originKind,
      originId: input.originId,
    }, { correlationId, causationId });
    const claim = companyCreditorClaimSchema.parse({
      id: claimId,
      runId: this.runId,
      companyId: input.companyId,
      creditorKind: input.creditorKind,
      creditorId: input.creditorId,
      creditorAccountId: input.creditorAccountId,
      seniority: input.seniority,
      amountCents: input.amountCents,
      originKind: input.originKind,
      originId: input.originId,
      registeredTick: ctx.tick,
      sourceEventId: event.eventId,
    });
    this.db.prepare(`
      INSERT INTO company_creditor_claims(
        run_id, id, company_id, creditor_kind, creditor_id, creditor_account_id,
        seniority, amount_cents, origin_kind, origin_id, registered_tick, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.runId,
      claim.id,
      claim.companyId,
      claim.creditorKind,
      claim.creditorId,
      claim.creditorAccountId,
      claim.seniority,
      claim.amountCents,
      claim.originKind,
      claim.originId,
      claim.registeredTick,
      claim.sourceEventId,
    );
    return claim;
  }

  private appendCompanyTimeline(
    ctx: TickContext,
    companyId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.db.prepare(`
      INSERT INTO company_timeline(run_id, id, company_id, tick, event_type, payload_canonical)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      ctx.ids.next("ctl"),
      companyId,
      ctx.tick,
      eventType,
      canonicalStringify(payload),
    );
  }

  private windDown(
    company: CompanyRow,
    obligations: ObligationSnapshot,
    ctx: TickContext,
    assessmentEventId: string,
  ): CompanyWindDown {
    if (this.getWindDown(company.id) !== null) {
      throw new EngineError("CONFLICT", `company ${company.id} is already wound down`);
    }
    const windDownId = ctx.ids.next("wnd");
    const correlationId = `company-wind-down:${company.id}`;
    const causeChain: string[] = [assessmentEventId];
    this.db.prepare(`
      UPDATE companies SET status = 'insolvent', failure_reason = 'sustained_cash_shortfall'
      WHERE run_id = ? AND id = ? AND status = 'active'
    `).run(this.runId, company.id);
    const insolvencyEvent = ctx.emit("company.insolvency.detected", {
      companyId: company.id,
      assessmentEventId,
      thresholdDays: 30,
      reason: "sustained_cash_shortfall",
    }, { correlationId, causationId: assessmentEventId });
    causeChain.push(insolvencyEvent.eventId);
    this.appendCompanyTimeline(ctx, company.id, "company.insolvency.detected", {
      assessmentEventId,
      reason: "sustained_cash_shortfall",
    });
    this.db.prepare(`
      UPDATE companies SET status = 'winding_down'
      WHERE run_id = ? AND id = ? AND status = 'insolvent'
    `).run(this.runId, company.id);
    const startedEvent = ctx.emit("company.wind_down.started", {
      windDownId,
      companyId: company.id,
      causeEventId: insolvencyEvent.eventId,
    }, { correlationId, causationId: insolvencyEvent.eventId });
    causeChain.push(startedEvent.eventId);
    this.appendCompanyTimeline(ctx, company.id, "company.wind_down.started", {
      windDownId,
      causeEventId: insolvencyEvent.eventId,
    });
    const openingCash = this.companyCash(company.id);
    const relationships = this.phase4.terminateCompanyRelationshipsForFailure(
      company.id,
      ctx,
      startedEvent.eventId,
    );
    causeChain.push(...relationships.eventIds);
    for (const automatic of obligations.automaticClaims) {
      const claim = this.insertClaim({
        ...automatic,
        companyId: company.id,
        seniority: CREDITOR_SENIORITY[automatic.creditorKind],
      }, ctx, causeChain.at(-1));
      causeChain.push(claim.sourceEventId);
    }
    const offerings = this.deactivateOfferings(company.id, ctx, causeChain.at(-1));
    causeChain.push(...offerings.eventIds);
    const salvage = this.salvageInventory(
      company,
      ctx,
      causeChain.at(-1) ?? startedEvent.eventId,
    );
    causeChain.push(...salvage.eventIds);
    const pool = money(openingCash + salvage.totalCents);
    const claims = [...this.listClaims(company.id)];
    const claimTotal = claims.reduce((sum, claim) => sum + BigInt(claim.amountCents), 0n);
    if (pool > claimTotal) {
      const founderAccount = this.finance.accountForAgent(company.founder_agent_id);
      const residual = this.insertClaim({
        companyId: company.id,
        creditorKind: "equity_residual",
        creditorId: company.founder_agent_id,
        creditorAccountId: founderAccount.id,
        seniority: CREDITOR_SENIORITY.equity_residual,
        amountCents: (pool - claimTotal).toString(),
        originKind: "equity_residual",
        originId: windDownId,
      }, ctx, causeChain.at(-1));
      claims.push(residual);
      causeChain.push(residual.sourceEventId);
    }
    const allocations = allocateCreditorWaterfall(pool, claims.map((claim) => ({
      id: claim.id,
      seniority: claim.seniority,
      registeredTick: claim.registeredTick,
      amountCents: money(claim.amountCents),
    })));
    const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
    const recoveryPayloads: {
      claimId: string;
      creditorId: string;
      creditorKind: CompanyCreditorKind;
      amountCents: string;
    }[] = [];
    let recoveredTotal = 0n;
    let writtenOffTotal = 0n;
    for (const allocation of allocations) {
      const claim = claimsById.get(allocation.claimId)!;
      if (allocation.recoveredCents > 0n) {
        const recovery = this.payRecovery(
          company.id,
          claim,
          allocation.recoveredCents,
          ctx,
          causeChain.at(-1) ?? startedEvent.eventId,
        );
        recoveredTotal += BigInt(recovery.amountCents);
        recoveryPayloads.push({
          claimId: claim.id,
          creditorId: claim.creditorId,
          creditorKind: claim.creditorKind,
          amountCents: recovery.amountCents,
        });
        causeChain.push(recovery.sourceEventId);
      }
      if (allocation.writtenOffCents > 0n) {
        const writeOff = this.writeOffClaim(
          company.id,
          claim,
          allocation.writtenOffCents,
          ctx,
          causeChain.at(-1) ?? startedEvent.eventId,
        );
        writtenOffTotal += BigInt(writeOff.amountCents);
        causeChain.push(writeOff.sourceEventId);
      }
    }
    this.options.beforeAccountClose?.(company.id);
    const accountsClosed = this.closeCompanyAccounts(
      company.id,
      ctx,
      causeChain.at(-1) ?? startedEvent.eventId,
    );
    causeChain.push(...accountsClosed.eventIds);
    this.db.prepare(`
      UPDATE companies SET status = 'closed', failure_reason = 'sustained_cash_shortfall'
      WHERE run_id = ? AND id = ? AND status = 'winding_down'
    `).run(this.runId, company.id);
    const finalEvent = ctx.emit("company.failed", {
      windDownId,
      companyId: company.id,
      causeChain: [...causeChain],
      creditorRecoveries: recoveryPayloads,
      liquidationProceedsCents: pool.toString(),
      salvageProceedsCents: salvage.totalCents.toString(),
      writtenOffCents: writtenOffTotal.toString(),
      employeesTerminated: relationships.employeesTerminated,
      contractsTerminated: relationships.contractsTerminated,
      jobsWithdrawn: relationships.jobsWithdrawn,
      offeringsDeactivated: offerings.count,
      accountsClosed: accountsClosed.accountIds,
    }, { correlationId, causationId: causeChain.at(-1) ?? startedEvent.eventId });
    const result = companyWindDownSchema.parse({
      id: windDownId,
      runId: this.runId,
      companyId: company.id,
      startedTick: ctx.tick,
      completedTick: ctx.tick,
      openingCashCents: openingCash.toString(),
      salvageProceedsCents: salvage.totalCents.toString(),
      liquidationPoolCents: pool.toString(),
      creditorRecoveriesCents: recoveredTotal.toString(),
      writtenOffCents: writtenOffTotal.toString(),
      employeesTerminated: relationships.employeesTerminated,
      contractsTerminated: relationships.contractsTerminated,
      jobsWithdrawn: relationships.jobsWithdrawn,
      offeringsDeactivated: offerings.count,
      accountsClosed: accountsClosed.accountIds,
      causeChain,
      sourceEventId: finalEvent.eventId,
    });
    this.db.prepare(`
      INSERT INTO company_wind_downs(
        run_id, id, company_id, started_tick, completed_tick, opening_cash_cents,
        salvage_proceeds_cents, liquidation_pool_cents, creditor_recoveries_cents,
        written_off_cents, employees_terminated, contracts_terminated,
        jobs_withdrawn, offerings_deactivated, accounts_closed_canonical,
        cause_chain_canonical, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.runId,
      result.id,
      result.companyId,
      result.startedTick,
      result.completedTick,
      result.openingCashCents,
      result.salvageProceedsCents,
      result.liquidationPoolCents,
      result.creditorRecoveriesCents,
      result.writtenOffCents,
      result.employeesTerminated,
      result.contractsTerminated,
      result.jobsWithdrawn,
      result.offeringsDeactivated,
      canonicalStringify(result.accountsClosed),
      canonicalStringify(result.causeChain),
      result.sourceEventId,
    );
    this.appendCompanyTimeline(ctx, company.id, "company.failed", {
      windDownId,
      sourceEventId: finalEvent.eventId,
    });
    this.assertWindDownPostconditions(company.id);
    return result;
  }

  private deactivateOfferings(
    companyId: string,
    ctx: TickContext,
    causationId?: string,
  ): { readonly count: number; readonly eventIds: readonly string[] } {
    const offerings = this.db.prepare<[string, string], OfferingRow>(`
      SELECT id, sku FROM market_offerings
      WHERE run_id = ? AND company_id = ? AND active = 1 ORDER BY id
    `).all(this.runId, companyId);
    const eventIds: string[] = [];
    for (const offering of offerings) {
      this.db.prepare(`
        UPDATE market_offerings SET active = 0
        WHERE run_id = ? AND id = ? AND active = 1
      `).run(this.runId, offering.id);
      const event = ctx.emit("market.offering.deactivated", {
        offeringId: offering.id,
        companyId,
        sku: offering.sku,
        reason: "company_failure",
      }, { correlationId: `company-wind-down:${companyId}`, causationId });
      eventIds.push(event.eventId);
    }
    return Object.freeze({ count: offerings.length, eventIds: Object.freeze(eventIds) });
  }

  private salvageInventory(
    company: CompanyRow,
    ctx: TickContext,
    causationId: string,
  ): { readonly totalCents: Money; readonly eventIds: readonly string[] } {
    if (company.business_account_id === null) {
      throw new EngineError("INTERNAL", "winding company has no business account");
    }
    const inventories = this.db.prepare<[string, string], InventoryRow>(`
      SELECT i.id, i.sku, i.quantity, p.row_reference_price_cents
      FROM company_inventory i
      JOIN market_products p ON p.sku = i.sku
      WHERE i.run_id = ? AND i.company_id = ? AND i.quantity > 0
      ORDER BY i.sku, i.id
    `).all(this.runId, company.id);
    const rowAccount = this.finance.systemAccount("system_row", "row_riverbend");
    const eventIds: string[] = [];
    let total = 0n;
    for (const inventory of inventories) {
      const quantity = toSafeNumber(inventory.quantity, "salvage inventory quantity");
      const unitPrice = inventorySalvageUnitPrice(money(inventory.row_reference_price_cents));
      const amount = inventorySalvageTotal(unitPrice, quantity);
      const salvageId = ctx.ids.next("slv");
      const correlationId = `company-salvage:${company.id}:${inventory.id}`;
      const requestEvent = ctx.emit("company.inventory.salvage.requested", {
        salvageId,
        companyId: company.id,
        inventoryId: inventory.id,
        sku: inventory.sku,
        quantity,
        unitPriceCents: unitPrice.toString(),
        totalCents: amount.toString(),
      }, { correlationId, causationId });
      const transaction = ledgerTransactionSchema.parse({
        id: ctx.ids.next("txn"),
        runId: this.runId,
        tick: ctx.tick,
        kind: "row_settlement",
        actor: { kind: "system", id: "M08-insolvency" },
        reason: "company.inventory_salvage_to_row",
        sourceEventId: requestEvent.eventId,
        correlationId,
        idempotencyKey: correlationId,
        legs: [
          { accountId: company.business_account_id, direction: "debit", amountCents: amount.toString() },
          { accountId: rowAccount.id, direction: "credit", amountCents: amount.toString() },
        ],
      });
      const posted = this.finance.post(transaction);
      const postedEvent = emitTransactionPosted(ctx, posted.transaction, posted.duplicate);
      const event = ctx.emit("company.inventory.salvaged", {
        salvageId,
        companyId: company.id,
        inventoryId: inventory.id,
        sku: inventory.sku,
        quantity,
        unitPriceCents: unitPrice.toString(),
        totalCents: amount.toString(),
        transactionId: posted.transaction.id,
      }, { correlationId, causationId: postedEvent.eventId });
      const salvage = companyInventorySalvageSchema.parse({
        id: salvageId,
        runId: this.runId,
        companyId: company.id,
        inventoryId: inventory.id,
        sku: inventory.sku,
        tick: ctx.tick,
        quantity,
        unitPriceCents: unitPrice.toString(),
        totalCents: amount.toString(),
        transactionId: posted.transaction.id,
        sourceEventId: event.eventId,
      });
      this.db.prepare(`
        UPDATE company_inventory SET quantity = 0, updated_tick = ?
        WHERE run_id = ? AND id = ? AND quantity = ?
      `).run(ctx.tick, this.runId, inventory.id, inventory.quantity);
      this.db.prepare(`
        INSERT INTO company_inventory_salvages(
          run_id, id, company_id, inventory_id, sku, tick, quantity,
          unit_price_cents, total_cents, transaction_id, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        salvage.runId,
        salvage.id,
        salvage.companyId,
        salvage.inventoryId,
        salvage.sku,
        salvage.tick,
        salvage.quantity,
        salvage.unitPriceCents,
        salvage.totalCents,
        salvage.transactionId,
        salvage.sourceEventId,
      );
      total += amount;
      eventIds.push(requestEvent.eventId, postedEvent.eventId, event.eventId);
    }
    return Object.freeze({ totalCents: money(total), eventIds: Object.freeze(eventIds) });
  }

  private payRecovery(
    companyId: string,
    claim: CompanyCreditorClaim,
    amountCents: Money,
    ctx: TickContext,
    causationId: string,
  ): CompanyCreditorRecovery {
    const sourceAccounts = this.companyAccounts(companyId);
    let remaining = amountCents;
    const creditLegs: { accountId: string; direction: "credit"; amountCents: string }[] = [];
    for (const account of sourceAccounts) {
      if (remaining === 0n) break;
      const balance = BigInt(account.balance_cents);
      const part = balance > remaining ? remaining : balance;
      if (part <= 0n) continue;
      creditLegs.push({ accountId: account.id, direction: "credit", amountCents: part.toString() });
      remaining = money(remaining - part);
    }
    if (remaining !== 0n) {
      throw new EngineError("INTERNAL", "waterfall recovery exceeds company cash");
    }
    const recoveryId = ctx.ids.next("rcv");
    const correlationId = `company-recovery:${companyId}:${claim.id}`;
    const requestEvent = ctx.emit("company.creditor_recovery.requested", {
      recoveryId,
      companyId,
      claimId: claim.id,
      creditorId: claim.creditorId,
      creditorKind: claim.creditorKind,
      amountCents: amountCents.toString(),
    }, { correlationId, causationId });
    const transaction = ledgerTransactionSchema.parse({
      id: ctx.ids.next("txn"),
      runId: this.runId,
      tick: ctx.tick,
      kind: "transfer",
      actor: { kind: "system", id: "M08-insolvency" },
      reason: "company.creditor_waterfall_recovery",
      sourceEventId: requestEvent.eventId,
      correlationId,
      idempotencyKey: correlationId,
      legs: [
        { accountId: claim.creditorAccountId, direction: "debit", amountCents: amountCents.toString() },
        ...creditLegs,
      ],
    });
    const posted = this.finance.post(transaction);
    const postedEvent = emitTransactionPosted(ctx, posted.transaction, posted.duplicate);
    const event = ctx.emit("company.creditor.recovered", {
      recoveryId,
      companyId,
      claimId: claim.id,
      creditorId: claim.creditorId,
      creditorKind: claim.creditorKind,
      seniority: claim.seniority,
      amountCents: amountCents.toString(),
      transactionId: posted.transaction.id,
    }, { correlationId, causationId: postedEvent.eventId });
    const recovery = companyCreditorRecoverySchema.parse({
      id: recoveryId,
      runId: this.runId,
      companyId,
      claimId: claim.id,
      tick: ctx.tick,
      amountCents: amountCents.toString(),
      transactionId: posted.transaction.id,
      sourceEventId: event.eventId,
    });
    this.db.prepare(`
      INSERT INTO company_creditor_recoveries(
        run_id, id, company_id, claim_id, tick, amount_cents,
        transaction_id, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recovery.runId,
      recovery.id,
      recovery.companyId,
      recovery.claimId,
      recovery.tick,
      recovery.amountCents,
      recovery.transactionId,
      recovery.sourceEventId,
    );
    return recovery;
  }

  private writeOffClaim(
    companyId: string,
    claim: CompanyCreditorClaim,
    amountCents: Money,
    ctx: TickContext,
    causationId: string,
  ): CompanyCreditorWriteOff {
    const writeOffId = ctx.ids.next("wof");
    const event = ctx.emit("company.creditor.written_off", {
      writeOffId,
      companyId,
      claimId: claim.id,
      creditorId: claim.creditorId,
      creditorKind: claim.creditorKind,
      seniority: claim.seniority,
      amountCents: amountCents.toString(),
    }, {
      correlationId: `company-write-off:${companyId}:${claim.id}`,
      causationId,
    });
    const writeOff = companyCreditorWriteOffSchema.parse({
      id: writeOffId,
      runId: this.runId,
      companyId,
      claimId: claim.id,
      tick: ctx.tick,
      amountCents: amountCents.toString(),
      sourceEventId: event.eventId,
    });
    this.db.prepare(`
      INSERT INTO company_creditor_write_offs(
        run_id, id, company_id, claim_id, tick, amount_cents, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      writeOff.runId,
      writeOff.id,
      writeOff.companyId,
      writeOff.claimId,
      writeOff.tick,
      writeOff.amountCents,
      writeOff.sourceEventId,
    );
    return writeOff;
  }

  private closeCompanyAccounts(
    companyId: string,
    ctx: TickContext,
    causationId: string,
  ): { readonly accountIds: readonly string[]; readonly eventIds: readonly string[] } {
    const accounts = this.companyAccounts(companyId);
    const eventIds: string[] = [];
    for (const account of accounts) {
      if (BigInt(account.balance_cents) !== 0n) {
        throw new EngineError(
          "INTERNAL",
          `company account ${account.id} was not drained before closure`,
        );
      }
      this.db.prepare(`
        UPDATE bank_accounts SET status = 'closed'
        WHERE run_id = ? AND id = ? AND status = 'active' AND balance_cents = '0'
      `).run(this.runId, account.id);
      const event = ctx.emit("account.closed", {
        accountId: account.id,
        ownerKind: "company",
        ownerId: companyId,
        reason: "company_failure",
      }, { correlationId: `company-wind-down:${companyId}`, causationId });
      eventIds.push(event.eventId);
    }
    return Object.freeze({
      accountIds: Object.freeze(accounts.map((account) => account.id)),
      eventIds: Object.freeze(eventIds),
    });
  }

  private assertWindDownPostconditions(companyId: string): void {
    const row = this.db.prepare<{ runId: string; companyId: string }, {
      active_employments: bigint;
      live_contracts: bigint;
      open_jobs: bigint;
      pending_applications: bigint;
      active_offerings: bigint;
      inventory_units: bigint;
      live_accounts: bigint;
      account_balance: bigint;
      unresolved_claims: bigint;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM employment_contracts
          WHERE run_id = @runId AND employer_id = @companyId AND status = 'active') AS active_employments,
        (SELECT COUNT(*) FROM legal_contracts c
          WHERE c.run_id = @runId AND c.status IN ('signed', 'active') AND (
            EXISTS (
              SELECT 1 FROM legal_contract_parties p
              WHERE p.run_id = c.run_id AND p.contract_id = c.id
                AND p.party_kind = 'company' AND p.party_id = @companyId
            )
            OR c.id = (
              SELECT incorporation_contract_id FROM companies
              WHERE run_id = c.run_id AND id = @companyId
            )
          )) AS live_contracts,
        (SELECT COUNT(*) FROM jobs
          WHERE run_id = @runId AND employer_id = @companyId AND status = 'open') AS open_jobs,
        (SELECT COUNT(*) FROM job_applications a
          JOIN jobs j ON j.run_id = a.run_id AND j.id = a.job_id
          WHERE a.run_id = @runId AND j.employer_id = @companyId AND a.status = 'submitted') AS pending_applications,
        (SELECT COUNT(*) FROM market_offerings
          WHERE run_id = @runId AND company_id = @companyId AND active = 1) AS active_offerings,
        (SELECT COALESCE(SUM(quantity), 0) FROM company_inventory
          WHERE run_id = @runId AND company_id = @companyId) AS inventory_units,
        (SELECT COUNT(*) FROM bank_accounts
          WHERE run_id = @runId AND owner_kind = 'company' AND owner_id = @companyId
            AND status <> 'closed') AS live_accounts,
        (SELECT COALESCE(SUM(CAST(balance_cents AS INTEGER)), 0) FROM bank_accounts
          WHERE run_id = @runId AND owner_kind = 'company' AND owner_id = @companyId) AS account_balance,
        (SELECT COUNT(*) FROM company_creditor_claims c
          WHERE c.run_id = @runId AND c.company_id = @companyId
            AND CAST(c.amount_cents AS INTEGER) <> COALESCE((
              SELECT SUM(amount) FROM (
                SELECT CAST(r.amount_cents AS INTEGER) AS amount
                FROM company_creditor_recoveries r
                WHERE r.run_id = c.run_id AND r.claim_id = c.id
                UNION ALL
                SELECT CAST(w.amount_cents AS INTEGER) AS amount
                FROM company_creditor_write_offs w
                WHERE w.run_id = c.run_id AND w.claim_id = c.id
              )
            ), 0)) AS unresolved_claims
    `).get({ runId: this.runId, companyId });
    if (row === undefined || Object.values(row).some((value) => value !== 0n)) {
      throw new EngineError("INTERNAL", "company wind-down left dangling state", {
        companyId,
        postconditions: row,
      });
    }
  }
}
