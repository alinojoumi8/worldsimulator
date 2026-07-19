# ADR-0012 — Server-Sent Events for real-time updates

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

The dashboard must reflect a running simulation live (tick counter, indicators, notable events, errors). All client→server traffic (controls, queries) is naturally request/response — and must be journaled as commands anyway (ADR-0003). Evaluated: WebSockets, SSE, polling (full comparison in API_CONTRACTS §3.1).

## Decision

**SSE** (`GET /api/v1/simulations/{id}/stream`) for MVP:

- One-way server→client matches the actual data flow; commands stay on REST where they are journaled uniformly.
- The browser uses `fetch` plus `ReadableStream`, not native `EventSource`, so both bearer authorization and `Last-Event-ID` can be sent as headers. A small parser handles split chunks, comments, and multiline data.
- SSE `id` is the committed event-log `seq`. The client remembers the last delivered ID in memory, reconnects with bounded exponential backoff, and stops in `auth-required` state on 401.
- The durable status projection supplies `activity.latestEventSeq` and `activity.latestDigest`. The first connection starts at that sequence, later reconnects use the last delivered ID, and terminal runs stop reconnecting while continuing to render the durable digest.
- **Digest discipline:** v0 exposes only `digest`, `lifecycle`, and server-generated `gap` frames. One digest follows each committed tick; it contains honest empty indicator/notable fields until owning modules exist. Raw events remain available through REST rather than flooding the stream.
- Lagging clients receive `{fromSeq,toSeq}` in a `gap` frame and invalidate the simulation, status, list, and event-ledger queries. Compression buffering is disabled; the server writes `:connected` immediately and `:hb` defaults to 15 seconds. Both are comment frames and consume no event sequence.
- All public frames are validated against the shared Zod discriminated union before reaching React state.

## Alternatives considered

- **Native `EventSource`:** convenient automatic retry, but its constructor cannot attach the optional bearer header required by ADR-0011. A token in the query string would leak through URLs and logs.
- **WebSockets:** bidirectional capability we don't need; hand-rolled reconnect/heartbeat/resume; would tempt un-journaled command paths. Revisit for collaborative admin or an interactive "talk to an agent" console.
- **Polling:** simplest, and retained as the documented degraded fallback (`GET /status` + `fromTick` deltas on explorers), but per-tick latency/overhead makes it a poor primary at 1s-tick rates.
- **HTTP/1.1 connection cap:** acceptable for the local MVP because each dashboard tab opens one stream. A reverse proxy with HTTP/2 can be added if multi-tab or multi-user deployment makes this material.

## Consequences

- Frontend real-time code includes a tested fetch-stream parser, a bounded retry hook, and TanStack Query invalidation on lifecycle/gap frames.
- Digest, lifecycle, and gap schemas are versioned contracts in `packages/shared` and documented in API_CONTRACTS §3.2.
- Future `news`, `errors`, `market`, and `policy` topics extend the union with their owning modules; clients must not assume they exist today.
- If bidirectional needs appear, WebSockets can be added *alongside* SSE without breaking existing clients.
