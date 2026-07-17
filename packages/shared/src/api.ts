/** Versioned HTTP request/response contracts shared by the server and clients. */

import { z } from "zod";
import {
  eventEnvelopeSchema,
  LLM_MODES,
  runManifestSchema,
  SIM_DATE_PATTERN,
  TYPE_NAME_PATTERN,
} from "./envelope";
import {
  runIdSchema,
  runStatusSchema,
  simulationIdSchema,
  simulationStatusSchema,
} from "./simulation";
import {
  agentIdSchema,
  educationLevelSchema,
  employmentStatusSchema,
  goalSchema,
  occupationCodeSchema,
  opinionAxesSchema,
  personalitySchema,
  relationshipTypeSchema,
  skillCodeSchema,
} from "./agent";
import { decisionTierSchema, triggerKindSchema } from "./decision";
import { memoryKindSchema } from "./memory";
import { worldEventSchema } from "./world-event";
import {
  llmDegradationTierSchema,
  llmModuleIdSchema,
} from "./llm-control";
import { replayRunSchema } from "./replay";
import { exportJobSchema } from "./export";

const positiveIntegerQuery = z.coerce.number().int().positive().safe();
const nonnegativeIntegerQuery = z.coerce.number().int().nonnegative().safe();

export const apiMetaSchema = z.object({
  simulated: z.literal(true),
  apiVersion: z.literal(1),
});

export const apiRootResponseSchema = z.object({
  name: z.literal("WorldTangle"),
  simulated: z.literal(true),
  apiVersion: z.literal(1),
  engineVersion: z.string().min(1),
  eventSchemaVersion: z.number().int().positive(),
  rulesetVersion: z.number().int().positive(),
  promptPackVersion: z.number().int().positive(),
  links: z.object({
    health: z.literal("/api/v1/health"),
    version: z.literal("/api/v1/version"),
    simulations: z.literal("/api/v1/simulations"),
  }).strict(),
}).strict();
export type ApiRootResponse = z.infer<typeof apiRootResponseSchema>;

export const scenarioBudgetSchema = z
  .object({
    runCostCentsMax: z.string().regex(/^[1-9]\d*$/),
    perAgentDailyTokens: z.number().int().positive().safe(),
  })
  .strict();

export const createSimulationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scenario: z
      .object({
        worldSpec: z.string().regex(/^[a-z0-9][a-z0-9_-]*@[1-9]\d*$/),
        seed: z.number().int().safe(),
        llmMode: z.enum(LLM_MODES),
        budgets: scenarioBudgetSchema,
        policyOverrides: z.record(z.string(), z.number().int().safe()),
        endTick: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict();
export type CreateSimulationRequest = z.infer<typeof createSimulationRequestSchema>;

export const runSelectionRequestSchema = z
  .object({
    runId: runIdSchema.optional(),
  })
  .strict();
export type RunSelectionRequest = z.infer<typeof runSelectionRequestSchema>;

export const advanceSimulationRequestSchema = runSelectionRequestSchema.extend({
  ticks: z.number().int().min(1).max(1_000).safe(),
});
export type AdvanceSimulationRequest = z.infer<typeof advanceSimulationRequestSchema>;

export const simulationPathSchema = z.object({ simId: simulationIdSchema }).strict();
export const agentPathSchema = z.object({
  simId: simulationIdSchema,
  agentId: agentIdSchema,
}).strict();

export const agentListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  occupation: occupationCodeSchema.optional(),
  employmentStatus: employmentStatusSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;

export const relationshipListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  type: relationshipTypeSchema.optional(),
}).strict();
export type RelationshipListQuery = z.infer<typeof relationshipListQuerySchema>;

export const agentDecisionListQuerySchema = z.object({
  runId: runIdSchema.optional(),
  limit: positiveIntegerQuery.max(200).default(50),
  cursor: z.string().min(1).optional(),
  tier: z.coerce.number().pipe(decisionTierSchema).optional(),
  fromTick: nonnegativeIntegerQuery.optional(),
  toTick: nonnegativeIntegerQuery.optional(),
}).strict().refine(
  (query) => query.fromTick === undefined || query.toTick === undefined || query.fromTick <= query.toTick,
  { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
);
export type AgentDecisionListQuery = z.infer<typeof agentDecisionListQuerySchema>;

export const simulationListQuerySchema = z
  .object({
    limit: positiveIntegerQuery.max(200).default(50),
    cursor: z.string().min(1).optional(),
    status: simulationStatusSchema.optional(),
  })
  .strict();
export type SimulationListQuery = z.infer<typeof simulationListQuerySchema>;

export const eventListQuerySchema = z
  .object({
    runId: runIdSchema.optional(),
    limit: positiveIntegerQuery.max(200).default(50),
    cursor: z.string().min(1).optional(),
    type: z.string().regex(TYPE_NAME_PATTERN).optional(),
    fromTick: nonnegativeIntegerQuery.optional(),
    toTick: nonnegativeIntegerQuery.optional(),
    actorId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    causationId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.fromTick === undefined ||
      query.toTick === undefined ||
      query.fromTick <= query.toTick,
    { path: ["toTick"], message: "toTick must be greater than or equal to fromTick" },
  );
export type EventListQuery = z.infer<typeof eventListQuerySchema>;

export const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);
export const opaqueCursorSchema = z.string().min(1).nullable();
const spendSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    costCentsEstimate: z.string().regex(/^\d+$/),
  })
  .strict();
const runStateSchema = z
  .object({
    id: runIdSchema,
    status: runStatusSchema,
    currentTick: z.number().int().nonnegative().safe(),
  })
  .strict();

export const createSimulationResponseSchema = z
  .object({
    simulation: z
      .object({
        id: simulationIdSchema,
        name: z.string().min(1),
        status: z.literal("created"),
        createdAt: z.string().min(1),
      })
      .strict(),
    run: runStateSchema
      .extend({
        status: z.literal("created"),
        manifest: runManifestSchema,
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();
export type CreateSimulationResponse = z.infer<typeof createSimulationResponseSchema>;

export const simulationListResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: simulationIdSchema,
          name: z.string().min(1),
          status: simulationStatusSchema,
          latestRun: runStateSchema,
          createdAt: z.string().min(1),
        })
        .strict(),
    ),
    nextCursor: opaqueCursorSchema,
    meta: apiMetaSchema,
  })
  .strict();
export type SimulationListResponse = z.infer<typeof simulationListResponseSchema>;

export const simulationDetailResponseSchema = z
  .object({
    simulation: z
      .object({
        id: simulationIdSchema,
        name: z.string().min(1),
        status: simulationStatusSchema,
        scenarioVersion: z.number().int().positive().safe(),
        scenario: z.record(z.string(), z.unknown()),
        createdAt: z.string().min(1),
      })
      .strict(),
    runs: z.array(
      runStateSchema
        .extend({
          seed: z.number().int().safe(),
          startedAt: z.string().min(1).nullable(),
          endedAt: z.string().min(1).nullable(),
          spend: spendSchema,
        })
        .strict(),
    ),
    meta: apiMetaSchema,
  })
  .strict();
export type SimulationDetailResponse = z.infer<typeof simulationDetailResponseSchema>;

export const controlSimulationResponseSchema = z
  .object({
    run: runStateSchema,
    commandEventId: eventIdSchema,
    meta: apiMetaSchema,
  })
  .strict();
export type ControlSimulationResponse = z.infer<typeof controlSimulationResponseSchema>;

export const replaySimulationResponseSchema = z.object({
  replayRun: replayRunSchema,
  meta: apiMetaSchema,
}).strict();
export type ReplaySimulationResponse = z.infer<typeof replaySimulationResponseSchema>;

export const createExportResponseSchema = z.object({
  export: exportJobSchema,
  meta: apiMetaSchema,
}).strict();
export type CreateExportResponse = z.infer<typeof createExportResponseSchema>;

export const getExportResponseSchema = z.object({
  export: exportJobSchema,
  meta: apiMetaSchema,
}).strict();
export type GetExportResponse = z.infer<typeof getExportResponseSchema>;

export const injectWorldEventResponseSchema = z.object({
  worldEvent: worldEventSchema,
  commandEventId: eventIdSchema,
  meta: apiMetaSchema,
}).strict();
export type InjectWorldEventResponse = z.infer<typeof injectWorldEventResponseSchema>;

const synchronousAdvanceResponseSchema = z
  .object({
    run: z
      .object({
        currentTick: z.number().int().nonnegative().safe(),
        status: runStatusSchema,
      })
      .strict(),
    tickResults: z
      .object({
        executed: z.number().int().positive().safe(),
        events: z.number().int().nonnegative().safe(),
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();

const asynchronousAdvanceResponseSchema = z
  .object({
    taskId: z.string().regex(/^task_[0-9a-z]{8,}$/),
    poll: z.string().min(1),
    meta: apiMetaSchema,
  })
  .strict();

export const advanceSimulationResponseSchema = z.union([
  synchronousAdvanceResponseSchema,
  asynchronousAdvanceResponseSchema,
]);
export type AdvanceSimulationResponse = z.infer<typeof advanceSimulationResponseSchema>;

export const simulationStatusResponseSchema = z
  .object({
    run: runStateSchema
      .extend({
        simDate: z.string().regex(SIM_DATE_PATTERN),
        endTick: z.number().int().positive().safe(),
      })
      .strict(),
    tickRate: z.object({ ticksPerSec: z.number().nonnegative() }).strict(),
    llm: z
      .object({
        mode: z.enum(LLM_MODES),
        spend: spendSchema,
        budgetPct: z.number().min(0).max(100),
        cacheHitRate: z.number().min(0).max(1),
        enabled: z.boolean(),
        effectiveTier: llmDegradationTierSchema,
        autoPaused: z.boolean(),
        frozenModules: z.array(llmModuleIdSchema),
        limits: scenarioBudgetSchema,
      })
      .strict(),
    errors: z.object({ last24Ticks: z.number().int().nonnegative().safe() }).strict(),
    replay: replayRunSchema.nullable().optional(),
    task: z
      .object({
        id: z.string().regex(/^task_[0-9a-z]{8,}$/),
        kind: z.literal("advance"),
        status: z.enum(["pending", "running", "completed", "failed"]),
        startTick: z.number().int().nonnegative().safe(),
        targetTick: z.number().int().positive().safe(),
        completedTicks: z.number().int().nonnegative().safe(),
        errorText: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    meta: apiMetaSchema,
  })
  .strict();
export type SimulationStatusResponse = z.infer<typeof simulationStatusResponseSchema>;

export const eventListResponseSchema = z
  .object({
    items: z.array(eventEnvelopeSchema),
    nextCursor: opaqueCursorSchema,
    meta: apiMetaSchema,
  })
  .strict();
export type EventListResponse = z.infer<typeof eventListResponseSchema>;

export const centsObjectSchema = z.object({ cents: z.string().regex(/^-?\d+$/) }).strict();

export const agentDirectoryItemSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1).max(120),
  age: z.number().int().min(16).max(100),
  occupation: occupationCodeSchema,
  employmentStatus: employmentStatusSchema,
  householdId: z.string().regex(/^hh_[0-9a-z]{8}$/),
  netWorth: centsObjectSchema,
}).strict();

export const agentListResponseSchema = z.object({
  items: z.array(agentDirectoryItemSchema),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

const profileMemorySchema = z.object({
  id: z.string().regex(/^mem_[0-9a-z]{8}$/),
  tick: z.number().int().nonnegative().safe(),
  kind: memoryKindSchema,
  content: z.string().min(1).max(2_000),
  importance: z.number().int().min(0).max(100),
  references: z.array(z.string().regex(/^evt_[0-9a-z]{8,}$/)).max(64),
}).strict();

const profileQuarantineSchema = z.object({
  mode: z.literal("tier1_only"),
  untilTick: z.number().int().nonnegative().safe(),
  consecutiveFailures: z.number().int().positive().safe(),
}).strict();

export const agentProfileResponseSchema = z.object({
  agent: z.object({
    id: agentIdSchema,
    name: z.string().min(1).max(120),
    age: z.number().int().min(16).max(100),
    gender: z.string().min(1).max(40).optional(),
    education: educationLevelSchema,
    occupation: occupationCodeSchema,
    employmentStatus: employmentStatusSchema,
    householdId: z.string().regex(/^hh_[0-9a-z]{8}$/),
    creditScore: z.number().int().min(300).max(850),
    personality: personalitySchema,
    opinions: opinionAxesSchema,
    goals: z.array(goalSchema),
    skills: z.record(skillCodeSchema, z.number().int().min(0).max(100)),
    bioSummary: z.string().min(1).max(1_000),
    promptVersion: z.number().int().positive().safe(),
    quarantine: profileQuarantineSchema.nullable(),
    annualIncome: centsObjectSchema,
    roleCode: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    organizationId: z.string().min(1).nullable(),
    memoryHighlights: z.array(profileMemorySchema).max(10),
  }).strict(),
  meta: apiMetaSchema,
}).strict();
export type AgentProfileResponse = z.infer<typeof agentProfileResponseSchema>;

export const relationshipListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().regex(/^rel_[0-9a-z]{8}$/),
    toAgent: z.object({ id: agentIdSchema, name: z.string().min(1).max(120) }).strict(),
    type: relationshipTypeSchema,
    strength: z.number().int().min(-100).max(100),
    lastInteractionTick: z.number().int().nonnegative().safe(),
  }).strict()),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();
export type RelationshipListResponse = z.infer<typeof relationshipListResponseSchema>;

export const agentDecisionListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().regex(/^dec_[0-9a-z]{8}$/),
    tick: z.number().int().positive().safe(),
    trigger: z.object({
      kind: triggerKindSchema,
      sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
    }).strict(),
    tier: decisionTierSchema,
    observation: z.object({
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      summary: z.string().min(1).max(4_000),
    }).strict(),
    optionsOffered: z.array(z.object({
      actionId: z.string().min(1),
      summary: z.string().min(1),
    }).strict()).min(1),
    chosen: z.object({
      actionId: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
    }).strict().nullable(),
    rationale: z.string().min(1).max(4_000),
    validation: z.object({
      result: z.enum(["approved", "rejected"]),
      code: z.string().min(1).optional(),
    }).strict(),
    llm: z.object({
      callId: z.string().regex(/^llm_[0-9a-z]{8,}$/),
      promptPackKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
      promptVersion: z.number().int().positive().safe(),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict().optional(),
  }).strict()),
  nextCursor: opaqueCursorSchema,
  meta: apiMetaSchema,
}).strict();
export type AgentDecisionListResponse = z.infer<typeof agentDecisionListResponseSchema>;
