/** SQLite persistence/read model for the Phase 2 agent framework. */

import {
  agentActionSchema,
  agentSchema,
  canonicalParse,
  canonicalStringify,
  decisionSchema,
  EngineError,
  goalSchema,
  householdSchema,
  memorySchema,
  personaSchema,
  relationshipSchema,
  runIdSchema,
} from "@worldtangle/shared";
import type {
  Agent,
  AgentAction,
  AgentQuarantine,
  Decision,
  EmploymentStatus,
  Goal,
  Memory,
  Persona,
  Relationship,
} from "@worldtangle/shared";
import type {
  GoalLifecycleRecord,
  GoalLifecycleRepository,
  MemoryRepository,
  RiverbendPopulation,
} from "@worldtangle/engine";
import { toSafeNumber } from "./database";
import type { WorldDatabase } from "./database";

interface AgentRow {
  id: string;
  run_id: string;
  persona_id: string;
  household_id: string;
  occupation_code: string;
  employment_status: EmploymentStatus;
  credit_score: bigint;
  quarantine_canonical: string;
  alive_flags_canonical: string;
  annual_income_cents: string;
  role_code: string;
  organization_id: string | null;
  segment: "institution" | "business" | "independent";
}

interface AgentPersonaRow extends AgentRow {
  persona_row_id: string;
  persona_agent_id: string;
  name: string;
  age: bigint;
  gender: string | null;
  education: Persona["education"];
  skills_canonical: string;
  personality_canonical: string;
  opinions_canonical: string;
  bio_summary: string;
  prompt_version: bigint;
}

interface GoalRow {
  id: string;
  agent_id: string;
  kind: string;
  params_canonical: string;
  priority: bigint;
  status: Goal["status"];
  activation_rule: string;
  progress_millionths: bigint;
  trigger_event_id: string;
  activated_tick: bigint | null;
  terminal_tick: bigint | null;
}

interface MemoryRow {
  id: string;
  agent_id: string;
  tick: bigint;
  kind: Memory["kind"];
  content: string;
  importance: bigint;
  references_canonical: string;
  source_memory_ids_canonical: string | null;
}

interface RelationshipRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: Relationship["type"];
  strength: bigint;
  last_interaction_tick: bigint;
  target_name?: string;
}

interface DecisionRow {
  id: string;
  tick: bigint;
  decision_canonical: string;
}

export interface AgentDirectoryQuery {
  readonly limit: number;
  readonly afterAgentId?: string;
  readonly occupation?: string;
  readonly employmentStatus?: EmploymentStatus;
  readonly search?: string;
}

export interface AgentDirectoryItem {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly occupation: string;
  readonly employmentStatus: EmploymentStatus;
  readonly householdId: string;
  readonly netWorth: { readonly cents: string };
}

export interface AgentProfileRecord {
  readonly agent: Agent;
  readonly persona: Persona;
  readonly annualIncomeCents: string;
  readonly roleCode: string;
  readonly organizationId: string | null;
  readonly segment: "institution" | "business" | "independent";
  readonly goals: readonly Goal[];
  readonly memoryHighlights: readonly Memory[];
}

export interface RelationshipFeedQuery {
  readonly limit: number;
  readonly type?: Relationship["type"];
  readonly after?: { readonly strength: number; readonly toAgentId: string };
}

export interface RelationshipFeedItem {
  readonly id: string;
  readonly toAgent: { readonly id: string; readonly name: string };
  readonly type: Relationship["type"];
  readonly strength: number;
  readonly lastInteractionTick: number;
}

export interface DecisionFeedQuery {
  readonly limit: number;
  readonly tier?: 1 | 2 | 3;
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly before?: { readonly tick: number; readonly decisionId: string };
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCanonical(text: string, label: string): unknown {
  try {
    const value = canonicalParse(text);
    if (canonicalStringify(value) !== text) throw new Error("value is not canonical");
    return value;
  } catch (error) {
    throw new EngineError("INTERNAL", `persisted ${label} is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function stringArray(text: string, label: string): string[] {
  const value = parseCanonical(text, label);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EngineError("INTERNAL", `persisted ${label} is not a string array`);
  }
  return value;
}

function assertRunId(value: string): void {
  if (!runIdSchema.safeParse(value).success) {
    throw new EngineError("VALIDATION_FAILED", `invalid run ID: ${value}`);
  }
}

function escapeLikePrefix(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") + "%";
}

export class SqliteAgentStore implements MemoryRepository, GoalLifecycleRepository {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {
    assertRunId(runId);
    const run = db.prepare<[string], { id: string }>("SELECT id FROM simulation_runs WHERE id = ?").get(runId);
    if (run === undefined) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);
  }

  insertPopulation(
    population: RiverbendPopulation,
    triggerEventByAgent: ReadonlyMap<string, string>,
  ): void {
    const persist = (): void => {
      this.db.prepare(`
        INSERT INTO world_generations(run_id, world_spec, spec_hash, population_hash, report_canonical)
        VALUES (@runId, @worldSpec, @specHash, @populationHash, @reportCanonical)
      `).run({
        runId: this.runId,
        worldSpec: population.report.worldSpec,
        specHash: population.report.specHash,
        populationHash: population.report.populationHash,
        reportCanonical: canonicalStringify(population.report),
      });

      const insertHousehold = this.db.prepare(`
        INSERT INTO households(
          run_id, id, member_ids_canonical, structure, housing_tier, budget_policy_canonical
        ) VALUES (@runId, @id, @memberIds, @structure, @housingTier, @budgetPolicy)
      `);
      for (const householdInput of population.households) {
        const household = householdSchema.parse(householdInput);
        if (household.runId !== this.runId) throw new EngineError("CONFLICT", "household belongs to another run");
        insertHousehold.run({
          runId: this.runId,
          id: household.id,
          memberIds: canonicalStringify(household.memberAgentIds),
          structure: household.structure,
          housingTier: household.housingTier,
          budgetPolicy: canonicalStringify(household.budgetPolicy),
        });
      }

      const insertAgent = this.db.prepare(`
        INSERT INTO agents(
          run_id, id, persona_id, household_id, occupation_code, employment_status,
          credit_score, quarantine_canonical, alive_flags_canonical, annual_income_cents,
          role_code, organization_id, segment
        ) VALUES (
          @runId, @id, @personaId, @householdId, @occupationCode, @employmentStatus,
          @creditScore, @quarantine, @aliveFlags, @annualIncomeCents,
          @roleCode, @organizationId, @segment
        )
      `);
      const insertPersona = this.db.prepare(`
        INSERT INTO personas(
          run_id, id, agent_id, name, age, gender, education, skills_canonical,
          personality_canonical, opinions_canonical, bio_summary, prompt_version
        ) VALUES (
          @runId, @id, @agentId, @name, @age, @gender, @education, @skills,
          @personality, @opinions, @bioSummary, @promptVersion
        )
      `);
      for (const resident of population.residents) {
        const agent = agentSchema.parse(resident.agent);
        const persona = personaSchema.parse(resident.persona);
        if (agent.runId !== this.runId || persona.agentId !== agent.id || persona.id !== agent.personaId) {
          throw new EngineError("CONFLICT", "resident identity does not match the run");
        }
        insertAgent.run({
          runId: this.runId,
          id: agent.id,
          personaId: agent.personaId,
          householdId: agent.householdId,
          occupationCode: agent.occupationCode,
          employmentStatus: agent.employmentStatus,
          creditScore: agent.creditScore,
          quarantine: canonicalStringify(agent.quarantine),
          aliveFlags: canonicalStringify(agent.aliveFlags),
          annualIncomeCents: resident.annualIncomeCents,
          roleCode: resident.roleCode,
          organizationId: resident.organizationId,
          segment: resident.segment,
        });
        insertPersona.run({
          runId: this.runId,
          id: persona.id,
          agentId: persona.agentId,
          name: persona.name,
          age: persona.age,
          gender: persona.gender ?? null,
          education: persona.education,
          skills: canonicalStringify(persona.skills),
          personality: canonicalStringify(persona.personality),
          opinions: canonicalStringify(persona.opinions),
          bioSummary: persona.bioSummary,
          promptVersion: persona.promptVersion,
        });
      }

      const insertGoal = this.db.prepare(`
        INSERT INTO goals(
          run_id, id, agent_id, kind, params_canonical, priority, status,
          activation_rule, progress_millionths, trigger_event_id, activated_tick, terminal_tick
        ) VALUES (
          @runId, @id, @agentId, @kind, @params, @priority, @status,
          @activationRule, @progress, @triggerEventId, @activatedTick, NULL
        )
      `);
      for (const goalInput of population.goals) {
        const goal = goalSchema.parse(goalInput);
        const triggerEventId = triggerEventByAgent.get(goal.agentId);
        if (triggerEventId === undefined) {
          throw new EngineError("CONFLICT", `missing initial trigger event for ${goal.agentId}`);
        }
        insertGoal.run({
          runId: this.runId,
          id: goal.id,
          agentId: goal.agentId,
          kind: goal.kind,
          params: canonicalStringify(goal.params),
          priority: goal.priority,
          status: goal.status,
          activationRule: goal.activationRule,
          progress: Math.round(goal.progress * 1_000_000),
          triggerEventId,
          activatedTick: goal.status === "active" ? 0 : null,
        });
      }

      const insertRelationship = this.db.prepare(`
        INSERT INTO relationships(
          run_id, id, from_agent_id, to_agent_id, type, strength, last_interaction_tick
        ) VALUES (@runId, @id, @fromAgentId, @toAgentId, @type, @strength, @lastInteractionTick)
      `);
      for (const relationshipInput of population.relationships) {
        const relationship = relationshipSchema.parse(relationshipInput);
        if (relationship.runId !== this.runId) throw new EngineError("CONFLICT", "relationship belongs to another run");
        insertRelationship.run({
          runId: this.runId,
          id: relationship.id,
          fromAgentId: relationship.fromAgentId,
          toAgentId: relationship.toAgentId,
          type: relationship.type,
          strength: relationship.strength,
          lastInteractionTick: relationship.lastInteractionTick,
        });
      }

      const insertAccount = this.db.prepare(`
        INSERT INTO opening_accounts(run_id, id, owner_kind, owner_id, account_type, balance_cents)
        VALUES (@runId, @id, @ownerKind, @ownerId, @accountType, @balanceCents)
      `);
      for (const account of population.accounts) {
        if (account.runId !== this.runId) throw new EngineError("CONFLICT", "account belongs to another run");
        insertAccount.run({ ...account, runId: this.runId });
      }
      const insertMint = this.db.prepare(`
        INSERT INTO opening_mint_transactions(run_id, id, account_id, amount_cents, kind)
        VALUES (@runId, @id, @accountId, @amountCents, @kind)
      `);
      for (const mint of population.mintTransactions) {
        if (mint.runId !== this.runId) throw new EngineError("CONFLICT", "mint belongs to another run");
        insertMint.run({ ...mint, runId: this.runId });
      }
      const insertLoan = this.db.prepare(`
        INSERT INTO seed_loans(
          run_id, id, borrower_kind, borrower_id, status, outstanding_principal_cents, loan_canonical
        ) VALUES (@runId, @id, @borrowerKind, @borrowerId, @status, @outstanding, @loan)
      `);
      for (const loan of population.loans) {
        if (loan.runId !== this.runId) throw new EngineError("CONFLICT", "loan belongs to another run");
        insertLoan.run({
          runId: this.runId,
          id: loan.id,
          borrowerKind: loan.borrowerKind,
          borrowerId: loan.borrowerId,
          status: loan.status,
          outstanding: loan.outstandingPrincipalCents,
          loan: canonicalStringify(loan),
        });
      }
    };
    this.db.transaction(persist).immediate();
  }

  hasPopulation(): boolean {
    return this.db.prepare<[string], { run_id: string }>(
      "SELECT run_id FROM world_generations WHERE run_id = ?",
    ).get(this.runId) !== undefined;
  }

  populationReport(): unknown {
    const row = this.db.prepare<[string], { report_canonical: string }>(
      "SELECT report_canonical FROM world_generations WHERE run_id = ?",
    ).get(this.runId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `run ${this.runId} has no population`);
    return parseCanonical(row.report_canonical, "world generation report");
  }

  listAgentEntities(): readonly Agent[] {
    return this.db.prepare<[string], AgentRow>(`
      SELECT * FROM agents WHERE run_id = ? ORDER BY id ASC
    `).all(this.runId).map((row) => this.mapAgent(row));
  }

  listAgents(query: AgentDirectoryQuery): readonly AgentDirectoryItem[] {
    const conditions = ["a.run_id = @runId"];
    const params: Record<string, string | number> = { runId: this.runId, limit: query.limit };
    if (query.afterAgentId !== undefined) {
      conditions.push("a.id > @afterAgentId");
      params["afterAgentId"] = query.afterAgentId;
    }
    if (query.occupation !== undefined) {
      conditions.push("a.occupation_code = @occupation");
      params["occupation"] = query.occupation;
    }
    if (query.employmentStatus !== undefined) {
      conditions.push("a.employment_status = @employmentStatus");
      params["employmentStatus"] = query.employmentStatus;
    }
    if (query.search !== undefined) {
      conditions.push("lower(p.name) LIKE @search ESCAPE '\\'");
      params["search"] = escapeLikePrefix(query.search.toLowerCase());
    }
    const rows = this.db.prepare<Record<string, string | number>, AgentPersonaRow>(`
      SELECT
        a.*, p.id AS persona_row_id, p.agent_id AS persona_agent_id,
        p.name, p.age, p.gender, p.education, p.skills_canonical,
        p.personality_canonical, p.opinions_canonical, p.bio_summary, p.prompt_version,
        p.agent_id
      FROM agents a
      JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.id ASC
      LIMIT @limit
    `).all(params);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      age: toSafeNumber(row.age, "persona age"),
      occupation: row.occupation_code,
      employmentStatus: row.employment_status,
      householdId: row.household_id,
      netWorth: { cents: this.netWorthCents(row.id) },
    }));
  }

  getProfile(agentId: string, memoryLimit = 5): AgentProfileRecord {
    const row = this.db.prepare<[string, string], AgentPersonaRow>(`
      SELECT
        a.*, p.id AS persona_row_id, p.agent_id AS persona_agent_id,
        p.name, p.age, p.gender, p.education, p.skills_canonical,
        p.personality_canonical, p.opinions_canonical, p.bio_summary, p.prompt_version,
        p.agent_id
      FROM agents a
      JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
      WHERE a.run_id = ? AND a.id = ?
    `).get(this.runId, agentId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
    return {
      agent: this.mapAgent(row),
      persona: this.mapPersona(row),
      annualIncomeCents: row.annual_income_cents,
      roleCode: row.role_code,
      organizationId: row.organization_id,
      segment: row.segment,
      goals: this.listByAgent(agentId).map((record) => record.goal),
      memoryHighlights: [...this.listActive(agentId)]
        .sort((left, right) => right.tick - left.tick || compareCodeUnit(right.id, left.id))
        .slice(0, memoryLimit),
    };
  }

  listRelationships(agentId: string, query: RelationshipFeedQuery): readonly RelationshipFeedItem[] {
    this.getProfile(agentId, 0);
    const conditions = ["r.run_id = @runId", "r.from_agent_id = @agentId"];
    const params: Record<string, string | number> = {
      runId: this.runId,
      agentId,
      limit: query.limit,
    };
    if (query.type !== undefined) {
      conditions.push("r.type = @type");
      params["type"] = query.type;
    }
    if (query.after !== undefined) {
      conditions.push("(r.strength < @afterStrength OR (r.strength = @afterStrength AND r.to_agent_id > @afterAgentId))");
      params["afterStrength"] = query.after.strength;
      params["afterAgentId"] = query.after.toAgentId;
    }
    return this.db.prepare<Record<string, string | number>, RelationshipRow>(`
      SELECT r.*, p.name AS target_name
      FROM relationships r
      JOIN personas p ON p.run_id = r.run_id AND p.agent_id = r.to_agent_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.strength DESC, r.to_agent_id ASC
      LIMIT @limit
    `).all(params).map((row) => ({
      id: row.id,
      toAgent: { id: row.to_agent_id, name: row.target_name! },
      type: row.type,
      strength: toSafeNumber(row.strength, "relationship strength"),
      lastInteractionTick: toSafeNumber(row.last_interaction_tick, "relationship tick"),
    }));
  }

  saveDecisionResult(
    decisionsInput: readonly Decision[],
    actionsInput: readonly AgentAction[],
  ): void {
    this.db.transaction(() => {
      const insertDecision = this.db.prepare(`
        INSERT INTO decisions(run_id, id, agent_id, tick, tier, decision_canonical)
        VALUES (@runId, @id, @agentId, @tick, @tier, @canonical)
      `);
      for (const input of decisionsInput) {
        const decision = decisionSchema.parse(input);
        if (decision.runId !== this.runId) throw new EngineError("CONFLICT", "decision belongs to another run");
        insertDecision.run({
          runId: this.runId,
          id: decision.id,
          agentId: decision.agentId,
          tick: decision.tick,
          tier: decision.tier,
          canonical: canonicalStringify(decision),
        });
      }
      const insertAction = this.db.prepare(`
        INSERT INTO agent_actions(run_id, id, decision_id, actor_id, type, status, action_canonical)
        VALUES (@runId, @id, @decisionId, @actorId, @type, @status, @canonical)
      `);
      for (const input of actionsInput) {
        const action = agentActionSchema.parse(input);
        if (action.runId !== this.runId) throw new EngineError("CONFLICT", "action belongs to another run");
        insertAction.run({
          runId: this.runId,
          id: action.id,
          decisionId: action.decisionId ?? null,
          actorId: action.actorId,
          type: action.type,
          status: action.status,
          canonical: canonicalStringify(action),
        });
      }
    }).immediate();
  }

  listDecisions(agentId: string, query: DecisionFeedQuery): readonly Decision[] {
    this.getProfile(agentId, 0);
    const conditions = ["run_id = @runId", "agent_id = @agentId"];
    const params: Record<string, string | number> = {
      runId: this.runId,
      agentId,
      limit: query.limit,
    };
    if (query.tier !== undefined) {
      conditions.push("tier = @tier");
      params["tier"] = query.tier;
    }
    if (query.fromTick !== undefined) {
      conditions.push("tick >= @fromTick");
      params["fromTick"] = query.fromTick;
    }
    if (query.toTick !== undefined) {
      conditions.push("tick <= @toTick");
      params["toTick"] = query.toTick;
    }
    if (query.before !== undefined) {
      conditions.push("(tick < @beforeTick OR (tick = @beforeTick AND id < @beforeId))");
      params["beforeTick"] = query.before.tick;
      params["beforeId"] = query.before.decisionId;
    }
    return this.db.prepare<Record<string, string | number>, DecisionRow>(`
      SELECT id, tick, decision_canonical
      FROM decisions
      WHERE ${conditions.join(" AND ")}
      ORDER BY tick DESC, id DESC
      LIMIT @limit
    `).all(params).map((row) => decisionSchema.parse(
      parseCanonical(row.decision_canonical, `decision ${row.id}`),
    ));
  }

  listActions(): readonly AgentAction[] {
    return this.db.prepare<[string], { id: string; action_canonical: string }>(`
      SELECT id, action_canonical FROM agent_actions WHERE run_id = ? ORDER BY id ASC
    `).all(this.runId).map((row) => agentActionSchema.parse(
      parseCanonical(row.action_canonical, `agent action ${row.id}`),
    ));
  }

  setAgentQuarantine(agentId: string, quarantine: AgentQuarantine): void {
    const updated = this.db.prepare(`
      UPDATE agents SET quarantine_canonical = @quarantine
      WHERE run_id = @runId AND id = @agentId
    `).run({ runId: this.runId, agentId, quarantine: canonicalStringify(quarantine) });
    if (updated.changes !== 1) throw new EngineError("NOT_FOUND", `agent ${agentId} does not exist`);
  }

  append(memoryInput: Memory): void {
    const memory = memorySchema.parse(memoryInput);
    if (memory.runId !== this.runId) throw new EngineError("CONFLICT", "memory belongs to another run");
    this.db.prepare(`
      INSERT INTO memories(
        run_id, id, agent_id, tick, kind, content, importance,
        references_canonical, source_memory_ids_canonical
      ) VALUES (
        @runId, @id, @agentId, @tick, @kind, @content, @importance,
        @references, @sourceMemoryIds
      )
    `).run({
      runId: this.runId,
      id: memory.id,
      agentId: memory.agentId,
      tick: memory.tick,
      kind: memory.kind,
      content: memory.content,
      importance: memory.importance,
      references: canonicalStringify(memory.references),
      sourceMemoryIds: memory.sourceMemoryIds === undefined
        ? null
        : canonicalStringify(memory.sourceMemoryIds),
    });
  }

  list(agentId: string): readonly Memory[] {
    return this.db.prepare<[string, string], MemoryRow>(`
      SELECT id, agent_id, tick, kind, content, importance,
             references_canonical, source_memory_ids_canonical
      FROM memories
      WHERE run_id = ? AND agent_id = ?
      ORDER BY tick ASC, id ASC
    `).all(this.runId, agentId).map((row) => this.mapMemory(row));
  }

  listActive(agentId: string): readonly Memory[] {
    return this.db.prepare<[string, string], MemoryRow>(`
      SELECT m.id, m.agent_id, m.tick, m.kind, m.content, m.importance,
             m.references_canonical, m.source_memory_ids_canonical
      FROM memories m
      LEFT JOIN memory_compactions c
        ON c.run_id = m.run_id AND c.source_memory_id = m.id
      WHERE m.run_id = ? AND m.agent_id = ? AND c.source_memory_id IS NULL
      ORDER BY m.tick ASC, m.id ASC
    `).all(this.runId, agentId).map((row) => this.mapMemory(row));
  }

  compact(agentId: string, summaryInput: Memory, sourceMemoryIds: readonly string[]): void {
    const summary = memorySchema.parse(summaryInput);
    if (
      summary.agentId !== agentId ||
      summary.runId !== this.runId ||
      summary.sourceMemoryIds === undefined ||
      sourceMemoryIds.length < 2 ||
      new Set(sourceMemoryIds).size !== sourceMemoryIds.length ||
      summary.sourceMemoryIds.length !== sourceMemoryIds.length ||
      summary.sourceMemoryIds.some((id, index) => id !== sourceMemoryIds[index])
    ) {
      throw new EngineError("VALIDATION_FAILED", "invalid memory compaction relation");
    }
    this.db.transaction(() => {
      for (const sourceId of sourceMemoryIds) {
        const row = this.db.prepare<[string, string, string], { id: string }>(`
          SELECT m.id
          FROM memories m
          LEFT JOIN memory_compactions c
            ON c.run_id = m.run_id AND c.source_memory_id = m.id
          WHERE m.run_id = ? AND m.agent_id = ? AND m.id = ? AND c.source_memory_id IS NULL
        `).get(this.runId, agentId, sourceId);
        if (row === undefined) {
          throw new EngineError("CONFLICT", `memory ${sourceId} is not active for compaction`);
        }
      }
      this.append(summary);
      const insert = this.db.prepare(`
        INSERT INTO memory_compactions(run_id, agent_id, source_memory_id, summary_memory_id)
        VALUES (@runId, @agentId, @sourceId, @summaryId)
      `);
      for (const sourceId of sourceMemoryIds) {
        insert.run({ runId: this.runId, agentId, sourceId, summaryId: summary.id });
      }
    }).immediate();
  }

  get(goalId: string): GoalLifecycleRecord | null {
    const row = this.db.prepare<[string, string], GoalRow>(`
      SELECT id, agent_id, kind, params_canonical, priority, status,
             activation_rule, progress_millionths, trigger_event_id,
             activated_tick, terminal_tick
      FROM goals WHERE run_id = ? AND id = ?
    `).get(this.runId, goalId);
    return row === undefined ? null : this.mapGoal(row);
  }

  listByAgent(agentId: string): readonly GoalLifecycleRecord[] {
    return this.db.prepare<[string, string], GoalRow>(`
      SELECT id, agent_id, kind, params_canonical, priority, status,
             activation_rule, progress_millionths, trigger_event_id,
             activated_tick, terminal_tick
      FROM goals WHERE run_id = ? AND agent_id = ? ORDER BY id ASC
    `).all(this.runId, agentId).map((row) => this.mapGoal(row));
  }

  transition(previous: GoalLifecycleRecord, next: GoalLifecycleRecord): void {
    const previousGoal = goalSchema.parse(previous.goal);
    const nextGoal = goalSchema.parse(next.goal);
    if (
      previousGoal.id !== nextGoal.id ||
      previousGoal.agentId !== nextGoal.agentId ||
      previousGoal.kind !== nextGoal.kind ||
      canonicalStringify(previousGoal.params) !== canonicalStringify(nextGoal.params) ||
      previousGoal.priority !== nextGoal.priority ||
      previousGoal.activationRule !== nextGoal.activationRule
    ) {
      throw new EngineError("VALIDATION_FAILED", "goal identity is immutable");
    }
    const updated = this.db.prepare(`
      UPDATE goals
      SET status = @nextStatus,
          progress_millionths = @nextProgress,
          trigger_event_id = @nextTriggerEventId,
          activated_tick = @nextActivatedTick,
          terminal_tick = @nextTerminalTick
      WHERE run_id = @runId AND id = @id
        AND status = @previousStatus
        AND progress_millionths = @previousProgress
        AND trigger_event_id = @previousTriggerEventId
        AND ((activated_tick IS NULL AND @previousActivatedTick IS NULL) OR activated_tick = @previousActivatedTick)
        AND ((terminal_tick IS NULL AND @previousTerminalTick IS NULL) OR terminal_tick = @previousTerminalTick)
    `).run({
      runId: this.runId,
      id: previousGoal.id,
      previousStatus: previousGoal.status,
      previousProgress: Math.round(previousGoal.progress * 1_000_000),
      previousTriggerEventId: previous.triggerEventId,
      previousActivatedTick: previous.activatedTick,
      previousTerminalTick: previous.terminalTick,
      nextStatus: nextGoal.status,
      nextProgress: Math.round(nextGoal.progress * 1_000_000),
      nextTriggerEventId: next.triggerEventId,
      nextActivatedTick: next.activatedTick,
      nextTerminalTick: next.terminalTick,
    });
    if (updated.changes !== 1) throw new EngineError("CONFLICT", `stale goal transition for ${previousGoal.id}`);
  }

  private netWorthCents(agentId: string): string {
    const balances = this.db.prepare<[string, string], { balance_cents: string }>(`
      SELECT balance_cents FROM opening_accounts
      WHERE run_id = ? AND owner_kind = 'agent' AND owner_id = ?
    `).all(this.runId, agentId);
    const debts = this.db.prepare<[string, string], { outstanding_principal_cents: string }>(`
      SELECT outstanding_principal_cents FROM seed_loans
      WHERE run_id = ? AND borrower_kind = 'agent' AND borrower_id = ?
    `).all(this.runId, agentId);
    const assets = balances.reduce((sum, row) => sum + BigInt(row.balance_cents), 0n);
    const liabilities = debts.reduce((sum, row) => sum + BigInt(row.outstanding_principal_cents), 0n);
    return (assets - liabilities).toString();
  }

  private mapAgent(row: AgentRow): Agent {
    return agentSchema.parse({
      id: row.id,
      runId: row.run_id,
      personaId: row.persona_id,
      householdId: row.household_id,
      occupationCode: row.occupation_code,
      employmentStatus: row.employment_status,
      creditScore: toSafeNumber(row.credit_score, "agent credit score"),
      quarantine: parseCanonical(row.quarantine_canonical, `agent ${row.id} quarantine`),
      aliveFlags: parseCanonical(row.alive_flags_canonical, `agent ${row.id} alive flags`),
    });
  }

  private mapPersona(row: AgentPersonaRow): Persona {
    return personaSchema.parse({
      id: row.persona_row_id,
      agentId: row.persona_agent_id,
      name: row.name,
      age: toSafeNumber(row.age, "persona age"),
      ...(row.gender === null ? {} : { gender: row.gender }),
      education: row.education,
      skills: parseCanonical(row.skills_canonical, `persona ${row.persona_row_id} skills`),
      personality: parseCanonical(row.personality_canonical, `persona ${row.persona_row_id} personality`),
      opinions: parseCanonical(row.opinions_canonical, `persona ${row.persona_row_id} opinions`),
      bioSummary: row.bio_summary,
      promptVersion: toSafeNumber(row.prompt_version, "persona prompt version"),
    });
  }

  private mapMemory(row: MemoryRow): Memory {
    return memorySchema.parse({
      id: row.id,
      runId: this.runId,
      agentId: row.agent_id,
      tick: toSafeNumber(row.tick, "memory tick"),
      kind: row.kind,
      content: row.content,
      importance: toSafeNumber(row.importance, "memory importance"),
      references: stringArray(row.references_canonical, `memory ${row.id} references`),
      ...(row.source_memory_ids_canonical === null
        ? {}
        : { sourceMemoryIds: stringArray(row.source_memory_ids_canonical, `memory ${row.id} sources`) }),
    });
  }

  private mapGoal(row: GoalRow): GoalLifecycleRecord {
    return Object.freeze({
      goal: goalSchema.parse({
        id: row.id,
        agentId: row.agent_id,
        kind: row.kind,
        params: parseCanonical(row.params_canonical, `goal ${row.id} params`),
        priority: toSafeNumber(row.priority, "goal priority"),
        status: row.status,
        activationRule: row.activation_rule,
        progress: toSafeNumber(row.progress_millionths, "goal progress") / 1_000_000,
      }),
      triggerEventId: row.trigger_event_id,
      activatedTick: row.activated_tick === null ? null : toSafeNumber(row.activated_tick, "goal activated tick"),
      terminalTick: row.terminal_tick === null ? null : toSafeNumber(row.terminal_tick, "goal terminal tick"),
    });
  }
}
