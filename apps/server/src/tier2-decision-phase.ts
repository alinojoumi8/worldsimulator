/** WS-605 asynchronous Tier-2 preparation and deterministic in-tick apply. */

import { z } from "zod";
import {
  agentActionSchema,
  canonicalStringify,
  decisionOptionSchema,
  decisionSchema,
  EngineError,
  type AgentAction,
  type Decision,
  type DecisionOption,
  type EventEnvelope,
  type LlmCallRecord,
  type Persona,
  type TriggerSignal,
} from "@worldtangle/shared";
import {
  ActionRegistry,
  buildAgentDecisionPrompt,
  DeterministicMemoryStore,
  GoalLifecycleEngine,
  llmRequestHash,
  resolveLiveDecision,
  simDateForTick,
  type ActionExecutionContext,
  type LlmProviderRoute,
  type LlmResult,
  type PhaseHandler,
  type RoutedLlmProvider,
  type TickContext,
  type UntrustedPromptItem,
} from "@worldtangle/engine";
import {
  SqliteAgentStore,
  SqliteCreditStore,
  SqliteLlmCallStore,
  SqliteMarketStore,
  SqlitePhase4Store,
  type FounderPricingOpportunity,
  type LaborDecisionCandidate,
  type WorldDatabase,
} from "./persistence";
import { goalDecisionDue } from "./agent-phase";
import {
  buildLlmCallRecordEvidence,
  buildLlmCallTelemetryEvidence,
} from "./llm-call-evidence";

export const TIER2_DECISION_KINDS = [
  "founder_pricing",
  "founder_hiring",
  "job_response",
  "loan_officer_adjustment",
  "goal_activation",
] as const;
export type Tier2DecisionKind = (typeof TIER2_DECISION_KINDS)[number];

export interface Tier2DecisionOpportunity {
  readonly key: string;
  readonly kind: Tier2DecisionKind;
  readonly purpose: string;
  readonly agentId: string;
  readonly persona: Persona;
  readonly trigger: TriggerSignal;
  readonly trustedState: unknown;
  readonly untrustedItems: readonly UntrustedPromptItem[];
  readonly options: readonly DecisionOption[];
  readonly budgetTag: string;
}

export interface PreparedTier2Decision {
  readonly opportunity: Tier2DecisionOpportunity;
  readonly prompt: ReturnType<typeof buildAgentDecisionPrompt>;
  readonly route: LlmProviderRoute;
  readonly result: LlmResult;
}

export interface PreparedTier2DecisionBatch {
  readonly tick: number;
  readonly entries: readonly PreparedTier2Decision[];
}

interface EvidenceEventRow {
  event_id: string;
}

interface Tier2ApplyState {
  readonly runId: string;
  readonly tick: number;
  readonly agentStore: SqliteAgentStore;
  readonly market: SqliteMarketStore;
  readonly phase4: SqlitePhase4Store;
  readonly credit: SqliteCreditStore;
  readonly goals: GoalLifecycleEngine<Record<string, never>>;
  readonly tickContext: TickContext;
  readonly emit: TickContext["emit"];
  readonly opportunityByDecision: Map<string, PreparedTier2Decision>;
  readonly rationaleByDecision: Map<string, string>;
  readonly laborByApplication: Map<string, {
    founder?: {
      decisionId: string;
      agentId: string;
      response: "offer" | "defer";
      sourceEventId: string;
    };
    applicant?: {
      decisionId: string;
      agentId: string;
      response: "accept" | "decline";
      sourceEventId: string;
    };
  }>;
  readonly effectEventIds: Map<string, string[]>;
}

interface ActionDraft {
  readonly actionId: string;
  readonly decisionId: string;
  readonly actorId: string;
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly callEventId: string;
  readonly sourceEventId: string;
  readonly status: "applied" | "failed";
  readonly resultEventIds: readonly string[];
  readonly error?: NonNullable<AgentAction["error"]>;
}

function freezeOpportunity(input: Tier2DecisionOpportunity): Tier2DecisionOpportunity {
  return Object.freeze(input);
}

const priceParamsSchema = z.object({
  companyId: z.string().regex(/^co_[0-9a-z]{8,}$/),
  offeringId: z.string().regex(/^off_[0-9a-z]{8,}$/),
  founderAgentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  newPriceCents: z.string().regex(/^[1-9]\d*$/),
}).strict();

const founderHiringParamsSchema = z.object({
  companyId: z.string().regex(/^co_[0-9a-z]{8,}$/),
  jobId: z.string().regex(/^job_[0-9a-z]{8,}$/),
  applicationId: z.string().regex(/^app_[0-9a-z]{8,}$/),
  founderAgentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  candidateAgentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  response: z.enum(["offer", "defer"]),
}).strict();

const jobResponseParamsSchema = z.object({
  companyId: z.string().regex(/^co_[0-9a-z]{8,}$/),
  jobId: z.string().regex(/^job_[0-9a-z]{8,}$/),
  applicationId: z.string().regex(/^app_[0-9a-z]{8,}$/),
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  response: z.enum(["accept", "decline"]),
}).strict();

const loanReviewParamsSchema = z.object({
  applicationId: z.string().regex(/^loanapp_[0-9a-z]{8,}$/),
  officerAgentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  officerAdjustment: z.number().int().min(-5).max(5).safe(),
}).strict();

const activateGoalParamsSchema = z.object({
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  goalId: z.string().regex(/^gol_[0-9a-z]{8}$/),
}).strict();

const deferGoalParamsSchema = z.object({
  agentId: z.string().regex(/^agt_[0-9a-z]{8}$/),
  reason: z.literal("defer_activation"),
}).strict();

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function latestEvidenceEvent(
  db: WorldDatabase,
  runId: string,
  references: readonly string[],
): string {
  for (const reference of references) {
    const row = db.prepare<[string, string, string], EvidenceEventRow>(`
      SELECT event_id FROM events
      WHERE run_id = ? AND (correlation_id = ? OR instr(payload_canonical, ?) > 0)
      ORDER BY seq DESC LIMIT 1
    `).get(runId, reference, reference);
    if (row !== undefined) return row.event_id;
  }
  const fallback = db.prepare<[string], EvidenceEventRow>(`
    SELECT event_id FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1
  `).get(runId);
  if (fallback === undefined) throw new EngineError("NOT_FOUND", "run has no causal event");
  return fallback.event_id;
}

function profileContext(
  store: SqliteAgentStore,
  agentId: string,
): { readonly persona: Persona; readonly untrustedItems: readonly UntrustedPromptItem[] } {
  const profile = store.getProfile(agentId, 5);
  return Object.freeze({
    persona: profile.persona,
    untrustedItems: Object.freeze(profile.memoryHighlights.map((memory) => Object.freeze({
      source: "memory" as const,
      id: memory.id,
      content: memory.content,
      references: memory.references,
    }))),
  });
}

function option(input: DecisionOption): DecisionOption {
  return Object.freeze(decisionOptionSchema.parse(input));
}

function pricingOptions(opportunity: FounderPricingOpportunity): readonly DecisionOption[] {
  const prices = [...new Set([
    opportunity.offering.postedPriceCents,
    opportunity.rulePriceCents,
    opportunity.minimumPriceCents,
    opportunity.maximumPriceCents,
  ])].sort((left, right) => {
    const delta = BigInt(left) - BigInt(right);
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  });
  return Object.freeze(prices.map((price) => option({
    actionId: `pricing.set_${price}`,
    actionType: "company.set_price",
    params: {
      companyId: opportunity.offering.companyId,
      offeringId: opportunity.offering.id,
      founderAgentId: opportunity.founderAgentId,
      newPriceCents: price,
    },
    utility: price === opportunity.rulePriceCents
      ? 1_000
      : price === opportunity.offering.postedPriceCents
        ? 750
        : 500,
    utilityFactors: {
      followsRule: price === opportunity.rulePriceCents ? 1 : 0,
      preservesPrice: price === opportunity.offering.postedPriceCents ? 1 : 0,
    },
  })));
}

function founderHiringOptions(candidate: LaborDecisionCandidate): readonly DecisionOption[] {
  const common = {
    companyId: candidate.companyId,
    jobId: candidate.job.id,
    applicationId: candidate.application.id,
    founderAgentId: candidate.founderAgentId,
    candidateAgentId: candidate.application.agentId,
  };
  return Object.freeze([
    option({
      actionId: "hiring.defer",
      actionType: "company.respond_hiring",
      params: { ...common, response: "defer" },
      utility: candidate.job.payrollRisk ? 900 : 100,
      utilityFactors: { payrollRisk: candidate.job.payrollRisk ? 1 : 0 },
    }),
    option({
      actionId: "hiring.offer",
      actionType: "company.respond_hiring",
      params: { ...common, response: "offer" },
      utility: candidate.score - (candidate.job.payrollRisk ? 1_000 : 0),
      utilityFactors: {
        candidateScore: candidate.score,
        payrollRiskPenalty: candidate.job.payrollRisk ? -1_000 : 0,
      },
    }),
  ]);
}

function jobResponseOptions(candidate: LaborDecisionCandidate): readonly DecisionOption[] {
  const common = {
    companyId: candidate.companyId,
    jobId: candidate.job.id,
    applicationId: candidate.application.id,
    agentId: candidate.application.agentId,
  };
  const wageSurplus = BigInt(candidate.job.annualWageCents) -
    BigInt(candidate.application.reservationWageCents);
  const boundedSurplus = wageSurplus > 1_000_000n
    ? 1_000_000
    : wageSurplus < -1_000_000n
      ? -1_000_000
      : Number(wageSurplus);
  return Object.freeze([
    option({
      actionId: "job.accept",
      actionType: "agent.respond_job_offer",
      params: { ...common, response: "accept" },
      utility: boundedSurplus,
      utilityFactors: { annualWageSurplusCents: boundedSurplus },
    }),
    option({
      actionId: "job.decline",
      actionType: "agent.respond_job_offer",
      params: { ...common, response: "decline" },
      utility: 0,
      utilityFactors: { reservationOption: 0 },
    }),
  ]);
}

function loanOptions(applicationId: string, officerAgentId: string): readonly DecisionOption[] {
  const options: DecisionOption[] = [];
  for (let adjustment = -5; adjustment <= 5; adjustment++) {
    const label = adjustment < 0 ? `minus_${-adjustment}` : `plus_${adjustment}`;
    options.push(option({
      actionId: `loan.adjust_${label}`,
      actionType: "bank.review_loan",
      params: { applicationId, officerAgentId, officerAdjustment: adjustment },
      utility: 100 - Math.abs(adjustment) * 10,
      utilityFactors: { adjustmentMagnitudePenalty: -Math.abs(adjustment) * 10 },
    }));
  }
  return Object.freeze(options);
}

function goalOptions(
  agentId: string,
  records: ReturnType<GoalLifecycleEngine<Record<string, never>>["eligibleForActivation"]>,
): readonly DecisionOption[] {
  const options = records.map((record) => option({
    actionId: `goal.activate_${record.goal.id.slice(4)}`,
    actionType: "agent.activate_goal",
    params: { agentId, goalId: record.goal.id },
    utility: record.goal.priority * 10,
    utilityFactors: { goalPriority: record.goal.priority * 10 },
  }));
  options.push(option({
    actionId: "goal.defer",
    actionType: "agent.defer_goal",
    params: { agentId, reason: "defer_activation" },
    utility: 0,
    utilityFactors: { deferBaseline: 0 },
  }));
  return Object.freeze(options);
}

export function discoverTier2DecisionOpportunities(
  db: WorldDatabase,
  runId: string,
  tick: number,
): readonly Tier2DecisionOpportunity[] {
  if (!Number.isSafeInteger(tick) || tick < 1) {
    throw new EngineError("VALIDATION_FAILED", "Tier-2 discovery tick must be positive");
  }
  const agents = new SqliteAgentStore(db, runId);
  const market = new SqliteMarketStore(db, runId);
  const phase4 = new SqlitePhase4Store(db, runId);
  const credit = new SqliteCreditStore(db, runId);
  const goals = new GoalLifecycleEngine<Record<string, never>>({ repository: agents });
  const opportunities: Tier2DecisionOpportunity[] = [];

  for (const pricing of market.listFounderPricingOpportunities(tick)) {
    const context = profileContext(agents, pricing.founderAgentId);
    const sourceEventId = latestEvidenceEvent(db, runId, [
      pricing.offering.id,
      pricing.offering.companyId,
    ]);
    opportunities.push(freezeOpportunity({
      key: `01-founder-pricing:${pricing.offering.id}`,
      kind: "founder_pricing",
      purpose: "decision.tier2.founder_pricing",
      agentId: pricing.founderAgentId,
      persona: context.persona,
      trigger: {
        kind: "company",
        agentId: pricing.founderAgentId,
        sourceEventId,
        tick,
        priority: 70,
        payload: {
          companyId: pricing.offering.companyId,
          eventKind: "pricing_review_due",
        },
      },
      trustedState: {
        decisionKind: "founder_pricing",
        companyId: pricing.offering.companyId,
        offering: pricing.offering,
        unitCostCents: pricing.unitCostCents,
        minimumPriceCents: pricing.minimumPriceCents,
        maximumPriceCents: pricing.maximumPriceCents,
        inventoryQuantity: pricing.inventoryQuantity,
        unitsSold: pricing.unitsSold,
        unfilledUnits: pricing.unfilledUnits,
        inventorySalesRatioBp: pricing.inventorySalesRatioBp,
        deterministicRule: {
          priceCents: pricing.rulePriceCents,
          signal: pricing.ruleSignal,
        },
        evidenceRefs: [sourceEventId, pricing.offering.id],
      },
      untrustedItems: context.untrustedItems,
      options: pricingOptions(pricing),
      budgetTag: "founder_pricing",
    }));
  }

  for (const candidate of phase4.listLaborDecisionCandidates(tick)) {
    const sourceEventId = latestEvidenceEvent(db, runId, [
      candidate.application.id,
      candidate.job.id,
      candidate.companyId,
    ]);
    const founder = profileContext(agents, candidate.founderAgentId);
    opportunities.push(freezeOpportunity({
      key: `02-founder-hiring:${candidate.application.id}`,
      kind: "founder_hiring",
      purpose: "decision.tier2.founder_hiring",
      agentId: candidate.founderAgentId,
      persona: founder.persona,
      trigger: {
        kind: "company",
        agentId: candidate.founderAgentId,
        sourceEventId,
        tick,
        priority: 80,
        payload: { companyId: candidate.companyId, eventKind: "candidate_ranked" },
      },
      trustedState: {
        decisionKind: "founder_hiring",
        companyId: candidate.companyId,
        job: candidate.job,
        application: candidate.application,
        candidateScore: candidate.score,
        evidenceRefs: [sourceEventId, candidate.job.id, candidate.application.id],
      },
      untrustedItems: founder.untrustedItems,
      options: founderHiringOptions(candidate),
      budgetTag: "founder_hiring",
    }));

    const applicant = profileContext(agents, candidate.application.agentId);
    opportunities.push(freezeOpportunity({
      key: `03-job-response:${candidate.application.id}`,
      kind: "job_response",
      purpose: "decision.tier2.job_response",
      agentId: candidate.application.agentId,
      persona: applicant.persona,
      trigger: {
        kind: "company",
        agentId: candidate.application.agentId,
        sourceEventId,
        tick,
        priority: 80,
        payload: { companyId: candidate.companyId, eventKind: "job_offer" },
      },
      trustedState: {
        decisionKind: "job_response",
        companyId: candidate.companyId,
        job: candidate.job,
        application: candidate.application,
        candidateScore: candidate.score,
        evidenceRefs: [sourceEventId, candidate.job.id, candidate.application.id],
      },
      untrustedItems: applicant.untrustedItems,
      options: jobResponseOptions(candidate),
      budgetTag: "job_response",
    }));
  }

  for (const application of credit.listApplications()) {
    if (application.status !== "under_review") continue;
    const review = credit.getReviewForApplication(application.id);
    if (review.reviewTier !== "tier2") continue;
    const context = profileContext(agents, review.officerAgentId);
    const assessment = credit.getAssessmentForApplication(application.id);
    opportunities.push(freezeOpportunity({
      key: `04-loan-review:${application.id}`,
      kind: "loan_officer_adjustment",
      purpose: "decision.tier2.loan_officer_adjustment",
      agentId: review.officerAgentId,
      persona: context.persona,
      trigger: {
        kind: "schedule",
        agentId: review.officerAgentId,
        sourceEventId: review.sourceEventId,
        tick,
        priority: 95,
        payload: { taskRef: `loan-review:${application.id}`, dueTick: tick },
      },
      trustedState: {
        decisionKind: "loan_officer_adjustment",
        application,
        review,
        assessment,
        adjustmentMinimum: -5,
        adjustmentMaximum: 5,
        evidenceRefs: [
          application.sourceEventId,
          review.sourceEventId,
          assessment.id,
          assessment.sourceEventId,
        ],
      },
      untrustedItems: context.untrustedItems,
      options: loanOptions(application.id, review.officerAgentId),
      budgetTag: "loan_officer_adjustment",
    }));
  }

  if (goalDecisionDue(tick)) {
    for (const agent of agents.listAgentEntities()) {
      if (!agent.aliveFlags.alive || !agent.aliveFlags.canAct) continue;
      if (agent.quarantine.mode === "tier1_only" && tick <= agent.quarantine.untilTick) continue;
      const eligible = goals.eligibleForActivation(agent.id, tick, {});
      if (eligible.length === 0) continue;
      const first = eligible[0]!;
      const context = profileContext(agents, agent.id);
      opportunities.push(freezeOpportunity({
        key: `05-goal-activation:${agent.id}`,
        kind: "goal_activation",
        purpose: "decision.tier2.goal_activation",
        agentId: agent.id,
        persona: context.persona,
        trigger: {
          kind: "goal",
          agentId: agent.id,
          sourceEventId: first.triggerEventId,
          tick,
          priority: first.goal.priority,
          payload: { goalId: first.goal.id, goalKind: first.goal.kind },
        },
        trustedState: {
          decisionKind: "goal_activation",
          eligibleGoals: eligible.map((record) => record.goal),
          activeGoals: agents.listByAgent(agent.id)
            .filter((record) => record.goal.status === "active")
            .map((record) => record.goal),
          evidenceRefs: eligible.map((record) => record.triggerEventId),
        },
        untrustedItems: context.untrustedItems,
        options: goalOptions(agent.id, eligible),
        budgetTag: "goal_activation",
      }));
    }
  }

  return Object.freeze(opportunities.sort((left, right) => compareCodeUnit(left.key, right.key)));
}

export async function prepareTier2DecisionBatch(input: {
  readonly db: WorldDatabase;
  readonly runId: string;
  readonly tick: number;
  readonly provider: RoutedLlmProvider;
  readonly promptPackVersion: number;
  readonly opportunities?: readonly Tier2DecisionOpportunity[];
}): Promise<PreparedTier2DecisionBatch> {
  const opportunities = input.opportunities ??
    discoverTier2DecisionOpportunities(input.db, input.runId, input.tick);
  const entries: PreparedTier2Decision[] = [];
  // Sequential gateway access keeps budget events and threshold transitions in
  // canonical opportunity order. WS-1103 owns provider-side batch scheduling.
  for (const opportunity of opportunities) {
    if (opportunity.trigger.tick !== input.tick) {
      throw new EngineError("CONFLICT", "Tier-2 opportunity belongs to another tick");
    }
    const prompt = buildAgentDecisionPrompt({
      persona: opportunity.persona,
      tick: input.tick,
      simDate: simDateForTick(input.tick),
      trigger: opportunity.trigger,
      trustedState: opportunity.trustedState,
      untrustedItems: opportunity.untrustedItems,
      options: opportunity.options,
      purpose: opportunity.purpose,
      correlationId: opportunity.key,
      budgetTag: opportunity.budgetTag,
      promptPackVersion: input.promptPackVersion,
    });
    let route: LlmProviderRoute;
    try {
      route = input.provider.route(prompt.request);
    } catch {
      route = { provider: "unavailable", model: "unavailable" };
    }
    let result: LlmResult;
    try {
      result = await input.provider.propose(prompt.request);
    } catch (error) {
      result = {
        ok: false,
        reason: "provider_error",
        requestHash: llmRequestHash(prompt.request),
        detail: error instanceof Error ? error.message : "LLM provider threw",
        providerError: {
          provider: route.provider,
          code: "unknown",
          retryable: false,
        },
        attempts: 0,
        requestedTier: 2,
        effectiveTier: 1,
      };
    }
    const expectedRequestHash = llmRequestHash(prompt.request);
    if (result.requestHash !== expectedRequestHash) {
      result = {
        ok: false,
        reason: "provider_error",
        requestHash: expectedRequestHash,
        detail: "LLM provider returned a mismatched canonical request hash",
        providerError: {
          provider: route.provider,
          code: "conflict",
          retryable: false,
        },
        attempts: result.attempts ?? (result.ok && !result.cached ? 1 : 0),
        requestedTier: 2,
        effectiveTier: 1,
      };
    }
    entries.push(Object.freeze({ opportunity, prompt, route, result }));
  }
  return Object.freeze({ tick: input.tick, entries: Object.freeze(entries) });
}

function eventId(value: EventEnvelope | string | void): string | undefined {
  return typeof value === "string" ? value : value?.eventId;
}

function receiptEventIds(result: unknown): string[] {
  if (typeof result !== "object" || result === null || !("eventIds" in result)) return [];
  const values = (result as { readonly eventIds?: unknown }).eventIds;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string =>
    typeof value === "string" && /^evt_[0-9a-z]{8,}$/.test(value)
  );
}

function addEffects(state: Tier2ApplyState, decisionId: string, values: readonly string[]): void {
  const current = state.effectEventIds.get(decisionId) ?? [];
  state.effectEventIds.set(
    decisionId,
    [...new Set([...current, ...values])].sort(compareCodeUnit),
  );
}

function requiredPrepared(
  state: Tier2ApplyState,
  decisionId: string | undefined,
): PreparedTier2Decision {
  if (decisionId === undefined) {
    throw new EngineError("VALIDATION_FAILED", "Tier-2 action requires a decision ID");
  }
  const prepared = state.opportunityByDecision.get(decisionId);
  if (prepared === undefined) {
    throw new EngineError("PERMISSION_DENIED", "action is not attached to an offered decision");
  }
  return prepared;
}

function createActionRegistry(state: Tier2ApplyState): ActionRegistry<Tier2ApplyState> {
  const registry = new ActionRegistry<Tier2ApplyState>({
    capabilityCheck: ({ type, actor, params, intent }) => {
      if (actor.kind !== "agent") {
        return { code: "PERMISSION_DENIED", message: "Tier-2 choices require an agent actor" };
      }
      const prepared = state.opportunityByDecision.get(intent.decisionId ?? "");
      if (prepared === undefined || prepared.opportunity.agentId !== actor.id) {
        return {
          code: "PERMISSION_DENIED",
          message: "agent does not own the offered Tier-2 decision",
        };
      }
      let paramsCanonical: string;
      try {
        paramsCanonical = canonicalStringify(params);
      } catch {
        return { code: "PERMISSION_DENIED", message: "action params are not canonical" };
      }
      const offered = prepared.opportunity.options.some((candidate) =>
        candidate.actionType === type && canonicalStringify(candidate.params) === paramsCanonical
      );
      if (!offered) {
        return {
          code: "PERMISSION_DENIED",
          message: "action params do not exactly match an engine-offered choice",
        };
      }
      return true;
    },
  });

  registry.registerActionType(
    "company.set_price",
    priceParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "founder_pricing") {
        throw new EngineError("PERMISSION_DENIED", "decision is not a founder pricing choice");
      }
      const changed = context.state.market.applyFounderPriceOverride({
        offeringId: params.offeringId,
        founderAgentId: params.founderAgentId,
        decisionId: intent.decisionId!,
        newPriceCents: params.newPriceCents,
      }, context.state.tickContext);
      return { eventIds: changed === null ? [] : [changed.sourceEventId] };
    },
  );

  registry.registerActionType(
    "company.respond_hiring",
    founderHiringParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "founder_hiring") {
        throw new EngineError("PERMISSION_DENIED", "decision is not a founder hiring choice");
      }
      const pair = context.state.laborByApplication.get(params.applicationId) ?? {};
      pair.founder = {
        decisionId: intent.decisionId!,
        agentId: params.founderAgentId,
        response: params.response,
        sourceEventId: prepared.opportunity.trigger.sourceEventId,
      };
      context.state.laborByApplication.set(params.applicationId, pair);
      return { eventIds: [] };
    },
  );

  registry.registerActionType(
    "agent.respond_job_offer",
    jobResponseParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "job_response") {
        throw new EngineError("PERMISSION_DENIED", "decision is not a job response choice");
      }
      const pair = context.state.laborByApplication.get(params.applicationId) ?? {};
      pair.applicant = {
        decisionId: intent.decisionId!,
        agentId: params.agentId,
        response: params.response,
        sourceEventId: prepared.opportunity.trigger.sourceEventId,
      };
      context.state.laborByApplication.set(params.applicationId, pair);
      if (pair.founder === undefined) {
        throw new EngineError("CONFLICT", "applicant response preceded the founder choice");
      }
      const outcome = context.state.phase4.applyTier2LaborDecision({
        applicationId: params.applicationId,
        founderAgentId: pair.founder.agentId,
        applicantAgentId: pair.applicant.agentId,
        founderDecisionId: pair.founder.decisionId,
        applicantDecisionId: pair.applicant.decisionId,
        founderResponse: pair.founder.response,
        applicantResponse: pair.applicant.response,
        sourceEventId: pair.applicant.sourceEventId,
      }, context.state.tickContext);
      addEffects(context.state, pair.founder.decisionId, outcome.eventIds);
      addEffects(context.state, pair.applicant.decisionId, outcome.eventIds);
      return { eventIds: outcome.eventIds };
    },
  );

  registry.registerActionType(
    "bank.review_loan",
    loanReviewParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "loan_officer_adjustment") {
        throw new EngineError("PERMISSION_DENIED", "decision is not a loan review choice");
      }
      const rationale = context.state.rationaleByDecision.get(intent.decisionId!);
      if (rationale === undefined) {
        throw new EngineError("INTERNAL", "loan decision rationale was not recorded");
      }
      const decided = context.state.credit.decideTier2Application(params.applicationId, {
        officerAdjustment: params.officerAdjustment,
        rationale,
        agentDecisionId: intent.decisionId!,
      }, context.state.tickContext);
      return { eventIds: [decided.decision.sourceEventId] };
    },
  );

  registry.registerActionType(
    "agent.activate_goal",
    activateGoalParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "goal_activation") {
        throw new EngineError("PERMISSION_DENIED", "decision is not a goal activation choice");
      }
      const activated = context.state.goals.activateSelected(
        params.goalId,
        context.tick,
        {},
        context.state.emit,
      );
      return { eventIds: [activated.triggerEventId] };
    },
  );

  registry.registerActionType(
    "agent.defer_goal",
    deferGoalParamsSchema,
    () => true,
    (params, context, intent) => {
      const prepared = requiredPrepared(context.state, intent.decisionId);
      if (prepared.opportunity.kind !== "goal_activation" || params.agentId !== prepared.opportunity.agentId) {
        throw new EngineError("PERMISSION_DENIED", "decision is not this agent's goal choice");
      }
      return { eventIds: [] };
    },
  );

  return registry;
}

function providerAttemptCount(result: LlmResult): number {
  if (result.ok && result.cached) return 0;
  return result.attempts ?? (result.ok ? 1 : 0);
}

function buildCallRecord(input: {
  readonly entry: PreparedTier2Decision;
  readonly runId: string;
  readonly tick: number;
  readonly callId: string;
  readonly decisionId: string;
  readonly sourceEventId: string;
  readonly validationFallbackDetail?: string;
}): LlmCallRecord {
  return buildLlmCallRecordEvidence({
    prompt: input.entry.prompt,
    result: input.entry.result,
    route: input.entry.route,
    agentId: input.entry.opportunity.agentId,
    runId: input.runId,
    tick: input.tick,
    callId: input.callId,
    decisionId: input.decisionId,
    sourceEventId: input.sourceEventId,
    ...(input.validationFallbackDetail === undefined
      ? {}
      : { validationFallbackDetail: input.validationFallbackDetail }),
  });
}

/** Applies a prepared provider batch synchronously inside the authoritative tick transaction. */
export function createTier2DecisionPhaseHandler(
  db: WorldDatabase,
  runId: string,
  batch: PreparedTier2DecisionBatch,
): PhaseHandler {
  const agentStore = new SqliteAgentStore(db, runId);
  const callStore = new SqliteLlmCallStore(db, runId);
  return {
    module: "M04-tier2-live-decisions",
    order: 50,
    run(ctx) {
      if (batch.tick !== ctx.tick) {
        throw new EngineError("CONFLICT", "prepared Tier-2 batch belongs to another tick");
      }
      const keys = batch.entries.map((entry) => entry.opportunity.key);
      const canonicalKeys = [...keys].sort(compareCodeUnit);
      if (new Set(keys).size !== keys.length || canonicalStringify(keys) !== canonicalStringify(canonicalKeys)) {
        throw new EngineError("CONFLICT", "prepared Tier-2 batch is duplicated or out of order");
      }
      const state: Tier2ApplyState = {
        runId,
        tick: ctx.tick,
        agentStore,
        market: new SqliteMarketStore(db, runId),
        phase4: new SqlitePhase4Store(db, runId),
        credit: new SqliteCreditStore(db, runId),
        goals: new GoalLifecycleEngine<Record<string, never>>({ repository: agentStore }),
        tickContext: ctx,
        emit: ctx.emit,
        opportunityByDecision: new Map(),
        rationaleByDecision: new Map(),
        laborByApplication: new Map(),
        effectEventIds: new Map(),
      };
      const registry = createActionRegistry(state);
      const actionContext: ActionExecutionContext<Tier2ApplyState> = {
        runId,
        tick: ctx.tick,
        state,
      };
      const drafts: ActionDraft[] = [];
      const decisions: Decision[] = [];

      for (const entry of batch.entries) {
        if (entry.prompt.request.tick !== ctx.tick || entry.opportunity.trigger.tick !== ctx.tick) {
          throw new EngineError("CONFLICT", "prepared Tier-2 entry belongs to another tick");
        }
        const decisionId = ctx.ids.next("dec");
        const callId = ctx.ids.next("llm");
        const intentId = ctx.ids.next("int");
        const actionId = ctx.ids.next("act");
        state.opportunityByDecision.set(decisionId, entry);
        const resolved = resolveLiveDecision({
          candidate: entry.result.ok ? entry.result.value : undefined,
          options: entry.opportunity.options,
          registry,
          context: actionContext,
          agentId: entry.opportunity.agentId,
          decisionId,
          intentId,
        });
        const tier = entry.result.ok && resolved.source === "live" ? 2 as const : 1 as const;
        const validationFallbackDetail = entry.result.ok && resolved.source !== "live"
          ? resolved.validationFailures.map((failure) => (
              `${failure.stage}:${failure.code}:${failure.message}`
            )).join("; ") || "provider proposal was not an executable engine-authored choice"
          : undefined;
        const decision = decisionSchema.parse({
          id: decisionId,
          runId,
          agentId: entry.opportunity.agentId,
          tick: ctx.tick,
          trigger: {
            kind: entry.opportunity.trigger.kind,
            sourceEventId: entry.opportunity.trigger.sourceEventId,
            priority: entry.opportunity.trigger.priority,
          },
          tier,
          observationDigest: entry.prompt.observationDigest,
          optionsOffered: entry.opportunity.options,
          chosenActionId: resolved.actionId,
          params: resolved.params,
          rationale: resolved.rationale,
          ...(tier === 2
            ? {
                llmCallId: callId,
                promptPackKey: entry.prompt.promptPackKey,
                promptVersion: entry.prompt.promptPackVersion,
                promptHash: entry.prompt.promptHash,
              }
            : {}),
          validationResult: { status: "approved" },
        });
        agentStore.saveDecisionResult([decision], []);
        decisions.push(decision);
        state.rationaleByDecision.set(decisionId, decision.rationale);

        const callEvent = ctx.emit("llm.call.recorded", {
          schemaVersion: 2,
          callId,
          decisionId,
          agentId: decision.agentId,
          moduleId: entry.prompt.request.moduleId,
          purpose: entry.opportunity.purpose,
          provider: entry.route.provider,
          model: entry.result.ok ? entry.result.model : entry.route.model,
          requestHash: entry.result.requestHash,
          promptHash: entry.prompt.promptHash,
          status: tier === 2 ? "success" : "fallback",
          effectiveTier: tier,
          ...(validationFallbackDetail === undefined
            ? entry.result.ok
              ? {}
              : { fallbackReason: entry.result.reason }
            : { fallbackReason: "validation_failed" }),
          cached: entry.result.ok ? entry.result.cached : false,
          attempts: entry.result.attempts ?? (entry.result.ok && !entry.result.cached ? 1 : 0),
          inputTokens: entry.result.ok ? entry.result.inputTokens : 0,
          outputTokens: entry.result.ok ? entry.result.outputTokens : 0,
          ...buildLlmCallTelemetryEvidence(entry.result),
        }, {
          actor: { kind: "agent", id: decision.agentId },
          correlationId: decisionId,
          causationId: decision.trigger.sourceEventId,
        });
        callStore.insert(buildCallRecord({
          entry,
          runId,
          tick: ctx.tick,
          callId,
          decisionId,
          sourceEventId: callEvent.eventId,
          ...(validationFallbackDetail === undefined ? {} : { validationFallbackDetail }),
        }), buildLlmCallTelemetryEvidence(entry.result));
        const decisionEvent = ctx.emit("agent.decision.recorded", {
          schemaVersion: 1,
          decisionId,
          agentId: decision.agentId,
          tier: decision.tier,
          kind: entry.opportunity.kind,
          chosenActionId: decision.chosenActionId,
          llmCallId: tier === 2 ? callId : null,
          validationFailureCount: resolved.validationFailures.length,
        }, {
          actor: { kind: "agent", id: decision.agentId },
          correlationId: decisionId,
          causationId: callEvent.eventId,
        });
        for (const failure of resolved.validationFailures) {
          ctx.emit("agent.action.rejected", {
            actionId,
            decisionId,
            type: resolved.actionType,
            stage: failure.stage,
            code: failure.code,
            message: failure.message,
            proposalRejected: true,
          }, {
            actor: { kind: "agent", id: decision.agentId },
            correlationId: decisionId,
            causationId: callEvent.eventId,
          });
        }
        ctx.emit("agent.action.started", {
          actionId,
          decisionId,
          type: resolved.actionType,
        }, {
          actor: { kind: "agent", id: decision.agentId },
          correlationId: decisionId,
          causationId: decisionEvent.eventId,
        });
        const dispatched = registry.dispatch({
          intentId,
          type: resolved.actionType,
          actor: { kind: "agent", id: decision.agentId },
          tick: ctx.tick,
          params: resolved.params,
          decisionId,
          correlationId: decisionId,
        }, actionContext);
        if (dispatched.status === "applied") {
          const resultEventIds = receiptEventIds(dispatched.result);
          addEffects(state, decisionId, resultEventIds);
          drafts.push({
            actionId,
            decisionId,
            actorId: decision.agentId,
            type: dispatched.intent.type,
            params: dispatched.params as Readonly<Record<string, unknown>>,
            callEventId: callEvent.eventId,
            sourceEventId: decisionEvent.eventId,
            status: "applied",
            resultEventIds,
          });
        } else {
          const rejection = dispatched.status === "failed" ? dispatched.error : dispatched.rejection;
          const rejected = ctx.emit("agent.action.rejected", {
            actionId,
            decisionId,
            type: resolved.actionType,
            stage: dispatched.status === "failed" ? "execution" : "validation",
            code: rejection.code,
            message: rejection.message,
          }, {
            actor: { kind: "agent", id: decision.agentId },
            correlationId: decisionId,
            causationId: decisionEvent.eventId,
          });
          drafts.push({
            actionId,
            decisionId,
            actorId: decision.agentId,
            type: resolved.actionType,
            params: resolved.params,
            callEventId: callEvent.eventId,
            sourceEventId: decisionEvent.eventId,
            status: "failed",
            resultEventIds: [rejected.eventId],
            error: { code: rejection.code, message: rejection.message },
          });
        }
        ctx.count("decisions", 1);
        ctx.count("llmCalls", providerAttemptCount(entry.result));
      }

      const actions: AgentAction[] = drafts.map((draft) => {
        if (draft.status === "failed") {
          return agentActionSchema.parse({
            id: draft.actionId,
            runId,
            decisionId: draft.decisionId,
            actorId: draft.actorId,
            type: draft.type,
            params: draft.params,
            status: "failed",
            resultEventIds: draft.resultEventIds,
            error: draft.error,
          });
        }
        const effects = [...new Set([
          ...draft.resultEventIds,
          ...(state.effectEventIds.get(draft.decisionId) ?? []),
        ])].sort(compareCodeUnit);
        const completed = ctx.emit("agent.action.completed", {
          actionId: draft.actionId,
          decisionId: draft.decisionId,
          type: draft.type,
          resultEventIds: effects,
        }, {
          actor: { kind: "agent", id: draft.actorId },
          correlationId: draft.decisionId,
          causationId: draft.sourceEventId,
        });
        effects.push(completed.eventId);
        return agentActionSchema.parse({
          id: draft.actionId,
          runId,
          decisionId: draft.decisionId,
          actorId: draft.actorId,
          type: draft.type,
          params: draft.params,
          status: "applied",
          resultEventIds: effects,
        });
      });
      agentStore.saveDecisionResult([], actions);

      const memoryStore = new DeterministicMemoryStore({ repository: agentStore, ids: ctx.ids });
      const actionByDecision = new Map(actions.map((action) => [action.decisionId!, action]));
      for (const decision of decisions) {
        const action = actionByDecision.get(decision.id);
        const recorded = memoryStore.record({
          runId,
          agentId: decision.agentId,
          tick: ctx.tick,
          kind: "outcome",
          content: (
            `At tick ${ctx.tick}, the bounded decision menu selected ` +
            `${decision.chosenActionId ?? "no_action"} at Tier ${decision.tier}.`
          ),
          importance: Math.min(100, decision.trigger.priority),
          references: [...new Set([
            decision.trigger.sourceEventId,
            ...(action?.resultEventIds ?? []),
          ])].sort(compareCodeUnit),
        });
        if (recorded.compaction !== undefined) {
          const compacted = ctx.emit("agent.memory.compacted", {
            agentId: decision.agentId,
            summaryMemoryId: recorded.compaction.summary.id,
            sourceMemoryIds: recorded.compaction.sourceMemoryIds,
            activeMemoryCount: agentStore.listActive(decision.agentId).length,
          }, {
            actor: { kind: "agent", id: decision.agentId },
            correlationId: recorded.compaction.summary.id,
          });
          if (eventId(compacted) === undefined) {
            throw new EngineError("INTERNAL", "memory compaction telemetry lacked an event ID");
          }
        }
      }
    },
  };
}
