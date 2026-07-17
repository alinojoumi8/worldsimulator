import { describe, expect, it } from "vitest";
import { IdFactory } from "@worldtangle/shared";
import {
  DeterministicMemoryStore,
  InMemoryMemoryRepository,
} from "./memory-store";

const runId = "run_00000001";
const agentId = "agt_00000001";

function fixture(maxActiveMemories = 8, compactToMemories = 5) {
  const repository = new InMemoryMemoryRepository();
  const ids = new IdFactory();
  const store = new DeterministicMemoryStore({
    repository,
    ids,
    maxActiveMemories,
    compactToMemories,
  });
  return { repository, ids, store };
}

describe("DeterministicMemoryStore", () => {
  it("ranks by integer recency, importance, references, and query relevance", () => {
    const { store } = fixture();
    const older = store.record({
      runId,
      agentId,
      tick: 2,
      kind: "event",
      content: "A bakery lease became available in Riverbend.",
      importance: 80,
      references: ["evt_00000001"],
    }).memory;
    store.record({
      runId,
      agentId,
      tick: 9,
      kind: "conversation",
      content: "A neighbor discussed the weather.",
      importance: 20,
      references: ["evt_00000002"],
    });

    const first = store.retrieve(agentId, {
      tick: 10,
      triggerKind: "goal",
      queryText: "start bakery",
      referenceIds: ["evt_00000001"],
      preferredKinds: ["event"],
    }, 2);
    const second = store.retrieve(agentId, {
      tick: 10,
      triggerKind: "goal",
      queryText: "start bakery",
      referenceIds: ["evt_00000001"],
      preferredKinds: ["event"],
    }, 2);
    expect(first).toEqual(second);
    expect(first[0]?.memory.id).toBe(older.id);
    expect(first[0]?.factors.relevance).toBe(490);
  });

  it("bounds the active set while preserving immutable sources and references", () => {
    const { repository, store } = fixture(4, 3);
    for (let tick = 1; tick <= 5; tick++) {
      store.record({
        runId,
        agentId,
        tick,
        kind: tick % 2 === 0 ? "event" : "outcome",
        content: `Memory ${tick}`,
        importance: tick * 10,
        references: [`evt_${tick.toString(36).padStart(8, "0")}`],
      });
    }
    const all = repository.list(agentId);
    const active = repository.listActive(agentId);
    const summary = all.find((memory) => memory.sourceMemoryIds !== undefined);
    expect(all).toHaveLength(6);
    expect(active).toHaveLength(3);
    expect(summary?.sourceMemoryIds).toEqual([
      "mem_00000001",
      "mem_00000002",
      "mem_00000003",
    ]);
    expect(summary?.references).toEqual([
      "evt_00000001",
      "evt_00000002",
      "evt_00000003",
    ]);
    expect(all[0]?.content).toBe("Memory 1");
  });

  it("uses memory ID as the final deterministic tie breaker", () => {
    const { store } = fixture();
    const first = store.record({
      runId,
      agentId,
      tick: 1,
      kind: "event",
      content: "same",
      importance: 50,
      references: [],
    }).memory;
    store.record({
      runId,
      agentId,
      tick: 1,
      kind: "event",
      content: "same",
      importance: 50,
      references: [],
    });
    expect(store.retrieve(agentId, { tick: 1, referenceIds: [], preferredKinds: [] }, 1)[0]?.memory.id)
      .toBe(first.id);
  });
});
