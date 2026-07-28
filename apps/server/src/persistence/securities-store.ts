/** Authoritative WS-901 listing eligibility and security creation store. */

import {
  assessSecuritiesListingEligibility,
  canonicalParse,
  canonicalStringify,
  EngineError,
  listSecurityInputSchema,
  RIVERBEND_SECURITIES_EXCHANGE_ID,
  securitiesListingEligibilityAssessmentSchema,
  securitiesMarketOpenedPayloadSchema,
  securitiesMarketSchema,
  securityListedPayloadSchema,
  securitySchema,
  type ListSecurityInput,
  type SecuritiesListingEligibilityAssessment,
  type SecuritiesMarket,
  type Security,
} from "@worldtangle/shared";
import type { TickContext } from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "./database";

export const RIVERBEND_SECURITIES_PRICE_BAND_BP = 2_000;
export const RIVERBEND_SECURITIES_AUCTION_SCHEDULE = Object.freeze({
  frequencyTicks: 1,
  offsetTick: 0,
});

interface CompanyListingRow {
  readonly company_kind: "opening" | "dynamic";
  readonly total_shares: string;
  readonly status: string | null;
  readonly founded_tick: bigint | null;
  readonly activated_tick: bigint | null;
  readonly wound_down: bigint;
}

interface AccountRow {
  readonly id: string;
  readonly balance_cents: string;
}

interface FlowRow {
  readonly direction: "debit" | "credit";
  readonly amount_cents: string;
  readonly kind: string;
}

interface MarketRow {
  readonly run_id: string;
  readonly id: string;
  readonly kind: "securities";
  readonly operator_institution_id: string;
  readonly auction_schedule_canonical: string;
  readonly price_band_bp: bigint;
  readonly status: "open" | "halted" | "closed";
  readonly opened_tick: bigint;
  readonly source_event_id: string;
}

interface SecurityRow {
  readonly run_id: string;
  readonly id: string;
  readonly market_id: string;
  readonly company_id: string;
  readonly symbol: string;
  readonly shares_listed: string;
  readonly reference_price_cents: string;
  readonly listed_tick: bigint;
  readonly status: "listed" | "suspended" | "delisted";
  readonly eligibility_canonical: string;
  readonly source_event_id: string;
}

export interface ListSecurityCommand extends ListSecurityInput {
  readonly triggerEventId: string;
}

function parseCanonical<T>(
  text: string,
  description: string,
  parse: (input: unknown) => T,
): T {
  try {
    const decoded = canonicalParse(text);
    if (canonicalStringify(decoded) !== text) {
      throw new Error("value is not canonical");
    }
    return parse(decoded);
  } catch (error) {
    throw new EngineError("INTERNAL", `${description} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export class SqliteSecuritiesStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  assess(
    rawInput: ListSecurityInput,
    tick: number,
  ): SecuritiesListingEligibilityAssessment {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "listing tick must be nonnegative");
    }
    const input = listSecurityInputSchema.parse(rawInput);
    const company = this.company(input.companyId);
    const account = this.companyAccount(input.companyId);
    const profit30Cents = this.profit30Cents(account.id, tick);
    const companyActive = company.company_kind === "opening"
      ? company.wound_down === 0n
      : company.status === "active";
    const foundedTick = company.company_kind === "opening"
      ? 0
      : company.activated_tick === null
        ? company.founded_tick === null
          ? 0
          : toSafeNumber(company.founded_tick, "company founding tick")
        : toSafeNumber(company.activated_tick, "company activation tick");
    return assessSecuritiesListingEligibility({
      companyId: input.companyId,
      assessedTick: tick,
      foundedTick,
      companyActive,
      profit30Cents,
      capitalCents: account.balance_cents,
      totalShares: company.total_shares,
      requestedShares: input.sharesListed,
    });
  }

  listSecurity(rawInput: ListSecurityCommand, ctx: TickContext): Security {
    this.assertContext(ctx);
    const input = listSecurityInputSchema.parse({
      companyId: rawInput.companyId,
      symbol: rawInput.symbol,
      sharesListed: rawInput.sharesListed,
      referencePriceCents: rawInput.referencePriceCents,
    });
    this.assertTrigger(rawInput.triggerEventId);
    const eligibility = this.assess(input, ctx.tick);
    if (!eligibility.eligible) {
      throw new EngineError(
        "VALIDATION_FAILED",
        `company ${input.companyId} is not eligible to list`,
        { assessment: eligibility },
      );
    }
    const duplicate = this.db.prepare<
      [string, string, string],
      { id: string }
    >(`
      SELECT id FROM securities
      WHERE run_id = ? AND (company_id = ? OR symbol = ?)
      ORDER BY id LIMIT 1
    `).get(this.runId, input.companyId, input.symbol);
    if (duplicate !== undefined) {
      throw new EngineError(
        "CONFLICT",
        `company ${input.companyId} or symbol ${input.symbol} is already listed`,
      );
    }

    return this.atomic(() => {
      let market = this.market();
      if (market === null) {
        const marketId = ctx.ids.next("mkt");
        const openedPayload = securitiesMarketOpenedPayloadSchema.parse({
          marketId,
          operatorInstitutionId: RIVERBEND_SECURITIES_EXCHANGE_ID,
          priceBandBp: RIVERBEND_SECURITIES_PRICE_BAND_BP,
          openedTick: ctx.tick,
        });
        const openedEvent = ctx.emit(
          "market.securities.opened",
          openedPayload,
          {
            actor: {
              kind: "institution",
              id: RIVERBEND_SECURITIES_EXCHANGE_ID,
            },
            schemaVersion: 1,
            correlationId: marketId,
            causationId: rawInput.triggerEventId,
          },
        );
        market = securitiesMarketSchema.parse({
          id: marketId,
          runId: this.runId,
          kind: "securities",
          operatorInstitutionId: RIVERBEND_SECURITIES_EXCHANGE_ID,
          auctionSchedule: RIVERBEND_SECURITIES_AUCTION_SCHEDULE,
          priceBandBp: RIVERBEND_SECURITIES_PRICE_BAND_BP,
          status: "open",
          openedTick: ctx.tick,
          sourceEventId: openedEvent.eventId,
        });
        this.insertMarket(market);
      }

      const securityId = ctx.ids.next("sec");
      const listedPayload = securityListedPayloadSchema.parse({
        securityId,
        companyId: input.companyId,
        symbol: input.symbol,
        sharesListed: input.sharesListed,
        referencePrice: input.referencePriceCents,
      });
      const listedEvent = ctx.emit("security.listed", listedPayload, {
        actor: {
          kind: "institution",
          id: RIVERBEND_SECURITIES_EXCHANGE_ID,
        },
        schemaVersion: 1,
        correlationId: securityId,
        causationId: rawInput.triggerEventId,
      });
      const security = securitySchema.parse({
        id: securityId,
        runId: this.runId,
        marketId: market.id,
        companyId: input.companyId,
        symbol: input.symbol,
        sharesListed: input.sharesListed,
        referencePriceCents: input.referencePriceCents,
        listedTick: ctx.tick,
        status: "listed",
        eligibility,
        sourceEventId: listedEvent.eventId,
      });
      this.insertSecurity(security);
      return security;
    });
  }

  market(): SecuritiesMarket | null {
    const row = this.db.prepare<[string], MarketRow>(`
      SELECT run_id, id, kind, operator_institution_id,
        auction_schedule_canonical, price_band_bp, status, opened_tick,
        source_event_id
      FROM securities_markets
      WHERE run_id = ? AND kind = 'securities'
    `).get(this.runId);
    return row === undefined ? null : this.mapMarket(row);
  }

  get(securityId: string): Security {
    const row = this.db.prepare<[string, string], SecurityRow>(`
      SELECT run_id, id, market_id, company_id, symbol, shares_listed,
        reference_price_cents, listed_tick, status, eligibility_canonical,
        source_event_id
      FROM securities WHERE run_id = ? AND id = ?
    `).get(this.runId, securityId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `security ${securityId} does not exist`);
    }
    return this.mapSecurity(row);
  }

  list(): readonly Security[] {
    return Object.freeze(this.db.prepare<[string], SecurityRow>(`
      SELECT run_id, id, market_id, company_id, symbol, shares_listed,
        reference_price_cents, listed_tick, status, eligibility_canonical,
        source_event_id
      FROM securities WHERE run_id = ? ORDER BY listed_tick, id
    `).all(this.runId).map((row) => this.mapSecurity(row)));
  }

  private company(companyId: string): CompanyListingRow {
    const row = this.db.prepare<[string, string], CompanyListingRow>(`
      SELECT cap.company_kind, cap.total_shares, company.status,
        company.founded_tick, company.activated_tick,
        CAST(EXISTS (
          SELECT 1 FROM company_wind_downs wind_down
          WHERE wind_down.run_id = cap.run_id
            AND wind_down.company_id = cap.company_id
        ) AS INTEGER) AS wound_down
      FROM company_cap_tables cap
      LEFT JOIN companies company
        ON company.run_id = cap.run_id AND company.id = cap.company_id
      WHERE cap.run_id = ? AND cap.company_id = ?
    `).get(this.runId, companyId);
    if (row === undefined) {
      throw new EngineError(
        "NOT_FOUND",
        `cap table for company ${companyId} does not exist`,
      );
    }
    return row;
  }

  private companyAccount(companyId: string): AccountRow {
    const row = this.db.prepare<[string, string], AccountRow>(`
      SELECT id, balance_cents FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company' AND owner_id = ?
        AND account_type = 'checking' AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(this.runId, companyId);
    if (row === undefined) {
      throw new EngineError(
        "CONFLICT",
        `company ${companyId} lacks an active checking account`,
      );
    }
    return row;
  }

  private profit30Cents(accountId: string, assessedTick: number): string {
    const flows = this.db.prepare<
      [string, string, number, number],
      FlowRow
    >(`
      SELECT leg.direction, leg.amount_cents, transaction_row.kind
      FROM ledger_transaction_legs leg
      JOIN ledger_transactions transaction_row
        ON transaction_row.run_id = leg.run_id
        AND transaction_row.id = leg.transaction_id
      WHERE leg.run_id = ? AND leg.account_id = ?
        AND transaction_row.tick BETWEEN ? AND ?
      ORDER BY transaction_row.tick, transaction_row.id, leg.leg_index
    `).all(
      this.runId,
      accountId,
      Math.max(0, assessedTick - 29),
      assessedTick,
    );
    let revenue = 0n;
    let costs = 0n;
    for (const flow of flows) {
      const amount = BigInt(flow.amount_cents);
      if (
        flow.direction === "debit" &&
        (flow.kind === "purchase" || flow.kind === "row_settlement")
      ) {
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
    return (revenue - costs).toString();
  }

  private assertTrigger(eventId: string): void {
    const event = this.db.prepare<[string, string], { event_id: string }>(`
      SELECT event_id FROM events WHERE run_id = ? AND event_id = ?
    `).get(this.runId, eventId);
    if (event === undefined) {
      throw new EngineError(
        "NOT_FOUND",
        `listing trigger event ${eventId} does not exist`,
      );
    }
  }

  private insertMarket(market: SecuritiesMarket): void {
    this.db.prepare(`
      INSERT INTO securities_markets(
        run_id, id, kind, operator_institution_id,
        auction_schedule_canonical, price_band_bp, status, opened_tick,
        source_event_id
      ) VALUES (
        @runId, @id, @kind, @operatorInstitutionId,
        @auctionScheduleCanonical, @priceBandBp, @status, @openedTick,
        @sourceEventId
      )
    `).run({
      ...market,
      auctionScheduleCanonical: canonicalStringify(market.auctionSchedule),
    });
  }

  private insertSecurity(security: Security): void {
    this.db.prepare(`
      INSERT INTO securities(
        run_id, id, market_id, company_id, symbol, shares_listed,
        reference_price_cents, listed_tick, status, eligibility_canonical,
        source_event_id
      ) VALUES (
        @runId, @id, @marketId, @companyId, @symbol, @sharesListed,
        @referencePriceCents, @listedTick, @status, @eligibilityCanonical,
        @sourceEventId
      )
    `).run({
      ...security,
      eligibilityCanonical: canonicalStringify(security.eligibility),
    });
  }

  private mapMarket(row: MarketRow): SecuritiesMarket {
    return securitiesMarketSchema.parse({
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      operatorInstitutionId: row.operator_institution_id,
      auctionSchedule: parseCanonical(
        row.auction_schedule_canonical,
        `market ${row.id} auction schedule`,
        (input) => securitiesMarketSchema.shape.auctionSchedule.parse(input),
      ),
      priceBandBp: toSafeNumber(row.price_band_bp, "market price band"),
      status: row.status,
      openedTick: toSafeNumber(row.opened_tick, "market opening tick"),
      sourceEventId: row.source_event_id,
    });
  }

  private mapSecurity(row: SecurityRow): Security {
    return securitySchema.parse({
      id: row.id,
      runId: row.run_id,
      marketId: row.market_id,
      companyId: row.company_id,
      symbol: row.symbol,
      sharesListed: row.shares_listed,
      referencePriceCents: row.reference_price_cents,
      listedTick: toSafeNumber(row.listed_tick, "security listing tick"),
      status: row.status,
      eligibility: parseCanonical(
        row.eligibility_canonical,
        `security ${row.id} eligibility`,
        (input) => securitiesListingEligibilityAssessmentSchema.parse(input),
      ),
      sourceEventId: row.source_event_id,
    });
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("CONFLICT", "securities context belongs to another run");
    }
  }

  private atomic<T>(operation: () => T): T {
    return this.db.inTransaction
      ? operation()
      : this.db.transaction(operation).immediate();
  }
}
