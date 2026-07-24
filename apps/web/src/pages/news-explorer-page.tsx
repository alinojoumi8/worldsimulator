import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EventListResponse,
  NewsListResponse,
  NewsStoryDetailResponse,
  ReplayMode,
  ReplayRun,
  SimulationDetailResponse,
  TransactionListResponse,
} from "@worldtangle/shared";
import {
  ArrowLeft,
  BookOpenText,
  GitBranch,
  History,
  Newspaper,
  ReceiptText,
  Search,
  StepBack,
  StepForward,
  Waypoints,
} from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import { EvidencePath } from "../components/evidence-path";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { errorMessage } from "../lib/api-client";

type EventItem = EventListResponse["items"][number];
type SimulationRunItem = SimulationDetailResponse["runs"][number];

export type ExplorerSelection =
  | {
      readonly kind: "event";
      readonly id: string;
      readonly eventId: string;
      readonly correlationId: string;
      readonly label: string;
    }
  | {
      readonly kind: "transaction";
      readonly id: string;
      readonly eventId: string | null;
      readonly correlationId: string;
      readonly label: string;
    };

interface AppliedExplorerFilters {
  readonly type?: string;
  readonly correlationId?: string;
  readonly fromTick?: number;
  readonly toTick?: number;
}

function titleFromType(type: string): string {
  return type
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" / ");
}

function formatCents(value: string): string {
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}$${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function stanceLabel(stance: number): string {
  if (stance < 0) return "cautious";
  if (stance > 0) return "constructive";
  return "neutral";
}

function sentimentPath(
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
): string {
  if (points.length === 0) return "";
  const ticks = points.map(([tick]) => tick);
  const values = points.map(([, value]) => value);
  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  return points.map(([tick, value], index) => {
    const x = maxTick === minTick ? width / 2 : ((tick - minTick) / (maxTick - minTick)) * width;
    const y = maxValue === minValue
      ? height / 2
      : height - ((value - minValue) / (maxValue - minValue)) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

/** Follow immutable causation IDs from the selected outcome back to its root. */
export function buildCauseChain(
  events: readonly EventItem[],
  targetEventId: string | null,
): readonly EventItem[] {
  if (targetEventId === null) return [];
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const chain: EventItem[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = targetEventId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const current = byId.get(currentId);
    if (current === undefined) break;
    chain.unshift(current);
    currentId = current.causationId;
  }
  return chain;
}

export function SentimentSparkline({
  series,
}: {
  readonly series: NewsListResponse["sentiment"][number];
}) {
  const first = series.points[0];
  const last = series.points.at(-1);
  const path = sentimentPath(series.points, 240, 56);
  return (
    <article className="sentiment-card">
      <div>
        <span>{series.topic}</span>
        <strong>{last === undefined ? "No movement" : `${(last[1] / 100).toFixed(2)}%`}</strong>
      </div>
      {last === undefined ? (
        <div className="sentiment-empty">Awaiting a published story</div>
      ) : (
        <svg
          viewBox="0 0 240 56"
          role="img"
          aria-label={`${series.topic} sentiment from tick ${first![0]} through tick ${last[0]}`}
          preserveAspectRatio="none"
        >
          <line x1="0" y1="28" x2="240" y2="28" />
          <path d={path} />
        </svg>
      )}
      <small>{series.points.length} authoritative updates</small>
    </article>
  );
}

export function NewsFeed({
  news,
  selectedStoryId,
  detail,
  detailPending = false,
  onOpenStory,
  onTraceEvent,
}: {
  readonly news: NewsListResponse;
  readonly selectedStoryId?: string;
  readonly detail?: NewsStoryDetailResponse;
  readonly detailPending?: boolean;
  readonly onOpenStory: (storyId: string) => void;
  readonly onTraceEvent: (eventId: string, correlationId: string, label: string) => void;
}) {
  return (
    <section className="newsroom-panel" aria-labelledby="news-feed-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"><Newspaper size={15} /> Cited public record</p>
          <h2 id="news-feed-heading">Riverbend news</h2>
        </div>
        <span>{news.items.length} published stories</span>
      </div>
      <div className="sentiment-grid">
        {news.sentiment.map((series) => <SentimentSparkline key={series.topic} series={series} />)}
      </div>
      {news.items.length === 0 ? (
        <div className="news-empty"><Newspaper size={22} /> The newsroom has not published yet.</div>
      ) : (
        <div className="story-grid">
          {news.items.map((story) => (
            <article className="story-card" key={story.id} data-selected={story.id === selectedStoryId}>
              <header>
                <span className="kind-chip">{story.topic}</span>
                <span>Tick {story.tick}</span>
              </header>
              <h3>{story.headline}</h3>
              <p>{story.org.name} / {story.author.name}</p>
              <dl>
                <div><dt>Stance</dt><dd>{stanceLabel(story.stance)}</dd></div>
                <div><dt>Reach</dt><dd>{story.reach}</dd></div>
                <div><dt>Citations</dt><dd>{story.citedEventIds.length}</dd></div>
              </dl>
              <button
                className="button button--secondary"
                type="button"
                aria-expanded={story.id === selectedStoryId}
                onClick={() => onOpenStory(story.id)}
              >
                <Waypoints size={15} /> Why this story?
              </button>
            </article>
          ))}
        </div>
      )}
      {detailPending ? <LoadingPanel label="Following the story citations..." /> : null}
      {detail === undefined || detail.story.id !== selectedStoryId ? null : (
        <article className="story-why" aria-labelledby="story-why-heading">
          <div className="story-why__copy">
            <p className="eyebrow"><BookOpenText size={15} /> Engine-authored, cited copy</p>
            <h3 id="story-why-heading">{detail.story.headline}</h3>
            <p data-testid="story-body">{detail.story.body}</p>
            <small>
              Decision {detail.story.decisionId}
              {detail.story.llmCallId === undefined ? " / deterministic template" : ` / call ${detail.story.llmCallId}`}
            </small>
          </div>
          <div className="story-evidence">
            <h4>Source events</h4>
            {detail.citedEvents.map((event) => (
              <div key={event.eventId}>
                <span><strong>{titleFromType(event.eventType)}</strong><small>Tick {event.tick}</small></span>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => onTraceEvent(event.eventId, event.correlationId, event.eventType)}
                >
                  Trace {event.eventId}
                </button>
              </div>
            ))}
            <h4>Sentiment effect</h4>
            {detail.sentimentImpact.length === 0 ? <p>No public sentiment delta.</p> : (
              detail.sentimentImpact.map((impact) => (
                <div key={`${impact.topic}-${impact.sourceEventId}`}>
                  <span><strong>{impact.topic}</strong><small>{impact.sourceEventId}</small></span>
                  <b>{impact.delta > 0 ? "+" : ""}{impact.delta} bp</b>
                </div>
              ))
            )}
          </div>
        </article>
      )}
    </section>
  );
}

function CauseChainPanel({
  selection,
  events,
  pending,
}: {
  readonly selection?: ExplorerSelection;
  readonly events: readonly EventItem[];
  readonly pending: boolean;
}) {
  const chain = buildCauseChain(events, selection?.eventId ?? null);
  const first = chain[0];
  const missingParent = first?.causationId !== undefined &&
    !events.some((event) => event.eventId === first.causationId);
  return (
    <aside className="cause-panel" aria-labelledby="cause-heading" aria-live="polite">
      <div className="panel-heading">
        <div><p className="eyebrow"><Waypoints size={15} /> Stored causation</p><h3 id="cause-heading">What caused this?</h3></div>
      </div>
      {selection === undefined ? (
        <p className="cause-empty">Choose Why? on an event or transaction to follow its causal thread.</p>
      ) : pending ? <LoadingPanel label="Following causation IDs..." /> : selection.eventId === null ? (
        <p className="cause-empty">This posting has no source event. Its correlation remains {selection.correlationId}.</p>
      ) : chain.length === 0 ? (
        <p className="cause-empty">The selected event is outside this bounded correlation page.</p>
      ) : (
        <>
          <p className="cause-selection"><strong>{selection.label}</strong><code>{selection.id}</code></p>
          <ol className="cause-chain">
            {chain.map((event, index) => (
              <li key={event.eventId} data-target={event.eventId === selection.eventId}>
                <span>{index + 1}</span>
                <div>
                  <strong>{titleFromType(event.type)}</strong>
                  <small>Tick {event.tick} / {event.actor.kind} {event.actor.id}</small>
                  <code>{event.eventId}</code>
                </div>
              </li>
            ))}
          </ol>
          {missingParent ? <p className="cause-warning">An earlier parent falls outside the 200-event view.</p> : null}
        </>
      )}
    </aside>
  );
}

export function CausalityExplorer({
  events,
  transactions,
  selection,
  causeEvents = [],
  causePending = false,
  onSelect,
}: {
  readonly events: EventListResponse;
  readonly transactions: TransactionListResponse;
  readonly selection?: ExplorerSelection;
  readonly causeEvents?: readonly EventItem[];
  readonly causePending?: boolean;
  readonly onSelect: (selection: ExplorerSelection) => void;
}) {
  const [tab, setTab] = useState<"events" | "transactions">(
    selection?.kind === "transaction" ? "transactions" : "events",
  );
  useEffect(() => {
    if (selection !== undefined) setTab(selection.kind === "transaction" ? "transactions" : "events");
  }, [selection]);
  return (
    <section className="explorer-panel" aria-labelledby="causality-explorer-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"><GitBranch size={15} /> Immutable evidence</p>
          <h2 id="causality-explorer-heading">Event and transaction explorer</h2>
        </div>
        <div className="explorer-tabs" role="tablist" aria-label="Ledger kind">
          <button type="button" role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>Events</button>
          <button type="button" role="tab" aria-selected={tab === "transactions"} onClick={() => setTab("transactions")}>Transactions</button>
        </div>
      </div>
      <div className="causality-layout">
        <div className="causal-records">
          {tab === "events" ? events.items.map((event) => (
            <article key={event.eventId} data-selected={selection?.id === event.eventId}>
              <span className="record-seq">#{event.seq}</span>
              <div><strong>{titleFromType(event.type)}</strong><small>{event.actor.kind} {event.actor.id} / tick {event.tick}</small><code>{event.eventId}</code></div>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => onSelect({
                  kind: "event",
                  id: event.eventId,
                  eventId: event.eventId,
                  correlationId: event.correlationId,
                  label: event.type,
                })}
              >Why?</button>
              <details><summary>Evidence</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>
            </article>
          )) : transactions.items.map((transaction) => (
            <article key={transaction.id} data-selected={selection?.id === transaction.id}>
              <ReceiptText className="record-seq" size={17} />
              <div><strong>{titleFromType(transaction.kind)}</strong><small>Tick {transaction.tick} / {formatCents(transaction.legs.filter((leg) => leg.direction === "debit").reduce((sum, leg) => sum + BigInt(leg.amount), 0n).toString())}</small><code>{transaction.id}</code></div>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => onSelect({
                  kind: "transaction",
                  id: transaction.id,
                  eventId: transaction.sourceEventId,
                  correlationId: transaction.correlationId,
                  label: transaction.kind,
                })}
              >Why?</button>
              <details><summary>Balanced legs</summary><ul>{transaction.legs.map((leg) => <li key={`${transaction.id}-${leg.accountId}-${leg.direction}`}><span>{leg.direction} {leg.owner.name}</span><strong>{formatCents(leg.amount)}</strong></li>)}</ul></details>
            </article>
          ))}
          {(tab === "events" ? events.items : transactions.items).length === 0 ? (
            <p className="cause-empty">No records match the current filters.</p>
          ) : null}
        </div>
        <CauseChainPanel selection={selection} events={causeEvents} pending={causePending} />
      </div>
    </section>
  );
}

export function ReplayStepper({
  runs,
  activeReplay,
  pending,
  failure,
  onStart,
}: {
  readonly runs: readonly SimulationRunItem[];
  readonly activeReplay?: ReplayRun | null;
  readonly pending: boolean;
  readonly failure?: string;
  readonly onStart: (sourceRunId: string, toTick: number, mode: ReplayMode) => void;
}) {
  const terminalRuns = useMemo(
    () => runs.filter((run) => ["completed", "stopped", "failed"].includes(run.status)),
    [runs],
  );
  const [sourceRunId, setSourceRunId] = useState(terminalRuns[0]?.id ?? "");
  const source = terminalRuns.find((run) => run.id === sourceRunId) ?? terminalRuns[0];
  const [targetTick, setTargetTick] = useState(source?.currentTick ?? 0);
  const [mode, setMode] = useState<ReplayMode>("strict");
  useEffect(() => {
    if (sourceRunId.length === 0 && terminalRuns[0] !== undefined) {
      setSourceRunId(terminalRuns[0].id);
    }
  }, [sourceRunId, terminalRuns]);
  useEffect(() => {
    if (source !== undefined) setTargetTick(source.currentTick);
  }, [source?.id, source?.currentTick]);
  const maxTick = source?.currentTick ?? 0;
  const replayRunning = activeReplay?.status === "running";
  return (
    <section className="replay-panel" aria-labelledby="replay-heading">
      <div className="panel-heading">
        <div><p className="eyebrow"><History size={15} /> Cache-only execution</p><h2 id="replay-heading">Replay stepper</h2></div>
        {activeReplay === undefined || activeReplay === null ? null : <StatusPill status={activeReplay.status} />}
      </div>
      {terminalRuns.length === 0 ? (
        <p className="cause-empty">Complete or stop a source run before starting replay.</p>
      ) : (
        <div className="replay-controls">
          <label>Source run<select value={source?.id ?? ""} disabled={pending || replayRunning} onChange={(event) => setSourceRunId(event.target.value)}>{terminalRuns.map((run) => <option key={run.id} value={run.id}>{run.id} / {run.status} / tick {run.currentTick}</option>)}</select></label>
          <label>Mode<select value={mode} disabled={pending || replayRunning} onChange={(event) => setMode(event.target.value as ReplayMode)}><option value="strict">Strict: stop at first divergence</option><option value="observe">Observe: record and continue</option></select></label>
          <label>Target tick<div className="tick-stepper"><button type="button" aria-label="Previous target tick" disabled={targetTick <= 0 || pending || replayRunning} onClick={() => setTargetTick((tick) => Math.max(0, tick - 1))}><StepBack size={16} /></button><input aria-label="Replay target tick" type="number" min={0} max={maxTick} value={targetTick} disabled={pending || replayRunning} onChange={(event) => setTargetTick(Math.max(0, Math.min(maxTick, Number(event.target.value))))} /><button type="button" aria-label="Next target tick" disabled={targetTick >= maxTick || pending || replayRunning} onClick={() => setTargetTick((tick) => Math.min(maxTick, tick + 1))}><StepForward size={16} /></button></div></label>
          <button className="button button--primary" type="button" disabled={source === undefined || pending || replayRunning} onClick={() => { if (source !== undefined) onStart(source.id, targetTick, mode); }}><History size={16} /> {pending ? "Starting replay..." : `Start ${mode} replay`}</button>
        </div>
      )}
      {failure === undefined ? null : <ErrorNotice title="Replay could not start" message={failure} />}
      {activeReplay === undefined || activeReplay === null ? null : (
        <div className="replay-progress">
          <div><strong>{activeReplay.currentTick} / {activeReplay.toTick} ticks</strong><span>{activeReplay.lastComparedSeq + 1} event prefixes compared</span></div>
          <div role="progressbar" aria-label="Replay progress" aria-valuemin={0} aria-valuemax={Math.max(1, activeReplay.toTick)} aria-valuenow={activeReplay.currentTick}><span style={{ width: `${activeReplay.toTick === 0 ? 100 : (activeReplay.currentTick / activeReplay.toTick) * 100}%` }} /></div>
          <dl><div><dt>Source</dt><dd>{activeReplay.replayOf}</dd></div><div><dt>Replay run</dt><dd>{activeReplay.id}</dd></div><div><dt>Divergences</dt><dd>{activeReplay.divergenceCount}</dd></div></dl>
          {activeReplay.firstDivergence === null ? <p className="replay-clean">No divergence recorded through the current boundary.</p> : <details><summary>First divergence / {activeReplay.firstDivergence.kind}</summary><dl><div><dt>Tick</dt><dd>{activeReplay.firstDivergence.tick}</dd></div><div><dt>Sequence</dt><dd>{activeReplay.firstDivergence.sequence}</dd></div><div><dt>Expected</dt><dd>{activeReplay.firstDivergence.expectedHash ?? "none"}</dd></div><div><dt>Actual</dt><dd>{activeReplay.firstDivergence.actualHash ?? "none"}</dd></div></dl></details>}
        </div>
      )}
    </section>
  );
}

function optionalTick(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function NewsExplorerPage() {
  const simulationId = useParams().simId ?? "invalid";
  const [searchParams] = useSearchParams();
  const routeCorrelation = searchParams.get("correlation")?.trim() ?? "";
  const routeFromTick = searchParams.get("fromTick")?.trim() ?? "";
  const routeToTick = searchParams.get("toTick")?.trim() ?? "";
  const routeFocusKind = searchParams.get("focusKind") === "transaction"
    ? "transaction"
    : "event";
  const routeFocusId = searchParams.get("focusId")?.trim() ?? "";
  const routeStoryId = searchParams.get("story")?.trim() ?? "";
  const initialFromTick = optionalTick(routeFromTick);
  const initialToTick = optionalTick(routeToTick);
  const { api, token } = useAppSession();
  const queryClient = useQueryClient();
  const appliedRouteFocus = useRef("");
  const [selectedStoryId, setSelectedStoryId] = useState<string | undefined>(
    routeStoryId.length === 0 ? undefined : routeStoryId,
  );
  const [selection, setSelection] = useState<ExplorerSelection>();
  const [activeReplayId, setActiveReplayId] = useState<string>();
  const [typeDraft, setTypeDraft] = useState("");
  const [correlationDraft, setCorrelationDraft] = useState(routeCorrelation);
  const [fromDraft, setFromDraft] = useState(routeFromTick);
  const [toDraft, setToDraft] = useState(routeToTick);
  const [filterFailure, setFilterFailure] = useState<string>();
  const [filters, setFilters] = useState<AppliedExplorerFilters>({
    ...(routeCorrelation.length === 0 ? {} : { correlationId: routeCorrelation }),
    ...(initialFromTick === undefined ? {} : { fromTick: initialFromTick }),
    ...(initialToTick === undefined ? {} : { toTick: initialToTick }),
  });

  useEffect(() => {
    const fromTick = optionalTick(routeFromTick);
    const toTick = optionalTick(routeToTick);
    setCorrelationDraft(routeCorrelation);
    setFromDraft(routeFromTick);
    setToDraft(routeToTick);
    setFilters({
      ...(routeCorrelation.length === 0 ? {} : { correlationId: routeCorrelation }),
      ...(fromTick === undefined ? {} : { fromTick }),
      ...(toTick === undefined ? {} : { toTick }),
    });
    setSelectedStoryId(routeStoryId.length === 0 ? undefined : routeStoryId);
    setSelection(undefined);
    appliedRouteFocus.current = "";
  }, [routeCorrelation, routeFromTick, routeStoryId, routeToTick]);

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
  const news = useQuery({
    queryKey: ["news", simulationId, runId, token],
    queryFn: ({ signal }) => api.listNews(simulationId, runId, signal, { limit: 50 }),
    enabled: runId !== undefined,
  });
  const story = useQuery({
    queryKey: ["news-story", simulationId, runId, selectedStoryId, token],
    queryFn: ({ signal }) => api.getNewsStory(simulationId, selectedStoryId!, runId, signal),
    enabled: runId !== undefined && selectedStoryId !== undefined,
  });
  const events = useQuery({
    queryKey: ["explorer-events", simulationId, runId, filters, token],
    queryFn: ({ signal }) => api.listEvents(simulationId, runId, signal, { limit: 100, ...filters }),
    enabled: runId !== undefined,
  });
  const transactions = useQuery({
    queryKey: ["explorer-transactions", simulationId, runId, filters, token],
    queryFn: ({ signal }) => api.listTransactions(simulationId, runId, signal, {
      limit: 100,
      ...(filters.correlationId === undefined ? {} : { correlationId: filters.correlationId }),
      ...(filters.fromTick === undefined ? {} : { fromTick: filters.fromTick }),
      ...(filters.toTick === undefined ? {} : { toTick: filters.toTick }),
    }),
    enabled: runId !== undefined,
  });
  useEffect(() => {
    if (routeFocusId.length === 0) return;
    const routeKey = `${routeFocusKind}:${routeFocusId}`;
    if (appliedRouteFocus.current === routeKey) return;
    if (routeFocusKind === "transaction") {
      const transaction = transactions.data?.items.find((item) => item.id === routeFocusId);
      if (transaction === undefined) return;
      setSelection({
        kind: "transaction",
        id: transaction.id,
        eventId: transaction.sourceEventId,
        correlationId: transaction.correlationId,
        label: transaction.kind,
      });
    } else {
      const event = events.data?.items.find((item) => item.eventId === routeFocusId);
      if (event === undefined) return;
      setSelection({
        kind: "event",
        id: event.eventId,
        eventId: event.eventId,
        correlationId: event.correlationId,
        label: event.type,
      });
    }
    appliedRouteFocus.current = routeKey;
  }, [
    events.data?.items,
    routeFocusId,
    routeFocusKind,
    transactions.data?.items,
  ]);
  const causeEvents = useQuery({
    queryKey: ["cause-events", simulationId, runId, selection?.correlationId, token],
    queryFn: ({ signal }) => api.listEvents(simulationId, runId, signal, {
      limit: 200,
      correlationId: selection!.correlationId,
    }),
    enabled: runId !== undefined && selection !== undefined,
  });
  const replay = useMutation({
    mutationFn: (input: { readonly sourceRunId: string; readonly toTick: number; readonly mode: ReplayMode }) =>
      api.replaySimulation(simulationId, input.sourceRunId, {
        toTick: input.toTick,
        mode: input.mode,
      }),
    onSuccess: (response) => {
      setActiveReplayId(response.replayRun.id);
      void queryClient.invalidateQueries({ queryKey: ["simulation", simulationId] });
    },
  });
  const replayStatus = useQuery({
    queryKey: ["replay-status", simulationId, activeReplayId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, activeReplayId, signal),
    enabled: activeReplayId !== undefined,
    refetchInterval: (query) => query.state.data?.replay?.status === "running" ? 500 : false,
  });

  if (detail.isPending || status.isPending) {
    return <div className="news-explorer-page"><LoadingPanel label="Opening the public record..." /></div>;
  }
  if (detail.error !== null || status.error !== null) {
    return <div className="news-explorer-page"><ErrorNotice message={errorMessage(detail.error ?? status.error)} onRetry={() => { void Promise.all([detail.refetch(), status.refetch()]); }} /></div>;
  }

  const applyFilters = (): void => {
    const fromTick = optionalTick(fromDraft);
    const toTick = optionalTick(toDraft);
    if ((fromDraft.length > 0 && fromTick === undefined) || (toDraft.length > 0 && toTick === undefined)) {
      setFilterFailure("Ticks must be nonnegative whole numbers.");
      return;
    }
    if (fromTick !== undefined && toTick !== undefined && fromTick > toTick) {
      setFilterFailure("The ending tick must not precede the starting tick.");
      return;
    }
    setFilterFailure(undefined);
    setFilters({
      ...(typeDraft.trim().length === 0 ? {} : { type: typeDraft.trim() }),
      ...(correlationDraft.trim().length === 0 ? {} : { correlationId: correlationDraft.trim() }),
      ...(fromTick === undefined ? {} : { fromTick }),
      ...(toTick === undefined ? {} : { toTick }),
    });
    setSelection(undefined);
  };
  const emptyEvents: EventListResponse = { items: [], nextCursor: null, meta: { simulated: true, apiVersion: 1 } };
  const emptyTransactions: TransactionListResponse = { items: [], nextCursor: null, meta: { simulated: true, apiVersion: 1 } };
  const activeReplay = replayStatus.data?.replay ?? replay.data?.replayRun ?? null;
  const evidenceCorrelation = selection?.correlationId ?? filters.correlationId;

  return (
    <div className="news-explorer-page">
      <div className="explorer-breadcrumb"><Link to={`/simulations/${simulationId}`}><ArrowLeft size={17} /> Simulation cockpit</Link></div>
      <header className="news-explorer-header">
        <div><p className="eyebrow"><Waypoints size={16} /> Public record and replay</p><h1>Follow every thread.</h1><p>Read cited stories, inspect balanced postings, follow stored causation IDs, and replay a terminal run without live provider calls.</p></div>
        <dl><div><dt>Run</dt><dd>{runId}</dd></div><div><dt>Tick</dt><dd>{status.data.run.currentTick}</dd></div><div><dt>Status</dt><dd><StatusPill status={status.data.run.status} /></dd></div></dl>
      </header>

      {news.isPending ? <LoadingPanel label="Reading published stories..." /> : null}
      {news.error === null ? null : <ErrorNotice title="News feed unavailable" message={errorMessage(news.error)} onRetry={() => { void news.refetch(); }} />}
      {story.error === null ? null : <ErrorNotice title="Story evidence unavailable" message={errorMessage(story.error)} onRetry={() => { void story.refetch(); }} />}
      {news.data === undefined ? null : <NewsFeed news={news.data} selectedStoryId={selectedStoryId} detail={story.data} detailPending={story.isPending && selectedStoryId !== undefined} onOpenStory={(storyId) => setSelectedStoryId((current) => current === storyId ? undefined : storyId)} onTraceEvent={(eventId, correlationId, label) => { setSelection({ kind: "event", id: eventId, eventId, correlationId, label }); document.getElementById("causality-explorer-heading")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />}

      <form className="explorer-filter-bar" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <div><Search size={17} /><strong>Filter durable records</strong></div>
        <label>Event type<input value={typeDraft} placeholder="loan.approved" onChange={(event) => setTypeDraft(event.target.value)} /></label>
        <label>Correlation<input value={correlationDraft} placeholder="workflow ID" onChange={(event) => setCorrelationDraft(event.target.value)} /></label>
        <label>From tick<input inputMode="numeric" value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} /></label>
        <label>To tick<input inputMode="numeric" value={toDraft} onChange={(event) => setToDraft(event.target.value)} /></label>
        <button className="button button--secondary" type="submit">Apply filters</button>
        {filterFailure === undefined ? null : <p role="alert">{filterFailure}</p>}
      </form>

      {events.error === null && transactions.error === null ? null : <ErrorNotice title="Explorer read failed" message={errorMessage(events.error ?? transactions.error)} onRetry={() => { void Promise.all([events.refetch(), transactions.refetch()]); }} />}
      <CausalityExplorer events={events.data ?? emptyEvents} transactions={transactions.data ?? emptyTransactions} selection={selection} causeEvents={causeEvents.data?.items ?? []} causePending={causeEvents.isPending && selection !== undefined} onSelect={setSelection} />
      {evidenceCorrelation === undefined || runId === undefined ? null : (
        <EvidencePath
          simulationId={simulationId}
          correlationId={evidenceCorrelation}
          runId={runId}
          title="Selected record evidence"
        />
      )}
      <ReplayStepper runs={detail.data.runs} activeReplay={activeReplay} pending={replay.isPending} failure={replay.error === null ? undefined : errorMessage(replay.error)} onStart={(sourceRunId, toTick, mode) => replay.mutate({ sourceRunId, toTick, mode })} />
    </div>
  );
}
