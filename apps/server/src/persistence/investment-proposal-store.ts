/** Authoritative WS-802 founder proposal and bounded investment-negotiation pipeline. */

import {
  canonicalParse,
  canonicalStringify,
  EngineError,
  investmentEquityBasisPoints,
  investmentProposalAgreedPayloadSchema,
  investmentProposalSchema,
  investmentProposedPayloadSchema,
  investmentRejectedPayloadSchema,
  investmentStructuredTermsSchema,
  type InvestmentProposal,
  type InvestmentProposalRejectionReason,
  type InvestmentStructuredTerms,
} from "@worldtangle/shared";
import {
  deterministicConversationOutcome,
  termsWithinConversationBounds,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteConversationStore } from "./conversation-store";
import { toSafeNumber, type WorldDatabase } from "./database";
import {
  FOUNDRY_CAPITAL_ID,
  SqliteVentureStore,
} from "./venture-store";

export const INVESTMENT_PITCH_DELAY_TICKS = 30;
export const INVESTMENT_PROPOSAL_LIFETIME_TICKS = 14;
export const INVESTMENT_NEGOTIATION_MAX_TURNS = 6;
export const INVESTMENT_NEGOTIATION_OUTPUT_TOKEN_BUDGET = 4_096;
const SIGNED_SQLITE_MAXIMUM = 9_223_372_036_854_775_807n;

interface ProposalRow {
  readonly run_id: string;
  readonly id: string;
  readonly company_id: string;
  readonly founder_agent_id: string;
  readonly firm_id: string;
  readonly fund_id: string;
  readonly vc_partner_agent_id: string;
  readonly ask_amount_cents: string;
  readonly pre_money_valuation_cents: string;
  readonly initial_equity_basis_points: bigint;
  readonly status: string;
  readonly negotiation_conversation_id: string | null;
  readonly final_terms_canonical: string | null;
  readonly proposed_tick: bigint;
  readonly expires_tick: bigint;
  readonly revision: bigint;
  readonly source_event_id: string;
  readonly last_transition_event_id: string;
}

interface CompanyCandidateRow {
  readonly id: string;
  readonly founder_agent_id: string;
  readonly founding_capital_cents: string;
  readonly activated_tick: bigint;
  readonly activation_event_id: string | null;
}

interface PartnerRow {
  readonly id: string;
}

export interface ProposeInvestmentInput {
  readonly companyId: string;
  readonly founderAgentId: string;
  readonly fundId: string;
  readonly vcPartnerAgentId: string;
  readonly askAmountCents: string;
  readonly preMoneyValuationCents: string;
  readonly triggerEventId: string;
  readonly expiresTick?: number;
  readonly evidenceRefs?: readonly string[];
}

export interface InvestmentProposalTickResult {
  readonly transitioned: readonly InvestmentProposal[];
  readonly proposed: InvestmentProposal | null;
}

export interface InvestmentProposalValidationFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidence(refs: readonly (string | undefined)[]): readonly string[] {
  return Object.freeze(
    [...new Set(refs.filter((ref): ref is string => ref !== undefined))]
      .sort(compareCodeUnit),
  );
}

function boundedMinimum(value: string): string {
  const amount = BigInt(value);
  const minimum = amount * 4n / 5n;
  return (minimum < 1n ? 1n : minimum).toString();
}

function parseFinalTerms(text: string, proposalId: string): InvestmentStructuredTerms {
  try {
    const parsed = canonicalParse(text);
    if (canonicalStringify(parsed) !== text) throw new Error("value is not canonical");
    return investmentStructuredTermsSchema.parse(parsed);
  } catch (error) {
    throw new EngineError(
      "INTERNAL",
      `investment proposal ${proposalId} final terms are invalid`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export class SqliteInvestmentProposalStore {
  private readonly conversations: SqliteConversationStore;
  private readonly venture: SqliteVentureStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.conversations = new SqliteConversationStore(db, runId);
    this.venture = new SqliteVentureStore(db, runId);
  }

  propose(input: ProposeInvestmentInput, ctx: TickContext): InvestmentProposal {
    this.assertContext(ctx);
    this.assertTrigger(input.triggerEventId);
    this.assertCompanyFounder(input.companyId, input.founderAgentId);
    const fund = this.venture.getFund(input.fundId);
    const firm = this.venture.getFirm(fund.firmId);
    if (firm.status !== "active" || fund.status !== "open") {
      throw new EngineError("CONFLICT", "investment proposal requires an active firm and open fund");
    }
    const initialEquityBasisPoints = investmentEquityBasisPoints(
      input.askAmountCents,
      input.preMoneyValuationCents,
    );
    const available = BigInt(fund.fundSizeCents) - BigInt(fund.deployedCents);
    if (BigInt(input.askAmountCents) > available) {
      throw new EngineError("LIMIT_EXCEEDED", "investment ask exceeds available fund capital");
    }
    this.assertPartner(input.vcPartnerAgentId, firm.id);
    const duplicate = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM investment_proposals
      WHERE run_id = ? AND company_id = ?
        AND status IN ('proposed', 'negotiating', 'agreed')
      LIMIT 1
    `).get(this.runId, input.companyId);
    if (duplicate !== undefined) {
      throw new EngineError(
        "CONFLICT",
        `company ${input.companyId} already has an active investment proposal`,
      );
    }

    const expiresTick = input.expiresTick ??
      ctx.tick + INVESTMENT_PROPOSAL_LIFETIME_TICKS;
    if (!Number.isSafeInteger(expiresTick) || expiresTick <= ctx.tick) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "investment proposal expiry must be a later safe tick",
      );
    }
    const proposalId = ctx.ids.next("prop");
    const payload = investmentProposedPayloadSchema.parse({
      proposalId,
      companyId: input.companyId,
      founderAgentId: input.founderAgentId,
      firmId: firm.id,
      fundId: fund.id,
      vcPartnerAgentId: input.vcPartnerAgentId,
      askAmountCents: input.askAmountCents,
      preMoneyValuationCents: input.preMoneyValuationCents,
      equityBasisPoints: initialEquityBasisPoints,
      proposedTick: ctx.tick,
      expiresTick,
      evidence: evidence([
        input.triggerEventId,
        fund.sourceEventId,
        ...(input.evidenceRefs ?? []),
      ]),
    });

    return this.atomic(() => {
      const proposedEvent = ctx.emit("investment.proposed", payload, {
        actor: { kind: "agent", id: input.founderAgentId },
        schemaVersion: 1,
        correlationId: proposalId,
        causationId: input.triggerEventId,
      });
      const proposed = investmentProposalSchema.parse({
        id: proposalId,
        runId: this.runId,
        companyId: input.companyId,
        founderAgentId: input.founderAgentId,
        firmId: firm.id,
        fundId: fund.id,
        vcPartnerAgentId: input.vcPartnerAgentId,
        askAmountCents: input.askAmountCents,
        preMoneyValuationCents: input.preMoneyValuationCents,
        initialEquityBasisPoints,
        status: "proposed",
        negotiationConversationId: null,
        finalTerms: null,
        proposedTick: ctx.tick,
        expiresTick,
        sourceEventId: proposedEvent.eventId,
        lastTransitionEventId: proposedEvent.eventId,
      });
      this.insert(proposed);
      const conversation = this.conversations.open({
        participantAgentIds: [input.founderAgentId, input.vcPartnerAgentId],
        topic: "investment",
        initiatingTriggerEventId: proposedEvent.eventId,
        termBounds: {
          kind: "investment",
          referenceId: proposalId,
          minAmountCents: boundedMinimum(input.askAmountCents),
          maxAmountCents: input.askAmountCents,
          minPreMoneyValuationCents: boundedMinimum(input.preMoneyValuationCents),
          maxPreMoneyValuationCents: input.preMoneyValuationCents,
        },
        maxTurns: INVESTMENT_NEGOTIATION_MAX_TURNS,
        outputTokenBudget: INVESTMENT_NEGOTIATION_OUTPUT_TOKEN_BUDGET,
        startTick: ctx.tick,
      }, ctx);
      const updated = this.db.prepare(`
        UPDATE investment_proposals
        SET status = 'negotiating', negotiation_conversation_id = @conversationId,
          revision = revision + 1, last_transition_event_id = @transitionEventId
        WHERE run_id = @runId AND id = @id AND status = 'proposed' AND revision = 0
      `).run({
        runId: this.runId,
        id: proposed.id,
        conversationId: conversation.id,
        transitionEventId: conversation.sourceEventId,
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale investment proposal ${proposed.id}`);
      }
      return this.get(proposed.id);
    });
  }

  processTick(ctx: TickContext): InvestmentProposalTickResult {
    this.assertContext(ctx);
    return this.atomic(() => {
      const transitioned: InvestmentProposal[] = [];
      for (const proposal of this.list("negotiating")) {
        const conversation = this.conversations.get(
          proposal.negotiationConversationId!,
        );
        if (conversation.status === "active" && ctx.tick < proposal.expiresTick) {
          continue;
        }
        if (conversation.status === "active") {
          this.conversations.close({
            conversationId: conversation.id,
            closeReason: "expired",
            outcome: deterministicConversationOutcome(
              "expired",
              null,
              "The investment proposal reached its deterministic expiry tick.",
            ),
          }, ctx);
        }
        transitioned.push(this.transitionTerminal(proposal, ctx));
      }
      return Object.freeze({
        transitioned: Object.freeze(transitioned),
        proposed: this.proposeEligible(ctx),
      });
    });
  }

  get(proposalId: string): InvestmentProposal {
    const row = this.db.prepare<[string, string], ProposalRow>(`
      SELECT * FROM investment_proposals WHERE run_id = ? AND id = ?
    `).get(this.runId, proposalId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `investment proposal ${proposalId} does not exist`);
    }
    return this.mapRow(row);
  }

  list(status?: InvestmentProposal["status"]): readonly InvestmentProposal[] {
    const rows = status === undefined
      ? this.db.prepare<[string], ProposalRow>(`
          SELECT * FROM investment_proposals
          WHERE run_id = ? ORDER BY proposed_tick, id
        `).all(this.runId)
      : this.db.prepare<[string, string], ProposalRow>(`
          SELECT * FROM investment_proposals
          WHERE run_id = ? AND status = ? ORDER BY proposed_tick, id
        `).all(this.runId, status);
    return Object.freeze(rows.map((row) => this.mapRow(row)));
  }

  rejectAgreed(
    proposalId: string,
    validation: InvestmentProposalValidationFailure,
    ctx: TickContext,
  ): InvestmentProposal {
    this.assertContext(ctx);
    return this.atomic(() => {
      const proposal = this.get(proposalId);
      if (proposal.status !== "agreed" || proposal.negotiationConversationId === null) {
        throw new EngineError(
          "CONFLICT",
          `investment proposal ${proposalId} is not awaiting closing validation`,
        );
      }
      const conversation = this.conversations.get(proposal.negotiationConversationId);
      const payload = investmentRejectedPayloadSchema.parse({
        proposalId: proposal.id,
        companyId: proposal.companyId,
        negotiationConversationId: proposal.negotiationConversationId,
        reason: "terms_invalid",
        status: "rejected",
        validation,
        evidence: evidence([
          proposal.sourceEventId,
          conversation.sourceEventId,
          proposal.lastTransitionEventId,
        ]),
      });
      const rejected = ctx.emit("investment.rejected", payload, {
        actor: { kind: "system", id: "investment-closing" },
        schemaVersion: 1,
        correlationId: proposal.id,
        causationId: proposal.lastTransitionEventId,
      });
      const updated = this.db.prepare(`
        UPDATE investment_proposals
        SET status = 'rejected', final_terms_canonical = NULL,
          revision = revision + 1, last_transition_event_id = @transitionEventId
        WHERE run_id = @runId AND id = @id AND status = 'agreed'
      `).run({
        runId: this.runId,
        id: proposal.id,
        transitionEventId: rejected.eventId,
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale investment proposal ${proposal.id}`);
      }
      return this.get(proposal.id);
    });
  }

  private proposeEligible(ctx: TickContext): InvestmentProposal | null {
    const candidates = this.db.prepare<[string, number], CompanyCandidateRow>(`
      SELECT company.id, company.founder_agent_id, company.founding_capital_cents,
        company.activated_tick,
        (
          SELECT event.event_id FROM events event
          WHERE event.run_id = company.run_id AND event.type = 'company.activated'
            AND json_extract(event.payload_canonical, '$.companyId') = company.id
          ORDER BY event.seq DESC LIMIT 1
        ) AS activation_event_id
      FROM companies company
      WHERE company.run_id = ? AND company.status = 'active'
        AND company.activated_tick IS NOT NULL
        AND company.activated_tick + ${INVESTMENT_PITCH_DELAY_TICKS} <= ?
        AND NOT EXISTS (
          SELECT 1 FROM investment_proposals proposal
          WHERE proposal.run_id = company.run_id AND proposal.company_id = company.id
        )
      ORDER BY company.activated_tick, company.id
    `).all(this.runId, ctx.tick);
    const partners = this.db.prepare<[string, string], PartnerRow>(`
      SELECT id FROM agents
      WHERE run_id = ? AND organization_id = ? AND role_code = 'vc.partner'
        AND employment_status = 'employed'
      ORDER BY id
    `).all(this.runId, FOUNDRY_CAPITAL_ID);
    if (partners.length === 0) return null;

    const funds = this.venture.listFunds(FOUNDRY_CAPITAL_ID);
    for (const company of candidates) {
      if (company.activation_event_id === null) continue;
      const ask = BigInt(company.founding_capital_cents);
      const preMoney = ask * 4n;
      if (preMoney > SIGNED_SQLITE_MAXIMUM) continue;
      const fund = funds.find((candidate) => (
        candidate.status === "open" &&
        BigInt(candidate.fundSizeCents) - BigInt(candidate.deployedCents) >= ask
      ));
      if (fund === undefined) return null;
      const partner = partners.find((candidate) => this.partnerAvailable(
        company.founder_agent_id,
        candidate.id,
        ctx.tick,
      ));
      if (partner === undefined) continue;
      return this.propose({
        companyId: company.id,
        founderAgentId: company.founder_agent_id,
        fundId: fund.id,
        vcPartnerAgentId: partner.id,
        askAmountCents: ask.toString(),
        preMoneyValuationCents: preMoney.toString(),
        triggerEventId: company.activation_event_id,
        evidenceRefs: [fund.sourceEventId],
      }, ctx);
    }
    return null;
  }

  private partnerAvailable(founderId: string, partnerId: string, tick: number): boolean {
    const conflict = this.db.prepare<
      Record<string, string | number>,
      { id: string }
    >(`
      SELECT id FROM conversations
      WHERE run_id = @runId AND (
        (
          start_tick = @tick AND (
            participant_a_id IN (@founderId, @partnerId) OR
            participant_b_id IN (@founderId, @partnerId)
          )
        ) OR (
          topic = 'investment' AND (
            (participant_a_id = @founderId AND participant_b_id = @partnerId) OR
            (participant_a_id = @partnerId AND participant_b_id = @founderId)
          ) AND (
            status = 'active' OR
            (end_tick IS NOT NULL AND end_tick > @cooldownBoundary)
          )
        )
      )
      ORDER BY id LIMIT 1
    `).get({
      runId: this.runId,
      tick,
      founderId,
      partnerId,
      cooldownBoundary: tick - 7,
    });
    return conflict === undefined;
  }

  private transitionTerminal(
    proposal: InvestmentProposal,
    ctx: TickContext,
  ): InvestmentProposal {
    const conversation = this.conversations.get(proposal.negotiationConversationId!);
    if (conversation.status === "active" || conversation.outcome === null) {
      throw new EngineError("CONFLICT", "investment negotiation is not terminal");
    }
    const terminalEventId = this.terminalEventId(conversation.id);
    const terms = conversation.outcome.structuredTerms;
    if (conversation.outcome.kind === "agreement" && terms !== null) {
      const parsed = investmentStructuredTermsSchema.safeParse(terms);
      if (
        parsed.success &&
        parsed.data.referenceId === proposal.id &&
        termsWithinConversationBounds(conversation.termBounds, parsed.data)
      ) {
        const payload = investmentProposalAgreedPayloadSchema.parse({
          proposalId: proposal.id,
          companyId: proposal.companyId,
          negotiationConversationId: conversation.id,
          finalTerms: parsed.data,
          evidence: evidence([
            proposal.sourceEventId,
            conversation.sourceEventId,
            terminalEventId,
          ]),
        });
        const agreed = ctx.emit("investment.proposal.agreed", payload, {
          actor: { kind: "institution", id: proposal.firmId },
          schemaVersion: 1,
          correlationId: proposal.id,
          causationId: terminalEventId,
        });
        const updated = this.db.prepare(`
          UPDATE investment_proposals
          SET status = 'agreed', final_terms_canonical = @finalTerms,
            revision = revision + 1, last_transition_event_id = @transitionEventId
          WHERE run_id = @runId AND id = @id AND status = 'negotiating'
        `).run({
          runId: this.runId,
          id: proposal.id,
          finalTerms: canonicalStringify(parsed.data),
          transitionEventId: agreed.eventId,
        });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", `stale investment proposal ${proposal.id}`);
        }
        return this.get(proposal.id);
      }
      return this.reject(
        proposal,
        "terms_invalid",
        "rejected",
        terminalEventId,
        ctx,
      );
    }
    const expired = conversation.closeReason === "expired";
    const reason: InvestmentProposalRejectionReason = expired
      ? "proposal_expired"
      : conversation.closeReason === "declined"
        ? "negotiation_declined"
        : conversation.outcome.kind === "escalate"
          ? "negotiation_escalated"
          : "negotiation_no_agreement";
    return this.reject(
      proposal,
      reason,
      expired ? "expired" : "rejected",
      terminalEventId,
      ctx,
    );
  }

  private reject(
    proposal: InvestmentProposal,
    reason: InvestmentProposalRejectionReason,
    status: "rejected" | "expired",
    terminalEventId: string,
    ctx: TickContext,
  ): InvestmentProposal {
    const payload = investmentRejectedPayloadSchema.parse({
      proposalId: proposal.id,
      companyId: proposal.companyId,
      negotiationConversationId: proposal.negotiationConversationId,
      reason,
      status,
      evidence: evidence([
        proposal.sourceEventId,
        this.conversations.get(proposal.negotiationConversationId!).sourceEventId,
        terminalEventId,
      ]),
    });
    const rejected = ctx.emit("investment.rejected", payload, {
      actor: { kind: "system", id: "investment-pipeline" },
      schemaVersion: 1,
      correlationId: proposal.id,
      causationId: terminalEventId,
    });
    const updated = this.db.prepare(`
      UPDATE investment_proposals
      SET status = @status, revision = revision + 1,
        last_transition_event_id = @transitionEventId
      WHERE run_id = @runId AND id = @id AND status = 'negotiating'
    `).run({
      runId: this.runId,
      id: proposal.id,
      status,
      transitionEventId: rejected.eventId,
    });
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", `stale investment proposal ${proposal.id}`);
    }
    return this.get(proposal.id);
  }

  private terminalEventId(conversationId: string): string {
    const eventId = this.db.prepare<
      [string, string],
      { terminal_event_id: string | null }
    >(`
      SELECT terminal_event_id FROM conversations WHERE run_id = ? AND id = ?
    `).get(this.runId, conversationId)?.terminal_event_id;
    if (eventId === undefined || eventId === null) {
      throw new EngineError(
        "INTERNAL",
        `investment negotiation ${conversationId} lacks terminal evidence`,
      );
    }
    return eventId;
  }

  private assertContext(ctx: TickContext): void {
    if (ctx.runId !== this.runId) {
      throw new EngineError("VALIDATION_FAILED", "investment context belongs to another run");
    }
  }

  private assertTrigger(eventId: string): void {
    const row = this.db.prepare<[string, string], { event_id: string }>(`
      SELECT event_id FROM events WHERE run_id = ? AND event_id = ?
    `).get(this.runId, eventId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `investment trigger event ${eventId} does not exist`);
    }
  }

  private assertCompanyFounder(companyId: string, founderAgentId: string): void {
    const row = this.db.prepare<
      [string, string, string],
      { id: string }
    >(`
      SELECT cap.company_id AS id
      FROM company_cap_tables cap
      JOIN ownership_stakes stake
        ON stake.run_id = cap.run_id AND stake.company_id = cap.company_id
      WHERE cap.run_id = ? AND cap.company_id = ?
        AND stake.holder_kind = 'agent' AND stake.holder_id = ?
        AND stake.acquired_via = 'founding'
        AND (
          cap.company_kind = 'opening' OR EXISTS (
            SELECT 1 FROM companies company
            WHERE company.run_id = cap.run_id AND company.id = cap.company_id
              AND company.status = 'active'
          )
        )
      LIMIT 1
    `).get(this.runId, companyId, founderAgentId);
    if (row === undefined) {
      throw new EngineError(
        "NOT_FOUND",
        `active company ${companyId} is not controlled by founder ${founderAgentId}`,
      );
    }
  }

  private assertPartner(partnerId: string, firmId: string): void {
    const row = this.db.prepare<[string, string, string], { id: string }>(`
      SELECT id FROM agents
      WHERE run_id = ? AND id = ? AND organization_id = ?
        AND role_code = 'vc.partner' AND employment_status = 'employed'
    `).get(this.runId, partnerId, firmId);
    if (row === undefined) {
      throw new EngineError("PERMISSION_DENIED", `agent ${partnerId} is not an active VC partner`);
    }
  }

  private insert(proposal: InvestmentProposal): void {
    this.db.prepare(`
      INSERT INTO investment_proposals(
        run_id, id, company_id, founder_agent_id, firm_id, fund_id,
        vc_partner_agent_id, ask_amount_cents, pre_money_valuation_cents,
        initial_equity_basis_points, status, negotiation_conversation_id,
        final_terms_canonical, proposed_tick, expires_tick, revision,
        source_event_id, last_transition_event_id
      ) VALUES (
        @runId, @id, @companyId, @founderAgentId, @firmId, @fundId,
        @vcPartnerAgentId, @askAmountCents, @preMoneyValuationCents,
        @initialEquityBasisPoints, @status, NULL, NULL, @proposedTick,
        @expiresTick, 0, @sourceEventId, @lastTransitionEventId
      )
    `).run(proposal);
  }

  private mapRow(row: ProposalRow): InvestmentProposal {
    return investmentProposalSchema.parse({
      id: row.id,
      runId: row.run_id,
      companyId: row.company_id,
      founderAgentId: row.founder_agent_id,
      firmId: row.firm_id,
      fundId: row.fund_id,
      vcPartnerAgentId: row.vc_partner_agent_id,
      askAmountCents: row.ask_amount_cents,
      preMoneyValuationCents: row.pre_money_valuation_cents,
      initialEquityBasisPoints: toSafeNumber(
        row.initial_equity_basis_points,
        "investment proposal equity basis points",
      ),
      status: row.status,
      negotiationConversationId: row.negotiation_conversation_id,
      finalTerms: row.final_terms_canonical === null
        ? null
        : parseFinalTerms(row.final_terms_canonical, row.id),
      proposedTick: toSafeNumber(row.proposed_tick, "investment proposal tick"),
      expiresTick: toSafeNumber(row.expires_tick, "investment proposal expiry tick"),
      sourceEventId: row.source_event_id,
      lastTransitionEventId: row.last_transition_event_id,
    });
  }

  private atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
