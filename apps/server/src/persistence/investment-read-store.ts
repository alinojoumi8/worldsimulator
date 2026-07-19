/** Read-only WS-805 projection over authoritative proposal, ownership, and cash journals. */

import {
  canonicalParse,
  EngineError,
  eventIdSchema,
  investmentCapTableViewSchema,
  investmentCompletedPayloadSchema,
  investmentDecisionEvidenceSchema,
  investmentDistributionListItemSchema,
  investmentListItemSchema,
  investmentProposalListItemSchema,
  investmentRejectedPayloadSchema,
  investmentTermsDiffSchema,
  investmentTimelineItemSchema,
  type CapTableSnapshot,
  type InvestmentCapTableView,
  type InvestmentDetailResponse,
  type InvestmentDistributionDetailResponse,
  type InvestmentDistributionListItem,
  type InvestmentDistributionListQuery,
  type InvestmentListItem,
  type InvestmentListQuery,
  type InvestmentProposal,
  type InvestmentProposalDetailResponse,
  type InvestmentProposalListItem,
  type InvestmentProposalListQuery,
  type InvestmentTimelineItem,
} from "@worldtangle/shared";
import { SqliteConversationStore } from "./conversation-store";
import { toSafeNumber, type WorldDatabase } from "./database";
import { SqliteInvestmentDistributionStore } from "./investment-distribution-store";
import { SqliteInvestmentProposalStore } from "./investment-proposal-store";
import { SqliteInvestmentStore } from "./investment-store";
import { SqliteVentureStore } from "./venture-store";

interface NameRow {
  readonly id: string;
  readonly name: string;
}

interface EventRow {
  readonly event_id: string;
  readonly tick: bigint;
  readonly type: string;
  readonly actor_kind: "agent" | "institution" | "system" | "admin";
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload_canonical: string;
}

type ProposalDetail = Omit<InvestmentProposalDetailResponse, "meta">;
type InvestmentDetail = Omit<InvestmentDetailResponse, "meta">;
type DistributionDetail = Omit<InvestmentDistributionDetailResponse, "meta">;

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function signedDifference(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evidenceFromPayload(payloadCanonical: string): readonly string[] {
  const payload = canonicalParse(payloadCanonical);
  if (!isRecord(payload) || !Array.isArray(payload["evidence"])) return [];
  return Object.freeze(
    [...new Set(payload["evidence"].filter((value): value is string => (
      typeof value === "string" && eventIdSchema.safeParse(value).success
    )))].sort(compareCodeUnit),
  );
}

function openingBusinessName(companyId: string): string {
  const words = companyId.slice("biz_".length).split("_")
    .filter((word) => word.length > 0);
  const name = words.map((word) => (
    `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  )).join(" ");
  if (name.length === 0) {
    throw new EngineError("INTERNAL", `opening business ${companyId} has no display name`);
  }
  return name;
}

export class SqliteInvestmentReadStore {
  private readonly proposals: SqliteInvestmentProposalStore;
  private readonly investments: SqliteInvestmentStore;
  private readonly distributions: SqliteInvestmentDistributionStore;
  private readonly conversations: SqliteConversationStore;
  private readonly venture: SqliteVentureStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.proposals = new SqliteInvestmentProposalStore(db, runId);
    this.investments = new SqliteInvestmentStore(db, runId);
    this.distributions = new SqliteInvestmentDistributionStore(db, runId);
    this.conversations = new SqliteConversationStore(db, runId);
    this.venture = new SqliteVentureStore(db, runId);
  }

  listProposals(query: InvestmentProposalListQuery): readonly InvestmentProposalListItem[] {
    return Object.freeze(this.proposals.list(query.status)
      .filter((proposal) => query.companyId === undefined || proposal.companyId === query.companyId)
      .map((proposal) => this.proposalItem(proposal)));
  }

  getProposal(proposalId: string): ProposalDetail {
    const proposal = this.proposals.get(proposalId);
    const item = this.proposalItem(proposal);
    const conversation = proposal.negotiationConversationId === null
      ? null
      : this.conversations.get(proposal.negotiationConversationId);
    const transition = this.event(proposal.lastTransitionEventId);
    let rejectionReason: ProposalDetail["decision"]["rejectionReason"] = null;
    let validation: ProposalDetail["decision"]["validation"] = null;
    let decisionEvidence = evidenceFromPayload(transition.payload_canonical);
    if (transition.type === "investment.rejected") {
      const rejected = investmentRejectedPayloadSchema.parse(
        canonicalParse(transition.payload_canonical),
      );
      rejectionReason = rejected.reason;
      validation = rejected.validation ?? null;
      decisionEvidence = rejected.evidence;
    }
    const finalTerms = proposal.finalTerms === null
      ? null
      : {
          amountCents: proposal.finalTerms.amountCents,
          preMoneyValuationCents: proposal.finalTerms.preMoneyValuationCents,
          equityBasisPoints: proposal.finalTerms.equityBasisPoints,
        };
    return {
      proposal: item,
      conversation: conversation === null
        ? null
        : {
            id: conversation.id,
            status: conversation.status,
            turns: conversation.turns,
            maxTurns: conversation.maxTurns,
            closeReason: conversation.closeReason,
            outcomeKind: conversation.outcome?.kind ?? null,
            startTick: conversation.startTick,
            endTick: conversation.endTick,
            sourceEventId: conversation.sourceEventId,
          },
      termsDiff: investmentTermsDiffSchema.parse({
        initial: {
          amountCents: proposal.askAmountCents,
          preMoneyValuationCents: proposal.preMoneyValuationCents,
          equityBasisPoints: proposal.initialEquityBasisPoints,
        },
        final: finalTerms,
        amountDeltaCents: finalTerms === null
          ? null
          : signedDifference(finalTerms.amountCents, proposal.askAmountCents),
        preMoneyDeltaCents: finalTerms === null
          ? null
          : signedDifference(
              finalTerms.preMoneyValuationCents,
              proposal.preMoneyValuationCents,
            ),
        equityDeltaBasisPoints: finalTerms === null
          ? null
          : finalTerms.equityBasisPoints - proposal.initialEquityBasisPoints,
      }),
      decision: investmentDecisionEvidenceSchema.parse({
        status: proposal.status,
        rejectionReason,
        validation,
        eventId: transition.event_id,
        causationId: transition.causation_id,
        evidenceEventIds: decisionEvidence,
      }),
      timeline: this.timeline(proposal),
    };
  }

  listInvestments(query: InvestmentListQuery): readonly InvestmentListItem[] {
    return Object.freeze(this.investments.list(query.companyId)
      .filter((investment) => query.fundId === undefined || investment.investorId === query.fundId)
      .map((investment) => this.investmentItem(investment)));
  }

  getInvestment(investmentId: string): InvestmentDetail {
    const investment = this.investments.get(investmentId);
    const proposal = this.proposals.get(investment.proposalId);
    const completedEvent = this.event(investment.sourceEventId);
    if (completedEvent.type !== "investment.completed") {
      throw new EngineError(
        "CONFLICT",
        `investment ${investment.id} source event is not investment.completed`,
      );
    }
    const payload = investmentCompletedPayloadSchema.parse(
      canonicalParse(completedEvent.payload_canonical),
    );
    if (payload.investmentId !== investment.id || payload.proposalId !== proposal.id) {
      throw new EngineError("CONFLICT", `investment ${investment.id} completion evidence is mismatched`);
    }
    if (completedEvent.causation_id === null) {
      throw new EngineError("CONFLICT", `investment ${investment.id} lacks completion causation`);
    }
    return {
      investment: {
        ...this.investmentItem(investment),
        transactionId: investment.transactionId,
        capitalCallTransactionId: investment.capitalCallTransactionId,
        contractId: investment.contractId,
        ownershipStakeId: investment.ownershipStakeId,
      },
      proposal: this.proposalItem(proposal),
      capTableBefore: this.resolveCapTable(payload.capTableBefore),
      capTableAfter: this.resolveCapTable(payload.capTableAfter),
      distributions: this.distributions.list(investment.companyId)
        .filter((distribution) => distribution.distributedTick >= investment.completedTick)
        .map((distribution) => this.distributionItem(distribution)),
      why: {
        sourceEventId: completedEvent.event_id,
        causationId: completedEvent.causation_id,
        evidenceEventIds: payload.evidence,
        contractId: investment.contractId,
        transactionId: investment.transactionId,
        capitalCallTransactionId: investment.capitalCallTransactionId,
        ownershipStakeId: investment.ownershipStakeId,
      },
      timeline: this.timeline(proposal),
    };
  }

  capTable(companyId: string): InvestmentCapTableView {
    return this.resolveCapTable(this.investments.capTable(companyId));
  }

  listDistributions(
    query: InvestmentDistributionListQuery,
  ): readonly InvestmentDistributionListItem[] {
    return Object.freeze(this.distributions.list(query.companyId)
      .map((distribution) => this.distributionItem(distribution)));
  }

  getDistribution(distributionId: string): DistributionDetail {
    const distribution = this.distributions.get(distributionId);
    return {
      distribution: {
        ...this.distributionItem(distribution),
        companyAccountId: distribution.companyAccountId,
        allocations: distribution.allocations.map((allocation) => ({
          allocationIndex: allocation.allocationIndex,
          holder: this.holder(
            allocation.holderKind,
            allocation.holderId,
          ),
          shares: allocation.shares,
          amountCents: allocation.amountCents,
          accountId: allocation.accountId,
          ownershipBasisPoints: Number(
            (BigInt(allocation.shares) * 10_000n) / BigInt(distribution.totalShares),
          ),
        })),
      },
    };
  }

  private proposalItem(proposal: InvestmentProposal): InvestmentProposalListItem {
    const investmentId = this.investments.list(proposal.companyId)
      .find((investment) => investment.proposalId === proposal.id)?.id ?? null;
    const firm = this.venture.getFirm(proposal.firmId);
    const fund = this.venture.getFund(proposal.fundId);
    return investmentProposalListItemSchema.parse({
      id: proposal.id,
      company: this.company(proposal.companyId),
      founder: this.agent(proposal.founderAgentId),
      firm: { id: firm.id, name: firm.name },
      fund: { id: fund.id, name: fund.name },
      vcPartner: this.agent(proposal.vcPartnerAgentId),
      askAmountCents: proposal.askAmountCents,
      preMoneyValuationCents: proposal.preMoneyValuationCents,
      initialEquityBasisPoints: proposal.initialEquityBasisPoints,
      status: proposal.status,
      conversationId: proposal.negotiationConversationId,
      finalTerms: proposal.finalTerms,
      proposedTick: proposal.proposedTick,
      expiresTick: proposal.expiresTick,
      investmentId,
      sourceEventId: proposal.sourceEventId,
      lastTransitionEventId: proposal.lastTransitionEventId,
    });
  }

  private investmentItem(
    investment: ReturnType<SqliteInvestmentStore["get"]>,
  ): InvestmentListItem {
    const firm = this.venture.getFirm(investment.firmId);
    const fund = this.venture.getFund(investment.investorId);
    return investmentListItemSchema.parse({
      id: investment.id,
      proposalId: investment.proposalId,
      company: this.company(investment.companyId),
      firm: { id: firm.id, name: firm.name },
      investor: { id: fund.id, name: fund.name },
      amountCents: investment.amountCents,
      preMoneyValuationCents: investment.preMoneyValuationCents,
      sharesIssued: investment.sharesIssued,
      totalSharesBefore: investment.totalSharesBefore,
      totalSharesAfter: investment.totalSharesAfter,
      pricePerShareCents: investment.pricePerShareCents,
      ownershipBasisPoints: Number(
        (BigInt(investment.sharesIssued) * 10_000n) /
        BigInt(investment.totalSharesAfter),
      ),
      completedTick: investment.completedTick,
      sourceEventId: investment.sourceEventId,
    });
  }

  private distributionItem(
    distribution: ReturnType<SqliteInvestmentDistributionStore["get"]>,
  ): InvestmentDistributionListItem {
    return investmentDistributionListItemSchema.parse({
      id: distribution.id,
      company: this.company(distribution.companyId),
      amountCents: distribution.amountCents,
      totalShares: distribution.totalShares,
      referenceId: distribution.referenceId,
      distributedTick: distribution.distributedTick,
      transactionId: distribution.transactionId,
      allocationCount: distribution.allocations.length,
      requestEventId: distribution.requestEventId,
      sourceEventId: distribution.sourceEventId,
    });
  }

  private resolveCapTable(capTable: CapTableSnapshot): InvestmentCapTableView {
    return investmentCapTableViewSchema.parse({
      company: this.company(capTable.companyId),
      totalShares: capTable.totalShares,
      stakes: capTable.stakes.map((stake) => ({
        id: stake.id,
        holder: this.holder(stake.holderKind, stake.holderId),
        shares: stake.shares,
        ownershipBasisPoints: Number(
          (BigInt(stake.shares) * 10_000n) / BigInt(capTable.totalShares),
        ),
        acquiredVia: stake.acquiredVia,
        sinceTick: stake.sinceTick,
      })),
    });
  }

  private holder(kind: "agent" | "venture_fund", id: string) {
    if (kind === "agent") return { kind, ...this.agent(id) };
    const fund = this.venture.getFund(id);
    return { kind, id: fund.id, name: fund.name };
  }

  private agent(agentId: string): NameRow {
    const row = this.db.prepare<[string, string], NameRow>(`
      SELECT agent.id, persona.name
      FROM agents agent
      JOIN personas persona
        ON persona.run_id = agent.run_id AND persona.id = agent.persona_id
      WHERE agent.run_id = ? AND agent.id = ?
    `).get(this.runId, agentId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
    return row;
  }

  private company(companyId: string): NameRow {
    if (companyId.startsWith("biz_")) {
      return { id: companyId, name: openingBusinessName(companyId) };
    }
    const row = this.db.prepare<[string, string], NameRow>(`
      SELECT id, name FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, companyId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `company ${companyId} does not exist`);
    }
    return row;
  }

  private event(eventId: string): EventRow {
    const row = this.db.prepare<[string, string], EventRow>(`
      SELECT event_id, tick, type, actor_kind, actor_id, correlation_id,
        causation_id, payload_canonical
      FROM events WHERE run_id = ? AND event_id = ?
    `).get(this.runId, eventId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `event ${eventId} does not exist`);
    return row;
  }

  private timeline(proposal: InvestmentProposal): InvestmentTimelineItem[] {
    const rows = proposal.negotiationConversationId === null
      ? this.db.prepare<[string, string], EventRow>(`
          SELECT event_id, tick, type, actor_kind, actor_id, correlation_id,
            causation_id, payload_canonical
          FROM events WHERE run_id = ? AND correlation_id = ?
          ORDER BY seq
        `).all(this.runId, proposal.id)
      : this.db.prepare<[string, string, string], EventRow>(`
          SELECT event_id, tick, type, actor_kind, actor_id, correlation_id,
            causation_id, payload_canonical
          FROM events
          WHERE run_id = ? AND correlation_id IN (?, ?)
          ORDER BY seq
        `).all(this.runId, proposal.id, proposal.negotiationConversationId);
    return rows.slice(0, 200).map((row) => (
      investmentTimelineItemSchema.parse({
        eventId: row.event_id,
        tick: toSafeNumber(row.tick, "investment timeline tick"),
        type: row.type,
        actor: { kind: row.actor_kind, id: row.actor_id },
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        evidenceEventIds: evidenceFromPayload(row.payload_canonical),
      })
    ));
  }
}
