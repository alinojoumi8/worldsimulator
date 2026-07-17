import { describe, expect, it } from "vitest";
import {
  INVARIANT_IDS,
  assertInvariants,
  checkInvariants,
} from "./invariant-checker";
import type { InvariantId, InvariantSnapshot } from "./invariant-checker";

const valid: InvariantSnapshot = {
  eventIds: ["evt_00000001"],
  transactions: [{
    id: "txn_1",
    legs: [
      { accountId: "a", direction: "debit", amountCents: "100" },
      { accountId: "b", direction: "credit", amountCents: "100" },
    ],
  }],
  moneySupplyChanges: [{ id: "s1", channel: "mint", deltaCents: "100", eventId: "evt_00000001" }],
  accounts: [
    { id: "a", balanceCents: "100", floorCents: "0" },
    { id: "b", balanceCents: "100", floorCents: "0" },
    { id: "loan_asset", balanceCents: "100", floorCents: "0" },
    { id: "borrower_deposit", balanceCents: "100", floorCents: "0" },
  ],
  ownership: [{ companyId: "co_1", totalShares: "100", stakes: [{ ownerId: "agt_1", shares: "100" }] }],
  employments: [{ agentId: "agt_1", employmentStatus: "employed", activeContractId: "emp_1" }],
  employmentContracts: [{ id: "emp_1", employeeAgentId: "agt_1", status: "active", signed: true }],
  companyClosures: [{
    companyId: "co_closed",
    status: "closed",
    activeEmployments: 0,
    liveContracts: 0,
    openJobs: 0,
    activeOfferings: 0,
    inventoryUnits: "0",
    liveAccounts: 0,
    accountBalanceCents: "0",
    unresolvedClaims: 0,
  }],
  loans: [{
    id: "loan_1",
    status: "repaying",
    bankAssetAccountId: "loan_asset",
    borrowerDepositAccountId: "borrower_deposit",
    disbursementTransactionId: "txn_1",
  }],
  orders: [
    { id: "buy_1", securityId: "sec_1", side: "buy", limitPriceCents: "120", quantity: "5" },
    { id: "sell_1", securityId: "sec_1", side: "sell", limitPriceCents: "100", quantity: "5" },
  ],
  trades: [{
    id: "trade_1",
    securityId: "sec_1",
    buyOrderId: "buy_1",
    sellOrderId: "sell_1",
    priceCents: "110",
    quantity: "5",
    settlementTransactionId: "txn_1",
  }],
  agentTickUsage: [{ agentId: "agt_1", tick: 1, actions: 2, conversations: 1, actionCap: 3, conversationCap: 2 }],
  tickCommits: [{ tick: 1, committed: true }, { tick: 2, committed: true }],
  actions: [{ id: "act_1", actorId: "agt_1", type: "agent.advance_goal", status: "applied", authorized: true }],
};

const broken: Readonly<Record<InvariantId, InvariantSnapshot>> = {
  "INV-1": { ...valid, transactions: [{ id: "txn_1", legs: [
    { accountId: "a", direction: "debit", amountCents: "100" },
    { accountId: "b", direction: "credit", amountCents: "99" },
  ] }] },
  "INV-2": { ...valid, moneySupplyChanges: [{ id: "s1", channel: "mystery", deltaCents: "1", eventId: "evt_missing" }] },
  "INV-3": { ...valid, accounts: [{ id: "a", balanceCents: "-1", floorCents: "0" }] },
  "INV-4": { ...valid, ownership: [{ companyId: "co_1", totalShares: "100", stakes: [{ ownerId: "agt_1", shares: "99" }] }] },
  "INV-5": { ...valid, employments: [{ agentId: "agt_1", employmentStatus: "employed" }] },
  "INV-6": { ...valid, loans: [{ id: "loan_1", status: "approved" }] },
  "INV-7": { ...valid, trades: [{ id: "trade_1", securityId: "sec_1", buyOrderId: "buy_1", sellOrderId: "sell_1", priceCents: "130", quantity: "5" }] },
  "INV-8": { ...valid, agentTickUsage: [{ agentId: "agt_1", tick: 1, actions: 4, conversations: 0, actionCap: 3, conversationCap: 2 }] },
  "INV-9": { ...valid, tickCommits: [{ tick: 1, committed: true }, { tick: 3, committed: false }] },
  "INV-10": { ...valid, actions: [{ id: "act_1", actorId: "agt_1", type: "forbidden", status: "applied", authorized: false }] },
};

describe("invariant checker", () => {
  it("passes a fully active valid fixture", () => {
    const report = checkInvariants(valid);
    expect(report.passed).toBe(true);
    expect(report.active).toEqual(INVARIANT_IDS);
    expect(report.inactive).toEqual([]);
    expect(() => assertInvariants(valid)).not.toThrow();
  });

  for (const invariant of INVARIANT_IDS) {
    it(`catches a deliberately seeded ${invariant} violation`, () => {
      const report = checkInvariants(broken[invariant]);
      expect(report.passed).toBe(false);
      expect(report.violations.some((finding) => finding.invariant === invariant)).toBe(true);
      expect(() => assertInvariants(broken[invariant])).toThrow(/invariant check failed/);
    });
  }

  it("reports future-domain invariants as inactive instead of silently passing them", () => {
    const report = checkInvariants({ tickCommits: [{ tick: 1, committed: true }] });
    expect(report.passed).toBe(true);
    expect(report.active).toEqual(["INV-9"]);
    expect(report.inactive).toEqual(INVARIANT_IDS.filter((id) => id !== "INV-9"));
  });

  it("rejects dangling state on a failed company", () => {
    const report = checkInvariants({
      companyClosures: [{
        companyId: "co_failed",
        status: "closed",
        activeEmployments: 1,
        liveContracts: 1,
        openJobs: 0,
        activeOfferings: 1,
        inventoryUnits: "4",
        liveAccounts: 1,
        accountBalanceCents: "100",
        unresolvedClaims: 1,
      }],
    });
    expect(report.violations).toContainEqual(expect.objectContaining({
      invariant: "INV-5",
      code: "failed_company_has_dangling_state",
    }));
  });
});
