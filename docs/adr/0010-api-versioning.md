# ADR-0010 — URI-versioned API + schemaVersion on payloads

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

The frontend, exports, and (later) external consumers depend on API shapes and event payloads. The engine will evolve fast; contracts must not break silently. Runs are long-lived artifacts whose recorded events outlive code versions.

## Decision

- **REST:** major version in the URI (`/api/v1`). Within v1: additive-only changes (new fields optional, new endpoints); breaking changes open `/api/v2` with a deprecation overlap. No header-based content negotiation.
- **Events & DTOs:** every event envelope carries an integer `schemaVersion` (per type, starting at 1); versioned stream/artifact payloads carry their own version field where defined. Envelope fields are fixed for the life of the store format. Payload evolution prefers additive; a breaking event payload change bumps that type's version, and readers keep decoding older versions (needed for replay/exports of old runs).
- **Source of truth:** Zod schemas in `packages/shared`. The Phase 0 event/intent/manifest/error contracts export a golden-hashed Draft 2020-12 bundle from the package. Server, frontend, and contract tests consume shared Zod schemas directly. HTTP JSON Schema publication and OpenAPI 3.1 endpoints are not implemented yet and are labelled planned in API_CONTRACTS.
- Ruleset, prompt-pack, and event-schema versions are pinned in run manifests, tying data compatibility to reproducibility (ADR-0009).

## Alternatives considered

- **Header/media-type versioning:** cleaner theoretically; needless friction for a local tool + browser EventSource (no custom headers on SSE).
- **No versioning ("it's local"):** replay and exports make old data long-lived; unversioned payloads rot immediately.
- **Protobuf/Avro registry:** heavyweight; JSON Schema meets the need and stays human-readable.

## Consequences

- Slight ceremony per payload change (version bump + reader support), repaid every time an old run is opened.
- OpenAPI/HTTP schema publication remains a future additive API capability; callers must not assume `/schemas/events.json` or `/openapi.json` exists today.
