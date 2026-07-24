/** Read-only causal evidence resolver. It reports stored links and never infers causation. */

import {
  evidencePathResponseSchema,
  type EvidencePathLane,
  type EvidencePathReference,
  type EvidencePathResponse,
} from "@worldtangle/shared";
import { toSafeNumber, type WorldDatabase } from "./database";

interface RunRow {
  readonly status: string;
}

interface EventRow {
  readonly event_id: string;
  readonly seq: bigint;
  readonly tick: bigint;
  readonly type: string;
  readonly correlation_id: string;
}

interface LedgerRow {
  readonly id: string;
  readonly tick: bigint;
  readonly kind: string;
  readonly reason: string;
  readonly source_event_id: string | null;
  readonly correlation_id: string;
}

interface DomainStateRow {
  readonly id: string;
  readonly tick: bigint;
  readonly label: string;
  readonly source_event_id: string;
  readonly correlation_id: string;
}

interface StakeRow {
  readonly id: string;
  readonly company_id: string;
  readonly since_tick: bigint;
  readonly source_event_id: string | null;
  readonly correlation_id: string | null;
}

interface ProposalRow {
  readonly id: string;
  readonly proposed_tick: bigint;
  readonly status: string;
  readonly source_event_id: string;
  readonly correlation_id: string;
}

interface InvestmentRow {
  readonly id: string;
  readonly completed_tick: bigint;
  readonly source_event_id: string;
  readonly correlation_id: string;
}

interface DistributionRow {
  readonly id: string;
  readonly distributed_tick: bigint;
  readonly source_event_id: string;
  readonly correlation_id: string;
}

interface NewsRow {
  readonly id: string;
  readonly tick: bigint;
  readonly source_event_id: string;
  readonly correlation_id: string;
}

type EvidencePath = Omit<EvidencePathResponse, "meta">;

function titleFromType(type: string): string {
  return type.split(".")
    .map((part) => part.replaceAll("_", " "))
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" · ");
}

function shortLabel(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedReferences(
  items: readonly EvidencePathReference[],
): EvidencePathReference[] {
  return [...items]
    .sort((left, right) => (
      left.tick - right.tick ||
      compareCodeUnit(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`)
    ))
    .slice(0, 200);
}

function eventReference(row: EventRow): EvidencePathReference {
  return {
    kind: "event",
    id: row.event_id,
    label: titleFromType(row.type),
    tick: toSafeNumber(row.tick, "evidence event tick"),
    eventId: row.event_id,
    correlationId: row.correlation_id,
  };
}

function lane(
  state: EvidencePathLane["state"],
  label: string,
  explanation: string,
  items: readonly EvidencePathReference[],
): EvidencePathLane {
  return { state, label, explanation, items: [...items] };
}

function emptyLaneState(
  originExists: boolean,
  terminal: boolean,
): EvidencePathLane["state"] {
  if (!originExists) return "broken_link";
  return terminal ? "no_effect" : "pending";
}

export class SqliteEvidencePathReadStore {
  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {}

  resolve(correlationId: string): EvidencePath {
    const run = this.db.prepare<[string], RunRow>(`
      SELECT status FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    const terminal = run === undefined ||
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "stopped";
    const correlatedEvents = this.db.prepare<[string, string], EventRow>(`
      SELECT event_id, seq, tick, type, correlation_id
      FROM events
      WHERE run_id = ? AND correlation_id = ?
      ORDER BY seq
      LIMIT 200
    `).all(this.runId, correlationId);
    const origin = correlatedEvents.at(0);
    const downstreamEvents = this.db.prepare<[string, string, string], EventRow>(`
      SELECT DISTINCT child.event_id, child.seq, child.tick, child.type, child.correlation_id
      FROM events child
      WHERE child.run_id = ? AND child.causation_id IN (
        SELECT event_id FROM events
        WHERE run_id = ? AND correlation_id = ?
      )
      ORDER BY child.seq
      LIMIT 200
    `).all(this.runId, this.runId, correlationId);

    const ledger = this.db.prepare<[string, string, string, string], LedgerRow>(`
      SELECT id, tick, kind, reason, source_event_id, correlation_id
      FROM ledger_transactions
      WHERE run_id = ? AND (
        correlation_id = ? OR source_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        )
      )
      ORDER BY tick, id
      LIMIT 200
    `).all(this.runId, correlationId, this.runId, correlationId);
    const domainState = this.db.prepare<[string, string], DomainStateRow>(`
      WITH target(run_id, correlation_id) AS (VALUES (?, ?)),
      correlated(event_id) AS (
        SELECT event.event_id
        FROM events event
        JOIN target ON target.run_id = event.run_id
        WHERE event.correlation_id = target.correlation_id
      )
      SELECT history.id, history.tick, 'Fuel price history' AS label,
        history.source_event_id, source.correlation_id
      FROM energy_fuel_price_history history
      JOIN target ON target.run_id = history.run_id
      JOIN events source
        ON source.run_id = history.run_id AND source.event_id = history.source_event_id
      WHERE history.source_event_id IN (SELECT event_id FROM correlated)
        OR history.cause_event_id IN (SELECT event_id FROM correlated)
      UNION ALL
      SELECT history.id, history.effective_tick AS tick,
        'ROW reference price history' AS label,
        history.source_event_id, source.correlation_id
      FROM row_reference_price_history history
      JOIN target ON target.run_id = history.run_id
      JOIN events source
        ON source.run_id = history.run_id AND source.event_id = history.source_event_id
      WHERE history.source_event_id IN (SELECT event_id FROM correlated)
      UNION ALL
      SELECT shock.id, shock.effective_tick AS tick,
        'Market demand shock' AS label,
        shock.source_event_id, source.correlation_id
      FROM market_demand_shocks shock
      JOIN target ON target.run_id = shock.run_id
      JOIN events source
        ON source.run_id = shock.run_id AND source.event_id = shock.source_event_id
      WHERE shock.source_event_id IN (SELECT event_id FROM correlated)
      UNION ALL
      SELECT disaster.id, disaster.effective_tick AS tick,
        'Company capacity disruption' AS label,
        disaster.source_event_id, source.correlation_id
      FROM company_capacity_disasters disaster
      JOIN target ON target.run_id = disaster.run_id
      JOIN events source
        ON source.run_id = disaster.run_id AND source.event_id = disaster.source_event_id
      WHERE disaster.source_event_id IN (SELECT event_id FROM correlated)
      ORDER BY tick, id
      LIMIT 200
    `).all(this.runId, correlationId);
    const stakes = this.db.prepare<[string, string, string], StakeRow>(`
      SELECT stake.id, stake.company_id, stake.since_tick, stake.source_event_id,
        event.correlation_id
      FROM ownership_stakes stake
      LEFT JOIN events event
        ON event.run_id = stake.run_id AND event.event_id = stake.source_event_id
      WHERE stake.run_id = ? AND stake.source_event_id IN (
        SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
      )
      ORDER BY stake.since_tick, stake.id
      LIMIT 200
    `).all(this.runId, this.runId, correlationId);
    const proposals = this.db.prepare<
      [string, string, string, string, string, string],
      ProposalRow
    >(`
      SELECT proposal.id, proposal.proposed_tick, proposal.status,
        proposal.last_transition_event_id AS source_event_id,
        event.correlation_id
      FROM investment_proposals proposal
      JOIN events event
        ON event.run_id = proposal.run_id
        AND event.event_id = proposal.last_transition_event_id
      WHERE proposal.run_id = ? AND (
        proposal.id = ? OR proposal.source_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        ) OR proposal.last_transition_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        )
      )
      ORDER BY proposal.proposed_tick, proposal.id
      LIMIT 200
    `).all(
      this.runId,
      correlationId,
      this.runId,
      correlationId,
      this.runId,
      correlationId,
    );
    const investments = this.db.prepare<
      [string, string, string, string],
      InvestmentRow
    >(`
      SELECT investment.id, investment.completed_tick, investment.source_event_id,
        event.correlation_id
      FROM investments investment
      JOIN events event
        ON event.run_id = investment.run_id AND event.event_id = investment.source_event_id
      WHERE investment.run_id = ? AND (
        investment.proposal_id = ? OR investment.source_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        )
      )
      ORDER BY investment.completed_tick, investment.id
      LIMIT 200
    `).all(this.runId, correlationId, this.runId, correlationId);
    const distributions = this.db.prepare<
      [string, string, string, string, string, string],
      DistributionRow
    >(`
      SELECT distribution.id, distribution.distributed_tick,
        distribution.source_event_id, event.correlation_id
      FROM investment_distributions distribution
      JOIN events event
        ON event.run_id = distribution.run_id
        AND event.event_id = distribution.source_event_id
      WHERE distribution.run_id = ? AND (
        distribution.reference_id = ? OR
        distribution.request_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        ) OR distribution.source_event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
        )
      )
      ORDER BY distribution.distributed_tick, distribution.id
      LIMIT 200
    `).all(
      this.runId,
      correlationId,
      this.runId,
      correlationId,
      this.runId,
      correlationId,
    );
    const news = this.db.prepare<
      [string, string, string, string, string, string],
      NewsRow
    >(`
      SELECT DISTINCT story.id, story.tick, story.source_event_id,
        source.correlation_id
      FROM news_stories story
      JOIN news_story_citations citation
        ON citation.run_id = story.run_id AND citation.story_id = story.id
      JOIN events source
        ON source.run_id = story.run_id AND source.event_id = story.source_event_id
      WHERE story.run_id = ? AND story.status = 'published'
        AND citation.event_id IN (
          SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
          UNION
          SELECT child.event_id FROM events child
          WHERE child.run_id = ? AND child.causation_id IN (
            SELECT event_id FROM events WHERE run_id = ? AND correlation_id = ?
          )
        )
      ORDER BY story.tick, story.id
      LIMIT 200
    `).all(
      this.runId,
      this.runId,
      correlationId,
      this.runId,
      this.runId,
      correlationId,
    );

    const bookedItems = boundedReferences([
      ...domainState.map((row) => ({
        kind: "state" as const,
        id: row.id,
        label: row.label,
        tick: toSafeNumber(row.tick, "evidence domain-state tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
      ...ledger.map((row) => ({
        kind: "transaction" as const,
        id: row.id,
        label: shortLabel(`Ledger ${row.kind.replaceAll("_", " ")} · ${row.reason}`),
        tick: toSafeNumber(row.tick, "evidence transaction tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
      ...stakes.map((row) => ({
        kind: "cap_table" as const,
        id: row.company_id,
        label: `Cap-table stake ${row.id} booked`,
        tick: toSafeNumber(row.since_tick, "evidence cap-table tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
      ...proposals.map((row) => ({
        kind: "proposal" as const,
        id: row.id,
        label: `Investment proposal · ${row.status}`,
        tick: toSafeNumber(row.proposed_tick, "evidence proposal tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
      ...investments.map((row) => ({
        kind: "investment" as const,
        id: row.id,
        label: "Investment close booked",
        tick: toSafeNumber(row.completed_tick, "evidence investment tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
      ...distributions.map((row) => ({
        kind: "distribution" as const,
        id: row.id,
        label: "Distribution booked",
        tick: toSafeNumber(row.distributed_tick, "evidence distribution tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
    ]);
    const downstreamItems = boundedReferences([
      ...downstreamEvents.map(eventReference),
      ...news.map((row) => ({
        kind: "news" as const,
        id: row.id,
        label: "Published story citing this evidence",
        tick: toSafeNumber(row.tick, "evidence news tick"),
        eventId: row.source_event_id,
        correlationId: row.correlation_id,
      })),
    ]);
    const originExists = origin !== undefined;
    const emptyState = emptyLaneState(originExists, terminal);
    return evidencePathResponseSchema.omit({ meta: true }).parse({
      correlationId,
      origin: lane(
        originExists ? "booked" : "broken_link",
        "Origin event",
        originExists
          ? "The first event stored under this exact correlation."
          : "No origin event is stored for this correlation; the link is broken.",
        origin === undefined ? [] : [eventReference(origin)],
      ),
      booked: lane(
        bookedItems.length > 0 ? "booked" : emptyState,
        "Booked state",
        bookedItems.length > 0
          ? "Authoritative ledger, proposal, ownership, investment, or distribution rows explicitly reference this thread."
          : terminal
            ? "The run ended without a stored ledger or cap-table effect for this thread."
            : "No authoritative state change is stored yet.",
        bookedItems,
      ),
      downstream: lane(
        downstreamItems.length > 0 ? "booked" : emptyState,
        "Downstream effect",
        downstreamItems.length > 0
          ? "These events or stories carry an explicit causation or citation link."
          : terminal
            ? "No explicit downstream effect was observed before the run ended."
            : "No explicit downstream effect is stored yet.",
        downstreamItems,
      ),
    });
  }
}
