/** Test-only adapter from an authoritative run database to the WS-209 checker. */

import {
  agentActionSchema,
  canonicalParse,
  EngineError,
} from "@worldtangle/shared";
import {
  DEFAULT_MAX_ACTIONS_PER_AGENT_PER_TICK,
  type InvariantSnapshot,
} from "@worldtangle/engine";
import { toSafeNumber } from "../persistence/database";
import type { WorldDatabase } from "../persistence/database";
import { SqliteOpeningCreditStore } from "../persistence/opening-credit-store";

interface AccountRow {
  id: string;
  balance_cents: string;
  floor_cents: string;
}

interface MoneyAccountRow {
  id: string;
  owner_kind: string;
  account_type: string;
}

interface TransactionRow {
  id: string;
  kind: string;
}

interface LegRow {
  transaction_id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_cents: string;
}

interface FinanceEventRow {
  event_id: string;
  payload_canonical: string;
}

interface EmploymentRow {
  agent_id: string;
  employment_status: string;
  active_contract_id: string | null;
}

interface EmploymentContractRow {
  id: string;
  employee_agent_id: string;
  status: "active" | "ended";
  signed: bigint;
}

interface CompanyClosureRow {
  company_id: string;
  status: string;
  active_employments: bigint;
  live_contracts: bigint;
  open_jobs: bigint;
  active_offerings: bigint;
  inventory_units: bigint;
  live_accounts: bigint;
  account_balance_cents: bigint;
  unresolved_claims: bigint;
}

interface EquityRow {
  company_id: string;
  total_shares: string;
  source: "opening" | "phase4";
}

interface StakeRow {
  owner_agent_id: string;
  shares: string;
}

interface LoanRow {
  id: string;
  status: string;
  bank_asset_account_id: string;
  borrower_deposit_account_id: string;
  disbursement_transaction_id: string;
}

interface UsageRow {
  agent_id: string;
  tick: bigint;
  actions: bigint;
}

interface TickRow {
  tick: bigint;
  completions: bigint;
}

interface RunRow {
  current_tick: bigint;
}

interface ActionRow {
  id: string;
  actor_id: string;
  type: string;
  status: "validated" | "applied" | "failed";
  action_canonical: string;
}

function parseAction(row: ActionRow) {
  try {
    return agentActionSchema.parse(canonicalParse(row.action_canonical));
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted agent action ${row.id} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function actionIdentityField(type: string): string | undefined {
  switch (type) {
    case "agent.advance_goal":
    case "agent.activate_goal":
    case "agent.defer_goal":
    case "agent.respond_job_offer":
      return "agentId";
    case "company.set_price":
    case "company.respond_hiring":
      return "founderAgentId";
    case "bank.review_loan":
      return "officerAgentId";
    default:
      return undefined;
  }
}

/**
 * Phase 4 additionally activates authoritative company-equity and signed
 * employment checks while preserving Phase 3 opening-state compatibility.
 */
export function readRunInvariantSnapshot(
  db: WorldDatabase,
  runId: string,
): InvariantSnapshot {
  const run = db.prepare<[string], RunRow>(`
    SELECT current_tick FROM simulation_runs WHERE id = ?
  `).get(runId);
  if (run === undefined) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  const currentTick = toSafeNumber(run.current_tick, "run current tick");

  const completions = new Map(
    db.prepare<[string], TickRow>(`
      SELECT tick, COUNT(*) AS completions
      FROM events
      WHERE run_id = ? AND type = 'simulation.tick.completed'
      GROUP BY tick ORDER BY tick
    `).all(runId).map((row) => [
      toSafeNumber(row.tick, "completed event tick"),
      toSafeNumber(row.completions, "completed event count"),
    ]),
  );
  const maximumObservedTick = Math.max(currentTick, ...completions.keys(), 0);

  const transactionRows = db.prepare<[string], TransactionRow>(`
    SELECT id, kind FROM ledger_transactions WHERE run_id = ? ORDER BY id
  `).all(runId);
  const financeLegs = db.prepare<[string], LegRow>(`
    SELECT transaction_id, account_id, direction, amount_cents
    FROM ledger_transaction_legs WHERE run_id = ?
    ORDER BY transaction_id, leg_index
  `).all(runId);
  const legsByTransaction = new Map<string, LegRow[]>();
  for (const leg of financeLegs) {
    const rows = legsByTransaction.get(leg.transaction_id) ?? [];
    rows.push(leg);
    legsByTransaction.set(leg.transaction_id, rows);
  }
  const transactions = transactionRows.map((transaction) => ({
    id: transaction.id,
    legs: (legsByTransaction.get(transaction.id) ?? []).map((leg) => ({
      accountId: leg.account_id,
      direction: leg.direction,
      amountCents: leg.amount_cents,
    })),
  }));
  const transactionEventIds = new Map<string, string>();
  const financeEvents = db.prepare<[string], FinanceEventRow>(`
    SELECT event_id, payload_canonical FROM events
    WHERE run_id = ? AND type = 'transaction.posted' ORDER BY seq
  `).all(runId);
  for (const event of financeEvents) {
    const payload = canonicalParse(event.payload_canonical);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const transactionId = (payload as Record<string, unknown>)["transactionId"];
    if (typeof transactionId === "string") transactionEventIds.set(transactionId, event.event_id);
  }
  const supplyChannels: Readonly<Record<string, "mint" | "lending" | "repayment" | "row">> = {
    mint: "mint",
    loan_disbursement: "lending",
    loan_payment: "repayment",
    row_settlement: "row",
  };
  const moneyAccounts = new Map(db.prepare<[string], MoneyAccountRow>(`
    SELECT id, owner_kind, account_type
    FROM bank_accounts WHERE run_id = ? ORDER BY id
  `).all(runId).map((account) => [account.id, account]));
  const moneySupplyChanges = transactionRows.flatMap((transaction) => {
    const domesticDelta = (legsByTransaction.get(transaction.id) ?? []).reduce((sum, leg) => {
      const account = moneyAccounts.get(leg.account_id);
      if (account?.account_type !== "checking" || (
        account.owner_kind !== "agent" &&
        account.owner_kind !== "company" &&
        account.owner_kind !== "government"
      )) return sum;
      const amount = BigInt(leg.amount_cents);
      return sum + (leg.direction === "debit" ? amount : -amount);
    }, 0n);
    if (domesticDelta === 0n) return [];
    return [{
      id: transaction.id,
      channel: supplyChannels[transaction.kind] ?? transaction.kind,
      deltaCents: domesticDelta.toString(),
      eventId: transactionEventIds.get(transaction.id) ?? `missing:${transaction.id}`,
    }];
  });
  const openingCreditStore = new SqliteOpeningCreditStore(db, runId);
  const openingCreditState = openingCreditStore.listLoans().length === 0
    ? undefined
    : openingCreditStore.readState();
  const staffJournalistIds = new Set(db.prepare<[string], { id: string }>(`
    SELECT id FROM agents
    WHERE run_id = ? AND role_code = 'news.journalist'
      AND organization_id = 'inst_riverbend_ledger'
    ORDER BY id
  `).all(runId).map((row) => row.id));

  return {
    eventIds: financeEvents.map((event) => event.event_id),
    transactions,
    moneySupplyChanges,
    accounts: db.prepare<[string], AccountRow>(`
      SELECT id, balance_cents, floor_cents
      FROM bank_accounts WHERE run_id = ? ORDER BY id
    `).all(runId).map((row) => ({
      id: row.id,
      balanceCents: row.balance_cents,
      floorCents: row.floor_cents,
    })),
    ownership: db.prepare<[string, string], EquityRow>(`
      SELECT company_id, total_shares, 'opening' AS source
      FROM opening_company_equity WHERE run_id = ?
      UNION ALL
      SELECT id AS company_id, total_shares, 'phase4' AS source
      FROM companies WHERE run_id = ?
      ORDER BY company_id
    `).all(runId, runId).map((company) => ({
      companyId: company.company_id,
      totalShares: company.total_shares,
      stakes: db.prepare<[string, string, string], StakeRow>(company.source === "opening" ? `
        SELECT owner_agent_id, shares FROM opening_company_equity_stakes
        WHERE run_id = ? AND company_id = ? AND ? = 'opening' ORDER BY owner_agent_id
      ` : `
        SELECT owner_agent_id, shares FROM company_equity_stakes
        WHERE run_id = ? AND company_id = ? AND ? = 'phase4' ORDER BY owner_agent_id
      `).all(runId, company.company_id, company.source).map((stake) => ({
        ownerId: stake.owner_agent_id,
        shares: stake.shares,
      })),
    })),
    employments: db.prepare<[string], EmploymentRow>(`
      SELECT a.id AS agent_id, a.employment_status,
        e.id AS active_contract_id
      FROM agents a
      LEFT JOIN employment_contracts e
        ON e.run_id = a.run_id AND e.employee_agent_id = a.id AND e.status = 'active'
      WHERE a.run_id = ? ORDER BY a.id
    `).all(runId).map((row) => ({
      agentId: row.agent_id,
      employmentStatus: row.employment_status,
      ...(row.active_contract_id === null ? {} : { activeContractId: row.active_contract_id }),
    })),
    employmentContracts: db.prepare<[string], EmploymentContractRow>(`
      SELECT e.id, e.employee_agent_id, e.status,
        CASE
          WHEN e.legal_contract_id IS NULL THEN 1
          WHEN lc.status IN ('signed', 'active', 'completed', 'terminated', 'breached')
            AND NOT EXISTS (
              SELECT 1 FROM legal_contract_parties p
              WHERE p.run_id = e.run_id AND p.contract_id = e.legal_contract_id
                AND p.signed_tick IS NULL
            ) THEN 1
          ELSE 0
        END AS signed
      FROM employment_contracts e
      LEFT JOIN legal_contracts lc
        ON lc.run_id = e.run_id AND lc.id = e.legal_contract_id
      WHERE e.run_id = ? ORDER BY e.id
    `).all(runId).map((row) => ({
      id: row.id,
      employeeAgentId: row.employee_agent_id,
      status: row.status,
      signed: row.signed === 1n,
    })),
    companyClosures: db.prepare<[string], CompanyClosureRow>(`
      SELECT c.id AS company_id, c.status,
        (SELECT COUNT(*) FROM employment_contracts e
          WHERE e.run_id = c.run_id AND e.employer_id = c.id
            AND e.status = 'active') AS active_employments,
        (SELECT COUNT(*) FROM legal_contracts lc
          WHERE lc.run_id = c.run_id AND lc.status IN ('signed', 'active') AND (
            EXISTS (
              SELECT 1 FROM legal_contract_parties p
              WHERE p.run_id = lc.run_id AND p.contract_id = lc.id
                AND p.party_kind = 'company' AND p.party_id = c.id
            )
            OR lc.id = c.incorporation_contract_id
          )) AS live_contracts,
        (SELECT COUNT(*) FROM jobs j
          WHERE j.run_id = c.run_id AND j.employer_id = c.id
            AND j.status = 'open') AS open_jobs,
        (SELECT COUNT(*) FROM market_offerings o
          WHERE o.run_id = c.run_id AND o.company_id = c.id
            AND o.active = 1) AS active_offerings,
        (SELECT COALESCE(SUM(i.quantity), 0) FROM company_inventory i
          WHERE i.run_id = c.run_id AND i.company_id = c.id) AS inventory_units,
        (SELECT COUNT(*) FROM bank_accounts a
          WHERE a.run_id = c.run_id AND a.owner_kind = 'company' AND a.owner_id = c.id
            AND a.status <> 'closed') AS live_accounts,
        (SELECT COALESCE(SUM(CAST(a.balance_cents AS INTEGER)), 0) FROM bank_accounts a
          WHERE a.run_id = c.run_id AND a.owner_kind = 'company'
            AND a.owner_id = c.id) AS account_balance_cents,
        (SELECT COUNT(*) FROM company_creditor_claims claim
          WHERE claim.run_id = c.run_id AND claim.company_id = c.id
            AND CAST(claim.amount_cents AS INTEGER) <> COALESCE((
              SELECT SUM(amount) FROM (
                SELECT CAST(r.amount_cents AS INTEGER) AS amount
                FROM company_creditor_recoveries r
                WHERE r.run_id = claim.run_id AND r.claim_id = claim.id
                UNION ALL
                SELECT CAST(w.amount_cents AS INTEGER) AS amount
                FROM company_creditor_write_offs w
                WHERE w.run_id = claim.run_id AND w.claim_id = claim.id
              )
            ), 0)) AS unresolved_claims
      FROM companies c WHERE c.run_id = ? ORDER BY c.id
    `).all(runId).map((row) => ({
      companyId: row.company_id,
      status: row.status,
      activeEmployments: toSafeNumber(row.active_employments, "active company employments"),
      liveContracts: toSafeNumber(row.live_contracts, "live company contracts"),
      openJobs: toSafeNumber(row.open_jobs, "open company jobs"),
      activeOfferings: toSafeNumber(row.active_offerings, "active company offerings"),
      inventoryUnits: row.inventory_units.toString(),
      liveAccounts: toSafeNumber(row.live_accounts, "live company accounts"),
      accountBalanceCents: row.account_balance_cents.toString(),
      unresolvedClaims: toSafeNumber(row.unresolved_claims, "unresolved company claims"),
    })),
    loans: db.prepare<[string, string], LoanRow>(`
      SELECT l.id, l.status, links.bank_asset_account_id,
        links.borrower_deposit_account_id, links.disbursement_transaction_id
      FROM seed_loans l
      JOIN seed_loan_ledger_links links
        ON links.run_id = l.run_id AND links.loan_id = l.id
      WHERE l.run_id = ?
      UNION ALL
      SELECT id, status, bank_asset_account_id,
        borrower_deposit_account_id, disbursement_transaction_id
      FROM loans WHERE run_id = ?
      ORDER BY id
    `).all(runId, runId).map((row) => ({
      id: row.id,
      status: row.status,
      bankAssetAccountId: row.bank_asset_account_id,
      borrowerDepositAccountId: row.borrower_deposit_account_id,
      disbursementTransactionId: row.disbursement_transaction_id,
    })),
    ...(openingCreditState === undefined ? {} : { openingCreditState }),
    agentTickUsage: db.prepare<[string], UsageRow>(`
      SELECT d.agent_id, d.tick, COUNT(a.id) AS actions
      FROM decisions d
      LEFT JOIN agent_actions a
        ON a.run_id = d.run_id AND a.decision_id = d.id
      WHERE d.run_id = ?
      GROUP BY d.agent_id, d.tick
      ORDER BY d.tick, d.agent_id
    `).all(runId).map((row) => ({
      agentId: row.agent_id,
      tick: toSafeNumber(row.tick, "agent usage tick"),
      actions: toSafeNumber(row.actions, "agent action count"),
      conversations: 0,
      actionCap: DEFAULT_MAX_ACTIONS_PER_AGENT_PER_TICK,
      conversationCap: 3,
    })),
    tickCommits: Array.from({ length: maximumObservedTick }, (_, index) => {
      const tick = index + 1;
      return {
        tick,
        committed: tick <= currentTick && completions.get(tick) === 1,
      };
    }),
    actions: db.prepare<[string], ActionRow>(`
      SELECT id, actor_id, type, status, action_canonical
      FROM agent_actions WHERE run_id = ? ORDER BY id
    `).all(runId).map((row) => {
      const action = parseAction(row);
      const identityField = actionIdentityField(row.type);
      const authorized = row.status !== "applied" ||
        row.type === "agent.no_op" ||
        (row.type === "news.story.publish" && staffJournalistIds.has(row.actor_id)) ||
        (
          identityField !== undefined &&
          action.params[identityField] === row.actor_id
        );
      return {
        id: row.id,
        actorId: row.actor_id,
        type: row.type,
        status: row.status,
        authorized,
      };
    }),
  };
}
