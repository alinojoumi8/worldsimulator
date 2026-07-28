import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalParse,
  canonicalStringify,
  IdFactory,
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
  new SqliteFinanceStore(db, TEST_RUN_ID).initialize(population, ids);
  const company = db.prepare<[], {
    company_id: string;
    balance_cents: string;
  }>(`
    SELECT cap.company_id, account.balance_cents
    FROM company_cap_tables cap
    JOIN bank_accounts account
      ON account.run_id = cap.run_id
      AND account.owner_kind = 'company'
      AND account.owner_id = cap.company_id
      AND account.account_type = 'checking'
      AND account.status = 'active'
    WHERE cap.run_id = '${TEST_RUN_ID}' AND cap.company_kind = 'opening'
    ORDER BY CAST(account.balance_cents AS INTEGER) DESC, cap.company_id
    LIMIT 1
  `).get();
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
    ids,
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
