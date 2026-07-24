import { useQuery } from "@tanstack/react-query";
import type {
  EvidencePathLane,
  EvidencePathReference,
} from "@worldtangle/shared";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  CircleOff,
  Link2Off,
  Waypoints,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAppSession } from "../app-session";
import { errorMessage } from "../lib/api-client";
import { ErrorNotice, LoadingPanel } from "./ui";

interface EvidencePathProps {
  readonly simulationId: string;
  readonly correlationId: string;
  readonly runId?: string;
  readonly title?: string;
}

const STATE_LABELS: Record<EvidencePathLane["state"], string> = {
  booked: "Booked",
  pending: "Pending",
  no_effect: "No effect observed",
  broken_link: "Broken link",
};

function StateIcon({ state }: { readonly state: EvidencePathLane["state"] }) {
  if (state === "booked") return <CheckCircle2 size={15} />;
  if (state === "pending") return <CircleDashed size={15} />;
  if (state === "no_effect") return <CircleOff size={15} />;
  return <Link2Off size={15} />;
}

function referenceHref(
  simulationId: string,
  reference: EvidencePathReference,
): string {
  switch (reference.kind) {
    case "proposal":
      return `/simulations/${simulationId}/investment-proposals/${reference.id}`;
    case "investment":
      return `/simulations/${simulationId}/investments/${reference.id}`;
    case "cap_table":
      return `/simulations/${simulationId}/companies/${reference.id}/cap-table`;
    case "distribution":
      return `/simulations/${simulationId}/investment-distributions/${reference.id}`;
    case "event":
    case "state":
    case "transaction":
    case "news": {
      const correlation = reference.correlationId ?? reference.id;
      const focusKind = reference.kind === "transaction" ? "transaction" : "event";
      const focusId = reference.kind === "transaction"
        ? reference.id
        : reference.eventId ?? reference.id;
      const params = new URLSearchParams({
        correlation,
        fromTick: String(reference.tick),
        toTick: String(reference.tick),
        focusKind,
        focusId,
      });
      if (reference.kind === "news") params.set("story", reference.id);
      return `/simulations/${simulationId}/explorer?${params.toString()}`;
    }
  }
}

function EvidenceLane({
  simulationId,
  lane,
}: {
  readonly simulationId: string;
  readonly lane: EvidencePathLane;
}) {
  return (
    <section className={`evidence-lane evidence-lane--${lane.state}`}>
      <div className="evidence-lane__heading">
        <span><StateIcon state={lane.state} /> {STATE_LABELS[lane.state]}</span>
        <h3>{lane.label}</h3>
      </div>
      <p>{lane.explanation}</p>
      {lane.items.length === 0 ? (
        <div className="evidence-lane__empty">
          {lane.state === "pending" ? <CircleDashed size={16} /> : <AlertTriangle size={16} />}
          No stored record in this lane.
        </div>
      ) : (
        <ol>
          {lane.items.slice(0, 6).map((reference, index) => (
            <li key={`${reference.kind}:${reference.id}:${reference.eventId ?? index}`}>
              <Link to={referenceHref(simulationId, reference)}>
                <strong>{reference.label}</strong>
                <span>{reference.kind.replaceAll("_", " ")} · tick {reference.tick}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      {lane.items.length > 6 ? (
        <p className="evidence-lane__remainder">
          {lane.items.length - 6} more explicit references are available in the linked records.
        </p>
      ) : null}
    </section>
  );
}

export function EvidencePath({
  simulationId,
  correlationId,
  runId,
  title = "Causal evidence path",
}: EvidencePathProps) {
  const { api, token } = useAppSession();
  const path = useQuery({
    queryKey: ["evidence-path", simulationId, runId, correlationId, token],
    queryFn: ({ signal }) => api.getEvidencePath(
      simulationId,
      correlationId,
      runId,
      signal,
    ),
  });

  return (
    <section className="evidence-path" aria-labelledby="evidence-path-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow"><Waypoints size={15} /> Stored links only</p>
          <h2 id="evidence-path-heading">{title}</h2>
        </div>
        <code>{correlationId}</code>
      </div>
      <p className="evidence-path__boundary">
        A shared correlation is not treated as proof by itself. Each lane shows only explicit
        event, journal, ownership, distribution, or citation references.
      </p>
      {path.isPending ? <LoadingPanel label="Resolving explicit evidence links…" /> : null}
      {path.error === null ? null : (
        <ErrorNotice
          title="Could not resolve this evidence path"
          message={errorMessage(path.error)}
          onRetry={() => { void path.refetch(); }}
        />
      )}
      {path.data === undefined ? null : (
        <div className="evidence-path__lanes">
          <EvidenceLane simulationId={simulationId} lane={path.data.origin} />
          <ArrowRight className="evidence-path__arrow" size={22} aria-hidden="true" />
          <EvidenceLane simulationId={simulationId} lane={path.data.booked} />
          <ArrowRight className="evidence-path__arrow" size={22} aria-hidden="true" />
          <EvidenceLane simulationId={simulationId} lane={path.data.downstream} />
        </div>
      )}
    </section>
  );
}
