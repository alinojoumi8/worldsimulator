import { useQuery } from "@tanstack/react-query";
import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ErrorListResponse,
  LlmCallListResponse,
  SimulationStatusResponse,
} from "@worldtangle/shared";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Gauge,
  MessageSquareText,
  ShieldAlert,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { errorMessage } from "../lib/api-client";

function formatMicrocents(value: string): string {
  const microcents = BigInt(value);
  const whole = microcents / 1_000_000n;
  const fraction = (microcents % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction} cents`;
}

export function BudgetMeter({ status }: { readonly status: SimulationStatusResponse }) {
  const percentage = Math.max(0, Math.min(100, status.llm.budgetPct));
  return (
    <section className="observability-panel budget-panel" aria-labelledby="budget-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"><Gauge size={15} /> Provider boundary</p>
          <h2 id="budget-heading">LLM budget</h2>
        </div>
        <StatusPill status={status.llm.enabled ? `tier-${status.llm.effectiveTier}` : "disabled"} />
      </div>
      <div className="budget-readout">
        <strong>{percentage.toFixed(2)}%</strong>
        <span>{status.llm.spend.costCentsEstimate} cents of {status.llm.limits.runCostCentsMax} cents</span>
      </div>
      <div
        className="budget-track"
        role="progressbar"
        aria-label="Run LLM budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <dl className="observability-stats">
        <div><dt>Input tokens</dt><dd>{status.llm.spend.inputTokens}</dd></div>
        <div><dt>Cached input</dt><dd>{status.llm.spend.cachedInputTokens}</dd></div>
        <div><dt>Output tokens</dt><dd>{status.llm.spend.outputTokens}</dd></div>
        <div><dt>Cache hit rate</dt><dd>{(status.llm.cacheHitRate * 100).toFixed(1)}%</dd></div>
        <div><dt>Daily agent limit</dt><dd>{status.llm.limits.perAgentDailyTokens}</dd></div>
      </dl>
      {status.llm.autoPaused ? <p className="health-warning">The run auto-paused at its cost ceiling.</p> : null}
      {status.llm.frozenModules.length === 0 ? null : (
        <p className="health-warning">Frozen modules: {status.llm.frozenModules.join(", ")}</p>
      )}
    </section>
  );
}

export function ObservabilityDashboard({
  simulationId,
  status,
  calls,
  errors,
  conversations,
}: {
  readonly simulationId: string;
  readonly status: SimulationStatusResponse;
  readonly calls: LlmCallListResponse;
  readonly errors: ErrorListResponse;
  readonly conversations: ConversationListResponse;
}) {
  return (
    <>
      <div className="observability-grid">
        <BudgetMeter status={status} />
        <section className="observability-panel" aria-labelledby="health-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow"><ShieldAlert size={15} /> Failure health</p>
              <h2 id="health-heading">Errors and quarantines</h2>
            </div>
            <strong className="health-total">{status.errors.last24Ticks} / 24 ticks</strong>
          </div>
          <dl className="observability-stats observability-stats--errors">
            <div><dt>Engine</dt><dd>{errors.summary.counts.engine}</dd></div>
            <div><dt>Rejected intents</dt><dd>{errors.summary.counts.intentRejected}</dd></div>
            <div><dt>LLM failures</dt><dd>{errors.summary.counts.llm}</dd></div>
            <div><dt>Schema failures</dt><dd>{errors.summary.counts.schema}</dd></div>
          </dl>
          <div className="quarantine-list">
            {errors.summary.activeQuarantines.length === 0 ? (
              <p>No active agent quarantines.</p>
            ) : errors.summary.activeQuarantines.map(({ agent, quarantine }) => (
              <div key={agent.id}>
                <AlertTriangle size={15} />
                <span><strong>{agent.name}</strong> Tier 1 through tick {quarantine.untilTick}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="observability-panel" aria-labelledby="calls-heading">
        <div className="panel-heading">
          <div><p className="eyebrow"><Bot size={15} /> Per-call receipts</p><h2 id="calls-heading">LLM calls</h2></div>
          <span>{calls.totals.calls} calls / {formatMicrocents(calls.totals.costMicrocents)}</span>
        </div>
        {calls.items.length === 0 ? <p className="observability-empty">No model proposals recorded.</p> : (
          <div className="observability-table-wrap">
            <table className="observability-table">
              <thead><tr><th>Tick / agent</th><th>Purpose</th><th>Route</th><th>Tokens</th><th>Latency</th><th>Cost</th><th>Result</th></tr></thead>
              <tbody>{calls.items.map((call) => (
                <tr key={call.id}>
                  <td><strong>{call.tick}</strong><span>{call.agent.name}</span></td>
                  <td><code>{call.purpose}</code><span>{call.id}</span></td>
                  <td><strong>{call.model}</strong><span>{call.provider}</span></td>
                  <td>
                    {call.inputTokens} in ({call.cachedInputTokens} cached) / {call.outputTokens} out
                  </td>
                  <td>{call.latencyMs} ms</td>
                  <td>{formatMicrocents(call.costMicrocents)}</td>
                  <td><StatusPill status={call.status} />{call.cached ? <span>cache hit</span> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <div className="observability-grid observability-grid--feeds">
        <section className="observability-panel" aria-labelledby="errors-heading">
          <div className="panel-heading"><div><p className="eyebrow"><Activity size={15} /> Correlated failures</p><h2 id="errors-heading">Error feed</h2></div></div>
          <div className="error-health-list">
            {errors.items.length === 0 ? <p>No recorded failures.</p> : errors.items.map((item) => (
              <article key={item.eventId}>
                <div><span className="kind-chip">{item.kind.replaceAll("_", " ")}</span><strong>{item.code}</strong><small>Tick {item.tick}</small></div>
                <p>{item.message}</p>
                <code>{item.correlationId}</code>
              </article>
            ))}
          </div>
        </section>

        <section className="observability-panel" aria-labelledby="conversations-heading">
          <div className="panel-heading"><div><p className="eyebrow"><MessageSquareText size={15} /> Bounded dialogue</p><h2 id="conversations-heading">Conversations</h2></div></div>
          <div className="conversation-list">
            {conversations.items.length === 0 ? <p>No conversations recorded.</p> : conversations.items.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/simulations/${simulationId}/observability/conversations/${conversation.id}`}
              >
                <MessageSquareText size={17} />
                <span><strong>{conversation.participants.map((agent) => agent.name).join(" to ")}</strong><small>{conversation.topic} / {conversation.turns} turns / tick {conversation.startTick}</small></span>
                <StatusPill status={conversation.status} />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

export function ConversationTranscript({ detail }: { readonly detail: ConversationDetailResponse }) {
  return (
    <>
      <section className="entity-heading">
        <div><p className="eyebrow"><MessageSquareText size={15} /> Bounded conversation</p><h1>{detail.conversation.participants.map((agent) => agent.name).join(" to ")}</h1></div>
        <StatusPill status={detail.conversation.status} />
        <p>{detail.conversation.topic} / {detail.conversation.turns}/{detail.conversation.maxTurns} turns / {detail.conversation.outputTokensUsed}/{detail.conversation.outputTokenBudget} output tokens</p>
      </section>
      <section className="observability-panel transcript-panel" aria-label="Conversation transcript">
        {detail.messages.length === 0 ? <p>No messages were committed.</p> : detail.messages.map((message) => (
          <article className="transcript-message" key={message.id}>
            <header><strong>{message.sender.name}</strong><span>Turn {message.turn} / tick {message.tick}</span><span>{message.kind}</span></header>
            <p data-testid="transcript-content">{message.content}</p>
            {message.structuredTerms === null ? null : <pre>{JSON.stringify(message.structuredTerms, null, 2)}</pre>}
            <footer><code>{message.decisionId}</code>{message.llmCallId === null ? null : <code>{message.llmCallId}</code>}</footer>
          </article>
        ))}
      </section>
      <div className="observability-grid">
        <section className="observability-panel"><h2>Outcome</h2><pre>{JSON.stringify(detail.outcome, null, 2)}</pre></section>
        <section className="observability-panel"><h2>Engine binding</h2><pre>{JSON.stringify(detail.binding, null, 2)}</pre></section>
      </div>
    </>
  );
}

export function ObservabilityPage() {
  const simulationId = useParams().simId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
    refetchInterval: 5_000,
  });
  const runId = status.data?.run.id;
  const calls = useQuery({
    queryKey: ["llm-calls", simulationId, runId, token],
    queryFn: ({ signal }) => api.listLlmCalls(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const errors = useQuery({
    queryKey: ["errors", simulationId, runId, token],
    queryFn: ({ signal }) => api.listErrors(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const conversations = useQuery({
    queryKey: ["conversations", simulationId, runId, token],
    queryFn: ({ signal }) => api.listConversations(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const pending = status.isPending || calls.isPending || errors.isPending || conversations.isPending;
  const failure = status.error ?? calls.error ?? errors.error ?? conversations.error;

  return (
    <div className="explorer-page observability-page">
      <Link className="back-link" to={`/simulations/${simulationId}`}><ArrowLeft size={17} /> Simulation cockpit</Link>
      <header className="explorer-header">
        <div><p className="eyebrow"><Activity size={16} /> WS-608 operations</p><h1>Runtime observability</h1><p>Exact model receipts, correlated failures, quarantines, and bounded conversation evidence.</p></div>
      </header>
      {pending ? <LoadingPanel label="Reconciling runtime telemetry..." /> : null}
      {failure === null ? null : <ErrorNotice message={errorMessage(failure)} onRetry={() => { void Promise.all([status.refetch(), calls.refetch(), errors.refetch(), conversations.refetch()]); }} />}
      {status.data === undefined || calls.data === undefined || errors.data === undefined || conversations.data === undefined ? null : (
        <ObservabilityDashboard
          simulationId={simulationId}
          status={status.data}
          calls={calls.data}
          errors={errors.data}
          conversations={conversations.data}
        />
      )}
    </div>
  );
}

export function ConversationDetailPage() {
  const simulationId = useParams().simId ?? "invalid";
  const conversationId = useParams().conversationId ?? "invalid";
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["conversation", simulationId, conversationId, token],
    queryFn: ({ signal }) => api.getConversation(simulationId, conversationId, undefined, signal),
  });
  return (
    <div className="explorer-page observability-page">
      <Link className="back-link" to={`/simulations/${simulationId}/observability`}><ArrowLeft size={17} /> Runtime observability</Link>
      {query.isPending ? <LoadingPanel label="Reading bounded transcript..." /> : null}
      {query.error === null ? null : <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />}
      {query.data === undefined ? null : <ConversationTranscript detail={query.data} />}
    </div>
  );
}
