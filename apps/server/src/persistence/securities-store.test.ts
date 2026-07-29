import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalParse,
  canonicalStringify,
  IdFactory,
  ledgerTransactionSchema,
  Rng,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  generateRiverbendPopulation,
  simDateForTick,
  type TickContext,
} from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import {
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteEventStore } from "./event-store";
import { SqliteFinanceStore } from "./finance-store";
import { SqliteSecuritiesStore } from "./securities-store";
import { computeLogicalStateHash } from "./snapshot-store";
import {
  insertTestRun,
  TEST_RUN_ID,
  TEST_SIMULATION_ID,
} from "./test-helpers";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(
  db: WorldDatabase,
  ids: IdFactory,
  tick: number,
): TickContext {
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: simDateForTick(tick),
    phase: "decisions",
    ids,
    rng: (key) => Rng.root(901).fork(`${tick}.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const events = new SqliteEventStore(db, TEST_RUN_ID);
      const event: EventEnvelope = {
        eventId: ids.next("evt"),
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId: TEST_SIMULATION_ID,
        runId: TEST_RUN_ID,
        seq: events.count(),
        tick,
        simDate: simDateForTick(tick),
        wallTime: `T${tick}`,
        actor: options?.actor ?? {
          kind: "system",
          id: "securities-test",
        },
        correlationId: options?.correlationId ?? `securities-test:${tick}`,
        ...(options?.causationId === undefined
          ? {}
          : { causationId: options.causationId }),
        payload,
      };
      events.append(event);
      return event;
    },
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-securities-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({
    runId: TEST_RUN_ID,
    seed: 42,
  });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(
    population,
    triggerEvents,
  );
  const ids = IdFactory.restore(population.idState);
  const finance = new SqliteFinanceStore(db, TEST_RUN_ID);
  const financeGenesis = finance.initialize(population, ids);
  const company = db.prepare<[string], {
    account_id: string;
    company_id: string;
    balance_cents: string;
  }>(`
    SELECT account.id AS account_id, cap.company_id, account.balance_cents
    FROM company_cap_tables cap
    JOIN bank_accounts account
      ON account.run_id = cap.run_id
      AND account.owner_kind = 'company'
      AND account.owner_id = cap.company_id
      AND account.account_type = 'checking'
      AND account.status = 'active'
    WHERE cap.run_id = ? AND cap.company_kind = 'opening'
    ORDER BY CAST(account.balance_cents AS INTEGER) DESC, cap.company_id
    LIMIT 1
  `).get(TEST_RUN_ID);
  if (company === undefined) throw new Error("opening company missing");
  const triggerEvent = context(db, ids, 30).emit(
    "company.listing.requested",
    { companyId: company.company_id },
    {
      actor: { kind: "institution", id: "inst_riverbend_exchange" },
      correlationId: company.company_id,
    },
  );
  return {
    dataDir,
    db,
    finance,
    financeGenesis,
    ids,
    companyAccountId: company.account_id,
    companyId: company.company_id,
    companyBalanceCents: company.balance_cents,
    triggerEventId: triggerEvent.eventId,
    store: new SqliteSecuritiesStore(db, TEST_RUN_ID),
  };
}

describe("SqliteSecuritiesStore", () => {
  it("enforces age and capital eligibility without consuming ids on rejection", () => {
    const state = fixture();
    expect(BigInt(state.companyBalanceCents)).toBeGreaterThanOrEqual(10_000_000n);
    const input = {
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
    } as const;

    expect(state.store.assess(input, 29)).toMatchObject({
      eligible: false,
      checks: { minimumAge: false },
    });
    const checkpoint = state.ids.serialize();
    expect(() => state.store.listSecurity({
      ...input,
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 29))).toThrow(/not eligible/);
    expect(state.ids.serialize()).toEqual(checkpoint);

    expect(state.store.assess({
      ...input,
      sharesListed: "10001",
    }, 30)).toMatchObject({
      eligible: false,
      checks: { sharesWithinTotal: false },
    });
    expect(() => state.store.listSecurity({
      ...input,
      sharesListed: "10001",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30))).toThrow(/not eligible/);
    expect(state.ids.serialize()).toEqual(checkpoint);
  });

  it("creates one exchange and an event-backed listed security", () => {
    const state = fixture();
    const beforeHash = computeLogicalStateHash(state.db, TEST_RUN_ID);
    const listed = state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30));

    expect(listed).toMatchObject({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      listedTick: 30,
      status: "listed",
      eligibility: {
        eligible: true,
        eligibilityBasis: "capital",
      },
    });
    expect(state.store.market()).toMatchObject({
      id: listed.marketId,
      kind: "securities",
      operatorInstitutionId: "inst_riverbend_exchange",
      priceBandBp: 2000,
      status: "open",
    });
    expect(state.store.get(listed.id)).toEqual(listed);
    expect(state.store.list()).toEqual([listed]);
    expect(computeLogicalStateHash(state.db, TEST_RUN_ID)).not.toBe(beforeHash);

    const listingEvent = state.db.prepare<
      [string, string],
      { type: string; payload_canonical: string; causation_id: string | null }
    >(`
      SELECT type, payload_canonical, causation_id
      FROM events WHERE run_id = ? AND event_id = ?
    `).get(TEST_RUN_ID, listed.sourceEventId);
    expect(listingEvent).toBeDefined();
    expect(listingEvent?.type).toBe("security.listed");
    expect(canonicalParse(listingEvent!.payload_canonical)).toEqual({
      securityId: listed.id,
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePrice: "1250",
    });
    expect(listingEvent?.causation_id).toBe(state.triggerEventId);

    const checkpoint = state.ids.serialize();
    expect(() => state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "1000",
      referencePriceCents: "1200",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 31))).toThrow(/already listed/);
    expect(state.ids.serialize()).toEqual(checkpoint);

    state.db.close();
    const reopened = openWorldDatabase(
      state.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    databases.push(reopened);
    expect(new SqliteSecuritiesStore(reopened, TEST_RUN_ID).get(listed.id))
      .toEqual(listed);
  });

  it("uses revenue from every active company checking account", () => {
    const state = fixture();
    state.db.prepare(`
      UPDATE bank_accounts SET balance_cents = '0'
      WHERE run_id = ? AND owner_kind = 'company' AND owner_id = ?
        AND account_type = 'checking' AND status = 'active'
    `).run(TEST_RUN_ID, state.companyId);
    const secondaryAccountId = state.ids.next("acct");
    state.db.prepare(`
      INSERT INTO bank_accounts(
        run_id, id, bank_id, owner_kind, owner_id, account_type,
        balance_cents, floor_cents, status, opened_tick
      ) VALUES (?, ?, ?, 'company', ?, 'checking', '0', '0', 'active', 0)
    `).run(
      TEST_RUN_ID,
      secondaryAccountId,
      state.financeGenesis.bankId,
      state.companyId,
    );
    state.finance.post(ledgerTransactionSchema.parse({
      id: state.ids.next("txn"),
      runId: TEST_RUN_ID,
      tick: 30,
      kind: "purchase",
      actor: { kind: "system", id: "securities-test" },
      reason: "second-account listing revenue test",
      sourceEventId: null,
      correlationId: "securities-second-account",
      idempotencyKey: "securities-second-account",
      legs: [
        {
          accountId: state.companyAccountId,
          direction: "debit",
          amountCents: "2",
        },
        {
          accountId: secondaryAccountId,
          direction: "debit",
          amountCents: "1",
        },
        {
          accountId: state.financeGenesis.rowAccountId,
          direction: "credit",
          amountCents: "3",
        },
      ],
    }));

    const input = {
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
    } as const;
    expect(state.store.assess(input, 30)).toMatchObject({
      profit30Cents: "3",
      capitalCents: "3",
      eligibilityBasis: "profitability",
      eligible: true,
    });
    expect(state.store.listSecurity({
      ...input,
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30))).toMatchObject({
      symbol: "RBG",
      eligibility: {
        eligibilityBasis: "profitability",
      },
    });
  });

  it("rolls back failed listing writes and restores the id checkpoint", () => {
    const state = fixture();
    const idCheckpoint = state.ids.serialize();
    const eventCount = new SqliteEventStore(state.db, TEST_RUN_ID).count();
    state.db.exec(`
      CREATE TRIGGER securities_test_force_insert_failure
      BEFORE INSERT ON securities
      BEGIN SELECT RAISE(ABORT, 'forced securities insert failure'); END;
    `);

    expect(() => state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30))).toThrow(/forced securities insert failure/);

    expect(state.ids.serialize()).toEqual(idCheckpoint);
    expect(state.store.market()).toBeNull();
    expect(state.store.list()).toEqual([]);
    expect(new SqliteEventStore(state.db, TEST_RUN_ID).count()).toBe(eventCount);

    state.db.transaction(() => {
      expect(() => state.store.listSecurity({
        companyId: state.companyId,
        symbol: "RBG",
        sharesListed: "2500",
        referencePriceCents: "1250",
        triggerEventId: state.triggerEventId,
      }, context(state.db, state.ids, 30))).toThrow(
        /forced securities insert failure/,
      );
    }).immediate();

    expect(state.ids.serialize()).toEqual(idCheckpoint);
    expect(state.store.market()).toBeNull();
    expect(state.store.list()).toEqual([]);
    expect(new SqliteEventStore(state.db, TEST_RUN_ID).count()).toBe(eventCount);
  });

  it("does not relist a suspended security while the market is halted", () => {
    const state = fixture();
    const listed = state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30));
    const updateSecurityStatus = state.db.prepare(`
      UPDATE securities SET status = ?
      WHERE run_id = ? AND id = ?
    `);
    const updateMarketStatus = state.db.prepare(`
      UPDATE securities_markets SET status = ?
      WHERE run_id = ? AND id = ?
    `);

    updateSecurityStatus.run("suspended", TEST_RUN_ID, listed.id);
    updateMarketStatus.run("halted", TEST_RUN_ID, listed.marketId);
    expect(() => updateSecurityStatus.run(
      "listed",
      TEST_RUN_ID,
      listed.id,
    )).toThrow(/invalid security status transition/);

    updateMarketStatus.run("open", TEST_RUN_ID, listed.marketId);
    expect(updateSecurityStatus.run("listed", TEST_RUN_ID, listed.id).changes)
      .toBe(1);
  });

  it("fails closed when canonical listing evidence is tampered", () => {
    const state = fixture();
    const listed = state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30));
    state.db.exec("DROP TRIGGER securities_identity_immutable");
    state.db.prepare(`
      UPDATE securities SET eligibility_canonical = ?
      WHERE run_id = ? AND id = ?
    `).run(
      JSON.stringify(listed.eligibility, null, 2),
      TEST_RUN_ID,
      listed.id,
    );

    expect(() => state.store.get(listed.id)).toThrow(/eligibility is invalid/);

    state.db.prepare(`
      UPDATE securities SET eligibility_canonical = ?
      WHERE run_id = ? AND id = ?
    `).run(
      canonicalStringify({
        ...listed.eligibility,
        eligible: false,
      }),
      TEST_RUN_ID,
      listed.id,
    );
    expect(() => state.store.get(listed.id)).toThrow(/eligibility is invalid/);
  });

  it("rejects a forged direct listing that exceeds the cap table", () => {
    const state = fixture();
    const listed = state.store.listSecurity({
      companyId: state.companyId,
      symbol: "RBG",
      sharesListed: "2500",
      referencePriceCents: "1250",
      triggerEventId: state.triggerEventId,
    }, context(state.db, state.ids, 30));
    const forgedEvent = context(state.db, state.ids, 31).emit(
      "security.listed",
      {
        securityId: "sec_zzzzzzzz",
        companyId: state.companyId,
        symbol: "BAD",
        sharesListed: "20000",
        referencePrice: "100",
      },
      {
        actor: { kind: "institution", id: "inst_riverbend_exchange" },
        correlationId: "sec_zzzzzzzz",
        causationId: state.triggerEventId,
      },
    );
    const forgedEligibility = {
      ...listed.eligibility,
      assessedTick: 31,
      requestedShares: "20000",
      checks: {
        ...listed.eligibility.checks,
        sharesWithinTotal: true,
      },
    };

    expect(() => state.db.prepare(`
      INSERT INTO securities(
        run_id, id, market_id, company_id, symbol, shares_listed,
        reference_price_cents, listed_tick, status, eligibility_canonical,
        source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      TEST_RUN_ID,
      "sec_zzzzzzzz",
      listed.marketId,
      state.companyId,
      "BAD",
      "20000",
      "100",
      31,
      "listed",
      canonicalStringify(forgedEligibility),
      forgedEvent.eventId,
    )).toThrow(/eligibility or evidence/);
  });
});
