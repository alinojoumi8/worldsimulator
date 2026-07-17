/** Typed action catalog, validation boundary, capability hook, and executor choke point. */

import {
  EngineError,
  TYPE_NAME_PATTERN,
  engineErrorCodeSchema,
  intentEnvelopeSchema,
} from "@worldtangle/shared";
import type {
  ActorRef,
  EngineErrorCode,
  IntentEnvelope,
} from "@worldtangle/shared";
import type { z } from "zod";

const strictIntentEnvelopeSchema = intentEnvelopeSchema.strict();

export interface ActionExecutionContext<TState = unknown> {
  readonly runId: string;
  readonly tick: number;
  readonly state: TState;
}

export interface ActionRejection {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export type ActionValidationOutcome = void | true | false | ActionRejection;

export interface CapabilityCheckInput<TState = unknown> {
  readonly type: string;
  readonly actor: ActorRef;
  readonly params: unknown;
  readonly intent: IntentEnvelope;
  readonly context: ActionExecutionContext<TState>;
}

export type ActionCapabilityHook<TState = unknown> = (
  input: CapabilityCheckInput<TState>,
) => ActionValidationOutcome;

export type DomainActionValidator<TParams, TState = unknown> = (
  params: TParams,
  context: ActionExecutionContext<TState>,
  intent: IntentEnvelope<TParams>,
) => ActionValidationOutcome;

export type DomainActionExecutor<TParams, TResult = unknown, TState = unknown> = (
  params: TParams,
  context: ActionExecutionContext<TState>,
  intent: IntentEnvelope<TParams>,
) => TResult;

interface StoredActionDefinition<TState> {
  readonly schema: z.ZodType<unknown>;
  readonly validate: DomainActionValidator<unknown, TState>;
  readonly execute: DomainActionExecutor<unknown, unknown, TState>;
}

const preparedBrand: unique symbol = Symbol("PreparedAction");

export interface PreparedAction {
  readonly intent: IntentEnvelope;
  readonly params: unknown;
  readonly type: string;
  readonly [preparedBrand]: {
    readonly registryToken: object;
    readonly definition: StoredActionDefinition<unknown>;
    readonly runId: string;
    readonly tick: number;
  };
}

export interface ActionPreparationAccepted {
  readonly ok: true;
  readonly prepared: PreparedAction;
}

export interface ActionPreparationRejected {
  readonly ok: false;
  readonly rejection: ActionRejection;
  readonly intent?: IntentEnvelope;
}

export type ActionPreparation = ActionPreparationAccepted | ActionPreparationRejected;

export interface ActionDispatchApplied {
  readonly status: "applied";
  readonly intent: IntentEnvelope;
  readonly params: unknown;
  readonly result: unknown;
}

export interface ActionDispatchRejected {
  readonly status: "rejected";
  readonly intent?: IntentEnvelope;
  readonly rejection: ActionRejection;
}

export interface ActionDispatchFailed {
  readonly status: "failed";
  readonly intent: IntentEnvelope;
  readonly params: unknown;
  readonly error: ActionRejection;
}

export type ActionDispatchResult =
  | ActionDispatchApplied
  | ActionDispatchRejected
  | ActionDispatchFailed;

export interface ActionRegistryOptions<TState = unknown> {
  readonly capabilityCheck?: ActionCapabilityHook<TState>;
}

function rejected(
  code: EngineErrorCode,
  message: string,
  details?: unknown,
): ActionPreparationRejected {
  return {
    ok: false,
    rejection: details === undefined ? { code, message } : { code, message, details },
  };
}

function normalizeOutcome(
  outcome: ActionValidationOutcome,
  defaultCode: EngineErrorCode,
  defaultMessage: string,
): ActionRejection | undefined {
  if (outcome === undefined || outcome === true) return undefined;
  if (outcome === false) return { code: defaultCode, message: defaultMessage };
  const code = engineErrorCodeSchema.safeParse(outcome.code);
  if (!code.success || typeof outcome.message !== "string" || outcome.message.length === 0) {
    return {
      code: "INTERNAL",
      message: "action validator returned an invalid rejection",
      details: outcome,
    };
  }
  return outcome;
}

function errorRejection(error: unknown, fallbackMessage: string): ActionRejection {
  if (error instanceof EngineError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "INTERNAL",
    message: fallbackMessage,
    details: error instanceof Error ? { name: error.name, message: error.message } : error,
  };
}

export class ActionRegistry<TState = unknown> {
  private readonly definitions = new Map<string, StoredActionDefinition<TState>>();
  private readonly capabilityCheck: ActionCapabilityHook<TState> | undefined;
  private readonly registryToken = Object.freeze({});

  constructor(options: ActionRegistryOptions<TState> = {}) {
    this.capabilityCheck = options.capabilityCheck;
  }

  registerActionType<TParams, TResult>(
    type: string,
    schema: z.ZodType<TParams>,
    validator: DomainActionValidator<TParams, TState>,
    executor: DomainActionExecutor<TParams, TResult, TState>,
  ): void {
    if (!TYPE_NAME_PATTERN.test(type)) {
      throw new EngineError("VALIDATION_FAILED", "invalid action type: " + type);
    }
    if (this.definitions.has(type)) {
      throw new EngineError("CONFLICT", "action type is already registered: " + type);
    }
    this.definitions.set(type, {
      schema: schema as z.ZodType<unknown>,
      validate: validator as DomainActionValidator<unknown, TState>,
      execute: executor as DomainActionExecutor<unknown, unknown, TState>,
    });
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  listActionTypes(): readonly string[] {
    return Object.freeze(
      [...this.definitions.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    );
  }

  prepare(
    input: unknown,
    context: ActionExecutionContext<TState>,
  ): ActionPreparation {
    const envelope = strictIntentEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      return rejected("SCHEMA_INVALID", "intent envelope is invalid", envelope.error.issues);
    }
    const intent = envelope.data as IntentEnvelope;
    if (intent.tick !== context.tick) {
      const result = rejected(
        "VALIDATION_FAILED",
        "intent tick does not match the execution context",
        { intentTick: intent.tick, contextTick: context.tick },
      );
      return { ...result, intent };
    }
    const definition = this.definitions.get(intent.type);
    if (definition === undefined) {
      const result = rejected("NOT_FOUND", "unknown action type: " + intent.type);
      return { ...result, intent };
    }
    const params = definition.schema.safeParse(intent.params);
    if (!params.success) {
      const result = rejected(
        "SCHEMA_INVALID",
        "action params failed the registered schema",
        params.error.issues,
      );
      return { ...result, intent };
    }

    if (this.capabilityCheck !== undefined) {
      try {
        const capability = normalizeOutcome(
          this.capabilityCheck({
            type: intent.type,
            actor: intent.actor,
            params: params.data,
            intent,
            context,
          }),
          "PERMISSION_DENIED",
          "actor lacks the capability for this action",
        );
        if (capability !== undefined) {
          return { ok: false, intent, rejection: capability };
        }
      } catch (error) {
        const capability = errorRejection(error, "capability check failed");
        return {
          ok: false,
          intent,
          rejection: capability.code === "INTERNAL"
            ? capability
            : { ...capability, code: "PERMISSION_DENIED" },
        };
      }
    }

    try {
      const validation = normalizeOutcome(
        definition.validate(params.data, context, intent),
        "VALIDATION_FAILED",
        "domain action validator rejected the intent",
      );
      if (validation !== undefined) return { ok: false, intent, rejection: validation };
    } catch (error) {
      return {
        ok: false,
        intent,
        rejection: errorRejection(error, "domain action validator failed"),
      };
    }

    const prepared: PreparedAction = {
      intent,
      params: params.data,
      type: intent.type,
      [preparedBrand]: {
        registryToken: this.registryToken,
        definition: definition as StoredActionDefinition<unknown>,
        runId: context.runId,
        tick: context.tick,
      },
    };
    return { ok: true, prepared };
  }

  executePrepared(
    prepared: PreparedAction,
    context: ActionExecutionContext<TState>,
  ): ActionDispatchApplied | ActionDispatchFailed {
    const metadata = prepared[preparedBrand];
    if (
      metadata.registryToken !== this.registryToken ||
      metadata.runId !== context.runId ||
      metadata.tick !== context.tick
    ) {
      throw new EngineError(
        "CONFLICT",
        "prepared action belongs to a different registry or execution context",
      );
    }
    try {
      const result = metadata.definition.execute(
        prepared.params,
        context as ActionExecutionContext<unknown>,
        prepared.intent,
      );
      return {
        status: "applied",
        intent: prepared.intent,
        params: prepared.params,
        result,
      };
    } catch (error) {
      return {
        status: "failed",
        intent: prepared.intent,
        params: prepared.params,
        error: errorRejection(error, "action executor failed"),
      };
    }
  }

  dispatch(
    input: unknown,
    context: ActionExecutionContext<TState>,
  ): ActionDispatchResult {
    const preparation = this.prepare(input, context);
    if (!preparation.ok) {
      return {
        status: "rejected",
        intent: preparation.intent,
        rejection: preparation.rejection,
      };
    }
    return this.executePrepared(preparation.prepared, context);
  }
}
