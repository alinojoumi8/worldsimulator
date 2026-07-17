import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  canonicalParse,
  createExportResponseSchema,
  createSimulationResponseSchema,
  exportManifestSchema,
  getExportResponseSchema,
  sha256Hex,
  type ExportFile,
  type ExportJob,
} from "@worldtangle/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { resolveExportArtifactPath } from "./export-generator";
import {
  computeLogicalStateHash,
  openWorldDatabase,
  SqliteExportStore,
  worldDatabasePath,
  type RunLocation,
} from "./persistence";

const directories: string[] = [];
const applications: FastifyInstance[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-export-integration-"));
  directories.push(path);
  return path;
}

function appFor(dataDir: string): FastifyInstance {
  const app = buildApp({
    dataDir,
    wallClock: () => "2026-07-16T12:00:00.000Z",
    tickIntervalMs: 1,
    enableAgentFramework: true,
    enableNewsPipeline: false,
  });
  applications.push(app);
  return app;
}

async function closeTracked(app: FastifyInstance): Promise<void> {
  const index = applications.indexOf(app);
  if (index >= 0) applications.splice(index, 1);
  await app.close();
}

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function waitForRun(app: FastifyInstance, simulationId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/status`,
    });
    const run = object(object(response.json())["run"]);
    if (run["status"] === "completed") return;
    if (run["status"] === "failed") throw new Error("simulation failed before export");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("simulation did not complete");
}

async function waitForExport(app: FastifyInstance, exportId: string): Promise<ExportJob> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/v1/exports/${exportId}` });
    const job = getExportResponseSchema.parse(response.json()).export;
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(`${job.errorCode}: ${job.errorMessage}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`export ${exportId} did not complete`);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

function requiredFile(job: ExportJob, dataset: ExportFile["dataset"]): ExportFile {
  const file = job.files.find((candidate) => candidate.dataset === dataset);
  if (file === undefined) throw new Error(`missing ${dataset} export file`);
  return file;
}

function readArtifact(location: RunLocation, file: ExportFile): string {
  const content = readFileSync(resolveExportArtifactPath(location, file.path), "utf8");
  expect(Buffer.byteLength(content, "utf8")).toBe(file.bytes);
  expect(sha256Hex(content)).toBe(file.sha256);
  return content;
}

function jsonlRows(content: string): unknown[] {
  return content.trim().length === 0
    ? []
    : content.trimEnd().split("\n").map((line) => canonicalParse(line));
}

function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (character === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted || row.length > 0 || cell.length > 0) throw new Error("incomplete CSV record");
  return rows;
}

function assertBalancedLegs(value: unknown): void {
  let debits = 0n;
  let credits = 0n;
  for (const legValue of array(value)) {
    const leg = object(legValue);
    const amount = BigInt(String(leg["amountCents"]));
    if (leg["direction"] === "debit") debits += amount;
    else if (leg["direction"] === "credit") credits += amount;
    else throw new Error("invalid transaction direction");
  }
  expect(debits).toBe(credits);
}

describe("WS-706 checksummed exports", () => {
  it("round-trips JSONL and CSV and resumes a running job after restart", async () => {
    const dataDir = temporaryDirectory();
    let app = appFor(dataDir);
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        name: "export-fixture",
        scenario: {
          worldSpec: "riverbend-100@1",
          seed: 42,
          llmMode: "off",
          budgets: { runCostCentsMax: "500", perAgentDailyTokens: 2_000 },
          policyOverrides: {},
          endTick: 1,
        },
      },
    });
    const created = createSimulationResponseSchema.parse(createdResponse.json());
    const simulationId = created.simulation.id;
    const runId = created.run.id;
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/start`,
      payload: { runId },
    })).statusCode).toBe(202);
    await waitForRun(app, simulationId);

    const location: RunLocation = {
      simulationId,
      runId,
      databasePath: worldDatabasePath(dataDir, simulationId, runId),
    };
    const db = openWorldDatabase(dataDir, simulationId, runId);
    const sourceHash = computeLogicalStateHash(db, runId);
    const authoritativeCounts = {
      events: Number(db.prepare<[string], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM events WHERE run_id = ?",
      ).get(runId)!.count),
      transactions: Number(db.prepare<[string], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM ledger_transactions WHERE run_id = ?",
      ).get(runId)!.count),
      indicators: Number(db.prepare<[string], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM indicator_points WHERE run_id = ?",
      ).get(runId)!.count),
    };
    const authoritativeBalances = new Map(db.prepare<[string], {
      id: string;
      balance_cents: string;
    }>(`
      SELECT id, balance_cents FROM bank_accounts
      WHERE run_id = ? ORDER BY id
    `).all(runId).map((account) => [account.id, BigInt(account.balance_cents)]));
    db.close();
    expect(authoritativeCounts.events).toBeGreaterThan(0);
    expect(authoritativeCounts.indicators).toBeGreaterThan(0);
    expect(authoritativeCounts.transactions).toBeGreaterThan(0);

    const queuedJsonl = createExportResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/exports`,
      payload: {
        runId,
        datasets: ["events", "transactions", "indicators"],
        format: "jsonl",
      },
    })).json()).export;
    const jsonl = await waitForExport(app, queuedJsonl.id);
    expect(jsonl.sourceStateHash).toBe(sourceHash);
    let exportedTransactions: unknown[] = [];
    for (const dataset of jsonl.datasets) {
      const file = requiredFile(jsonl, dataset);
      expect(file.rows).toBe(authoritativeCounts[dataset]);
      const rows = jsonlRows(readArtifact(location, file));
      expect(rows).toHaveLength(file.rows);
      if (dataset === "events") {
        expect(rows.map((value) => Number(object(value)["seq"]))).toEqual(
          rows.map((_, index) => index),
        );
      } else if (dataset === "transactions") {
        exportedTransactions = rows;
        for (const value of rows) assertBalancedLegs(object(value)["legs"]);
      } else {
        for (const value of rows) {
          const indicator = object(value);
          expect(indicator["formulaVersion"]).toBeTypeOf("number");
          expect(indicator["inputsDigest"]).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
    const reconstructedBalances = new Map<string, bigint>();
    for (const value of exportedTransactions) {
      for (const legValue of array(object(value)["legs"])) {
        const leg = object(legValue);
        const accountId = String(leg["accountId"]);
        const amount = BigInt(String(leg["amountCents"]));
        const delta = leg["direction"] === "debit" ? amount : -amount;
        reconstructedBalances.set(
          accountId,
          (reconstructedBalances.get(accountId) ?? 0n) + delta,
        );
      }
    }
    expect([...authoritativeBalances].map(([accountId]) => [
      accountId,
      reconstructedBalances.get(accountId) ?? 0n,
    ])).toEqual([...authoritativeBalances]);
    const manifestContent = readFileSync(
      resolveExportArtifactPath(location, jsonl.manifest!.path),
      "utf8",
    );
    expect(sha256Hex(manifestContent)).toBe(jsonl.manifest!.sha256);
    expect(exportManifestSchema.parse(canonicalParse(manifestContent))).toMatchObject({
      exportId: jsonl.id,
      sourceStateHash: sourceHash,
      files: jsonl.files,
    });

    const queuedCsv = createExportResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/exports`,
      payload: {
        runId,
        datasets: ["events", "transactions", "indicators"],
        format: "csv",
      },
    })).json()).export;
    const csv = await waitForExport(app, queuedCsv.id);
    for (const dataset of csv.datasets) {
      const file = requiredFile(csv, dataset);
      const rows = csvRows(readArtifact(location, file));
      expect(rows).toHaveLength(file.rows + 1);
      if (dataset === "events") {
        const payloadIndex = rows[0]!.indexOf("payloadCanonical");
        for (const row of rows.slice(1)) expect(() => canonicalParse(row[payloadIndex]!)).not.toThrow();
      } else if (dataset === "transactions") {
        const legsIndex = rows[0]!.indexOf("legsCanonical");
        for (const row of rows.slice(1)) assertBalancedLegs(canonicalParse(row[legsIndex]!));
      } else {
        const digestIndex = rows[0]!.indexOf("inputsDigest");
        for (const row of rows.slice(1)) expect(row[digestIndex]).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    await closeTracked(app);
    const recoveryDb = openWorldDatabase(dataDir, simulationId, runId);
    const recoveryStore = new SqliteExportStore(recoveryDb, runId);
    const recovering = recoveryStore.create({
      simulationId,
      format: "jsonl",
      datasets: ["indicators"],
      sourceTick: 1,
      sourceStateHash: sourceHash,
      correlationId: "restart-recovery",
      createdWall: "2026-07-16T12:01:00.000Z",
    });
    recoveryStore.markRunning(recovering.id, "2026-07-16T12:01:01.000Z");
    recoveryDb.close();

    app = appFor(dataDir);
    const recovered = await waitForExport(app, recovering.id);
    expect(recovered.status).toBe("completed");
    expect(recovered.auditEvents.map((event) => event.type)).toEqual([
      "export.job.queued",
      "export.job.started",
      "export.job.completed",
    ]);
    const finalDb = openWorldDatabase(dataDir, simulationId, runId);
    expect(computeLogicalStateHash(finalDb, runId)).toBe(sourceHash);
    finalDb.close();
  }, 15_000);
});
