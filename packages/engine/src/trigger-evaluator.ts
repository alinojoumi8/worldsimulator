/** Deterministic per-tick trigger evaluation and capped wake-set construction. */

import {
  EngineError,
  TRIGGER_KINDS,
  canonicalStringify,
  hashValue,
  triggerSignalSchema,
} from "@worldtangle/shared";
import type { TriggerKind, TriggerSignal } from "@worldtangle/shared";

export type TriggerDropReason =
  | "invalid"
  | "unknown_agent"
  | "not_due"
  | "stale"
  | "duplicate"
  | "per_agent_cap";

export interface TriggerDrop {
  readonly reason: TriggerDropReason;
  readonly signal: unknown;
  readonly detail?: string;
}

export interface WakeSetEntry {
  readonly agentId: string;
  readonly triggers: readonly TriggerSignal[];
}

export interface WakeSet {
  readonly tick: number;
  readonly entries: readonly WakeSetEntry[];
  readonly dropped: readonly TriggerDrop[];
  readonly inputCount: number;
  readonly wakeSetHash: string;
}

export interface TriggerEvaluatorOptions {
  readonly maxTriggersPerAgentPerTick?: number;
}

const TRIGGER_ORDER = new Map<TriggerKind, number>(
  TRIGGER_KINDS.map((kind, index) => [kind, index]),
);

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortFingerprint(value: unknown): string {
  try {
    return canonicalStringify(value);
  } catch {
    try {
      return "~unsupported:" + Object.prototype.toString.call(value);
    } catch {
      return "~unsupported:" + typeof value;
    }
  }
}

function compareSignals(left: TriggerSignal, right: TriggerSignal): number {
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  const kind = (TRIGGER_ORDER.get(left.kind) ?? 0) - (TRIGGER_ORDER.get(right.kind) ?? 0);
  if (kind !== 0) return kind;
  const source = compareCodeUnit(left.sourceEventId, right.sourceEventId);
  return source !== 0
    ? source
    : compareCodeUnit(canonicalStringify(left), canonicalStringify(right));
}

function triggerIdentity(signal: TriggerSignal): string {
  return signal.agentId + "|" + signal.kind + "|" + signal.sourceEventId;
}

function activeAtTick(signal: TriggerSignal, tick: number): TriggerDropReason | undefined {
  if (signal.kind === "schedule") {
    if (signal.tick > tick || signal.payload.dueTick > tick) return "not_due";
    return undefined;
  }
  if (signal.tick < tick) return "stale";
  if (signal.tick > tick) return "not_due";
  return undefined;
}

export class TriggerEvaluator {
  readonly maxTriggersPerAgentPerTick: number;

  constructor(options: TriggerEvaluatorOptions = {}) {
    const cap = options.maxTriggersPerAgentPerTick ?? 3;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "maxTriggersPerAgentPerTick must be an integer from 1 to 32, got " + cap,
      );
    }
    this.maxTriggersPerAgentPerTick = cap;
  }

  evaluateTriggers(
    tick: number,
    signals: readonly unknown[],
    knownAgentIds?: ReadonlySet<string>,
  ): WakeSet {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "invalid trigger-evaluation tick: " + tick,
      );
    }

    const dropped: TriggerDrop[] = [];
    const candidates: TriggerSignal[] = [];
    for (const input of signals) {
      const parsed = triggerSignalSchema.safeParse(input);
      if (!parsed.success) {
        dropped.push({ reason: "invalid", signal: input, detail: parsed.error.message });
        continue;
      }
      const signal = parsed.data;
      if (knownAgentIds !== undefined && !knownAgentIds.has(signal.agentId)) {
        dropped.push({ reason: "unknown_agent", signal });
        continue;
      }
      const inactiveReason = activeAtTick(signal, tick);
      if (inactiveReason !== undefined) {
        dropped.push({ reason: inactiveReason, signal });
        continue;
      }
      candidates.push(signal);
    }

    candidates.sort((left, right) => {
      const agent = compareCodeUnit(left.agentId, right.agentId);
      return agent !== 0 ? agent : compareSignals(left, right);
    });

    const deduplicated: TriggerSignal[] = [];
    const identities = new Set<string>();
    for (const signal of candidates) {
      const identity = triggerIdentity(signal);
      if (identities.has(identity)) {
        dropped.push({ reason: "duplicate", signal });
      } else {
        identities.add(identity);
        deduplicated.push(signal);
      }
    }

    const byAgent = new Map<string, TriggerSignal[]>();
    for (const signal of deduplicated) {
      const group = byAgent.get(signal.agentId) ?? [];
      if (group.length >= this.maxTriggersPerAgentPerTick) {
        dropped.push({ reason: "per_agent_cap", signal });
      } else {
        group.push(signal);
        byAgent.set(signal.agentId, group);
      }
    }
    const entries = [...byAgent.entries()]
      .sort(([left], [right]) => compareCodeUnit(left, right))
      .map(([agentId, triggers]) => ({
        agentId,
        triggers: Object.freeze([...triggers].sort(compareSignals)),
      }));
    dropped.sort((left, right) => {
      const reason = compareCodeUnit(left.reason, right.reason);
      return reason !== 0
        ? reason
        : compareCodeUnit(sortFingerprint(left.signal), sortFingerprint(right.signal));
    });
    const wakeSetHash = hashValue({ tick, entries });
    return Object.freeze({
      tick,
      entries: Object.freeze(entries),
      dropped: Object.freeze(dropped),
      inputCount: signals.length,
      wakeSetHash,
    });
  }
}
