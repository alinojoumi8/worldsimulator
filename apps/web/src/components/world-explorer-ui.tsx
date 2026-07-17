import type {
  AgentFinancesResponse,
  CompanyDetailResponse,
} from "@worldtangle/shared";
import { ArrowLeft, Waypoints } from "lucide-react";
import { Link, NavLink } from "react-router-dom";

export type WorldSection =
  | "companies"
  | "jobs"
  | "contracts"
  | "institutions"
  | "market"
  | "credit"
  | "agents";

const SECTIONS: readonly { readonly id: WorldSection; readonly label: string }[] = [
  { id: "companies", label: "Companies" },
  { id: "jobs", label: "Jobs" },
  { id: "contracts", label: "Contracts" },
  { id: "institutions", label: "Institutions" },
  { id: "market", label: "Goods market" },
  { id: "credit", label: "Credit" },
  { id: "agents", label: "Citizens" },
] as const;

export function formatCents(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const whole = digits.length <= 2 ? "0" : digits.slice(0, -2);
  const fraction = digits.padStart(2, "0").slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}$${grouped}.${fraction}`;
}

export function WorldExplorerHeader({
  simulationId,
  title = "Riverbend world explorer",
  subtitle = "Follow companies, work, agreements, institutions, and prices back to committed evidence.",
}: {
  readonly simulationId: string;
  readonly title?: string;
  readonly subtitle?: string;
}) {
  return (
    <>
      <div className="explorer-breadcrumb">
        <Link to={`/simulations/${simulationId}`}><ArrowLeft size={16} /> Run cockpit</Link>
      </div>
      <header className="explorer-header">
        <p className="eyebrow"><Waypoints size={16} /> Inspectable economy</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </header>
      <nav className="world-nav" aria-label="World explorer">
        {SECTIONS.map((section) => (
          <NavLink
            key={section.id}
            to={`/simulations/${simulationId}/world/${section.id}`}
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function EmptyWorldState({ children }: { readonly children: string }) {
  return <div className="world-empty"><Waypoints size={24} /><p>{children}</p></div>;
}

export function CompanyTimeline({
  timeline,
}: {
  readonly timeline: CompanyDetailResponse["timeline"];
}) {
  return (
    <ol className="company-timeline" aria-label="Company causal timeline">
      {timeline.map((item) => (
        <li key={item.id}>
          <span className="company-timeline__tick">Tick {item.tick}</span>
          <div>
            <strong>{item.type}</strong>
            <p>{item.referenceId ?? "State milestone"}</p>
            {item.sourceEventId === null ? null : <code>{item.sourceEventId}</code>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function AgentFinancePanel({
  finances,
}: {
  readonly finances: AgentFinancesResponse;
}) {
  const income = finances.income.last30Ticks;
  const expenses = finances.expenses.last30Ticks;
  return (
    <div className="finance-readout">
      <section>
        <p className="eyebrow">Employment</p>
        {finances.employment === null ? <p>Not currently employed.</p> : (
          <dl className="explorer-dl">
            <div><dt>Employer</dt><dd>{finances.employment.employer.name}</dd></div>
            <div><dt>Role</dt><dd>{finances.employment.title}</dd></div>
            <div><dt>Annual wage</dt><dd>{formatCents(finances.employment.wage)}</dd></div>
            <div><dt>Contract</dt><dd><code>{finances.employment.contractId}</code></dd></div>
          </dl>
        )}
      </section>
      <section>
        <p className="eyebrow">Accounts</p>
        <dl className="explorer-dl">
          {finances.accounts.map((account) => (
            <div key={account.id}>
              <dt>{account.bank} · {account.type}</dt>
              <dd>{formatCents(account.balance)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <p className="eyebrow">Last 30 ticks</p>
        <dl className="explorer-dl">
          <div><dt>Salary</dt><dd>{formatCents(income.salary)}</dd></div>
          <div><dt>Benefits</dt><dd>{formatCents(income.benefits)}</dd></div>
          <div><dt>Subsistence</dt><dd>{formatCents(expenses.subsistence)}</dd></div>
          <div><dt>Discretionary</dt><dd>{formatCents(expenses.discretionary)}</dd></div>
          <div><dt>Rent</dt><dd>{formatCents(expenses.rent)}</dd></div>
          <div><dt>Utilities</dt><dd>{formatCents(expenses.utilities)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
