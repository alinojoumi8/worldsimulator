import { useQuery } from "@tanstack/react-query";
import type {
  InvestmentCapTableView,
  InvestmentTimelineItem,
} from "@worldtangle/shared";
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  BookOpenCheck,
  Building2,
  CircleDollarSign,
  GitBranch,
  Landmark,
  PieChart,
  ReceiptText,
  Scale,
  Users,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import { EvidencePath } from "../components/evidence-path";
import {
  EmptyWorldState,
  formatCents,
  WorldExplorerHeader,
} from "../components/world-explorer-ui";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { errorMessage } from "../lib/api-client";

function formatBasisPoints(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function Timeline({ items }: { readonly items: readonly InvestmentTimelineItem[] }) {
  if (items.length === 0) return <EmptyWorldState>No timeline events are stored yet.</EmptyWorldState>;
  return (
    <ol className="investment-timeline">
      {items.map((item) => (
        <li key={item.eventId}>
          <span>Tick {item.tick}</span>
          <div>
            <strong>{item.type.replaceAll(".", " · ").replaceAll("_", " ")}</strong>
            <code>{item.eventId}</code>
            <small>
              {item.actor.kind} · {item.actor.id}
              {item.evidenceEventIds.length === 0
                ? " · no additional evidence references"
                : ` · ${item.evidenceEventIds.length} evidence references`}
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CapTable({
  capTable,
  title,
}: {
  readonly capTable: InvestmentCapTableView;
  readonly title: string;
}) {
  return (
    <section className="cap-table-card">
      <div className="panel-heading">
        <div><p className="eyebrow"><PieChart size={15} /> Exact shares</p><h2>{title}</h2></div>
        <strong>{capTable.totalShares} total</strong>
      </div>
      <div className="cap-table-list">
        {capTable.stakes.map((stake) => (
          <article key={stake.id}>
            <div>
              <strong>{stake.holder.name}</strong>
              <span>{stake.holder.kind.replaceAll("_", " ")} · {stake.acquiredVia}</span>
            </div>
            <div className="cap-table-list__share">
              <strong>{formatBasisPoints(stake.ownershipBasisPoints)}</strong>
              <span>{stake.shares} shares · tick {stake.sinceTick}</span>
            </div>
            <div className="ownership-track" aria-label={`${stake.holder.name} ownership`}>
              <span style={{ width: `${stake.ownershipBasisPoints / 100}%` }} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DetailError({
  error,
  retry,
}: {
  readonly error: unknown;
  readonly retry: () => void;
}) {
  return (
    <ErrorNotice
      title="Investment evidence is unavailable"
      message={errorMessage(error)}
      onRetry={retry}
    />
  );
}

export function InvestmentExplorerPage() {
  const simulationId = useParams().simId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
  });
  const runId = status.data?.run.id;
  const proposals = useQuery({
    queryKey: ["investment-proposals", simulationId, runId, token],
    queryFn: ({ signal }) => api.listInvestmentProposals(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const investments = useQuery({
    queryKey: ["investments", simulationId, runId, token],
    queryFn: ({ signal }) => api.listInvestments(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const distributions = useQuery({
    queryKey: ["investment-distributions", simulationId, runId, token],
    queryFn: ({ signal }) => api.listInvestmentDistributions(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  const failure = status.error ?? proposals.error ?? investments.error ?? distributions.error;

  return (
    <div className="explorer-page investment-page">
      <WorldExplorerHeader
        simulationId={simulationId}
        title="Investment evidence"
        subtitle="Follow proposals, negotiated closes, exact cap-table changes, and distributions through stored records."
      />
      <section className="investment-boundary" role="note">
        <BookOpenCheck size={20} />
        <div>
          <strong>Read-only simulated evidence</strong>
          <p>These records describe a synthetic economy. They are not investment advice or a claim about a real company.</p>
        </div>
        {status.data === undefined ? null : <StatusPill status={status.data.run.status} />}
      </section>
      {status.isPending ? <LoadingPanel label="Locating the durable run…" /> : null}
      {failure === null ? null : (
        <DetailError
          error={failure}
          retry={() => {
            void status.refetch();
            if (runId !== undefined) {
              void Promise.all([
                proposals.refetch(),
                investments.refetch(),
                distributions.refetch(),
              ]);
            }
          }}
        />
      )}
      {runId === undefined ? null : (
        <div className="investment-pipeline" aria-label="Investment evidence pipeline">
          <span><GitBranch size={16} /> Proposal</span>
          <ArrowRight size={17} />
          <span><Scale size={16} /> Negotiated close</span>
          <ArrowRight size={17} />
          <span><PieChart size={16} /> Cap table</span>
          <ArrowRight size={17} />
          <span><ReceiptText size={16} /> Distribution</span>
        </div>
      )}

      <section className="investment-section" aria-labelledby="proposal-list-heading">
        <div className="panel-heading">
          <div><p className="eyebrow"><Scale size={15} /> Proposed terms</p><h2 id="proposal-list-heading">Proposals</h2></div>
          <span>{proposals.data?.items.length ?? 0} stored</span>
        </div>
        {proposals.isPending && runId !== undefined ? <LoadingPanel label="Reading proposals…" /> : null}
        {proposals.data?.items.length === 0 ? (
          <EmptyWorldState>No investment proposals have been generated in this run.</EmptyWorldState>
        ) : (
          <div className="investment-card-grid">
            {proposals.data?.items.map((proposal) => (
              <Link
                className="investment-record-card"
                to={`/simulations/${simulationId}/investment-proposals/${proposal.id}`}
                key={proposal.id}
              >
                <div><StatusPill status={proposal.status} /><span>Tick {proposal.proposedTick}</span></div>
                <h3>{proposal.company.name}</h3>
                <p>{proposal.fund.name} · {proposal.vcPartner.name}</p>
                <dl>
                  <div><dt>Ask</dt><dd>{formatCents(proposal.askAmountCents)}</dd></div>
                  <div><dt>Pre-money</dt><dd>{formatCents(proposal.preMoneyValuationCents)}</dd></div>
                  <div><dt>Equity</dt><dd>{formatBasisPoints(proposal.initialEquityBasisPoints)}</dd></div>
                </dl>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="investment-section" aria-labelledby="investment-list-heading">
        <div className="panel-heading">
          <div><p className="eyebrow"><CircleDollarSign size={15} /> Booked closes</p><h2 id="investment-list-heading">Investments</h2></div>
          <span>{investments.data?.items.length ?? 0} stored</span>
        </div>
        {investments.isPending && runId !== undefined ? <LoadingPanel label="Reading investment closes…" /> : null}
        {investments.data?.items.length === 0 ? (
          <EmptyWorldState>No negotiated investment has closed in this run.</EmptyWorldState>
        ) : (
          <div className="investment-record-list">
            {investments.data?.items.map((investment) => (
              <Link
                to={`/simulations/${simulationId}/investments/${investment.id}`}
                key={investment.id}
              >
                <CircleDollarSign size={18} />
                <div>
                  <strong>{investment.company.name}</strong>
                  <span>{investment.investor.name} · {formatCents(investment.amountCents)}</span>
                </div>
                <span>{formatBasisPoints(investment.ownershipBasisPoints)} · tick {investment.completedTick}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="investment-section" aria-labelledby="distribution-list-heading">
        <div className="panel-heading">
          <div><p className="eyebrow"><ReceiptText size={15} /> Pro-rata cash</p><h2 id="distribution-list-heading">Distributions</h2></div>
          <span>{distributions.data?.items.length ?? 0} stored</span>
        </div>
        {distributions.isPending && runId !== undefined ? <LoadingPanel label="Reading distributions…" /> : null}
        {distributions.data?.items.length === 0 ? (
          <EmptyWorldState>No investment distribution has been booked in this run.</EmptyWorldState>
        ) : (
          <div className="investment-record-list">
            {distributions.data?.items.map((distribution) => (
              <Link
                to={`/simulations/${simulationId}/investment-distributions/${distribution.id}`}
                key={distribution.id}
              >
                <ReceiptText size={18} />
                <div>
                  <strong>{distribution.company.name}</strong>
                  <span>{distribution.allocationCount} allocations · {distribution.referenceId}</span>
                </div>
                <span>{formatCents(distribution.amountCents)} · tick {distribution.distributedTick}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function InvestmentProposalDetailPage() {
  const simulationId = useParams().simId ?? "invalid";
  const proposalId = useParams().proposalId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
  });
  const runId = status.data?.run.id;
  const detail = useQuery({
    queryKey: ["investment-proposal", simulationId, runId, proposalId, token],
    queryFn: ({ signal }) => api.getInvestmentProposal(
      simulationId,
      proposalId,
      runId,
      signal,
    ),
    enabled: runId !== undefined,
  });

  if (status.isPending || (runId !== undefined && detail.isPending)) {
    return <div className="explorer-page"><LoadingPanel label="Reconstructing proposal evidence…" /></div>;
  }
  if (status.error !== null || detail.error !== null || detail.data === undefined) {
    return (
      <div className="explorer-page">
        <DetailError
          error={status.error ?? detail.error}
          retry={() => {
            void status.refetch();
            if (runId !== undefined) void detail.refetch();
          }}
        />
      </div>
    );
  }
  const proposal = detail.data.proposal;
  return (
    <div className="explorer-page investment-page">
      <WorldExplorerHeader
        simulationId={simulationId}
        title={proposal.company.name}
        subtitle="Proposal terms, negotiation outcome, and event-backed decision evidence."
      />
      <div className="investment-detail-heading">
        <Link to={`/simulations/${simulationId}/world/investments`}><ArrowLeft size={15} /> Investment evidence</Link>
        <StatusPill status={proposal.status} />
      </div>
      <section className="investment-hero-card">
        <div>
          <p className="eyebrow"><Scale size={15} /> Proposal {proposal.id}</p>
          <h1>{formatCents(proposal.askAmountCents)} from {proposal.fund.name}</h1>
          <p>Founder {proposal.founder.name} · partner {proposal.vcPartner.name} · expires tick {proposal.expiresTick}</p>
        </div>
        {proposal.investmentId === null ? null : (
          <Link className="button button--primary" to={`/simulations/${simulationId}/investments/${proposal.investmentId}`}>
            Open booked investment
          </Link>
        )}
      </section>
      <div className="investment-detail-grid">
        <section className="investment-fact-card">
          <p className="eyebrow">Initial terms</p>
          <dl>
            <div><dt>Ask</dt><dd>{formatCents(detail.data.termsDiff.initial.amountCents)}</dd></div>
            <div><dt>Pre-money</dt><dd>{formatCents(detail.data.termsDiff.initial.preMoneyValuationCents)}</dd></div>
            <div><dt>Equity</dt><dd>{formatBasisPoints(detail.data.termsDiff.initial.equityBasisPoints)}</dd></div>
          </dl>
        </section>
        <section className="investment-fact-card">
          <p className="eyebrow">Final terms</p>
          {detail.data.termsDiff.final === null ? (
            <p>No final terms were booked.</p>
          ) : (
            <dl>
              <div><dt>Amount</dt><dd>{formatCents(detail.data.termsDiff.final.amountCents)}</dd></div>
              <div><dt>Pre-money</dt><dd>{formatCents(detail.data.termsDiff.final.preMoneyValuationCents)}</dd></div>
              <div><dt>Equity</dt><dd>{formatBasisPoints(detail.data.termsDiff.final.equityBasisPoints)}</dd></div>
            </dl>
          )}
        </section>
        <section className="investment-fact-card">
          <p className="eyebrow">Decision evidence</p>
          <dl>
            <div><dt>Status</dt><dd>{detail.data.decision.status}</dd></div>
            <div><dt>Reason</dt><dd>{detail.data.decision.rejectionReason ?? "No rejection recorded"}</dd></div>
            <div><dt>Evidence refs</dt><dd>{detail.data.decision.evidenceEventIds.length}</dd></div>
          </dl>
        </section>
      </div>
      <EvidencePath
        simulationId={simulationId}
        correlationId={proposal.id}
        runId={runId}
        title="Proposal-to-state evidence"
      />
      <section className="investment-section">
        <div className="panel-heading"><div><p className="eyebrow"><GitBranch size={15} /> Stored sequence</p><h2>Proposal timeline</h2></div></div>
        <Timeline items={detail.data.timeline} />
      </section>
    </div>
  );
}

export function InvestmentDetailPage() {
  const simulationId = useParams().simId ?? "invalid";
  const investmentId = useParams().investmentId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
  });
  const runId = status.data?.run.id;
  const detail = useQuery({
    queryKey: ["investment", simulationId, runId, investmentId, token],
    queryFn: ({ signal }) => api.getInvestment(simulationId, investmentId, runId, signal),
    enabled: runId !== undefined,
  });
  if (status.isPending || (runId !== undefined && detail.isPending)) {
    return <div className="explorer-page"><LoadingPanel label="Reconciling cash, contract, and shares…" /></div>;
  }
  if (status.error !== null || detail.error !== null || detail.data === undefined) {
    return (
      <div className="explorer-page">
        <DetailError
          error={status.error ?? detail.error}
          retry={() => {
            void status.refetch();
            if (runId !== undefined) void detail.refetch();
          }}
        />
      </div>
    );
  }
  const investment = detail.data.investment;
  const correlation = detail.data.timeline.find(
    (item) => item.eventId === detail.data.why.sourceEventId,
  )?.correlationId ?? investment.proposalId;
  return (
    <div className="explorer-page investment-page">
      <WorldExplorerHeader
        simulationId={simulationId}
        title={`${investment.company.name} investment`}
        subtitle="The negotiated close, balanced cash posting, legal contract, and exact ownership change."
      />
      <div className="investment-detail-heading">
        <Link to={`/simulations/${simulationId}/world/investments`}><ArrowLeft size={15} /> Investment evidence</Link>
        <span className="scenario-chip">Booked · tick {investment.completedTick}</span>
      </div>
      <section className="investment-hero-card">
        <div>
          <p className="eyebrow"><CircleDollarSign size={15} /> {investment.id}</p>
          <h1>{formatCents(investment.amountCents)} invested by {investment.investor.name}</h1>
          <p>{formatBasisPoints(investment.ownershipBasisPoints)} ownership · {investment.sharesIssued} newly issued shares</p>
        </div>
        <div className="investment-hero-actions">
          <Link
            className="button button--secondary"
            to={`/simulations/${simulationId}/investment-proposals/${investment.proposalId}`}
          >
            <Scale size={16} /> Proposal terms
          </Link>
          <Link
            className="button button--secondary"
            to={`/simulations/${simulationId}/companies/${investment.company.id}/cap-table`}
          >
            <PieChart size={16} /> Current cap table
          </Link>
        </div>
      </section>
      <div className="investment-proof-grid">
        <article><Banknote size={20} /><strong>Cash transaction</strong><code>{investment.transactionId}</code></article>
        <article><Scale size={20} /><strong>Investment contract</strong><code>{investment.contractId}</code></article>
        <article><Users size={20} /><strong>Ownership stake</strong><code>{investment.ownershipStakeId}</code></article>
      </div>
      <div className="cap-table-comparison">
        <CapTable capTable={detail.data.capTableBefore} title="Before close" />
        <ArrowRight size={24} aria-hidden="true" />
        <CapTable capTable={detail.data.capTableAfter} title="After close" />
      </div>
      <EvidencePath
        simulationId={simulationId}
        correlationId={correlation}
        runId={runId}
        title="Close-to-ledger evidence"
      />
      <section className="investment-section">
        <div className="panel-heading"><div><p className="eyebrow"><GitBranch size={15} /> Stored sequence</p><h2>Negotiation and close timeline</h2></div></div>
        <Timeline items={detail.data.timeline} />
      </section>
      <section className="investment-section">
        <div className="panel-heading">
          <div><p className="eyebrow"><ReceiptText size={15} /> Ownership proceeds</p><h2>Linked distributions</h2></div>
          <span>{detail.data.distributions.length} stored</span>
        </div>
        {detail.data.distributions.length === 0 ? (
          <EmptyWorldState>No later distribution is linked to this invested company.</EmptyWorldState>
        ) : (
          <div className="investment-record-list">
            {detail.data.distributions.map((distribution) => (
              <Link
                to={`/simulations/${simulationId}/investment-distributions/${distribution.id}`}
                key={distribution.id}
              >
                <ReceiptText size={18} />
                <div>
                  <strong>{formatCents(distribution.amountCents)}</strong>
                  <span>{distribution.allocationCount} allocations · {distribution.referenceId}</span>
                </div>
                <span>Tick {distribution.distributedTick}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function InvestmentCapTablePage() {
  const simulationId = useParams().simId ?? "invalid";
  const companyId = useParams().companyId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
  });
  const runId = status.data?.run.id;
  const capTable = useQuery({
    queryKey: ["investment-cap-table", simulationId, runId, companyId, token],
    queryFn: ({ signal }) => api.getInvestmentCapTable(
      simulationId,
      companyId,
      runId,
      signal,
    ),
    enabled: runId !== undefined,
  });
  const investments = useQuery({
    queryKey: ["investments", simulationId, runId, token],
    queryFn: ({ signal }) => api.listInvestments(simulationId, runId, signal),
    enabled: runId !== undefined,
  });
  if (
    status.isPending ||
    (runId !== undefined && (capTable.isPending || investments.isPending))
  ) {
    return <div className="explorer-page"><LoadingPanel label="Reconciling the exact cap table…" /></div>;
  }
  if (
    status.error !== null ||
    capTable.error !== null ||
    investments.error !== null ||
    capTable.data === undefined
  ) {
    return (
      <div className="explorer-page">
        <DetailError
          error={status.error ?? capTable.error ?? investments.error}
          retry={() => {
            void status.refetch();
            if (runId !== undefined) {
              void Promise.all([capTable.refetch(), investments.refetch()]);
            }
          }}
        />
      </div>
    );
  }
  const latestInvestment = investments.data?.items
    .filter((investment) => investment.company.id === companyId)
    .reduce<(typeof investments.data.items)[number] | undefined>(
      (latest, investment) => (
        latest === undefined || investment.completedTick > latest.completedTick
          ? investment
          : latest
      ),
      undefined,
    );
  return (
    <div className="explorer-page investment-page">
      <WorldExplorerHeader
        simulationId={simulationId}
        title={`${capTable.data.capTable.company.name} cap table`}
        subtitle="Exact stored shares and ownership percentages. No inferred or rounded ownership is used."
      />
      <div className="investment-detail-heading">
        <Link to={`/simulations/${simulationId}/companies/${companyId}`}><ArrowLeft size={15} /> Company</Link>
        <span className="scenario-chip">Authoritative projection</span>
      </div>
      <CapTable capTable={capTable.data.capTable} title="Current ownership" />
      {latestInvestment === undefined ? (
        <section className="investment-boundary">
          <PieChart size={20} />
          <div><strong>Founding ownership only</strong><p>No completed investment is stored for this company.</p></div>
        </section>
      ) : (
        <EvidencePath
          simulationId={simulationId}
          correlationId={latestInvestment.proposalId}
          runId={runId}
          title="Latest dilution evidence"
        />
      )}
    </div>
  );
}

export function InvestmentDistributionDetailPage() {
  const simulationId = useParams().simId ?? "invalid";
  const distributionId = useParams().distributionId ?? "invalid";
  const { api, token } = useAppSession();
  const status = useQuery({
    queryKey: ["status", simulationId, token],
    queryFn: ({ signal }) => api.getStatus(simulationId, undefined, signal),
  });
  const runId = status.data?.run.id;
  const detail = useQuery({
    queryKey: ["investment-distribution", simulationId, runId, distributionId, token],
    queryFn: ({ signal }) => api.getInvestmentDistribution(
      simulationId,
      distributionId,
      runId,
      signal,
    ),
    enabled: runId !== undefined,
  });
  if (status.isPending || (runId !== undefined && detail.isPending)) {
    return <div className="explorer-page"><LoadingPanel label="Reconciling distribution allocations…" /></div>;
  }
  if (status.error !== null || detail.error !== null || detail.data === undefined) {
    return (
      <div className="explorer-page">
        <DetailError
          error={status.error ?? detail.error}
          retry={() => {
            void status.refetch();
            if (runId !== undefined) void detail.refetch();
          }}
        />
      </div>
    );
  }
  const distribution = detail.data.distribution;
  return (
    <div className="explorer-page investment-page">
      <WorldExplorerHeader
        simulationId={simulationId}
        title={`${distribution.company.name} distribution`}
        subtitle="The exact pro-rata allocations, balanced transaction, and source evidence."
      />
      <div className="investment-detail-heading">
        <Link to={`/simulations/${simulationId}/world/investments`}><ArrowLeft size={15} /> Investment evidence</Link>
        <span className="scenario-chip">Booked · tick {distribution.distributedTick}</span>
      </div>
      <section className="investment-hero-card">
        <div>
          <p className="eyebrow"><ReceiptText size={15} /> {distribution.id}</p>
          <h1>{formatCents(distribution.amountCents)} distributed</h1>
          <p>{distribution.allocations.length} exact allocations · transaction {distribution.transactionId}</p>
        </div>
        <Link
          className="button button--secondary"
          to={`/simulations/${simulationId}/companies/${distribution.company.id}/cap-table`}
        >
          <PieChart size={16} /> Cap table
        </Link>
      </section>
      <section className="investment-section">
        <div className="panel-heading">
          <div><p className="eyebrow"><Landmark size={15} /> Balanced allocations</p><h2>Distribution ledger</h2></div>
          <span>{distribution.totalShares} shares</span>
        </div>
        <div className="distribution-allocation-list">
          {distribution.allocations.map((allocation) => (
            <article key={allocation.allocationIndex}>
              <Building2 size={18} />
              <div><strong>{allocation.holder.name}</strong><span>{allocation.shares} shares · {formatBasisPoints(allocation.ownershipBasisPoints)}</span></div>
              <strong>{formatCents(allocation.amountCents)}</strong>
              <code>{allocation.accountId}</code>
            </article>
          ))}
        </div>
      </section>
      <EvidencePath
        simulationId={simulationId}
        correlationId={distribution.referenceId}
        runId={runId}
        title="Distribution evidence"
      />
    </div>
  );
}
