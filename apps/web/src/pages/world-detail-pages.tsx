import { useQuery } from "@tanstack/react-query";
import {
  Banknote,
  BriefcaseBusiness,
  FileSignature,
  Landmark,
  PackageCheck,
  UserRound,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAppSession } from "../app-session";
import {
  AgentFinancePanel,
  CompanyTimeline,
  formatCents,
  WorldExplorerHeader,
} from "../components/world-explorer-ui";
import { LoanWhyPanel } from "../components/credit-ui";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { errorMessage } from "../lib/api-client";

function DetailError({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return <ErrorNotice title="Could not open this record" message={errorMessage(error)} onRetry={retry} />;
}

export function CompanyDetailPage() {
  const { simId = "invalid", companyId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["company", simId, companyId, token],
    queryFn: ({ signal }) => api.getCompany(simId, companyId, undefined, signal),
  });
  return (
    <div className="explorer-page">
      <WorldExplorerHeader simulationId={simId} title="Company record" subtitle="Formation, work, production, pricing, and solvency in one causal view." />
      <section className="explorer-content">
        {query.isPending ? <LoadingPanel label="Reconciling the company record…" /> : null}
        {query.error === null ? null : <DetailError error={query.error} retry={() => { void query.refetch(); }} />}
        {query.data === undefined ? null : (
          <>
            <header className="entity-heading">
              <div><p className="eyebrow"><BriefcaseBusiness size={16} /> {query.data.company.sector.replaceAll("_", " ")}</p><h1>{query.data.company.name}</h1></div>
              <StatusPill status={query.data.company.status} />
              <p>Founded by <Link to={`/simulations/${simId}/agents/${query.data.company.founder.id}`}>{query.data.company.founder.name}</Link> at tick {query.data.company.foundedTick}.</p>
            </header>
            <div className="financial-position-grid" aria-label="Company financial position">
              <article><span>Cash</span><strong>{formatCents(query.data.financials.cashCents)}</strong></article>
              <article><span>Revenue · 30 ticks</span><strong>{formatCents(query.data.financials.revenue30Cents)}</strong></article>
              <article><span>Costs · 30 ticks</span><strong>{formatCents(query.data.financials.costs30Cents)}</strong></article>
              <article><span>Profit · 30 ticks</span><strong>{formatCents(query.data.financials.profit30Cents)}</strong></article>
            </div>
            <div className="entity-two-column">
              <section className="entity-panel">
                <h2>Ownership & formation</h2>
                <dl className="explorer-dl">
                  <div><dt>Formation stage</dt><dd>{query.data.company.formationStage.replaceAll("_", " ")}</dd></div>
                  <div><dt>Incorporation</dt><dd><Link to={`/simulations/${simId}/contracts/${query.data.company.incorporationContractId}`}>{query.data.company.incorporationContractId}</Link></dd></div>
                  {query.data.capTable.map((stake) => <div key={stake.holder.id}><dt>{stake.holder.name}</dt><dd>{stake.shares} shares · {(stake.ownershipBp / 100).toFixed(2)}%</dd></div>)}
                </dl>
                <Link
                  className="button button--secondary"
                  to={`/simulations/${simId}/companies/${query.data.company.id}/cap-table`}
                >
                  Open exact investment cap table
                </Link>
              </section>
              <section className="entity-panel">
                <h2>Solvency why-panel</h2>
                {query.data.solvency === null ? <p>No solvency assessment has fired yet.</p> : (
                  <dl className="explorer-dl">
                    <div><dt>Assessed tick</dt><dd>{query.data.solvency.tick}</dd></div>
                    <div><dt>30-tick obligations</dt><dd>{formatCents(query.data.solvency.obligationCents)}</dd></div>
                    <div><dt>Shortfall</dt><dd>{formatCents(query.data.solvency.shortfallCents)}</dd></div>
                    <div><dt>Consecutive days</dt><dd>{query.data.solvency.consecutiveShortfallDays}</dd></div>
                    <div><dt>Evidence</dt><dd><code>{query.data.solvency.sourceEventId}</code></dd></div>
                  </dl>
                )}
                {query.data.windDown === null ? null : <pre>{JSON.stringify(query.data.windDown, null, 2)}</pre>}
              </section>
            </div>
            <div className="entity-two-column">
              <section className="entity-panel">
                <h2>Employment</h2>
                {query.data.staff.length === 0 ? <p>No employment contracts.</p> : query.data.staff.map((member) => (
                  <div className="entity-row" key={member.employmentId}>
                    <UserRound size={17} /><div><Link to={`/simulations/${simId}/agents/${member.agent.id}`}>{member.agent.name}</Link><span>{member.title} · {formatCents(member.annualWageCents)}/yr</span></div><StatusPill status={member.status} />
                  </div>
                ))}
                {query.data.jobs.map((job) => <Link className="inline-record-link" key={job.id} to={`/simulations/${simId}/jobs/${job.id}`}>{job.title} · {job.status}</Link>)}
              </section>
              <section className="entity-panel">
                <h2>Offerings & inventory</h2>
                {query.data.offerings.length === 0 ? <p>No market offering.</p> : query.data.offerings.map((offering) => (
                  <div className="entity-row" key={offering.id}>
                    <PackageCheck size={17} /><div><strong>{offering.sku.replaceAll("_", " ")}</strong><span>{formatCents(offering.postedPriceCents)} · cost {formatCents(offering.unitCostCents)} · {offering.inventory ?? "service"}</span></div><StatusPill status={offering.active ? "active" : "inactive"} />
                  </div>
                ))}
              </section>
            </div>
            <section className="entity-panel entity-panel--timeline"><h2>Causal timeline</h2><CompanyTimeline timeline={query.data.timeline} /></section>
          </>
        )}
      </section>
    </div>
  );
}

export function ContractDetailPage() {
  const { simId = "invalid", contractId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const query = useQuery({ queryKey: ["contract", simId, contractId, token], queryFn: ({ signal }) => api.getContract(simId, contractId, undefined, signal) });
  return (
    <div className="explorer-page"><WorldExplorerHeader simulationId={simId} title="Agreement record" subtitle="Typed terms, signatures, obligations, and lifecycle evidence." /><section className="explorer-content">
      {query.isPending ? <LoadingPanel label="Reading agreement terms…" /> : null}
      {query.error === null ? null : <DetailError error={query.error} retry={() => { void query.refetch(); }} />}
      {query.data === undefined ? null : <>
        <header className="entity-heading"><div><p className="eyebrow"><FileSignature size={16} /> Legal agreement</p><h1>{query.data.contract.type.replaceAll("_", " ")}</h1></div><StatusPill status={query.data.contract.status} /><code>{query.data.contract.id}</code></header>
        <div className="entity-two-column">
          <section className="entity-panel"><h2>Parties</h2>{query.data.partyDetails.map((party) => <div className="entity-row" key={`${party.kind}:${party.id}`}><UserRound size={17} /><div><strong>{party.name}</strong><span>{party.role} · {party.signedTick === null ? "unsigned" : `signed tick ${party.signedTick}`}</span></div></div>)}</section>
          <section className="entity-panel"><h2>Terms</h2><pre>{JSON.stringify(query.data.contract.terms, null, 2)}</pre></section>
        </div>
        <section className="entity-panel"><h2>Obligations & breaches</h2><pre>{JSON.stringify({ obligations: query.data.contract.obligations, breaches: query.data.contract.breaches }, null, 2)}</pre></section>
        <section className="entity-panel"><h2>Lifecycle</h2>{query.data.timeline.map((item) => <div className="entity-row" key={item.id}><span>Tick {item.tick}</span><div><strong>{item.type}</strong><code>{item.id}</code></div></div>)}</section>
      </>}
    </section></div>
  );
}

export function JobDetailPage() {
  const { simId = "invalid", jobId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const query = useQuery({ queryKey: ["job", simId, jobId, token], queryFn: ({ signal }) => api.getJob(simId, jobId, undefined, signal) });
  return (
    <div className="explorer-page"><WorldExplorerHeader simulationId={simId} title="Labor-market record" subtitle="Posting terms, applications, deterministic scores, and signed employment." /><section className="explorer-content">
      {query.isPending ? <LoadingPanel label="Reading the labor match…" /> : null}
      {query.error === null ? null : <DetailError error={query.error} retry={() => { void query.refetch(); }} />}
      {query.data === undefined ? null : <>
        <header className="entity-heading"><div><p className="eyebrow"><BriefcaseBusiness size={16} /> <Link to={`/simulations/${simId}/companies/${query.data.employer.id}`}>{query.data.employer.name}</Link></p><h1>{query.data.job.title}</h1></div><StatusPill status={query.data.job.status} /><p>{formatCents(query.data.job.annualWageCents)}/year · {query.data.job.filledCount}/{query.data.job.openings} filled</p></header>
        <div className="entity-two-column">
          <section className="entity-panel"><h2>Requirements</h2><pre>{JSON.stringify(query.data.job.requirements, null, 2)}</pre></section>
          <section className="entity-panel"><h2>Applications</h2>{query.data.applications.length === 0 ? <p>No applications.</p> : query.data.applications.map(({ application, agent }) => <div className="entity-row" key={application.id}><UserRound size={17} /><div><Link to={`/simulations/${simId}/agents/${agent.id}`}>{agent.name}</Link><span>Score {application.score ?? "pending"} · reservation {formatCents(application.reservationWageCents)}</span></div><StatusPill status={application.status} /></div>)}</section>
        </div>
        <section className="entity-panel"><h2>Employment created</h2>{query.data.employmentContracts.length === 0 ? <p>No signed employment emerged from this posting.</p> : query.data.employmentContracts.map((employment) => <div className="entity-row" key={employment.id}><FileSignature size={17} /><div><Link to={`/simulations/${simId}/agents/${employment.employee.id}`}>{employment.employee.name}</Link><span>Started tick {employment.startTick} · {employment.legalContractId}</span></div><StatusPill status={employment.status} /></div>)}</section>
      </>}
    </section></div>
  );
}

export function InstitutionDetailPage() {
  const { simId = "invalid", institutionId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const query = useQuery({ queryKey: ["institution", simId, institutionId, token], queryFn: ({ signal }) => api.getInstitution(simId, institutionId, undefined, signal) });
  return (
    <div className="explorer-page"><WorldExplorerHeader simulationId={simId} title="Institution record" subtitle="Public officeholders, live figures, and the engine-owned rulebook." /><section className="explorer-content">
      {query.isPending ? <LoadingPanel label="Reading the public rulebook…" /> : null}
      {query.error === null ? null : <DetailError error={query.error} retry={() => { void query.refetch(); }} />}
      {query.data === undefined ? null : <>
        <header className="entity-heading"><div><p className="eyebrow"><Landmark size={16} /> {query.data.institution.kind.replaceAll("_", " ")}</p><h1>{query.data.institution.name}</h1></div><span className="kind-chip">{query.data.institution.staffCount} staff</span></header>
        <div className="entity-two-column"><section className="entity-panel"><h2>Officeholders</h2>{query.data.officeholders.map((holder) => <div className="entity-row" key={`${holder.role}:${holder.agent.id}`}><UserRound size={17} /><div><Link to={`/simulations/${simId}/agents/${holder.agent.id}`}>{holder.agent.name}</Link><span>{holder.role}</span></div></div>)}</section><section className="entity-panel"><h2>Key figures</h2><pre>{JSON.stringify(query.data.institution.keyFigures, null, 2)}</pre></section></div>
        {query.data.institution.kind === "vc_firm" ? (
          <Link className="button button--secondary" to={`/simulations/${simId}/world/investments`}>
            Open proposal, investment, and cap-table evidence
          </Link>
        ) : null}
        <section className="entity-panel"><h2>Public rulebook</h2><pre>{JSON.stringify(query.data.rulebook, null, 2)}</pre><p className="rulebook-note">Institutions are engine-side rule systems. Officeholders may exercise only the bounded authority shown here.</p></section>
      </>}
    </section></div>
  );
}

export function BankDetailPage() {
  const { simId = "invalid", bankId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const bank = useQuery({
    queryKey: ["bank", simId, bankId, token],
    queryFn: ({ signal }) => api.getBank(simId, bankId, undefined, signal),
  });
  const loans = useQuery({
    queryKey: ["bank-loans", simId, bankId, token],
    queryFn: ({ signal }) => api.listLoans(simId, undefined, signal),
  });
  const error = bank.error ?? loans.error;
  const loanBook = loans.data?.items.filter((loan) => loan.bank.id === bankId) ?? [];
  return (
    <div className="explorer-page">
      <WorldExplorerHeader
        simulationId={simId}
        title="Bank dashboard"
        subtitle="Deposits, lending constraints, loan outcomes, and stored credit evidence."
      />
      <section className="explorer-content">
        {bank.isPending || loans.isPending ? <LoadingPanel label="Reconciling the bank ledgerâ€¦" /> : null}
        {error === null ? null : <DetailError error={error} retry={() => { void Promise.all([bank.refetch(), loans.refetch()]); }} />}
        {bank.data === undefined || loans.data === undefined ? null : (
          <>
            <header className="entity-heading">
              <div><p className="eyebrow"><Landmark size={16} /> Credit institution</p><h1>{bank.data.bank.name}</h1></div>
              <StatusPill status={bank.data.bank.lendingHalted ? "lending halted" : "active"} />
              <code>{bank.data.bank.id}</code>
            </header>
            <div className="financial-position-grid" aria-label="Bank financial position">
              <article><span>Deposits</span><strong>{formatCents(bank.data.bank.totalDeposits)}</strong></article>
              <article><span>Credit outstanding</span><strong>{formatCents(bank.data.bank.totalLoans)}</strong></article>
              <article><span>Capital ratio</span><strong>{(bank.data.bank.capitalRatioBp / 100).toFixed(2)}%</strong></article>
              <article><span>Reserve ratio</span><strong>{(bank.data.bank.reserveRatioBp / 100).toFixed(2)}%</strong></article>
            </div>
            <div className="entity-two-column">
              <section className="entity-panel">
                <h2>Loan book</h2>
                <dl className="explorer-dl">
                  <div><dt>Active</dt><dd>{bank.data.bank.loanBook.active}</dd></div>
                  <div><dt>Defaulted</dt><dd>{bank.data.bank.loanBook.defaulted}</dd></div>
                  <div><dt>Written off</dt><dd>{bank.data.bank.loanBook.writtenOff}</dd></div>
                  <div><dt>Accounts</dt><dd>{bank.data.bank.accounts.count}</dd></div>
                </dl>
              </section>
              <section className="entity-panel">
                <h2>Last 30 ticks</h2>
                <dl className="explorer-dl">
                  <div><dt>Interest income</dt><dd>{formatCents(bank.data.bank.incomeStatement30.interestIncome)}</dd></div>
                  <div><dt>Write-downs</dt><dd>{formatCents(bank.data.bank.incomeStatement30.writeDowns)}</dd></div>
                </dl>
              </section>
            </div>
            <section className="entity-panel">
              <h2>Loans</h2>
              {loanBook.length === 0 ? <p>No loans are attributed to this bank.</p> : loanBook.map((loan) => (
                <Link className="explorer-list-row" key={loan.id} to={`/simulations/${simId}/loans/${loan.id}`}>
                  <Banknote size={18} />
                  <div><strong>{loan.borrower.name}</strong><span>{loan.purpose.replaceAll("_", " ")} Â· {(loan.annualRateBp / 100).toFixed(2)}%</span></div>
                  <span>{formatCents(loan.outstandingPrincipalCents)}</span>
                  <StatusPill status={loan.status} />
                </Link>
              ))}
            </section>
          </>
        )}
      </section>
    </div>
  );
}

export function LoanDetailPage() {
  const { simId = "invalid", loanId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const query = useQuery({
    queryKey: ["loan", simId, loanId, token],
    queryFn: ({ signal }) => api.getLoan(simId, loanId, undefined, signal),
  });
  const detail = query.data;
  return (
    <div className="explorer-page">
      <WorldExplorerHeader
        simulationId={simId}
        title="Loan record"
        subtitle="Terms, payment schedule, underwriting, circuit checks, and causal evidence from stored state."
      />
      <section className="explorer-content">
        {query.isPending ? <LoadingPanel label="Reconstructing the loan evidence chainâ€¦" /> : null}
        {query.error === null ? null : <DetailError error={query.error} retry={() => { void query.refetch(); }} />}
        {detail === undefined ? null : (
          <>
            <header className="entity-heading">
              <div>
                <p className="eyebrow"><Banknote size={16} /> {detail.loan.origin.replaceAll("_", " ")}</p>
                <h1>{detail.loan.borrower.name}</h1>
              </div>
              <StatusPill status={detail.loan.status} />
              <p>{detail.loan.purpose.replaceAll("_", " ")} through <Link to={`/simulations/${simId}/banks/${detail.loan.bank.id}`}>{detail.loan.bank.name}</Link>.</p>
            </header>
            <div className="financial-position-grid" aria-label="Loan position">
              <article><span>Original principal</span><strong>{formatCents(detail.loan.principalCents)}</strong></article>
              <article><span>Outstanding</span><strong>{formatCents(detail.loan.outstandingPrincipalCents)}</strong></article>
              <article><span>Annual rate</span><strong>{(detail.loan.annualRateBp / 100).toFixed(2)}%</strong></article>
              <article><span>Term</span><strong>{detail.loan.termMonths} months</strong></article>
            </div>
            <LoanWhyPanel detail={detail} />
            <section className="entity-panel">
              <h2>Payment schedule</h2>
              <div className="market-table-wrap">
                <table className="market-table">
                  <thead><tr><th>Installment</th><th>Due tick</th><th>Principal</th><th>Interest</th><th>Status</th></tr></thead>
                  <tbody>
                    {detail.schedule.map((installment) => (
                      <tr key={installment.installmentNumber}>
                        <th>{installment.installmentNumber}</th>
                        <td>{installment.dueTick ?? "Opening history"}</td>
                        <td>{formatCents(installment.principalDueCents)}</td>
                        <td>{formatCents(installment.interestDueCents)}</td>
                        <td><StatusPill status={installment.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </section>
    </div>
  );
}

export function AgentDetailPage() {
  const { simId = "invalid", agentId = "invalid" } = useParams();
  const { api, token } = useAppSession();
  const profile = useQuery({ queryKey: ["agent", simId, agentId, token], queryFn: ({ signal }) => api.getAgent(simId, agentId, undefined, signal) });
  const finances = useQuery({ queryKey: ["agent-finances", simId, agentId, token], queryFn: ({ signal }) => api.getAgentFinances(simId, agentId, undefined, signal) });
  const error = profile.error ?? finances.error;
  return (
    <div className="explorer-page"><WorldExplorerHeader simulationId={simId} title="Citizen record" subtitle="Persona, current employment, accounts, income, spending, and evidence." /><section className="explorer-content">
      {profile.isPending || finances.isPending ? <LoadingPanel label="Reading citizen state…" /> : null}
      {error === null ? null : <DetailError error={error} retry={() => { void Promise.all([profile.refetch(), finances.refetch()]); }} />}
      {profile.data === undefined || finances.data === undefined ? null : <>
        <header className="entity-heading"><div><p className="eyebrow"><UserRound size={16} /> {profile.data.agent.occupation.replaceAll("_", " ")}</p><h1>{profile.data.agent.name}</h1></div><StatusPill status={profile.data.agent.employmentStatus} /><p>Age {profile.data.agent.age} · {profile.data.agent.education} · credit {profile.data.agent.creditScore}</p></header>
        <div className="entity-two-column"><section className="entity-panel"><h2>Profile</h2><p>{profile.data.agent.bioSummary}</p><dl className="explorer-dl"><div><dt>Annual income</dt><dd>{formatCents(profile.data.agent.annualIncome.cents)}</dd></div><div><dt>Role</dt><dd>{profile.data.agent.roleCode}</dd></div><div><dt>Organization</dt><dd>{profile.data.agent.organizationId ?? "Independent"}</dd></div><div><dt>Household</dt><dd>{profile.data.agent.householdId}</dd></div></dl></section><section className="entity-panel"><h2>Skills & goals</h2><pre>{JSON.stringify({ skills: profile.data.agent.skills, goals: profile.data.agent.goals }, null, 2)}</pre></section></div>
        <section className="entity-panel"><h2><Banknote size={19} /> Employment & finances</h2><AgentFinancePanel finances={finances.data} /></section>
      </>}
    </section></div>
  );
}
