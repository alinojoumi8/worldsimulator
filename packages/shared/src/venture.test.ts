import { describe, expect, it } from "vitest";
import {
  capTableSnapshotSchema,
  investmentEquityBasisPoints,
  investmentProposalSchema,
  investmentStructuredTermsSchema,
  ownershipStakeSchema,
  ventureFundDeploymentSchema,
  ventureFundSchema,
} from "./venture";

describe("venture contracts", () => {
  it("accepts exact fund and deployment states for opening and formed companies", () => {
    expect(ventureFundSchema.parse({
      id: "vfund_00000001",
      runId: "run_00000001",
      firmId: "inst_foundry_capital",
      bankAccountId: "acct_00000001",
      name: "Foundry Fund I",
      fundSizeCents: "100",
      deployedCents: "25",
      status: "open",
      createdTick: 0,
      sourceEventId: "evt_00000001",
    }).deployedCents).toBe("25");
    for (const targetCompanyId of ["biz_ironvale", "co_00000001"]) {
      expect(ventureFundDeploymentSchema.parse({
        id: "vdep_00000001",
        runId: "run_00000001",
        fundId: "vfund_00000001",
        targetCompanyId,
        referenceId: `investment:${targetCompanyId}`,
        amountCents: "25",
        deployedBeforeCents: "0",
        deployedAfterCents: "25",
        deployedTick: 1,
        sourceEventId: "evt_00000002",
      }).targetCompanyId).toBe(targetCompanyId);
    }
  });

  it("rejects over-deployed funds and inconsistent deployment chains", () => {
    expect(() => ventureFundSchema.parse({
      id: "vfund_00000001",
      runId: "run_00000001",
      firmId: "inst_foundry_capital",
      bankAccountId: "acct_00000001",
      name: "Foundry Fund I",
      fundSizeCents: "100",
      deployedCents: "101",
      status: "open",
      createdTick: 0,
      sourceEventId: "evt_00000001",
    })).toThrow(/cannot exceed/);
    expect(() => ventureFundDeploymentSchema.parse({
      id: "vdep_00000001",
      runId: "run_00000001",
      fundId: "vfund_00000001",
      targetCompanyId: "biz_ironvale",
      referenceId: "investment:bad-chain",
      amountCents: "25",
      deployedBeforeCents: "10",
      deployedAfterCents: "34",
      deployedTick: 1,
      sourceEventId: "evt_00000002",
    })).toThrow(/must equal/);
  });

  it("validates investment proposal terms, lifecycle shape, and exact price math", () => {
    const equityBasisPoints = investmentEquityBasisPoints("10000000", "40000000");
    expect(equityBasisPoints).toBe(2_000);
    const finalTerms = investmentStructuredTermsSchema.parse({
      kind: "investment",
      referenceId: "prop_00000001",
      amountCents: "10000000",
      preMoneyValuationCents: "40000000",
      equityBasisPoints,
    });
    expect(investmentProposalSchema.parse({
      id: "prop_00000001",
      runId: "run_00000001",
      companyId: "co_00000001",
      founderAgentId: "agt_00000001",
      firmId: "inst_foundry_capital",
      fundId: "vfund_00000001",
      vcPartnerAgentId: "agt_00000002",
      askAmountCents: "10000000",
      preMoneyValuationCents: "40000000",
      initialEquityBasisPoints: equityBasisPoints,
      status: "agreed",
      negotiationConversationId: "cnv_00000001",
      finalTerms,
      proposedTick: 30,
      expiresTick: 44,
      sourceEventId: "evt_00000001",
      lastTransitionEventId: "evt_00000002",
    }).status).toBe("agreed");
    expect(() => investmentStructuredTermsSchema.parse({
      ...finalTerms,
      equityBasisPoints: 5_000,
    })).toThrow(/inconsistent/);
    expect(() => investmentProposalSchema.parse({
      id: "prop_00000001",
      runId: "run_00000001",
      companyId: "co_00000001",
      founderAgentId: "agt_00000001",
      firmId: "inst_foundry_capital",
      fundId: "vfund_00000001",
      vcPartnerAgentId: "agt_00000002",
      askAmountCents: "10000000",
      preMoneyValuationCents: "40000000",
      initialEquityBasisPoints: equityBasisPoints,
      status: "negotiating",
      negotiationConversationId: null,
      finalTerms: null,
      proposedTick: 30,
      expiresTick: 44,
      sourceEventId: "evt_00000001",
      lastTransitionEventId: "evt_00000002",
    })).toThrow(/negotiation conversation/);
  });

  it("requires exact cap-table totals while allowing later agent and fund trades", () => {
    const founder = ownershipStakeSchema.parse({
      id: "stk_00000001",
      runId: "run_00000001",
      companyId: "co_00000001",
      holderKind: "agent",
      holderId: "agt_00000001",
      shares: "80",
      acquiredVia: "founding",
      sinceTick: 0,
      sourceEventId: null,
    });
    const investor = ownershipStakeSchema.parse({
      id: "stk_00000002",
      runId: "run_00000001",
      companyId: "co_00000001",
      holderKind: "venture_fund",
      holderId: "vfund_00000001",
      shares: "20",
      acquiredVia: "investment",
      sinceTick: 10,
      sourceEventId: "evt_00000001",
    });
    expect(ownershipStakeSchema.parse({
      ...founder,
      id: "stk_00000003",
      acquiredVia: "trade",
    }).acquiredVia).toBe("trade");
    expect(ownershipStakeSchema.parse({
      ...investor,
      id: "stk_00000004",
      acquiredVia: "trade",
    }).acquiredVia).toBe("trade");
    const stakes = [founder, investor].map((stake) => ({
      id: stake.id,
      companyId: stake.companyId,
      holderKind: stake.holderKind,
      holderId: stake.holderId,
      shares: stake.shares,
      acquiredVia: stake.acquiredVia,
      sinceTick: stake.sinceTick,
    }));
    expect(capTableSnapshotSchema.parse({
      companyId: "co_00000001",
      totalShares: "100",
      stakes,
    }).totalShares).toBe("100");
    expect(() => capTableSnapshotSchema.parse({
      companyId: "co_00000001",
      totalShares: "101",
      stakes,
    })).toThrow(/sum exactly/);
    expect(() => ownershipStakeSchema.parse({
      ...founder,
      acquiredVia: "investment",
    })).toThrow(/venture funds/);
  });
});
