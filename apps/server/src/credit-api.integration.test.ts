import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decisionSchema,
  IdFactory,
  Rng,
  eventEnvelopeSchema,
  indicatorSeriesResponseSchema,
  loanDetailResponseSchema,
  loanListQuerySchema,
  loanListResponseSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import { simDateForTick, type TickContext } from "@worldtangle/engine";
import { buildApp } from "./app";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteAgentStore,
  SqliteCreditReadStore,
  SqliteCreditStore,
  SqliteEventStore,
  SqliteFinanceStore,
  SqliteSnapshotStore,
  type WorldDatabase,
} from "./persistence";
import { readRunCheckpoint } from "./persistence/tick-committer";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

const createBody = {
  name: "ws507-credit-explorer",
  scenario: {
    worldSpec: "riverbend-100@1",
    seed: 42,
    llmMode: "mock",
    budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
    policyOverrides: {},
    endTick: 360,
  },
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-credit-api-"));
  directories.push(dataDir);
  const app = buildApp({
    dataDir,
    webRoot: false,
    wallClock: () => "2026-07-15T00:00:00.000Z",
  });
  apps.push(app);
  return { dataDir, app };
}

async function create(f: ReturnType<typeof fixture>) {
  const response = await f.app.inject({
    method: "POST",
    url: "/api/v1/simulations",
    payload: createBody,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return {
    simulationId: body.simulation.id as string,
    runId: body.run.id as string,
  };
}

function persistentContext(
  db: WorldDatabase,
  simulationId: string,
  runId: string,
  ids: IdFactory,
  tick: number,
): TickContext {
  const events = new SqliteEventStore(db, runId);
  return {
    simulationId,
    runId,
    tick,
    simDate: simDateForTick(tick),
    phase: "execute",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.ws507.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const eventId = ids.next("evt");
      const event = eventEnvelopeSchema.parse({
        eventId,
        type,
        schemaVersion: options?.schemaVersion ?? 1,
        simulationId,
        runId,
        seq: events.count(),
        tick,
        simDate: simDateForTick(tick),
        wallTime: "ws507-credit-api-test-wall",
        actor: options?.actor ?? { kind: "system", id: "test" },
        correlationId: options?.correlationId ?? eventId,
        ...(options?.causationId === undefined ? {} : { causationId: options.causationId }),
        payload,
      }) as EventEnvelope;
      events.append(event);
      return event;
    },
  };
}

describe("WS-507 credit API", () => {
  it("serves opening credit, indicators, pagination, and restore-equivalent why-panels", async () => {
    const f = fixture();
    const { simulationId, runId } = await create(f);

    const firstPage = loanListResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans?runId=${runId}&limit=3`,
    })).json());
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = loanListResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans?runId=${runId}&limit=3&cursor=${firstPage.nextCursor}`,
    })).json());
    expect(secondPage.items).toHaveLength(3);
    expect(secondPage.items.some((loan) => firstPage.items.some((first) => first.id === loan.id)))
      .toBe(false);

    const all = loanListResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans?runId=${runId}&limit=100`,
    })).json());
    expect(all.items).toHaveLength(8);
    expect(all.items.filter((loan) => loan.status === "delinquent")).toHaveLength(1);
    const ironvale = all.items.find((loan) => loan.borrower.id === "biz_ironvale");
    expect(ironvale).toMatchObject({
      origin: "opening_seed",
      borrower: { kind: "business", name: "Ironvale" },
      principalCents: "30000000",
      outstandingPrincipalCents: "11666662",
      annualRateBp: 650,
      termMonths: 36,
      status: "current",
    });

    const businessOnly = loanListResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans?runId=${runId}&borrowerKind=business&origin=opening_seed`,
    })).json());
    expect(businessOnly.items.map((loan) => loan.id)).toEqual([ironvale!.id]);

    const detail = loanDetailResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans/${ironvale!.id}?runId=${runId}`,
    })).json());
    expect(detail.schedule).toHaveLength(36);
    expect(detail.why).toMatchObject({
      kind: "opening_seed",
      seasonedMonths: 22,
      missedPayments: 0,
      sourceEventId: ironvale!.sourceEventId,
      causationId: expect.stringMatching(/^evt_/),
      recognitionTransactionId: expect.stringMatching(/^txn_/),
    });

    const indicators = indicatorSeriesResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=creditOutstanding,defaultRate`,
    })).json());
    const expectedOutstanding = all.items.reduce(
      (sum, loan) => sum + BigInt(loan.outstandingPrincipalCents),
      0n,
    ).toString();
    expect(indicators.series).toEqual([
      { name: "creditOutstanding", unit: "cents", points: [[0, expectedOutstanding]] },
      { name: "defaultRate", unit: "bp", points: [[0, 0]] },
    ]);

    await f.app.close();
    apps.splice(apps.indexOf(f.app), 1);
    let db = openWorldDatabase(f.dataDir, simulationId, runId);
    const query = loanListQuerySchema.parse({ limit: 100 });
    const before = new SqliteCreditReadStore(db, runId).listLoans(query);
    const beforeDetail = new SqliteCreditReadStore(db, runId).getLoan(ironvale!.id);
    const beforeHash = computeLogicalStateHash(db, runId);
    expect(() => db.prepare(`
      INSERT INTO indicator_points(
        run_id, tick, indicator_key, value_integer, formula_version, inputs_digest
      ) VALUES (?, 99, 'unknown_credit_measure', '1', 1, ?)
    `).run(runId, "a".repeat(64))).toThrow(/CHECK constraint failed/);
    expect(computeLogicalStateHash(db, runId)).toBe(beforeHash);

    const snapshots = new SqliteSnapshotStore(db, f.dataDir, simulationId, runId);
    const snapshot = await snapshots.create({ createdWall: "2026-07-15T00:00:01.000Z" });
    const finalHash = computeLogicalStateHash(db, runId);
    expect(snapshot.stateHash).toBe(finalHash);
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(f.dataDir, "restored", "ws507-credit.db"),
    );
    db.close();

    db = openWorldDatabase(f.dataDir, simulationId, runId);
    try {
      expect(new SqliteCreditReadStore(db, runId).listLoans(query)).toEqual(before);
      expect(new SqliteCreditReadStore(db, runId).getLoan(ironvale!.id)).toEqual(beforeDetail);
      expect(computeLogicalStateHash(db, runId)).toBe(finalHash);
    } finally {
      db.close();
    }
    const restored = openDatabaseFile(restoredPath);
    try {
      expect(new SqliteCreditReadStore(restored, runId).listLoans(query)).toEqual(before);
      expect(new SqliteCreditReadStore(restored, runId).getLoan(ironvale!.id))
        .toEqual(beforeDetail);
      expect(computeLogicalStateHash(restored, runId)).toBe(finalHash);
    } finally {
      restored.close();
    }
  });

  it("serves a complete stored underwriting and circuit-breaker why-panel", async () => {
    const f = fixture();
    const { simulationId, runId } = await create(f);
    const db = openWorldDatabase(f.dataDir, simulationId, runId);
    const checkpoint = readRunCheckpoint(db, runId);
    const ids = IdFactory.restore(checkpoint.idState);
    const bankId = db.prepare<[string], { id: string }>(`
      SELECT id FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
    `).get(runId)!.id;
    const applicantId = db.prepare<[string], { id: string }>(`
      SELECT agent.id
      FROM agents agent
      WHERE agent.run_id = ? AND agent.employment_status = 'employed'
        AND agent.id NOT IN (
          SELECT borrower_id FROM seed_loans
          WHERE run_id = agent.run_id AND borrower_kind = 'agent'
        )
      ORDER BY agent.id LIMIT 1
    `).get(runId)!.id;
    const credit = new SqliteCreditStore(db, runId);
    const submitted = credit.submitApplication({
      applicantKind: "agent",
      applicantId,
      bankId,
      purpose: "Replace a failed vehicle",
      amountCents: "600001",
      termMonths: 12,
    }, persistentContext(db, simulationId, runId, ids, 1));
    const reviewing = credit.beginReview(
      submitted.application.id,
      persistentContext(db, simulationId, runId, ids, 2),
      undefined,
      "tier2",
    );
    const review = reviewing.review;
    const agentDecisionId = ids.next("dec");
    const officerAdjustment = 5;
    const officerRationale = "Vehicle access supports stable employment and repayment.";
    const decisionParams = {
      applicationId: submitted.application.id,
      officerAgentId: review.officerAgentId,
      officerAdjustment,
    };
    new SqliteAgentStore(db, runId).saveDecisionResult([
      decisionSchema.parse({
        id: agentDecisionId,
        runId,
        agentId: review.officerAgentId,
        tick: 3,
        trigger: { kind: "schedule", sourceEventId: review.sourceEventId, priority: 95 },
        tier: 2,
        observationDigest: {
          hash: "8".repeat(64),
          summary: "The loan officer reviewed an engine-bounded adjustment menu.",
        },
        optionsOffered: [{
          actionId: "loan.adjust_plus_5",
          actionType: "bank.review_loan",
          params: decisionParams,
          utility: 50,
        }],
        chosenActionId: "loan.adjust_plus_5",
        params: decisionParams,
        rationale: officerRationale,
        llmCallId: ids.next("llm"),
        validationResult: { status: "approved" },
        promptPackKey: "agent.decision",
        promptVersion: 1,
        promptHash: "9".repeat(64),
      }),
    ], []);
    const decided = credit.decideTier2Application(submitted.application.id, {
      officerAdjustment,
      rationale: officerRationale,
      agentDecisionId,
    }, persistentContext(db, simulationId, runId, ids, 3));
    expect(decided.decision.outcome).toBe("approved");
    const disbursed = credit.disburseApprovedApplication(
      submitted.application.id,
      persistentContext(db, simulationId, runId, ids, 4),
    );
    new SqliteFinanceStore(db, runId).insertIndicatorPoints(4);
    db.close();

    const filtered = loanListResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans?runId=${runId}&origin=originated&bankId=${bankId}&borrowerKind=agent&borrowerId=${applicantId}`,
    })).json());
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id: disbursed.loan.id,
      origin: "originated",
      principalCents: "600001",
      status: "disbursed",
      progress: { completedInstallments: 0, missedInstallments: 0, totalInstallments: 12 },
    });

    const detail = loanDetailResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/loans/${disbursed.loan.id}?runId=${runId}`,
    })).json());
    expect(detail.schedule).toHaveLength(12);
    expect(detail.loan).toMatchObject({
      scheduleDigest: disbursed.loan.scheduleDigest,
      recognitionTransactionId: disbursed.transaction.id,
      disbursedTick: 4,
      maturityTick: 364,
    });
    expect(detail.why.kind).toBe("underwritten");
    if (detail.why.kind !== "underwritten") throw new Error("expected underwriting why-panel");
    expect(detail.why.assessment.inputs).toMatchObject({
      requestedAmountCents: "600001",
      termMonths: 12,
      incomeEvidenceRefs: expect.any(Array),
      debtEvidenceRefs: expect.any(Array),
    });
    expect(detail.why.decision.policyChecks).toHaveLength(6);
    expect(detail.why.decision.policyChecks.every((check) => check.passed)).toBe(true);
    expect(detail.why.review.reviewTier).toBe("tier2");
    expect(detail.why.decision).toMatchObject({
      reviewTier: "tier2",
      agentDecisionId,
      officerAdjustment,
      rationale: officerRationale,
    });
    expect(detail.why.circuitAssessments.map((assessment) => assessment.stage))
      .toEqual(["approval", "disbursement"]);
    expect(detail.why.evidence).toEqual(expect.arrayContaining([
      detail.why.application.sourceEventId,
      detail.why.assessment.sourceEventId,
      detail.why.review.sourceEventId,
      detail.why.decision.sourceEventId,
      detail.loan.sourceEventId,
    ]));

    const indicators = indicatorSeriesResponseSchema.parse((await f.app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/indicators?runId=${runId}&series=creditOutstanding,defaultRate`,
    })).json());
    const creditSeries = indicators.series.find((series) => series.name === "creditOutstanding")!;
    expect(creditSeries.points.at(-1)?.[0]).toBe(4);
    expect(
      BigInt(String(creditSeries.points.at(-1)?.[1])) -
      BigInt(String(creditSeries.points[0]?.[1])),
    ).toBe(600001n);
    expect(indicators.series.find((series) => series.name === "defaultRate")?.points.at(-1))
      .toEqual([4, 0]);
  });
});
