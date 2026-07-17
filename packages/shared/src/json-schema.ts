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
export const CORE_JSON_SCHEMA_VERSION = 1;

export type PublishedJsonSchema = Readonly<Record<string, unknown>> & {
  readonly $id: string;
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
  readonly title: string;
};

function publishJsonSchema(
  schema: z.ZodType,
  name: string,
  title: string,
): PublishedJsonSchema {
  return Object.freeze({
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id: `urn:worldtangle:schema:${name}:v${CORE_JSON_SCHEMA_VERSION}`,
    $schema: JSON_SCHEMA_DIALECT,
    title,
  });
}

export const eventEnvelopeJsonSchema = publishJsonSchema(
  eventEnvelopeSchema,
  "event-envelope",
  "EventEnvelope",
);

export const intentEnvelopeJsonSchema = publishJsonSchema(
  intentEnvelopeSchema,
  "intent-envelope",
  "IntentEnvelope",
);

export const runManifestJsonSchema = publishJsonSchema(
  runManifestSchema,
  "run-manifest",
  "RunManifest",
);

export const engineErrorCodeJsonSchema = publishJsonSchema(
  engineErrorCodeSchema,
  "engine-error-code",
  "EngineErrorCode",
);

/** Serializable registry payload suitable for later HTTP/OpenAPI publication. */
export const coreJsonSchemaBundle = Object.freeze({
  schemaVersion: CORE_JSON_SCHEMA_VERSION,
  dialect: JSON_SCHEMA_DIALECT,
  schemas: Object.freeze({
    engineErrorCode: engineErrorCodeJsonSchema,
    eventEnvelope: eventEnvelopeJsonSchema,
    intentEnvelope: intentEnvelopeJsonSchema,
    runManifest: runManifestJsonSchema,
  }),
});
