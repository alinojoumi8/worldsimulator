import type {
  BankListResponse,
  IndicatorSeriesResponse,
  LoanDetailResponse,
  LoanListResponse,
} from "@worldtangle/shared";
import { BadgeDollarSign, Landmark, Scale, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { IndicatorSparkline } from "./indicator-sparkline";
import { StatusPill } from "./ui";
import { formatCents } from "./world-explorer-ui";

function indicator(
  indicators: IndicatorSeriesResponse,
  name: "creditOutstanding" | "defaultRate",
  unit: "cents" | "bp",
): IndicatorSeriesResponse["series"][number] {
  return indicators.series.find((series) => series.name === name) ?? { name, unit, points: [] };
}

export function CreditDashboard({
  simulationId,
  banks,
  loans,
  indicators,
}: {
  readonly simulationId: string;
  readonly banks: BankListResponse;
  readonly loans: LoanListResponse;
  readonly indicators: IndicatorSeriesResponse;
}) {
  return (
    <div className="credit-dashboard">
      <div className="credit-indicator-grid" aria-label="Credit indicators">
        <IndicatorSparkline
          series={indicator(indicators, "creditOutstanding", "cents")}
          label="Credit outstanding"
          description="Gross stored principal still owed"
          tone="blue"
        />
        <IndicatorSparkline
          series={indicator(indicators, "defaultRate", "bp")}
          label="Default rate"
          description="Recorded defaults as a share of all loans"
          tone="rust"
        />
      </div>

      <section className="entity-panel">
        <h2><Landmark size={19} /> Banks</h2>
        <div className="explorer-card-grid">
          {banks.items.map((bank) => (
            <Link
              className="explorer-card"
              key={bank.id}
              to={`/simulations/${simulationId}/banks/${bank.id}`}
            >
              <div className="explorer-card__title"><Landmark size={19} /><h3>{bank.name}</h3></div>
              <StatusPill status={bank.lendingHalted ? "lending halted" : "active"} />
              <dl className="explorer-dl">
                <div><dt>Deposits</dt><dd>{formatCents(bank.totalDeposits)}</dd></div>
                <div><dt>Loans</dt><dd>{formatCents(bank.totalLoans)}</dd></div>
                <div><dt>Capital ratio</dt><dd>{(bank.capitalRatioBp / 100).toFixed(2)}%</dd></div>
                <div><dt>Reserve ratio</dt><dd>{(bank.reserveRatioBp / 100).toFixed(2)}%</dd></div>
              </dl>
            </Link>
          ))}
        </div>
      </section>

      <section className="entity-panel">
        <h2><BadgeDollarSign size={19} /> Loan book</h2>
        <div className="market-table-wrap">
          <table className="market-table credit-loan-table">
            <thead>
              <tr><th>Borrower</th><th>Origin</th><th>Outstanding</th><th>Rate</th><th>Status</th></tr>
            </thead>
            <tbody>
              {loans.items.map((loan) => (
                <tr key={loan.id}>
                  <th>
                    <Link to={`/simulations/${simulationId}/loans/${loan.id}`}>
                      {loan.borrower.name}
                    </Link>
                    <small>{loan.purpose.replaceAll("_", " ")}</small>
                  </th>
                  <td>{loan.origin === "opening_seed" ? "Opening state" : `Tick ${loan.openedTick}`}</td>
                  <td>{formatCents(loan.outstandingPrincipalCents)}</td>
                  <td>{(loan.annualRateBp / 100).toFixed(2)}%</td>
                  <td><StatusPill status={loan.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
function EvidenceList({ evidence }: { readonly evidence: readonly string[] }) {
  return (
    <ul className="evidence-list">
      {evidence.map((reference) => <li key={reference}><code>{reference}</code></li>)}
    </ul>
  );
}

export function LoanWhyPanel({ detail }: { readonly detail: LoanDetailResponse }) {
  const why = detail.why;
  if (why.kind === "opening_seed") {
    return (
      <section className="entity-panel loan-why-panel" aria-label="Loan why-panel">
        <h2><ShieldCheck size={19} /> Opening-state why-panel</h2>
        <p>{why.explanation}</p>
        <dl className="explorer-dl">
          <div><dt>Seasoned months</dt><dd>{why.seasonedMonths}</dd></div>
          <div><dt>Missed payments</dt><dd>{why.missedPayments}</dd></div>
          <div><dt>Schedule digest</dt><dd><code>{why.scheduleDigest}</code></dd></div>
          <div><dt>Recognition transaction</dt><dd><code>{why.recognitionTransactionId}</code></dd></div>
          <div><dt>Bank asset account</dt><dd><code>{why.bankAssetAccountId}</code></dd></div>
          <div><dt>Borrower account</dt><dd><code>{why.borrowerDepositAccountId}</code></dd></div>
          <div><dt>Seed event</dt><dd><code>{why.sourceEventId}</code></dd></div>
          <div><dt>Caused by</dt><dd><code>{why.causationId}</code></dd></div>
          <div><dt>Correlation</dt><dd><code>{why.correlationId}</code></dd></div>
        </dl>
        <h3>Evidence</h3>
        <EvidenceList evidence={why.evidence} />
      </section>
    );
  }

  return (
    <section className="entity-panel loan-why-panel" aria-label="Loan why-panel">
      <h2><Scale size={19} /> Underwriting why-panel</h2>
      <p>{why.explanation}</p>
      <div className="entity-two-column">
        <section>
          <h3>Application & stored score inputs</h3>
          <dl className="explorer-dl">
            <div><dt>Requested</dt><dd>{formatCents(why.application.amountCents)}</dd></div>
            <div><dt>Term</dt><dd>{why.application.termMonths} months</dd></div>
            <div><dt>Annual income</dt><dd>{formatCents(why.assessment.inputs.annualIncomeCents)}</dd></div>
            <div><dt>Annual debt service</dt><dd>{formatCents(why.assessment.inputs.annualDebtServiceCents)}</dd></div>
            <div><dt>Existing debt</dt><dd>{formatCents(why.assessment.inputs.existingDebtCents)}</dd></div>
            <div><dt>Debt-to-income</dt><dd>{(why.assessment.inputs.debtToIncomeBp / 100).toFixed(2)}%</dd></div>
            <div><dt>History score</dt><dd>{(why.assessment.inputs.historyScoreBp / 100).toFixed(2)}%</dd></div>
            <div><dt>No history</dt><dd>{why.assessment.inputs.noHistory ? "Yes" : "No"}</dd></div>
          </dl>
        </section>
        <section>
          <h3>Score & officer review</h3>
          <dl className="explorer-dl">
            <div><dt>Model version</dt><dd>{why.assessment.modelVersion}</dd></div>
            <div><dt>System score</dt><dd>{why.assessment.systemScore}</dd></div>
            <div><dt>Income points</dt><dd>{why.assessment.breakdown.incomeStabilityPoints}</dd></div>
            <div><dt>DTI points</dt><dd>{why.assessment.breakdown.debtToIncomePoints}</dd></div>
            <div><dt>History points</dt><dd>{why.assessment.breakdown.historyPoints}</dd></div>
            <div><dt>Review tier</dt><dd>{why.review.reviewTier}</dd></div>
            <div><dt>Officer adjustment</dt><dd>{why.decision.officerAdjustment}</dd></div>
            <div><dt>Final score</dt><dd>{why.decision.finalScore}</dd></div>
            <div><dt>Outcome</dt><dd><StatusPill status={why.decision.outcome} /></dd></div>
          </dl>
          <blockquote>{why.decision.rationale}</blockquote>
        </section>
      </div>

      <h3>Policy checks</h3>
      <div className="policy-check-grid">
        {why.decision.policyChecks.map((check) => (
          <article key={check.id} className={check.passed ? "policy-check policy-check--pass" : "policy-check policy-check--fail"}>
            <strong>{check.id.replaceAll("_", " ")}</strong>
            <span>{check.actual} {check.comparator} {check.threshold}</span>
            <StatusPill status={check.passed ? "passed" : "failed"} />
            <EvidenceList evidence={check.evidenceRefs} />
          </article>
        ))}
      </div>

      <h3>Bank circuit assessments</h3>
      {why.circuitAssessments.map((assessment) => (
        <article className="circuit-assessment" key={assessment.id}>
          <div><strong>{assessment.stage}</strong><StatusPill status={assessment.allowed ? "allowed" : "blocked"} /></div>
          <dl className="explorer-dl">
            <div><dt>Projected reserve ratio</dt><dd>{(assessment.projectedReserveRatioBp / 100).toFixed(2)}%</dd></div>
            <div><dt>Projected capital ratio</dt><dd>{(assessment.projectedCapitalRatioBp / 100).toFixed(2)}%</dd></div>
            <div><dt>Projected exposure</dt><dd>{formatCents(assessment.projectedBorrowerExposureCents)}</dd></div>
            <div><dt>Exposure cap</dt><dd>{formatCents(assessment.borrowerExposureCapCents)}</dd></div>
            <div><dt>Failed breakers</dt><dd>{assessment.failedBreakers.join(", ") || "None"}</dd></div>
            <div><dt>Evidence event</dt><dd><code>{assessment.sourceEventId}</code></dd></div>
          </dl>
        </article>
      ))}

      {why.default === null ? null : (
        <section className="default-record">
          <h3>Default outcome</h3>
          <p>Defaulted at tick {why.default.defaultTick} after {why.default.missedInstallmentIds.length} stored misses.</p>
          <code>{why.default.sourceEventId}</code>
        </section>
      )}
      <h3>Complete evidence chain</h3>
      <EvidenceList evidence={why.evidence} />
    </section>
  );
}
