/**
 * Stable, machine-readable publications of the Phase 0 shared contracts.
 *
 * Zod remains the source of truth. The pinned Zod converter produces Draft
 * 2020-12 documents, while explicit IDs and a versioned bundle give API and
 * tooling consumers stable names. The golden hash test makes converter drift
 * or accidental contract edits visible in review.
 */

import { z } from "zod";
import {
  engineErrorCodeSchema,
  eventEnvelopeSchema,
  intentEnvelopeSchema,
  runManifestSchema,
} from "./envelope";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const coreJsonSchemaRegistry = Object.freeze({
  schemaVersion: 2,
  contracts: Object.freeze({
    engineErrorCode: Object.freeze({
      name: "engine-error-code",
      title: "EngineErrorCode",
      version: 1,
      contentDigest:
        "fb37f157530ba922d81423d51bc83c239b245035310d4732a86bf7e0a9209134",
    }),
    eventEnvelope: Object.freeze({
      name: "event-envelope",
      title: "EventEnvelope",
      version: 1,
      contentDigest:
        "2e3f559c760e47c2bc87c9ed1515297a382fe8e6eab171e7a6869ca268966783",
    }),
    intentEnvelope: Object.freeze({
      name: "intent-envelope",
      title: "IntentEnvelope",
      version: 1,
      contentDigest:
        "4a5bbd17a6e6d3be7c225088641b90de8a86cd8898458036526117981dcc027e",
    }),
    runManifest: Object.freeze({
      name: "run-manifest",
      title: "RunManifest",
      version: 2,
      contentDigest:
        "f16fd0b6a0e7de0caa06a94842a4eb40459614727eb21de53fa3712c530c9037",
    }),
  }),
});

export type PublishedJsonSchema = Readonly<Record<string, unknown>> & {
  readonly $id: string;
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
  readonly title: string;
};

function publishJsonSchema(
  schema: z.ZodType,
  contract: keyof typeof coreJsonSchemaRegistry.contracts,
): PublishedJsonSchema {
  const registration = coreJsonSchemaRegistry.contracts[contract];
  return Object.freeze({
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id:
      `urn:worldtangle:schema:${registration.name}:v${registration.version}`,
    $schema: JSON_SCHEMA_DIALECT,
    title: registration.title,
  });
}

export const eventEnvelopeJsonSchema = publishJsonSchema(
  eventEnvelopeSchema,
  "eventEnvelope",
);

export const intentEnvelopeJsonSchema = publishJsonSchema(
  intentEnvelopeSchema,
  "intentEnvelope",
);

export const runManifestJsonSchema = publishJsonSchema(
  runManifestSchema,
  "runManifest",
);

export const engineErrorCodeJsonSchema = publishJsonSchema(
  engineErrorCodeSchema,
  "engineErrorCode",
);

/** Serializable registry payload suitable for later HTTP/OpenAPI publication. */
export const coreJsonSchemaBundle = Object.freeze({
  schemaVersion: coreJsonSchemaRegistry.schemaVersion,
  dialect: JSON_SCHEMA_DIALECT,
  schemas: Object.freeze({
    engineErrorCode: engineErrorCodeJsonSchema,
    eventEnvelope: eventEnvelopeJsonSchema,
    intentEnvelope: intentEnvelopeJsonSchema,
    runManifest: runManifestJsonSchema,
  }),
});
