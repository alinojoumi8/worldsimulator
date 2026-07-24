import { useMemo, useState } from "react";
import type { EventListResponse } from "@worldtangle/shared";
import {
  CheckCircle2,
  Clipboard,
  CircleDashed,
  ExternalLink,
  Route,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";

type RunEvent = EventListResponse["items"][number];

interface RunHandoffProps {
  readonly simulationId: string;
  readonly runId?: string;
  readonly runStatus?: string;
  readonly mode: string;
  readonly seed: string;
  readonly currentTick: number;
  readonly endTick: number;
  readonly latestEventSeq?: number;
  readonly events: readonly RunEvent[];
  readonly cpiObserved: boolean;
  readonly guided: boolean;
}

interface WorldEventThread {
  readonly injected?: RunEvent;
  readonly applied?: RunEvent;
  readonly effects: readonly RunEvent[];
  readonly worldEventId?: string;
  readonly interventionType?: string;
  readonly catalogVersion?: number;
}

function payloadRecord(event: RunEvent | undefined): Record<string, unknown> {
  return typeof event?.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
}

function latestWorldEventThread(events: readonly RunEvent[]): WorldEventThread {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const injected = ordered.filter((event) => event.type === "world.event.injected").at(-1);
  if (injected === undefined) return { effects: [] };
  const injectedPayload = payloadRecord(injected);
  const worldEventId = typeof injectedPayload["worldEventId"] === "string"
    ? injectedPayload["worldEventId"]
    : undefined;
  const applied = ordered.find((event) => {
    if (event.type !== "world.event.applied") return false;
    return worldEventId !== undefined &&
      payloadRecord(event)["worldEventId"] === worldEventId;
  });
  const effects = applied === undefined
    ? []
    : ordered.filter((event) => (
      event.causationId === applied.eventId
    ));
  return {
    injected,
    applied,
    effects,
    ...(worldEventId === undefined ? {} : { worldEventId }),
    ...(typeof injectedPayload["type"] === "string"
      ? { interventionType: injectedPayload["type"] }
      : {}),
    ...(typeof injectedPayload["catalogVersion"] === "number"
      ? { catalogVersion: injectedPayload["catalogVersion"] }
      : {}),
  };
}

function milestone(
  runStatus: string | undefined,
  thread: WorldEventThread,
  cpiObserved: boolean,
  guided: boolean,
): string {
  if (!guided && thread.injected === undefined) {
    if (runStatus === "created") return "Start the run when the world is configured";
    if (runStatus === "running") return "Pause at a useful checkpoint to inspect durable evidence";
    if (runStatus === "paused") return "Resume the run or inspect the current world";
    if (runStatus === "completed") return "Review the completed world's evidence";
    if (runStatus === "failed") return "Inspect the runtime error before continuing";
    return "Review the committed world state";
  }
  if (thread.injected === undefined) return "Schedule the approved intervention";
  if (thread.applied === undefined) {
    return runStatus === "created"
      ? "Start the run so the scheduled shock can apply"
      : "Wait for the shock to reach its committed tick";
  }
  if (!cpiObserved) return "Observe the first post-shock CPI point";
  return "Open the causal record and copy the receipt";
}

function safeAction(
  simulationId: string,
  runStatus: string | undefined,
  thread: WorldEventThread,
  cpiObserved: boolean,
  guided: boolean,
): { readonly label: string; readonly href: string; readonly route: boolean } {
  if (!guided && thread.injected === undefined) {
    if (runStatus === "created") {
      return { label: "Start the run", href: "#run-controls", route: false };
    }
    if (runStatus === "running") {
      return { label: "Pause at a checkpoint", href: "#run-controls", route: false };
    }
    if (runStatus === "paused") {
      return { label: "Resume the run", href: "#run-controls", route: false };
    }
    if (runStatus === "failed") {
      return {
        label: "Inspect runtime errors",
        href: `/simulations/${simulationId}/observability`,
        route: true,
      };
    }
    return {
      label: "Explore the completed world",
      href: `/simulations/${simulationId}/world/companies`,
      route: true,
    };
  }
  if (thread.injected === undefined) {
    return { label: "Schedule the 30% fuel shock", href: "#intervention", route: false };
  }
  if (runStatus === "created") {
    return { label: "Start the deterministic run", href: "#run-controls", route: false };
  }
  if (thread.applied === undefined && runStatus === "paused") {
    return { label: "Resume to apply the shock", href: "#run-controls", route: false };
  }
  if (thread.applied === undefined) {
    return { label: "Pause when the shock is applied", href: "#run-controls", route: false };
  }
  if (!cpiObserved && runStatus === "paused") {
    return { label: "Resume to observe CPI", href: "#run-controls", route: false };
  }
  if (runStatus === "running") {
    return { label: "Pause and inspect the result", href: "#run-controls", route: false };
  }
  const correlation = encodeURIComponent(thread.applied.correlationId);
  return {
    label: "Open the causal record",
    href: `/simulations/${simulationId}/explorer?correlation=${correlation}`,
    route: true,
  };
}

function receiptText({
  simulationId,
  runId,
  mode,
  seed,
  currentTick,
  endTick,
  latestEventSeq,
  thread,
}: {
  readonly simulationId: string;
  readonly runId?: string;
  readonly mode: string;
  readonly seed: string;
  readonly currentTick: number;
  readonly endTick: number;
  readonly latestEventSeq?: number;
  readonly thread: WorldEventThread;
}): string {
  const causalEvents = [thread.injected, thread.applied, ...thread.effects]
    .filter((event): event is RunEvent => event !== undefined);
  const firstSeq = causalEvents.length === 0
    ? "not-yet-recorded"
    : String(Math.min(...causalEvents.map((event) => event.seq)));
  const lastSeq = causalEvents.length === 0
    ? "not-yet-recorded"
    : String(Math.max(...causalEvents.map((event) => event.seq)));
  const replayTick = Math.min(currentTick, endTick);
  return [
    "WorldTangle reproducibility receipt",
    "Evidence: simulated scenario; not a real-world prediction",
    `Simulation: ${simulationId}`,
    `Run: ${runId ?? "not-created"}`,
    `Mode: ${mode}`,
    `Seed: ${seed}`,
    `Intervention: ${thread.interventionType ?? "not-scheduled"}`,
    `Intervention ID: ${thread.worldEventId ?? "not-scheduled"}`,
    `Catalog version: ${thread.catalogVersion ?? "not-recorded"}`,
    `Tick range: 0-${replayTick} (configured end ${endTick})`,
    `Causal event range: ${firstSeq}-${lastSeq}`,
    `Latest committed event: ${latestEventSeq ?? "none"}`,
    `Replay: open /simulations/${simulationId}/explorer and replay run ${runId ?? "unknown"} to tick ${replayTick} in exact mode.`,
  ].join("\n");
}

export function RunHandoff(props: RunHandoffProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const thread = useMemo(() => latestWorldEventThread(props.events), [props.events]);
  const nextAction = safeAction(
    props.simulationId,
    props.runStatus,
    thread,
    props.cpiObserved,
    props.guided,
  );
  const receipt = receiptText({ ...props, thread });

  const copyReceipt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(receipt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section
      className={`run-handoff${props.guided ? " run-handoff--guided" : ""}`}
      aria-labelledby="run-handoff-heading"
    >
      <div className="run-handoff__identity">
        <p className="eyebrow"><Route size={15} /> {props.guided ? "Guided causal test" : "Run handoff"}</p>
        <h2 id="run-handoff-heading">Keep hold of the causal thread.</h2>
        <div className="run-handoff__badges">
          <span><ShieldCheck size={14} /> {props.mode} · simulated</span>
          <span>Tick {props.currentTick} of {props.endTick}</span>
          <span>
            Last intervention · {thread.interventionType ?? "none"}
            {thread.worldEventId === undefined ? "" : ` · ${thread.worldEventId}`}
          </span>
        </div>
      </div>
      <div className="run-handoff__milestone">
        <span>Unresolved milestone</span>
        <strong>{milestone(
          props.runStatus,
          thread,
          props.cpiObserved,
          props.guided,
        )}</strong>
        {nextAction.route ? (
          <Link className="button button--primary" to={nextAction.href}>
            {nextAction.label} <ExternalLink size={15} />
          </Link>
        ) : (
          <a className="button button--primary" href={nextAction.href}>{nextAction.label}</a>
        )}
      </div>
      {props.guided || thread.injected !== undefined ? (
        <div className="run-handoff__evidence" aria-label="Guided evidence progress">
          <span className={thread.injected === undefined ? "pending" : "booked"}>
            {thread.injected === undefined ? <CircleDashed size={15} /> : <CheckCircle2 size={15} />}
            Intervention {thread.injected === undefined ? "pending" : "booked"}
          </span>
          <span className={thread.applied === undefined ? "pending" : "booked"}>
            {thread.applied === undefined ? <CircleDashed size={15} /> : <CheckCircle2 size={15} />}
            State effect {thread.applied === undefined ? "pending" : "booked"}
          </span>
          <span className={props.cpiObserved ? "booked" : "pending"}>
            {props.cpiObserved ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
            CPI observation {props.cpiObserved ? "booked" : "pending"}
          </span>
        </div>
      ) : (
        <div className="run-handoff__evidence" aria-label="Run evidence progress">
          <span className={props.runStatus === "completed" ? "booked" : "pending"}>
            {props.runStatus === "completed"
              ? <CheckCircle2 size={15} />
              : <CircleDashed size={15} />}
            Run {props.runStatus ?? "loading"}
          </span>
          <span className="neutral"><CircleDashed size={15} /> No intervention scheduled</span>
          <span className={props.latestEventSeq === undefined ? "pending" : "booked"}>
            {props.latestEventSeq === undefined
              ? <CircleDashed size={15} />
              : <CheckCircle2 size={15} />}
            Durable event ledger {props.latestEventSeq === undefined ? "pending" : "booked"}
          </span>
        </div>
      )}
      <div className="run-handoff__receipt">
        <button className="button button--secondary" type="button" onClick={() => { void copyReceipt(); }}>
          <Clipboard size={16} /> Copy reproducibility receipt
        </button>
        <span role="status">
          {copyState === "copied"
            ? "Receipt copied."
            : copyState === "failed"
              ? "Clipboard unavailable; use the causal record."
              : "Includes seed, mode, intervention, ticks, events, and replay steps."}
        </span>
      </div>
    </section>
  );
}
