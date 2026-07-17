// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  loanDetailResponseSchema,
  loanListResponseSchema,
  type BankListResponse,
  type IndicatorSeriesResponse,
  type LoanDetailResponse,
} from "@worldtangle/shared";
import { CreditDashboard, LoanWhyPanel } from "./credit-ui";

const meta = { simulated: true, apiVersion: 1 } as const;
const event = (index: number) => `evt_${index.toString(36).padStart(8, "0")}`;

function commonLoan() {
  return {
    id: "loan_00000009",
    origin: "originated" as const,
    borrower: { kind: "agent" as const, id: "agt_00000009", name: "Mara Vale" },
    bank: { id: "bank_00000001", name: "First Ledger Bank" },
    purpose: "Replace a failed vehicle",
    principalCents: "600001",
    outstandingPrincipalCents: "600001",
    annualRateBp: 700,
    termMonths: 12,
    status: "disbursed" as const,
    openedTick: 4,
    progress: {
      completedInstallments: 0,
      missedInstallments: 0,
      totalInstallments: 12,
      nextDueTick: 34,
    },
    sourceEventId: event(20),
  };
}

function circuit(stage: "approval" | "disbursement", index: number) {
  return {
    id: `bca_${index.toString(36).padStart(8, "0")}`,
    runId: "run_00000001",
    bankId: "bank_00000001",
    applicationId: "loanapp_00000001",
    decisionId: stage === "approval" ? null : "loandec_00000001",
    stage,
    borrowerKind: "agent" as const,
    borrowerId: "agt_00000009",
    assessedTick: stage === "approval" ? 3 : 4,
    policyVersion: 1 as const,
    bankStatusBefore: "active" as const,
    bankStatusAfter: "active" as const,
    depositCents: "1000000",
    projectedDepositCents: "1600001",
    reserveCents: "500000",
    reserveRatioBp: 5_000,
    projectedReserveRatioBp: 3_125,
    reserveRatioMinBp: 1_000,
    effectiveCapitalCents: "1000000",
    capitalRatioBp: 10_000,
    projectedCapitalRatioBp: 6_250,
    capitalRatioMinBp: 800,
    borrowerExposureCents: "0",
    projectedBorrowerExposureCents: "600001",
    borrowerExposureCapCents: "1000000",
    requestedAmountCents: "600001",
    bankOpen: true,
    reservePassed: true,
    capitalPassed: true,
    exposurePassed: true,
    systemicPassed: true,
    allowed: true,
    failedBreakers: [],
    sourceEventId: event(10 + index),
  };
}

function underwrittenDetail(): LoanDetailResponse {
  const checks = [
    ["minimum_score", "gte", "850", "620"],
    ["maximum_dti", "lte", "1200", "4500"],
    ["maximum_term", "lte", "12", "60"],
    ["borrower_exposure", "lte", "600001", "1000000"],
    ["bank_status", "eq", "active", "active"],
    ["minimum_capital_ratio", "gte", "6250", "800"],
  ].map(([id, comparator, actual, threshold], index) => ({
    id,
    comparator,
    actual,
    threshold,
    passed: true,
    evidenceRefs: [event(30 + index)],
  }));
  return loanDetailResponseSchema.parse({
    loan: {
      ...commonLoan(),
      disbursedTick: 4,
      maturityTick: 364,
      scheduleDigest: "a".repeat(64),
      bankAssetAccountId: "acct_00000011",
      borrowerDepositAccountId: "acct_00000012",
      recognitionTransactionId: "txn_00000011",
    },
    schedule: [{
      installmentNumber: 1,
      dueTick: 34,
      principalDueCents: "50000",
      interestDueCents: "3500",
      totalDueCents: "53500",
      status: "due",
      paidTick: null,
      transactionId: null,
      sourceEventId: event(21),
    }],
    why: {
      kind: "underwritten",
      explanation: "Stored score and six policy checks approved this loan.",
      application: {
        id: "loanapp_00000001",
        runId: "run_00000001",
        applicantKind: "agent",
        applicantId: "agt_00000009",
        bankId: "bank_00000001",
        purpose: "Replace a failed vehicle",
        amountCents: "600001",
        termMonths: 12,
        status: "approved",
        submittedTick: 1,
        decidedTick: 3,
        sourceEventId: event(1),
      },
      assessment: {
        id: "cscore_00000001",
        runId: "run_00000001",
        applicationId: "loanapp_00000001",
        modelVersion: 1,
        inputs: {
          modelVersion: 1,
          annualIncomeCents: "5000000",
          annualDebtServiceCents: "600000",
          existingDebtCents: "0",
          requestedAmountCents: "600001",
          termMonths: 12,
          incomeStabilityBp: 10_000,
          debtToIncomeBp: 1_200,
          historyScoreBp: 5_000,
          completedPayments: 0,
          missedPayments: 0,
          defaults: 0,
          noHistory: true,
          incomeEvidenceRefs: [event(1)],
          debtEvidenceRefs: [event(2)],
        },
        systemScore: 850,
        breakdown: {
          basePoints: 300,
          incomeStabilityPoints: 200,
          debtToIncomePoints: 200,
          historyPoints: 150,
          totalPoints: 850,
        },
        computedTick: 1,
        sourceEventId: event(2),
      },
      review: {
        id: "loanrev_00000001",
        runId: "run_00000001",
        applicationId: "loanapp_00000001",
        officerAgentId: "agt_00000001",
        reviewTier: "tier1",
        startedTick: 2,
        sourceEventId: event(3),
      },
      decision: {
        id: "loandec_00000001",
        runId: "run_00000001",
        applicationId: "loanapp_00000001",
        assessmentId: "cscore_00000001",
        reviewId: "loanrev_00000001",
        officerAgentId: "agt_00000001",
        reviewTier: "tier1",
        agentDecisionId: null,
        policyVersion: 1,
        systemScore: 850,
        officerAdjustment: 0,
        finalScore: 850,
        rationale: "All stored policy checks passed without discretionary adjustment.",
        policyChecks: checks,
        outcome: "approved",
        offeredRateBp: 700,
        decidedTick: 3,
        sourceEventId: event(4),
      },
      circuitAssessments: [circuit("approval", 1), circuit("disbursement", 2)],
      default: null,
      evidence: [event(1), event(2), event(3), event(4), event(20)],
    },
    meta,
  });
}

function openingDetail(): LoanDetailResponse {
  return loanDetailResponseSchema.parse({
    loan: {
      ...commonLoan(),
      id: "loan_00000001",
      origin: "opening_seed",
      borrower: { kind: "business", id: "biz_ironvale", name: "Ironvale" },
      purpose: "working_capital",
      principalCents: "30000000",
      outstandingPrincipalCents: "11666662",
      annualRateBp: 650,
      termMonths: 36,
      status: "current",
      openedTick: 0,
      progress: { completedInstallments: 22, missedInstallments: 0, totalInstallments: 36, nextDueTick: null },
      sourceEventId: event(40),
      disbursedTick: null,
      maturityTick: null,
      scheduleDigest: "b".repeat(64),
      bankAssetAccountId: "acct_00000021",
      borrowerDepositAccountId: "acct_00000022",
      recognitionTransactionId: "txn_00000021",
    },
    schedule: [{
      installmentNumber: 1,
      dueTick: null,
      principalDueCents: "833333",
      interestDueCents: "162500",
      totalDueCents: "995833",
      status: "paid",
      paidTick: null,
      transactionId: null,
      sourceEventId: null,
    }],
    why: {
      kind: "opening_seed",
      explanation: "Opening credit was imported at tick 0 after 22 months.",
      seasonedMonths: 22,
      missedPayments: 0,
      recognitionTransactionId: "txn_00000021",
      bankAssetAccountId: "acct_00000021",
      borrowerDepositAccountId: "acct_00000022",
      scheduleDigest: "b".repeat(64),
      sourceEventId: event(40),
      causationId: event(39),
      correlationId: "loan:loan_00000001",
      evidence: [event(39), "txn_00000021"],
    },
    meta,
  });
}

describe("WS-507 credit explorer components", () => {
  afterEach(cleanup);

  it("renders bank figures, authoritative credit indicators, and loan links", () => {
    const banks: BankListResponse = {
      items: [{
        id: "bank_00000001",
        name: "First Ledger Bank",
        totalDeposits: "528000000",
        totalLoans: "600001",
        capitalRatioBp: 1_800,
        reserveRatioBp: 1_500,
        lendingHalted: false,
      }],
      nextCursor: null,
      meta,
    };
    const loans = loanListResponseSchema.parse({
      items: [commonLoan()],
      nextCursor: null,
      meta,
    });
    const indicators: IndicatorSeriesResponse = {
      series: [
        { name: "creditOutstanding", unit: "cents", points: [[0, "100000"], [4, "600001"]] },
        { name: "defaultRate", unit: "bp", points: [[0, 0], [4, 1250]] },
      ],
      meta,
    };
    render(
      <MemoryRouter>
        <CreditDashboard
          simulationId="sim_00000001"
          banks={banks}
          loans={loans}
          indicators={indicators}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Banks" })).toBeTruthy();
    expect(screen.getByText("First Ledger Bank")).toBeTruthy();
    expect(screen.getAllByText("$6,000.01")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Credit outstanding from tick 0 through tick 4" }))
      .toBeTruthy();
    expect(screen.getByRole("link", { name: "Mara Vale" }).getAttribute("href"))
      .toBe("/simulations/sim_00000001/loans/loan_00000009");
  });

  it("renders all stored underwriting checks and both circuit assessments", () => {
    render(<LoanWhyPanel detail={underwrittenDetail()} />);
    expect(screen.getByRole("heading", { name: "Underwriting why-panel" })).toBeTruthy();
    expect(screen.getByText("All stored policy checks passed without discretionary adjustment."))
      .toBeTruthy();
    expect(screen.getByText("minimum score")).toBeTruthy();
    expect(screen.getByText("minimum capital ratio")).toBeTruthy();
    expect(screen.getByText("approval")).toBeTruthy();
    expect(screen.getByText("disbursement")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Complete evidence chain" })).toBeTruthy();
  });

  it("renders opening-loan ledger provenance without inventing underwriting", () => {
    render(<LoanWhyPanel detail={openingDetail()} />);
    expect(screen.getByRole("heading", { name: "Opening-state why-panel" })).toBeTruthy();
    expect(screen.getAllByText("txn_00000021").length).toBeGreaterThan(0);
    expect(screen.getByText(event(40))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Policy checks" })).toBeNull();
  });
});
