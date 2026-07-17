/** Reusable WS-209/M26 invariant checker. This module is never called by production ticks. */

import { EngineError } from "@worldtangle/shared";
import { auditOpeningCreditState } from "../seeded-credit";
import type { OpeningCreditState } from "../seeded-credit";

export const INVARIANT_IDS = [
  "INV-1",
  "INV-2",
  "INV-3",
  "INV-4",
  "INV-5",
  "INV-6",
  "INV-7",
  "INV-8",
  "INV-9",
  "INV-10",
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface InvariantCheckResult {
  readonly invariant: InvariantId;
  readonly status: "passed" | "failed" | "inactive";
  readonly violations: readonly InvariantViolation[];
}

export interface InvariantReport {
  readonly passed: boolean;
  readonly checks: readonly InvariantCheckResult[];
  readonly violations: readonly InvariantViolation[];
  readonly active: readonly InvariantId[];
  readonly inactive: readonly InvariantId[];
}

export interface InvariantTransaction {
  readonly id: string;
  readonly legs: readonly {
    readonly accountId: string;
    readonly direction: "debit" | "credit";
    readonly amountCents: string;
  }[];
}

export interface MoneySupplyChange {
  readonly id: string;
  readonly channel: "mint" | "lending" | "repayment" | "row" | string;
  readonly deltaCents: string;
  readonly eventId: string;
}

export interface InvariantAccount {
  readonly id: string;
  readonly balanceCents: string;
  readonly floorCents: string;
}

export interface InvariantCompanyOwnership {
  readonly companyId: string;
  readonly totalShares: string;
  readonly stakes: readonly { readonly ownerId: string; readonly shares: string }[];
}

export interface InvariantEmployment {
  readonly agentId: string;
  readonly employmentStatus: string;
  readonly activeContractId?: string;
}

export interface InvariantEmploymentContract {
  readonly id: string;
  readonly employeeAgentId: string;
  readonly status: "active" | "ended";
  readonly signed: boolean;
}

export interface InvariantCompanyClosure {
  readonly companyId: string;
  readonly status: string;
  readonly activeEmployments: number;
  readonly liveContracts: number;
  readonly openJobs: number;
  readonly activeOfferings: number;
  readonly inventoryUnits: string;
  readonly liveAccounts: number;
  readonly accountBalanceCents: string;
  readonly unresolvedClaims: number;
}

export interface InvariantLoan {
  readonly id: string;
  readonly status: string;
  readonly bankAssetAccountId?: string;
  readonly borrowerDepositAccountId?: string;
  readonly disbursementTransactionId?: string;
}

export interface InvariantOrder {
  readonly id: string;
  readonly securityId: string;
  readonly side: "buy" | "sell";
  readonly limitPriceCents: string;
  readonly quantity: string;
}

export interface InvariantTrade {
  readonly id: string;
  readonly securityId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly priceCents: string;
  readonly quantity: string;
  readonly settlementTransactionId?: string;
}

export interface AgentTickUsage {
  readonly agentId: string;
  readonly tick: number;
  readonly actions: number;
  readonly conversations: number;
  readonly actionCap: number;
  readonly conversationCap: number;
}

export interface InvariantTickCommit {
  readonly tick: number;
  readonly committed: boolean;
}

export interface InvariantAction {
  readonly id: string;
  readonly actorId: string;
  readonly type: string;
  readonly status: "validated" | "applied" | "failed" | "rejected";
  readonly authorized: boolean;
}

export interface InvariantSnapshot {
  readonly eventIds?: readonly string[];
  readonly transactions?: readonly InvariantTransaction[];
  readonly moneySupplyChanges?: readonly MoneySupplyChange[];
  readonly accounts?: readonly InvariantAccount[];
  readonly ownership?: readonly InvariantCompanyOwnership[];
  readonly employments?: readonly InvariantEmployment[];
  readonly employmentContracts?: readonly InvariantEmploymentContract[];
  readonly companyClosures?: readonly InvariantCompanyClosure[];
  readonly loans?: readonly InvariantLoan[];
  readonly openingCreditState?: OpeningCreditState;
  readonly orders?: readonly InvariantOrder[];
  readonly trades?: readonly InvariantTrade[];
  readonly agentTickUsage?: readonly AgentTickUsage[];
  readonly tickCommits?: readonly InvariantTickCommit[];
  readonly actions?: readonly InvariantAction[];
}

type ViolationInput = Omit<InvariantViolation, "invariant">;
type Check = (snapshot: InvariantSnapshot) => readonly ViolationInput[] | undefined;

function violation(
  code: string,
  message: string,
  path: string,
  details?: Readonly<Record<string, unknown>>,
): ViolationInput {
  return { code, message, path, ...(details === undefined ? {} : { details }) };
}

function parseInteger(
  value: string,
  path: string,
  violations: ViolationInput[],
  options: { nonnegative?: boolean; positive?: boolean } = {},
): bigint | undefined {
  if (!/^-?\d+$/.test(value)) {
    violations.push(violation("invalid_integer", "value is not integer cents", path));
    return undefined;
  }
  const parsed = BigInt(value);
  if (options.positive === true && parsed <= 0n) {
    violations.push(violation("not_positive", "value must be positive", path));
    return undefined;
  }
  if (options.nonnegative === true && parsed < 0n) {
    violations.push(violation("negative_value", "value must be nonnegative", path));
    return undefined;
  }
  return parsed;
}

const CHECKS: Readonly<Record<InvariantId, Check>> = {
  "INV-1": (snapshot) => {
    if (snapshot.transactions === undefined) return undefined;
    const violations: ViolationInput[] = [];
    for (const transaction of snapshot.transactions) {
      let debits = 0n;
      let credits = 0n;
      if (transaction.legs.length < 2) {
        violations.push(violation(
          "too_few_legs",
          "a transaction must contain at least two legs",
          `transactions.${transaction.id}.legs`,
        ));
      }
      for (let index = 0; index < transaction.legs.length; index++) {
        const leg = transaction.legs[index]!;
        const amount = parseInteger(
          leg.amountCents,
          `transactions.${transaction.id}.legs.${index}.amountCents`,
          violations,
          { positive: true },
        );
        if (amount === undefined) continue;
        if (leg.direction === "debit") debits += amount;
        else credits += amount;
      }
      if (debits !== credits) {
        violations.push(violation(
          "unbalanced_transaction",
          "transaction debits and credits differ",
          `transactions.${transaction.id}`,
          { debits: debits.toString(), credits: credits.toString() },
        ));
      }
    }
    return violations;
  },
  "INV-2": (snapshot) => {
    if (snapshot.moneySupplyChanges === undefined) return undefined;
    const violations: ViolationInput[] = [];
    const allowed = new Set(["mint", "lending", "repayment", "row"]);
    const eventIds = new Set(snapshot.eventIds ?? []);
    for (const change of snapshot.moneySupplyChanges) {
      parseInteger(
        change.deltaCents,
        `moneySupplyChanges.${change.id}.deltaCents`,
        violations,
      );
      if (!allowed.has(change.channel)) {
        violations.push(violation(
          "unauthorized_money_channel",
          "money supply changed outside an authorized channel",
          `moneySupplyChanges.${change.id}.channel`,
          { channel: change.channel },
        ));
      }
      if (!eventIds.has(change.eventId)) {
        violations.push(violation(
          "unevented_money_change",
          "money supply change lacks a matching event",
          `moneySupplyChanges.${change.id}.eventId`,
          { eventId: change.eventId },
        ));
      }
    }
    return violations;
  },
  "INV-3": (snapshot) => {
    if (snapshot.accounts === undefined) return undefined;
    const violations: ViolationInput[] = [];
    for (const account of snapshot.accounts) {
      const balance = parseInteger(
        account.balanceCents,
        `accounts.${account.id}.balanceCents`,
        violations,
      );
      const floor = parseInteger(
        account.floorCents,
        `accounts.${account.id}.floorCents`,
        violations,
      );
      if (balance !== undefined && floor !== undefined && balance < floor) {
        violations.push(violation(
          "account_below_floor",
          "account balance is below its configured floor",
          `accounts.${account.id}`,
          { balance: balance.toString(), floor: floor.toString() },
        ));
      }
    }
    return violations;
  },
  "INV-4": (snapshot) => {
    if (snapshot.ownership === undefined) return undefined;
    const violations: ViolationInput[] = [];
    for (const company of snapshot.ownership) {
      const total = parseInteger(
        company.totalShares,
        `ownership.${company.companyId}.totalShares`,
        violations,
        { positive: true },
      );
      let sum = 0n;
      for (let index = 0; index < company.stakes.length; index++) {
        const shares = parseInteger(
          company.stakes[index]!.shares,
          `ownership.${company.companyId}.stakes.${index}.shares`,
          violations,
          { positive: true },
        );
        if (shares !== undefined) sum += shares;
      }
      if (total !== undefined && total !== sum) {
        violations.push(violation(
          "ownership_total_mismatch",
          "ownership stakes do not equal company total shares",
          `ownership.${company.companyId}`,
          { totalShares: total.toString(), stakeShares: sum.toString() },
        ));
      }
    }
    return violations;
  },
  "INV-5": (snapshot) => {
    if (snapshot.employments === undefined && snapshot.employmentContracts === undefined &&
      snapshot.companyClosures === undefined) {
      return undefined;
    }
    const violations: ViolationInput[] = [];
    const contracts = new Map((snapshot.employmentContracts ?? []).map((contract) => [contract.id, contract]));
    for (const employment of snapshot.employments ?? []) {
      if (employment.employmentStatus !== "employed") continue;
      const contract = employment.activeContractId === undefined
        ? undefined
        : contracts.get(employment.activeContractId);
      if (
        contract === undefined ||
        contract.employeeAgentId !== employment.agentId ||
        contract.status !== "active" ||
        !contract.signed
      ) {
        violations.push(violation(
          "employment_without_signed_contract",
          "employed agent lacks a matching active signed agreement",
          `employments.${employment.agentId}`,
        ));
      }
    }
    for (const company of snapshot.companyClosures ?? []) {
      if (company.status !== "closed") continue;
      const inventoryUnits = parseInteger(
        company.inventoryUnits,
        `companyClosures.${company.companyId}.inventoryUnits`,
        violations,
        { nonnegative: true },
      );
      const accountBalance = parseInteger(
        company.accountBalanceCents,
        `companyClosures.${company.companyId}.accountBalanceCents`,
        violations,
      );
      if (
        company.activeEmployments !== 0 || company.liveContracts !== 0 ||
        company.openJobs !== 0 || company.activeOfferings !== 0 ||
        inventoryUnits !== 0n || company.liveAccounts !== 0 ||
        accountBalance !== 0n || company.unresolvedClaims !== 0
      ) {
        violations.push(violation(
          "failed_company_has_dangling_state",
          "closed failed company retains employment, contracts, market state, cash, or claims",
          `companyClosures.${company.companyId}`,
        ));
      }
    }
    return violations;
  },
  "INV-6": (snapshot) => {
    if (snapshot.loans === undefined && snapshot.openingCreditState === undefined) return undefined;
    const violations: ViolationInput[] = [];
    const accountIds = new Set((snapshot.accounts ?? []).map((account) => account.id));
    const transactionIds = new Set((snapshot.transactions ?? []).map((transaction) => transaction.id));
    for (const loan of snapshot.loans ?? []) {
      if (!new Set(["approved", "disbursed", "repaying", "current", "delinquent", "defaulted"]).has(loan.status)) {
        continue;
      }
      const missing = [
        loan.bankAssetAccountId === undefined ||
          (snapshot.accounts !== undefined && !accountIds.has(loan.bankAssetAccountId)),
        loan.borrowerDepositAccountId === undefined ||
          (snapshot.accounts !== undefined && !accountIds.has(loan.borrowerDepositAccountId)),
        loan.disbursementTransactionId === undefined ||
          (snapshot.transactions !== undefined && !transactionIds.has(loan.disbursementTransactionId)),
      ].some(Boolean);
      if (missing) {
        violations.push(violation(
          "loan_records_incomplete",
          "approved loan lacks matching asset, liability, or disbursement records",
          `loans.${loan.id}`,
        ));
      }
    }
    if (snapshot.openingCreditState !== undefined) {
      const opening = auditOpeningCreditState(snapshot.openingCreditState, {
        requireSeedEvents: false,
      });
      for (const finding of opening.violations) {
        violations.push(violation(
          `opening_credit_${finding.code}`,
          finding.message,
          `openingCreditState.${finding.path}`,
          finding.details,
        ));
      }
    }
    return violations;
  },
  "INV-7": (snapshot) => {
    if (snapshot.trades === undefined) return undefined;
    const violations: ViolationInput[] = [];
    const orders = new Map((snapshot.orders ?? []).map((order) => [order.id, order]));
    for (const trade of snapshot.trades) {
      const buy = orders.get(trade.buyOrderId);
      const sell = orders.get(trade.sellOrderId);
      const price = parseInteger(
        trade.priceCents,
        `trades.${trade.id}.priceCents`,
        violations,
        { positive: true },
      );
      const quantity = parseInteger(
        trade.quantity,
        `trades.${trade.id}.quantity`,
        violations,
        { positive: true },
      );
      let compatible = buy !== undefined && sell !== undefined &&
        buy.side === "buy" && sell.side === "sell" &&
        buy.securityId === trade.securityId && sell.securityId === trade.securityId &&
        trade.settlementTransactionId !== undefined;
      if (compatible && price !== undefined && quantity !== undefined) {
        const buyLimit = parseInteger(buy!.limitPriceCents, `orders.${buy!.id}.limitPriceCents`, violations, { positive: true });
        const sellLimit = parseInteger(sell!.limitPriceCents, `orders.${sell!.id}.limitPriceCents`, violations, { positive: true });
        const buyQuantity = parseInteger(buy!.quantity, `orders.${buy!.id}.quantity`, violations, { positive: true });
        const sellQuantity = parseInteger(sell!.quantity, `orders.${sell!.id}.quantity`, violations, { positive: true });
        compatible = buyLimit !== undefined && sellLimit !== undefined &&
          buyQuantity !== undefined && sellQuantity !== undefined &&
          buyLimit >= price && price >= sellLimit &&
          buyQuantity >= quantity && sellQuantity >= quantity;
      }
      if (!compatible) {
        violations.push(violation(
          "trade_without_compatible_orders",
          "trade lacks compatible funded buy and sell orders",
          `trades.${trade.id}`,
        ));
      }
    }
    return violations;
  },
  "INV-8": (snapshot) => {
    if (snapshot.agentTickUsage === undefined) return undefined;
    const violations: ViolationInput[] = [];
    for (const usage of snapshot.agentTickUsage) {
      if (
        !Number.isSafeInteger(usage.actions) ||
        !Number.isSafeInteger(usage.conversations) ||
        !Number.isSafeInteger(usage.actionCap) ||
        !Number.isSafeInteger(usage.conversationCap) ||
        usage.actions < 0 ||
        usage.conversations < 0 ||
        usage.actionCap < 0 ||
        usage.conversationCap < 0 ||
        usage.actions > usage.actionCap ||
        usage.conversations > usage.conversationCap
      ) {
        violations.push(violation(
          "agent_tick_cap_exceeded",
          "agent exceeded an action or conversation cap",
          `agentTickUsage.${usage.tick}.${usage.agentId}`,
          {
            actions: usage.actions,
            actionCap: usage.actionCap,
            conversations: usage.conversations,
            conversationCap: usage.conversationCap,
          },
        ));
      }
    }
    return violations;
  },
  "INV-9": (snapshot) => {
    if (snapshot.tickCommits === undefined) return undefined;
    const violations: ViolationInput[] = [];
    for (let index = 0; index < snapshot.tickCommits.length; index++) {
      const commit = snapshot.tickCommits[index]!;
      if (!commit.committed) {
        violations.push(violation(
          "partial_tick",
          "tick is visible without a committed checkpoint",
          `tickCommits.${index}`,
          { tick: commit.tick },
        ));
      }
      if (!Number.isSafeInteger(commit.tick) || commit.tick < 1) {
        violations.push(violation("invalid_tick", "tick must be a positive integer", `tickCommits.${index}.tick`));
      }
      if (index > 0 && commit.tick !== snapshot.tickCommits[index - 1]!.tick + 1) {
        violations.push(violation(
          "tick_sequence_gap",
          "committed ticks must increase exactly by one",
          `tickCommits.${index}.tick`,
        ));
      }
    }
    return violations;
  },
  "INV-10": (snapshot) => {
    if (snapshot.actions === undefined) return undefined;
    return snapshot.actions
      .filter((action) => action.status === "applied" && !action.authorized)
      .map((action) => violation(
        "unauthorized_action_applied",
        "an actor applied an action outside its capabilities",
        `actions.${action.id}`,
        { actorId: action.actorId, type: action.type },
      ));
  },
};

export function checkInvariants(snapshot: InvariantSnapshot): InvariantReport {
  const checks = INVARIANT_IDS.map((invariant): InvariantCheckResult => {
    const findings = CHECKS[invariant](snapshot);
    if (findings === undefined) {
      return Object.freeze({ invariant, status: "inactive", violations: Object.freeze([]) });
    }
    const violations = Object.freeze(findings.map((finding) => Object.freeze({ invariant, ...finding })));
    return Object.freeze({
      invariant,
      status: violations.length === 0 ? "passed" : "failed",
      violations,
    });
  });
  const violations = Object.freeze(checks.flatMap((check) => check.violations));
  return Object.freeze({
    passed: violations.length === 0,
    checks: Object.freeze(checks),
    violations,
    active: Object.freeze(checks.filter((check) => check.status !== "inactive").map((check) => check.invariant)),
    inactive: Object.freeze(checks.filter((check) => check.status === "inactive").map((check) => check.invariant)),
  });
}

export function assertInvariants(snapshot: InvariantSnapshot): InvariantReport {
  const report = checkInvariants(snapshot);
  if (!report.passed) {
    throw new EngineError("CONFLICT", "simulation invariant check failed", {
      violations: report.violations,
    });
  }
  return report;
}
