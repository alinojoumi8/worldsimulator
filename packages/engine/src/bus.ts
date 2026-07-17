/**
 * Synchronous, deterministic in-process event bus (ADR-0003).
 *
 * - Handlers run in registration order.
 * - Events published from inside a handler are queued FIFO and dispatched
 *   after the current event finishes (no re-entrancy, no microtask races).
 * - The sink (event log) always observes an event BEFORE any handler.
 * - Handlers must not mutate state directly — they enqueue intents/tasks for
 *   defined phases (enforced by convention + review, not by this class).
 */

import type { EventEnvelope } from "@worldtangle/shared";

export type EventHandler = (event: EventEnvelope) => void;

export class EventBus {
  private readonly byType = new Map<string, EventHandler[]>();
  private readonly wildcard: EventHandler[] = [];
  private readonly queue: EventEnvelope[] = [];
  private draining = false;
  private sink: EventHandler | undefined;

  /** The event log's append hook. May be set exactly once. */
  setSink(sink: EventHandler): void {
    if (this.sink) throw new Error("EventBus sink already set");
    this.sink = sink;
  }

  /** Subscribe to one event type, or "*" for every event (runs after typed handlers). */
  subscribe(type: string, handler: EventHandler): void {
    if (type === "*") {
      this.wildcard.push(handler);
      return;
    }
    const list = this.byType.get(type);
    if (list) {
      list.push(handler);
    } else {
      this.byType.set(type, [handler]);
    }
  }

  publish(event: EventEnvelope): void {
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) break;
        this.sink?.(next);
        const typed = this.byType.get(next.type);
        if (typed) {
          // copy: handlers subscribing mid-dispatch must not affect this event
          for (const handler of [...typed]) handler(next);
        }
        for (const handler of [...this.wildcard]) handler(next);
      }
    } catch (error) {
      // Nested publications belong to the failed dispatch attempt. Retaining
      // them would leak phantom events into the next tick/retry.
      this.queue.length = 0;
      throw error;
    } finally {
      this.draining = false;
    }
  }
}
