import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "@worldtangle/shared";
import { checkInvariants } from "@worldtangle/engine";
import { SimulationService } from "../simulation-service";
import { readRunInvariantSnapshot } from "../testing/run-invariant-probe";
import {
  computeLogicalStateHash,
  openDatabaseFile,
  openWorldDatabase,
  SqliteOpeningCreditStore,
  SqliteSnapshotStore,
} from "./index";

const directories: string[] = [];
const services: SimulationService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WS-506 persisted opening credit state", () => {
  it("audits exact histories, causal ledger facts, immutability, reopen, and snapshot restore", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-opening-credit-"));
    directories.push(dataDir);
    const service = new SimulationService({
      dataDir,
      wallClock: () => "2026-07-15T00:00:00.000Z",
      tickIntervalMs: 60_000,
    });
    services.push(service);
    const created = service.createSimulation({
      name: "opening-credit-audit",
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: 42,
        llmMode: "mock",
        budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
        policyOverrides: {},
        endTick: 360,
      },
    }, "ws506-create");
    const simulationId = created.simulation.id;
    const runId = created.run.id;
    service.close();
    services.splice(services.indexOf(service), 1);

    let db = openWorldDatabase(dataDir, simulationId, runId);
    const opening = new SqliteOpeningCreditStore(db, runId);
    const audit = opening.audit();
    expect(audit.violations).toEqual([]);
    expect(audit.summary).toEqual(expect.objectContaining({
      totalLoans: 8,
      businessLoans: 1,
      personalLoans: 7,
      currentPersonalLoans: 6,
      delinquentPersonalLoans: 1,
      totalOutstandingPrincipalCents: expect.stringMatching(/^\d+$/),
    }));

    const state = opening.readState();
    expect(state.links).toHaveLength(8);
    expect(state.transactions).toHaveLength(8);
    expect(state.seedEvents).toHaveLength(8);
    expect(state.loans.find((loan) => loan.borrowerId === "biz_ironvale")).toMatchObject({
      originalPrincipalCents: "30000000",
      outstandingPrincipalCents: "11666662",
      annualRateBp: 650,
      termMonths: 36,
      seasonedMonths: 22,
      missedPayments: 0,
      status: "current",
    });
    const delinquent = state.loans.filter((loan) => (
      loan.borrowerKind === "agent" && loan.status === "delinquent"
    ));
    expect(delinquent).toHaveLength(1);
    expect(delinquent[0]!.installments.filter((row) => row.status === "missed")).toHaveLength(1);

    const invariantReport = checkInvariants(readRunInvariantSnapshot(db, runId));
    expect(invariantReport.checks.find((check) => check.invariant === "INV-6")).toEqual({
      invariant: "INV-6",
      status: "passed",
      violations: [],
    });

    const originalHash = computeLogicalStateHash(db, runId);
    const first = state.loans[0]!;
    expect(() => db.prepare(`
      UPDATE seed_loans SET status = 'delinquent'
      WHERE run_id = ? AND id = ?
    `).run(runId, first.id)).toThrow(/seed loans are immutable/);
    expect(() => db.prepare(`
      DELETE FROM seed_loans WHERE run_id = ? AND id = ?
    `).run(runId, first.id)).toThrow(/seed loans cannot be deleted/);
    const invalid = {
      ...first,
      id: "loan_invalid_opening",
      outstandingPrincipalCents: "1",
    };
    expect(() => db.prepare(`
      INSERT INTO seed_loans(
        run_id, id, borrower_kind, borrower_id, status,
        outstanding_principal_cents, loan_canonical
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      invalid.id,
      invalid.borrowerKind,
      invalid.borrowerId,
      invalid.status,
      invalid.outstandingPrincipalCents,
      canonicalStringify(invalid),
    )).toThrow(/seed loan history is inconsistent/);
    expect(computeLogicalStateHash(db, runId)).toBe(originalHash);
    expect(opening.audit()).toEqual(audit);

    const snapshots = new SqliteSnapshotStore(db, dataDir, simulationId, runId);
    const snapshot = await snapshots.create({ createdWall: "2026-07-15T00:00:01.000Z" });
    const restoredPath = snapshots.restoreTo(
      snapshot.id,
      join(dataDir, "restored", "opening-credit.db"),
    );
    const finalHash = computeLogicalStateHash(db, runId);
    expect(snapshot.stateHash).toBe(finalHash);
    db.close();

    db = openWorldDatabase(dataDir, simulationId, runId);
    try {
      expect(new SqliteOpeningCreditStore(db, runId).audit()).toEqual(audit);
      expect(computeLogicalStateHash(db, runId)).toBe(finalHash);
    } finally {
      db.close();
    }

    const restored = openDatabaseFile(restoredPath);
    try {
      expect(new SqliteOpeningCreditStore(restored, runId).audit()).toEqual(audit);
      expect(computeLogicalStateHash(restored, runId)).toBe(finalHash);
      const restoredInvariant = checkInvariants(readRunInvariantSnapshot(restored, runId));
      expect(restoredInvariant.checks.find((check) => check.invariant === "INV-6")?.status)
        .toBe("passed");
    } finally {
      restored.close();
    }
  });
});
