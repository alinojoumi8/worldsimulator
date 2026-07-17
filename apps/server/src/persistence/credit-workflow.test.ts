import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdFactory,
  Rng,
  canonicalStringify,
  decisionSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import { generateRiverbendPopulation, type TickContext } from "@worldtangle/engine";
import { SqliteAgentStore } from "./agent-store";
import { SqliteCreditStore } from "./credit-store";
import {
  openDatabaseFile,
  openWorldDatabase,
  type WorldDatabase,
} from "./database";
import { SqliteFinanceStore } from "./finance-store";
import { computeLogicalStateHash, SqliteSnapshotStore } from "./snapshot-store";
import { insertTestRun, TEST_RUN_ID, TEST_SIMULATION_ID } from "./test-helpers";
import { readRunCheckpoint } from "./tick-committer";

const directories: string[] = [];
const databases: WorldDatabase[] = [];

interface RecordedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly options: unknown;
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-credit-workflow-"));
  directories.push(dataDir);
  const db = openWorldDatabase(dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
  databases.push(db);
  insertTestRun(db);
  const population = generateRiverbendPopulation({ runId: TEST_RUN_ID, seed: 42 });
  const triggerEvents = new Map(population.residents.map((resident) => [
    resident.agent.id,
    `evt_${(resident.rosterIndex + 1).toString(36).padStart(8, "0")}`,
  ]));
  new SqliteAgentStore(db, TEST_RUN_ID).insertPopulation(population, triggerEvents);
  const ids = IdFactory.restore(population.idState);
  new SqliteFinanceStore(db, TEST_RUN_ID).initialize(population, ids);
  const bankId = db.prepare<[string], { id: string }>(`
    SELECT id FROM banks WHERE run_id = ? ORDER BY id LIMIT 1
  `).get(TEST_RUN_ID)?.id;
  if (bankId === undefined) throw new Error("workflow bank is missing");
  const borrowerIds = new Set(population.loans.map((loan) => loan.borrowerId));
  const applicant = population.residents.find((resident) => (
    resident.agent.employmentStatus === "employed" && !borrowerIds.has(resident.agent.id)
  ));
  if (applicant === undefined) throw new Error("workflow applicant is missing");
  const tellerId = db.prepare<[string], { id: string }>(`
    SELECT id FROM agents WHERE run_id = ? AND role_code = 'bank.teller' LIMIT 1
  `).get(TEST_RUN_ID)?.id;
  if (tellerId === undefined) throw new Error("workflow teller is missing");
  return { dataDir, db, population, ids, bankId, applicantId: applicant.agent.id, tellerId };
}

function context(
  ids: IdFactory,
  tick: number,
  tag: string,
  events: RecordedEvent[] = [],
): TickContext {
  let sequence = 0;
  return {
    simulationId: TEST_SIMULATION_ID,
    runId: TEST_RUN_ID,
    tick,
    simDate: "Y0001-M01-D01",
    phase: "execute",
    ids,
    rng: (key) => Rng.root(42).fork(`${tick}.credit-workflow.${key}`),
    count: () => undefined,
    setDigestIndicators: () => undefined,
    emit: (type, payload, options) => {
      const eventId = `evt_${tag}${String(++sequence).padStart(8, "0")}`;
      events.push({ eventId, type, payload, options });
      return { eventId } as EventEnvelope;
    },
  };
}

function request(
  base: ReturnType<typeof fixture>,
  amountCents = "600000",
) {
  return {
    applicantKind: "agent" as const,
    applicantId: base.applicantId,
    bankId: base.bankId,
    purpose: "Replace a failed vehicle",
    amountCents,
    termMonths: 12,
  };
}

function submitReviewDecide(
  base: ReturnType<typeof fixture>,
  tag: string,
  amountCents = "600000",
) {
  const events: RecordedEvent[] = [];
  const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
  const submitted = store.submitApplication(
    request(base, amountCents),
    context(base.ids, 1, `${tag}sub`, events),
  );
  const reviewing = store.beginReview(
    submitted.application.id,
    context(base.ids, 2, `${tag}rev`, events),
  );
  const decided = store.decideTier1Application(
    submitted.application.id,
    context(base.ids, 3, `${tag}dec`, events),
  );
  return { store, submitted, reviewing, decided, events };
}

function persistLoanOfficerDecision(input: {
  readonly base: ReturnType<typeof fixture>;
  readonly officerAgentId: string;
  readonly applicationId: string;
  readonly tick: number;
  readonly adjustment: number;
}): string {
  const decisionId = input.base.ids.next("dec");
  const callId = input.base.ids.next("llm");
  const params = {
    applicationId: input.applicationId,
    officerAgentId: input.officerAgentId,
    officerAdjustment: input.adjustment,
  };
  new SqliteAgentStore(input.base.db, TEST_RUN_ID).saveDecisionResult([
    decisionSchema.parse({
      id: decisionId,
      runId: TEST_RUN_ID,
      agentId: input.officerAgentId,
      tick: input.tick,
      trigger: { kind: "schedule", sourceEventId: "evt_00000001", priority: 95 },
      tier: 2,
      observationDigest: { hash: "4".repeat(64), summary: "bounded loan review menu" },
      optionsOffered: [{
        actionId: "loan.adjust_test",
        actionType: "bank.review_loan",
        params,
        utility: 100,
      }],
      chosenActionId: "loan.adjust_test",
      params,
      rationale: "bounded loan officer adjustment",
      llmCallId: callId,
      validationResult: { status: "approved" },
      promptPackKey: "agent.decision",
      promptVersion: 1,
      promptHash: "5".repeat(64),
    }),
  ], []);
  return decisionId;
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-502 persisted application workflow", () => {
  it("moves submitted -> under_review -> approved with a complete immutable why record", () => {
    const base = fixture();
    const result = submitReviewDecide(base, "approve");

    expect(result.submitted.application.status).toBe("submitted");
    expect(result.reviewing.application.status).toBe("under_review");
    expect(result.decided.application).toMatchObject({ status: "approved", decidedTick: 3 });
    expect(result.decided.review).toMatchObject({ reviewTier: "tier1", startedTick: 2 });
    expect(result.decided.decision).toMatchObject({
      reviewTier: "tier1",
      policyVersion: 1,
      officerAdjustment: 0,
      outcome: "approved",
      decidedTick: 3,
    });
    expect(result.decided.decision.policyChecks).toHaveLength(6);
    expect(result.decided.decision.policyChecks.every((check) => check.passed)).toBe(true);
    expect(result.decided.decision.offeredRateBp).not.toBeNull();
    expect(result.store.getReviewForApplication(result.submitted.application.id))
      .toEqual(result.decided.review);
    expect(result.store.getDecisionForApplication(result.submitted.application.id))
      .toEqual(result.decided.decision);

    expect(result.events.map((event) => event.type)).toEqual([
      "loan.application.created",
      "loan.score.computed",
      "loan.application.review_started",
      "bank.lending.assessed",
      "loan.approved",
    ]);
    expect(result.events[2]?.options).toMatchObject({
      actor: { kind: "agent", id: result.decided.review.officerAgentId },
      causationId: result.events[0]?.eventId,
    });
    expect(result.events[3]?.options).toMatchObject({
      actor: { kind: "institution", id: base.bankId },
      causationId: result.events[2]?.eventId,
    });
    expect(result.events[4]?.options).toMatchObject({
      actor: { kind: "agent", id: result.decided.review.officerAgentId },
      causationId: result.events[3]?.eventId,
    });
    expect(result.events[4]?.payload).toMatchObject({
      applicationId: result.submitted.application.id,
      scoreInputs: result.submitted.assessment.inputs,
      scoreBreakdown: result.submitted.assessment.breakdown,
      officerAdjustment: 0,
      officerRationale: result.decided.decision.rationale,
      policyChecks: result.decided.decision.policyChecks,
      offeredRateBp: result.decided.decision.offeredRateBp,
      circuitBreakerAssessment: {
        allowed: true,
        failedBreakers: [],
      },
    });

    expect(() => result.store.decideTier1Application(
      result.submitted.application.id,
      context(base.ids, 4, "again"),
    )).toThrow(/not under_review/);
    expect(() => base.db.prepare(`
      UPDATE loan_application_decisions SET final_score = 300
      WHERE run_id = ? AND application_id = ?
    `).run(TEST_RUN_ID, result.submitted.application.id)).toThrow(/decisions are immutable/);
    expect(() => base.db.prepare(`
      UPDATE loan_applications SET status = 'rejected'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, result.submitted.application.id)).toThrow(/loan application/);
  });

  it("rejects on stored policy failures and carries all failed checks in its event", () => {
    const base = fixture();
    const result = submitReviewDecide(base, "reject", "120000001");
    expect(result.decided.application.status).toBe("rejected");
    expect(result.decided.decision).toMatchObject({
      outcome: "rejected",
      offeredRateBp: null,
      officerAdjustment: 0,
    });
    const failed = result.decided.decision.policyChecks
      .filter((check) => !check.passed)
      .map((check) => check.id);
    expect(failed).toEqual(expect.arrayContaining([
      "minimum_score",
      "maximum_dti",
      "borrower_exposure",
    ]));
    expect(result.events.at(-1)).toMatchObject({
      type: "loan.rejected",
      payload: {
        failedChecks: failed,
        offeredRateBp: null,
        scoreInputs: result.submitted.assessment.inputs,
      },
    });
  });

  it("assigns the least-loaded officer deterministically and rejects non-officer authority", () => {
    const base = fixture();
    const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const first = store.submitApplication(request(base), context(base.ids, 1, "load1sub"));
    const second = store.submitApplication(request(base), context(base.ids, 1, "load2sub"));
    const firstReview = store.beginReview(
      first.application.id,
      context(base.ids, 2, "load1rev"),
    ).review;
    const secondReview = store.beginReview(
      second.application.id,
      context(base.ids, 2, "load2rev"),
    ).review;
    expect(firstReview.officerAgentId).not.toBe(secondReview.officerAgentId);
    expect(firstReview.officerAgentId < secondReview.officerAgentId).toBe(true);

    const forbidden = store.submitApplication(request(base), context(base.ids, 2, "forbidsub"));
    expect(() => store.beginReview(
      forbidden.application.id,
      context(base.ids, 3, "forbidrev"),
      base.tellerId,
    )).toThrow(/not an active loan officer/);
    expect(store.getApplication(forbidden.application.id).status).toBe("submitted");
    expect(() => store.getReviewForApplication(forbidden.application.id)).toThrow(/does not exist/);

    const direct = store.submitApplication(request(base), context(base.ids, 3, "directsub"));
    expect(() => base.db.prepare(`
      UPDATE loan_applications SET status = 'under_review'
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, direct.application.id)).toThrow(/review record is required/);
    expect(() => base.db.prepare(`
      UPDATE loan_applications SET status = 'approved', decided_tick = 3
      WHERE run_id = ? AND id = ?
    `).run(TEST_RUN_ID, direct.application.id)).toThrow(/loan application/);
  });

  it("rolls back, reopens, and restores with an equivalent next decision hash", async () => {
    const base = fixture();
    const first = submitReviewDecide(base, "persist");
    const beforeRollback = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const pending = first.store.submitApplication(
      request(base),
      context(base.ids, 4, "rollbacksub"),
    );
    expect(() => base.db.transaction(() => {
      first.store.beginReview(
        pending.application.id,
        context(base.ids, 5, "rollbackrev"),
      );
      throw new Error("rollback review");
    }).immediate()).toThrow(/rollback review/);
    expect(first.store.getApplication(pending.application.id).status).toBe("submitted");
    expect(() => first.store.getReviewForApplication(pending.application.id)).toThrow(/does not exist/);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).not.toBe(beforeRollback);

    base.db.prepare(`
      UPDATE simulation_runs SET current_tick = 5, id_state_canonical = ? WHERE id = ?
    `).run(canonicalStringify(base.ids.serialize()), TEST_RUN_ID);
    const expectedHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    base.db.close();
    const reopened = openWorldDatabase(base.dataDir, TEST_SIMULATION_ID, TEST_RUN_ID);
    databases.push(reopened);
    const reopenedStore = new SqliteCreditStore(reopened, TEST_RUN_ID);
    expect(reopenedStore.getDecisionForApplication(first.submitted.application.id))
      .toEqual(first.decided.decision);
    expect(computeLogicalStateHash(reopened, TEST_RUN_ID)).toBe(expectedHash);

    const snapshots = new SqliteSnapshotStore(
      reopened,
      base.dataDir,
      TEST_SIMULATION_ID,
      TEST_RUN_ID,
    );
    const snapshot = await snapshots.create({ createdWall: "workflow-snapshot-wall" });
    const destination = join(base.dataDir, "workflow-restored", "world.db");
    snapshots.restoreTo(snapshot.id, destination);

    const nextDecisionHash = (db: WorldDatabase): string => {
      const ids = IdFactory.restore(readRunCheckpoint(db, TEST_RUN_ID).idState);
      const store = new SqliteCreditStore(db, TEST_RUN_ID);
      store.beginReview(pending.application.id, context(ids, 6, "equivrev"));
      store.decideTier1Application(pending.application.id, context(ids, 7, "equivdec"));
      db.prepare(`
        UPDATE simulation_runs SET current_tick = 7, id_state_canonical = ? WHERE id = ?
      `).run(canonicalStringify(ids.serialize()), TEST_RUN_ID);
      return computeLogicalStateHash(db, TEST_RUN_ID);
    };

    const straightHash = nextDecisionHash(reopened);
    const restored = openDatabaseFile(destination);
    databases.push(restored);
    expect(computeLogicalStateHash(restored, TEST_RUN_ID)).toBe(snapshot.stateHash);
    expect(nextDecisionHash(restored)).toBe(straightHash);
  });
});

describe("WS-605 bounded Tier-2 loan review", () => {
  it.each([-5, 5] as const)(
    "accepts the inclusive %i adjustment and preserves its written why record",
    (adjustment) => {
      const base = fixture();
      const events: RecordedEvent[] = [];
      const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
      const submitted = store.submitApplication(request(base), context(base.ids, 1, "t2sub", events));
      const review = store.beginReview(
        submitted.application.id,
        context(base.ids, 2, "t2rev", events),
        undefined,
        "tier2",
      ).review;
      const agentDecisionId = persistLoanOfficerDecision({
        base,
        officerAgentId: review.officerAgentId,
        applicationId: submitted.application.id,
        tick: 3,
        adjustment,
      });
      const rationale = `loan_officer_selected_${adjustment}`;
      const decided = store.decideTier2Application(submitted.application.id, {
        officerAdjustment: adjustment,
        rationale,
        agentDecisionId,
      }, context(base.ids, 3, "t2dec", events));

      expect(decided.decision).toMatchObject({
        reviewTier: "tier2",
        agentDecisionId,
        officerAdjustment: adjustment,
        finalScore: decided.assessment.systemScore + adjustment,
        rationale,
      });
      expect(store.getDecisionForApplication(submitted.application.id)).toEqual(decided.decision);
      expect(events.at(-1)).toMatchObject({
        payload: { agentDecisionId, officerAdjustment: adjustment, officerRationale: rationale },
        options: { correlationId: agentDecisionId },
      });
    },
  );

  it.each([-6, 6] as const)("rejects %i before any underwriting mutation", (adjustment) => {
    const base = fixture();
    const store = new SqliteCreditStore(base.db, TEST_RUN_ID);
    const submitted = store.submitApplication(request(base), context(base.ids, 1, "badsub"));
    const review = store.beginReview(
      submitted.application.id,
      context(base.ids, 2, "badrev"),
      undefined,
      "tier2",
    ).review;
    const agentDecisionId = persistLoanOfficerDecision({
      base,
      officerAgentId: review.officerAgentId,
      applicationId: submitted.application.id,
      tick: 3,
      adjustment: 0,
    });
    const beforeHash = computeLogicalStateHash(base.db, TEST_RUN_ID);
    const beforeAssessments = base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM bank_lending_assessments WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count;

    expect(() => store.decideTier2Application(submitted.application.id, {
      officerAdjustment: adjustment,
      rationale: "forged out of bounds adjustment",
      agentDecisionId,
    }, context(base.ids, 3, "baddec"))).toThrow(/-5 through \+5/);
    expect(store.getApplication(submitted.application.id).status).toBe("under_review");
    expect(base.db.prepare<[string], { count: bigint }>(`
      SELECT COUNT(*) AS count FROM bank_lending_assessments WHERE run_id = ?
    `).get(TEST_RUN_ID)!.count).toBe(beforeAssessments);
    expect(computeLogicalStateHash(base.db, TEST_RUN_ID)).toBe(beforeHash);
  });
});
