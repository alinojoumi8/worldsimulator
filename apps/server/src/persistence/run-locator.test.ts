import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "@worldtangle/shared";
import { RunLocator } from "./run-locator";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "worldtangle-locator-"));
  temporaryDirectories.push(path);
  return path;
}

function addRun(dataDir: string, simulationId: string, runId: string): void {
  const directory = join(dataDir, simulationId, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "world.db"), "fixture");
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("RunLocator", () => {
  it("discovers only valid per-run database paths in deterministic order", () => {
    const dataDir = temporaryDirectory();
    addRun(dataDir, "sim_00000002", "run_00000002");
    addRun(dataDir, "sim_00000001", "run_00000001");
    addRun(dataDir, "not-a-simulation", "run_00000003");
    mkdirSync(join(dataDir, "sim_00000003", "run_00000003"), { recursive: true });

    const locator = new RunLocator(dataDir);
    expect(locator.list().map((location) => [location.simulationId, location.runId])).toEqual([
      ["sim_00000001", "run_00000001"],
      ["sim_00000002", "run_00000002"],
    ]);
  });

  it("locates an explicit or latest run and validates IDs", () => {
    const dataDir = temporaryDirectory();
    addRun(dataDir, "sim_00000001", "run_00000001");
    addRun(dataDir, "sim_00000001", "run_00000003");
    const locator = new RunLocator(dataDir);
    expect(locator.locate("sim_00000001").runId).toBe("run_00000003");
    expect(locator.locate("sim_00000001", "run_00000001").runId).toBe("run_00000001");
    expect(() => locator.locate("../outside")).toThrow(EngineError);
    expect(() => locator.locate("sim_00000002")).toThrow(EngineError);
  });

  it("allocates monotonic IDs across discovered runs and ignores crash debris", () => {
    const dataDir = temporaryDirectory();
    addRun(dataDir, "sim_00000002", "run_00000005");
    mkdirSync(join(dataDir, "sim_00000009", "run_00000009"), { recursive: true });
    expect(new RunLocator(dataDir).nextIds()).toEqual({
      simulationId: "sim_00000003",
      runId: "run_00000006",
    });
  });
});
