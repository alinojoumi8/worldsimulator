/**
 * Versioned envelopes and the engine error taxonomy (API_CONTRACTS §4,
 * IMPLEMENTATION_PLAN §4). These schemas are the single source of truth shared
 * by the engine (validation), the event store (append-time checks), the API
 * (DTOs), and — later — generated frontend types.
 */

import { z } from "zod";

export const ACTOR_KINDS = ["agent", "institution", "system", "admin"] as const;

export const actorRefSchema = z.object({
  kind: z.enum(ACTOR_KINDS),
  id: z.string().min(1),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

/** 360-day calendar date: Y0001-M01-D01 … (ADR-0005). */
export const SIM_DATE_PATTERN = /^Y\d{4}-M(0[1-9]|1[0-2])-D(0[1-9]|[12]\d|30)$/;

/** Event/intent type names: dot-separated lower_snake segments. */
export const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const eventEnvelopeSchema = z.object({
  eventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  type: z.string().regex(TYPE_NAME_PATTERN),
  schemaVersion: z.number().int().min(1),
  simulationId: z.string().min(1),
  runId: z.string().min(1),
  /** Per-run monotonic, gapless (enforced by the event log). */
  seq: z.number().int().min(0),
  tick: z.number().int().min(0),
  simDate: z.string().regex(SIM_DATE_PATTERN),
  /** Informational only — excluded from all hashes (ADR-0009). */
  wallTime: z.string().min(1),
  actor: actorRefSchema,
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type EventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  "payload"
> & { payload: TPayload };

export const intentEnvelopeSchema = z.object({
  intentId: z.string().regex(/^int_[0-9a-z]{8,}$/),
  type: z.string().regex(TYPE_NAME_PATTERN),
  actor: actorRefSchema,
  tick: z.number().int().min(0),
  params: z.unknown(),
  /** Present for Tier ≥1 decisions; Tier 0 routines may omit. */
  decisionId: z.string().min(1).optional(),
  correlationId: z.string().min(1),
});

export type IntentEnvelope<TParams = unknown> = Omit<
  z.infer<typeof intentEnvelopeSchema>,
  "params"
> & { params: TParams };

export const LLM_MODES = ["off", "mock", "live"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** Write-once reproducibility record for a run (ADR-0009). */
export const runManifestSchema = z.object({
  runId: z.string().min(1),
  simulationId: z.string().min(1),
  seed: z.number().int(),
  engineVersion: z.string().min(1),
  rulesetVersion: z.number().int().min(1),
  promptPackVersion: z.number().int().min(1),
  eventSchemaVersion: z.number().int().min(1),
  llmMode: z.enum(LLM_MODES),
  /** decision-tier → model id (ADR-0007). */
  modelRouting: z.record(z.string(), z.string()),
  scenarioDigest: z.string().min(1),
  worldSpecDigest: z.string().min(1),
  createdWall: z.string().min(1),
});
export type RunManifest = z.infer<typeof runManifestSchema>;

export const ENGINE_ERROR_CODES = [
  "VALIDATION_FAILED",
  "INSUFFICIENT_FUNDS",
  "PERMISSION_DENIED",
  "LIMIT_EXCEEDED",
  "NOT_FOUND",
  "CONFLICT",
  "BUDGET_EXHAUSTED",
  "SCHEMA_INVALID",
  "INTERNAL",
] as const;
export const engineErrorCodeSchema = z.enum(ENGINE_ERROR_CODES);
export type EngineErrorCode = z.infer<typeof engineErrorCodeSchema>;

/** Typed engine error — maps 1:1 onto RFC 9457 problem `code` at the API. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly details: unknown;

  constructor(code: EngineErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}
