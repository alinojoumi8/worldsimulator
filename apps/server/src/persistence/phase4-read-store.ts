/** Read-only WS-409 projections over authoritative Phase 4 state. */

import {
  canonicalParse,
  EngineError,
  eventIdSchema,
  type CompanyListItem,
  type CompanyListQuery,
  type ContractListQuery,
  type InstitutionKind,
  type InstitutionListQuery,
  type JobListQuery,
  type ProductSku,
} from "@worldtangle/shared";
import type { WorldDatabase } from "./database";
import { SqliteEnergyStore } from "./energy-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteInsolvencyStore } from "./insolvency-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";
import { SqliteVentureStore } from "./venture-store";
import { SqliteWorldEventStore } from "./world-event-store";

interface NamedRow {
  readonly id: string;
  readonly name: string;
}

interface CountRow {
  readonly count: bigint;
}

interface TimelineRow {
  readonly id: string;
  readonly tick: bigint;
  readonly event_type: string;
  readonly payload_canonical: string;
}

interface FlowRow {
  readonly direction: "debit" | "credit";
  readonly amount_cents: string;
  readonly kind: string;
}

interface SolvencyRow {
  readonly tick: bigint;
  readonly cash_cents: string;
  readonly obligation_cents: string;
  readonly shortfall_cents: string;
  readonly consecutive_shortfall_days: bigint;
  readonly insolvent: bigint;
  readonly source_event_id: string;
}

interface InstitutionCatalogEntry {
  readonly id: string;
  readonly kind: InstitutionKind;
  readonly name: string;
}

const INSTITUTION_CATALOG: readonly InstitutionCatalogEntry[] = [
  { id: "inst_first_ledger_bank", kind: "bank", name: "First Ledger Bank" },
  { id: "inst_foundry_capital", kind: "vc_firm", name: "Foundry Capital" },
  { id: "inst_hale_marrow", kind: "law_firm", name: "Hale & Marrow" },
  { id: "inst_riverbend_school", kind: "school", name: "Riverbend School" },
  { id: "inst_riverbend_ledger", kind: "news_org", name: "The Riverbend Ledger" },
  { id: "inst_town_riverbend", kind: "government", name: "Town of Riverbend" },
  { id: "inst_riverbend_exchange", kind: "market_operator", name: "Riverbend Exchange" },
  { id: "inst_riverbend_power", kind: "energy_co", name: "Riverbend Power & Light" },
] as const;

function toSafeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new EngineError("CONFLICT", `${label} exceeds the safe integer range`);
  }
  return number;
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const parsed = canonicalParse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("CONFLICT", `${label} is not a canonical record`);
  }
  return parsed as Record<string, unknown>;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function titleFromCode(value: string): string {
  return value.split("_").map((part) =>
    part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`
  ).join(" ");
}

function sourceEventFromDetails(details: Record<string, unknown>): string | null {
  const sourceEventId = details["sourceEventId"];
  return eventIdSchema.safeParse(sourceEventId).success ? sourceEventId as string : null;
}

export class SqlitePhase4ReadStore {
  private readonly phase4: SqlitePhase4Store;
  private readonly finance: SqliteFinanceStore;
  private readonly market: SqliteMarketStore;
  private readonly energy: SqliteEnergyStore;
  private readonly insolvency: SqliteInsolvencyStore;
  private readonly worldEvents: SqliteWorldEventStore;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    this.phase4 = new SqlitePhase4Store(db, runId);
    this.finance = new SqliteFinanceStore(db, runId);
    this.market = new SqliteMarketStore(db, runId);
    this.energy = new SqliteEnergyStore(db, runId);
    this.insolvency = new SqliteInsolvencyStore(db, runId);
    this.worldEvents = new SqliteWorldEventStore(db, runId);
  }

  currentTick(): number {
    const row = this.db.prepare<[string], { current_tick: bigint }>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    return toSafeNumber(row.current_tick, "run current tick");
  }

  listCompanies(query: CompanyListQuery): readonly CompanyListItem[] {
    return this.phase4.listCompanies()
      .filter((company) => query.status === undefined || company.status === query.status)
      .filter((company) => query.sector === undefined || company.sector === query.sector)
      .map((company) => {
        const financials = this.companyFinancials(company.businessAccountId);
        const employees = this.db.prepare<[string, string], CountRow>(`
          SELECT COUNT(*) AS count FROM employment_contracts
          WHERE run_id = ? AND employer_id = ? AND status = 'active'
        `).get(this.runId, company.id)!.count;
        const solvency = this.latestSolvency(company.id);
        return {
          id: company.id,
          name: company.name,
          sector: company.sector,
          status: company.status,
          formationStage: company.formationStage,
          foundedTick: company.foundedTick,
          employees: toSafeNumber(employees, "company employee count"),
          cash: { cents: financials.cashCents },
          lastProfit: { cents: financials.profit30Cents },
          consecutiveShortfallDays: solvency?.consecutiveShortfallDays ?? 0,
        };
      })
      .sort((left, right) => (
        right.foundedTick - left.foundedTick || compareCodeUnit(right.id, left.id)
      ));
  }

  getCompany(companyId: string): Readonly<Record<string, unknown>> {
    const company = this.phase4.getCompany(companyId);
    const founder = this.namedAgent(company.founderAgentId);
    const capTableRows = this.db.prepare<[string, string], {
      owner_agent_id: string;
      shares: string;
    }>(`
      SELECT owner_agent_id, shares FROM company_equity_stakes
      WHERE run_id = ? AND company_id = ? ORDER BY owner_agent_id
    `).all(this.runId, company.id);
    const totalShares = BigInt(company.totalShares);
    const capTable = capTableRows.map((row) => ({
      holder: this.namedAgent(row.owner_agent_id),
      shares: row.shares,
      ownershipBp: Number((BigInt(row.shares) * 10_000n) / totalShares),
    }));
    const staff = this.db.prepare<[string, string], {
      id: string;
      employee_agent_id: string;
      annual_wage_cents: string;
      status: "active" | "ended";
      start_tick: bigint;
      end_tick: bigint | null;
      legal_contract_id: string | null;
      occupation_code: string;
    }>(`
      SELECT e.id, e.employee_agent_id, e.annual_wage_cents, e.status,
        e.start_tick, e.end_tick, e.legal_contract_id, a.occupation_code
      FROM employment_contracts e
      JOIN agents a ON a.run_id = e.run_id AND a.id = e.employee_agent_id
      WHERE e.run_id = ? AND e.employer_id = ?
      ORDER BY e.start_tick, e.id
    `).all(this.runId, company.id).map((row) => ({
      employmentId: row.id,
      agent: this.namedAgent(row.employee_agent_id),
      title: titleFromCode(row.occupation_code),
      annualWageCents: row.annual_wage_cents,
      status: row.status,
      startTick: toSafeNumber(row.start_tick, "employment start tick"),
      endTick: row.end_tick === null ? null : toSafeNumber(row.end_tick, "employment end tick"),
      legalContractId: row.legal_contract_id,
    }));
    const offerings = this.db.prepare<[string, string], {
      id: string;
      sku: ProductSku;
      posted_price_cents: string;
      profile_unit_cost_cents: string | null;
      average_unit_cost_cents: string | null;
      quantity: bigint | null;
      active: bigint;
      created_tick: bigint;
    }>(`
      SELECT o.id, o.sku, o.posted_price_cents,
        p.unit_cost_cents AS profile_unit_cost_cents,
        i.average_unit_cost_cents, i.quantity, o.active, o.created_tick
      FROM market_offerings o
      LEFT JOIN company_production_profiles p
        ON p.run_id = o.run_id AND p.company_id = o.company_id AND p.sku = o.sku
      LEFT JOIN company_inventory i
        ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
      WHERE o.run_id = ? AND o.company_id = ? ORDER BY o.sku, o.id
    `).all(this.runId, company.id).map((row) => ({
      id: row.id,
      sku: row.sku,
      postedPriceCents: row.posted_price_cents,
      unitCostCents: row.average_unit_cost_cents ?? row.profile_unit_cost_cents ?? "0",
      inventory: row.quantity === null ? null : toSafeNumber(row.quantity, "inventory quantity"),
      active: row.active === 1n,
      createdTick: toSafeNumber(row.created_tick, "offering created tick"),
    }));
    const jobs = this.db.prepare<[string, string], {
      id: string;
      title: string;
      status: "open" | "filled" | "withdrawn" | "expired";
      annual_wage_cents: string;
      openings: bigint;
      filled_count: bigint;
    }>(`
      SELECT id, title, status, annual_wage_cents, openings, filled_count
      FROM jobs WHERE run_id = ? AND employer_id = ? ORDER BY posted_tick, id
    `).all(this.runId, company.id).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      annualWageCents: row.annual_wage_cents,
      openings: toSafeNumber(row.openings, "job openings"),
      filledCount: toSafeNumber(row.filled_count, "job filled count"),
    }));
    const solvency = this.latestSolvency(company.id);
    const windDown = this.insolvency.getWindDown(company.id);
    return {
      company: {
        id: company.id,
        name: company.name,
        sector: company.sector,
        status: company.status,
        formationStage: company.formationStage,
        foundedTick: company.foundedTick,
        registeredTick: company.registeredTick,
        activatedTick: company.activatedTick,
        incorporationContractId: company.incorporationContractId,
        businessAccountId: company.businessAccountId,
        failureReason: company.failureReason,
        founder,
      },
      capTable,
      staff,
      offerings,
      jobs,
      financials: this.companyFinancials(company.businessAccountId),
      solvency,
      windDown: windDown === null ? null : {
        completedTick: windDown.completedTick,
        openingCashCents: windDown.openingCashCents,
        salvageProceedsCents: windDown.salvageProceedsCents,
        liquidationPoolCents: windDown.liquidationPoolCents,
        creditorRecoveriesCents: windDown.creditorRecoveriesCents,
        writtenOffCents: windDown.writtenOffCents,
        employeesTerminated: windDown.employeesTerminated,
        contractsTerminated: windDown.contractsTerminated,
        jobsWithdrawn: windDown.jobsWithdrawn,
        offeringsDeactivated: windDown.offeringsDeactivated,
        sourceEventId: windDown.sourceEventId,
      },
      timeline: this.companyTimeline(company.id),
    };
  }

  listContracts(query: ContractListQuery): readonly Readonly<Record<string, unknown>>[] {
    return this.phase4.listLegalContracts()
      .filter((contract) => query.type === undefined || contract.type === query.type)
      .filter((contract) => query.status === undefined || contract.status === query.status)
      .filter((contract) => query.party === undefined ||
        contract.parties.some((party) => party.id === query.party))
      .map((contract) => ({
        id: contract.id,
        type: contract.type,
        parties: this.contractPartyDetails(contract.parties),
        status: contract.status,
        effectiveTick: contract.effectiveTick,
        terminalTick: contract.terminalTick,
        feeCents: contract.feeCents,
      }))
      .sort((left, right) => compareCodeUnit(String(right["id"]), String(left["id"])));
  }

  getContract(contractId: string): Readonly<Record<string, unknown>> {
    const contract = this.phase4.getLegalContract(contractId);
    const timeline = this.db.prepare<[string, string], TimelineRow>(`
      SELECT id, tick, event_type, payload_canonical
      FROM legal_contract_timeline
      WHERE run_id = ? AND contract_id = ? ORDER BY tick, id
    `).all(this.runId, contractId).map((row) => ({
      id: row.id,
      tick: toSafeNumber(row.tick, "contract timeline tick"),
      type: row.event_type,
      details: parseRecord(row.payload_canonical, `contract timeline ${row.id}`),
    }));
    return {
      contract,
      partyDetails: this.contractPartyDetails(contract.parties),
      timeline,
    };
  }

  listJobs(query: JobListQuery): readonly Readonly<Record<string, unknown>>[] {
    const ids = this.db.prepare<[string], { id: string }>(`
      SELECT id FROM jobs WHERE run_id = ? ORDER BY posted_tick DESC, id DESC
    `).all(this.runId).map((row) => row.id);
    return ids.map((id) => {
      const job = this.phase4.getJob(id);
      const applications = this.db.prepare<[string, string], CountRow>(`
        SELECT COUNT(*) AS count FROM job_applications WHERE run_id = ? AND job_id = ?
      `).get(this.runId, id)!.count;
      return {
        id: job.id,
        employer: { id: job.employerId, name: this.namedCompany(job.employerId).name },
        occupationCode: job.occupationCode,
        title: job.title,
        annualWageCents: job.annualWageCents,
        openings: job.openings,
        filledCount: job.filledCount,
        status: job.status,
        postedTick: job.postedTick,
        expiresTick: job.expiresTick,
        applicationCount: toSafeNumber(applications, "job application count"),
        payrollRisk: job.payrollRisk,
      };
    }).filter((job) => query.status === undefined || job.status === query.status)
      .filter((job) => query.companyId === undefined || job.employer.id === query.companyId)
      .filter((job) => query.occupation === undefined || job.occupationCode === query.occupation);
  }

  getJob(jobId: string): Readonly<Record<string, unknown>> {
    const job = this.phase4.getJob(jobId);
    const applications = this.phase4.listJobApplications(jobId).map((application) => ({
      application,
      agent: this.namedAgent(application.agentId),
    }));
    const employmentContracts = this.phase4.listLegalContracts()
      .filter((contract) => (
        contract.type === "employment" &&
        contract.terms.template === "employment" &&
        contract.terms.jobId === jobId
      ))
      .map((contract) => {
        if (contract.terms.template !== "employment") {
          throw new EngineError("CONFLICT", `contract ${contract.id} has invalid employment terms`);
        }
        const row = this.db.prepare<[string, string], {
          id: string;
          start_tick: bigint;
          end_tick: bigint | null;
          status: "active" | "ended";
        }>(`
          SELECT id, start_tick, end_tick, status FROM employment_contracts
          WHERE run_id = ? AND legal_contract_id = ?
        `).get(this.runId, contract.id);
        return {
          id: row?.id ?? `pending:${contract.id}`,
          employee: this.namedAgent(contract.terms.employeeAgentId),
          legalContractId: contract.id,
          startTick: row === undefined
            ? contract.terms.startTick
            : toSafeNumber(row.start_tick, "employment start tick"),
          endTick: row?.end_tick === null || row === undefined
            ? null
            : toSafeNumber(row.end_tick, "employment end tick"),
          status: row?.status ?? "active",
        };
      });
    return {
      job,
      employer: { id: job.employerId, name: this.namedCompany(job.employerId).name },
      applications,
      employmentContracts,
    };
  }

  listInstitutions(query: InstitutionListQuery): readonly Readonly<Record<string, unknown>>[] {
    return INSTITUTION_CATALOG
      .filter((institution) => query.kind === undefined || institution.kind === query.kind)
      .map((institution) => this.institutionSummary(institution))
      .sort((left, right) => compareCodeUnit(String(left["id"]), String(right["id"])));
  }

  getInstitution(institutionId: string): Readonly<Record<string, unknown>> {
    const catalog = INSTITUTION_CATALOG.find((entry) => entry.id === institutionId);
    if (catalog === undefined) {
      throw new EngineError("NOT_FOUND", `institution ${institutionId} does not exist`);
    }
    const officeholders = this.institutionStaff(catalog.id).map((staff) => ({
      role: staff.roleCode,
      agent: { id: staff.id, name: staff.name },
    }));
    return {
      institution: this.institutionSummary(catalog),
      officeholders,
      rulebook: this.institutionRulebook(catalog),
    };
  }

  goodsMarket(): Readonly<Record<string, unknown>> {
    const tick = this.currentTick();
    const offeringRows = this.db.prepare<[string], {
      id: string;
      company_id: string;
      company_name: string;
      sku: ProductSku;
      posted_price_cents: string;
      average_unit_cost_cents: string | null;
      profile_unit_cost_cents: string | null;
      quantity: bigint | null;
      active: bigint;
    }>(`
      SELECT o.id, o.company_id, c.name AS company_name, o.sku,
        o.posted_price_cents, i.average_unit_cost_cents,
        p.unit_cost_cents AS profile_unit_cost_cents, i.quantity, o.active
      FROM market_offerings o
      JOIN companies c ON c.run_id = o.run_id AND c.id = o.company_id
      LEFT JOIN company_inventory i
        ON i.run_id = o.run_id AND i.company_id = o.company_id AND i.sku = o.sku
      LEFT JOIN company_production_profiles p
        ON p.run_id = o.run_id AND p.company_id = o.company_id AND p.sku = o.sku
      WHERE o.run_id = ? ORDER BY o.sku, o.posted_price_cents, o.id
    `).all(this.runId);
    const products = this.market.listProducts().map((product) => ({
      product,
      currentRowReferencePriceCents: this.worldEvents.rowReferencePriceCents(product.sku, tick),
      demandMultiplierBp: this.worldEvents.demandMultiplierBp(product.sku, tick),
      offerings: offeringRows.filter((row) => row.sku === product.sku).map((row) => ({
        id: row.id,
        company: { id: row.company_id, name: row.company_name },
        postedPriceCents: row.posted_price_cents,
        averageUnitCostCents:
          row.average_unit_cost_cents ?? row.profile_unit_cost_cents ?? "0",
        inventory: row.quantity === null ? null : toSafeNumber(row.quantity, "market inventory"),
        active: row.active === 1n,
      })),
    }));
    const recentPriceChanges = [...this.market.listPriceHistory()]
      .sort((left, right) => right.tick - left.tick || compareCodeUnit(right.id, left.id))
      .slice(0, 50)
      .map((entry) => ({
        id: entry.id,
        offeringId: entry.offeringId,
        companyId: entry.companyId,
        sku: entry.sku,
        tick: entry.tick,
        oldPriceCents: entry.oldPriceCents,
        newPriceCents: entry.newPriceCents,
        source: entry.source,
        sourceEventId: entry.sourceEventId,
      }));
    const system = this.energy.system();
    const energy = system === null ? null : {
      householdTariffCents: this.energy.tariff("household", tick).priceCents,
      businessTariffCents: this.energy.tariff("business", tick).priceCents,
      fuelPriceCents: this.energy.latestFuelPrice(tick).newPriceCents,
    };
    return {
      market: { id: "goods_riverbend", kind: "posted_price", tick, catalogVersion: 1 },
      products,
      recentPriceChanges,
      energy,
    };
  }

  private companyFinancials(businessAccountId: string | null): {
    readonly cashCents: string;
    readonly revenue30Cents: string;
    readonly costs30Cents: string;
    readonly profit30Cents: string;
  } {
    if (businessAccountId === null) {
      return { cashCents: "0", revenue30Cents: "0", costs30Cents: "0", profit30Cents: "0" };
    }
    const account = this.db.prepare<[string, string], { balance_cents: string }>(`
      SELECT balance_cents FROM bank_accounts WHERE run_id = ? AND id = ?
    `).get(this.runId, businessAccountId);
    if (account === undefined) {
      throw new EngineError("CONFLICT", `company account ${businessAccountId} does not exist`);
    }
    const fromTick = Math.max(0, this.currentTick() - 29);
    const flows = this.db.prepare<[string, string, number], FlowRow>(`
      SELECT l.direction, l.amount_cents, t.kind
      FROM ledger_transaction_legs l
      JOIN ledger_transactions t ON t.run_id = l.run_id AND t.id = l.transaction_id
      WHERE l.run_id = ? AND l.account_id = ? AND t.tick >= ?
      ORDER BY t.tick, t.id, l.leg_index
    `).all(this.runId, businessAccountId, fromTick);
    let revenue = 0n;
    let costs = 0n;
    for (const flow of flows) {
      const amount = BigInt(flow.amount_cents);
      if (flow.direction === "debit" && (flow.kind === "purchase" || flow.kind === "row_settlement")) {
        revenue += amount;
      } else if (
        flow.direction === "credit" &&
        flow.kind !== "transfer" &&
        flow.kind !== "mint" &&
        flow.kind !== "loan_disbursement"
      ) {
        costs += amount;
      }
    }
    return {
      cashCents: account.balance_cents,
      revenue30Cents: revenue.toString(),
      costs30Cents: costs.toString(),
      profit30Cents: (revenue - costs).toString(),
    };
  }

  private latestSolvency(companyId: string): {
    readonly tick: number;
    readonly cashCents: string;
    readonly obligationCents: string;
    readonly shortfallCents: string;
    readonly consecutiveShortfallDays: number;
    readonly insolvent: boolean;
    readonly sourceEventId: string;
  } | null {
    const row = this.db.prepare<[string, string], SolvencyRow>(`
      SELECT tick, cash_cents, obligation_cents, shortfall_cents,
        consecutive_shortfall_days, insolvent, source_event_id
      FROM company_solvency_assessments
      WHERE run_id = ? AND company_id = ? ORDER BY tick DESC, id DESC LIMIT 1
    `).get(this.runId, companyId);
    return row === undefined ? null : {
      tick: toSafeNumber(row.tick, "solvency tick"),
      cashCents: row.cash_cents,
      obligationCents: row.obligation_cents,
      shortfallCents: row.shortfall_cents,
      consecutiveShortfallDays: toSafeNumber(
        row.consecutive_shortfall_days,
        "consecutive shortfall days",
      ),
      insolvent: row.insolvent === 1n,
      sourceEventId: row.source_event_id,
    };
  }

  private companyTimeline(companyId: string): readonly Readonly<Record<string, unknown>>[] {
    const timeline: Record<string, unknown>[] = this.db
      .prepare<[string, string], TimelineRow>(`
        SELECT id, tick, event_type, payload_canonical FROM company_timeline
        WHERE run_id = ? AND company_id = ? ORDER BY tick, id
      `).all(this.runId, companyId).map((row) => {
        const details = parseRecord(row.payload_canonical, `company timeline ${row.id}`);
        return {
          id: row.id,
          tick: toSafeNumber(row.tick, "company timeline tick"),
          type: row.event_type,
          sourceEventId: sourceEventFromDetails(details),
          referenceId: typeof details["transactionId"] === "string"
            ? details["transactionId"]
            : typeof details["contractId"] === "string"
              ? details["contractId"]
              : typeof details["windDownId"] === "string"
                ? details["windDownId"]
                : null,
          details,
        };
      });
    const employment = this.db.prepare<[string, string], {
      id: string;
      employee_agent_id: string;
      start_tick: bigint;
      end_tick: bigint | null;
    }>(`
      SELECT id, employee_agent_id, start_tick, end_tick FROM employment_contracts
      WHERE run_id = ? AND employer_id = ? ORDER BY start_tick, id
    `).all(this.runId, companyId);
    for (const row of employment) {
      timeline.push({
        id: `employment-start:${row.id}`,
        tick: toSafeNumber(row.start_tick, "employment start tick"),
        type: "employment.created",
        sourceEventId: null,
        referenceId: row.id,
        details: { employeeAgentId: row.employee_agent_id },
      });
      if (row.end_tick !== null) {
        timeline.push({
          id: `employment-end:${row.id}`,
          tick: toSafeNumber(row.end_tick, "employment end tick"),
          type: "employment.terminated",
          sourceEventId: null,
          referenceId: row.id,
          details: { employeeAgentId: row.employee_agent_id },
        });
      }
    }
    const production = this.db.prepare<[string, string], {
      id: string;
      sku: string;
      tick: bigint;
      units_produced: bigint;
      source_event_id: string;
    }>(`
      SELECT id, sku, tick, units_produced, source_event_id FROM production_runs
      WHERE run_id = ? AND company_id = ? ORDER BY sku, tick, id
    `).all(this.runId, companyId);
    const productionBySku = new Map<string, typeof production>();
    for (const row of production) {
      const rows = productionBySku.get(row.sku) ?? [];
      productionBySku.set(row.sku, [...rows, row]);
    }
    for (const rows of productionBySku.values()) {
      const milestones = rows.length < 2 ? rows : [rows[0]!, rows.at(-1)!];
      for (const [index, row] of milestones.entries()) {
        timeline.push({
          id: `production:${row.id}`,
          tick: toSafeNumber(row.tick, "production tick"),
          type: index === 0 ? "production.started" : "production.latest",
          sourceEventId: row.source_event_id,
          referenceId: row.id,
          details: {
            sku: row.sku,
            unitsProduced: toSafeNumber(row.units_produced, "units produced"),
          },
        });
      }
    }
    const prices = this.db.prepare<[string, string], {
      id: string;
      tick: bigint;
      sku: string;
      old_price_cents: string;
      new_price_cents: string;
      source_event_id: string;
    }>(`
      SELECT id, tick, sku, old_price_cents, new_price_cents, source_event_id
      FROM market_price_history WHERE run_id = ? AND company_id = ? ORDER BY tick, id
    `).all(this.runId, companyId);
    for (const row of prices) {
      timeline.push({
        id: `price:${row.id}`,
        tick: toSafeNumber(row.tick, "market price tick"),
        type: "market.price.updated",
        sourceEventId: row.source_event_id,
        referenceId: row.id,
        details: {
          sku: row.sku,
          oldPriceCents: row.old_price_cents,
          newPriceCents: row.new_price_cents,
        },
      });
    }
    const solvency = this.latestSolvency(companyId);
    if (solvency !== null) {
      timeline.push({
        id: `solvency:${solvency.sourceEventId}`,
        tick: solvency.tick,
        type: solvency.insolvent ? "company.insolvency.detected" : "company.solvency.assessed",
        sourceEventId: solvency.sourceEventId,
        referenceId: null,
        details: {
          cashCents: solvency.cashCents,
          obligationCents: solvency.obligationCents,
          shortfallCents: solvency.shortfallCents,
          consecutiveShortfallDays: solvency.consecutiveShortfallDays,
        },
      });
    }
    return timeline.sort((left, right) => {
      const tickOrder = Number(left["tick"]) - Number(right["tick"]);
      if (tickOrder !== 0) return tickOrder;
      const typeOrder = compareCodeUnit(String(left["type"]), String(right["type"]));
      return typeOrder !== 0 ? typeOrder : compareCodeUnit(String(left["id"]), String(right["id"]));
    });
  }

  private contractPartyDetails(
    parties: readonly {
      readonly kind: "agent" | "company" | "institution";
      readonly id: string;
      readonly role: string;
      readonly signedTick: number | null;
    }[],
  ) {
    return parties.map((party) => ({
      ...party,
      name: party.kind === "agent"
        ? this.namedAgent(party.id).name
        : party.kind === "company"
          ? this.namedCompany(party.id).name
          : this.namedInstitution(party.id).name,
    }));
  }

  private namedAgent(agentId: string): NamedRow {
    const row = this.db.prepare<[string, string], NamedRow>(`
      SELECT a.id, p.name FROM agents a
      JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? AND a.id = ?
    `).get(this.runId, agentId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
    return row;
  }

  private namedCompany(companyId: string): NamedRow {
    const row = this.db.prepare<[string, string], NamedRow>(`
      SELECT id, name FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, companyId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `company ${companyId} does not exist`);
    return row;
  }

  private namedInstitution(institutionId: string): NamedRow {
    const row = INSTITUTION_CATALOG.find((entry) => entry.id === institutionId);
    return row === undefined
      ? {
          id: institutionId,
          name: titleFromCode(institutionId.replace(/^(?:inst|biz)_/, "")),
        }
      : { id: row.id, name: row.name };
  }

  private institutionStaff(institutionId: string): readonly {
    readonly id: string;
    readonly name: string;
    readonly roleCode: string;
  }[] {
    return this.db.prepare<[string, string], {
      id: string;
      name: string;
      role_code: string;
    }>(`
      SELECT a.id, p.name, a.role_code FROM agents a
      JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? AND a.organization_id = ? AND a.segment = 'institution'
      ORDER BY a.role_code, a.id
    `).all(this.runId, institutionId).map((row) => ({
      id: row.id,
      name: row.name,
      roleCode: row.role_code,
    }));
  }

  private institutionSummary(catalog: InstitutionCatalogEntry): Readonly<Record<string, unknown>> {
    return {
      id: catalog.id,
      kind: catalog.kind,
      name: catalog.name,
      staffCount: this.institutionStaff(catalog.id).length,
      keyFigures: this.institutionKeyFigures(catalog),
    };
  }

  private institutionKeyFigures(catalog: InstitutionCatalogEntry): Record<string, unknown> {
    if (catalog.kind === "bank") {
      const bank = this.finance.listBanks()[0];
      return bank === undefined ? { initialized: false } : {
        initialized: true,
        bankId: bank.id,
        totalDepositsCents: bank.totalDeposits,
        totalLoansCents: bank.totalLoans,
        capitalRatioBp: bank.capitalRatioBp,
        reserveRatioBp: bank.reserveRatioBp,
        lendingHalted: bank.lendingHalted,
      };
    }
    if (catalog.kind === "vc_firm") {
      const venture = new SqliteVentureStore(this.db, this.runId);
      const firm = venture.listFirms().find((candidate) => candidate.id === catalog.id);
      if (firm === undefined) return { initialized: false };
      const funds = venture.listFunds(firm.id);
      const fundSizeCents = funds.reduce(
        (total, fund) => total + BigInt(fund.fundSizeCents),
        0n,
      );
      const deployedCents = funds.reduce(
        (total, fund) => total + BigInt(fund.deployedCents),
        0n,
      );
      return {
        initialized: true,
        firmId: firm.id,
        status: firm.status,
        fundCount: funds.length,
        fundSizeCents: fundSizeCents.toString(),
        deployedCents: deployedCents.toString(),
        availableCents: (fundSizeCents - deployedCents).toString(),
      };
    }
    if (catalog.kind === "government") {
      const treasury = this.db.prepare<[string], { balance_cents: string }>(`
        SELECT balance_cents FROM bank_accounts
        WHERE run_id = ? AND owner_kind = 'government'
          AND owner_id = 'inst_town_riverbend' AND account_type = 'checking'
        ORDER BY id LIMIT 1
      `).get(this.runId);
      return { treasuryBalanceCents: treasury?.balance_cents ?? "0" };
    }
    if (catalog.kind === "energy_co") {
      const system = this.energy.system();
      if (system === null) return { initialized: false };
      const tick = this.currentTick();
      return {
        initialized: true,
        householdTariffCents: this.energy.tariff("household", tick).priceCents,
        businessTariffCents: this.energy.tariff("business", tick).priceCents,
        fuelPriceCents: this.energy.latestFuelPrice(tick).newPriceCents,
      };
    }
    const contracts = this.db.prepare<[string, string], CountRow>(`
      SELECT COUNT(DISTINCT p.contract_id) AS count
      FROM legal_contract_parties p
      JOIN legal_contracts c ON c.run_id = p.run_id AND c.id = p.contract_id
      WHERE p.run_id = ? AND p.party_id = ?
        AND c.status IN ('signed', 'active')
    `).get(this.runId, catalog.id)!.count;
    return { activeContracts: toSafeNumber(contracts, "institution active contract count") };
  }

  private institutionRulebook(catalog: InstitutionCatalogEntry): Record<string, unknown> {
    if (catalog.kind === "bank") {
      const row = this.db.prepare<[string], {
        reserve_ratio_bp: bigint;
        capital_ratio_min_bp: bigint;
        base_lending_rate_bp: bigint;
        exposure_cap_cents: string;
      }>(`
        SELECT reserve_ratio_bp, capital_ratio_min_bp, base_lending_rate_bp,
          exposure_cap_cents FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
      `).get(this.runId);
      return row === undefined ? { version: 1, initialized: false } : {
        version: 1,
        reserveRatioBp: toSafeNumber(row.reserve_ratio_bp, "reserve ratio"),
        capitalRatioMinBp: toSafeNumber(row.capital_ratio_min_bp, "capital ratio"),
        baseLendingRateBp: toSafeNumber(row.base_lending_rate_bp, "lending rate"),
        exposureCapCents: row.exposure_cap_cents,
      };
    }
    if (catalog.kind === "vc_firm") {
      return {
        version: 1,
        authority: "investment_review_only",
        accountingUnit: "integer_cents",
        deploymentLimit: "deployed_cents_lte_fund_size_cents",
      };
    }
    if (catalog.kind === "government") {
      const tick = this.currentTick();
      const rows = this.db.prepare<[string, number, number], {
        policy_key: string;
        value_integer: string;
      }>(`
        SELECT p.policy_key, p.value_integer FROM policies p
        WHERE p.run_id = ? AND p.effective_tick <= ?
          AND NOT EXISTS (
            SELECT 1 FROM policies later
            WHERE later.run_id = p.run_id AND later.policy_key = p.policy_key
              AND later.effective_tick <= ?
              AND (later.effective_tick > p.effective_tick
                OR (later.effective_tick = p.effective_tick AND later.id > p.id))
          )
        ORDER BY p.policy_key
      `).all(this.runId, tick, tick);
      return {
        version: 1,
        policies: Object.fromEntries(rows.map((row) => [row.policy_key, row.value_integer])),
      };
    }
    if (catalog.kind === "energy_co") {
      const system = this.energy.system();
      return system === null ? { version: 1, initialized: false } : {
        version: system.rulesetVersion,
        billingIntervalTicks: system.billingIntervalTicks,
        passThroughBp: system.passThroughBp,
        minimumTariffBp: system.minimumTariffBp,
        maximumTariffBp: system.maximumTariffBp,
        minimumFuelPriceBp: system.minimumFuelPriceBp,
        maximumFuelPriceBp: system.maximumFuelPriceBp,
      };
    }
    const authority: Record<InstitutionCatalogEntry["kind"], string> = {
      bank: "deposit_and_credit_rules",
      vc_firm: "investment_review_only",
      law_firm: "contract_drafting_and_filing",
      school: "education_services",
      news_org: "editorial_workflow",
      government: "bounded_public_policy",
      market_operator: "market_operations",
      energy_co: "regulated_tariff_and_billing",
    };
    return { version: 1, authority: authority[catalog.kind] };
  }
}
