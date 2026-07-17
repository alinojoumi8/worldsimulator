import type {
  LlmProviderRoute,
  LlmRequest,
  LlmResult,
  RoutedLlmProvider,
} from "@worldtangle/engine";

export type MonotonicClock = () => number;

function elapsedMilliseconds(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.ceil(end - start);
}

/**
 * Adds operational latency after the deterministic provider gateway has made
 * its proposal. Latency is persisted for observability but is never hashed or
 * used as an engine input.
 */
export class TimedLlmProvider implements RoutedLlmProvider {
  constructor(
    private readonly provider: RoutedLlmProvider,
    private readonly monotonicClock: MonotonicClock,
  ) {}

  route(request: LlmRequest): LlmProviderRoute {
    return this.provider.route(request);
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    const start = this.readClock();
    const result = await this.provider.propose(request);
    return {
      ...result,
      latencyMs: elapsedMilliseconds(start, this.readClock()),
    };
  }

  private readClock(): number {
    try {
      return this.monotonicClock();
    } catch {
      return 0;
    }
  }
}
