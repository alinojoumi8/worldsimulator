import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
  AGENT_LAB_PROTOCOL_VERSION,
} from "./agent-lab";
import { hashValue } from "./codec";
import { runManifestSchema } from "./envelope";
import {
  coreJsonSchemaBundle,
  coreJsonSchemaRegistry,
  engineErrorCodeJsonSchema,
  eventEnvelopeJsonSchema,
  intentEnvelopeJsonSchema,
  JSON_SCHEMA_DIALECT,
  runManifestJsonSchema,
} from "./json-schema";

const digest = "a".repeat(64);
const publishedSchemaPins = [
  {
    name: "engine error code",
    schema: engineErrorCodeJsonSchema,
    registration: coreJsonSchemaRegistry.contracts.engineErrorCode,
  },
  {
    name: "event envelope",
    schema: eventEnvelopeJsonSchema,
    registration: coreJsonSchemaRegistry.contracts.eventEnvelope,
  },
  {
    name: "intent envelope",
    schema: intentEnvelopeJsonSchema,
    registration: coreJsonSchemaRegistry.contracts.intentEnvelope,
  },
  {
    name: "run manifest",
    schema: runManifestJsonSchema,
    registration: coreJsonSchemaRegistry.contracts.runManifest,
  },
] as const;

function runManifestAgentLab() {
  return {
    protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
    studyId: "schema-compatibility",
    trialId: "schema-compatibility-shadow-1",
    experimentManifestDigest: digest,
    mode: "shadow",
    cohortSelection: {
      strategy: "stable_stratified_v1",
      size: 1,
      controller: "shadow",
      strata: ["occupation"],
    },
    opportunityFixture: {
      version: AGENT_LAB_GOAL_COMMITMENT_FIXTURE_VERSION,
      ticks: [10],
    },
    decisionDeadlineMs: 5_000,
    budget: {
      maxAgentLoopIterations: 8,
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      maxToolCalls: 8,
    },
    driverPolicyDigest: digest,
    promptDigest: digest,
    toolSchemaDigest: digest,
    resolvedAssignments: [{
      agentId: "agt_00000001",
      controller: "shadow",
    }],
  } as const;
}

function runManifest(agentLab?: unknown) {
  return {
    runId: "run_00000001",
    simulationId: "sim_00000001",
    seed: 42,
    engineVersion: "0.1.0",
    rulesetVersion: 1,
    promptPackVersion: 1,
    eventSchemaVersion: 1,
    llmMode: "mock",
    modelRouting: {},
    scenarioDigest: "abc123",
    worldSpecDigest: "def456",
    createdWall: "2026-07-14T00:00:00.000Z",
    ...(agentLab === undefined ? {} : { agentLab }),
  };
}

describe("published core JSON Schemas", () => {
  it("exports named Draft 2020-12 documents for every WS-005 contract", () => {
    expect(coreJsonSchemaBundle.schemaVersion).toBe(
      coreJsonSchemaRegistry.schemaVersion,
    );
    expect(coreJsonSchemaBundle.dialect).toBe(JSON_SCHEMA_DIALECT);
    expect(Object.keys(coreJsonSchemaBundle.schemas)).toEqual([
      "engineErrorCode",
      "eventEnvelope",
      "intentEnvelope",
      "runManifest",
    ]);

    for (const schema of [
      engineErrorCodeJsonSchema,
      eventEnvelopeJsonSchema,
      intentEnvelopeJsonSchema,
      runManifestJsonSchema,
    ]) {
      expect(schema.$schema).toBe(JSON_SCHEMA_DIALECT);
      expect(Object.isFrozen(schema)).toBe(true);
    }
  });

  it("pins each document digest to its independently versioned schema ID", () => {
    const ids = publishedSchemaPins.map((pin) => pin.schema.$id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pin of publishedSchemaPins) {
      const expectedId =
        `urn:worldtangle:schema:${pin.registration.name}:` +
        `v${pin.registration.version}`;
      expect(pin.schema.$id, `${pin.name} schema ID changed`).toBe(expectedId);
      expect(
        () => new Ajv2020({ strict: false }).compile(pin.schema),
        `${pin.name} schema is not valid Draft 2020-12`,
      ).not.toThrow();
      expect(
        hashValue(pin.schema),
        `${pin.name} schema changed; bump its contract ID or verify a Zod ` +
          "converter upgrade before updating the digest",
      ).toBe(pin.registration.contentDigest);
    }
  });

  it("publishes the envelope and manifest constraints from their Zod sources", () => {
    expect(eventEnvelopeJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "eventId",
        "type",
        "schemaVersion",
        "simulationId",
        "runId",
        "seq",
        "tick",
        "simDate",
        "wallTime",
        "actor",
        "correlationId",
        "payload",
      ],
      properties: {
        eventId: { pattern: "^evt_[0-9a-z]{8,}$", type: "string" },
        seq: { minimum: 0, type: "integer" },
        tick: { minimum: 0, type: "integer" },
      },
    });
    expect(intentEnvelopeJsonSchema).toMatchObject({
      properties: {
        intentId: { pattern: "^int_[0-9a-z]{8,}$", type: "string" },
        tick: { minimum: 0, type: "integer" },
      },
    });
    expect(runManifestJsonSchema).toMatchObject({
      properties: {
        agentLab: {
          additionalProperties: false,
          type: "object",
        },
        llmMode: { enum: ["off", "mock", "live"], type: "string" },
      },
    });
    const agentLabSchema = (
      runManifestJsonSchema as unknown as {
        properties: {
          agentLab: {
            properties: {
              opportunityFixture: {
                additionalProperties?: boolean;
                required?: readonly string[];
              };
            };
          };
        };
      }
    ).properties.agentLab;
    expect(agentLabSchema.properties.opportunityFixture).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["version", "ticks"]),
    });
    expect(
      (runManifestJsonSchema as { required?: readonly string[] }).required,
    ).not.toContain("agentLab");
    expect(engineErrorCodeJsonSchema).toMatchObject({
      enum: expect.arrayContaining(["VALIDATION_FAILED", "SCHEMA_INVALID", "INTERNAL"]),
      type: "string",
    });
  });

  it("documents refinement-only fixture rules as non-authoritative", () => {
    const agentLab = runManifestAgentLab();
    const refinementOnlyViolation = runManifest({
      ...agentLab,
      opportunityFixture: {
        ...agentLab.opportunityFixture,
        ticks: [30, 10, 10],
      },
    });
    const validatePublishedSchema = new Ajv2020({ strict: false })
      .compile(runManifestJsonSchema);

    expect(
      validatePublishedSchema(refinementOnlyViolation),
      JSON.stringify(validatePublishedSchema.errors),
    ).toBe(true);
    expect(runManifestSchema.safeParse(refinementOnlyViolation).success).toBe(false);
    const structurallyInvalid = runManifest({
      ...agentLab,
      opportunityFixture: {
        ...agentLab.opportunityFixture,
        ticks: [0],
      },
    });
    expect(validatePublishedSchema(structurallyInvalid)).toBe(false);
    expect(validatePublishedSchema.errors).not.toBeNull();
  });

  it("preserves legacy manifests and rejects malformed fixture extensions", () => {
    expect(runManifestSchema.safeParse(runManifest()).success).toBe(true);
    const agentLab = runManifestAgentLab();
    expect(runManifestSchema.safeParse(runManifest(agentLab)).success).toBe(true);

    for (const { invalidAgentLab, issuePath } of [
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            version: "goal_commitment_choice_v0",
          },
        },
        issuePath: "agentLab.opportunityFixture.version",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            ticks: [0],
          },
        },
        issuePath: "agentLab.opportunityFixture.ticks.0",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            unexpected: true,
          },
        },
        issuePath: "agentLab.opportunityFixture",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            ticks: [],
          },
        },
        issuePath: "agentLab.opportunityFixture.ticks",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            ticks: Array.from({ length: 101 }, (_, index) => index + 1),
          },
        },
        issuePath: "agentLab.opportunityFixture.ticks",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            ticks: [10, 10],
          },
        },
        issuePath: "agentLab.opportunityFixture.ticks",
      },
      {
        invalidAgentLab: {
          ...agentLab,
          opportunityFixture: {
            ...agentLab.opportunityFixture,
            ticks: [30, 10],
          },
        },
        issuePath: "agentLab.opportunityFixture.ticks",
      },
    ]) {
      const parsed = runManifestSchema.safeParse(runManifest(invalidAgentLab));
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
          issuePath,
        );
      }
    }
  });

  it("has a stable canonical publication hash", () => {
    expect(
      hashValue(coreJsonSchemaBundle),
      "schema bundle changed; verify contract edits or a Zod converter upgrade " +
        "before updating the digest",
    ).toBe(
      "b8a631b15e3094405b8f08e9355f890e915ab7a64b5d4a46c890aa3b8ac2c7b4",
    );
  });
});
