import { canonicalStringify } from "@worldtangle/shared";
import type { Simulation, SimulationRun } from "@worldtangle/shared";
import type { WorldDatabase } from "./database";

export const TEST_SIMULATION_ID = "sim_00000001";
export const TEST_RUN_ID = "run_00000001";

export function testSimulation(overrides: Partial<Simulation> = {}): Simulation {
  return {
    id: TEST_SIMULATION_ID,
    name: "test world",
    status: "created",
    scenarioVersion: 1,
    scenario: { worldSpec: "test@1" },
    createdWall: "T0",
    ...overrides,
  };
}

export function testRun(overrides: Partial<SimulationRun> = {}): SimulationRun {
  const id = overrides.id ?? TEST_RUN_ID;
  const simulationId = overrides.simulationId ?? TEST_SIMULATION_ID;
  return {
    id,
    simulationId,
    status: "created",
    currentTick: 0,
    nextEventSeq: 0,
    endTick: 360,
    manifest: {
      runId: id,
      simulationId,
      seed: 42,
      engineVersion: "0.1.0",
      rulesetVersion: 1,
      promptPackVersion: 1,
      eventSchemaVersion: 1,
      llmMode: "mock",
      modelRouting: {},
      scenarioDigest: "scenario-digest",
      worldSpecDigest: "world-spec-digest",
      createdWall: "T0",
    },
    idState: {},
    startedWall: null,
    endedWall: null,
    ...overrides,
  };
}

export function insertTestRun(db: WorldDatabase): void {
  const simulation = testSimulation();
  const run = testRun();
  db.prepare(`
    INSERT INTO simulations(
      id, name, status, scenario_version, scenario_canonical, created_wall
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    simulation.id,
    simulation.name,
    simulation.status,
    simulation.scenarioVersion,
    canonicalStringify(simulation.scenario),
    simulation.createdWall,
  );
  db.prepare(`
    INSERT INTO simulation_runs(
      id, simulation_id, status, current_tick, next_event_seq, end_tick,
      manifest_canonical, id_state_canonical, started_wall, ended_wall
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.simulationId,
    run.status,
    run.currentTick,
    run.nextEventSeq,
    run.endTick,
    canonicalStringify(run.manifest),
    canonicalStringify(run.idState),
    run.startedWall,
    run.endedWall,
  );
}
