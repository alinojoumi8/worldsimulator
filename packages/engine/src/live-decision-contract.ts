/** Pure Tier 2 proposal validation and deterministic Tier 1 fallback boundary. */

import {
  EngineError,
  decisionOptionSchema,
  tier2DecisionProposalSchema,
} from "@worldtangle/shared";
import type {
  DecisionOption,
  EngineErrorCode,
  IntentEnvelope,
  Tier2DecisionProposal,
} from "@worldtangle/shared";
import type {
  ActionExecutionContext,
  ActionRegistry,
} from "./action-registry";

export type LiveProposalFailureStage =
  | "proposal_schema"
  | "offered_action"
  | "action_validation";

export interface LiveProposalValidationFailure {
  readonly stage: LiveProposalFailureStage;
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface ResolveLiveDecisionInput<TState = unknown> {
  readonly candidate: unknown;
  readonly options: readonly DecisionOption[];
  readonly registry: ActionRegistry<TState>;
  readonly context: ActionExecutionContext<TState>;
  readonly agentId: string;
  readonly decisionId: string;
  readonly intentId: string;
}

export interface ResolvedLiveDecision {
  readonly source: "live" | "tier1_fallback";
  readonly actionId: string;
  readonly actionType: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rationale: string;
  readonly validationFailures: readonly LiveProposalValidationFailure[];
  readonly proposal?: Tier2DecisionProposal;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fallbackOrder(options: readonly DecisionOption[]): DecisionOption[] {
  return [...options].sort((left, right) => {
    const utility = right.utility - left.utility;
    return utility !== 0 ? utility : compareCodeUnit(left.actionId, right.actionId);
  });
}

export function resolveLiveDecision<TState>(
  input: ResolveLiveDecisionInput<TState>,
): ResolvedLiveDecision {
  const options = input.options.map((option) => decisionOptionSchema.parse(option));
  if (options.length === 0) {
    throw new RangeError("live decision resolution requires at least one fallback option");
  }
  const failures: LiveProposalValidationFailure[] = [];
  const parsed = tier2DecisionProposalSchema.safeParse(input.candidate);
  if (!parsed.success) {
    failures.push({
      stage: "proposal_schema",
      code: "SCHEMA_INVALID",
      message: "live proposal failed the Tier 2 response schema",
      details: parsed.error.issues,
    });
  } else {
    const selected = options.find((option) => option.actionId === parsed.data.actionId);
    if (selected === undefined) {
      failures.push({
        stage: "offered_action",
        code: "PERMISSION_DENIED",
        message: "live proposal selected an action outside the engine-offered menu",
        details: { actionId: parsed.data.actionId },
      });
    } else {
      const intent: IntentEnvelope = {
        intentId: input.intentId,
        type: selected.actionType,
        actor: { kind: "agent", id: input.agentId },
        tick: input.context.tick,
        params: parsed.data.params,
        decisionId: input.decisionId,
        correlationId: input.decisionId,
      };
      const preparation = input.registry.prepare(intent, input.context);
      if (preparation.ok) {
        return {
          source: "live",
          actionId: selected.actionId,
          actionType: selected.actionType,
          params: preparation.prepared.params as Readonly<Record<string, unknown>>,
          rationale: parsed.data.rationale,
          validationFailures: Object.freeze([]),
          proposal: parsed.data,
        };
      }
      failures.push({
        stage: "action_validation",
        code: preparation.rejection.code,
        message: preparation.rejection.message,
        ...(preparation.rejection.details === undefined
          ? {}
          : { details: preparation.rejection.details }),
      });
    }
  }

  for (const fallback of fallbackOrder(options)) {
    const fallbackIntent: IntentEnvelope = {
      intentId: input.intentId,
      type: fallback.actionType,
      actor: { kind: "agent", id: input.agentId },
      tick: input.context.tick,
      params: fallback.params,
      decisionId: input.decisionId,
      correlationId: input.decisionId,
    };
    const preparation = input.registry.prepare(fallbackIntent, input.context);
    if (preparation.ok) {
      return {
        source: "tier1_fallback",
        actionId: fallback.actionId,
        actionType: fallback.actionType,
        params: preparation.prepared.params as Readonly<Record<string, unknown>>,
        rationale: "tier1_fallback_after_" + failures[0]!.stage,
        validationFailures: Object.freeze(failures),
      };
    }
    failures.push({
      stage: "action_validation",
      code: preparation.rejection.code,
      message: "Tier 1 fallback option failed action validation: " + preparation.rejection.message,
      ...(preparation.rejection.details === undefined
        ? {}
        : { details: preparation.rejection.details }),
    });
  }
  throw new EngineError(
    "INTERNAL",
    "no engine-authored Tier 1 fallback option passed the action registry",
    { failures },
  );
}
