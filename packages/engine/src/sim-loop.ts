/**
 * Simulation clock: tick loop + ordered phase pipeline + 360-day calendar
 * (ADR-0005). Foundation skeleton: real modules register PhaseHandlers in
 * Phase 1+; the loop itself never changes shape.
 *
 * Determinism: time and randomness are ports. The wall clock is injected and
 * is informational only (excluded from hashes); randomness comes from named
 * forks of the run's root RNG (ADR-0008).
 */

import { EngineError, IdFactory, Rng } from "@worldtangle/shared";
import type { ActorRef, EventEnvelope } from "@worldtangle/shared";
import type { EventBus } from "./bus";
import { validateEventEnvelope } from "./event-log";
import type { EventLog } from "./event-log";

export const PHASES = [
  "obligations",
  "perception",
  "decisions",
  "collect",
  "execute",
  "clearing",
  "settlement",
  "news",
  "metrics",
  "commit",
] as const;
export type PhaseName = (typeof PHASES)[number];

export const TICKS_PER_YEAR = 360;
export const TICKS_PER_MONTH = 30;
/** Semi-monthly payroll days (ADR-0005). */
export const PAYROLL_DAYS: readonly number[] = [15, 30];

/** Tick 1 = Y0001-M01-D01. Tick 0 (genesis/world-gen) maps to the same date. */
export function simDateForTick(tick: number): string {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new EngineError("VALIDATION_FAILED", `invalid tick: ${tick}`);
  }
  const dayIndex = tick <= 0 ? 0 : tick - 1;
  const year = Math.floor(dayIndex / TICKS_PER_YEAR) + 1;
  const dayOfYear = dayIndex % TICKS_PER_YEAR;
  const month = Math.floor(dayOfYear / TICKS_PER_MONTH) + 1;
  const day = (dayOfYear % TICKS_PER_MONTH) + 1;
  const pad = (n: number, width: number): string => n.toString().padStart(width, "0");
  return `Y${pad(year, 4)}-M${pad(month, 2)}-D${pad(day, 2)}`;
}

/** 1..30 within the simulated month (tick ≥ 1). */
export function dayOfMonth(tick: number): number {
  if (!Number.isInteger(tick) || tick < 1) {
    throw new EngineError("VALIDATION_FAILED", `invalid tick: ${tick}`);
  }
  return ((tick - 1) % TICKS_PER_MONTH) + 1;
}

export function isPayrollDay(tick: number): boolean {
  return PAYROLL_DAYS.includes(dayOfMonth(tick));
}

export interface EmitOptions {
  actor?: ActorRef;
  schemaVersion?: number;
  correlationId?: string;
  causationId?: string;
}

export interface TickContext {
  readonly simulationId: string;
  readonly runId: string;
  readonly tick: number;
  readonly simDate: string;
  readonly phase: PhaseName;
  readonly ids: IdFactory;
  /** Named RNG stream scoped to (tick, phase, key) — see ADR-0008. */
  rng(streamKey: string): Rng;
  /** Add authoritative work counts reported in simulation.tick.completed. */
  count(kind: "transactions" | "decisions" | "llmCalls", amount?: number): void;
  /** Replace the small public indicator set carried by the committed digest. */
  setDigestIndicators(indicators: Readonly<Record<string, number | string>>): void;
  emit(type: string, payload: unknown, options?: EmitOptions): EventEnvelope;
}

export interface PhaseHandler {
  /** Module id, e.g. "M07-labor". Part of the deterministic ordering key. */
  readonly module: string;
  /** Handlers in a phase run by ascending order, then module name. */
  readonly order: number;
  run(ctx: TickContext): void;
}

export interface SimLoopOptions {
  simulationId: string;
  runId: string;
  seed: number | string;
  /** A fresh bus — the loop installs the log as its sink. */
  bus: EventBus;
  log: EventLog;
  ids?: IdFactory;
  /** Injected wall clock (informational only, excluded from hashes). */
  wallClock: () => string;
  /** Persisted tick to resume from. Defaults to a new run at tick 0. */
  initialTick?: number;
  /** Persisted next event sequence. Defaults to the event-log count. */
  nextSeq?: number;
  /** Atomic persistence boundary for the tick and its staged events. */
  tickCommitter?: TickCommitter;
  /** Root transaction spanning every phase effect and the final tick commit. */
  tickUnitOfWork?: TickUnitOfWork;
  /** Optional monotonic telemetry clock; never included in authoritative events. */
  monotonicClock?: () => number;
  /** Best-effort observer. Failures are isolated from simulation state. */
  phaseObserver?: (sample: PhaseTimingSample) => void;
}

export interface PhaseTimingSample {
  readonly tick: number;
  readonly phase: PhaseName;
  readonly durationMs: number;
}

export interface TickCommit {
  simulationId: string;
  runId: string;
  previousTick: number;
  tick: number;
  events: readonly EventEnvelope[];
  idState: Readonly<Record<string, number>>;
}

export interface TickCommitter {
  commitTick(commit: TickCommit): void;
}

export interface TickUnitOfWork {
  execute(work: () => void): void;
}

const SYSTEM_ACTOR: ActorRef = { kind: "system", id: "engine" };

export class SimLoop {
  private readonly simulationId: string;
  private readonly runId: string;
  private readonly bus: EventBus;
  private readonly log: EventLog;
  private ids: IdFactory;
  private readonly wallClock: () => string;
  private readonly rootRng: Rng;
  private readonly tickCommitter: TickCommitter | undefined;
  private readonly tickUnitOfWork: TickUnitOfWork | undefined;
  private readonly monotonicClock: (() => number) | undefined;
  private readonly phaseObserver: ((sample: PhaseTimingSample) => void) | undefined;
  private readonly handlers = new Map<PhaseName, PhaseHandler[]>();
  private currentTickValue = 0;
  private nextSeq = 0;
  private pendingEvents: EventEnvelope[] | undefined;

  constructor(options: SimLoopOptions) {
    this.simulationId = options.simulationId;
    this.runId = options.runId;
    this.bus = options.bus;
    this.log = options.log;
    const initialTick = options.initialTick ?? 0;
    const nextSeq = options.nextSeq ?? options.log.count();
    if (!Number.isSafeInteger(initialTick) || initialTick < 0) {
      throw new EngineError("VALIDATION_FAILED", `invalid initial tick: ${initialTick}`);
    }
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
      throw new EngineError("VALIDATION_FAILED", `invalid next event sequence: ${nextSeq}`);
    }
    if (nextSeq !== options.log.count()) {
      throw new EngineError(
        "CONFLICT",
        `event-log count ${options.log.count()} does not match next sequence ${nextSeq}`,
      );
    }
    this.ids = options.ids ?? IdFactory.restore(nextSeq === 0 ? {} : { evt: nextSeq });
    const eventIdCounter = this.ids.serialize()["evt"] ?? 0;
    if (eventIdCounter !== nextSeq) {
      throw new EngineError(
        "CONFLICT",
        `event ID checkpoint ${eventIdCounter} does not match next sequence ${nextSeq}`,
      );
    }
    this.wallClock = options.wallClock;
    this.rootRng = Rng.root(options.seed);
    this.tickCommitter = options.tickCommitter;
    this.tickUnitOfWork = options.tickUnitOfWork;
    if (this.tickCommitter !== undefined && this.tickUnitOfWork === undefined) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "a persisted tick committer requires a tick unit of work",
      );
    }
    this.monotonicClock = options.monotonicClock;
    this.phaseObserver = options.phaseObserver;
    if (this.phaseObserver !== undefined && this.monotonicClock === undefined) {
      throw new EngineError("VALIDATION_FAILED", "phase observer requires a monotonic clock");
    }
    this.currentTickValue = initialTick;
    this.nextSeq = nextSeq;
    this.bus.setSink((event) => {
      if (!this.pendingEvents) {
        throw new EngineError("INTERNAL", "event published outside an active tick");
      }
      this.pendingEvents.push(event);
    });
  }

  get currentTick(): number {
    return this.currentTickValue;
  }

  get nextEventSeq(): number {
    return this.nextSeq;
  }

  get idState(): Readonly<Record<string, number>> {
    return this.ids.serialize();
  }

  registerPhase(phase: PhaseName, handler: PhaseHandler): void {
    if (!PHASES.includes(phase)) {
      throw new EngineError("VALIDATION_FAILED", `unknown phase: ${phase}`);
    }
    const list = this.handlers.get(phase) ?? [];
    list.push(handler);
    list.sort(
      (a, b) =>
        a.order - b.order || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0),
    );
    this.handlers.set(phase, list);
  }

  /** Execute exactly one tick through all phases. Returns the new tick number. */
  tick(): number {
    const tick = this.currentTickValue + 1;
    const simDate = simDateForTick(tick);
    const seqAtStart = this.nextSeq;
    const idsAtStart = this.ids.serialize();
    this.pendingEvents = [];
    try {
      const executeTick = (): void => {
        const workCounts = {
          transactions: 0,
          decisions: 0,
          llmCalls: 0,
        };
        let digestIndicators: Readonly<Record<string, number | string>> = {};
        this.emitEvent(tick, simDate, "simulation.tick.started", { tick });
        for (const phase of PHASES) {
          const phaseStarted = this.monotonicClock?.();
          const ctx: TickContext = {
            simulationId: this.simulationId,
            runId: this.runId,
            tick,
            simDate,
            phase,
            ids: this.ids,
            rng: (streamKey: string) => this.rootRng.fork(`t${tick}.${phase}.${streamKey}`),
            count: (kind, amount = 1) => {
              if (!Number.isSafeInteger(amount) || amount < 0) {
                throw new EngineError(
                  "VALIDATION_FAILED",
                  `tick work count must be a nonnegative integer, got ${amount}`,
                );
              }
              workCounts[kind] += amount;
            },
            setDigestIndicators: (indicators) => {
              const validated: Record<string, number | string> = {};
              for (const key of Object.keys(indicators).sort()) {
                const value = indicators[key];
                if (
                  (typeof value !== "string" || value.length === 0) &&
                  (typeof value !== "number" || !Number.isFinite(value))
                ) {
                  throw new EngineError("VALIDATION_FAILED", `invalid digest indicator ${key}`);
                }
                validated[key] = value;
              }
              digestIndicators = Object.freeze(validated);
            },
            emit: (type, payload, options) =>
              this.emitEvent(tick, simDate, type, payload, options),
          };
          try {
            for (const handler of this.handlers.get(phase) ?? []) {
              handler.run(ctx);
            }
          } finally {
            if (
              phaseStarted !== undefined &&
              this.monotonicClock !== undefined &&
              this.phaseObserver !== undefined
            ) {
              const sample = Object.freeze({
                tick,
                phase,
                durationMs: Math.max(0, this.monotonicClock() - phaseStarted),
              });
              try {
                this.phaseObserver(sample);
              } catch {
                // Telemetry is explicitly non-authoritative and must not make a
                // deterministic tick fail or change its event log.
              }
            }
          }
        }
        this.emitEvent(tick, simDate, "simulation.tick.completed", {
          tick,
          indicators: digestIndicators,
          counts: {
            events: this.nextSeq - seqAtStart + 1,
            transactions: workCounts.transactions,
            decisions: workCounts.decisions,
            llmCalls: workCounts.llmCalls,
          },
          // Engine events must remain replay-hash deterministic. Real elapsed
          // timing belongs in structured telemetry, not authoritative state.
          durationMs: 0,
        });

        const events = Object.freeze([...this.pendingEvents!]);
        const commit: TickCommit = {
          simulationId: this.simulationId,
          runId: this.runId,
          previousTick: this.currentTickValue,
          tick,
          events,
          idState: this.ids.serialize(),
        };
        if (this.tickCommitter) {
          this.tickCommitter.commitTick(commit);
        } else {
          this.log.appendBatch(events);
        }
      };

      if (this.tickUnitOfWork !== undefined) {
        this.tickUnitOfWork.execute(executeTick);
      } else {
        executeTick();
      }
      this.currentTickValue = tick;
      return tick;
    } catch (error) {
      this.nextSeq = seqAtStart;
      this.ids = IdFactory.restore(idsAtStart);
      throw error;
    } finally {
      this.pendingEvents = undefined;
    }
  }

  advance(ticks: number): number {
    if (!Number.isInteger(ticks) || ticks < 1) {
      throw new EngineError("VALIDATION_FAILED", `advance requires a positive tick count, got ${ticks}`);
    }
    for (let i = 0; i < ticks; i++) this.tick();
    return this.currentTickValue;
  }

  private emitEvent(
    tick: number,
    simDate: string,
    type: string,
    payload: unknown,
    options?: EmitOptions,
  ): EventEnvelope {
    const eventId = this.ids.next("evt");
    const envelope: EventEnvelope = {
      eventId,
      type,
      schemaVersion: options?.schemaVersion ?? 1,
      simulationId: this.simulationId,
      runId: this.runId,
      seq: this.nextSeq,
      tick,
      simDate,
      wallTime: this.wallClock(),
      actor: options?.actor ?? SYSTEM_ACTOR,
      correlationId: options?.correlationId ?? eventId,
      ...(options?.causationId ? { causationId: options.causationId } : {}),
      payload,
    };
    const validated = validateEventEnvelope(envelope);
    this.nextSeq += 1;
    this.bus.publish(validated);
    return validated;
  }
}
