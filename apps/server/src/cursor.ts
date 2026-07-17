/** Endpoint-bound opaque cursors for deterministic keyset pagination. */

import {
  agentIdSchema,
  canonicalParse,
  canonicalStringify,
  decisionIdSchema,
  EngineError,
  conversationIdSchema,
  llmCallIdSchema,
  newsStoryIdSchema,
  runIdSchema,
  simulationIdSchema,
} from "@worldtangle/shared";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 2_048;

export interface SimulationCursor {
  readonly createdWall: string;
  readonly simulationId: string;
}

export interface EventCursor {
  readonly runId: string;
  readonly seq: number;
}

export interface AgentCursor {
  readonly runId: string;
  readonly agentId: string;
}

export interface AgentDecisionCursor extends AgentCursor {
  readonly tick: number;
  readonly decisionId: string;
}

export interface RelationshipCursor extends AgentCursor {
  readonly strength: number;
  readonly toAgentId: string;
}

export interface TransactionCursor {
  readonly runId: string;
  readonly transactionId: string;
}

export type Phase4CursorView = "companies" | "contracts" | "jobs" | "loans";

export interface Phase4Cursor {
  readonly runId: string;
  readonly view: Phase4CursorView;
  readonly order: number;
  readonly id: string;
}

export interface LlmCallCursor {
  readonly runId: string;
  readonly tick: number;
  readonly callId: string;
}

export interface ErrorCursor {
  readonly runId: string;
  readonly seq: number;
}

export interface ConversationCursor {
  readonly runId: string;
  readonly startTick: number;
  readonly conversationId: string;
}

export interface NewsCursor {
  readonly runId: string;
  readonly tick: number;
  readonly storyId: string;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function encode(value: unknown): string {
  return Buffer.from(canonicalStringify(value), "utf8").toString("base64url");
}

function decode(cursor: string): unknown {
  if (
    cursor.length < 1 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !CURSOR_PATTERN.test(cursor)
  ) {
    throw new EngineError("VALIDATION_FAILED", "invalid pagination cursor");
  }
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical base64url");
    return canonicalParse(bytes.toString("utf8"));
  } catch {
    throw new EngineError("VALIDATION_FAILED", "invalid pagination cursor");
  }
}

export function encodeSimulationCursor(cursor: SimulationCursor): string {
  return encode({ kind: "simulations", ...cursor });
}

export function decodeSimulationCursor(cursor: string): SimulationCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["createdWall", "kind", "simulationId"]) ||
    parsed["kind"] !== "simulations" ||
    typeof parsed["createdWall"] !== "string" ||
    parsed["createdWall"].length < 1 ||
    !simulationIdSchema.safeParse(parsed["simulationId"]).success
  ) {
    throw new EngineError("VALIDATION_FAILED", "invalid simulation cursor");
  }
  const createdWall = parsed["createdWall"];
  const simulationId = parsed["simulationId"] as string;
  return { createdWall, simulationId };
}

export function encodeEventCursor(cursor: EventCursor): string {
  return encode({ kind: "events", ...cursor });
}

export function decodeEventCursor(cursor: string, expectedRunId: string): EventCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["kind", "runId", "seq"]) ||
    parsed["kind"] !== "events" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    typeof parsed["seq"] !== "number" ||
    !Number.isSafeInteger(parsed["seq"]) ||
    parsed["seq"] < 0
  ) {
    throw new EngineError("VALIDATION_FAILED", "event cursor does not belong to this run");
  }
  const runId = parsed["runId"] as string;
  const seq = parsed["seq"];
  return { runId, seq };
}

export function encodeTransactionCursor(cursor: TransactionCursor): string {
  return encode({ kind: "transactions", ...cursor });
}

export function decodeTransactionCursor(
  cursor: string,
  expectedRunId: string,
): TransactionCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["kind", "runId", "transactionId"]) ||
    parsed["kind"] !== "transactions" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    typeof parsed["transactionId"] !== "string" ||
    !/^txn_[0-9a-z]{8,}$/.test(parsed["transactionId"])
  ) {
    throw new EngineError("VALIDATION_FAILED", "transaction cursor does not belong to this run");
  }
  return {
    runId: parsed["runId"] as string,
    transactionId: parsed["transactionId"],
  };
}

export function encodePhase4Cursor(cursor: Phase4Cursor): string {
  return encode({ kind: "phase4-read", ...cursor });
}

export function decodePhase4Cursor(
  cursor: string,
  expectedRunId: string,
  expectedView: Phase4CursorView,
): Phase4Cursor {
  const parsed = decode(cursor);
  const idPattern = expectedView === "companies"
    ? /^co_[0-9a-z]{8,}$/
    : expectedView === "contracts"
      ? /^ctr_[0-9a-z]{8,}$/
      : expectedView === "jobs"
        ? /^job_[0-9a-z]{8,}$/
        : /^loan_[0-9a-z]{8,}$/;
  if (
    !isExactRecord(parsed, ["id", "kind", "order", "runId", "view"]) ||
    parsed["kind"] !== "phase4-read" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    parsed["view"] !== expectedView ||
    typeof parsed["order"] !== "number" ||
    !Number.isSafeInteger(parsed["order"]) ||
    parsed["order"] < 0 ||
    typeof parsed["id"] !== "string" ||
    !idPattern.test(parsed["id"])
  ) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${expectedView} cursor does not belong to this run`,
    );
  }
  return {
    runId: parsed["runId"] as string,
    view: expectedView,
    order: parsed["order"],
    id: parsed["id"],
  };
}

export function encodeAgentCursor(cursor: AgentCursor): string {
  return encode({ kind: "agents", ...cursor });
}

export function decodeAgentCursor(cursor: string, expectedRunId: string): AgentCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["agentId", "kind", "runId"]) ||
    parsed["kind"] !== "agents" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    !agentIdSchema.safeParse(parsed["agentId"]).success
  ) {
    throw new EngineError("VALIDATION_FAILED", "agent cursor does not belong to this run");
  }
  return {
    runId: parsed["runId"] as string,
    agentId: parsed["agentId"] as string,
  };
}

export function encodeAgentDecisionCursor(cursor: AgentDecisionCursor): string {
  return encode({ kind: "agent-decisions", ...cursor });
}

export function decodeAgentDecisionCursor(
  cursor: string,
  expectedRunId: string,
  expectedAgentId: string,
): AgentDecisionCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["agentId", "decisionId", "kind", "runId", "tick"]) ||
    parsed["kind"] !== "agent-decisions" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    !agentIdSchema.safeParse(parsed["agentId"]).success ||
    parsed["agentId"] !== expectedAgentId ||
    !decisionIdSchema.safeParse(parsed["decisionId"]).success ||
    typeof parsed["tick"] !== "number" ||
    !Number.isSafeInteger(parsed["tick"]) ||
    parsed["tick"] < 1
  ) {
    throw new EngineError("VALIDATION_FAILED", "decision cursor does not belong to this agent run");
  }
  return {
    runId: parsed["runId"] as string,
    agentId: parsed["agentId"] as string,
    decisionId: parsed["decisionId"] as string,
    tick: parsed["tick"],
  };
}

export function encodeRelationshipCursor(cursor: RelationshipCursor): string {
  return encode({ kind: "relationships", ...cursor });
}

export function decodeRelationshipCursor(
  cursor: string,
  expectedRunId: string,
  expectedAgentId: string,
): RelationshipCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["agentId", "kind", "runId", "strength", "toAgentId"]) ||
    parsed["kind"] !== "relationships" ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    parsed["runId"] !== expectedRunId ||
    !agentIdSchema.safeParse(parsed["agentId"]).success ||
    parsed["agentId"] !== expectedAgentId ||
    !agentIdSchema.safeParse(parsed["toAgentId"]).success ||
    typeof parsed["strength"] !== "number" ||
    !Number.isSafeInteger(parsed["strength"]) ||
    parsed["strength"] < -100 ||
    parsed["strength"] > 100
  ) {
    throw new EngineError("VALIDATION_FAILED", "relationship cursor does not belong to this agent run");
  }
  return {
    runId: parsed["runId"] as string,
    agentId: parsed["agentId"] as string,
    strength: parsed["strength"],
    toAgentId: parsed["toAgentId"] as string,
  };
}

export function encodeLlmCallCursor(cursor: LlmCallCursor): string {
  return encode({ kind: "llm-calls", ...cursor });
}

export function decodeLlmCallCursor(cursor: string, expectedRunId: string): LlmCallCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["callId", "kind", "runId", "tick"]) ||
    parsed["kind"] !== "llm-calls" ||
    parsed["runId"] !== expectedRunId ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    !llmCallIdSchema.safeParse(parsed["callId"]).success ||
    typeof parsed["tick"] !== "number" ||
    !Number.isSafeInteger(parsed["tick"]) ||
    parsed["tick"] < 0
  ) {
    throw new EngineError("VALIDATION_FAILED", "LLM call cursor does not belong to this run");
  }
  return {
    runId: parsed["runId"] as string,
    tick: parsed["tick"],
    callId: parsed["callId"] as string,
  };
}

export function encodeErrorCursor(cursor: ErrorCursor): string {
  return encode({ kind: "errors", ...cursor });
}

export function decodeErrorCursor(cursor: string, expectedRunId: string): ErrorCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["kind", "runId", "seq"]) ||
    parsed["kind"] !== "errors" ||
    parsed["runId"] !== expectedRunId ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    typeof parsed["seq"] !== "number" ||
    !Number.isSafeInteger(parsed["seq"]) ||
    parsed["seq"] < 0
  ) {
    throw new EngineError("VALIDATION_FAILED", "error cursor does not belong to this run");
  }
  return { runId: parsed["runId"] as string, seq: parsed["seq"] };
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  return encode({ kind: "conversations", ...cursor });
}

export function decodeConversationCursor(
  cursor: string,
  expectedRunId: string,
): ConversationCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["conversationId", "kind", "runId", "startTick"]) ||
    parsed["kind"] !== "conversations" ||
    parsed["runId"] !== expectedRunId ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    !conversationIdSchema.safeParse(parsed["conversationId"]).success ||
    typeof parsed["startTick"] !== "number" ||
    !Number.isSafeInteger(parsed["startTick"]) ||
    parsed["startTick"] < 0
  ) {
    throw new EngineError("VALIDATION_FAILED", "conversation cursor does not belong to this run");
  }
  return {
    runId: parsed["runId"] as string,
    startTick: parsed["startTick"],
    conversationId: parsed["conversationId"] as string,
  };
}

export function encodeNewsCursor(cursor: NewsCursor): string {
  return encode({ kind: "news", ...cursor });
}

export function decodeNewsCursor(cursor: string, expectedRunId: string): NewsCursor {
  const parsed = decode(cursor);
  if (
    !isExactRecord(parsed, ["kind", "runId", "storyId", "tick"]) ||
    parsed["kind"] !== "news" ||
    parsed["runId"] !== expectedRunId ||
    !runIdSchema.safeParse(parsed["runId"]).success ||
    !newsStoryIdSchema.safeParse(parsed["storyId"]).success ||
    typeof parsed["tick"] !== "number" ||
    !Number.isSafeInteger(parsed["tick"]) ||
    parsed["tick"] < 1
  ) {
    throw new EngineError("VALIDATION_FAILED", "news cursor does not belong to this run");
  }
  return {
    runId: parsed["runId"] as string,
    tick: parsed["tick"],
    storyId: parsed["storyId"] as string,
  };
}
