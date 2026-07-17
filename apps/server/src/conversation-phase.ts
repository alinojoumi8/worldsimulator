/** WS-606 asynchronous Tier-3 conversation preparation and in-tick apply. */

import {
  canonicalStringify,
  decisionSchema,
  EngineError,
  hashValue,
  type Conversation,
  type ConversationCloseReason,
  type ConversationMessage,
  type ConversationOutcome,
  type ConversationStructuredTerms,
  type Decision,
  type DecisionOption,
  type Persona,
  type TriggerSignal,
} from "@worldtangle/shared";
import {
  buildAgentDecisionPrompt,
  CONVERSATION_MESSAGE_PROMPT_PACK_KEY,
  CONVERSATION_OUTCOME_PROMPT_PACK_KEY,
  conversationMessageOptions,
  conversationOutcomeOptions,
  deterministicConversationOutcome,
  llmRequestHash,
  nextConversationSpeaker,
  planConversationClose,
  resolveConversationMessageProposal,
  resolveConversationOutcomeProposal,
  simDateForTick,
  type BuiltAgentDecisionPrompt,
  type ConversationClosePlan,
  type LlmProviderRoute,
  type LlmResult,
  type PhaseHandler,
  type ResolvedConversationMessageProposal,
  type RoutedLlmProvider,
  type UntrustedPromptItem,
} from "@worldtangle/engine";
import {
  buildLlmCallRecordEvidence,
  buildLlmCallTelemetryEvidence,
} from "./llm-call-evidence";
import {
  SqliteAgentStore,
  SqliteConversationStore,
  SqliteLlmCallStore,
  type WorldDatabase,
} from "./persistence";

export interface ConversationTurnOpportunity {
  readonly key: string;
  readonly conversation: Conversation;
  readonly messages: readonly ConversationMessage[];
  readonly speakerAgentId: string;
  readonly recipientAgentId: string;
  readonly persona: Persona;
  readonly trigger: TriggerSignal;
  readonly options: readonly DecisionOption[];
  readonly trustedState: unknown;
  readonly untrustedItems: readonly UntrustedPromptItem[];
}

interface PreparedProviderCall {
  readonly prompt: BuiltAgentDecisionPrompt;
  readonly route: LlmProviderRoute;
  readonly result: LlmResult;
}

interface PreparedOutcomeCall extends PreparedProviderCall {
  readonly options: readonly DecisionOption[];
  readonly resolution: ReturnType<typeof resolveConversationOutcomeProposal> | null;
  readonly validationFallbackDetail?: string;
}

export interface PreparedConversationTurn {
  readonly opportunity: ConversationTurnOpportunity;
  readonly messageCall: PreparedProviderCall | null;
  readonly messageResolution: ResolvedConversationMessageProposal | null;
  readonly messageValidationFallbackDetail?: string;
  readonly closePlan: ConversationClosePlan;
  readonly outcomeCall: PreparedOutcomeCall | null;
}

export interface PreparedConversationBatch {
  readonly tick: number;
  readonly entries: readonly PreparedConversationTurn[];
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function transcriptItems(
  messages: readonly ConversationMessage[],
): readonly UntrustedPromptItem[] {
  return Object.freeze(messages.map((message) => Object.freeze({
    source: "message" as const,
    id: message.id,
    content: message.content,
    references: [message.sourceEventId],
  })));
}

function transcriptState(
  conversation: Conversation,
  messages: readonly ConversationMessage[],
): unknown {
  return Object.freeze({
    conversationId: conversation.id,
    topic: conversation.topic,
    participantAgentIds: conversation.participantAgentIds,
    termBounds: conversation.termBounds,
    turn: conversation.turns + 1,
    maxTurns: conversation.maxTurns,
    outputTokenBudget: conversation.outputTokenBudget,
    outputTokensUsed: conversation.outputTokensUsed,
    outputTokensRemaining:
      conversation.outputTokenBudget - conversation.outputTokensUsed,
    structuredTranscript: messages.map((message) => ({
      messageId: message.id,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      turn: message.turn,
      kind: message.kind,
      structuredTerms: message.structuredTerms,
      sourceEventId: message.sourceEventId,
    })),
  });
}

/**
 * Finds at most one due conversation per participant for a tick. Deferred
 * conversations stay active and are reconsidered in canonical ID order.
 */
export function discoverConversationTurnOpportunities(
  db: WorldDatabase,
  runId: string,
  tick: number,
): readonly ConversationTurnOpportunity[] {
  const conversations = new SqliteConversationStore(db, runId);
  const agents = new SqliteAgentStore(db, runId);
  const busyAgents = new Set<string>();
  const opportunities: ConversationTurnOpportunity[] = [];
  for (const conversation of conversations.listDueForTurn(tick)) {
    if (conversation.participantAgentIds.some((agentId) => busyAgents.has(agentId))) {
      continue;
    }
    const messages = conversations.listMessages(conversation.id);
    const speakerAgentId = nextConversationSpeaker(conversation, messages);
    const recipientAgentId = conversation.participantAgentIds.find(
      (agentId) => agentId !== speakerAgentId,
    );
    if (recipientAgentId === undefined) {
      throw new EngineError("INTERNAL", "conversation recipient is missing");
    }
    const profile = agents.getProfile(speakerAgentId, 0);
    const latest = messages.at(-1);
    const sourceEventId = latest?.sourceEventId ?? conversation.sourceEventId;
    const trigger: TriggerSignal = {
      kind: "message",
      agentId: speakerAgentId,
      sourceEventId,
      tick,
      priority: 80,
      payload: {
        messageId: latest?.id ?? conversation.id,
        conversationId: conversation.id,
      },
    };
    opportunities.push(Object.freeze({
      key: `${conversation.id}.turn.${conversation.turns + 1}`,
      conversation,
      messages,
      speakerAgentId,
      recipientAgentId,
      persona: profile.persona,
      trigger,
      options: conversationMessageOptions(conversation, messages),
      trustedState: transcriptState(conversation, messages),
      untrustedItems: transcriptItems(messages),
    }));
    for (const agentId of conversation.participantAgentIds) busyAgents.add(agentId);
  }
  return Object.freeze(opportunities);
}

function capPromptOutput(
  prompt: BuiltAgentDecisionPrompt,
  remainingTokens: number,
): BuiltAgentDecisionPrompt {
  if (!Number.isSafeInteger(remainingTokens) || remainingTokens < 1) {
    throw new EngineError("LIMIT_EXCEEDED", "conversation has no output tokens remaining");
  }
  const configured = prompt.request.maxOutputTokens ?? remainingTokens;
  return Object.freeze({
    ...prompt,
    request: Object.freeze({
      ...prompt.request,
      maxOutputTokens: Math.min(configured, remainingTokens),
    }),
  });
}

async function callProvider(
  provider: RoutedLlmProvider,
  prompt: BuiltAgentDecisionPrompt,
): Promise<PreparedProviderCall> {
  let route: LlmProviderRoute;
  try {
    route = provider.route(prompt.request);
  } catch {
    route = { provider: "unavailable", model: "unavailable" };
  }
  let result: LlmResult;
  try {
    result = await provider.propose(prompt.request);
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
      requestedTier: prompt.request.tier,
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
      requestedTier: prompt.request.tier,
      effectiveTier: 1,
    };
  }
  return Object.freeze({ prompt, route, result });
}

function validationDetail(error: unknown): string {
  if (error instanceof EngineError) return `${error.code}:${error.message}`;
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return "provider proposal failed conversation validation";
}

function candidateTranscriptItems(
  opportunity: ConversationTurnOpportunity,
  resolution: ResolvedConversationMessageProposal,
): readonly UntrustedPromptItem[] {
  return Object.freeze([
    ...opportunity.untrustedItems,
    Object.freeze({
      source: "message" as const,
      id: `${opportunity.conversation.id}.candidate.${opportunity.conversation.turns + 1}`,
      content: resolution.content,
      references: [opportunity.trigger.sourceEventId],
    }),
  ]);
}

async function prepareOutcomeCall(input: {
  readonly opportunity: ConversationTurnOpportunity;
  readonly resolution: ResolvedConversationMessageProposal;
  readonly closePlan: ConversationClosePlan;
  readonly remainingTokens: number;
  readonly provider: RoutedLlmProvider;
  readonly promptPackVersion: number;
}): Promise<PreparedOutcomeCall | null> {
  if (input.closePlan.closeReason === null || input.remainingTokens < 1) return null;
  const options = conversationOutcomeOptions(
    input.opportunity.conversation,
    input.closePlan.closeReason,
    input.closePlan.acceptedTerms,
  );
  const prompt = capPromptOutput(buildAgentDecisionPrompt({
    persona: input.opportunity.persona,
    tick: input.opportunity.trigger.tick,
    simDate: simDateForTick(input.opportunity.trigger.tick),
    trigger: input.opportunity.trigger,
    trustedState: {
      ...input.opportunity.trustedState as Record<string, unknown>,
      terminalCloseReason: input.closePlan.closeReason,
      acceptedStructuredTerms: input.closePlan.acceptedTerms,
      candidateStructuredTerms: input.resolution.structuredTerms,
      candidateKind: input.resolution.kind,
    },
    untrustedItems: candidateTranscriptItems(input.opportunity, input.resolution),
    options,
    purpose: "conversation.outcome",
    correlationId: `${input.opportunity.key}.outcome`,
    budgetTag: `conversation_${input.opportunity.conversation.topic}_outcome`,
    promptPackKey: CONVERSATION_OUTCOME_PROMPT_PACK_KEY,
    promptPackVersion: input.promptPackVersion,
  }), input.remainingTokens);
  const call = await callProvider(input.provider, prompt);
  let resolution: ReturnType<typeof resolveConversationOutcomeProposal> | null = null;
  let validationFallbackDetail: string | undefined;
  if (call.result.ok) {
    try {
      if (call.result.outputTokens > input.remainingTokens) {
        throw new EngineError(
          "LIMIT_EXCEEDED",
          "outcome response exceeds the remaining conversation token budget",
        );
      }
      resolution = resolveConversationOutcomeProposal(call.result.value, options);
    } catch (error) {
      validationFallbackDetail = validationDetail(error);
    }
  }
  return Object.freeze({
    ...call,
    options,
    resolution,
    ...(validationFallbackDetail === undefined ? {} : { validationFallbackDetail }),
  });
}

/** Performs provider/cache/budget work before the authoritative tick begins. */
export async function prepareConversationBatch(input: {
  readonly db: WorldDatabase;
  readonly runId: string;
  readonly tick: number;
  readonly promptPackVersion: number;
  readonly provider?: RoutedLlmProvider;
  readonly opportunities?: readonly ConversationTurnOpportunity[];
}): Promise<PreparedConversationBatch | undefined> {
  const opportunities = input.opportunities ??
    discoverConversationTurnOpportunities(input.db, input.runId, input.tick);
  if (opportunities.length === 0) return undefined;
  const entries: PreparedConversationTurn[] = [];
  for (const opportunity of opportunities) {
    if (opportunity.trigger.tick !== input.tick) {
      throw new EngineError("CONFLICT", "conversation opportunity belongs to another tick");
    }
    if (input.provider === undefined) {
      entries.push(Object.freeze({
        opportunity,
        messageCall: null,
        messageResolution: null,
        closePlan: Object.freeze({
          acceptMessage: true,
          closeReason: "provider_fallback",
          acceptedTerms: null,
        }),
        outcomeCall: null,
      }));
      continue;
    }
    const remaining = opportunity.conversation.outputTokenBudget -
      opportunity.conversation.outputTokensUsed;
    if (remaining < 1) {
      entries.push(Object.freeze({
        opportunity,
        messageCall: null,
        messageResolution: null,
        closePlan: Object.freeze({
          acceptMessage: false,
          closeReason: "token_budget",
          acceptedTerms: null,
        }),
        outcomeCall: null,
      }));
      continue;
    }
    const prompt = capPromptOutput(buildAgentDecisionPrompt({
      persona: opportunity.persona,
      tick: input.tick,
      simDate: simDateForTick(input.tick),
      trigger: opportunity.trigger,
      trustedState: opportunity.trustedState,
      untrustedItems: opportunity.untrustedItems,
      options: opportunity.options,
      purpose: "conversation.message",
      correlationId: opportunity.key,
      budgetTag: `conversation_${opportunity.conversation.topic}_message`,
      promptPackKey: CONVERSATION_MESSAGE_PROMPT_PACK_KEY,
      promptPackVersion: input.promptPackVersion,
    }), remaining);
    const messageCall = await callProvider(input.provider, prompt);
    let messageResolution: ResolvedConversationMessageProposal | null = null;
    let messageValidationFallbackDetail: string | undefined;
    let closePlan: ConversationClosePlan;
    if (!messageCall.result.ok) {
      closePlan = Object.freeze({
        acceptMessage: true,
        closeReason: "provider_fallback",
        acceptedTerms: null,
      });
    } else {
      try {
        messageResolution = resolveConversationMessageProposal(
          messageCall.result.value,
          opportunity.options,
        );
        closePlan = planConversationClose({
          conversation: opportunity.conversation,
          messages: opportunity.messages,
          senderAgentId: opportunity.speakerAgentId,
          proposal: messageResolution,
          outputTokens: messageCall.result.outputTokens,
        });
      } catch (error) {
        messageValidationFallbackDetail = validationDetail(error);
        closePlan = Object.freeze({
          acceptMessage: true,
          closeReason: "invalid_proposal",
          acceptedTerms: null,
        });
      }
    }
    const messageAccepted = messageCall.result.ok &&
      messageResolution !== null &&
      closePlan.acceptMessage;
    const remainingAfterMessage = remaining - (
      messageAccepted ? messageCall.result.outputTokens : 0
    );
    const outcomeCall = messageAccepted && closePlan.closeReason !== null
      ? await prepareOutcomeCall({
          opportunity,
          resolution: messageResolution!,
          closePlan,
          remainingTokens: remainingAfterMessage,
          provider: input.provider,
          promptPackVersion: input.promptPackVersion,
        })
      : null;
    entries.push(Object.freeze({
      opportunity,
      messageCall,
      messageResolution,
      ...(messageValidationFallbackDetail === undefined
        ? {}
        : { messageValidationFallbackDetail }),
      closePlan,
      outcomeCall,
    }));
  }
  return Object.freeze({ tick: input.tick, entries: Object.freeze(entries) });
}

function providerAttemptCount(result: LlmResult): number {
  return result.attempts ?? (result.ok && !result.cached ? 1 : 0);
}

function fallbackMessageOption(options: readonly DecisionOption[]): DecisionOption {
  const option = options.find((candidate) => candidate.actionId === "conversation.decline");
  if (option === undefined) {
    throw new EngineError("INTERNAL", "conversation menu lacks a fail-closed option");
  }
  return option;
}

function fallbackOutcomeOption(
  options: readonly DecisionOption[],
  closeReason: ConversationCloseReason,
): DecisionOption {
  const actionId = closeReason === "agreement"
    ? "conversation.outcome.agreement"
    : "conversation.outcome.no_agreement";
  const option = options.find((candidate) => candidate.actionId === actionId);
  if (option === undefined) {
    throw new EngineError("INTERNAL", `conversation outcome menu lacks ${actionId}`);
  }
  return option;
}

function decisionObservation(
  entry: PreparedConversationTurn,
  kind: "message" | "outcome",
): Readonly<{ hash: string; summary: string }> {
  const prompt = kind === "message" ? entry.messageCall?.prompt : entry.outcomeCall?.prompt;
  if (prompt !== undefined) return prompt.observationDigest;
  return Object.freeze({
    hash: hashValue({
      format: "worldtangle.conversation.rule-observation.v1",
      conversationId: entry.opportunity.conversation.id,
      tick: entry.opportunity.trigger.tick,
      turn: entry.opportunity.conversation.turns + 1,
      kind,
    }),
    summary: (
      `Conversation ${entry.opportunity.conversation.id} ${kind} ` +
      `fallback at tick ${entry.opportunity.trigger.tick}.`
    ),
  });
}

function recordCall(input: {
  readonly db: WorldDatabase;
  readonly runId: string;
  readonly tick: number;
  readonly agentId: string;
  readonly decisionId: string;
  readonly callId: string;
  readonly call: PreparedProviderCall;
  readonly validationFallbackDetail?: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly ctx: Parameters<PhaseHandler["run"]>[0];
}): string {
  const fallback = !input.call.result.ok || input.validationFallbackDetail !== undefined;
  const event = input.ctx.emit("llm.call.recorded", {
    schemaVersion: 2,
    callId: input.callId,
    decisionId: input.decisionId,
    agentId: input.agentId,
    moduleId: input.call.prompt.request.moduleId,
    purpose: input.call.prompt.request.purpose,
    provider: input.call.route.provider,
    model: input.call.result.ok ? input.call.result.model : input.call.route.model,
    requestHash: input.call.result.requestHash,
    promptHash: input.call.prompt.promptHash,
    status: fallback ? "fallback" : "success",
    effectiveTier: fallback ? 1 : input.call.prompt.request.tier,
    ...(!input.call.result.ok
      ? { fallbackReason: input.call.result.reason }
      : input.validationFallbackDetail === undefined
        ? {}
        : { fallbackReason: "validation_failed" }),
    cached: input.call.result.ok ? input.call.result.cached : false,
    attempts: providerAttemptCount(input.call.result),
    inputTokens: input.call.result.ok ? input.call.result.inputTokens : 0,
    outputTokens: input.call.result.ok ? input.call.result.outputTokens : 0,
    ...buildLlmCallTelemetryEvidence(input.call.result),
  }, {
    actor: { kind: "agent", id: input.agentId },
    schemaVersion: 1,
    correlationId: input.correlationId,
    causationId: input.causationId,
  });
  new SqliteLlmCallStore(input.db, input.runId).insert(buildLlmCallRecordEvidence({
    prompt: input.call.prompt,
    result: input.call.result,
    route: input.call.route,
    agentId: input.agentId,
    runId: input.runId,
    tick: input.tick,
    callId: input.callId,
    decisionId: input.decisionId,
    sourceEventId: event.eventId,
    ...(input.validationFallbackDetail === undefined
      ? {}
      : { validationFallbackDetail: input.validationFallbackDetail }),
  }), buildLlmCallTelemetryEvidence(input.call.result));
  input.ctx.count("llmCalls", providerAttemptCount(input.call.result));
  return event.eventId;
}

function messageDecision(input: {
  readonly entry: PreparedConversationTurn;
  readonly decisionId: string;
  readonly callId: string | null;
  readonly live: boolean;
  readonly option: DecisionOption;
  readonly rationale: string;
  readonly runId: string;
  readonly tick: number;
}): Decision {
  const call = input.entry.messageCall;
  return decisionSchema.parse({
    id: input.decisionId,
    runId: input.runId,
    agentId: input.entry.opportunity.speakerAgentId,
    tick: input.tick,
    trigger: {
      kind: "message",
      sourceEventId: input.entry.opportunity.trigger.sourceEventId,
      priority: input.entry.opportunity.trigger.priority,
    },
    tier: input.live ? 3 : 1,
    observationDigest: decisionObservation(input.entry, "message"),
    optionsOffered: input.entry.opportunity.options,
    chosenActionId: input.option.actionId,
    params: input.option.params,
    rationale: input.rationale,
    ...(input.live && call !== null && input.callId !== null
      ? {
          llmCallId: input.callId,
          promptPackKey: call.prompt.promptPackKey,
          promptVersion: call.prompt.promptPackVersion,
          promptHash: call.prompt.promptHash,
        }
      : {}),
    validationResult: { status: "approved" },
  });
}

function outcomeFromOption(
  option: DecisionOption,
  rationale: string,
  extractedBy: "tier2" | "rule",
  decisionId: string,
  callId: string | null,
): ConversationOutcome {
  const kind = option.params["kind"];
  const structuredTerms = option.params["structuredTerms"];
  if (kind !== "agreement" && kind !== "no_agreement" && kind !== "escalate") {
    throw new EngineError("INTERNAL", "conversation outcome option kind is invalid");
  }
  return {
    kind,
    structuredTerms: structuredTerms as ConversationStructuredTerms | null,
    extractedBy,
    rationale,
    decisionId,
    llmCallId: callId,
  };
}

function assertPreparedCurrent(
  store: SqliteConversationStore,
  entry: PreparedConversationTurn,
): void {
  const current = store.get(entry.opportunity.conversation.id);
  const messages = store.listMessages(current.id);
  if (
    canonicalStringify(current) !== canonicalStringify(entry.opportunity.conversation) ||
    canonicalStringify(messages) !== canonicalStringify(entry.opportunity.messages)
  ) {
    throw new EngineError("CONFLICT", "prepared conversation state is stale");
  }
}

/** Applies prepared calls synchronously inside the authoritative tick transaction. */
export function createConversationPhaseHandler(
  db: WorldDatabase,
  runId: string,
  batch?: PreparedConversationBatch,
): PhaseHandler {
  return {
    module: "M05-bounded-conversations",
    order: 75,
    run(ctx) {
      const store = new SqliteConversationStore(db, runId);
      store.deliverDue(ctx.tick, ctx);
      if (batch === undefined) return;
      if (batch.tick !== ctx.tick) {
        throw new EngineError("CONFLICT", "prepared conversation batch belongs to another tick");
      }
      const keys = batch.entries.map((entry) => entry.opportunity.key);
      if (
        new Set(keys).size !== keys.length ||
        canonicalStringify(keys) !== canonicalStringify([...keys].sort(compareCodeUnit))
      ) {
        throw new EngineError("CONFLICT", "prepared conversation batch is duplicated or unordered");
      }
      const agentStore = new SqliteAgentStore(db, runId);
      for (const entry of batch.entries) {
        assertPreparedCurrent(store, entry);
        const messageDecisionId = ctx.ids.next("dec");
        const messageCallId = entry.messageCall === null ? null : ctx.ids.next("llm");
        const liveMessage = entry.messageCall?.result.ok === true &&
          entry.messageResolution !== null &&
          entry.closePlan.acceptMessage &&
          entry.messageValidationFallbackDetail === undefined;
        const selectedMessageOption = liveMessage
          ? entry.messageResolution!.option
          : fallbackMessageOption(entry.opportunity.options);
        const messageRationale = liveMessage
          ? entry.messageResolution!.content
          : `rule:fail_closed:${entry.closePlan.closeReason ?? "invalid_proposal"}`;
        const decision = messageDecision({
          entry,
          decisionId: messageDecisionId,
          callId: messageCallId,
          live: liveMessage,
          option: selectedMessageOption,
          rationale: messageRationale,
          runId,
          tick: ctx.tick,
        });
        agentStore.saveDecisionResult([decision], []);
        let messageCallEventId: string | null = null;
        if (entry.messageCall !== null && messageCallId !== null) {
          const fallbackDetail = liveMessage
            ? undefined
            : entry.messageValidationFallbackDetail ?? (
                entry.messageCall.result.ok
                  ? "conversation message did not pass the hard token or action boundary"
                  : undefined
              );
          messageCallEventId = recordCall({
            db,
            runId,
            tick: ctx.tick,
            agentId: decision.agentId,
            decisionId: decision.id,
            callId: messageCallId,
            call: entry.messageCall,
            ...(fallbackDetail === undefined ? {} : { validationFallbackDetail: fallbackDetail }),
            causationId: decision.trigger.sourceEventId,
            correlationId: entry.opportunity.conversation.id,
            ctx,
          });
        }
        const decisionEvent = ctx.emit("agent.decision.recorded", {
          schemaVersion: 1,
          decisionId: decision.id,
          agentId: decision.agentId,
          tier: decision.tier,
          kind: "conversation_message",
          conversationId: entry.opportunity.conversation.id,
          chosenActionId: decision.chosenActionId,
          llmCallId: decision.llmCallId ?? null,
          validationFallback: !liveMessage,
          evidenceEventIds: [
            decision.trigger.sourceEventId,
            ...(messageCallEventId === null ? [] : [messageCallEventId]),
          ].sort(compareCodeUnit),
        }, {
          actor: { kind: "agent", id: decision.agentId },
          schemaVersion: 1,
          correlationId: entry.opportunity.conversation.id,
          causationId: messageCallEventId ?? decision.trigger.sourceEventId,
        });
        if (!liveMessage && entry.messageCall !== null) {
          ctx.emit("conversation.message.rejected", {
            schemaVersion: 1,
            conversationId: entry.opportunity.conversation.id,
            decisionId: decision.id,
            reason: entry.closePlan.closeReason,
            detail: entry.messageValidationFallbackDetail ?? (
              entry.messageCall.result.ok
                ? "hard conversation boundary rejected the proposal"
                : entry.messageCall.result.reason
            ),
            evidenceEventIds: [decisionEvent.eventId],
          }, {
            actor: { kind: "agent", id: decision.agentId },
            schemaVersion: 1,
            correlationId: entry.opportunity.conversation.id,
            causationId: decisionEvent.eventId,
          });
        }

        let message: ConversationMessage | null = null;
        if (liveMessage) {
          const result = entry.messageCall!.result;
          if (!result.ok) throw new EngineError("INTERNAL", "live message lacks provider result");
          message = store.appendMessage({
            conversationId: entry.opportunity.conversation.id,
            senderAgentId: decision.agentId,
            actionId: selectedMessageOption.actionId,
            kind: entry.messageResolution!.kind,
            content: entry.messageResolution!.content,
            structuredTerms: entry.messageResolution!.structuredTerms,
            decisionId: decision.id,
            llmCallId: messageCallId,
            outputTokens: result.outputTokens,
          }, ctx);
        } else if (entry.closePlan.acceptMessage) {
          message = store.appendMessage({
            conversationId: entry.opportunity.conversation.id,
            senderAgentId: decision.agentId,
            actionId: selectedMessageOption.actionId,
            kind: "decline",
            content: "Deterministic fail-closed response.",
            structuredTerms: null,
            decisionId: decision.id,
            llmCallId: null,
            outputTokens: 0,
          }, ctx);
        }
        ctx.count("decisions", 1);

        if (entry.closePlan.closeReason === null) continue;
        const acceptedTerms = entry.closePlan.acceptedTerms;
        const outcomeOptions = entry.outcomeCall?.options ?? conversationOutcomeOptions(
          entry.opportunity.conversation,
          entry.closePlan.closeReason,
          acceptedTerms,
        );
        const outcomeDecisionId = ctx.ids.next("dec");
        const outcomeCallId = entry.outcomeCall === null ? null : ctx.ids.next("llm");
        const liveOutcome = entry.outcomeCall?.result.ok === true &&
          entry.outcomeCall.resolution !== null &&
          entry.outcomeCall.validationFallbackDetail === undefined;
        const selectedOutcomeOption = liveOutcome
          ? entry.outcomeCall!.resolution!.option
          : fallbackOutcomeOption(outcomeOptions, entry.closePlan.closeReason);
        const outcomeRationale = liveOutcome
          ? entry.outcomeCall!.resolution!.rationale
          : `rule:${entry.closePlan.closeReason}`;
        const outcomeDecision = decisionSchema.parse({
          id: outcomeDecisionId,
          runId,
          agentId: entry.opportunity.speakerAgentId,
          tick: ctx.tick,
          trigger: {
            kind: "message",
            sourceEventId: message?.sourceEventId ?? decisionEvent.eventId,
            priority: entry.opportunity.trigger.priority,
          },
          tier: liveOutcome ? 2 : 1,
          observationDigest: decisionObservation(entry, "outcome"),
          optionsOffered: outcomeOptions,
          chosenActionId: selectedOutcomeOption.actionId,
          params: selectedOutcomeOption.params,
          rationale: outcomeRationale,
          ...(liveOutcome && entry.outcomeCall !== null && outcomeCallId !== null
            ? {
                llmCallId: outcomeCallId,
                promptPackKey: entry.outcomeCall.prompt.promptPackKey,
                promptVersion: entry.outcomeCall.prompt.promptPackVersion,
                promptHash: entry.outcomeCall.prompt.promptHash,
              }
            : {}),
          validationResult: { status: "approved" },
        });
        agentStore.saveDecisionResult([outcomeDecision], []);
        let outcomeCallEventId: string | null = null;
        if (entry.outcomeCall !== null && outcomeCallId !== null) {
          outcomeCallEventId = recordCall({
            db,
            runId,
            tick: ctx.tick,
            agentId: outcomeDecision.agentId,
            decisionId: outcomeDecision.id,
            callId: outcomeCallId,
            call: entry.outcomeCall,
            ...(entry.outcomeCall.validationFallbackDetail === undefined
              ? {}
              : { validationFallbackDetail: entry.outcomeCall.validationFallbackDetail }),
            causationId: outcomeDecision.trigger.sourceEventId,
            correlationId: entry.opportunity.conversation.id,
            ctx,
          });
        }
        const outcomeDecisionEvent = ctx.emit("agent.decision.recorded", {
          schemaVersion: 1,
          decisionId: outcomeDecision.id,
          agentId: outcomeDecision.agentId,
          tier: outcomeDecision.tier,
          kind: "conversation_outcome",
          conversationId: entry.opportunity.conversation.id,
          chosenActionId: outcomeDecision.chosenActionId,
          llmCallId: outcomeDecision.llmCallId ?? null,
          validationFallback: !liveOutcome,
          evidenceEventIds: [
            outcomeDecision.trigger.sourceEventId,
            ...(outcomeCallEventId === null ? [] : [outcomeCallEventId]),
          ].sort(compareCodeUnit),
        }, {
          actor: { kind: "agent", id: outcomeDecision.agentId },
          schemaVersion: 1,
          correlationId: entry.opportunity.conversation.id,
          causationId: outcomeCallEventId ?? outcomeDecision.trigger.sourceEventId,
        });
        const outcome = liveOutcome && outcomeCallId !== null
          ? outcomeFromOption(
              selectedOutcomeOption,
              outcomeRationale,
              "tier2",
              outcomeDecision.id,
              outcomeCallId,
            )
          : deterministicConversationOutcome(
              entry.closePlan.closeReason,
              acceptedTerms,
              outcomeRationale,
              outcomeDecision.id,
            );
        const outcomeOutputTokens = liveOutcome && entry.outcomeCall?.result.ok === true
          ? entry.outcomeCall.result.outputTokens
          : 0;
        void outcomeDecisionEvent;
        store.close({
          conversationId: entry.opportunity.conversation.id,
          closeReason: entry.closePlan.closeReason,
          outcome,
          outcomeOutputTokens,
        }, ctx);
        ctx.count("decisions", 1);
      }
    },
  };
}
