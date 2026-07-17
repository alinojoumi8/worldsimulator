import { useQuery } from "@tanstack/react-query";
import {
  BadgeDollarSign,
  Building2,
  FileSignature,
  Landmark,
  PackageSearch,
  Users,
  Workflow,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import {
  EmptyWorldState,
  formatCents,
  type WorldSection,
  WorldExplorerHeader,
} from "../components/world-explorer-ui";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { CreditDashboard } from "../components/credit-ui";
import { errorMessage } from "../lib/api-client";

function PanelError({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return <ErrorNotice message={errorMessage(error)} onRetry={retry} />;
}

function CompaniesPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["companies", simulationId, token],
    queryFn: ({ signal }) => api.listCompanies(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading company books…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  if (query.data.items.length === 0) return <EmptyWorldState>No companies have entered formation yet.</EmptyWorldState>;
  return (
    <div className="explorer-card-grid">
      {query.data.items.map((company) => (
        <Link className="explorer-card" key={company.id} to={`/simulations/${simulationId}/companies/${company.id}`}>
          <div className="explorer-card__title"><Building2 size={19} /><h2>{company.name}</h2></div>
          <StatusPill status={company.status} />
          <p>{company.sector.replaceAll("_", " ")} · founded tick {company.foundedTick}</p>
          <dl>
            <div><dt>Cash</dt><dd>{formatCents(company.cash.cents)}</dd></div>
            <div><dt>30-tick profit</dt><dd>{formatCents(company.lastProfit.cents)}</dd></div>
            <div><dt>Staff</dt><dd>{company.employees}</dd></div>
            <div><dt>Shortfall streak</dt><dd>{company.consecutiveShortfallDays} days</dd></div>
          </dl>
        </Link>
      ))}
    </div>
  );
}

function JobsPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["jobs", simulationId, token],
    queryFn: ({ signal }) => api.listJobs(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading the labor board…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  if (query.data.items.length === 0) return <EmptyWorldState>No job postings are recorded yet.</EmptyWorldState>;
  return (
    <div className="explorer-list">
      {query.data.items.map((job) => (
        <Link className="explorer-list-row" key={job.id} to={`/simulations/${simulationId}/jobs/${job.id}`}>
          <Workflow size={18} />
          <div><strong>{job.title}</strong><span>{job.employer.name} · {job.occupationCode.replaceAll("_", " ")}</span></div>
          <span>{formatCents(job.annualWageCents)}/yr</span>
          <StatusPill status={job.status} />
          <small>{job.applicationCount} applicants · {job.filledCount}/{job.openings} filled</small>
        </Link>
      ))}
    </div>
  );
}

function ContractsPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["contracts", simulationId, token],
    queryFn: ({ signal }) => api.listContracts(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading the agreement registry…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  if (query.data.items.length === 0) return <EmptyWorldState>No legal agreements are recorded yet.</EmptyWorldState>;
  return (
    <div className="explorer-list">
      {query.data.items.map((contract) => (
        <Link className="explorer-list-row" key={contract.id} to={`/simulations/${simulationId}/contracts/${contract.id}`}>
          <FileSignature size={18} />
          <div><strong>{contract.type.replaceAll("_", " ")}</strong><span>{contract.parties.map((party) => party.name).join(" · ")}</span></div>
          <code>{contract.id}</code>
          <StatusPill status={contract.status} />
          <small>Effective tick {contract.effectiveTick} · fee {formatCents(contract.feeCents)}</small>
        </Link>
      ))}
    </div>
  );
}

function InstitutionsPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["institutions", simulationId, token],
    queryFn: ({ signal }) => api.listInstitutions(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading institution rulebooks…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  return (
    <div className="explorer-card-grid">
      {query.data.items.map((institution) => (
        <Link className="explorer-card" key={institution.id} to={`/simulations/${simulationId}/institutions/${institution.id}`}>
          <div className="explorer-card__title"><Landmark size={19} /><h2>{institution.name}</h2></div>
          <span className="kind-chip">{institution.kind.replaceAll("_", " ")}</span>
          <p>{institution.staffCount} bounded officeholders</p>
          <pre>{JSON.stringify(institution.keyFigures, null, 2)}</pre>
        </Link>
      ))}
    </div>
  );
}

function MarketPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["goods-market", simulationId, token],
    queryFn: ({ signal }) => api.getGoodsMarket(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading posted prices and inventory…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  return (
    <>
      {query.data.energy === null ? null : (
        <div className="market-energy-strip">
          <span>Household power <strong>{formatCents(query.data.energy.householdTariffCents)}</strong></span>
          <span>Business unit <strong>{formatCents(query.data.energy.businessTariffCents)}</strong></span>
          <span>Fuel reference <strong>{formatCents(query.data.energy.fuelPriceCents)}</strong></span>
        </div>
      )}
      <div className="market-table-wrap">
        <table className="market-table">
          <thead><tr><th>Product</th><th>ROW reference</th><th>Demand</th><th>Posted offerings</th></tr></thead>
          <tbody>
            {query.data.products.map(({ product, currentRowReferencePriceCents, demandMultiplierBp, offerings }) => (
              <tr key={product.sku}>
                <th><PackageSearch size={16} /> {product.name}<small>{product.unit}</small></th>
                <td>{formatCents(currentRowReferencePriceCents)}</td>
                <td>{(demandMultiplierBp / 100).toFixed(0)}%</td>
                <td>
                  {offerings.length === 0 ? <span className="muted">ROW only</span> : offerings.map((offering) => (
                    <div className="market-quote" key={offering.id}>
                      <Link to={`/simulations/${simulationId}/companies/${offering.company.id}`}>{offering.company.name}</Link>
                      <strong>{formatCents(offering.postedPriceCents)}</strong>
                      <span>{offering.inventory === null ? "service" : `${offering.inventory} units`}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AgentsPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["agents", simulationId, token],
    queryFn: ({ signal }) => api.listAgents(simulationId, undefined, signal),
  });
  if (query.isPending) return <LoadingPanel label="Reading the citizen directory…" />;
  if (query.error !== null) return <PanelError error={query.error} retry={() => { void query.refetch(); }} />;
  return (
    <div className="explorer-list explorer-list--agents">
      {query.data.items.map((agent) => (
        <Link className="explorer-list-row" key={agent.id} to={`/simulations/${simulationId}/agents/${agent.id}`}>
          <Users size={18} />
          <div><strong>{agent.name}</strong><span>{agent.occupation.replaceAll("_", " ")} · age {agent.age}</span></div>
          <span>{formatCents(agent.netWorth.cents)}</span>
          <StatusPill status={agent.employmentStatus} />
          <small>{agent.householdId}</small>
        </Link>
      ))}
    </div>
  );
}

function CreditPanel({ simulationId }: { readonly simulationId: string }) {
  const { api, token } = useAppSession();
  const banks = useQuery({
    queryKey: ["banks", simulationId, token],
    queryFn: ({ signal }) => api.listBanks(simulationId, undefined, signal),
  });
  const loans = useQuery({
    queryKey: ["loans", simulationId, token],
    queryFn: ({ signal }) => api.listLoans(simulationId, undefined, signal),
  });
  const indicators = useQuery({
    queryKey: ["credit-indicators", simulationId, token],
    queryFn: ({ signal }) => api.listIndicators(simulationId, undefined, signal),
  });
  if (banks.isPending || loans.isPending || indicators.isPending) {
    return <LoadingPanel label="Reconciling banks, loans, and credit indicatorsâ€¦" />;
  }
  const error = banks.error ?? loans.error ?? indicators.error;
  if (error !== null) {
    return (
      <PanelError
        error={error}
        retry={() => { void Promise.all([banks.refetch(), loans.refetch(), indicators.refetch()]); }}
      />
    );
  }
  if (banks.data === undefined || loans.data === undefined || indicators.data === undefined) {
    return null;
  }
  return (
    <>
      <p className="eyebrow"><BadgeDollarSign size={16} /> Stored credit lifecycle</p>
      <CreditDashboard
        simulationId={simulationId}
        banks={banks.data}
        loans={loans.data}
        indicators={indicators.data}
      />
    </>
  );
}

export function WorldExplorerPage({ section }: { readonly section: WorldSection }) {
  const simulationId = useParams().simId ?? "invalid";
  return (
    <div className="explorer-page">
      <WorldExplorerHeader simulationId={simulationId} />
      <section className="explorer-content" aria-live="polite">
        {section === "companies" ? <CompaniesPanel simulationId={simulationId} /> : null}
        {section === "jobs" ? <JobsPanel simulationId={simulationId} /> : null}
        {section === "contracts" ? <ContractsPanel simulationId={simulationId} /> : null}
        {section === "institutions" ? <InstitutionsPanel simulationId={simulationId} /> : null}
        {section === "market" ? <MarketPanel simulationId={simulationId} /> : null}
        {section === "credit" ? <CreditPanel simulationId={simulationId} /> : null}
        {section === "agents" ? <AgentsPanel simulationId={simulationId} /> : null}
      </section>
    </div>
  );
}
