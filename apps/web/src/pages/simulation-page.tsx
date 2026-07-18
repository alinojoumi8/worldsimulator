import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DigestStreamData,
  IndicatorSeriesName,
  InjectWorldEventRequest,
} from "@worldtangle/shared";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Banknote,
  BookOpenText,
  Bot,
  CirclePause,
  CirclePlay,
  Clock3,
  Gauge,
  GitBranch,
  Newspaper,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Square,
  StepForward,
  Waypoints,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import { IndicatorSparkline } from "../components/indicator-sparkline";
import { ErrorNotice, LoadingPanel, MetricCard, StatusPill } from "../components/ui";
import { WorldEventInjector } from "../components/world-event-injector";
import { useSimulationStream } from "../hooks/use-simulation-stream";
import { errorMessage } from "../lib/api-client";

type RunAction = "start" | "pause" | "resume" | "stop" | "step";

const INDICATOR_PRESENTATION: Record<IndicatorSeriesName, {
  readonly label: string;
  readonly description: string;
  readonly tone: "teal" | "blue" | "rust" | "green";
}> = {
  gdpProxy: {
    label: "GDP proxy (30 ticks)",
    description: "Rolling local final household and energy expenditure",
    tone: "teal",
  },
  cpi: {
    label: "Consumer price index",
    description: "Fixed Riverbend basket, tick-0 base 1000",
    tone: "rust",
  },
  m1: {
    label: "Money supply",
    description: "Agent and company checking deposits",
    tone: "teal",
  },
  treasuryBalance: {
    label: "Treasury balance",
    description: "Government checking balance",
    tone: "blue",
  },
  averageWage: {
    label: "Average annual wage",
    description: "Mean wage on active employment contracts",
    tone: "green",
  },
  unemploymentRate: {
    label: "Unemployment rate",
    description: "Working-age agents without active employment",
    tone: "rust",
  },
  creditOutstanding: {
    label: "Credit outstanding",
    description: "Gross stored principal still owed",
    tone: "blue",
  },
  defaultRate: {
    label: "Default rate",
    description: "Recorded defaults as a share of all loans",
    tone: "rust",
  },
  businessCount: {
    label: "Active businesses",
    description: "Unique owners with an active company checking account",
    tone: "green",
  },
  sentimentIndex: {
    label: "Sentiment index",
    description: "Mean of decayed economy, employment, and institutions sentiment",
    tone: "blue",
  },
};

const MACRO_SERIES = ["gdpProxy", "cpi"] as const;
const FINANCE_SERIES = ["m1", "treasuryBalance", "creditOutstanding", "defaultRate"] as const;
const EMPLOYMENT_SERIES = ["averageWage", "unemploymentRate"] as const;
const BUSINESS_SERIES = ["businessCount", "sentimentIndex"] as const;

function formatSimDate(value: string): string {
  const match = /^Y(\d{4})-M(\d{2})-D(\d{2})$/.exec(value);
  return match === null ? value : `Year ${Number(match[1])} · Month ${Number(match[2])} · Day ${Number(match[3])}`;
}

function formatCents(value: string): string {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? `$${(cents / 100).toFixed(2)}` : `${value}¢`;
}

function titleFromType(type: string): string {
  return type
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" · ");
}

function streamLabel(state: string): string {
  const labels: Record<string, string> = {
    connecting: "Connecting",
    live: "Live",
    reconnecting: "Reconnecting",
    offline: "Offline",
    "auth-required": "Token required",
    synced: "Durable snapshot",
  };
  return labels[state] ?? state;
}

export function SimulationPage() {
  const simulationId = useParams().simId ?? "invalid";
  const { api, token } = useAppSession();
  const queryClient = useQueryClient();
  const [streamDigest, setStreamDigest] = useState<{
    readonly runId: string;
    readonly data: DigestStreamData;
  }>();

  const detail = useQuery({
    queryKey: ["simulation", simulationId, token],
    queryFn: ({ signal }) => api.getSimulation(simulationId, signal),
  });
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
    refetchInterval: (query) => query.state.data?.run.status === "running" ? 1_000 : 5_000,
  });
  const runId = status.data?.run.id;
  const events = useQuery({
    queryKey: ["events", simulationId, runId, token],
    queryFn: ({ signal }) => api.listEvents(simulationId, runId, signal),
    enabled: runId !== undefined,
    refetchInterval: status.data?.run.status === "running" ? 2_000 : false,
  });
  const indicators = useQuery({
    queryKey: ["indicators", simulationId, runId, token],
    queryFn: ({ signal }) => api.listIndicators(simulationId, runId, signal),
    enabled: runId !== undefined,
    refetchInterval: status.data?.run.status === "running" ? 2_000 : false,
  });

  const refreshRun = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["simulation", simulationId] }),
      queryClient.invalidateQueries({ queryKey: ["status", simulationId] }),
      queryClient.invalidateQueries({ queryKey: ["events", simulationId] }),
      queryClient.invalidateQueries({ queryKey: ["indicators", simulationId] }),
      queryClient.invalidateQueries({ queryKey: ["simulations"] }),
    ]);
  }, [queryClient, simulationId]);
  const handleDigest = useCallback((data: DigestStreamData) => {
    if (runId !== undefined) setStreamDigest({ runId, data });
  }, [runId]);
  const handleLifecycle = useCallback(() => {
    refreshRun();
  }, [refreshRun]);
  const handleGap = useCallback(() => {
    refreshRun();
  }, [refreshRun]);
  const terminalRun = status.data?.run.status === "completed" ||
    status.data?.run.status === "stopped" ||
    status.data?.run.status === "failed";
  const stream = useSimulationStream({
    simulationId,
    ...(runId === undefined ? {} : { runId }),
    token,
    enabled: runId !== undefined && status.data !== undefined && !terminalRun,
    ...(status.data === undefined
      ? {}
      : { initialLastEventId: status.data.activity.latestEventSeq }),
    onDigest: handleDigest,
    onLifecycle: handleLifecycle,
    onGap: handleGap,
  });

  const liveDigest = streamDigest !== undefined && streamDigest.runId === runId
    ? streamDigest.data
    : undefined;
  const durableDigest = status.data?.activity.latestDigest ?? undefined;
  const latestDigest = liveDigest === undefined ||
      (durableDigest !== undefined && durableDigest.tick > liveDigest.tick)
    ? durableDigest
    : liveDigest;
  const displayedStreamState = terminalRun ? "synced" : stream.connectionState;
  const displayedLastEventId = stream.lastEventId ?? status.data?.activity.latestEventSeq;

  const action = useMutation({
    mutationFn: async (requested: RunAction) => {
      if (requested === "step") return api.advance(simulationId, runId);
      return api.control(simulationId, requested, runId);
    },
    onSuccess: refreshRun,
  });
  const injectEvent = useMutation({
    mutationFn: (input: InjectWorldEventRequest) => api.injectWorldEvent(simulationId, input),
    onSuccess: refreshRun,
  });

  const runStatus = status.data?.run.status;
  const currentTick = Math.max(status.data?.run.currentTick ?? 0, latestDigest?.tick ?? 0);
  const endTick = status.data?.run.endTick ?? 1;
  const progress = Math.min(100, (currentTick / endTick) * 100);
  const simDate = latestDigest?.tick === currentTick
    ? latestDigest.simDate
    : (status.data?.run.simDate ?? "Y0001-M01-D01");
  const scenario = detail.data?.simulation.scenario;
  const scenarioBudget = useMemo(() => {
    const budgets = scenario?.["budgets"];
    if (typeof budgets !== "object" || budgets === null) return undefined;
    const value = (budgets as Record<string, unknown>)["runCostCentsMax"];
    return typeof value === "string" ? value : undefined;
  }, [scenario]);

  if (detail.isPending || status.isPending) {
    return <div className="cockpit-page"><LoadingPanel label="Tracing this world’s state…" /></div>;
  }
  if (detail.error !== null || status.error !== null) {
    const failure = detail.error ?? status.error;
    return (
      <div className="cockpit-page">
        <Link className="back-link" to="/"><ArrowLeft size={17} /> Simulation library</Link>
        <ErrorNotice
          title="Could not open this simulation"
          message={errorMessage(failure)}
          onRetry={() => { void Promise.all([detail.refetch(), status.refetch()]); }}
        />
      </div>
    );
  }

  return (
    <div className="cockpit-page">
      <div className="cockpit-breadcrumb">
        <Link className="back-link" to="/"><ArrowLeft size={17} /> Simulation library</Link>
        <span aria-hidden="true">/</span>
        <span>{detail.data.simulation.id}</span>
      </div>

      <header className="cockpit-header">
        <div className="cockpit-header__title">
          <p className="eyebrow"><Waypoints size={16} /> Riverbend system</p>
          <div className="title-line">
            <h1>{detail.data.simulation.name}</h1>
            <StatusPill status={runStatus ?? "created"} />
          </div>
          <p>{formatSimDate(simDate)} <span>·</span> Run {runId}</p>
        </div>
        <div className="stream-status" data-state={displayedStreamState}>
          <span className="stream-status__pulse" />
          <div>
            <strong>{streamLabel(displayedStreamState)}</strong>
            <span>{displayedLastEventId === undefined ? "Committed event stream" : `Through event #${displayedLastEventId}`}</span>
          </div>
        </div>
      </header>

      <section className="world-explorer-callout" aria-label="World explorer">
        <Waypoints size={22} />
        <div>
          <strong>Trace the living economy</strong>
          <p>Open companies, jobs, contracts, institutions, posted prices, and citizen finances.</p>
        </div>
        <div className="callout-actions">
          <Link className="button button--secondary" to={`/simulations/${simulationId}/world/companies`}>
            Explore Riverbend
          </Link>
          <Link className="button button--secondary" to={`/simulations/${simulationId}/observability`}>
            Observe runtime
          </Link>
          <Link className="button button--secondary" to={`/simulations/${simulationId}/explorer`}>
            <Newspaper size={16} /> News and replay
          </Link>
        </div>
      </section>

      <section className="run-console" aria-label="Simulation controls and progress">
        <div className="run-progress">
          <div className="run-progress__numbers">
            <div><span>Current tick</span><strong>{currentTick}</strong></div>
            <span>of {endTick}</span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Simulation progress"
            aria-valuemin={0}
            aria-valuemax={endTick}
            aria-valuenow={currentTick}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="run-controls" aria-label="Lifecycle controls">
          {runStatus === "created" ? (
            <button className="button button--primary" type="button" disabled={action.isPending} onClick={() => action.mutate("start")}>
              <Play size={17} fill="currentColor" /> Start run
            </button>
          ) : null}
          {runStatus === "running" ? (
            <button className="button button--primary" type="button" disabled={action.isPending} onClick={() => action.mutate("pause")}>
              <Pause size={17} fill="currentColor" /> Pause
            </button>
          ) : null}
          {runStatus === "paused" ? (
            <>
              <button className="button button--primary" type="button" disabled={action.isPending} onClick={() => action.mutate("resume")}>
                <Play size={17} fill="currentColor" /> Resume
              </button>
              <button className="button button--secondary" type="button" disabled={action.isPending} onClick={() => action.mutate("step")}>
                <StepForward size={17} /> Step one tick
              </button>
            </>
          ) : null}
          {runStatus === "running" || runStatus === "paused" ? (
            <button className="button button--danger-quiet" type="button" disabled={action.isPending} onClick={() => action.mutate("stop")}>
              <Square size={15} fill="currentColor" /> Stop
            </button>
          ) : null}
          {runStatus === "completed" ? <span className="terminal-note"><CirclePlay size={17} /> End tick reached</span> : null}
          {runStatus === "stopped" ? <span className="terminal-note"><CirclePause size={17} /> Run stopped</span> : null}
          {runStatus === "failed" ? <span className="terminal-note terminal-note--error"><AlertCircle size={17} /> Run failed</span> : null}
        </div>
      </section>
      {action.error === null ? null : <ErrorNotice title="Lifecycle command failed" message={errorMessage(action.error)} />}
      <WorldEventInjector
        runId={runId}
        runStatus={runStatus}
        pending={injectEvent.isPending}
        {...(injectEvent.error === null ? {} : { failure: errorMessage(injectEvent.error) })}
        {...(injectEvent.data === undefined ? {} : { receipt: injectEvent.data })}
        onInject={(input) => injectEvent.mutate(input)}
      />
      <section className="metric-grid" aria-label="Run status metrics">
        <MetricCard
          label="Tick rate"
          value={`${status.data.tickRate.ticksPerSec.toFixed(status.data.tickRate.ticksPerSec % 1 === 0 ? 0 : 1)}/s`}
          detail={runStatus === "running" ? "Engine cadence" : "Paused cadence"}
          icon={<Gauge size={21} />}
          accent="teal"
        />
        <MetricCard
          label="LLM budget"
          value={`${status.data.llm.budgetPct.toFixed(0)}%`}
          detail={`${formatCents(status.data.llm.spend.costCentsEstimate)} spent · ${status.data.llm.mode}`}
          icon={<Bot size={21} />}
          accent="blue"
        />
        <MetricCard
          label="Committed events"
          value={status.data.activity.committedEvents}
          detail={`Through event #${status.data.activity.latestEventSeq}`}
          icon={<GitBranch size={21} />}
          accent="rust"
        />
        <MetricCard
          label="Run guardrail"
          value={scenarioBudget === undefined ? "—" : formatCents(scenarioBudget)}
          detail={`${status.data.errors.last24Ticks} errors in 24 ticks`}
          icon={<Banknote size={21} />}
          accent="green"
        />
      </section>

      {status.data.task === null ? null : (
        <section className="task-banner" aria-label="Advance task">
          <RotateCcw className={status.data.task.status === "running" ? "spin" : ""} size={19} />
          <div>
            <strong>Advance task · {status.data.task.status}</strong>
            <span>{status.data.task.completedTicks} of {status.data.task.targetTick - status.data.task.startTick} ticks processed</span>
          </div>
        </section>
      )}

      <div className="cockpit-grid">
        <section className="indicator-panel" aria-labelledby="indicators-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow"><Activity size={15} /> System signals</p>
              <h2 id="indicators-heading">Indicators</h2>
            </div>
            <span className="live-data-chip">Committed series · through tick {currentTick}</span>
          </div>
          {indicators.isPending ? <LoadingPanel label="Reading committed indicator series…" /> : null}
          {indicators.error === null ? null : (
            <ErrorNotice
              title="Could not load indicators"
              message={errorMessage(indicators.error)}
              onRetry={() => { void indicators.refetch(); }}
            />
          )}
          {indicators.data === undefined ? null : (
            <div className="domain-dashboard-grid">
              <section className="domain-panel" aria-labelledby="macro-panel-heading">
                <div className="domain-panel__heading">
                  <div className="domain-panel__icon domain-panel__icon--finance"><Gauge size={17} /></div>
                  <div><p>Whole economy</p><h3 id="macro-panel-heading">Macro</h3></div>
                </div>
                <div className="sparkline-grid">
                  {MACRO_SERIES.map((name) => {
                    const series = indicators.data.series.find((candidate) => candidate.name === name);
                    if (series === undefined) return null;
                    const presentation = INDICATOR_PRESENTATION[name];
                    return <IndicatorSparkline key={name} series={series} {...presentation} />;
                  })}
                </div>
              </section>
              <section className="domain-panel" aria-labelledby="finance-panel-heading">
                <div className="domain-panel__heading">
                  <div className="domain-panel__icon domain-panel__icon--finance"><Banknote size={17} /></div>
                  <div><p>Financial system</p><h3 id="finance-panel-heading">Finance</h3></div>
                </div>
                <div className="sparkline-grid">
                  {FINANCE_SERIES.map((name) => {
                    const series = indicators.data.series.find((candidate) => candidate.name === name);
                    if (series === undefined) return null;
                    const presentation = INDICATOR_PRESENTATION[name];
                    return <IndicatorSparkline key={name} series={series} {...presentation} />;
                  })}
                </div>
              </section>
              <section className="domain-panel" aria-labelledby="employment-panel-heading">
                <div className="domain-panel__heading">
                  <div className="domain-panel__icon domain-panel__icon--employment"><Activity size={17} /></div>
                  <div><p>Labor market</p><h3 id="employment-panel-heading">Employment</h3></div>
                </div>
                <div className="sparkline-grid">
                  {EMPLOYMENT_SERIES.map((name) => {
                    const series = indicators.data.series.find((candidate) => candidate.name === name);
                    if (series === undefined) return null;
                    const presentation = INDICATOR_PRESENTATION[name];
                    return <IndicatorSparkline key={name} series={series} {...presentation} />;
                  })}
                </div>
              </section>
              <section className="domain-panel" aria-labelledby="business-panel-heading">
                <div className="domain-panel__heading">
                  <div className="domain-panel__icon domain-panel__icon--employment"><Waypoints size={17} /></div>
                  <div><p>Firms and confidence</p><h3 id="business-panel-heading">Business</h3></div>
                </div>
                <div className="sparkline-grid">
                  {BUSINESS_SERIES.map((name) => {
                    const series = indicators.data.series.find((candidate) => candidate.name === name);
                    if (series === undefined) return null;
                    const presentation = INDICATOR_PRESENTATION[name];
                    return <IndicatorSparkline key={name} series={series} {...presentation} />;
                  })}
                </div>
              </section>
            </div>
          )}
          <p className="digest-counts__caption">
            Latest committed tick activity{latestDigest === undefined ? "" : ` · tick ${latestDigest.tick}`}
          </p>
          <dl className="digest-counts">
            <div><dt>Transactions</dt><dd>{latestDigest?.counts.transactions ?? "—"}</dd></div>
            <div><dt>Decisions</dt><dd>{latestDigest?.counts.decisions ?? "—"}</dd></div>
            <div><dt>LLM calls</dt><dd>{latestDigest?.counts.llmCalls ?? "—"}</dd></div>
            <div><dt>Rejected intents</dt><dd>{latestDigest?.counts.rejectedIntents ?? "—"}</dd></div>
          </dl>
        </section>

        <aside className="run-ledger" aria-labelledby="run-details-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow"><BookOpenText size={15} /> Pinned manifest</p>
              <h2 id="run-details-heading">Run details</h2>
            </div>
          </div>
          <dl className="run-details">
            <div><dt>World spec</dt><dd>{String(scenario?.["worldSpec"] ?? "—")}</dd></div>
            <div><dt>Seed</dt><dd>{String(scenario?.["seed"] ?? "—")}</dd></div>
            <div><dt>LLM mode</dt><dd>{status.data.llm.mode}</dd></div>
            <div><dt>Run ID</dt><dd>{runId}</dd></div>
            <div><dt>Scenario version</dt><dd>v{detail.data.simulation.scenarioVersion}</dd></div>
          </dl>
          <div className="causal-note">
            <Waypoints size={21} />
            <div><strong>Every change leaves a thread.</strong><p>Open an event below to inspect its actor, correlation, and payload.</p></div>
          </div>
        </aside>
      </div>

      <section className="event-ledger" aria-labelledby="events-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow"><Radio size={15} /> Durable record</p>
            <h2 id="events-heading">Event ledger</h2>
          </div>
          <button className="button button--quiet" type="button" onClick={() => { void events.refetch(); }}>
            <RotateCcw size={16} /> Refresh
          </button>
        </div>
        {events.isPending ? <LoadingPanel label="Reading committed events…" /> : null}
        {events.error === null ? null : <ErrorNotice message={errorMessage(events.error)} onRetry={() => { void events.refetch(); }} />}
        {events.data?.items.length === 0 ? (
          <div className="ledger-empty"><Clock3 size={20} /> Events will appear after the first command is committed.</div>
        ) : null}
        <div className="event-list">
          {events.data?.items.map((event) => (
            <details className="event-row" key={event.eventId}>
              <summary>
                <span className="event-sequence">#{event.seq}</span>
                <span className="event-symbol" aria-hidden="true" />
                <span className="event-title"><strong>{titleFromType(event.type)}</strong><small>{event.eventId}</small></span>
                <span className="event-actor">{event.actor.kind} · {event.actor.id}</span>
                <span className="event-tick">Tick {event.tick}</span>
              </summary>
              <div className="event-detail">
                <dl>
                  <div><dt>Sim date</dt><dd>{event.simDate}</dd></div>
                  <div><dt>Correlation</dt><dd>{event.correlationId}</dd></div>
                  <div><dt>Causation</dt><dd>{event.causationId ?? "root event"}</dd></div>
                  <div><dt>Wall time</dt><dd>{event.wallTime}</dd></div>
                </dl>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
