/** Authoritative persistence for WS-606 bounded two-party conversations. */

import {
  canonicalParse,
  canonicalStringify,
  CONVERSATION_TOPIC_COOLDOWN_TICKS,
  conversationInboxItemSchema,
  conversationMessageSchema,
  conversationOutcomeSchema,
  conversationSchema,
  EngineError,
  openConversationInputSchema,
  relationshipSchema,
  type Conversation,
  type ConversationCloseReason,
  type ConversationInboxItem,
  type ConversationMessage,
  type ConversationOutcome,
  type ConversationStructuredTerms,
  type OpenConversationInput,
  type Relationship,
} from "@worldtangle/shared";
import {
  conversationRelationshipStrength,
  nextConversationSpeaker,
  termsWithinConversationBounds,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { toSafeNumber, type WorldDatabase } from "./database";

interface ConversationRow {
  run_id: string;
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  topic: string;
  initiating_trigger_event_id: string;
  term_bounds_canonical: string;
  max_turns: bigint;
  output_token_budget: bigint;
  output_tokens_used: bigint;
  turns: bigint;
  status: string;
  outcome_canonical: string | null;
  close_reason: string | null;
  start_tick: bigint;
  end_tick: bigint | null;
  revision: bigint;
  source_event_id: string;
  terminal_event_id: string | null;
}

interface ConversationMessageRow {
  run_id: string;
  id: string;
  conversation_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  turn: bigint;
  action_id: string;
  kind: string;
  content: string;
  structured_terms_canonical: string | null;
  tick: bigint;
  delivery_tick: bigint;
  decision_id: string;
  llm_call_id: string | null;
  output_tokens: bigint;
  source_event_id: string;
}

interface ConversationInboxRow {
  run_id: string;
  conversation_id: string;
  message_id: string;
  recipient_agent_id: string;
  delivery_tick: bigint;
  delivered_tick: bigint | null;
  read_tick: bigint | null;
  revision: bigint;
  source_event_id: string;
}

interface RelationshipRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: Relationship["type"];
  strength: bigint;
  last_interaction_tick: bigint;
}

interface RelationshipHistoryRow {
  id: string;
  conversation_id: string;
  relationship_id: string;
  from_agent_id: string;
  to_agent_id: string;
  prior_strength: bigint;
  next_strength: bigint;
  prior_interaction_tick: bigint;
  next_interaction_tick: bigint;
  source_event_id: string;
}

interface DecisionEvidenceRow {
  agent_id: string;
  tick: bigint;
}

interface CallEvidenceRow {
  decision_id: string;
  agent_id: string;
  tick: bigint;
  source_event_id: string;
}

export interface AppendConversationMessageInput {
  readonly conversationId: string;
  readonly senderAgentId: string;
  readonly actionId: string;
  readonly kind: ConversationMessage["kind"];
  readonly content: string;
  readonly structuredTerms: ConversationStructuredTerms | null;
  readonly decisionId: string;
  readonly llmCallId: string | null;
  readonly outputTokens: number;
}

export interface CloseConversationInput {
  readonly conversationId: string;
  readonly closeReason: ConversationCloseReason;
  readonly outcome: ConversationOutcome;
  readonly outcomeOutputTokens?: number;
}

export interface ConversationRelationshipHistory {
  readonly id: string;
  readonly conversationId: string;
  readonly relationshipId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly priorStrength: number;
  readonly nextStrength: number;
  readonly priorInteractionTick: number;
  readonly nextInteractionTick: number;
  readonly sourceEventId: string;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCanonical(text: string, label: string): unknown {
  try {
    const value = canonicalParse(text);
    if (canonicalStringify(value) !== text) throw new Error("value is not canonical");
    return value;
  } catch (error) {
    throw new EngineError("INTERNAL", `${label} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function terminalStatus(
  reason: ConversationCloseReason,
): Conversation["status"] {
  if (reason === "agreement" || reason === "declined") return "concluded";
  if (reason === "provider_fallback" || reason === "invalid_proposal") {
    return "force_closed";
  }
  return "expired";
}

function mapConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    runId: row.run_id,
    participantAgentIds: [row.participant_a_id, row.participant_b_id],
    topic: row.topic,
    initiatingTriggerEventId: row.initiating_trigger_event_id,
    termBounds: parseCanonical(
      row.term_bounds_canonical,
      `conversation ${row.id} term bounds`,
    ),
    maxTurns: toSafeNumber(row.max_turns, "conversation max turns"),
    outputTokenBudget: toSafeNumber(
      row.output_token_budget,
      "conversation output-token budget",
    ),
    outputTokensUsed: toSafeNumber(
      row.output_tokens_used,
      "conversation output tokens used",
    ),
    turns: toSafeNumber(row.turns, "conversation turns"),
    status: row.status,
    outcome: row.outcome_canonical === null
      ? null
      : parseCanonical(row.outcome_canonical, `conversation ${row.id} outcome`),
    closeReason: row.close_reason,
    startTick: toSafeNumber(row.start_tick, "conversation start tick"),
    endTick: row.end_tick === null
      ? null
      : toSafeNumber(row.end_tick, "conversation end tick"),
    sourceEventId: row.source_event_id,
  });
}

function mapMessage(row: ConversationMessageRow): ConversationMessage {
  return conversationMessageSchema.parse({
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    turn: toSafeNumber(row.turn, "conversation message turn"),
    actionId: row.action_id,
    kind: row.kind,
    content: row.content,
    structuredTerms: row.structured_terms_canonical === null
      ? null
      : parseCanonical(
          row.structured_terms_canonical,
          `conversation message ${row.id} terms`,
        ),
    tick: toSafeNumber(row.tick, "conversation message tick"),
    deliveryTick: toSafeNumber(row.delivery_tick, "conversation message delivery tick"),
    decisionId: row.decision_id,
    llmCallId: row.llm_call_id,
    outputTokens: toSafeNumber(row.output_tokens, "conversation message output tokens"),
    sourceEventId: row.source_event_id,
  });
}

function mapInbox(row: ConversationInboxRow): ConversationInboxItem {
  return conversationInboxItemSchema.parse({
    runId: row.run_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    recipientAgentId: row.recipient_agent_id,
    deliveryTick: toSafeNumber(row.delivery_tick, "conversation inbox delivery tick"),
    deliveredTick: row.delivered_tick === null
      ? null
      : toSafeNumber(row.delivered_tick, "conversation inbox delivered tick"),
    readTick: row.read_tick === null
      ? null
      : toSafeNumber(row.read_tick, "conversation inbox read tick"),
    sourceEventId: row.source_event_id,
  });
}

export class SqliteConversationStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  open(inputValue: OpenConversationInput, ctx: TickContext): Conversation {
    const input = openConversationInputSchema.parse(inputValue);
    const participantAId = input.participantAgentIds[0]!;
    const participantBId = input.participantAgentIds[1]!;
    if (ctx.runId !== this.runId || input.startTick !== ctx.tick) {
      throw new EngineError("CONFLICT", "conversation start does not match the active run tick");
    }
    const participantCount = this.db.prepare<
      [string, string, string],
      { count: bigint }
    >(`
      SELECT COUNT(*) AS count FROM agents
      WHERE run_id = ? AND id IN (?, ?)
    `).get(this.runId, participantAId, participantBId)?.count ?? 0n;
    if (participantCount !== 2n) {
      throw new EngineError("NOT_FOUND", "conversation participant does not exist");
    }

    const capacityConflict = this.db.prepare<
      [string, number, string, string, string, string],
      { id: string }
    >(`
      SELECT id FROM conversations
      WHERE run_id = ? AND start_tick = ?
        AND (
          participant_a_id IN (?, ?) OR participant_b_id IN (?, ?)
        )
      ORDER BY id LIMIT 1
    `).get(
      this.runId,
      input.startTick,
      participantAId,
      participantBId,
      participantAId,
      participantBId,
    );
    if (capacityConflict !== undefined) {
      throw new EngineError(
        "LIMIT_EXCEEDED",
        "an agent may open at most one conversation per tick",
      );
    }

    const repeatConflict = this.db.prepare<
      Record<string, string | number>,
      { id: string; status: string; end_tick: bigint | null }
    >(`
      SELECT id, status, end_tick FROM conversations
      WHERE run_id = @runId AND topic = @topic
        AND (
          (participant_a_id = @first AND participant_b_id = @second) OR
          (participant_a_id = @second AND participant_b_id = @first)
        )
        AND (
          status = 'active' OR
          (end_tick IS NOT NULL AND end_tick > @cooldownBoundary)
        )
      ORDER BY start_tick DESC, id DESC
      LIMIT 1
    `).get({
      runId: this.runId,
      topic: input.topic,
      first: participantAId,
      second: participantBId,
      cooldownBoundary: input.startTick - CONVERSATION_TOPIC_COOLDOWN_TICKS,
    });
    if (repeatConflict !== undefined) {
      throw new EngineError(
        repeatConflict.status === "active" ? "CONFLICT" : "LIMIT_EXCEEDED",
        repeatConflict.status === "active"
          ? "the same participants already have an active conversation on this topic"
          : "conversation topic is still in cooldown for these participants",
      );
    }

    const conversationId = ctx.ids.next("cnv");
    const started = ctx.emit("conversation.started", {
      schemaVersion: 1,
      conversationId,
      topic: input.topic,
      participantAgentIds: input.participantAgentIds,
      termBounds: input.termBounds,
      maxTurns: input.maxTurns,
      outputTokenBudget: input.outputTokenBudget,
      startTick: input.startTick,
      evidenceEventIds: [input.initiatingTriggerEventId],
    }, {
      actor: { kind: "agent", id: participantAId },
      schemaVersion: 1,
      correlationId: conversationId,
      causationId: input.initiatingTriggerEventId,
    });
    this.db.prepare(`
      INSERT INTO conversations(
        run_id, id, participant_a_id, participant_b_id, topic,
        initiating_trigger_event_id, term_bounds_canonical, max_turns,
        output_token_budget, output_tokens_used, turns, status,
        outcome_canonical, close_reason, start_tick, end_tick, revision,
        source_event_id, terminal_event_id
      ) VALUES (
        @runId, @id, @participantAId, @participantBId, @topic,
        @initiatingTriggerEventId, @termBounds, @maxTurns,
        @outputTokenBudget, 0, 0, 'active',
        NULL, NULL, @startTick, NULL, 0,
        @sourceEventId, NULL
      )
    `).run({
      runId: this.runId,
      id: conversationId,
      participantAId,
      participantBId,
      topic: input.topic,
      initiatingTriggerEventId: input.initiatingTriggerEventId,
      termBounds: canonicalStringify(input.termBounds),
      maxTurns: input.maxTurns,
      outputTokenBudget: input.outputTokenBudget,
      startTick: input.startTick,
      sourceEventId: started.eventId,
    });
    return this.get(conversationId);
  }

  get(conversationId: string): Conversation {
    return mapConversation(this.requiredRow(conversationId));
  }

  list(): readonly Conversation[] {
    return Object.freeze(this.db.prepare<[string], ConversationRow>(`
      SELECT * FROM conversations WHERE run_id = ? ORDER BY start_tick, id
    `).all(this.runId).map(mapConversation));
  }

  listDueForTurn(tick: number): readonly Conversation[] {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "conversation tick is invalid");
    }
    return Object.freeze(this.db.prepare<[string, number, number], ConversationRow>(`
      SELECT c.* FROM conversations c
      WHERE c.run_id = ? AND c.status = 'active' AND c.start_tick <= ?
        AND (
          c.turns = 0 OR EXISTS (
            SELECT 1 FROM conversation_messages m
            WHERE m.run_id = c.run_id AND m.conversation_id = c.id
              AND m.turn = c.turns AND m.delivery_tick <= ?
          )
        )
      ORDER BY c.id
    `).all(this.runId, tick, tick).map(mapConversation));
  }

  listMessages(conversationId: string): readonly ConversationMessage[] {
    this.requiredRow(conversationId);
    return Object.freeze(this.db.prepare<
      [string, string],
      ConversationMessageRow
    >(`
      SELECT * FROM conversation_messages
      WHERE run_id = ? AND conversation_id = ?
      ORDER BY turn, id
    `).all(this.runId, conversationId).map(mapMessage));
  }

  listInbox(agentId: string): readonly ConversationInboxItem[] {
    return Object.freeze(this.db.prepare<[string, string], ConversationInboxRow>(`
      SELECT * FROM conversation_inbox
      WHERE run_id = ? AND recipient_agent_id = ?
      ORDER BY delivery_tick, message_id
    `).all(this.runId, agentId).map(mapInbox));
  }

  deliverDue(tick: number, ctx: TickContext): readonly ConversationInboxItem[] {
    if (ctx.runId !== this.runId || ctx.tick !== tick) {
      throw new EngineError("CONFLICT", "inbox delivery does not match the active run tick");
    }
    const rows = this.db.prepare<[string, number], ConversationInboxRow>(`
      SELECT * FROM conversation_inbox
      WHERE run_id = ? AND delivered_tick IS NULL AND delivery_tick <= ?
      ORDER BY delivery_tick, message_id, recipient_agent_id
    `).all(this.runId, tick);
    const delivered: ConversationInboxItem[] = [];
    for (const row of rows) {
      const event = ctx.emit("conversation.message.delivered", {
        schemaVersion: 1,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        recipientAgentId: row.recipient_agent_id,
        scheduledDeliveryTick: toSafeNumber(row.delivery_tick, "inbox delivery tick"),
        deliveredTick: tick,
        evidenceEventIds: [row.source_event_id],
      }, {
        actor: { kind: "system", id: "conversation-engine" },
        schemaVersion: 1,
        correlationId: row.conversation_id,
        causationId: row.source_event_id,
      });
      const updated = this.db.prepare(`
        UPDATE conversation_inbox
        SET delivered_tick = @tick, revision = revision + 1
        WHERE run_id = @runId AND message_id = @messageId
          AND recipient_agent_id = @recipientAgentId
          AND delivered_tick IS NULL AND revision = @revision
      `).run({
        runId: this.runId,
        messageId: row.message_id,
        recipientAgentId: row.recipient_agent_id,
        tick,
        revision: row.revision,
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale inbox delivery for ${row.message_id}`);
      }
      delivered.push(conversationInboxItemSchema.parse({
        ...mapInbox(row),
        deliveredTick: tick,
        sourceEventId: row.source_event_id,
      }));
      void event;
    }
    return Object.freeze(delivered);
  }

  markReadForResponse(
    conversationId: string,
    recipientAgentId: string,
    ctx: TickContext,
  ): number {
    if (ctx.runId !== this.runId) {
      throw new EngineError("CONFLICT", "inbox read belongs to another run");
    }
    const rows = this.db.prepare<[string, string, string, number], ConversationInboxRow>(`
      SELECT * FROM conversation_inbox
      WHERE run_id = ? AND conversation_id = ? AND recipient_agent_id = ?
        AND delivered_tick IS NOT NULL AND delivered_tick <= ? AND read_tick IS NULL
      ORDER BY delivery_tick, message_id
    `).all(this.runId, conversationId, recipientAgentId, ctx.tick);
    for (const row of rows) {
      const read = ctx.emit("conversation.message.read", {
        schemaVersion: 1,
        conversationId,
        messageId: row.message_id,
        recipientAgentId,
        readTick: ctx.tick,
        evidenceEventIds: [row.source_event_id],
      }, {
        actor: { kind: "agent", id: recipientAgentId },
        schemaVersion: 1,
        correlationId: conversationId,
        causationId: row.source_event_id,
      });
      const updated = this.db.prepare(`
        UPDATE conversation_inbox
        SET read_tick = @tick, revision = revision + 1
        WHERE run_id = @runId AND message_id = @messageId
          AND recipient_agent_id = @recipientAgentId
          AND delivered_tick IS NOT NULL AND read_tick IS NULL
          AND revision = @revision
      `).run({
        runId: this.runId,
        messageId: row.message_id,
        recipientAgentId,
        tick: ctx.tick,
        revision: row.revision,
      });
      if (updated.changes !== 1) {
        throw new EngineError("CONFLICT", `stale inbox read for ${row.message_id}`);
      }
      void read;
    }
    return rows.length;
  }

  appendMessage(
    input: AppendConversationMessageInput,
    ctx: TickContext,
  ): ConversationMessage {
    if (ctx.runId !== this.runId) {
      throw new EngineError("CONFLICT", "conversation message belongs to another run");
    }
    const row = this.requiredRow(input.conversationId);
    const conversation = mapConversation(row);
    if (conversation.status !== "active") {
      throw new EngineError("CONFLICT", "cannot append a message to a closed conversation");
    }
    const messages = this.listMessages(conversation.id);
    const expectedSender = nextConversationSpeaker(conversation, messages);
    if (input.senderAgentId !== expectedSender) {
      throw new EngineError("PERMISSION_DENIED", "agent is not the next conversation speaker");
    }
    const recipientAgentId = conversation.participantAgentIds.find(
      (agentId) => agentId !== input.senderAgentId,
    );
    if (recipientAgentId === undefined) {
      throw new EngineError("INTERNAL", "conversation recipient is missing");
    }
    if (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0) {
      throw new EngineError("VALIDATION_FAILED", "message output-token usage is invalid");
    }
    if (
      conversation.turns >= conversation.maxTurns ||
      conversation.outputTokensUsed + input.outputTokens > conversation.outputTokenBudget
    ) {
      throw new EngineError("LIMIT_EXCEEDED", "conversation message exceeds a hard limit");
    }
    if (
      input.structuredTerms !== null &&
      !termsWithinConversationBounds(conversation.termBounds, input.structuredTerms)
    ) {
      throw new EngineError("PERMISSION_DENIED", "message terms exceed conversation bounds");
    }
    this.assertDecisionEvidence(
      input.decisionId,
      input.llmCallId,
      input.senderAgentId,
      ctx.tick,
    );
    this.markReadForResponse(conversation.id, input.senderAgentId, ctx);

    const messageId = ctx.ids.next("msg");
    const turn = conversation.turns + 1;
    const created = ctx.emit("conversation.message.created", {
      schemaVersion: 1,
      conversationId: conversation.id,
      messageId,
      senderAgentId: input.senderAgentId,
      recipientAgentId,
      turn,
      actionId: input.actionId,
      kind: input.kind,
      content: input.content,
      structuredTerms: input.structuredTerms,
      decisionId: input.decisionId,
      llmCallId: input.llmCallId,
      outputTokens: input.outputTokens,
      deliveryTick: ctx.tick + 1,
      evidenceEventIds: [
        conversation.sourceEventId,
        ...messages.map((message) => message.sourceEventId),
      ].sort(compareCodeUnit),
    }, {
      actor: { kind: "agent", id: input.senderAgentId },
      schemaVersion: 1,
      correlationId: conversation.id,
      causationId: messages.at(-1)?.sourceEventId ?? conversation.sourceEventId,
    });
    const message = conversationMessageSchema.parse({
      id: messageId,
      runId: this.runId,
      conversationId: conversation.id,
      senderAgentId: input.senderAgentId,
      recipientAgentId,
      turn,
      actionId: input.actionId,
      kind: input.kind,
      content: input.content,
      structuredTerms: input.structuredTerms,
      tick: ctx.tick,
      deliveryTick: ctx.tick + 1,
      decisionId: input.decisionId,
      llmCallId: input.llmCallId,
      outputTokens: input.outputTokens,
      sourceEventId: created.eventId,
    });
    this.db.prepare(`
      INSERT INTO conversation_messages(
        run_id, id, conversation_id, sender_agent_id, recipient_agent_id,
        turn, action_id, kind, content, structured_terms_canonical,
        tick, delivery_tick, decision_id, llm_call_id, output_tokens, source_event_id
      ) VALUES (
        @runId, @id, @conversationId, @senderAgentId, @recipientAgentId,
        @turn, @actionId, @kind, @content, @structuredTerms,
        @tick, @deliveryTick, @decisionId, @llmCallId, @outputTokens, @sourceEventId
      )
    `).run({
      runId: this.runId,
      id: message.id,
      conversationId: message.conversationId,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      turn: message.turn,
      actionId: message.actionId,
      kind: message.kind,
      content: message.content,
      structuredTerms: message.structuredTerms === null
        ? null
        : canonicalStringify(message.structuredTerms),
      tick: message.tick,
      deliveryTick: message.deliveryTick,
      decisionId: message.decisionId,
      llmCallId: message.llmCallId,
      outputTokens: message.outputTokens,
      sourceEventId: message.sourceEventId,
    });
    this.db.prepare(`
      INSERT INTO conversation_inbox(
        run_id, conversation_id, message_id, recipient_agent_id,
        delivery_tick, delivered_tick, read_tick, revision, source_event_id
      ) VALUES (
        @runId, @conversationId, @messageId, @recipientAgentId,
        @deliveryTick, NULL, NULL, 0, @sourceEventId
      )
    `).run({
      runId: this.runId,
      conversationId: message.conversationId,
      messageId: message.id,
      recipientAgentId: message.recipientAgentId,
      deliveryTick: message.deliveryTick,
      sourceEventId: message.sourceEventId,
    });
    const updated = this.db.prepare(`
      UPDATE conversations
      SET turns = turns + 1,
          output_tokens_used = output_tokens_used + @outputTokens,
          revision = revision + 1
      WHERE run_id = @runId AND id = @id AND status = 'active'
        AND revision = @revision AND turns = @turns
        AND output_tokens_used = @outputTokensUsed
    `).run({
      runId: this.runId,
      id: conversation.id,
      outputTokens: input.outputTokens,
      revision: row.revision,
      turns: row.turns,
      outputTokensUsed: row.output_tokens_used,
    });
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", `stale conversation append for ${conversation.id}`);
    }
    return message;
  }

  close(input: CloseConversationInput, ctx: TickContext): Conversation {
    if (ctx.runId !== this.runId) {
      throw new EngineError("CONFLICT", "conversation close belongs to another run");
    }
    const row = this.requiredRow(input.conversationId);
    const conversation = mapConversation(row);
    if (conversation.status !== "active") {
      throw new EngineError("CONFLICT", "conversation is already closed");
    }
    const outcome = conversationOutcomeSchema.parse(input.outcome);
    const outcomeOutputTokens = input.outcomeOutputTokens ?? 0;
    if (!Number.isSafeInteger(outcomeOutputTokens) || outcomeOutputTokens < 0) {
      throw new EngineError("VALIDATION_FAILED", "outcome output-token usage is invalid");
    }
    if (conversation.outputTokensUsed + outcomeOutputTokens > conversation.outputTokenBudget) {
      throw new EngineError("LIMIT_EXCEEDED", "conversation outcome exceeds its token budget");
    }
    if (
      (input.closeReason === "agreement") !== (outcome.kind === "agreement") ||
      (outcome.kind === "escalate" &&
        input.closeReason !== "max_turns" && input.closeReason !== "no_progress")
    ) {
      throw new EngineError("VALIDATION_FAILED", "conversation reason and outcome disagree");
    }
    if (
      outcome.structuredTerms !== null &&
      !termsWithinConversationBounds(conversation.termBounds, outcome.structuredTerms)
    ) {
      throw new EngineError("PERMISSION_DENIED", "outcome terms exceed conversation bounds");
    }
    this.assertOutcomeEvidence(outcome, ctx.tick);
    const messages = this.listMessages(conversation.id);
    const evidenceEventIds = [
      conversation.initiatingTriggerEventId,
      conversation.sourceEventId,
      ...messages.map((message) => message.sourceEventId),
    ].sort(compareCodeUnit);
    const ended = ctx.emit("conversation.ended", {
      schemaVersion: 1,
      conversationId: conversation.id,
      topic: conversation.topic,
      participantAgentIds: conversation.participantAgentIds,
      status: terminalStatus(input.closeReason),
      closeReason: input.closeReason,
      outcome,
      turns: conversation.turns,
      outputTokensUsed: conversation.outputTokensUsed + outcomeOutputTokens,
      endTick: ctx.tick,
      evidenceEventIds,
    }, {
      actor: { kind: "system", id: "conversation-engine" },
      schemaVersion: 1,
      correlationId: conversation.id,
      causationId: messages.at(-1)?.sourceEventId ?? conversation.sourceEventId,
    });
    const updated = this.db.prepare(`
      UPDATE conversations
      SET status = @status,
          outcome_canonical = @outcome,
          close_reason = @closeReason,
          end_tick = @endTick,
          terminal_event_id = @terminalEventId,
          output_tokens_used = output_tokens_used + @outcomeOutputTokens,
          revision = revision + 1
      WHERE run_id = @runId AND id = @id AND status = 'active'
        AND revision = @revision
    `).run({
      runId: this.runId,
      id: conversation.id,
      status: terminalStatus(input.closeReason),
      outcome: canonicalStringify(outcome),
      closeReason: input.closeReason,
      endTick: ctx.tick,
      terminalEventId: ended.eventId,
      outcomeOutputTokens,
      revision: row.revision,
    });
    if (updated.changes !== 1) {
      throw new EngineError("CONFLICT", `stale conversation close for ${conversation.id}`);
    }

    this.updateRelationships(conversation, outcome, ended.eventId, ctx);
    const agentStore = new SqliteAgentStore(this.db, this.runId);
    for (const agentId of conversation.participantAgentIds) {
      const memoryId = ctx.ids.next("mem");
      const memoryEvent = ctx.emit("agent.memory.recorded", {
        schemaVersion: 1,
        memoryId,
        agentId,
        kind: "conversation",
        conversationId: conversation.id,
        outcomeKind: outcome.kind,
        evidenceEventIds: [...evidenceEventIds, ended.eventId].sort(compareCodeUnit),
      }, {
        actor: { kind: "agent", id: agentId },
        schemaVersion: 1,
        correlationId: conversation.id,
        causationId: ended.eventId,
      });
      agentStore.append({
        id: memoryId,
        runId: this.runId,
        agentId,
        tick: ctx.tick,
        kind: "conversation",
        content: (
          `Conversation ${conversation.id} about ${conversation.topic} ` +
          `ended with ${outcome.kind} at tick ${ctx.tick}.`
        ),
        importance: outcome.kind === "agreement" ? 70 : 50,
        references: [...new Set([
          ...evidenceEventIds,
          ended.eventId,
          memoryEvent.eventId,
        ])].sort(compareCodeUnit),
      });
    }
    return this.get(conversation.id);
  }

  listRelationshipHistory(
    conversationId: string,
  ): readonly ConversationRelationshipHistory[] {
    return Object.freeze(this.db.prepare<
      [string, string],
      RelationshipHistoryRow
    >(`
      SELECT * FROM conversation_relationship_history
      WHERE run_id = ? AND conversation_id = ? ORDER BY id
    `).all(this.runId, conversationId).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      relationshipId: row.relationship_id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      priorStrength: toSafeNumber(row.prior_strength, "prior relationship strength"),
      nextStrength: toSafeNumber(row.next_strength, "next relationship strength"),
      priorInteractionTick: toSafeNumber(
        row.prior_interaction_tick,
        "prior relationship interaction tick",
      ),
      nextInteractionTick: toSafeNumber(
        row.next_interaction_tick,
        "next relationship interaction tick",
      ),
      sourceEventId: row.source_event_id,
    })));
  }

  private requiredRow(conversationId: string): ConversationRow {
    const row = this.db.prepare<[string, string], ConversationRow>(`
      SELECT * FROM conversations WHERE run_id = ? AND id = ?
    `).get(this.runId, conversationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `conversation ${conversationId} does not exist`);
    }
    return row;
  }

  private assertDecisionEvidence(
    decisionId: string,
    llmCallId: string | null,
    agentId: string,
    tick: number,
  ): void {
    const decision = this.db.prepare<[string, string], DecisionEvidenceRow>(`
      SELECT agent_id, tick FROM decisions WHERE run_id = ? AND id = ?
    `).get(this.runId, decisionId);
    if (
      decision === undefined ||
      decision.agent_id !== agentId ||
      toSafeNumber(decision.tick, "conversation decision tick") !== tick
    ) {
      throw new EngineError("CONFLICT", "message decision evidence is missing or mismatched");
    }
    if (llmCallId === null) return;
    const call = this.db.prepare<[string, string], CallEvidenceRow>(`
      SELECT decision_id, agent_id, tick, source_event_id
      FROM llm_call_records WHERE run_id = ? AND id = ?
    `).get(this.runId, llmCallId);
    if (
      call === undefined ||
      call.decision_id !== decisionId ||
      call.agent_id !== agentId ||
      toSafeNumber(call.tick, "conversation call tick") !== tick
    ) {
      throw new EngineError("CONFLICT", "message LLM-call evidence is missing or mismatched");
    }
  }

  private assertOutcomeEvidence(outcome: ConversationOutcome, tick: number): void {
    if (outcome.decisionId === null) return;
    const decision = this.db.prepare<[string, string], DecisionEvidenceRow>(`
      SELECT agent_id, tick FROM decisions WHERE run_id = ? AND id = ?
    `).get(this.runId, outcome.decisionId);
    if (decision === undefined || toSafeNumber(decision.tick, "outcome decision tick") !== tick) {
      throw new EngineError("CONFLICT", "outcome decision evidence is missing or mismatched");
    }
    if (outcome.llmCallId === null) return;
    const call = this.db.prepare<[string, string], CallEvidenceRow>(`
      SELECT decision_id, agent_id, tick, source_event_id
      FROM llm_call_records WHERE run_id = ? AND id = ?
    `).get(this.runId, outcome.llmCallId);
    if (
      call === undefined ||
      call.decision_id !== outcome.decisionId ||
      call.agent_id !== decision.agent_id ||
      toSafeNumber(call.tick, "outcome call tick") !== tick
    ) {
      throw new EngineError("CONFLICT", "outcome LLM-call evidence is missing or mismatched");
    }
  }

  private updateRelationships(
    conversation: Conversation,
    outcome: ConversationOutcome,
    terminalEventId: string,
    ctx: TickContext,
  ): void {
    const directions = [
      [conversation.participantAgentIds[0]!, conversation.participantAgentIds[1]!],
      [conversation.participantAgentIds[1]!, conversation.participantAgentIds[0]!],
    ] as const;
    for (const [fromAgentId, toAgentId] of directions) {
      const existing = this.db.prepare<
        [string, string, string],
        RelationshipRow
      >(`
        SELECT id, from_agent_id, to_agent_id, type, strength, last_interaction_tick
        FROM relationships
        WHERE run_id = ? AND from_agent_id = ? AND to_agent_id = ?
        ORDER BY id LIMIT 1
      `).get(this.runId, fromAgentId, toAgentId);
      const relationshipId = existing?.id ?? ctx.ids.next("rel");
      const priorStrength = existing === undefined
        ? 0
        : toSafeNumber(existing.strength, "relationship strength");
      const priorInteractionTick = existing === undefined
        ? conversation.startTick
        : toSafeNumber(existing.last_interaction_tick, "relationship interaction tick");
      if (priorInteractionTick > ctx.tick) {
        throw new EngineError("CONFLICT", "relationship interaction tick is ahead of conversation");
      }
      const type = existing?.type ?? "business";
      const nextStrength = conversationRelationshipStrength(
        { type, strength: priorStrength },
        outcome.kind,
      );
      const relationship = relationshipSchema.parse({
        id: relationshipId,
        runId: this.runId,
        fromAgentId,
        toAgentId,
        type,
        strength: nextStrength,
        lastInteractionTick: ctx.tick,
      });
      const updatedEvent = ctx.emit("agent.relationship.updated", {
        schemaVersion: 1,
        relationshipId,
        conversationId: conversation.id,
        fromAgentId,
        toAgentId,
        type,
        priorStrength,
        nextStrength,
        priorInteractionTick,
        nextInteractionTick: ctx.tick,
        created: existing === undefined,
        outcomeKind: outcome.kind,
        evidenceEventIds: [terminalEventId],
      }, {
        actor: { kind: "system", id: "conversation-engine" },
        schemaVersion: 1,
        correlationId: conversation.id,
        causationId: terminalEventId,
      });
      if (existing === undefined) {
        this.db.prepare(`
          INSERT INTO relationships(
            run_id, id, from_agent_id, to_agent_id, type, strength, last_interaction_tick
          ) VALUES (
            @runId, @id, @fromAgentId, @toAgentId, @type, @strength, @lastInteractionTick
          )
        `).run({
          runId: relationship.runId,
          id: relationship.id,
          fromAgentId: relationship.fromAgentId,
          toAgentId: relationship.toAgentId,
          type: relationship.type,
          strength: relationship.strength,
          lastInteractionTick: relationship.lastInteractionTick,
        });
      } else {
        const updated = this.db.prepare(`
          UPDATE relationships
          SET strength = @nextStrength, last_interaction_tick = @tick
          WHERE run_id = @runId AND id = @id
            AND strength = @priorStrength
            AND last_interaction_tick = @priorInteractionTick
        `).run({
          runId: this.runId,
          id: relationshipId,
          nextStrength,
          tick: ctx.tick,
          priorStrength,
          priorInteractionTick,
        });
        if (updated.changes !== 1) {
          throw new EngineError("CONFLICT", `stale relationship update for ${relationshipId}`);
        }
      }
      this.db.prepare(`
        INSERT INTO conversation_relationship_history(
          run_id, id, conversation_id, relationship_id,
          from_agent_id, to_agent_id, prior_strength, next_strength,
          prior_interaction_tick, next_interaction_tick, source_event_id
        ) VALUES (
          @runId, @id, @conversationId, @relationshipId,
          @fromAgentId, @toAgentId, @priorStrength, @nextStrength,
          @priorInteractionTick, @nextInteractionTick, @sourceEventId
        )
      `).run({
        runId: this.runId,
        id: ctx.ids.next("rch"),
        conversationId: conversation.id,
        relationshipId,
        fromAgentId,
        toAgentId,
        priorStrength,
        nextStrength,
        priorInteractionTick,
        nextInteractionTick: ctx.tick,
        sourceEventId: updatedEvent.eventId,
      });
    }
  }
}
