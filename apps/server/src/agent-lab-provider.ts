import {
  AGENT_LAB_PROTOCOL_VERSION,
  agentTurnEnvelopeSchema,
  hashValue,
  type AgentTurnEnvelope,
  type RunManifestAgentLab,
} from "@worldtangle/shared";
import {
  llmRequestHash,
  type LlmRequest,
  type LlmResult,
  type RoutedLlmProvider,
} from "@worldtangle/engine";
import {
  SqliteAgentLabStore,
  SqliteReplayStore,
  toSafeNumber,
  type WorldDatabase,
} from "./persistence";

export interface AgentLabProviderOptions {
  readonly native: RoutedLlmProvider;
  readonly external: RoutedLlmProvider;
  readonly store: SqliteAgentLabStore;
  readonly config: RunManifestAgentLab;
  readonly wallClock: () => string;
  readonly replay: boolean;
}

export function agentLabTurnId(trialId: string, opportunityKey: string): string {
  return `turn_${hashValue({
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    trialId,
    opportunityKey,
  }).slice(0, 24)}`;
}

function deadline(createdWall: string, deadlineMs: number): string {
  const created = Date.parse(createdWall);
  if (!Number.isFinite(created)) {
    throw new RangeError("Agent Lab wall clock must return an ISO-8601 timestamp");
  }
  return new Date(created + deadlineMs).toISOString();
}

function requireContext(request: LlmRequest) {
  if (request.agentLab === undefined) {
    throw new TypeError("Agent Lab provider received a request without scoped context");
  }
  return request.agentLab;
}

function envelopeFor(
  request: LlmRequest,
  config: RunManifestAgentLab,
  createdWall: string,
): AgentTurnEnvelope {
  const context = requireContext(request);
  if (context.controller !== "shadow" && context.controller !== "external") {
    throw new TypeError("native Agent Lab requests do not open external turns");
  }
  return agentTurnEnvelopeSchema.parse({
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    simulationId: context.simulationId,
    runId: context.runId,
    studyId: context.studyId,
    trialId: context.trialId,
    turnId: agentLabTurnId(context.trialId, context.opportunityKey),
    agentId: request.agentId,
    controller: context.controller,
    opportunityKey: context.opportunityKey,
    trigger: context.trigger,
    completedTick: context.completedTick,
    targetTick: context.targetTick,
    observation: context.observation,
    offeredOptions: context.offeredOptions,
    projectionHash: hashValue(context.observation),
    menuHash: hashValue(context.offeredOptions),
    cursor: Buffer.from(
      `${context.targetTick}:${context.opportunityKey}`,
      "utf8",
    ).toString("base64url"),
    deadline: deadline(createdWall, config.decisionDeadlineMs),
    driverPolicyDigest: context.driverPolicyDigest,
    promptDigest: context.promptDigest,
    toolSchemaDigest: context.toolSchemaDigest,
  });
}

/**
 * Raw external proposal source. It can only return a candidate for the
 * existing Tier-2 resolver; it never sees a state writer or ActionRegistry.
 */
export class AgentLabExternalTurnProvider implements RoutedLlmProvider {
  constructor(
    private readonly store: SqliteAgentLabStore,
    private readonly config: RunManifestAgentLab,
    private readonly wallClock: () => string,
  ) {}

  route(request: LlmRequest) {
    void request;
    return {
      provider: "worldtangle-agent-lab",
      model: `hermes-external@${this.config.driverPolicyDigest.slice(0, 12)}`,
    };
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    const requestHash = llmRequestHash(request);
    try {
      const createdWall = this.wallClock();
      const envelope = this.store.openTurn(
        envelopeFor(request, this.config, createdWall),
        createdWall,
      );
      const submission = await this.store.waitForAcceptedSubmission(
        envelope.turnId,
        this.wallClock,
      );
      if (submission === null) {
        return {
          ok: false,
          reason: "provider_error",
          requestHash,
          detail: "external decision deadline elapsed; using deterministic Tier-1 fallback",
          providerError: {
            provider: "worldtangle-agent-lab",
            code: "timeout",
            retryable: false,
          },
          attempts: 0,
          requestedTier: 2,
          effectiveTier: 1,
        };
      }
      return {
        ok: true,
        value: submission.action,
        model: this.route(request).model,
        cached: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        requestHash,
        attempts: 1,
        requestedTier: 2,
        effectiveTier: 2,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "provider_error",
        requestHash,
        detail: error instanceof Error ? error.message : "Agent Lab turn failed",
        providerError: {
          provider: "worldtangle-agent-lab",
          code: "malformed_response",
          retryable: false,
        },
        attempts: 0,
        requestedTier: 2,
        effectiveTier: 1,
      };
    }
  }
}

/**
 * Cache-independent replay source for external decisions. The expectation is
 * imported from the source run's causal input event before replay starts.
 */
export class RecordedAgentLabReplayProvider implements RoutedLlmProvider {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
    private readonly config: RunManifestAgentLab,
  ) {}

  route(request: LlmRequest) {
    void request;
    return {
      provider: "worldtangle-agent-lab",
      model: `hermes-external@${this.config.driverPolicyDigest.slice(0, 12)}`,
    };
  }

  async propose(request: LlmRequest): Promise<LlmResult> {
    const requestHash = llmRequestHash(request);
    const emitted = this.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE run_id = ? AND type = 'agent.external_submission.recorded'
    `).get(this.runId);
    const ordinal = toSafeNumber(
      emitted?.count ?? 0n,
      "replayed Agent Lab input event count",
    ) + 1;
    const expected = new SqliteReplayStore(this.db, this.runId)
      .agentLabSubmissionAt(ordinal);
    if (expected === null || expected.requestHash !== requestHash) {
      return {
        ok: false,
        reason: "cache_miss",
        requestHash,
        detail: expected === null
          ? "replay journal has no external Agent Lab submission for this turn"
          : "replay Agent Lab request hash differs from the recorded submission",
        providerError: {
          provider: "worldtangle-agent-lab",
          code: "cache_miss",
          retryable: false,
        },
        attempts: 0,
        requestedTier: 2,
        effectiveTier: 1,
      };
    }
    return {
      ok: true,
      value: expected.proposal,
      model: this.route(request).model,
      cached: false,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      requestHash,
      attempts: 1,
      requestedTier: 2,
      effectiveTier: 2,
    };
  }
}

/**
 * Routes native, observational shadow, and authoritative external decisions.
 * Shadow work is sidecar-only and deliberately cannot affect the native
 * provider result, cache key, event stream, or logical state.
 */
export class AgentLabRoutedLlmProvider implements RoutedLlmProvider {
  constructor(private readonly options: AgentLabProviderOptions) {}

  route(request: LlmRequest) {
    return request.agentLab?.controller === "external"
      ? this.options.external.route(request)
      : this.options.native.route(request);
  }

  propose(request: LlmRequest): Promise<LlmResult> {
    const controller = request.agentLab?.controller ?? "native";
    if (controller === "external") return this.options.external.propose(request);
    if (controller === "shadow" && !this.options.replay) this.openShadowTurn(request);
    return this.options.native.propose(request);
  }

  private openShadowTurn(request: LlmRequest): void {
    try {
      const createdWall = this.options.wallClock();
      this.options.store.openTurn(
        envelopeFor(request, this.options.config, createdWall),
        createdWall,
      );
      const timer = setTimeout(() => {
        try {
          this.options.store.expireDueTurns(this.options.wallClock());
        } catch {
          // Sidecar lifecycle failures cannot alter an authoritative shadow run.
        }
      }, this.options.config.decisionDeadlineMs + 1);
      timer.unref?.();
    } catch {
      // Shadow instrumentation is explicitly non-authoritative.
    }
  }
}
