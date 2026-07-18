import { useEffect, useRef, useState } from "react";
import type {
  DigestStreamData,
  EventStreamFrame,
  GapStreamData,
  LifecycleStreamData,
} from "@worldtangle/shared";
import { consumeEventStream } from "../lib/event-stream-client";

export type StreamConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "auth-required";

interface SimulationStreamOptions {
  readonly simulationId: string;
  readonly runId?: string;
  readonly token: string;
  readonly enabled?: boolean;
  /** Durable sequence to tail from when this run is first connected. */
  readonly initialLastEventId?: number;
  readonly onDigest: (data: DigestStreamData) => void;
  readonly onLifecycle: (data: LifecycleStreamData) => void;
  readonly onGap: (data: GapStreamData) => void;
}

const MAX_RECONNECTS = 5;

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export function useSimulationStream(options: SimulationStreamOptions): {
  connectionState: StreamConnectionState;
  lastEventId?: number;
} {
  const [connectionState, setConnectionState] = useState<StreamConnectionState>("connecting");
  const [lastEventId, setLastEventId] = useState<number>();
  const sequence = useRef<number | undefined>(undefined);
  const streamKey = `${options.simulationId}\u0000${options.runId ?? ""}\u0000${options.token}`;
  const connectedKey = useRef<string | undefined>(undefined);
  const bootstrap = useRef<{
    readonly key: string;
    readonly lastEventId?: number;
  }>({
    key: streamKey,
    ...(options.initialLastEventId === undefined
      ? {}
      : { lastEventId: options.initialLastEventId }),
  });
  if (bootstrap.current.key !== streamKey || connectedKey.current !== streamKey) {
    bootstrap.current = {
      key: streamKey,
      ...(options.initialLastEventId === undefined
        ? {}
        : { lastEventId: options.initialLastEventId }),
    };
  }

  useEffect(() => {
    if (options.enabled === false) {
      sequence.current = undefined;
      setLastEventId(undefined);
      setConnectionState("connecting");
      return undefined;
    }
    const controller = new AbortController();
    connectedKey.current = streamKey;
    sequence.current = bootstrap.current.lastEventId;
    setLastEventId(bootstrap.current.lastEventId);
    setConnectionState("connecting");

    const deliver = (frame: EventStreamFrame): void => {
      sequence.current = frame.id;
      setLastEventId(frame.id);
      if (frame.event === "digest") options.onDigest(frame.data);
      else if (frame.event === "lifecycle") options.onLifecycle(frame.data);
      else options.onGap(frame.data);
    };

    void (async () => {
      for (let attempt = 0; attempt <= MAX_RECONNECTS && !controller.signal.aborted; attempt += 1) {
        try {
          if (attempt > 0) setConnectionState("reconnecting");
          const result = await consumeEventStream({
            simulationId: options.simulationId,
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            token: options.token,
            ...(sequence.current === undefined ? {} : { lastEventId: sequence.current }),
            signal: controller.signal,
            onOpen: () => setConnectionState("live"),
            onFrame: deliver,
          });
          if (controller.signal.aborted) return;
          if (result === "unauthorized") {
            setConnectionState("auth-required");
            return;
          }
        } catch (error) {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            return;
          }
        }

        if (attempt === MAX_RECONNECTS) break;
        const backoff = Math.min(750 * 2 ** attempt, 8_000);
        await waitForRetry(backoff, controller.signal);
      }
      if (!controller.signal.aborted) setConnectionState("offline");
    })();

    return () => controller.abort();
  }, [
    options.enabled,
    options.onDigest,
    options.onGap,
    options.onLifecycle,
    options.runId,
    options.simulationId,
    options.token,
    streamKey,
  ]);

  return {
    connectionState,
    ...(lastEventId === undefined ? {} : { lastEventId }),
  };
}
