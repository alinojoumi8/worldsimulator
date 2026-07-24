import { z } from "zod";
import { canonicalStringify, hashValue } from "./codec";

export const AGENT_LAB_PROTOCOL_VERSION = "wt.agent-lab.v1" as const;
export const AGENT_LAB_MODES = ["native", "shadow", "external"] as const;
export const AGENT_LAB_CONTROLLERS = ["native", "shadow", "external"] as const;
export const AGENT_LAB_SCOPES = [
  "agent-lab.identity:read",
  "agent-lab.turn:read",
  "agent-lab.action:submit",
  "agent-lab.receipt:read",
] as const;
export const AGENT_LAB_RECEIPT_STATUSES = [
  "shadowed",
  "queued",
  "applied",
  "rejected",
  "stale",
  "fallback",
] as const;
export const AGENT_LAB_MCP_TOOL_NAMES = [
  "wt_identity_get",
  "wt_turn_wait",
  "wt_action_submit",
  "wt_receipt_get",
] as const;
export const AGENT_LAB_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "wt_identity_get",
    description: "Read this trial-bound citizen identity and exact granted scopes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wt_turn_wait",
    description: "Wait for this citizen's exact scoped decision turn.",
    inputSchema: {
      type: "object",
      properties: {
        waitMs: { type: "integer", minimum: 0, maximum: 30_000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wt_action_submit",
    description: "Submit one idempotent action from the engine-offered menu.",
    inputSchema: {
      type: "object",
      required: [
        "turnId",
        "targetTick",
        "observedProjectionHash",
        "observedMenuHash",
        "idempotencyKey",
        "action",
        "driverPolicyDigest",
      ],
      properties: {
        turnId: { type: "string", pattern: "^turn_[0-9a-f]{24}$" },
        targetTick: { type: "integer", minimum: 1 },
        observedProjectionHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        observedMenuHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
        action: {
          type: "object",
          required: ["actionId", "params", "rationale"],
          properties: {
            actionId: { type: "string" },
            params: { type: "object" },
            rationale: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          additionalProperties: false,
        },
        driverPolicyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wt_receipt_get",
    description: "Read a submission receipt owned by this trial-bound citizen.",
    inputSchema: {
      type: "object",
      required: ["submissionId"],
      properties: {
        submissionId: { type: "string", pattern: "^sub_[0-9a-f]{24}$" },
      },
      additionalProperties: false,
    },
  },
] as const);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LAB_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{24}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9a-f]{24}$/;
const RECEIPT_ID_PATTERN = /^rcpt_[0-9a-f]{24}$/;
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const agentIdSchema = z.string().regex(/^agt_[0-9a-z]{8,}$/);
const runIdSchema = z.string().regex(/^run_[0-9a-z]{8,}$/);
const simulationIdSchema = z.string().regex(/^sim_[0-9a-z]{8,}$/);
const triggerBaseSchema = z.object({
  agentId: agentIdSchema,
  tick: z.number().int().nonnegative().safe(),
  sourceEventId: z.string().regex(/^evt_[0-9a-z]{8,}$/),
  priority: z.number().int().min(0).max(100),
});
const triggerSignalSchema = z.discriminatedUnion("kind", [
  triggerBaseSchema.extend({
    kind: z.literal("schedule"),
    payload: z.object({
      taskRef: z.string().min(1).max(160),
      dueTick: z.number().int().nonnegative().safe(),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("message"),
    payload: z.object({
      messageId: z.string().min(1).max(80),
      conversationId: z.string().min(1).max(80).optional(),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("stress"),
    payload: z.object({
      balanceCents: z.string().regex(/^-?\d+$/),
      bufferDays: z.number().int().min(0).max(365),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("news"),
    payload: z.object({
      storyId: z.string().min(1).max(80),
      relevanceScore: z.number().int().min(0).max(100),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("goal"),
    payload: z.object({
      goalId: z.string().min(1).max(80),
      goalKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("policy"),
    payload: z.object({
      policyId: z.string().min(1).max(80),
      changeKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("company"),
    payload: z.object({
      companyId: z.string().min(1).max(80),
      eventKind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict(),
  }).strict(),
  triggerBaseSchema.extend({
    kind: z.literal("market"),
    payload: z.object({
      marketId: z.string().min(1).max(80),
      securityId: z.string().min(1).max(80).optional(),
      movementBp: z.number().int().min(-10_000).max(10_000),
    }).strict(),
  }).strict(),
]);
const decisionOptionSchema = z.object({
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  actionType: z.string().regex(TYPE_NAME_PATTERN),
  params: z.record(z.string(), z.unknown()),
  utility: z.number().int().min(-1_000_000).max(1_000_000),
  utilityFactors: z.record(z.string(), z.number().int()).optional(),
}).strict();

export const sha256DigestSchema = z.string().regex(SHA256_PATTERN);
export const agentLabModeSchema = z.enum(AGENT_LAB_MODES);
export const agentLabControllerSchema = z.enum(AGENT_LAB_CONTROLLERS);
export const agentLabScopeSchema = z.enum(AGENT_LAB_SCOPES);
export const agentLabReceiptStatusSchema = z.enum(AGENT_LAB_RECEIPT_STATUSES);
export type AgentLabMode = z.infer<typeof agentLabModeSchema>;
export type AgentLabController = z.infer<typeof agentLabControllerSchema>;
export type AgentLabScope = z.infer<typeof agentLabScopeSchema>;
export type AgentLabReceiptStatus = z.infer<typeof agentLabReceiptStatusSchema>;

export const agentLabControllerAssignmentSchema = z.object({
  agentId: agentIdSchema,
  controller: agentLabControllerSchema,
}).strict();

export const agentLabCohortSelectionSchema = z.object({
  strategy: z.literal("stable_stratified_v1"),
  size: z.number().int().min(1).max(100).safe(),
  controller: z.enum(["shadow", "external"]),
  strata: z.array(z.enum(["occupation", "employment_status", "household"])).min(1).max(3),
}).strict();

export const agentLabBudgetSchema = z.object({
  maxAgentLoopIterations: z.number().int().min(1).max(8).safe(),
  maxInputTokens: z.number().int().min(1).max(1_000_000).safe(),
  maxOutputTokens: z.number().int().min(1).max(100_000).safe(),
  maxToolCalls: z.number().int().min(1).max(32).safe(),
}).strict();
export type AgentLabBudget = z.infer<typeof agentLabBudgetSchema>;

export const agentLabScenarioSchema = z.object({
  protocolVersion: z.literal(AGENT_LAB_PROTOCOL_VERSION),
  studyId: z.string().regex(LAB_ID_PATTERN),
  trialId: z.string().regex(LAB_ID_PATTERN),
  experimentManifestDigest: sha256DigestSchema,
  mode: agentLabModeSchema,
  controllerAssignments: z.array(agentLabControllerAssignmentSchema).max(100).optional(),
  cohortSelection: agentLabCohortSelectionSchema.optional(),
  decisionDeadlineMs: z.number().int().min(50).max(120_000).safe(),
  budget: agentLabBudgetSchema,
  driverPolicyDigest: sha256DigestSchema,
  promptDigest: sha256DigestSchema,
  toolSchemaDigest: sha256DigestSchema,
}).strict().superRefine((value, ctx) => {
  if (value.controllerAssignments !== undefined && value.cohortSelection !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["cohortSelection"],
      message: "use controllerAssignments or cohortSelection, not both",
    });
  }
  if (
    value.mode !== "native" &&
    value.controllerAssignments === undefined &&
    value.cohortSelection === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["controllerAssignments"],
      message: "shadow and external trials require an explicit or stratified cohort",
    });
  }
  if (
    value.controllerAssignments !== undefined &&
    new Set(value.controllerAssignments.map((assignment) => assignment.agentId)).size !==
      value.controllerAssignments.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["controllerAssignments"],
      message: "controller assignments must contain unique agents",
    });
  }
  if (
    value.controllerAssignments?.some(
      (assignment) => assignment.controller !== value.mode,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["controllerAssignments"],
      message: "every explicit controller must match the trial mode",
    });
  }
  if (
    value.cohortSelection !== undefined &&
    value.cohortSelection.controller !== value.mode
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["cohortSelection", "controller"],
      message: "the cohort controller must match the trial mode",
    });
  }
});
export type AgentLabScenario = z.infer<typeof agentLabScenarioSchema>;

export const runManifestAgentLabSchema = agentLabScenarioSchema.safeExtend({
  resolvedAssignments: z.array(agentLabControllerAssignmentSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (
    new Set(value.resolvedAssignments.map((assignment) => assignment.agentId)).size !==
      value.resolvedAssignments.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["resolvedAssignments"],
      message: "resolved assignments must contain unique agents",
    });
  }
  if (
    value.resolvedAssignments.some(
      (assignment) => assignment.controller !== value.mode,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["resolvedAssignments"],
      message: "every resolved controller must match the trial mode",
    });
  }
});
export type RunManifestAgentLab = z.infer<typeof runManifestAgentLabSchema>;

export const scopedObservationFactSchema = z.object({
  id: z.string().regex(LAB_ID_PATTERN),
  kind: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  learnedTick: z.number().int().nonnegative().safe(),
  value: z.unknown(),
  evidenceEventIds: z.array(z.string().min(1).max(160)).max(32),
}).strict();

export const scopedDeliveredItemSchema = z.object({
  source: z.enum(["message", "conversation", "news"]),
  id: z.string().min(1).max(160),
  content: z.string().min(1).max(4_000),
  deliveredTick: z.number().int().nonnegative().safe(),
  references: z.array(z.string().min(1).max(160)).max(32),
}).strict();

export const scopedPublicPriceSchema = z.object({
  itemId: z.string().min(1).max(160),
  priceCents: z.string().regex(/^\d+$/),
  observedTick: z.number().int().nonnegative().safe(),
  sourceEventId: z.string().min(1).max(160),
}).strict();

export const scopedMemoryCitationSchema = z.object({
  memoryId: z.string().min(1).max(160),
  summary: z.string().min(1).max(2_000),
  recordedTick: z.number().int().nonnegative().safe(),
  references: z.array(z.string().min(1).max(160)).min(1).max(32),
}).strict();

export const agentScopedObservationSchema = z.object({
  policyVersion: z.literal("partial_observation_v1"),
  ownState: z.unknown(),
  learnedFacts: z.array(scopedObservationFactSchema).max(200),
  deliveredItems: z.array(scopedDeliveredItemSchema).max(100),
  publicPrices: z.array(scopedPublicPriceSchema).max(200),
  citedMemories: z.array(scopedMemoryCitationSchema).max(100),
}).strict();
export type AgentScopedObservation = z.infer<typeof agentScopedObservationSchema>;

export const agentTurnEnvelopeSchema = z.object({
  protocolVersion: z.literal(AGENT_LAB_PROTOCOL_VERSION),
  simulationId: simulationIdSchema,
  runId: runIdSchema,
  studyId: z.string().regex(LAB_ID_PATTERN),
  trialId: z.string().regex(LAB_ID_PATTERN),
  turnId: z.string().regex(TURN_ID_PATTERN),
  agentId: agentIdSchema,
  controller: z.enum(["shadow", "external"]),
  opportunityKey: z.string().min(1).max(240),
  trigger: triggerSignalSchema,
  completedTick: z.number().int().nonnegative().safe(),
  targetTick: z.number().int().positive().safe(),
  observation: agentScopedObservationSchema,
  offeredOptions: z.array(decisionOptionSchema).min(1).max(100),
  projectionHash: sha256DigestSchema,
  menuHash: sha256DigestSchema,
  cursor: z.string().min(1).max(512),
  deadline: z.string().datetime({ offset: true }),
  driverPolicyDigest: sha256DigestSchema,
  promptDigest: sha256DigestSchema,
  toolSchemaDigest: sha256DigestSchema,
}).strict();
export type AgentTurnEnvelope = z.infer<typeof agentTurnEnvelopeSchema>;

export const agentLabActionChoiceSchema = z.object({
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
export type AgentLabActionChoice = z.infer<typeof agentLabActionChoiceSchema>;

export const agentActionSubmissionSchema = z.object({
  turnId: z.string().regex(TURN_ID_PATTERN),
  targetTick: z.number().int().positive().safe(),
  observedProjectionHash: sha256DigestSchema,
  observedMenuHash: sha256DigestSchema,
  idempotencyKey: z.string().trim().min(1).max(128),
  action: agentLabActionChoiceSchema,
  driverPolicyDigest: sha256DigestSchema,
}).strict();
export type AgentActionSubmission = z.infer<typeof agentActionSubmissionSchema>;

export const recordedAgentLabSubmissionSchema = z.object({
  protocolVersion: z.literal(AGENT_LAB_PROTOCOL_VERSION),
  studyId: z.string().regex(LAB_ID_PATTERN),
  trialId: z.string().regex(LAB_ID_PATTERN),
  turnId: z.string().regex(TURN_ID_PATTERN),
  agentId: agentIdSchema,
  opportunityKey: z.string().min(1).max(240),
  targetTick: z.number().int().positive().safe(),
  projectionHash: sha256DigestSchema,
  menuHash: sha256DigestSchema,
  requestHash: sha256DigestSchema,
  proposalDigest: sha256DigestSchema,
  proposal: agentLabActionChoiceSchema,
  actionId: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  params: z.record(z.string(), z.unknown()),
  driverPolicyDigest: sha256DigestSchema,
}).strict().superRefine((value, ctx) => {
  if (
    value.actionId !== value.proposal.actionId ||
    canonicalStringify(value.params) !== canonicalStringify(value.proposal.params)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["proposal"],
      message: "recorded proposal must match the indexed action and parameters",
    });
  }
  if (value.proposalDigest !== hashValue(value.proposal)) {
    ctx.addIssue({
      code: "custom",
      path: ["proposalDigest"],
      message: "recorded proposal digest does not match the proposal bytes",
    });
  }
});
export type RecordedAgentLabSubmission = z.infer<typeof recordedAgentLabSubmissionSchema>;

export const agentLabValidatorResultSchema = z.object({
  validator: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  ok: z.boolean(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(1_000),
}).strict();

export const agentActionReceiptSchema = z.object({
  protocolVersion: z.literal(AGENT_LAB_PROTOCOL_VERSION),
  receiptId: z.string().regex(RECEIPT_ID_PATTERN),
  submissionId: z.string().regex(SUBMISSION_ID_PATTERN).optional(),
  turnId: z.string().regex(TURN_ID_PATTERN),
  runId: runIdSchema,
  agentId: agentIdSchema,
  targetTick: z.number().int().positive().safe(),
  status: agentLabReceiptStatusSchema,
  validatorResults: z.array(agentLabValidatorResultSchema).max(100),
  resultEventIds: z.array(z.string().min(1).max(160)).max(100),
  postTickStateHash: sha256DigestSchema.optional(),
  createdWall: z.string().datetime({ offset: true }),
  completedWall: z.string().datetime({ offset: true }).optional(),
}).strict();
export type AgentActionReceipt = z.infer<typeof agentActionReceiptSchema>;

export const experimentMetricSchema = z.object({
  id: z.string().regex(LAB_ID_PATTERN),
  description: z.string().trim().min(1).max(1_000),
  unit: z.string().trim().min(1).max(80),
  direction: z.enum(["increase", "decrease", "target", "descriptive"]),
}).strict();

export const experimentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(AGENT_LAB_PROTOCOL_VERSION),
  studyId: z.string().regex(LAB_ID_PATTERN),
  scenario: z.object({
    name: z.string().trim().min(1).max(120),
    worldSpec: z.string().regex(/^[a-z0-9][a-z0-9_-]*@[1-9]\d*$/),
    seeds: z.array(z.number().int().safe()).min(1).max(100),
    ticks: z.number().int().positive().max(10_000).safe(),
    budgets: z.object({
      runCostCentsMax: z.string().regex(/^[1-9]\d*$/),
      perAgentDailyTokens: z.number().int().positive().safe(),
    }).strict(),
    policyOverrides: z.record(z.string(), z.number().int().safe()),
  }).strict(),
  cohort: agentLabCohortSelectionSchema,
  interventions: z.array(z.object({
    id: z.string().regex(LAB_ID_PATTERN),
    tick: z.number().int().positive().safe(),
    type: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    params: z.record(z.string(), z.unknown()),
  }).strict()).max(100),
  hypotheses: z.array(z.object({
    id: z.string().regex(LAB_ID_PATTERN),
    statement: z.string().trim().min(1).max(2_000),
    metricIds: z.array(z.string().regex(LAB_ID_PATTERN)).min(1).max(100),
  }).strict()).min(1),
  primaryMetrics: z.array(experimentMetricSchema).min(1),
  secondaryMetrics: z.array(experimentMetricSchema),
  attempts: z.object({
    native: z.number().int().nonnegative().max(100),
    shadow: z.number().int().nonnegative().max(100),
    external: z.number().int().nonnegative().max(100),
  }).strict(),
  provider: z.object({
    family: z.literal("hermes"),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/),
    settings: z.object({
      decisionDeadlineMs: z.number().int().min(50).max(120_000).safe(),
      inputMicrocentsPerToken: z.number().int().nonnegative().safe(),
      outputMicrocentsPerToken: z.number().int().nonnegative().safe(),
      hermesVersion: z.string().trim().min(1).max(240),
      hermesPythonVersion: z.string().trim().min(1).max(80),
      hermesOpenAiSdkVersion: z.string().trim().min(1).max(80),
      providerEnvAllowlist: z.string().trim().min(1).max(1_000),
    }).strict(),
  }).strict(),
  generationBudget: agentLabBudgetSchema,
  prompt: z.object({
    bytes: z.string().min(1).max(100_000),
    digest: sha256DigestSchema,
  }).strict(),
  tools: z.array(z.object({
    name: z.enum(AGENT_LAB_MCP_TOOL_NAMES),
    schema: z.record(z.string(), z.unknown()),
    digest: sha256DigestSchema,
  }).strict()).length(4),
  engine: z.object({
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    dependencies: z.record(z.string(), z.string().min(1)),
  }).strict(),
  driverPolicyDigest: sha256DigestSchema,
  createdWall: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  const toolNames = value.tools.map((tool) => tool.name);
  if (
    new Set(toolNames).size !== AGENT_LAB_MCP_TOOL_NAMES.length ||
    AGENT_LAB_MCP_TOOL_NAMES.some((name) => !toolNames.includes(name))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["tools"],
      message: "manifest must pin each WorldTangle Agent Lab MCP tool exactly once",
    });
  }
  if (new Set(value.scenario.seeds).size !== value.scenario.seeds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["scenario", "seeds"],
      message: "experiment seeds must be unique",
    });
  }
  const interventionIds = value.interventions.map((intervention) => intervention.id);
  if (new Set(interventionIds).size !== interventionIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["interventions"],
      message: "intervention IDs must be unique",
    });
  }
  if (value.interventions.some((intervention) => intervention.tick > value.scenario.ticks)) {
    ctx.addIssue({
      code: "custom",
      path: ["interventions"],
      message: "every intervention must occur inside the trial tick range",
    });
  }
  const metrics = [...value.primaryMetrics, ...value.secondaryMetrics];
  const metricIds = metrics.map((metric) => metric.id);
  if (new Set(metricIds).size !== metricIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["primaryMetrics"],
      message: "experiment metric IDs must be unique",
    });
  }
  const hypothesisIds = value.hypotheses.map((hypothesis) => hypothesis.id);
  if (new Set(hypothesisIds).size !== hypothesisIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["hypotheses"],
      message: "hypothesis IDs must be unique",
    });
  }
  const knownMetrics = new Set(metricIds);
  if (
    value.hypotheses.some((hypothesis) =>
      hypothesis.metricIds.some((metricId) => !knownMetrics.has(metricId))
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["hypotheses"],
      message: "every hypothesis metric must be declared in the manifest",
    });
  }
});
export type ExperimentManifest = z.infer<typeof experimentManifestSchema>;

export const taintRecordSchema = z.object({
  tainted: z.boolean(),
  reasons: z.array(z.object({
    code: z.enum(["manual_input", "manifest_drift", "unmanifested_intervention", "artifact_corrupt"]),
    detail: z.string().min(1).max(1_000),
    recordedWall: z.string().datetime({ offset: true }),
  }).strict()).max(100),
}).strict();
export type TaintRecord = z.infer<typeof taintRecordSchema>;

export const trialArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  studyId: z.string().regex(LAB_ID_PATTERN),
  trialId: z.string().regex(LAB_ID_PATTERN),
  mode: agentLabModeSchema,
  seed: z.number().int().safe(),
  attempt: z.number().int().positive().safe(),
  manifestDigest: sha256DigestSchema,
  runtime: z.object({
    engineCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
    startedWall: z.string().datetime({ offset: true }),
    completedWall: z.string().datetime({ offset: true }),
  }).strict(),
  files: z.record(z.string(), sha256DigestSchema),
  hashHeads: z.object({
    eventLog: sha256DigestSchema,
    state: sha256DigestSchema,
    cache: sha256DigestSchema,
    prompt: sha256DigestSchema,
    artifact: sha256DigestSchema,
  }).strict(),
  statistics: z.object({
    turns: z.number().int().nonnegative().safe(),
    terminalReceipts: z.number().int().nonnegative().safe(),
    validSubmissions: z.number().int().nonnegative().safe(),
    rejectedSubmissions: z.number().int().nonnegative().safe(),
    fallbacks: z.number().int().nonnegative().safe(),
    toolCalls: z.number().int().nonnegative().safe(),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    costMicrocents: z.string().regex(/^\d+$/),
    latencyMs: z.number().int().nonnegative().safe(),
  }).strict(),
  taint: taintRecordSchema,
}).strict();
export type TrialArtifact = z.infer<typeof trialArtifactSchema>;

const scoreMetricSchema = z.object({
  metricId: z.string().regex(LAB_ID_PATTERN),
  value: z.number().finite().nullable(),
  unit: z.string().min(1).max(80),
  evidence: z.array(z.string().min(1).max(240)).max(100),
}).strict();

export const experimentScorecardSchema = z.object({
  schemaVersion: z.literal(1),
  studyId: z.string().regex(LAB_ID_PATTERN),
  trialId: z.string().regex(LAB_ID_PATTERN),
  structural: z.array(scoreMetricSchema),
  behavioral: z.array(scoreMetricSchema),
  social: z.array(scoreMetricSchema),
  economic: z.array(scoreMetricSchema),
  operational: z.array(scoreMetricSchema),
  judge: z.object({
    enabled: z.boolean(),
    blinded: z.boolean(),
    releaseOracle: z.literal(false),
    metrics: z.array(scoreMetricSchema),
  }).strict().optional(),
}).strict();
export type ExperimentScorecard = z.infer<typeof experimentScorecardSchema>;
