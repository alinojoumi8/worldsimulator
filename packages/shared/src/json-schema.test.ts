import { describe, expect, it } from "vitest";
import { hashValue } from "./codec";
import {
  CORE_JSON_SCHEMA_VERSION,
  coreJsonSchemaBundle,
  engineErrorCodeJsonSchema,
  eventEnvelopeJsonSchema,
  intentEnvelopeJsonSchema,
  JSON_SCHEMA_DIALECT,
  runManifestJsonSchema,
} from "./json-schema";

describe("published core JSON Schemas", () => {
  it("exports named Draft 2020-12 documents for every WS-005 contract", () => {
    expect(coreJsonSchemaBundle.schemaVersion).toBe(CORE_JSON_SCHEMA_VERSION);
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
      expect(schema.$id).toMatch(/^urn:worldtangle:schema:[a-z-]+:v1$/);
      expect(Object.isFrozen(schema)).toBe(true);
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
        llmMode: { enum: ["off", "mock", "live"], type: "string" },
      },
    });
    expect(engineErrorCodeJsonSchema).toMatchObject({
      enum: expect.arrayContaining(["VALIDATION_FAILED", "SCHEMA_INVALID", "INTERNAL"]),
      type: "string",
    });
  });

  it("has a stable canonical publication hash", () => {
    expect(hashValue(coreJsonSchemaBundle)).toBe(
      "12e95d616ab76bf146f023972980d6eb1120023b743443e7cb3136b0fbb19f91",
    );
  });
});
