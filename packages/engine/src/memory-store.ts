/** Deterministic M03 memory recording, retrieval, and template compaction. */

import {
  EngineError,
  memoryRetrievalContextSchema,
  memorySchema,
} from "@worldtangle/shared";
import type {
  Memory,
  MemoryKind,
  MemoryRecordInput,
  MemoryRetrievalContext,
} from "@worldtangle/shared";

export interface MemoryIdSource {
  next(prefix: "mem"): string;
}

/**
 * Records remain immutable forever. Compaction membership is stored in a
 * separate append-only relation so the active working set can stay bounded.
 */
export interface MemoryRepository {
  append(memory: Memory): void;
  list(agentId: string): readonly Memory[];
  listActive(agentId: string): readonly Memory[];
  compact(agentId: string, summary: Memory, sourceMemoryIds: readonly string[]): void;
}

export interface MemoryStoreOptions {
  readonly repository: MemoryRepository;
  readonly ids: MemoryIdSource;
  /** Maximum active records after automatic compaction. */
  readonly maxActiveMemories?: number;
  /** Target active records after compaction, including the new summary. */
  readonly compactToMemories?: number;
}

export interface MemoryCompactionResult {
  readonly summary: Memory;
  readonly sourceMemoryIds: readonly string[];
}

export interface MemoryRecordResult {
  readonly memory: Memory;
  readonly compaction?: MemoryCompactionResult;
}

export interface RetrievedMemory {
  readonly memory: Memory;
  readonly score: number;
  readonly factors: {
    readonly recency: number;
    readonly importance: number;
    readonly relevance: number;
  };
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateCap(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EngineError(
      "VALIDATION_FAILED",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnit);
}

function tokenize(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function relevanceScore(memory: Memory, context: MemoryRetrievalContext): number {
  let relevance = 100;
  const references = new Set(memory.references);
  for (const reference of context.referenceIds) {
    if (references.has(reference)) relevance += 200;
  }
  if (context.preferredKinds.includes(memory.kind)) relevance += 150;
  const queryTokens = tokenize(
    context.triggerKind === undefined
      ? context.queryText
      : `${context.triggerKind} ${context.queryText ?? ""}`,
  );
  if (queryTokens.size > 0) {
    const memoryTokens = tokenize(memory.content);
    let matches = 0;
    for (const token of queryTokens) {
      if (memoryTokens.has(token)) matches += 1;
    }
    relevance += Math.min(matches, 10) * 40;
  }
  return relevance;
}

function compactionContent(memories: readonly Memory[]): string {
  const ticks = memories.map((memory) => memory.tick);
  const counts: Record<MemoryKind, number> = {
    event: 0,
    conversation: 0,
    outcome: 0,
    reflection: 0,
  };
  for (const memory of memories) counts[memory.kind] += 1;
  const kinds = (Object.keys(counts) as MemoryKind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${kind}:${counts[kind]}`)
    .join(",");
  return (
    `Deterministic memory summary: ${memories.length} records from ticks ` +
    `${Math.min(...ticks)}-${Math.max(...ticks)} (${kinds}).`
  );
}

export class DeterministicMemoryStore {
  readonly maxActiveMemories: number;
  readonly compactToMemories: number;
  private readonly repository: MemoryRepository;
  private readonly ids: MemoryIdSource;

  constructor(options: MemoryStoreOptions) {
    this.repository = options.repository;
    this.ids = options.ids;
    this.maxActiveMemories = validateCap(
      "maxActiveMemories",
      options.maxActiveMemories ?? 64,
      3,
      10_000,
    );
    this.compactToMemories = validateCap(
      "compactToMemories",
      options.compactToMemories ?? Math.max(2, Math.floor(this.maxActiveMemories * 0.75)),
      2,
      this.maxActiveMemories - 1,
    );
  }

  record(input: MemoryRecordInput): MemoryRecordResult {
    const memory = memorySchema.parse({ ...input, id: this.ids.next("mem") });
    this.repository.append(memory);
    const compaction = this.compact(memory.agentId, memory.tick);
    return compaction === undefined ? { memory } : { memory, compaction };
  }

  retrieve(
    agentId: string,
    contextInput: MemoryRetrievalContext,
    k: number,
  ): readonly RetrievedMemory[] {
    if (!/^agt_[0-9a-z]{8}$/.test(agentId)) {
      throw new EngineError("VALIDATION_FAILED", `invalid agent ID: ${agentId}`);
    }
    if (!Number.isSafeInteger(k) || k < 1 || k > 32) {
      throw new EngineError("VALIDATION_FAILED", "memory retrieval k must be from 1 to 32");
    }
    const context = memoryRetrievalContextSchema.parse(contextInput);
    return this.repository
      .listActive(agentId)
      .filter((memory) => memory.tick <= context.tick)
      .map((memory): RetrievedMemory => {
        const age = context.tick - memory.tick;
        const recency = Math.floor(1_000_000 / (age + 1));
        const relevance = relevanceScore(memory, context);
        return {
          memory,
          score: (memory.importance + 1) * recency * relevance,
          factors: { recency, importance: memory.importance + 1, relevance },
        };
      })
      .sort((left, right) =>
        right.score - left.score ||
        right.memory.importance - left.memory.importance ||
        right.memory.tick - left.memory.tick ||
        compareCodeUnit(left.memory.id, right.memory.id)
      )
      .slice(0, k);
  }

  compact(agentId: string, tick: number): MemoryCompactionResult | undefined {
    const active = [...this.repository.listActive(agentId)];
    if (active.length <= this.maxActiveMemories) return undefined;
    const sourceCount = active.length - this.compactToMemories + 1;
    const sources = active
      .sort((left, right) =>
        left.importance - right.importance ||
        left.tick - right.tick ||
        compareCodeUnit(left.id, right.id)
      )
      .slice(0, sourceCount)
      .sort((left, right) => left.tick - right.tick || compareCodeUnit(left.id, right.id));
    if (sources.length < 2) {
      throw new EngineError("INTERNAL", "memory compaction requires at least two sources");
    }
    const sourceMemoryIds = sources.map((memory) => memory.id);
    const summary = memorySchema.parse({
      id: this.ids.next("mem"),
      runId: sources[0]!.runId,
      agentId,
      tick,
      kind: "reflection",
      content: compactionContent(sources),
      importance: Math.max(...sources.map((memory) => memory.importance)),
      references: sortedUnique(sources.flatMap((memory) => memory.references)).slice(0, 64),
      sourceMemoryIds,
    });
    this.repository.compact(agentId, summary, sourceMemoryIds);
    return Object.freeze({ summary, sourceMemoryIds: Object.freeze(sourceMemoryIds) });
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, Memory>();
  private readonly compactedInto = new Map<string, string>();

  append(memoryInput: Memory): void {
    const memory = memorySchema.parse(memoryInput);
    if (this.records.has(memory.id)) {
      throw new EngineError("CONFLICT", `memory ${memory.id} already exists`);
    }
    this.records.set(memory.id, Object.freeze(memory));
  }

  list(agentId: string): readonly Memory[] {
    return [...this.records.values()]
      .filter((memory) => memory.agentId === agentId)
      .sort((left, right) => left.tick - right.tick || compareCodeUnit(left.id, right.id));
  }

  listActive(agentId: string): readonly Memory[] {
    return this.list(agentId).filter((memory) => !this.compactedInto.has(memory.id));
  }

  compact(agentId: string, summaryInput: Memory, sourceMemoryIds: readonly string[]): void {
    const summary = memorySchema.parse(summaryInput);
    const uniqueSources = sortedUnique(sourceMemoryIds);
    if (
      summary.agentId !== agentId ||
      summary.sourceMemoryIds === undefined ||
      uniqueSources.length < 2 ||
      uniqueSources.length !== sourceMemoryIds.length ||
      summary.sourceMemoryIds.length !== sourceMemoryIds.length ||
      summary.sourceMemoryIds.some((id, index) => id !== sourceMemoryIds[index])
    ) {
      throw new EngineError("VALIDATION_FAILED", "invalid memory compaction relation");
    }
    for (const sourceId of sourceMemoryIds) {
      const source = this.records.get(sourceId);
      if (
        source === undefined ||
        source.agentId !== agentId ||
        this.compactedInto.has(sourceId)
      ) {
        throw new EngineError("CONFLICT", `memory ${sourceId} is not active for compaction`);
      }
    }
    this.append(summary);
    for (const sourceId of sourceMemoryIds) this.compactedInto.set(sourceId, summary.id);
  }
}
