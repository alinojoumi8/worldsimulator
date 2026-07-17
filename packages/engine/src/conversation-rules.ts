import {
  canonicalStringify,
  conversationStructuredTermsSchema,
  conversationTermBoundsSchema,
  decisionOptionSchema,
  EngineError,
  tier2DecisionProposalSchema,
  type Conversation,
  type ConversationCloseReason,
  type ConversationMessage,
  type ConversationOutcome,
  type ConversationStructuredTerms,
  type ConversationTermBounds,
  type DecisionOption,
  type Relationship,
  type Tier2DecisionProposal,
} from "@worldtangle/shared";

export interface ResolvedConversationMessageProposal {
  readonly option: DecisionOption;
  readonly kind: ConversationMessage["kind"];
  readonly structuredTerms: ConversationStructuredTerms | null;
  readonly content: string;
}

export interface ConversationClosePlan {
  readonly acceptMessage: boolean;
  readonly closeReason: ConversationCloseReason | null;
  readonly acceptedTerms: ConversationStructuredTerms | null;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function midpointBigint(minimum: string, maximum: string): string {
  return ((BigInt(minimum) + BigInt(maximum)) / 2n).toString();
}

function uniqueTerms(
  candidates: readonly ConversationStructuredTerms[],
): readonly ConversationStructuredTerms[] {
  const byCanonical = new Map<string, ConversationStructuredTerms>();
  for (const candidate of candidates) {
    const terms = conversationStructuredTermsSchema.parse(candidate);
    byCanonical.set(canonicalStringify(terms), terms);
  }
  return Object.freeze(
    [...byCanonical.entries()]
      .sort(([left], [right]) => compareCodeUnit(left, right))
      .map(([, terms]) => Object.freeze(terms)),
  );
}

export function conversationTermCandidates(
  boundsInput: ConversationTermBounds,
): readonly ConversationStructuredTerms[] {
  const bounds = conversationTermBoundsSchema.parse(boundsInput);
  if (bounds.kind === "purchase") {
    const midQuantity = Math.floor((bounds.minQuantity + bounds.maxQuantity) / 2);
    return uniqueTerms([
      {
        kind: "purchase",
        referenceId: bounds.referenceId,
        quantity: bounds.minQuantity,
        unitPriceCents: bounds.minUnitPriceCents,
      },
      {
        kind: "purchase",
        referenceId: bounds.referenceId,
        quantity: midQuantity,
        unitPriceCents: midpointBigint(bounds.minUnitPriceCents, bounds.maxUnitPriceCents),
      },
      {
        kind: "purchase",
        referenceId: bounds.referenceId,
        quantity: bounds.maxQuantity,
        unitPriceCents: bounds.maxUnitPriceCents,
      },
    ]);
  }
  return uniqueTerms([
    {
      kind: "job",
      referenceId: bounds.referenceId,
      annualWageCents: bounds.minAnnualWageCents,
    },
    {
      kind: "job",
      referenceId: bounds.referenceId,
      annualWageCents: midpointBigint(
        bounds.minAnnualWageCents,
        bounds.maxAnnualWageCents,
      ),
    },
    {
      kind: "job",
      referenceId: bounds.referenceId,
      annualWageCents: bounds.maxAnnualWageCents,
    },
  ]);
}

export function termsWithinConversationBounds(
  boundsInput: ConversationTermBounds,
  termsInput: ConversationStructuredTerms,
): boolean {
  const bounds = conversationTermBoundsSchema.parse(boundsInput);
  const terms = conversationStructuredTermsSchema.parse(termsInput);
  if (bounds.kind !== terms.kind || bounds.referenceId !== terms.referenceId) return false;
  if (bounds.kind === "purchase" && terms.kind === "purchase") {
    const price = BigInt(terms.unitPriceCents);
    return terms.quantity >= bounds.minQuantity &&
      terms.quantity <= bounds.maxQuantity &&
      price >= BigInt(bounds.minUnitPriceCents) &&
      price <= BigInt(bounds.maxUnitPriceCents);
  }
  if (bounds.kind === "job" && terms.kind === "job") {
    const wage = BigInt(terms.annualWageCents);
    return wage >= BigInt(bounds.minAnnualWageCents) &&
      wage <= BigInt(bounds.maxAnnualWageCents);
  }
  return false;
}

export function nextConversationSpeaker(
  conversation: Conversation,
  messages: readonly ConversationMessage[],
): string {
  if (conversation.status !== "active") {
    throw new EngineError("CONFLICT", "closed conversation has no next speaker");
  }
  if (messages.length !== conversation.turns) {
    throw new EngineError("CONFLICT", "conversation turn checkpoint disagrees with messages");
  }
  return conversation.participantAgentIds[messages.length % 2]!;
}

function lastTermsFromOther(
  senderAgentId: string,
  messages: readonly ConversationMessage[],
): ConversationStructuredTerms | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.senderAgentId !== senderAgentId && message.structuredTerms !== null) {
      return message.structuredTerms;
    }
  }
  return null;
}

export function conversationMessageOptions(
  conversation: Conversation,
  messages: readonly ConversationMessage[],
): readonly DecisionOption[] {
  const senderAgentId = nextConversationSpeaker(conversation, messages);
  const messageKind = messages.length === 0 ? "offer" : "counter";
  const candidates = conversationTermCandidates(conversation.termBounds);
  const options: DecisionOption[] = candidates.map((structuredTerms, index) =>
    decisionOptionSchema.parse({
      actionId: `conversation.${messageKind}.${index + 1}`,
      actionType: "conversation.send_message",
      params: { conversationId: conversation.id, messageKind, structuredTerms },
      utility: 300 - index,
      utilityFactors: { boundedTerms: 300 - index },
    })
  );
  const offeredTerms = lastTermsFromOther(senderAgentId, messages);
  if (offeredTerms !== null) {
    options.push(decisionOptionSchema.parse({
      actionId: "conversation.accept",
      actionType: "conversation.send_message",
      params: {
        conversationId: conversation.id,
        messageKind: "accept",
        structuredTerms: offeredTerms,
      },
      utility: 400,
      utilityFactors: { agreementAvailable: 400 },
    }));
  }
  options.push(decisionOptionSchema.parse({
    actionId: "conversation.clarify",
    actionType: "conversation.send_message",
    params: {
      conversationId: conversation.id,
      messageKind: "clarify",
      structuredTerms: null,
    },
    utility: 0,
  }));
  options.push(decisionOptionSchema.parse({
    actionId: "conversation.decline",
    actionType: "conversation.send_message",
    params: {
      conversationId: conversation.id,
      messageKind: "decline",
      structuredTerms: null,
    },
    utility: -100,
  }));
  return Object.freeze(options.sort((left, right) => compareCodeUnit(left.actionId, right.actionId)));
}

export function resolveConversationMessageProposal(
  value: unknown,
  options: readonly DecisionOption[],
): ResolvedConversationMessageProposal {
  const proposal = tier2DecisionProposalSchema.parse(value);
  const option = options.find((candidate) =>
    candidate.actionId === proposal.actionId &&
    canonicalStringify(candidate.params) === canonicalStringify(proposal.params)
  );
  if (option === undefined) {
    throw new EngineError("PERMISSION_DENIED", "conversation proposal was not in the offered menu");
  }
  const messageKind = option.params["messageKind"];
  if (
    messageKind !== "offer" &&
    messageKind !== "counter" &&
    messageKind !== "accept" &&
    messageKind !== "decline" &&
    messageKind !== "clarify"
  ) {
    throw new EngineError("SCHEMA_INVALID", "conversation option has an invalid message kind");
  }
  const rawTerms = option.params["structuredTerms"];
  const structuredTerms = rawTerms === null
    ? null
    : conversationStructuredTermsSchema.parse(rawTerms);
  return Object.freeze({
    option,
    kind: messageKind,
    structuredTerms,
    content: proposal.rationale,
  });
}

export function conversationHasNoProgress(
  senderAgentId: string,
  structuredTerms: ConversationStructuredTerms | null,
  messages: readonly ConversationMessage[],
): boolean {
  if (structuredTerms === null) return false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const previous = messages[index]!;
    if (previous.senderAgentId !== senderAgentId) continue;
    return previous.structuredTerms !== null &&
      canonicalStringify(previous.structuredTerms) === canonicalStringify(structuredTerms);
  }
  return false;
}

export function planConversationClose(input: {
  readonly conversation: Conversation;
  readonly messages: readonly ConversationMessage[];
  readonly senderAgentId: string;
  readonly proposal: ResolvedConversationMessageProposal;
  readonly outputTokens: number;
}): ConversationClosePlan {
  const { conversation, messages, senderAgentId, proposal, outputTokens } = input;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new EngineError("SCHEMA_INVALID", "conversation output-token usage is invalid");
  }
  const remaining = conversation.outputTokenBudget - conversation.outputTokensUsed;
  if (outputTokens > remaining) {
    return Object.freeze({ acceptMessage: false, closeReason: "token_budget", acceptedTerms: null });
  }
  if (proposal.kind === "accept") {
    const offeredTerms = lastTermsFromOther(senderAgentId, messages);
    if (
      offeredTerms === null ||
      proposal.structuredTerms === null ||
      canonicalStringify(offeredTerms) !== canonicalStringify(proposal.structuredTerms)
    ) {
      throw new EngineError("PERMISSION_DENIED", "accept must repeat the latest opposing terms");
    }
    return Object.freeze({
      acceptMessage: true,
      closeReason: "agreement",
      acceptedTerms: proposal.structuredTerms,
    });
  }
  if (proposal.kind === "decline") {
    return Object.freeze({ acceptMessage: true, closeReason: "declined", acceptedTerms: null });
  }
  if (conversationHasNoProgress(senderAgentId, proposal.structuredTerms, messages)) {
    return Object.freeze({ acceptMessage: true, closeReason: "no_progress", acceptedTerms: null });
  }
  if (messages.length + 1 >= conversation.maxTurns) {
    return Object.freeze({ acceptMessage: true, closeReason: "max_turns", acceptedTerms: null });
  }
  if (conversation.outputTokensUsed + outputTokens >= conversation.outputTokenBudget) {
    return Object.freeze({ acceptMessage: true, closeReason: "token_budget", acceptedTerms: null });
  }
  return Object.freeze({ acceptMessage: true, closeReason: null, acceptedTerms: null });
}

export function conversationOutcomeOptions(
  conversation: Conversation,
  closeReason: ConversationCloseReason,
  acceptedTerms: ConversationStructuredTerms | null,
): readonly DecisionOption[] {
  const options: DecisionOption[] = [];
  if (closeReason === "agreement" && acceptedTerms !== null) {
    options.push(decisionOptionSchema.parse({
      actionId: "conversation.outcome.agreement",
      actionType: "conversation.extract_outcome",
      params: {
        conversationId: conversation.id,
        kind: "agreement",
        structuredTerms: acceptedTerms,
      },
      utility: 1_000,
    }));
  } else {
    options.push(decisionOptionSchema.parse({
      actionId: "conversation.outcome.no_agreement",
      actionType: "conversation.extract_outcome",
      params: {
        conversationId: conversation.id,
        kind: "no_agreement",
        structuredTerms: null,
      },
      utility: 1_000,
    }));
    if (closeReason === "max_turns" || closeReason === "no_progress") {
      options.push(decisionOptionSchema.parse({
        actionId: "conversation.outcome.escalate",
        actionType: "conversation.extract_outcome",
        params: {
          conversationId: conversation.id,
          kind: "escalate",
          structuredTerms: null,
        },
        utility: 0,
      }));
    }
  }
  return Object.freeze(options.sort((left, right) => compareCodeUnit(left.actionId, right.actionId)));
}

export function deterministicConversationOutcome(
  closeReason: ConversationCloseReason,
  acceptedTerms: ConversationStructuredTerms | null,
  rationale: string,
  decisionId: string | null = null,
): ConversationOutcome {
  const agreement = closeReason === "agreement" && acceptedTerms !== null;
  return {
    kind: agreement ? "agreement" : "no_agreement",
    structuredTerms: agreement ? acceptedTerms : null,
    extractedBy: "rule",
    rationale,
    decisionId,
    llmCallId: null,
  };
}

export function resolveConversationOutcomeProposal(
  value: unknown,
  options: readonly DecisionOption[],
): Readonly<{
  option: DecisionOption;
  kind: ConversationOutcome["kind"];
  structuredTerms: ConversationStructuredTerms | null;
  rationale: string;
}> {
  const proposal: Tier2DecisionProposal = tier2DecisionProposalSchema.parse(value);
  const option = options.find((candidate) =>
    candidate.actionId === proposal.actionId &&
    canonicalStringify(candidate.params) === canonicalStringify(proposal.params)
  );
  if (option === undefined) {
    throw new EngineError("PERMISSION_DENIED", "conversation outcome was not in the offered menu");
  }
  const kind = option.params["kind"];
  if (kind !== "agreement" && kind !== "no_agreement" && kind !== "escalate") {
    throw new EngineError("SCHEMA_INVALID", "conversation outcome option has an invalid kind");
  }
  const rawTerms = option.params["structuredTerms"];
  const structuredTerms = rawTerms === null
    ? null
    : conversationStructuredTermsSchema.parse(rawTerms);
  return Object.freeze({ option, kind, structuredTerms, rationale: proposal.rationale });
}

export function conversationRelationshipStrength(
  relationship: Pick<Relationship, "type" | "strength">,
  outcomeKind: ConversationOutcome["kind"],
): number {
  const delta = outcomeKind === "agreement" ? 2 : outcomeKind === "escalate" ? -2 : -1;
  const candidate = relationship.strength + delta;
  return relationship.type === "adversary"
    ? Math.max(-100, Math.min(-1, candidate))
    : Math.max(0, Math.min(100, candidate));
}
