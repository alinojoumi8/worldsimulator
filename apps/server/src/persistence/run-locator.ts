/** Filesystem locator for authoritative per-run databases (ADR-0004). */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EngineError, runIdSchema, simulationIdSchema } from "@worldtangle/shared";
import { worldDatabasePath } from "./database";

export interface RunLocation {
  readonly simulationId: string;
  readonly runId: string;
  readonly databasePath: string;
}

function directoryNames(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function idValue(id: string): number {
  const suffix = id.slice(id.indexOf("_") + 1);
  const value = Number.parseInt(suffix, 36);
  if (!Number.isSafeInteger(value)) throw new EngineError("INTERNAL", `invalid persisted ID: ${id}`);
  return value;
}

function formatId(prefix: "sim" | "run", value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 36 ** 8) {
    throw new EngineError("LIMIT_EXCEEDED", `${prefix} ID space exhausted`);
  }
  return `${prefix}_${value.toString(36).padStart(8, "0")}`;
}

export class RunLocator {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  list(): readonly RunLocation[] {
    const locations: RunLocation[] = [];
    const simulationIds = directoryNames(this.dataDir)
      .filter((id) => simulationIdSchema.safeParse(id).success)
      .sort();
    for (const simulationId of simulationIds) {
      const runIds = directoryNames(join(this.dataDir, simulationId))
        .filter((id) => runIdSchema.safeParse(id).success)
        .sort();
      for (const runId of runIds) {
        const databasePath = worldDatabasePath(this.dataDir, simulationId, runId);
        if (existsSync(databasePath)) locations.push({ simulationId, runId, databasePath });
      }
    }
    return locations;
  }

  locate(simulationId: string, runId?: string): RunLocation {
    if (!simulationIdSchema.safeParse(simulationId).success) {
      throw new EngineError("VALIDATION_FAILED", `invalid simulation ID: ${simulationId}`);
    }
    const candidates = this.list().filter((location) => location.simulationId === simulationId);
    if (runId !== undefined) {
      if (!runIdSchema.safeParse(runId).success) {
        throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${runId}`);
      }
      const match = candidates.find((location) => location.runId === runId);
      if (match) return match;
    } else if (candidates.length > 0) {
      return candidates.at(-1)!;
    }
    throw new EngineError(
      "NOT_FOUND",
      runId === undefined
        ? `simulation ${simulationId} has no runs`
        : `run ${runId} does not exist for simulation ${simulationId}`,
    );
  }

  nextIds(): { simulationId: string; runId: string } {
    const locations = this.list();
    const simulationValue = locations.reduce(
      (maximum, location) => Math.max(maximum, idValue(location.simulationId)),
      0,
    );
    const runValue = locations.reduce(
      (maximum, location) => Math.max(maximum, idValue(location.runId)),
      0,
    );
    return {
      simulationId: formatId("sim", simulationValue + 1),
      runId: formatId("run", runValue + 1),
    };
  }
}
