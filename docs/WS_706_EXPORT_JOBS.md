# WS-706 — Checksummed export jobs

WS-706 adds restart-safe asynchronous exports for the three authoritative MVP
datasets: committed events, double-entry transactions, and versioned economic
indicators. Exports are read-only operational artifacts and do not change the
simulation logical state hash.

## Public contract

- `POST /api/v1/simulations/{simId}/exports` accepts a run ID, one or more
  unique datasets, and `jsonl` or `csv`. The source run cannot be running and
  cannot have an active advance task or replay.
- `GET /api/v1/exports/{exportId}` returns the complete job, file and manifest
  checksums, row/byte counts, disclaimer, failure detail, and versioned audit
  chain.
- Job states are `queued -> running -> completed|failed`. A queued job may also
  fail before it starts. Illegal transitions are rejected by SQLite triggers.
- Every job pins `sourceTick` and `sourceStateHash`. The worker holds the normal
  run-operation lock and verifies both values before reading any dataset.

The exact disclaimer is stored in both the job and manifest:

> Simulated scenario data - not a prediction and not financial, legal, or political advice.

## Artifact format

Each dataset is materialized beneath its run directory as:

`exports/{exportId}/{dataset}-{sha256}.{jsonl|csv}`

The manifest is `exports/{exportId}/manifest.json`. Dataset names, formats,
relative paths, UTF-8 byte counts, row counts, and SHA-256 digests are validated
by the shared Zod contract. Files are written to a same-directory temporary
file, flushed, and atomically renamed. Existing content-addressed files are
accepted only when their bytes match exactly.

- JSONL uses one canonical-codec value per LF-terminated line.
- CSV uses fixed headers, LF line endings, and quotes every field. Nested event
  payloads and transaction legs use canonical JSON in their CSV cell.
- Events retain the complete versioned envelope and causal IDs in sequence
  order.
- Transactions retain authoritative enriched legs in transaction-ID order.
- Indicators retain tick, series, value, formula version, and canonical-input
  digest in `(tick, series)` order.

## Persistence and recovery

Migration 30 adds `export_jobs`, `export_files`, and `export_events`. Identity
fields and audit/file rows are immutable. Audit events use schema version 1 and
carry actor, correlation, causation, tick, and evidence. Export tables are
deliberately excluded from logical state-hash v22, while normal SQLite snapshots
and backups preserve them.

At startup the service scans for both queued and running jobs. A recovered
running job safely rematerializes content-addressed files and completes the
same database record; no new job or audit-start event is created. A checksum,
tick, status, or state-hash mismatch terminates the job with a typed failure and
never publishes it as completed.

## Verification

Coverage includes:

- strict request/job/manifest schemas and causal-chain rejection;
- migration-29 upgrade/reopen coverage for migration 30;
- atomic rollback, immutable triggers, reopen, logical-hash neutrality, and
  exact snapshot restore of job metadata;
- Fastify validation and response metadata;
- end-to-end JSONL and CSV generation against authoritative database counts;
- dataset and manifest checksum/byte verification, transaction re-summing,
  indicator evidence, event sequence ordering, and Windows file flushing;
- restart recovery from a persisted `running` job with an unchanged final
  logical state hash.

The ticket gate is:

```text
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
