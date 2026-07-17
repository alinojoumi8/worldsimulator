/** Authoritative WS-801 persistence for VC firms, funds, and deployed capital. */

import {
  EngineError,
  ventureCapitalFirmSchema,
  ventureFirmCreatedPayloadSchema,
  ventureFundCreatedPayloadSchema,
  ventureFundDeployedPayloadSchema,
  ventureFundDeploymentSchema,
  ventureFundSchema,
  type IdFactory,
  type VentureCapitalFirm,
  type VentureFund,
  type VentureFundDeployment,
} from "@worldtangle/shared";
import { quoteVentureFundDeployment, type TickContext } from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";

export const FOUNDRY_CAPITAL_ID = "inst_foundry_capital";
export const FOUNDRY_CAPITAL_NAME = "Foundry Capital";
export const FOUNDRY_FUND_NAME = "Foundry Fund I";
export const FOUNDRY_FUND_SIZE_CENTS = "500000000";

interface FirmRow {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "closed";
  readonly created_tick: bigint;
  readonly source_event_id: string;
}

interface FundRow {
  readonly id: string;
  readonly firm_id: string;
  readonly name: string;
  readonly fund_size_cents: string;
  readonly deployed_cents: string;
  readonly status: "open" | "fully_deployed" | "closed";
  readonly created_tick: bigint;
  readonly source_event_id: string;
}

interface DeploymentRow {
  readonly id: string;
  readonly fund_id: string;
  readonly target_company_id: string;
  readonly reference_id: string;
  readonly amount_cents: string;
  readonly deployed_before_cents: string;
  readonly deployed_after_cents: string;
  readonly deployed_tick: bigint;
  readonly source_event_id: string;
}

function evidence(refs: readonly (string | undefined)[]): readonly string[] {
  const result: string[] = [];
  for (const ref of refs) {
    if (ref !== undefined && !result.includes(ref)) result.push(ref);
  }
  return Object.freeze(result);
}

export interface FoundryInitialization {
  readonly firm: VentureCapitalFirm;
  readonly fund: VentureFund;
}

export class SqliteVentureStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  initializeFoundry(input: {
    readonly ids: IdFactory;
    readonly firmSourceEventId: string;
    readonly fundSourceEventId: string;
  }): FoundryInitialization {
    const count = this.db.prepare<[string, string], { count: bigint }>(`
      SELECT (
        (SELECT COUNT(*) FROM vc_firms WHERE run_id = ?) +
        (SELECT COUNT(*) FROM vc_funds WHERE run_id = ?)
      ) AS count
    `).get(this.runId, this.runId)!.count;
    if (count !== 0n) {
      throw new EngineError("CONFLICT", "venture state is already initialized");
    }
    const firm = ventureCapitalFirmSchema.parse({
      id: FOUNDRY_CAPITAL_ID,
      runId: this.runId,
      name: FOUNDRY_CAPITAL_NAME,
      status: "active",
      createdTick: 0,
      sourceEventId: input.firmSourceEventId,
    });
    const fund = ventureFundSchema.parse({
      id: input.ids.next("vfund"),
      runId: this.runId,
      firmId: firm.id,
      name: FOUNDRY_FUND_NAME,
      fundSizeCents: FOUNDRY_FUND_SIZE_CENTS,
      deployedCents: "0",
      status: "open",
      createdTick: 0,
      sourceEventId: input.fundSourceEventId,
    });
    this.atomic(() => {
      this.insertFirm(firm);
      this.insertFund(fund);
    });
    return Object.freeze({ firm, fund });
  }

  createFirm(input: {
    readonly name: string;
    readonly firmId?: string;
    readonly causationId?: string;
    readonly evidenceRefs?: readonly string[];
  }, ctx: TickContext): VentureCapitalFirm {
    this.assertContext(ctx);
    const firmId = input.firmId ?? ctx.ids.next("inst");
    const existing = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM vc_firms WHERE run_id = ? AND id = ?
    `).get(this.runId, firmId);
    if (existing !== undefined) {
      throw new EngineError("CONFLICT", `venture firm ${firmId} already exists`);
    }
    return this.atomic(() => {
      const payload = ventureFirmCreatedPayloadSchema.parse({
        firmId,
        name: input.name,
        status: "active",
        evidence: evidence([input.causationId, ...(input.evidenceRefs ?? [])]),
      });
      const source = ctx.emit("venture.firm.created", payload, {
        actor: { kind: "system", id: "venture-capital" },
        schemaVersion: 1,
        correlationId: `venture-firm:${firmId}`,
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      });
      const firm = ventureCapitalFirmSchema.parse({
        id: firmId,
        runId: this.runId,
        name: input.name,
        status: "active",
        createdTick: ctx.tick,
        sourceEventId: source.eventId,
      });
      this.insertFirm(firm);
      return firm;
    });
  }

  createFund(input: {
    readonly firmId: string;
    readonly name: string;
    readonly fundSizeCents: string;
    readonly causationId?: string;
    readonly evidenceRefs?: readonly string[];
  }, ctx: TickContext): VentureFund {
    this.assertContext(ctx);
    const firm = this.getFirm(input.firmId);
    if (firm.status !== "active") {
      throw new EngineError("CONFLICT", `venture firm ${firm.id} is not active`);
    }
    const duplicate = this.db.prepare<[string, string, string], { id: string }>(`
      SELECT id FROM vc_funds WHERE run_id = ? AND firm_id = ? AND name = ?
    `).get(this.runId, firm.id, input.name);
    if (duplicate !== undefined) {
      throw new EngineError("CONFLICT", `venture fund ${input.name} already exists`);
    }
    const fundId = ctx.ids.next("vfund");
    return this.atomic(() => {
      const cause = input.causationId ?? firm.sourceEventId;
      const payload = ventureFundCreatedPayloadSchema.parse({
        fundId,
        firmId: firm.id,
        name: input.name,
        fundSizeCents: input.fundSizeCents,
        evidence: evidence([firm.sourceEventId, cause, ...(input.evidenceRefs ?? [])]),
      });
      const source = ctx.emit("venture.fund.created", payload, {
        actor: { kind: "institution", id: firm.id },
        schemaVersion: 1,
        correlationId: `venture-fund:${fundId}`,
        causationId: cause,
      });
      const fund = ventureFundSchema.parse({
        id: fundId,
        runId: this.runId,
        firmId: firm.id,
        name: input.name,
        fundSizeCents: input.fundSizeCents,
        deployedCents: "0",
        status: "open",
        createdTick: ctx.tick,
        sourceEventId: source.eventId,
      });
      this.insertFund(fund);
      return fund;
    });
  }

  deployCapital(input: {
    readonly fundId: string;
    readonly targetCompanyId: string;
    readonly referenceId: string;
    readonly amountCents: string;
    readonly causationId?: string;
    readonly evidenceRefs?: readonly string[];
  }, ctx: TickContext): { readonly fund: VentureFund; readonly deployment: VentureFundDeployment } {
    this.assertContext(ctx);
    const fund = this.getFund(input.fundId);
    if (fund.status !== "open") {
      throw new EngineError("CONFLICT", `venture fund ${fund.id} is not open`);
    }
    this.assertTargetCompany(input.targetCompanyId);
    const duplicate = this.db.prepare<[string, string, string], { id: string }>(`
      SELECT id FROM vc_fund_deployments
      WHERE run_id = ? AND fund_id = ? AND reference_id = ?
    `).get(this.runId, fund.id, input.referenceId);
    if (duplicate !== undefined) {
      throw new EngineError("CONFLICT", `venture deployment ${input.referenceId} already exists`);
    }
    const quote = quoteVentureFundDeployment(fund, input.amountCents);
    const deploymentId = ctx.ids.next("vdep");
    return this.atomic(() => {
      const cause = input.causationId ?? fund.sourceEventId;
      const payload = ventureFundDeployedPayloadSchema.parse({
        deploymentId,
        fundId: fund.id,
        targetCompanyId: input.targetCompanyId,
        referenceId: input.referenceId,
        amountCents: quote.amountCents,
        deployedBeforeCents: quote.deployedBeforeCents,
        deployedAfterCents: quote.deployedAfterCents,
        remainingCents: quote.remainingCents,
        evidence: evidence([fund.sourceEventId, cause, ...(input.evidenceRefs ?? [])]),
      });
      const source = ctx.emit("venture.fund.deployed", payload, {
        actor: { kind: "institution", id: fund.firmId },
        schemaVersion: 1,
        correlationId: `venture-fund:${fund.id}`,
        causationId: cause,
      });
      const deployment = ventureFundDeploymentSchema.parse({
        id: deploymentId,
        runId: this.runId,
        fundId: fund.id,
        targetCompanyId: input.targetCompanyId,
        referenceId: input.referenceId,
        amountCents: quote.amountCents,
        deployedBeforeCents: quote.deployedBeforeCents,
        deployedAfterCents: quote.deployedAfterCents,
        deployedTick: ctx.tick,
        sourceEventId: source.eventId,
      });
      this.db.prepare(`
        INSERT INTO vc_fund_deployments(
          run_id, id, fund_id, target_company_id, reference_id, amount_cents,
          deployed_before_cents, deployed_after_cents, deployed_tick, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        deployment.id,
        deployment.fundId,
        deployment.targetCompanyId,
        deployment.referenceId,
        deployment.amountCents,
        deployment.deployedBeforeCents,
        deployment.deployedAfterCents,
        deployment.deployedTick,
        deployment.sourceEventId,
      );
      return Object.freeze({ fund: this.getFund(fund.id), deployment });
    });
  }

  listFirms(): readonly VentureCapitalFirm[] {
    return this.db.prepare<[string], FirmRow>(`
      SELECT id, name, status, created_tick, source_event_id
      FROM vc_firms WHERE run_id = ? ORDER BY id
    `).all(this.runId).map((row) => this.firmFromRow(row));
  }

  getFirm(firmId: string): VentureCapitalFirm {
    const row = this.db.prepare<[string, string], FirmRow>(`
      SELECT id, name, status, created_tick, source_event_id
      FROM vc_firms WHERE run_id = ? AND id = ?
    `).get(this.runId, firmId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `venture firm ${firmId} does not exist`);
    }
    return this.firmFromRow(row);
  }

  listFunds(firmId?: string): readonly VentureFund[] {
    const rows = firmId === undefined
      ? this.db.prepare<[string], FundRow>(`
          SELECT id, firm_id, name, fund_size_cents, deployed_cents, status,
            created_tick, source_event_id
          FROM vc_funds WHERE run_id = ? ORDER BY id
        `).all(this.runId)
      : this.db.prepare<[string, string], FundRow>(`
          SELECT id, firm_id, name, fund_size_cents, deployed_cents, status,
            created_tick, source_event_id
          FROM vc_funds WHERE run_id = ? AND firm_id = ? ORDER BY id
        `).all(this.runId, firmId);
    return rows.map((row) => this.fundFromRow(row));
  }

  getFund(fundId: string): VentureFund {
    const row = this.db.prepare<[string, string], FundRow>(`
      SELECT id, firm_id, name, fund_size_cents, deployed_cents, status,
        created_tick, source_event_id
      FROM vc_funds WHERE run_id = ? AND id = ?
    `).get(this.runId, fundId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `venture fund ${fundId} does not exist`);
    }
    return this.fundFromRow(row);
  }

  listDeployments(fundId: string): readonly VentureFundDeployment[] {
    return this.db.prepare<[string, string], DeploymentRow>(`
      SELECT id, fund_id, target_company_id, reference_id, amount_cents,
        deployed_before_cents, deployed_after_cents, deployed_tick, source_event_id
      FROM vc_fund_deployments
      WHERE run_id = ? AND fund_id = ? ORDER BY deployed_tick, id
    `).all(this.runId, fundId).map((row) => this.deploymentFromRow(row));
  }

  private insertFirm(firm: VentureCapitalFirm): void {
    this.db.prepare(`
      INSERT INTO vc_firms(run_id, id, name, status, created_tick, source_event_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      firm.id,
      firm.name,
      firm.status,
      firm.createdTick,
      firm.sourceEventId,
    );
  }

  private insertFund(fund: VentureFund): void {
    this.db.prepare(`
      INSERT INTO vc_funds(
        run_id, id, firm_id, name, fund_size_cents, deployed_cents,
        status, created_tick, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      fund.id,
      fund.firmId,
      fund.name,
      fund.fundSizeCents,
      fund.deployedCents,
      fund.status,
      fund.createdTick,
      fund.sourceEventId,
    );
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "venture context belongs to another run");
    }
  }

  private assertTargetCompany(companyId: string): void {
    const row = this.db.prepare<[string, string, string, string], { id: string }>(`
      SELECT company_id AS id FROM opening_company_equity
      WHERE run_id = ? AND company_id = ?
      UNION ALL
      SELECT id FROM companies WHERE run_id = ? AND id = ?
      LIMIT 1
    `).get(this.runId, companyId, this.runId, companyId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `venture target company ${companyId} does not exist`);
    }
  }

  private firmFromRow(row: FirmRow): VentureCapitalFirm {
    return ventureCapitalFirmSchema.parse({
      id: row.id,
      runId: this.runId,
      name: row.name,
      status: row.status,
      createdTick: toSafeNumber(row.created_tick, "venture firm created tick"),
      sourceEventId: row.source_event_id,
    });
  }

  private fundFromRow(row: FundRow): VentureFund {
    return ventureFundSchema.parse({
      id: row.id,
      runId: this.runId,
      firmId: row.firm_id,
      name: row.name,
      fundSizeCents: row.fund_size_cents,
      deployedCents: row.deployed_cents,
      status: row.status,
      createdTick: toSafeNumber(row.created_tick, "venture fund created tick"),
      sourceEventId: row.source_event_id,
    });
  }

  private deploymentFromRow(row: DeploymentRow): VentureFundDeployment {
    return ventureFundDeploymentSchema.parse({
      id: row.id,
      runId: this.runId,
      fundId: row.fund_id,
      targetCompanyId: row.target_company_id,
      referenceId: row.reference_id,
      amountCents: row.amount_cents,
      deployedBeforeCents: row.deployed_before_cents,
      deployedAfterCents: row.deployed_after_cents,
      deployedTick: toSafeNumber(row.deployed_tick, "venture deployment tick"),
      sourceEventId: row.source_event_id,
    });
  }

  private atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
