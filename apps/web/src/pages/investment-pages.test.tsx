// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evidencePathResponseSchema,
  investmentDistributionDetailResponseSchema,
  investmentDistributionListResponseSchema,
  investmentListResponseSchema,
  investmentProposalDetailResponseSchema,
  investmentProposalListResponseSchema,
  simulationStatusResponseSchema,
} from "@worldtangle/shared";
import { App } from "../app";

const meta = { simulated: true, apiVersion: 1 } as const;
const spend = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costCentsEstimate: "0",
};

function statusPayload(simulationId: string) {
  return simulationStatusResponseSchema.parse({
    run: {
      id: simulationId.replace("sim_", "run_"),
      status: "paused",
      currentTick: 42,
      simDate: "Y0001-M02-D13",
      endTick: 360,
    },
    tickRate: { ticksPerSec: 0 },
    llm: {
      mode: "mock",
      spend,
      budgetPct: 0,
      cacheHitRate: 0,
      enabled: true,
      effectiveTier: 3,
      autoPaused: false,
      frozenModules: [],
      limits: { runCostCentsMax: "500", perAgentDailyTokens: 128000 },
    },
    errors: { last24Ticks: 0 },
    activity: {
      committedEvents: 80,
      latestEventSeq: 79,
      latestDigest: null,
    },
    task: null,
    meta,
  });
}

const proposal = {
  id: "prop_00000001",
  company: { id: "co_00000001", name: "Northstar Foods" },
  founder: { id: "agt_00000001", name: "Ada Reed" },
  firm: { id: "inst_venture_firm", name: "Riverbend Ventures" },
  fund: { id: "vfund_00000001", name: "Civic Seed Fund" },
  vcPartner: { id: "agt_00000002", name: "Lin Park" },
  askAmountCents: "25000000",
  preMoneyValuationCents: "100000000",
  initialEquityBasisPoints: 2000,
  status: "completed",
  conversationId: "cnv_00000001",
  finalTerms: {
    kind: "investment",
    referenceId: "prop_00000001",
    amountCents: "20000000",
    preMoneyValuationCents: "100000000",
    equityBasisPoints: 1667,
  },
  proposedTick: 30,
  expiresTick: 60,
  investmentId: "inv_00000001",
  sourceEventId: "evt_00000001",
  lastTransitionEventId: "evt_00000004",
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WS-805 investment React routes", () => {
  it("shows a retryable error when the durable run cannot be loaded", async () => {
    const simulationId = "sim_00000008";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "SERVICE_UNAVAILABLE",
      message: "Run status is temporarily unavailable.",
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })));
    window.history.pushState(
      {},
      "",
      `/simulations/${simulationId}/investment-proposals/${proposal.id}`,
    );

    render(<App />);

    expect(await screen.findByText(
      "Investment evidence is unavailable",
      {},
      { timeout: 4_000 },
    )).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/reconstructing proposal evidence/i)).toBeNull();
  });

  it("renders proposal, close, and distribution lists from run-bound contracts", async () => {
    const simulationId = "sim_00000009";
    const proposals = investmentProposalListResponseSchema.parse({
      items: [proposal],
      nextCursor: null,
      meta,
    });
    const investments = investmentListResponseSchema.parse({
      items: [{
        id: "inv_00000001",
        proposalId: proposal.id,
        company: proposal.company,
        firm: proposal.firm,
        investor: proposal.fund,
        amountCents: "20000000",
        preMoneyValuationCents: "100000000",
        sharesIssued: "200000",
        totalSharesBefore: "1000000",
        totalSharesAfter: "1200000",
        pricePerShareCents: "100",
        ownershipBasisPoints: 1666,
        completedTick: 36,
        sourceEventId: "evt_00000004",
      }],
      nextCursor: null,
      meta,
    });
    const distributions = investmentDistributionListResponseSchema.parse({
      items: [{
        id: "dist_00000001",
        company: proposal.company,
        amountCents: "1200000",
        totalShares: "1200000",
        referenceId: proposal.id,
        distributedTick: 41,
        transactionId: "txn_00000001",
        allocationCount: 2,
        requestEventId: "evt_00000005",
        sourceEventId: "evt_00000006",
      }],
      nextCursor: null,
      meta,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.includes("/status")
        ? statusPayload(simulationId)
        : path.includes("/investment-proposals")
          ? proposals
          : path.includes("/investment-distributions")
            ? distributions
            : investments;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    window.history.pushState({}, "", `/simulations/${simulationId}/world/investments`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Investment evidence" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Proposals" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Investments" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Distributions" })).toBeTruthy();
    expect(await screen.findAllByText("Northstar Foods")).toHaveLength(3);
    const investmentLink = screen.getAllByRole("link", {
      name: /Northstar Foods.*Civic Seed Fund/i,
    }).find((link) => link.getAttribute("href")?.includes("/investments/"));
    expect(investmentLink?.getAttribute("href")).toContain("/investments/inv_00000001");
  });

  it("renders proposal terms beside explicit three-lane evidence states", async () => {
    const simulationId = "sim_00000010";
    const detail = investmentProposalDetailResponseSchema.parse({
      proposal,
      conversation: {
        id: "cnv_00000001",
        status: "concluded",
        turns: 2,
        maxTurns: 6,
        closeReason: "agreement",
        outcomeKind: "agreement",
        startTick: 30,
        endTick: 35,
        sourceEventId: "evt_00000002",
      },
      termsDiff: {
        initial: {
          amountCents: proposal.askAmountCents,
          preMoneyValuationCents: proposal.preMoneyValuationCents,
          equityBasisPoints: proposal.initialEquityBasisPoints,
        },
        final: {
          amountCents: proposal.finalTerms.amountCents,
          preMoneyValuationCents: proposal.finalTerms.preMoneyValuationCents,
          equityBasisPoints: proposal.finalTerms.equityBasisPoints,
        },
        amountDeltaCents: "-5000000",
        preMoneyDeltaCents: "0",
        equityDeltaBasisPoints: -333,
      },
      decision: {
        status: "completed",
        rejectionReason: null,
        validation: null,
        eventId: "evt_00000004",
        causationId: "evt_00000003",
        evidenceEventIds: ["evt_00000003"],
      },
      timeline: [{
        eventId: "evt_00000004",
        tick: 36,
        type: "investment.completed",
        actor: { kind: "system", id: "investment_closer" },
        correlationId: proposal.id,
        causationId: "evt_00000003",
        evidenceEventIds: ["evt_00000003"],
      }],
      meta,
    });
    const evidence = evidencePathResponseSchema.parse({
      correlationId: proposal.id,
      origin: {
        state: "booked",
        label: "Origin event",
        explanation: "The exact proposal event is stored.",
        items: [{
          kind: "event",
          id: "evt_00000001",
          label: "Investment proposed",
          tick: 30,
          eventId: "evt_00000001",
          correlationId: proposal.id,
        }],
      },
      booked: {
        state: "booked",
        label: "Booked state",
        explanation: "Cash and ownership were booked.",
        items: [{
          kind: "investment",
          id: "inv_00000001",
          label: "Investment close booked",
          tick: 36,
          eventId: "evt_00000004",
          correlationId: proposal.id,
        }],
      },
      downstream: {
        state: "no_effect",
        label: "Downstream effect",
        explanation: "No later effect was observed.",
        items: [],
      },
      meta,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.includes("/status")
        ? statusPayload(simulationId)
        : path.includes("/evidence-paths/")
          ? evidence
          : detail;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    window.history.pushState(
      {},
      "",
      `/simulations/${simulationId}/investment-proposals/${proposal.id}`,
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Northstar Foods" })).toBeTruthy();
    expect(screen.getByText("Initial terms")).toBeTruthy();
    expect(screen.getByText("Final terms")).toBeTruthy();
    expect(await screen.findByText("No effect observed")).toBeTruthy();
    const originLink = screen.getByRole("link", { name: /Investment proposed/i })
      .getAttribute("href");
    expect(originLink).toContain(`correlation=${proposal.id}`);
    expect(originLink).toContain("fromTick=30");
    expect(originLink).toContain("toTick=30");
    expect(originLink).toContain("focusId=evt_00000001");
    expect(screen.getByRole("link", { name: /Investment close booked/i })
      .getAttribute("href")).toContain("/investments/inv_00000001");
  });

  it("renders an exact distribution allocation and cap-table handoff", async () => {
    const simulationId = "sim_00000011";
    const distributionId = "dist_00000001";
    const detail = investmentDistributionDetailResponseSchema.parse({
      distribution: {
        id: distributionId,
        company: proposal.company,
        amountCents: "1200000",
        totalShares: "1200000",
        referenceId: proposal.id,
        distributedTick: 41,
        transactionId: "txn_00000001",
        allocationCount: 2,
        requestEventId: "evt_00000005",
        sourceEventId: "evt_00000006",
        companyAccountId: "acct_company_operating",
        allocations: [{
          allocationIndex: 0,
          holder: { kind: "agent", id: "agt_00000001", name: "Ada Reed" },
          shares: "1000000",
          amountCents: "1000000",
          accountId: "acct_founder_checking",
          ownershipBasisPoints: 8333,
        }, {
          allocationIndex: 1,
          holder: {
            kind: "venture_fund",
            id: "vfund_00000001",
            name: "Civic Seed Fund",
          },
          shares: "200000",
          amountCents: "200000",
          accountId: "acct_fund_checking",
          ownershipBasisPoints: 1667,
        }],
      },
      meta,
    });
    const evidence = evidencePathResponseSchema.parse({
      correlationId: proposal.id,
      origin: {
        state: "booked",
        label: "Origin event",
        explanation: "The distribution request is stored.",
        items: [],
      },
      booked: {
        state: "booked",
        label: "Booked state",
        explanation: "The distribution transaction is stored.",
        items: [],
      },
      downstream: {
        state: "no_effect",
        label: "Downstream effect",
        explanation: "No later observation is stored.",
        items: [],
      },
      meta,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.includes("/status")
        ? statusPayload(simulationId)
        : path.includes("/evidence-paths/")
          ? evidence
          : detail;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    window.history.pushState(
      {},
      "",
      `/simulations/${simulationId}/investment-distributions/${distributionId}`,
    );

    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Northstar Foods distribution",
    })).toBeTruthy();
    expect(screen.getByText("Ada Reed")).toBeTruthy();
    expect(screen.getByText("Civic Seed Fund")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Cap table" }).getAttribute("href"))
      .toBe(`/simulations/${simulationId}/companies/${proposal.company.id}/cap-table`);
  });
});
