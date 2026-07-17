/** SQLite adapter for the authoritative Phase 3 ledger and economic read model. */

import {
  actorRefSchema,
  bankAccountSchema,
  canonicalParse,
  canonicalStringify,
  EngineError,
  hashValue,
  INDICATOR_KEYS,
  indicatorKeySchema,
  ledgerTransactionSchema,
  money,
  mulDiv,
  runIdSchema,
  SENTIMENT_TOPICS,
  sentimentUpdateSchema,
} from "@worldtangle/shared";
import type {
  AccountOwnerKind,
  ActorRef,
  BankAccount,
  BankAccountType,
  IndicatorKey,
  LedgerTransaction,
  PolicyKey,
  TransactionKind,
} from "@worldtangle/shared";
import {
  BANK_MINIMUM_CAPITAL_RATIO_BP,
  BANK_MINIMUM_RESERVE_RATIO_BP,
  BANK_OPENING_RESERVE_CENTS,
  ECONOMIC_INDICATOR_RULESET_VERSION,
  GDP_PROXY_WINDOW_TICKS,
  assertCanOpenAccount,
  bankRatioBasisPoints,
  calculateFullIndicatorExtensions,
  DoubleEntryLedger,
  representativePostedPriceCents,
  sentimentValueAtTick,
  simDateForTick,
} from "@worldtangle/engine";
import type {
  LedgerAccountSnapshot,
  LedgerPostResult,
  LedgerRepository,
  RiverbendPopulation,
  StoredLedgerTransaction,
} from "@worldtangle/engine";
import type { IdFactory } from "@worldtangle/shared";
import type { WorldDatabase } from "./database";
import { toSafeNumber } from "./database";

const SYSTEM_ACTOR = { kind: "system", id: "finance" } as const;
const UNBOUNDED_INTERNAL_FLOOR = "-999999999999999999999999999";
const TREASURY_OPENING_CENTS = "18000000";

interface AccountRow {
  id: string;
  run_id: string;
  bank_id: string;
  owner_kind: AccountOwnerKind;
  owner_id: string;
  account_type: BankAccountType;
  balance_cents: string;
  floor_cents: string;
  status: "active" | "frozen" | "closed";
  opened_tick: bigint;
}

interface TransactionRow {
  id: string;
  run_id: string;
  tick: bigint;
  kind: TransactionKind;
  actor_kind: ActorRef["kind"];
  actor_id: string;
  reason: string;
  source_event_id: string | null;
  correlation_id: string;
  idempotency_key: string;
  request_hash: string;
}

interface LegRow {
  account_id: string;
  direction: "debit" | "credit";
  amount_cents: string;
}

export interface FinanceGenesis {
  readonly bankId: string;
  readonly treasuryAccountId: string;
  readonly rowAccountId: string;
  readonly accounts: readonly BankAccount[];
  readonly mintTransactions: readonly LedgerTransaction[];
  readonly loanTransactions: readonly LedgerTransaction[];
  readonly seedLoanLinks: readonly {
    readonly loanId: string;
    readonly bankAssetAccountId: string;
    readonly borrowerDepositAccountId: string;
    readonly recognitionTransactionId: string;
  }[];
  readonly policies: readonly {
    readonly id: string;
    readonly key: PolicyKey;
    readonly valueInteger: string;
  }[];
  readonly employmentContractIds: readonly string[];
  readonly indicators: Readonly<Record<IndicatorKey, string>>;
  readonly indicatorEvidence: Readonly<Record<IndicatorKey, IndicatorPointEvidence>>;
}

export interface IndicatorPointEvidence {
  readonly formulaVersion: number;
  readonly inputsDigest: string;
}

export interface EconomicIndicatorSnapshot {
  readonly values: Readonly<Record<IndicatorKey, string>>;
  readonly evidence: Readonly<Record<IndicatorKey, IndicatorPointEvidence>>;
}

export interface PayrollObligation {
  readonly contractId: string;
  readonly employerId: string;
  readonly employerAccountId: string;
  readonly employeeAgentId: string;
  readonly employeeAccountId: string;
  readonly annualWageCents: string;
  readonly employerOwnerKind: AccountOwnerKind;
}

export interface HouseholdFinanceRow {
  readonly householdId: string;
  readonly memberAgentIds: readonly string[];
  readonly housingTier: "modest" | "standard" | "comfortable";
  readonly budgetPolicy: {
    readonly bufferDays: number;
    readonly discretionaryPropensityBp: number;
  };
  readonly annualIncomeCents: string;
  readonly memberAccounts: readonly { readonly accountId: string; readonly balanceCents: string }[];
}

export interface TransactionQuery {
  readonly limit: number;
  readonly beforeId?: string;
  readonly accountId?: string;
  readonly kind?: TransactionKind;
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly correlationId?: string;
}

export type TransactionView = Omit<LedgerTransaction, "legs"> & {
  readonly legs: (LedgerTransaction["legs"][number] & {
    readonly ownerKind: AccountOwnerKind;
    readonly ownerId: string;
    readonly ownerName: string;
  })[];
};

function parseStringArray(text: string, field: string): readonly string[] {
  const parsed = canonicalParse(text);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new EngineError("INTERNAL", `${field} is not a string array`);
  }
  return parsed;
}

function mapAccount(row: AccountRow): BankAccount {
  return bankAccountSchema.parse({
    id: row.id,
    runId: row.run_id,
    bankId: row.bank_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    type: row.account_type,
    balanceCents: row.balance_cents,
    floorCents: row.floor_cents,
    status: row.status,
    openedTick: toSafeNumber(row.opened_tick, "bank account opened tick"),
  });
}

export class SqliteFinanceStore implements LedgerRepository {
  private readonly ledger: DoubleEntryLedger;

  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    if (!runIdSchema.safeParse(runId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
    }
    if (db.prepare<[string], { id: string }>("SELECT id FROM simulation_runs WHERE id = ?").get(runId) === undefined) {
      throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
    }
    this.ledger = new DoubleEntryLedger(this);
  }

  initialize(
    population: RiverbendPopulation,
    ids: IdFactory,
    policyOverrides: Readonly<Record<string, number>> = {},
    sourceEventId: string | null = null,
  ): FinanceGenesis {
    if (population.residents.some((resident) => resident.agent.runId !== this.runId)) {
      throw new EngineError("CONFLICT", "population belongs to another run");
    }
    if (this.db.prepare<[string], { id: string }>("SELECT id FROM banks WHERE run_id = ?").get(this.runId)) {
      throw new EngineError("CONFLICT", `run ${this.runId} already has authoritative finance state`);
    }

    let result: FinanceGenesis | undefined;
    const persist = (): void => {
      const bankId = ids.next("bank");
      this.db.prepare(`
        INSERT INTO banks(
          run_id, id, name, capital_cents, reserve_ratio_bp, capital_ratio_min_bp,
          base_lending_rate_bp, exposure_cap_cents, status, reserve_cents
        ) VALUES (
          ?, ?, 'First Ledger Bank', '73920000', ?, ?, 500,
          '120000000', 'active', ?
        )
      `).run(
        this.runId,
        bankId,
        BANK_MINIMUM_RESERVE_RATIO_BP,
        BANK_MINIMUM_CAPITAL_RATIO_BP,
        BANK_OPENING_RESERVE_CENTS,
      );

      const mintSourceAccountId = ids.next("acct");
      const loanSourceAccountId = ids.next("acct");
      const rowAccountId = ids.next("acct");
      const treasuryAccountId = ids.next("acct");
      this.insertAccount({
        id: mintSourceAccountId,
        runId: this.runId,
        bankId,
        ownerKind: "bank_internal",
        ownerId: bankId,
        type: "equity",
        balanceCents: "0",
        floorCents: UNBOUNDED_INTERNAL_FLOOR,
        status: "active",
        openedTick: 0,
      });
      this.insertAccount({
        id: loanSourceAccountId,
        runId: this.runId,
        bankId,
        ownerKind: "bank_internal",
        ownerId: `${bankId}:loan_source`,
        type: "internal_liability",
        balanceCents: "0",
        floorCents: UNBOUNDED_INTERNAL_FLOOR,
        status: "active",
        openedTick: 0,
      });
      this.insertAccount({
        id: rowAccountId,
        runId: this.runId,
        bankId,
        ownerKind: "system_row",
        ownerId: "row_riverbend",
        type: "checking",
        balanceCents: "0",
        floorCents: UNBOUNDED_INTERNAL_FLOOR,
        status: "active",
        openedTick: 0,
      });
      this.insertAccount({
        id: treasuryAccountId,
        runId: this.runId,
        bankId,
        ownerKind: "government",
        ownerId: "inst_town_riverbend",
        type: "checking",
        balanceCents: "0",
        floorCents: "0",
        status: "active",
        openedTick: 0,
      });

      const accountByOwner = new Map<string, string>();
      for (const opening of population.accounts) {
        const ownerKind = opening.ownerKind === "business" ? "company" : "agent";
        this.insertAccount({
          id: opening.id,
          runId: this.runId,
          bankId,
          ownerKind,
          ownerId: opening.ownerId,
          type: "checking",
          balanceCents: "0",
          floorCents: "0",
          status: "active",
          openedTick: 0,
        });
        accountByOwner.set(`${ownerKind}:${opening.ownerId}`, opening.id);
      }
      accountByOwner.set("government:inst_town_riverbend", treasuryAccountId);
      accountByOwner.set("system_row:row_riverbend", rowAccountId);

      const employedOrganizations = [...new Set(
        population.residents
          .filter((resident) => resident.agent.employmentStatus === "employed")
          .map((resident) => resident.organizationId)
          .filter((organizationId): organizationId is string => organizationId !== null),
      )].sort();
      for (const organizationId of employedOrganizations) {
        if (organizationId === "inst_town_riverbend") continue;
        if (accountByOwner.has(`company:${organizationId}`)) continue;
        const accountId = ids.next("acct");
        this.insertAccount({
          id: accountId,
          runId: this.runId,
          bankId,
          ownerKind: "company",
          ownerId: organizationId,
          type: "checking",
          balanceCents: "0",
          floorCents: "0",
          status: "active",
          openedTick: 0,
        });
        accountByOwner.set(`company:${organizationId}`, accountId);
      }

      const governmentEmployees = population.residents
        .filter((resident) => resident.organizationId === "inst_town_riverbend")
        .sort((left, right) => left.agent.id < right.agent.id ? -1 : left.agent.id > right.agent.id ? 1 : 0);
      const officeholders = Object.fromEntries(governmentEmployees
        .filter((resident) =>
          resident.roleCode === "government.mayor" ||
          resident.roleCode === "government.treasurer"
        )
        .map((resident) => [
          resident.roleCode.slice("government.".length),
          resident.agent.id,
        ]));
      this.db.prepare(`
        INSERT INTO government_institutions(
          run_id, id, name, treasury_account_id,
          officeholders_canonical, employee_agent_ids_canonical
        ) VALUES (?, 'inst_town_riverbend', 'Town of Riverbend', ?, ?, ?)
      `).run(
        this.runId,
        treasuryAccountId,
        canonicalStringify(officeholders),
        canonicalStringify(governmentEmployees.map((resident) => resident.agent.id)),
      );

      const mintTransactions: LedgerTransaction[] = [];
      for (const mint of population.mintTransactions) {
        const transaction = ledgerTransactionSchema.parse({
          id: mint.id,
          runId: this.runId,
          tick: 0,
          kind: "mint",
          actor: SYSTEM_ACTOR,
          reason: "world_gen.opening_balance",
          sourceEventId,
          correlationId: `world-gen:${this.runId}`,
          idempotencyKey: `opening-mint:${mint.accountId}`,
          legs: [
            { accountId: mint.accountId, direction: "debit", amountCents: mint.amountCents },
            { accountId: mintSourceAccountId, direction: "credit", amountCents: mint.amountCents },
          ],
        });
        this.ledger.post(transaction);
        mintTransactions.push(transaction);
      }
      const treasuryMint = ledgerTransactionSchema.parse({
        id: ids.next("txn"),
        runId: this.runId,
        tick: 0,
        kind: "mint",
        actor: SYSTEM_ACTOR,
        reason: "world_gen.treasury_endowment",
        sourceEventId,
        correlationId: `world-gen:${this.runId}`,
        idempotencyKey: "opening-mint:treasury",
        legs: [
          { accountId: treasuryAccountId, direction: "debit", amountCents: TREASURY_OPENING_CENTS },
          { accountId: mintSourceAccountId, direction: "credit", amountCents: TREASURY_OPENING_CENTS },
        ],
      });
      this.ledger.post(treasuryMint);
      mintTransactions.push(treasuryMint);

      const loanTransactions: LedgerTransaction[] = [];
      const seedLoanLinks: {
        loanId: string;
        bankAssetAccountId: string;
        borrowerDepositAccountId: string;
        recognitionTransactionId: string;
      }[] = [];
      const insertLoanLink = this.db.prepare(`
        INSERT INTO seed_loan_ledger_links(
          run_id, loan_id, bank_asset_account_id,
          borrower_deposit_account_id, disbursement_transaction_id
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const loan of population.loans) {
        const assetAccountId = ids.next("acct");
        this.insertAccount({
          id: assetAccountId,
          runId: this.runId,
          bankId,
          ownerKind: "bank_internal",
          ownerId: loan.id,
          type: "internal_asset",
          balanceCents: "0",
          floorCents: "0",
          status: "active",
          openedTick: 0,
        });
        const borrowerKind = loan.borrowerKind === "business" ? "company" : "agent";
        const borrowerAccountId = accountByOwner.get(`${borrowerKind}:${loan.borrowerId}`);
        if (borrowerAccountId === undefined) {
          throw new EngineError("INTERNAL", `missing deposit account for seed loan ${loan.id}`);
        }
        const transaction = ledgerTransactionSchema.parse({
          id: ids.next("txn"),
          runId: this.runId,
          tick: 0,
          kind: "loan_disbursement",
          actor: SYSTEM_ACTOR,
          reason: "world_gen.seed_loan_recognition",
          sourceEventId,
          correlationId: `world-gen:${this.runId}`,
          idempotencyKey: `opening-loan:${loan.id}`,
          legs: [
            {
              accountId: assetAccountId,
              direction: "debit",
              amountCents: loan.outstandingPrincipalCents,
            },
            {
              accountId: loanSourceAccountId,
              direction: "credit",
              amountCents: loan.outstandingPrincipalCents,
            },
          ],
        });
        this.ledger.post(transaction);
        insertLoanLink.run(
          this.runId,
          loan.id,
          assetAccountId,
          borrowerAccountId,
          transaction.id,
        );
        loanTransactions.push(transaction);
        seedLoanLinks.push({
          loanId: loan.id,
          bankAssetAccountId: assetAccountId,
          borrowerDepositAccountId: borrowerAccountId,
          recognitionTransactionId: transaction.id,
        });
      }

      const override = (keys: readonly string[], fallback: number): string => {
        const selected = keys
          .map((key) => policyOverrides[key])
          .find((value): value is number => value !== undefined);
        const value = selected ?? fallback;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new EngineError("VALIDATION_FAILED", `invalid policy override ${keys[0]}`);
        }
        return value.toString();
      };
      const withholding = override(
        ["personal_withholding_rate_bp", "income_tax_rate_bp"],
        1_500,
      );
      if (Number(withholding) > 10_000) {
        throw new EngineError("VALIDATION_FAILED", "withholding rate cannot exceed 10000 bp");
      }
      const policyValues: readonly [PolicyKey, string][] = [
        ["personal_withholding_rate_bp", withholding],
        ["unemployment_benefit_annual_cents", override(["unemployment_benefit_annual_cents"], 1_200_000)],
        ["food_monthly_per_person_cents", override(["food_monthly_per_person_cents"], 35_000)],
        ["utilities_monthly_cents", override(["utilities_monthly_cents"], 15_000)],
      ];
      const policies: { id: string; key: PolicyKey; valueInteger: string }[] = [];
      const insertPolicy = this.db.prepare(`
        INSERT INTO policies(
          run_id, id, policy_key, value_integer, effective_tick, source,
          previous_value_integer, cause_event_id
        ) VALUES (?, ?, ?, ?, 0, 'world_gen', NULL, NULL)
      `);
      for (const [key, value] of policyValues) {
        const id = ids.next("pol");
        insertPolicy.run(this.runId, id, key, value);
        policies.push({ id, key, valueInteger: value });
      }
      const policyMap = new Map(policyValues);
      const insertSku = this.db.prepare(`
        INSERT INTO row_reference_skus(
          run_id, sku, category, unit, reference_price_cents, active
        ) VALUES (?, ?, ?, ?, ?, 1)
      `);
      const skus = [
        ["row.food_basket_person_month", "food", "person_month", policyMap.get("food_monthly_per_person_cents")!],
        ["row.utilities_household_month", "utilities", "household_month", policyMap.get("utilities_monthly_cents")!],
        ["row.rent_modest_month", "rent", "household_month", "65000"],
        ["row.rent_standard_month", "rent", "household_month", "90000"],
        ["row.rent_comfortable_month", "rent", "household_month", "140000"],
        ["row.discretionary_unit", "discretionary", "unit", "100"],
      ] as const;
      for (const [sku, category, unit, price] of skus) {
        insertSku.run(this.runId, sku, category, unit, price);
      }

      const employmentContractIds: string[] = [];
      const insertEmployment = this.db.prepare(`
        INSERT INTO employment_contracts(
          run_id, id, employer_id, employer_account_id, employee_agent_id,
          annual_wage_cents, start_tick, end_tick, notice_days, status, legal_contract_id
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 14, 'active', NULL)
      `);
      for (const resident of population.residents) {
        if (resident.agent.employmentStatus !== "employed") continue;
        const employerId = resident.organizationId ?? "row_independent_clients";
        const employerAccountId = resident.organizationId === null
          ? rowAccountId
          : resident.organizationId === "inst_town_riverbend"
            ? treasuryAccountId
            : accountByOwner.get(`company:${resident.organizationId}`);
        if (employerAccountId === undefined) {
          throw new EngineError("INTERNAL", `missing employer account for ${employerId}`);
        }
        const contractId = ids.next("emp");
        insertEmployment.run(
          this.runId,
          contractId,
          employerId,
          employerAccountId,
          resident.agent.id,
          resident.annualIncomeCents,
        );
        employmentContractIds.push(contractId);
      }

      const insertEquity = this.db.prepare(`
        INSERT INTO opening_company_equity(run_id, company_id, total_shares)
        VALUES (?, ?, '10000')
      `);
      const insertStake = this.db.prepare(`
        INSERT INTO opening_company_equity_stakes(
          run_id, company_id, owner_agent_id, shares
        ) VALUES (?, ?, ?, '10000')
      `);
      const insertCapTable = this.db.prepare(`
        INSERT INTO company_cap_tables(
          run_id, company_id, company_kind, total_shares, revision, last_event_id
        ) VALUES (?, ?, 'opening', '10000', 0, ?)
      `);
      const insertOwnershipStake = this.db.prepare(`
        INSERT INTO ownership_stakes(
          run_id, id, company_id, holder_kind, holder_id, shares,
          acquired_via, since_tick, source_event_id
        ) VALUES (?, ?, ?, 'agent', ?, '10000', 'founding', 0, ?)
      `);
      const companyIds = population.accounts
        .filter((account) => account.ownerKind === "business")
        .map((account) => account.ownerId)
        .sort();
      for (const companyId of companyIds) {
        const founder = population.residents.find(
          (resident) => resident.organizationId === companyId && resident.roleCode.endsWith(".owner"),
        );
        if (founder === undefined) {
          throw new EngineError("INTERNAL", `company ${companyId} has no opening founder`);
        }
        insertEquity.run(this.runId, companyId);
        insertCapTable.run(this.runId, companyId, sourceEventId);
        insertStake.run(this.runId, companyId, founder.agent.id);
        insertOwnershipStake.run(
          this.runId,
          `stk_${(companyId + founder.agent.id).replaceAll("_", "")}`,
          companyId,
          founder.agent.id,
          sourceEventId,
        );
      }

      const indicatorSnapshot = this.computeIndicatorSnapshot(0);
      this.insertIndicatorPoints(0, indicatorSnapshot);
      result = {
        bankId,
        treasuryAccountId,
        rowAccountId,
        accounts: this.listAccounts(),
        mintTransactions,
        loanTransactions,
        seedLoanLinks,
        policies,
        employmentContractIds,
        indicators: indicatorSnapshot.values,
        indicatorEvidence: indicatorSnapshot.evidence,
      };
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
    return result!;
  }

  openAccount(input: {
    readonly id: string;
    readonly bankId: string;
    readonly ownerKind: AccountOwnerKind;
    readonly ownerId: string;
    readonly type: BankAccountType;
    readonly floorCents: string;
    readonly openedTick: number;
    readonly actor: ActorRef;
  }): BankAccount {
    const actor = actorRefSchema.parse(input.actor);
    assertCanOpenAccount(actor, input.ownerKind, input.ownerId);
    const bank = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM banks WHERE run_id = ? AND id = ? AND status <> 'closed'
    `).get(this.runId, input.bankId);
    if (bank === undefined) throw new EngineError("NOT_FOUND", `bank ${input.bankId} does not exist`);
    if (input.ownerKind === "agent") {
      const owner = this.db.prepare<[string, string], { id: string }>(`
        SELECT id FROM agents WHERE run_id = ? AND id = ?
      `).get(this.runId, input.ownerId);
      if (owner === undefined) throw new EngineError("NOT_FOUND", `agent ${input.ownerId} does not exist`);
    }
    if (input.ownerKind === "company") {
      const registered = this.db.prepare<
        [string, string, string, string, string, string],
        { organization_id: string }
      >(`
        SELECT organization_id FROM agents
        WHERE run_id = ? AND organization_id = ?
        UNION ALL
        SELECT id AS organization_id FROM companies
        WHERE run_id = ? AND id = ? AND status IN ('registered', 'active')
        UNION ALL
        SELECT id AS organization_id FROM vc_firms
        WHERE run_id = ? AND id = ? AND status = 'active'
        LIMIT 1
      `).get(
        this.runId,
        input.ownerId,
        this.runId,
        input.ownerId,
        this.runId,
        input.ownerId,
      );
      if (registered === undefined) {
        throw new EngineError("NOT_FOUND", `registered company ${input.ownerId} does not exist`);
      }
    }
    const account = bankAccountSchema.parse({
      id: input.id,
      runId: this.runId,
      bankId: input.bankId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      type: input.type,
      balanceCents: "0",
      floorCents: input.floorCents,
      status: "active",
      openedTick: input.openedTick,
    });
    this.insertAccount(account);
    return account;
  }

  post(transaction: LedgerTransaction): LedgerPostResult {
    return this.ledger.post(transaction);
  }

  findByIdempotencyKey(runId: string, idempotencyKey: string): StoredLedgerTransaction | null {
    const row = this.db.prepare<[string, string], TransactionRow>(`
      SELECT * FROM ledger_transactions WHERE run_id = ? AND idempotency_key = ?
    `).get(runId, idempotencyKey);
    if (row === undefined) return null;
    return { transaction: this.mapTransaction(row), requestHash: row.request_hash };
  }

  getAccounts(runId: string, accountIds: readonly string[]): readonly LedgerAccountSnapshot[] {
    if (accountIds.length === 0) return [];
    const placeholders = accountIds.map(() => "?").join(", ");
    return this.db.prepare<unknown[], AccountRow>(`
      SELECT * FROM bank_accounts WHERE run_id = ? AND id IN (${placeholders}) ORDER BY id
    `).all(runId, ...accountIds).map((row) => ({
      id: row.id,
      runId: row.run_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      type: row.account_type,
      balanceCents: BigInt(row.balance_cents),
      floorCents: BigInt(row.floor_cents),
      status: row.status,
    }));
  }

  saveTransaction(
    transaction: LedgerTransaction,
    requestHash: string,
    resultingBalances: ReadonlyMap<string, bigint>,
  ): void {
    const persist = (): void => {
      this.db.prepare(`
        INSERT INTO ledger_transactions(
          run_id, id, tick, kind, actor_kind, actor_id, reason, source_event_id,
          correlation_id, idempotency_key, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        transaction.runId,
        transaction.id,
        transaction.tick,
        transaction.kind,
        transaction.actor.kind,
        transaction.actor.id,
        transaction.reason,
        transaction.sourceEventId,
        transaction.correlationId,
        transaction.idempotencyKey,
        requestHash,
      );
      const insertLeg = this.db.prepare(`
        INSERT INTO ledger_transaction_legs(
          run_id, transaction_id, leg_index, account_id, direction, amount_cents
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      transaction.legs.forEach((leg, index) => {
        insertLeg.run(
          transaction.runId,
          transaction.id,
          index,
          leg.accountId,
          leg.direction,
          leg.amountCents,
        );
      });
      const update = this.db.prepare(`
        UPDATE bank_accounts SET balance_cents = ? WHERE run_id = ? AND id = ?
      `);
      for (const [accountId, balanceCents] of resultingBalances) {
        if (update.run(balanceCents.toString(), transaction.runId, accountId).changes !== 1) {
          throw new EngineError("CONFLICT", `could not update ledger account ${accountId}`);
        }
      }
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
  }

  listAccounts(): readonly BankAccount[] {
    return this.db.prepare<[string], AccountRow>(`
      SELECT * FROM bank_accounts WHERE run_id = ? ORDER BY id
    `).all(this.runId).map(mapAccount);
  }

  accountForAgent(agentId: string): BankAccount {
    const row = this.db.prepare<[string, string], AccountRow>(`
      SELECT * FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'agent' AND owner_id = ? AND account_type = 'checking'
      ORDER BY id LIMIT 1
    `).get(this.runId, agentId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} has no checking account`);
    return mapAccount(row);
  }

  accountBalance(accountId: string): bigint {
    const row = this.db.prepare<[string, string], { balance_cents: string }>(`
      SELECT balance_cents FROM bank_accounts WHERE run_id = ? AND id = ?
    `).get(this.runId, accountId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `account ${accountId} does not exist`);
    return BigInt(row.balance_cents);
  }

  systemAccount(ownerKind: "government" | "system_row", ownerId: string): BankAccount {
    const row = this.db.prepare<[string, string, string], AccountRow>(`
      SELECT * FROM bank_accounts
      WHERE run_id = ? AND owner_kind = ? AND owner_id = ?
      ORDER BY id LIMIT 1
    `).get(this.runId, ownerKind, ownerId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `${ownerKind}:${ownerId} has no account`);
    return mapAccount(row);
  }

  policyValue(key: PolicyKey, tick: number): bigint {
    const row = this.db.prepare<[string, string, number], { value_integer: string }>(`
      SELECT value_integer FROM policies
      WHERE run_id = ? AND policy_key = ? AND effective_tick <= ?
      ORDER BY effective_tick DESC, id DESC LIMIT 1
    `).get(this.runId, key, tick);
    if (row === undefined) throw new EngineError("NOT_FOUND", `policy ${key} is not effective at tick ${tick}`);
    return BigInt(row.value_integer);
  }

  schedulePolicyChange(input: {
    readonly id: string;
    readonly key: PolicyKey;
    readonly valueInteger: string;
    readonly effectiveTick: number;
    readonly source: "admin" | "schedule";
    readonly causeEventId: string;
    readonly actor: ActorRef;
  }): Readonly<{
    policyId: string;
    key: PolicyKey;
    old: string;
    new: string;
    effectiveTick: number;
    source: "admin" | "schedule";
    causeEventId: string;
  }> {
    const actor = actorRefSchema.parse(input.actor);
    if (
      (input.source === "admin" && actor.kind !== "admin") ||
      (input.source === "schedule" && actor.kind !== "system")
    ) {
      throw new EngineError("PERMISSION_DENIED", "policy changes require the matching admin or schedule capability");
    }
    const current = this.db.prepare<[string], { current_tick: bigint }>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId)!;
    const currentTick = toSafeNumber(current.current_tick, "run current tick");
    if (!Number.isSafeInteger(input.effectiveTick) || input.effectiveTick <= currentTick) {
      throw new EngineError(
        "VALIDATION_FAILED",
        "policy changes must be scheduled for a future tick boundary",
      );
    }
    if (!/^-?\d+$/.test(input.valueInteger)) {
      throw new EngineError("VALIDATION_FAILED", "policy value must be an integer string");
    }
    const previous = this.policyValue(input.key, input.effectiveTick - 1);
    this.db.prepare(`
      INSERT INTO policies(
        run_id, id, policy_key, value_integer, effective_tick, source,
        previous_value_integer, cause_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      input.id,
      input.key,
      input.valueInteger,
      input.effectiveTick,
      input.source,
      previous.toString(),
      input.causeEventId,
    );
    return {
      policyId: input.id,
      key: input.key,
      old: previous.toString(),
      new: input.valueInteger,
      effectiveTick: input.effectiveTick,
      source: input.source,
      causeEventId: input.causeEventId,
    };
  }

  listPayrollObligations(): readonly PayrollObligation[] {
    return this.db.prepare<[string], {
      contract_id: string;
      employer_id: string;
      employer_account_id: string;
      employee_agent_id: string;
      employee_account_id: string;
      annual_wage_cents: string;
      employer_owner_kind: AccountOwnerKind;
    }>(`
      SELECT
        e.id AS contract_id,
        e.employer_id,
        e.employer_account_id,
        e.employee_agent_id,
        employee_account.id AS employee_account_id,
        e.annual_wage_cents,
        employer_account.owner_kind AS employer_owner_kind
      FROM employment_contracts e
      JOIN bank_accounts employer_account
        ON employer_account.run_id = e.run_id AND employer_account.id = e.employer_account_id
      JOIN bank_accounts employee_account
        ON employee_account.run_id = e.run_id
        AND employee_account.owner_kind = 'agent'
        AND employee_account.owner_id = e.employee_agent_id
        AND employee_account.account_type = 'checking'
      WHERE e.run_id = ? AND e.status = 'active'
      ORDER BY e.employee_agent_id, e.id
    `).all(this.runId).map((row) => ({
      contractId: row.contract_id,
      employerId: row.employer_id,
      employerAccountId: row.employer_account_id,
      employeeAgentId: row.employee_agent_id,
      employeeAccountId: row.employee_account_id,
      annualWageCents: row.annual_wage_cents,
      employerOwnerKind: row.employer_owner_kind,
    }));
  }

  unemployedAgents(): readonly { readonly agentId: string; readonly accountId: string }[] {
    return this.db.prepare<[string], { agent_id: string; account_id: string }>(`
      SELECT a.id AS agent_id, ba.id AS account_id
      FROM agents a
      JOIN bank_accounts ba
        ON ba.run_id = a.run_id AND ba.owner_kind = 'agent'
        AND ba.owner_id = a.id AND ba.account_type = 'checking'
      WHERE a.run_id = ? AND a.employment_status = 'unemployed'
      ORDER BY a.id
    `).all(this.runId).map((row) => ({ agentId: row.agent_id, accountId: row.account_id }));
  }

  recordTax(input: {
    readonly id: string;
    readonly payerId: string;
    readonly period: string;
    readonly baseCents: string;
    readonly rateBp: number;
    readonly amountCents: string;
    readonly transactionId: string;
    readonly tick: number;
  }): void {
    this.db.prepare(`
      INSERT INTO tax_records(
        run_id, id, kind, payer_id, period, base_cents, rate_bp,
        amount_cents, transaction_id, tick
      ) VALUES (?, ?, 'personal_withholding', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      input.id,
      input.payerId,
      input.period,
      input.baseCents,
      input.rateBp,
      input.amountCents,
      input.transactionId,
      input.tick,
    );
  }

  listHouseholdFinances(): readonly HouseholdFinanceRow[] {
    const rows = this.db.prepare<[string], {
      id: string;
      member_ids_canonical: string;
      housing_tier: HouseholdFinanceRow["housingTier"];
      budget_policy_canonical: string;
      annual_income_cents: string;
    }>(`
      SELECT h.id, h.member_ids_canonical, h.housing_tier, h.budget_policy_canonical,
        CAST(COALESCE(SUM(CAST(a.annual_income_cents AS INTEGER)), 0) AS TEXT) AS annual_income_cents
      FROM households h
      JOIN agents a ON a.run_id = h.run_id AND a.household_id = h.id
      WHERE h.run_id = ?
      GROUP BY h.id
      ORDER BY h.id
    `).all(this.runId);
    return rows.map((row) => {
      const memberAgentIds = parseStringArray(row.member_ids_canonical, `household ${row.id} members`);
      const budget = canonicalParse(row.budget_policy_canonical);
      if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
        throw new EngineError("INTERNAL", `household ${row.id} budget policy is invalid`);
      }
      const budgetRecord = budget as Record<string, unknown>;
      const memberAccounts = memberAgentIds.map((agentId) => {
        const account = this.accountForAgent(agentId);
        return { accountId: account.id, balanceCents: account.balanceCents };
      });
      return {
        householdId: row.id,
        memberAgentIds,
        housingTier: row.housing_tier,
        budgetPolicy: {
          bufferDays: Number(budgetRecord["bufferDays"]),
          discretionaryPropensityBp: Number(budgetRecord["discretionaryPropensityBp"]),
        },
        annualIncomeCents: row.annual_income_cents,
        memberAccounts,
      };
    });
  }

  computeIndicatorSnapshot(tick: number): EconomicIndicatorSnapshot {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "indicator tick must be non-negative");
    }
    const m1Accounts = this.db.prepare<
      [string],
      { id: string; balance_cents: string }
    >(`
      SELECT id, balance_cents FROM bank_accounts
      WHERE run_id = ? AND account_type = 'checking' AND owner_kind IN ('agent', 'company')
      ORDER BY id
    `).all(this.runId);
    const m1 = m1Accounts.reduce((sum, row) => sum + BigInt(row.balance_cents), 0n);

    const wages = this.db.prepare<
      [string],
      { id: string; annual_wage_cents: string }
    >(`
      SELECT id, annual_wage_cents FROM employment_contracts
      WHERE run_id = ? AND status = 'active' ORDER BY id
    `).all(this.runId);
    const wageTotal = wages.reduce((sum, row) => sum + BigInt(row.annual_wage_cents), 0n);
    const averageWage = wages.length === 0
      ? 0n
      : mulDiv(money(wageTotal), 1n, BigInt(wages.length), "HALF_EVEN");

    const labor = this.db.prepare<
      [string],
      { id: string; employment_status: "employed" | "unemployed" }
    >(`
      SELECT id, employment_status FROM agents
      WHERE run_id = ? AND employment_status IN ('employed', 'unemployed') ORDER BY id
    `).all(this.runId);
    const unemployed = labor.filter((row) => row.employment_status === "unemployed").length;
    const unemploymentRate = labor.length === 0
      ? 0n
      : mulDiv(
          money(BigInt(unemployed)),
          10_000n,
          BigInt(labor.length),
          "HALF_EVEN",
        );

    const openingCredit = this.db.prepare<
      [string],
      { id: string; outstanding_principal_cents: string; status: string }
    >(`
      SELECT id, outstanding_principal_cents, status
      FROM seed_loans WHERE run_id = ? ORDER BY id
    `).all(this.runId);
    const originatedCredit = this.db.prepare<
      [string],
      { id: string; outstanding_principal_cents: string; status: string }
    >(`
      SELECT id, outstanding_principal_cents, status
      FROM loans WHERE run_id = ? ORDER BY id
    `).all(this.runId);
    const defaults = this.db.prepare<
      [string],
      { id: string; loan_id: string; default_tick: bigint }
    >(`
      SELECT id, loan_id, default_tick FROM loan_defaults
      WHERE run_id = ? ORDER BY id
    `).all(this.runId);
    const allCredit = [...openingCredit, ...originatedCredit];
    const creditOutstanding = allCredit.reduce(
      (sum, row) => sum + BigInt(row.outstanding_principal_cents),
      0n,
    );
    const totalLoans = BigInt(allCredit.length);
    const defaultRate = totalLoans === 0n
      ? 0n
      : mulDiv(money(BigInt(defaults.length)), 10_000n, totalLoans, "HALF_EVEN");

    const products = this.db.prepare<[], {
      sku: string;
      basket_weight_bp: bigint;
      row_reference_price_cents: string;
    }>(`
      SELECT sku, basket_weight_bp, row_reference_price_cents
      FROM market_products ORDER BY sku
    `).all();
    const offerings = this.db.prepare<
      [string],
      { id: string; sku: string; posted_price_cents: string }
    >(`
      SELECT id, sku, posted_price_cents FROM market_offerings
      WHERE run_id = ? AND active = 1 ORDER BY sku, id
    `).all(this.runId);
    const offeringsBySku = new Map<string, typeof offerings>();
    for (const offering of offerings) {
      const current = offeringsBySku.get(offering.sku) ?? [];
      current.push(offering);
      offeringsBySku.set(offering.sku, current);
    }
    const rowPriceHistory = this.db.prepare<
      [string, number],
      { id: string; sku: string; effective_tick: bigint; new_price_cents: string }
    >(`
      SELECT id, sku, effective_tick, new_price_cents FROM row_reference_price_history
      WHERE run_id = ? AND effective_tick <= ?
      ORDER BY sku, effective_tick DESC, id DESC
    `).all(this.runId, tick);
    const latestRowPriceBySku = new Map<string, (typeof rowPriceHistory)[number]>();
    for (const row of rowPriceHistory) {
      if (!latestRowPriceBySku.has(row.sku)) latestRowPriceBySku.set(row.sku, row);
    }
    const householdTariff = this.db.prepare<
      [string, number],
      { id: string; effective_tick: bigint; price_cents: string }
    >(`
      SELECT id, effective_tick, price_cents FROM energy_tariff_history
      WHERE run_id = ? AND customer_class = 'household' AND effective_tick <= ?
      ORDER BY effective_tick DESC, id DESC LIMIT 1
    `).get(this.runId, tick);
    const cpiEvidence: {
      sku: string;
      weightBp: number;
      basePriceCents: string;
      currentPriceCents: string;
      source: string;
      sourceIds: readonly string[];
    }[] = [];
    const cpiBasket = products.map((product) => {
      const weightBp = toSafeNumber(product.basket_weight_bp, `${product.sku} basket weight`);
      const changedRowPrice = latestRowPriceBySku.get(product.sku);
      const fallbackPrice = changedRowPrice?.new_price_cents ?? product.row_reference_price_cents;
      const localOfferings = offeringsBySku.get(product.sku) ?? [];
      const currentPrice = product.sku === "electricity" && householdTariff !== undefined
        ? BigInt(householdTariff.price_cents)
        : localOfferings.length > 0
          ? representativePostedPriceCents(
              localOfferings.map((offering) => offering.posted_price_cents),
            )
          : BigInt(fallbackPrice);
      const source = product.sku === "electricity" && householdTariff !== undefined
        ? "household_tariff"
        : localOfferings.length > 0
          ? "active_offering_mean"
          : changedRowPrice === undefined
            ? "tick0_reference"
            : "row_reference";
      const sourceIds = product.sku === "electricity" && householdTariff !== undefined
        ? [householdTariff.id]
        : localOfferings.length > 0
          ? localOfferings.map((offering) => offering.id)
          : changedRowPrice === undefined
            ? []
            : [changedRowPrice.id];
      const item = {
        sku: product.sku,
        weightBp,
        basePriceCents: product.row_reference_price_cents,
        currentPriceCents: currentPrice.toString(),
      };
      cpiEvidence.push({ ...item, source, sourceIds });
      return item;
    });

    const gdpFromTick = Math.max(1, tick - GDP_PROXY_WINDOW_TICKS + 1);
    const finalGoodsSales = tick === 0
      ? []
      : this.db.prepare<
          [string, number, number],
          { id: string; settled_tick: bigint; total_cents: string; settlement_transaction_id: string }
        >(`
          SELECT id, settled_tick, total_cents, settlement_transaction_id
          FROM goods_orders
          WHERE run_id = ? AND status = 'filled'
            AND buyer_kind IN ('agent', 'household')
            AND settled_tick BETWEEN ? AND ?
          ORDER BY settled_tick, id
        `).all(this.runId, gdpFromTick, tick);
    const finalEnergySales = tick === 0
      ? []
      : this.db.prepare<
          [string, number, number],
          { id: string; tick: bigint; amount_cents: string; transaction_id: string }
        >(`
          SELECT id, tick, amount_cents, transaction_id FROM energy_bills
          WHERE run_id = ? AND customer_class = 'household' AND status = 'paid'
            AND tick BETWEEN ? AND ?
          ORDER BY tick, id
        `).all(this.runId, gdpFromTick, tick);
    const finalDomesticSalesCents = [
      ...finalGoodsSales.map((row) => row.total_cents),
      ...finalEnergySales.map((row) => row.amount_cents),
    ];

    const activeBusinesses = this.db.prepare<[string], { owner_id: string }>(`
      SELECT DISTINCT owner_id FROM bank_accounts
      WHERE run_id = ? AND owner_kind = 'company'
        AND account_type = 'checking' AND status = 'active'
      ORDER BY owner_id
    `).all(this.runId).map((row) => row.owner_id);

    const sentimentRows = this.db.prepare<
      [string, number],
      { topic: string; id: string; tick: bigint; update_canonical: string }
    >(`
      SELECT topic, id, tick, update_canonical FROM sentiment_updates
      WHERE run_id = ? AND tick <= ? ORDER BY topic, tick DESC, id DESC
    `).all(this.runId, tick);
    const latestSentimentByTopic = new Map<string, (typeof sentimentRows)[number]>();
    for (const row of sentimentRows) {
      if (!latestSentimentByTopic.has(row.topic)) latestSentimentByTopic.set(row.topic, row);
    }
    const sentimentEvidence = SENTIMENT_TOPICS.map((topic) => {
      const row = latestSentimentByTopic.get(topic);
      if (row === undefined) return { topic, updateId: null, updateTick: null, value: 0 };
      const update = sentimentUpdateSchema.parse(canonicalParse(row.update_canonical));
      return {
        topic,
        updateId: row.id,
        updateTick: toSafeNumber(row.tick, `${topic} sentiment tick`),
        value: sentimentValueAtTick(update, tick),
      };
    });

    const extensions = calculateFullIndicatorExtensions({
      cpiBasket,
      finalDomesticSalesCents,
      activeBusinessIds: activeBusinesses,
      sentimentTopicValues: sentimentEvidence.map((entry) => entry.value),
    });
    const treasury = this.systemAccount("government", "inst_town_riverbend");
    const values: Readonly<Record<IndicatorKey, string>> = {
      gdp_proxy_cents: extensions.gdpProxyCents.toString(),
      cpi_index: extensions.cpiIndex.toString(),
      m1_cents: m1.toString(),
      average_wage_cents: averageWage.toString(),
      unemployment_rate_bp: unemploymentRate.toString(),
      credit_outstanding_cents: creditOutstanding.toString(),
      default_rate_bp: defaultRate.toString(),
      active_business_count: extensions.activeBusinessCount.toString(),
      treasury_balance_cents: treasury.balanceCents,
      sentiment_index_bp: extensions.sentimentIndex.toString(),
    };
    const evidenceFor = (key: IndicatorKey, inputs: unknown): IndicatorPointEvidence => ({
      formulaVersion: ECONOMIC_INDICATOR_RULESET_VERSION,
      inputsDigest: hashValue({
        indicatorKey: key,
        formulaVersion: ECONOMIC_INDICATOR_RULESET_VERSION,
        tick,
        inputs,
      }),
    });
    const evidence: Readonly<Record<IndicatorKey, IndicatorPointEvidence>> = {
      gdp_proxy_cents: evidenceFor("gdp_proxy_cents", {
        window: { fromTick: gdpFromTick, toTick: tick },
        goods: finalGoodsSales,
        householdEnergy: finalEnergySales,
      }),
      cpi_index: evidenceFor("cpi_index", cpiEvidence),
      m1_cents: evidenceFor("m1_cents", m1Accounts),
      average_wage_cents: evidenceFor("average_wage_cents", wages),
      unemployment_rate_bp: evidenceFor("unemployment_rate_bp", labor),
      credit_outstanding_cents: evidenceFor("credit_outstanding_cents", allCredit),
      default_rate_bp: evidenceFor("default_rate_bp", {
        loanIds: allCredit.map((loan) => loan.id),
        defaults,
      }),
      active_business_count: evidenceFor("active_business_count", activeBusinesses),
      treasury_balance_cents: evidenceFor("treasury_balance_cents", {
        accountId: treasury.id,
        balanceCents: treasury.balanceCents,
      }),
      sentiment_index_bp: evidenceFor("sentiment_index_bp", sentimentEvidence),
    };
    return Object.freeze({ values, evidence });
  }

  recomputeIndicators(tick: number): Readonly<Record<IndicatorKey, string>> {
    return this.computeIndicatorSnapshot(tick).values;
  }

  insertIndicatorPoints(
    tick: number,
    snapshot = this.computeIndicatorSnapshot(tick),
  ): void {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new EngineError("VALIDATION_FAILED", "indicator tick must be non-negative");
    }
    const insert = this.db.prepare(`
      INSERT INTO indicator_points(
        run_id, tick, indicator_key, value_integer, formula_version, inputs_digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const persist = () => {
      for (const key of INDICATOR_KEYS) {
        const indicatorKey = indicatorKeySchema.parse(key);
        const evidence = snapshot.evidence[indicatorKey];
        insert.run(
          this.runId,
          tick,
          indicatorKey,
          snapshot.values[indicatorKey],
          evidence.formulaVersion,
          evidence.inputsDigest,
        );
      }
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist).immediate();
  }

  latestIndicators(): Readonly<Record<IndicatorKey, string>> {
    const rows = this.db.prepare<[string, string], { indicator_key: IndicatorKey; value_integer: string }>(`
      SELECT p.indicator_key, p.value_integer
      FROM indicator_points p
      JOIN (
        SELECT indicator_key, MAX(tick) AS tick FROM indicator_points
        WHERE run_id = ? GROUP BY indicator_key
      ) latest ON latest.indicator_key = p.indicator_key AND latest.tick = p.tick
      WHERE p.run_id = ?
      ORDER BY p.indicator_key
    `).all(this.runId, this.runId);
    const result = {} as Record<IndicatorKey, string>;
    for (const row of rows) result[row.indicator_key] = row.value_integer;
    return result;
  }

  listIndicatorPoints(input: {
    readonly series: readonly IndicatorKey[];
    readonly fromTick?: number;
    readonly toTick?: number;
    readonly step: number;
    readonly max: number;
  }): readonly { readonly tick: number; readonly series: IndicatorKey; readonly value: string }[] {
    const clauses = ["run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId, max: input.max };
    const placeholders = input.series.map((_, index) => {
      params[`series${index}`] = input.series[index]!;
      return `@series${index}`;
    });
    clauses.push(`indicator_key IN (${placeholders.join(", ")})`);
    if (input.fromTick !== undefined) {
      clauses.push("tick >= @fromTick");
      params["fromTick"] = input.fromTick;
    }
    if (input.toTick !== undefined) {
      clauses.push("tick <= @toTick");
      params["toTick"] = input.toTick;
    }
    clauses.push("tick % @step = 0");
    params["step"] = input.step;
    return this.db.prepare<Record<string, string | number>, {
      tick: bigint;
      indicator_key: IndicatorKey;
      value_integer: string;
    }>(`
      SELECT tick, indicator_key, value_integer FROM indicator_points
      WHERE ${clauses.join(" AND ")}
      ORDER BY tick, indicator_key LIMIT @max
    `).all(params).map((row) => ({
      tick: toSafeNumber(row.tick, "indicator tick"),
      series: row.indicator_key,
      value: row.value_integer,
    }));
  }

  listBanks(): readonly {
    readonly id: string;
    readonly name: string;
    readonly totalDeposits: string;
    readonly totalLoans: string;
    readonly capitalRatioBp: number;
    readonly reserveRatioBp: number;
    readonly lendingHalted: boolean;
  }[] {
    return this.db.prepare<[string], {
      id: string;
      name: string;
      capital_cents: string;
      reserve_cents: string;
      reserve_ratio_bp: bigint;
      capital_ratio_min_bp: bigint;
      status: "active" | "lending_halted" | "closed";
    }>("SELECT * FROM banks WHERE run_id = ? ORDER BY id").all(this.runId).map((bank) => {
      const deposits = this.db.prepare<[string, string], { balance_cents: string }>(`
        SELECT balance_cents FROM bank_accounts
        WHERE run_id = ? AND bank_id = ? AND account_type = 'checking'
          AND owner_kind IN ('agent', 'company', 'government')
        ORDER BY id
      `).all(this.runId, bank.id).reduce((sum, row) => sum + BigInt(row.balance_cents), 0n);
      const seedLoans = this.db.prepare<[string, string], { outstanding_principal_cents: string }>(`
        SELECT seed.outstanding_principal_cents
        FROM seed_loans seed
        JOIN seed_loan_ledger_links link
          ON link.run_id = seed.run_id AND link.loan_id = seed.id
        JOIN bank_accounts asset
          ON asset.run_id = link.run_id AND asset.id = link.bank_asset_account_id
        WHERE seed.run_id = ? AND asset.bank_id = ? ORDER BY seed.id
      `).all(this.runId, bank.id).reduce(
        (sum, row) => sum + BigInt(row.outstanding_principal_cents),
        0n,
      );
      const originatedLoans = this.db.prepare<[string, string], {
        outstanding_principal_cents: string;
      }>(`
        SELECT outstanding_principal_cents FROM loans
        WHERE run_id = ? AND bank_id = ? ORDER BY id
      `).all(this.runId, bank.id).reduce(
        (sum, row) => sum + BigInt(row.outstanding_principal_cents),
        0n,
      );
      const netIncome = this.db.prepare<[string, string], {
        account_type: "internal_income" | "internal_expense";
        balance_cents: string;
      }>(`
        SELECT account_type, balance_cents FROM bank_accounts
        WHERE run_id = ? AND bank_id = ? AND owner_kind = 'bank_internal'
          AND account_type IN ('internal_income', 'internal_expense')
        ORDER BY id
      `).all(this.runId, bank.id).reduce((sum, row) => (
        sum + (row.account_type === "internal_income"
          ? BigInt(row.balance_cents)
          : -BigInt(row.balance_cents))
      ), 0n);
      const rawCapital = BigInt(bank.capital_cents) + netIncome;
      const effectiveCapital = rawCapital > 0n ? rawCapital : 0n;
      const capitalRatioBp = bankRatioBasisPoints(
        effectiveCapital.toString(),
        deposits.toString(),
      );
      const reserveRatioBp = bankRatioBasisPoints(bank.reserve_cents, deposits.toString());
      return {
        id: bank.id,
        name: bank.name,
        totalDeposits: deposits.toString(),
        totalLoans: (seedLoans + originatedLoans).toString(),
        capitalRatioBp,
        reserveRatioBp,
        lendingHalted: bank.status !== "active" ||
          capitalRatioBp < toSafeNumber(bank.capital_ratio_min_bp, "bank minimum capital ratio") ||
          reserveRatioBp < toSafeNumber(bank.reserve_ratio_bp, "bank minimum reserve ratio"),
      };
    });
  }

  getBank(bankId: string): Readonly<Record<string, unknown>> {
    const bank = this.listBanks().find((candidate) => candidate.id === bankId);
    if (bank === undefined) throw new EngineError("NOT_FOUND", `bank ${bankId} does not exist`);
    const currentTickRow = this.db.prepare<[string], { current_tick: bigint }>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (currentTickRow === undefined) {
      throw new EngineError("NOT_FOUND", `run ${this.runId} does not exist`);
    }
    const currentTick = toSafeNumber(currentTickRow.current_tick, "run current tick");
    const fromTick = Math.max(0, currentTick - 29);
    const sumInternalDebits = (
      ownerId: string,
      accountType: "internal_income" | "internal_expense",
      reason: string,
    ): bigint => this.db.prepare<
      [string, string, string, string, string, number, number],
      { amount_cents: string }
    >(`
      SELECT leg.amount_cents
      FROM ledger_transaction_legs leg
      JOIN ledger_transactions txn
        ON txn.run_id = leg.run_id AND txn.id = leg.transaction_id
      JOIN bank_accounts account
        ON account.run_id = leg.run_id AND account.id = leg.account_id
      WHERE leg.run_id = ?
        AND account.bank_id = ?
        AND account.owner_kind = 'bank_internal'
        AND account.owner_id = ?
        AND account.account_type = ?
        AND txn.reason = ?
        AND txn.tick BETWEEN ? AND ?
        AND leg.direction = 'debit'
      ORDER BY txn.tick, txn.id, leg.leg_index
    `).all(
      this.runId,
      bankId,
      ownerId,
      accountType,
      reason,
      fromTick,
      currentTick,
    ).reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
    const accounts = this.db.prepare<[string, string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM bank_accounts WHERE run_id = ? AND bank_id = ?
    `).get(this.runId, bankId)!.count;
    const seedLoanStatuses = this.db.prepare<[string, string], { status: string }>(`
      SELECT seed.status
      FROM seed_loans seed
      JOIN seed_loan_ledger_links link
        ON link.run_id = seed.run_id AND link.loan_id = seed.id
      JOIN bank_accounts asset
        ON asset.run_id = link.run_id AND asset.id = link.bank_asset_account_id
      WHERE seed.run_id = ? AND asset.bank_id = ? ORDER BY seed.id
    `).all(this.runId, bankId);
    const originatedLoanStatuses = this.db.prepare<[string, string], { status: string }>(`
      SELECT status FROM loans WHERE run_id = ? AND bank_id = ? ORDER BY id
    `).all(this.runId, bankId);
    const loanStatuses = [...seedLoanStatuses, ...originatedLoanStatuses];
    return {
      ...bank,
      accounts: { count: toSafeNumber(accounts, "bank account count") },
      loanBook: {
        active: loanStatuses.filter((loan) => (
          loan.status === "current" || loan.status === "delinquent" ||
          loan.status === "disbursed" || loan.status === "repaying"
        )).length,
        defaulted: loanStatuses.filter((loan) => loan.status === "defaulted").length,
        writtenOff: loanStatuses.filter((loan) => loan.status === "written_off").length,
      },
      incomeStatement30: {
        interestIncome: sumInternalDebits(
          `${bankId}:interest_income`,
          "internal_income",
          "loan.installment.payment",
        ).toString(),
        writeDowns: sumInternalDebits(
          `${bankId}:credit_loss`,
          "internal_expense",
          "loan.default.write_down",
        ).toString(),
      },
    };
  }

  listTransactions(query: TransactionQuery): {
    readonly items: readonly TransactionView[];
    readonly nextId: string | null;
  } {
    const clauses = ["t.run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId, limit: query.limit + 1 };
    if (query.beforeId !== undefined) {
      clauses.push("t.id < @beforeId");
      params["beforeId"] = query.beforeId;
    }
    if (query.accountId !== undefined) {
      clauses.push(`EXISTS (
        SELECT 1 FROM ledger_transaction_legs filter_leg
        WHERE filter_leg.run_id = t.run_id AND filter_leg.transaction_id = t.id
          AND filter_leg.account_id = @accountId
      )`);
      params["accountId"] = query.accountId;
    }
    if (query.kind !== undefined) {
      clauses.push("t.kind = @kind");
      params["kind"] = query.kind;
    }
    if (query.fromTick !== undefined) {
      clauses.push("t.tick >= @fromTick");
      params["fromTick"] = query.fromTick;
    }
    if (query.toTick !== undefined) {
      clauses.push("t.tick <= @toTick");
      params["toTick"] = query.toTick;
    }
    if (query.correlationId !== undefined) {
      clauses.push("t.correlation_id = @correlationId");
      params["correlationId"] = query.correlationId;
    }
    const rows = this.db.prepare<Record<string, string | number>, TransactionRow>(`
      SELECT t.* FROM ledger_transactions t
      WHERE ${clauses.join(" AND ")}
      ORDER BY t.id DESC LIMIT @limit
    `).all(params);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => this.mapTransactionView(row)),
      nextId: rows.length > query.limit ? page.at(-1)!.id : null,
    };
  }

  agentFinances(agentId: string): Readonly<Record<string, unknown>> {
    const account = this.accountForAgent(agentId);
    const employment = this.db.prepare<[string, string], {
      id: string;
      employer_id: string;
      annual_wage_cents: string;
      status: string;
      start_tick: bigint;
      occupation_code: string;
    }>(`
      SELECT e.id, e.employer_id, e.annual_wage_cents, e.status, e.start_tick, a.occupation_code
      FROM employment_contracts e
      JOIN agents a ON a.run_id = e.run_id AND a.id = e.employee_agent_id
      WHERE e.run_id = ? AND e.employee_agent_id = ?
      ORDER BY e.start_tick DESC, e.id DESC LIMIT 1
    `).get(this.runId, agentId);
    const currentTickRow = this.db.prepare<[string], { current_tick: bigint }>(`
      SELECT current_tick FROM simulation_runs WHERE id = ?
    `).get(this.runId)!;
    const currentTick = toSafeNumber(currentTickRow.current_tick, "run current tick");
    const fromTick = Math.max(1, currentTick - 29);
    const flows = this.db.prepare<[string, string], {
      direction: "debit" | "credit";
      amount_cents: string;
      kind: TransactionKind;
      reason: string;
    }>(`
      SELECT l.direction, l.amount_cents, t.kind, t.reason
      FROM ledger_transaction_legs l
      JOIN ledger_transactions t ON t.run_id = l.run_id AND t.id = l.transaction_id
      WHERE l.run_id = ? AND l.account_id = ? AND t.tick >= ${fromTick}
      ORDER BY t.id, l.leg_index
    `).all(this.runId, account.id);
    const income = { salary: 0n, benefits: 0n, other: 0n };
    const expenses = { subsistence: 0n, discretionary: 0n, rent: 0n, utilities: 0n };
    for (const flow of flows) {
      const amount = BigInt(flow.amount_cents);
      if (flow.direction === "debit") {
        if (flow.kind === "payroll") income.salary += amount;
        else if (flow.kind === "benefit") income.benefits += amount;
        else income.other += amount;
      } else if (flow.reason === "household.discretionary") {
        expenses.discretionary += amount;
      } else if (flow.reason === "household.rent") {
        expenses.rent += amount;
      } else if (flow.reason === "household.utilities") {
        expenses.utilities += amount;
      } else {
        expenses.subsistence += amount;
      }
    }
    const loans = this.db.prepare<[string, string], {
      id: string;
      status: string;
      outstanding_principal_cents: string;
      loan_canonical: string;
    }>(`
      SELECT id, status, outstanding_principal_cents, loan_canonical FROM seed_loans
      WHERE run_id = ? AND borrower_kind = 'agent' AND borrower_id = ? ORDER BY id
    `).all(this.runId, agentId).map((loan) => {
      const detail = canonicalParse(loan.loan_canonical) as Record<string, unknown>;
      return {
        id: loan.id,
        principal: String(detail["originalPrincipalCents"] ?? loan.outstanding_principal_cents),
        outstanding: loan.outstanding_principal_cents,
        status: loan.status,
        nextDue: null,
      };
    });
    const bank = this.db.prepare<[string, string], { name: string }>(`
      SELECT name FROM banks WHERE run_id = ? AND id = ?
    `).get(this.runId, account.bankId)!;
    const employerName = employment === undefined
      ? null
      : employment.employer_id === "inst_first_ledger_bank"
        ? bank.name
        : employment.employer_id
            .replace(/^inst_/, "")
            .replace(/^biz_/, "")
            .split("_")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");
    return {
      employment: employment === undefined ? null : {
        contractId: employment.id,
        employer: { id: employment.employer_id, name: employerName! },
        title: employment.occupation_code
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        wage: employment.annual_wage_cents,
        since: simDateForTick(toSafeNumber(employment.start_tick, "employment start tick")),
      },
      accounts: [{
        id: account.id,
        bank: bank.name,
        type: account.type,
        balance: account.balanceCents,
      }],
      income: {
        last30Ticks: {
          salary: income.salary.toString(),
          benefits: income.benefits.toString(),
          other: income.other.toString(),
        },
      },
      expenses: {
        last30Ticks: {
          subsistence: expenses.subsistence.toString(),
          discretionary: expenses.discretionary.toString(),
          rent: expenses.rent.toString(),
          utilities: expenses.utilities.toString(),
        },
      },
      loans,
    };
  }

  reconcile(): readonly string[] {
    const calculated = new Map(this.listAccounts().map((account) => [account.id, 0n]));
    const legs = this.db.prepare<[string], LegRow>(`
      SELECT account_id, direction, amount_cents FROM ledger_transaction_legs
      WHERE run_id = ? ORDER BY transaction_id, leg_index
    `).all(this.runId);
    for (const leg of legs) {
      calculated.set(
        leg.account_id,
        (calculated.get(leg.account_id) ?? 0n) +
          (leg.direction === "debit" ? BigInt(leg.amount_cents) : -BigInt(leg.amount_cents)),
      );
    }
    const issues: string[] = [];
    for (const account of this.listAccounts()) {
      const expected = calculated.get(account.id) ?? 0n;
      if (expected.toString() !== account.balanceCents) {
        issues.push(`${account.id}: cache=${account.balanceCents} postings=${expected.toString()}`);
      }
      if (BigInt(account.balanceCents) < BigInt(account.floorCents)) {
        issues.push(`${account.id}: balance is below floor`);
      }
    }
    return issues;
  }

  /** Prove domestic deposit changes occur only through controlled supply channels. */
  auditConservation(): readonly string[] {
    const domesticAccounts = new Set(this.listAccounts()
      .filter((account) =>
        account.type === "checking" &&
        (account.ownerKind === "agent" ||
          account.ownerKind === "company" ||
          account.ownerKind === "government")
      )
      .map((account) => account.id));
    const controlled = new Set<TransactionKind>([
      "mint",
      "loan_disbursement",
      "loan_payment",
      "row_settlement",
    ]);
    const transactions = this.db.prepare<[string], TransactionRow>(`
      SELECT * FROM ledger_transactions WHERE run_id = ? ORDER BY id
    `).all(this.runId);
    const domesticDeltaByTransaction = new Map<string, bigint>();
    const legs = this.db.prepare<[string], LegRow & { transaction_id: string }>(`
      SELECT transaction_id, account_id, direction, amount_cents
      FROM ledger_transaction_legs WHERE run_id = ?
      ORDER BY transaction_id, leg_index
    `).all(this.runId);
    for (const leg of legs) {
      if (!domesticAccounts.has(leg.account_id)) continue;
      const amount = BigInt(leg.amount_cents);
      domesticDeltaByTransaction.set(
        leg.transaction_id,
        (domesticDeltaByTransaction.get(leg.transaction_id) ?? 0n) +
          (leg.direction === "debit" ? amount : -amount),
      );
    }
    const issues: string[] = [];
    for (const transaction of transactions) {
      const domesticDelta = domesticDeltaByTransaction.get(transaction.id) ?? 0n;
      if (domesticDelta !== 0n && !controlled.has(transaction.kind)) {
        issues.push(
          `${transaction.id}: ${transaction.kind} changed domestic deposits by ${domesticDelta}`,
        );
      }
    }
    return issues;
  }

  private insertAccount(account: BankAccount): void {
    const parsed = bankAccountSchema.parse(account);
    this.db.prepare(`
      INSERT INTO bank_accounts(
        run_id, id, bank_id, owner_kind, owner_id, account_type,
        balance_cents, floor_cents, status, opened_tick
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.runId,
      parsed.id,
      parsed.bankId,
      parsed.ownerKind,
      parsed.ownerId,
      parsed.type,
      parsed.balanceCents,
      parsed.floorCents,
      parsed.status,
      parsed.openedTick,
    );
  }

  private mapTransaction(row: TransactionRow): LedgerTransaction {
    const legs = this.db.prepare<[string, string], LegRow>(`
      SELECT account_id, direction, amount_cents FROM ledger_transaction_legs
      WHERE run_id = ? AND transaction_id = ? ORDER BY leg_index
    `).all(this.runId, row.id);
    return ledgerTransactionSchema.parse({
      id: row.id,
      runId: row.run_id,
      tick: toSafeNumber(row.tick, "transaction tick"),
      kind: row.kind,
      actor: { kind: row.actor_kind, id: row.actor_id },
      reason: row.reason,
      sourceEventId: row.source_event_id,
      correlationId: row.correlation_id,
      idempotencyKey: row.idempotency_key,
      legs: legs.map((leg) => ({
        accountId: leg.account_id,
        direction: leg.direction,
        amountCents: leg.amount_cents,
      })),
    });
  }

  private mapTransactionView(row: TransactionRow): TransactionView {
    const transaction = this.mapTransaction(row);
    const ownerName = this.db.prepare<[string, string], { name: string }>(`
      SELECT p.name FROM agents a JOIN personas p
        ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? AND a.id = ?
    `);
    return {
      ...transaction,
      legs: transaction.legs.map((leg) => {
        const account = this.getAccounts(this.runId, [leg.accountId])[0];
        if (account === undefined) throw new EngineError("INTERNAL", `missing leg account ${leg.accountId}`);
        const name = account.ownerKind === "agent"
          ? ownerName.get(this.runId, account.ownerId)?.name ?? account.ownerId
          : account.ownerId;
        return {
          ...leg,
          ownerKind: account.ownerKind,
          ownerId: account.ownerId,
          ownerName: name,
        };
      }),
    };
  }
}
