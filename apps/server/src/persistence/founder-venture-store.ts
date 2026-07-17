/** Deterministic default-scenario founder venture lifecycle for WS-710 AC-5. */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  type Job,
  type JobApplication,
  type LoanApplication,
  type ProductSku,
} from "@worldtangle/shared";
import type { TickContext } from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteCreditStore } from "./credit-store";
import { SqliteMarketStore } from "./market-store";
import { SqlitePhase4Store } from "./phase4-store";

const LAUNCH_JOB_TITLE = "Founding operations associate";
const LAUNCH_LOAN_PURPOSE = "founder venture working capital";
const LAUNCH_LOAN_AMOUNT_CENTS = 25_000n;
const MINIMUM_ANNUAL_REVENUE_CENTS = LAUNCH_LOAN_AMOUNT_CENTS * 5n;
const MINIMUM_POST_HIRE_UNEMPLOYMENT_RATE_BP = 300n;

interface FounderCompanyRow {
  readonly id: string;
  readonly sector: string;
  readonly founder_agent_id: string;
  readonly business_account_id: string;
  readonly activated_tick: bigint;
}

interface EventRow {
  readonly event_id: string;
  readonly payload_canonical: string;
}

interface IdRow {
  readonly id: string;
}

interface CreditApplicationRow extends IdRow {
  readonly status: LoanApplication["status"];
}

interface RevenueRow {
  readonly tick: bigint;
  readonly amount_cents: string;
}

interface LaborCountRow {
  readonly labor_count: bigint;
  readonly unemployed_count: bigint;
}

interface LaunchProduct {
  readonly sku: ProductSku;
  readonly postedPriceCents: string;
  readonly unitCostCents: string;
  readonly productivityMilliunitsPerLaborHour: number;
  readonly capacityUnitsPerTick: number;
}

export class SqliteFounderVentureStore {
  private readonly companies: SqlitePhase4Store;
  private readonly market: SqliteMarketStore;
  private readonly credit: SqliteCreditStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.companies = new SqlitePhase4Store(db, runId);
    this.market = new SqliteMarketStore(db, runId);
    this.credit = new SqliteCreditStore(db, runId);
  }

  processLaunches(ctx: TickContext): void {
    for (const company of this.eligibleCompanies(ctx.tick)) {
      if (this.entityEventId("company.launch.completed", "companyId", company.id) !== undefined) {
        continue;
      }
      const activationEventId = this.requireEntityEventId(
        "company.activated",
        "companyId",
        company.id,
      );
      const correlationId = `founder-venture:${company.id}`;
      let terminalEventId = this.entityEventId(
        "company.launch.started",
        "companyId",
        company.id,
      );
      if (terminalEventId === undefined) {
        terminalEventId = ctx.emit("company.launch.started", {
          companyId: company.id,
          founderAgentId: company.founder_agent_id,
          sector: company.sector,
        }, {
          actor: { kind: "agent", id: company.founder_agent_id },
          correlationId,
          causationId: activationEventId,
        }).eventId;
      }

      let job = this.launchJob(company.id);
      if (job === undefined) {
        job = this.companies.postJob({
          employerId: company.id,
          occupationCode: "production_worker",
          title: LAUNCH_JOB_TITLE,
          annualWageCents: "3000000",
          requirements: [],
          openings: 1,
          tick: ctx.tick,
          ids: ctx.ids,
        });
        const posted = ctx.emit("job.posted", {
          jobId: job.id,
          employerId: company.id,
          occupationCode: job.occupationCode,
          title: job.title,
          annualWageCents: job.annualWageCents,
          openings: job.openings,
          payrollRisk: job.payrollRisk,
        }, {
          actor: { kind: "institution", id: company.id },
          correlationId,
          causationId: terminalEventId,
        });
        terminalEventId = posted.eventId;
        this.appendTimeline(ctx, company.id, "job.posted", {
          jobId: job.id,
          sourceEventId: posted.eventId,
        });
      }

      let application = this.launchApplication(job.id);
      if (application === undefined && job.status === "open") {
        const candidate = this.launchCandidate(company.founder_agent_id);
        if (candidate !== undefined) {
          application = this.companies.submitJobApplication({
            jobId: job.id,
            agentId: candidate.id,
            reservationWageCents: "2500000",
            tick: ctx.tick,
            ids: ctx.ids,
          });
          const submitted = ctx.emit("job.application.submitted", {
            applicationId: application.id,
            jobId: job.id,
            employerId: company.id,
            agentId: application.agentId,
            reservationWageCents: application.reservationWageCents,
          }, {
            actor: { kind: "agent", id: application.agentId },
            correlationId,
            causationId: terminalEventId,
          });
          terminalEventId = submitted.eventId;
          this.appendTimeline(ctx, company.id, "job.application.submitted", {
            applicationId: application.id,
            jobId: job.id,
            agentId: application.agentId,
            sourceEventId: submitted.eventId,
          });
        }
      }

      if (application?.status === "submitted" && job.status === "open") {
        const applicationEventId = this.entityEventId(
          "job.application.submitted",
          "applicationId",
          application.id,
        ) ?? terminalEventId;
        const hired = this.companies.hireFounderLaunchApplication({
          applicationId: application.id,
          correlationId,
          sourceEventId: applicationEventId,
        }, ctx);
        job = hired.job;
        terminalEventId = hired.eventIds.at(-1) ?? applicationEventId;
        this.appendTimeline(ctx, company.id, "employment.created", {
          employmentContractId: hired.employmentContractId,
          legalContractId: hired.legalContractId,
          applicationId: application.id,
          jobId: job.id,
          sourceEventId: terminalEventId,
        });
      }

      let offeringId = this.launchOfferingId(company.id);
      if (job.filledCount > 0 && offeringId === undefined) {
        const product = this.launchProduct(company.id);
        const created = this.market.createProductionOffering({
          companyId: company.id,
          sku: product.sku,
          postedPriceCents: product.postedPriceCents,
          unitCostCents: product.unitCostCents,
          laborHoursPerWorker: 8,
          productivityMilliunitsPerLaborHour: product.productivityMilliunitsPerLaborHour,
          capacityUnitsPerTick: product.capacityUnitsPerTick,
          tick: ctx.tick,
          ids: ctx.ids,
        });
        offeringId = created.offering.id;
        const offered = ctx.emit("market.offering.created", {
          companyId: company.id,
          offeringId,
          inventoryId: created.inventory.id,
          sku: created.offering.sku,
          postedPriceCents: created.offering.postedPriceCents,
          unitCostCents: created.profile.unitCostCents,
        }, {
          actor: { kind: "institution", id: company.id },
          correlationId,
          causationId: terminalEventId,
        });
        terminalEventId = offered.eventId;
        this.appendTimeline(ctx, company.id, "market.offering.created", {
          offeringId,
          inventoryId: created.inventory.id,
          sku: created.offering.sku,
          sourceEventId: offered.eventId,
        });
      }

      if (job.filledCount > 0 && offeringId !== undefined) {
        const completed = ctx.emit("company.launch.completed", {
          companyId: company.id,
          founderAgentId: company.founder_agent_id,
          jobId: job.id,
          offeringId,
        }, {
          actor: { kind: "institution", id: company.id },
          correlationId,
          causationId: terminalEventId,
        });
        this.appendTimeline(ctx, company.id, "company.launch.completed", {
          jobId: job.id,
          offeringId,
          sourceEventId: completed.eventId,
        });
      }
    }
  }

  processCreditLifecycle(ctx: TickContext): void {
    for (const company of this.eligibleCompanies(ctx.tick)) {
      const launchEventId = this.entityEventId(
        "company.launch.completed",
        "companyId",
        company.id,
      );
      if (launchEventId === undefined) continue;
      const activatedTick = toSafeNumber(
        company.activated_tick,
        `company ${company.id} activated tick`,
      );
      if (ctx.tick - activatedTick < 30) continue;

      const application = this.creditApplication(company.id);
      if (application === undefined) {
        if (!this.isCreditReady(company, ctx.tick)) continue;
        const bank = this.db.prepare<[string], IdRow>(`
          SELECT id FROM banks WHERE run_id = ? AND status = 'active' ORDER BY id LIMIT 1
        `).get(this.runId);
        if (bank === undefined) {
          throw new EngineError("NOT_FOUND", "founder venture credit requires an active bank");
        }
        const submitted = this.credit.submitApplication({
          applicantKind: "company",
          applicantId: company.id,
          bankId: bank.id,
          purpose: LAUNCH_LOAN_PURPOSE,
          amountCents: LAUNCH_LOAN_AMOUNT_CENTS.toString(),
          termMonths: 12,
        }, ctx, launchEventId);
        this.appendTimeline(ctx, company.id, "loan.application.created", {
          applicationId: submitted.application.id,
          assessmentId: submitted.assessment.id,
          amountCents: submitted.application.amountCents,
          sourceEventId: submitted.application.sourceEventId,
        });
        continue;
      }

      const existingLoan = this.db.prepare<[string, string], IdRow>(`
        SELECT id FROM loans WHERE run_id = ? AND application_id = ?
      `).get(this.runId, application.id);
      if (existingLoan !== undefined) continue;

      switch (application.status) {
        case "submitted": {
          const started = this.credit.beginReview(application.id, ctx);
          this.appendTimeline(ctx, company.id, "loan.application.review_started", {
            applicationId: application.id,
            reviewId: started.review.id,
            officerAgentId: started.review.officerAgentId,
            sourceEventId: started.review.sourceEventId,
          });
          break;
        }
        case "under_review": {
          const decided = this.credit.decideTier1Application(application.id, ctx);
          this.appendTimeline(ctx, company.id, `loan.${decided.decision.outcome}`, {
            applicationId: application.id,
            decisionId: decided.decision.id,
            finalScore: decided.decision.finalScore,
            policyChecks: decided.decision.policyChecks,
            sourceEventId: decided.decision.sourceEventId,
          });
          break;
        }
        case "approved": {
          const attempt = this.credit.tryDisburseApprovedApplication(application.id, ctx);
          if (attempt.kind === "disbursed") {
            this.appendTimeline(ctx, company.id, "loan.disbursed", {
              applicationId: application.id,
              loanId: attempt.loan.id,
              transactionId: attempt.transaction.id,
              principalCents: attempt.loan.principalCents,
              sourceEventId: attempt.loan.sourceEventId,
            });
          } else {
            this.appendTimeline(ctx, company.id, "loan.disbursement.blocked", {
              applicationId: application.id,
              assessmentId: attempt.assessment.id,
              failedBreakers: attempt.assessment.failedBreakers,
              sourceEventId: attempt.sourceEventId,
            });
          }
          break;
        }
        case "rejected":
          break;
      }
    }
  }

  private eligibleCompanies(tick: number): readonly FounderCompanyRow[] {
    return this.db.prepare<[string, number], FounderCompanyRow>(`
      SELECT c.id, c.sector, c.founder_agent_id, c.business_account_id, c.activated_tick
      FROM companies c
      WHERE c.run_id = ? AND c.status = 'active' AND c.business_account_id IS NOT NULL
        AND c.activated_tick IS NOT NULL AND c.activated_tick < ?
        AND EXISTS (
          SELECT 1 FROM goals g
          WHERE g.run_id = c.run_id AND g.agent_id = c.founder_agent_id
            AND g.kind = 'start_business' AND g.status = 'achieved'
        )
      ORDER BY c.activated_tick, c.id
    `).all(this.runId, tick);
  }

  private launchJob(companyId: string): Job | undefined {
    const row = this.db.prepare<[string, string, string], IdRow>(`
      SELECT id FROM jobs WHERE run_id = ? AND employer_id = ? AND title = ?
      ORDER BY id LIMIT 1
    `).get(this.runId, companyId, LAUNCH_JOB_TITLE);
    return row === undefined ? undefined : this.companies.getJob(row.id);
  }

  private launchApplication(jobId: string): JobApplication | undefined {
    return this.companies.listJobApplications(jobId)[0];
  }

  private launchCandidate(founderAgentId: string): IdRow | undefined {
    const labor = this.db.prepare<[string], LaborCountRow>(`
      SELECT
        COUNT(*) AS labor_count,
        SUM(CASE WHEN employment_status = 'unemployed' THEN 1 ELSE 0 END)
          AS unemployed_count
      FROM agents
      WHERE run_id = ? AND employment_status IN ('employed', 'unemployed')
    `).get(this.runId);
    if (labor === undefined || labor.labor_count === 0n || labor.unemployed_count === 0n) {
      return undefined;
    }
    const projectedUnemploymentRateBp =
      (labor.unemployed_count - 1n) * 10_000n / labor.labor_count;
    if (projectedUnemploymentRateBp < MINIMUM_POST_HIRE_UNEMPLOYMENT_RATE_BP) {
      return undefined;
    }
    return this.db.prepare<[string, string], IdRow>(`
      SELECT a.id FROM agents a
      WHERE a.run_id = ? AND a.employment_status = 'unemployed' AND a.id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM job_applications ja
          WHERE ja.run_id = a.run_id AND ja.agent_id = a.id AND ja.status = 'submitted'
        )
      ORDER BY a.id LIMIT 1
    `).get(this.runId, founderAgentId);
  }

  private launchOfferingId(companyId: string): string | undefined {
    return this.db.prepare<[string, string], IdRow>(`
      SELECT id FROM market_offerings
      WHERE run_id = ? AND company_id = ?
      ORDER BY id LIMIT 1
    `).get(this.runId, companyId)?.id;
  }

  private launchProduct(companyId: string): LaunchProduct {
    const primary = this.db.prepare<[string], IdRow>(`
      SELECT c.id FROM companies c
      WHERE c.run_id = ? AND c.status = 'active'
        AND EXISTS (
          SELECT 1 FROM goals g
          WHERE g.run_id = c.run_id AND g.agent_id = c.founder_agent_id
            AND g.kind = 'start_business' AND g.status = 'achieved'
        )
      ORDER BY c.activated_tick, c.id LIMIT 1
    `).get(this.runId);
    if (primary?.id === companyId) {
      return Object.freeze({
        sku: "groceries",
        postedPriceCents: "500",
        unitCostCents: "450",
        productivityMilliunitsPerLaborHour: 12_500,
        capacityUnitsPerTick: 100,
      });
    }
    return Object.freeze({
      sku: "durable_goods",
      postedPriceCents: "50000",
      unitCostCents: "45000",
      productivityMilliunitsPerLaborHour: 250,
      capacityUnitsPerTick: 2,
    });
  }

  private creditApplication(companyId: string): CreditApplicationRow | undefined {
    return this.db.prepare<[string, string, string], CreditApplicationRow>(`
      SELECT id, status FROM loan_applications
      WHERE run_id = ? AND applicant_kind = 'company' AND applicant_id = ? AND purpose = ?
      ORDER BY submitted_tick DESC, id DESC LIMIT 1
    `).get(this.runId, companyId, LAUNCH_LOAN_PURPOSE);
  }

  private isCreditReady(company: FounderCompanyRow, tick: number): boolean {
    const fromTick = Math.max(0, tick - 89);
    const revenue = this.db.prepare<[string, string, number, number], RevenueRow>(`
      SELECT t.tick, l.amount_cents
      FROM ledger_transaction_legs l
      JOIN ledger_transactions t ON t.run_id = l.run_id AND t.id = l.transaction_id
      WHERE l.run_id = ? AND l.account_id = ? AND t.tick BETWEEN ? AND ?
        AND l.direction = 'debit' AND t.kind IN ('purchase', 'row_settlement')
      ORDER BY t.tick, t.id, l.leg_index
    `).all(this.runId, company.business_account_id, fromTick, tick);
    const observedTicks = Math.max(1, tick - fromTick + 1);
    if (observedTicks < 30) return false;
    const revenueTicks = new Set(revenue.map((row) => row.tick.toString())).size;
    const revenueTotal = revenue.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    const annualRevenue = revenueTotal * 360n / BigInt(observedTicks);
    return revenueTicks * 10 >= observedTicks * 6 &&
      annualRevenue >= MINIMUM_ANNUAL_REVENUE_CENTS;
  }

  private entityEventId(type: string, key: string, value: string): string | undefined {
    const rows = this.db.prepare<[string, string], EventRow>(`
      SELECT event_id, payload_canonical FROM events
      WHERE run_id = ? AND type = ? ORDER BY seq DESC
    `).all(this.runId, type);
    for (const row of rows) {
      const payload = canonicalParse(row.payload_canonical);
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
        (payload as Record<string, unknown>)[key] === value) {
        return row.event_id;
      }
    }
    return undefined;
  }

  private requireEntityEventId(type: string, key: string, value: string): string {
    const eventId = this.entityEventId(type, key, value);
    if (eventId === undefined) {
      throw new EngineError("NOT_FOUND", `${type} event for ${key} ${value} is missing`);
    }
    return eventId;
  }

  private appendTimeline(
    ctx: TickContext,
    companyId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.db.prepare(`
      INSERT INTO company_timeline(
        run_id, id, company_id, tick, event_type, payload_canonical
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      ctx.ids.next("ctl"),
      companyId,
      ctx.tick,
      eventType,
      canonicalStringify(payload),
    );
  }
}
