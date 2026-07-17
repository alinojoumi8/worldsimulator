import { canonicalStringify } from "@worldtangle/shared";
import type {
  EventEnvelope,
  IdFactory,
  Simulation,
  SimulationRun,
} from "@worldtangle/shared";
import type { TickContext } from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { SqliteEventStore } from "./event-store";

export const TEST_SIMULATION_ID = "sim_00000001";
export const TEST_RUN_ID = "run_00000001";

export function testSimDate(tick: number): string {
  const boundedTick = Number.isSafeInteger(tick) && tick >= 0 ? tick : 0;
  const year = Math.floor(boundedTick / 360) + 1;
  const withinYear = boundedTick % 360;
  const month = Math.floor(withinYear / 30) + 1;
  const day = withinYear % 30 + 1;
  return `Y${String(year).padStart(4, "0")}-M${String(month).padStart(2, "0")}` +
    `-D${String(day).padStart(2, "0")}`;
}

export function appendTestTickEvent(
  db: WorldDatabase,
  input: {
    readonly simulationId: string;
    readonly runId: string;
    readonly ids: IdFactory;
    readonly tick: number;
    readonly simDate: string;
    readonly phase: TickContext["phase"];
    readonly type: string;
    readonly payload: unknown;
    readonly options?: Parameters<TickContext["emit"]>[2];
  },
): EventEnvelope {
  const events = new SqliteEventStore(db, input.runId);
  const eventId = input.ids.next("evt");
  const event: EventEnvelope = {
    eventId,
    type: input.type,
    schemaVersion: input.options?.schemaVersion ?? 1,
    simulationId: input.simulationId,
    runId: input.runId,
    seq: events.count(),
    tick: input.tick,
    simDate: input.simDate,
    wallTime: `T${input.tick}`,
    actor: input.options?.actor ?? { kind: "system", id: "persistence-test" },
    correlationId: input.options?.correlationId ??
      `persistence-test:${input.phase}:${input.tick}:${eventId}`,
    ...(input.options?.causationId === undefined
      ? {}
      : { causationId: input.options.causationId }),
    payload: input.payload,
  };
  events.append(event);
  return event;
}

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
