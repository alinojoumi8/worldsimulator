# ADR-0010 — URI-versioned API + schemaVersion on payloads

**Status:** accepted · **Date:** 2026-07-14

## Context

The frontend, exports, and (later) external consumers depend on API shapes and event payloads. The engine will evolve fast; contracts must not break silently. Runs are long-lived artifacts whose recorded events outlive code versions.

## Decision

- **REST:** major version in the URI (`/api/v1`). Within v1: additive-only changes (new fields optional, new endpoints); breaking changes open `/api/v2` with a deprecation overlap. No header-based content negotiation.
- **Events & DTOs:** every event payload carries an integer `schemaVersion` (per type, starting at 1); envelope fields are fixed for the life of the store format. Payload evolution prefers additive; a breaking payload change bumps that type's version, and readers keep decoding older versions (needed for replay/exports of old runs).
- **Source of truth:** Zod schemas in `packages/shared` → JSON Schema bundle (`GET /api/v1/schemas/events.json`) → OpenAPI 3.1 (`GET /api/v1/openapi.json`). Contract tests validate every response and every emitted event against these; the frontend consumes generated types from the same schemas — drift fails CI.
- Ruleset, prompt-pack, and event-schema versions are pinned in run manifests, tying data compatibility to reproducibility (ADR-0009).

## Alternatives considered

- **Header/media-type versioning:** cleaner theoretically; needless friction for a local tool + browser EventSource (no custom headers on SSE).
- **No versioning ("it's local"):** replay and exports make old data long-lived; unversioned payloads rot immediately.
- **Protobuf/Avro registry:** heavyweight; JSON Schema meets the need and stays human-readable.

## Consequences

- Slight ceremony per payload change (version bump + reader support), repaid every time an old run is opened.
- OpenAPI generation is deferred until Phase 1 (schemas exist from Phase 0; the endpoint that serves them comes with the API layer).
