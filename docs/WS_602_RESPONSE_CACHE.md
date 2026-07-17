# WS-602 — Canonical LLM response cache and replay boundary

## Outcome

WS-602 makes a live model response a durable, immutable run artifact. A later
replay can satisfy the same canonical request from SQLite without contacting a
provider. Cache misses in `cache_only` mode are typed fallback signals and never
fall through to live transport.

The cache is operational replay metadata, not economic world state. Importing a
cache artifact therefore cannot consume simulation `evt_*` IDs, change the
logical state hash, or alter later deterministic event ordering.

## Canonical identity

The composite cache key is:

```text
(provider, model, promptPackVersion, schemaVersion, requestHash)
```

`requestHash` is SHA-256 over canonical serialization of every request field
that can shape output: purpose, tier, agent, stable system prompt, volatile
observation, registered schema key and versions, engine-generated menu, and
maximum output tokens. `correlationId`, `causationId`, `budgetTag`, simulated
budget day (`tick`), and approved control `moduleId` are operational metadata
and are deliberately excluded.

Both the request hash and the complete composite key have hard-coded golden
tests. Provider and model routing is resolved before the first call, so a model
change cannot silently reuse an older answer.

## Read-through and replay behavior

`CachedLlmProvider` composes around any `RoutedLlmProvider`:

- `read_write`: read first; on a miss call the provider once, revalidate the
  result with the registered Zod schema, then store it immutably.
- `cache_only`: read first; on a miss return `cache_miss` with zero provider
  attempts.
- A malformed key, poisoned row, wrong request hash, schema-invalid response,
  or persistence/audit failure returns a typed `cache_corrupt` fallback. It
  never calls live transport as recovery and never throws into the engine.
- An existing key may be written again only when the complete normalized
  response is byte-equivalent under the canonical codec.

## Persistence and audit

Migration v19 adds two run-scoped append-only tables:

- `llm_response_cache`: immutable normalized response, resolved response model,
  token counts, provider attempts, origin run, stored tick, and source audit ID.
- `llm_cache_events`: an independent gapless sequence of version-1
  `llm.cache.miss`, `hit`, `stored`, `corrupt`, and `imported` facts.

Every cache audit fact records the system actor `llm_gateway`, tick,
correlation, causation, and concrete request/key or artifact evidence. A cause
must already exist in either the authoritative simulation journal or the cache
audit stream. The `stored` event and response row commit in one immediate SQLite
transaction; an insert failure rolls both back.

The independent `llmce_*` sequence is intentional. Cache preload happens before
re-execution and must not move the authoritative `next_event_seq` or ID factory.
The cache and audit stream remain excluded from logical state-hash v15, while a
SQLite snapshot contains both tables and restores them exactly.

## Artifact contract

`worldtangle.llm-response-cache` version 1 is a canonical, key-sorted object
containing the source run, normalized records, and SHA-256 digest. Validation
rejects tampering, duplicate keys, and non-canonical ordering before any write.
Import is atomic, conflicts are rejected, exact records are skipped, and an
exact repeated import emits no duplicate audit event.

The full replay executor will consume this artifact in WS-705. WS-602 supplies
the provider-independent cache-only boundary and verified import/export
contract it needs.

## Acceptance evidence

Coverage proves:

- cross-platform request/key hash goldens and sensitivity to every key field;
- deterministic miss/store/hit behavior with one upstream call;
- cache-only hit and typed miss with zero upstream calls;
- poisoned-cache and provider-hash containment;
- immutable conflicts and injected-write rollback;
- checksummed, sorted, idempotent artifact export/import;
- reopen persistence and causal audit ordering;
- no change to authoritative logical state hash or simulation event sequence;
- exact cache and audit survival through SQLite snapshot/restore.
