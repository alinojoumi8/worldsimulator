# ADR-0011 — Local-first auth: none by default, optional bearer token; in-engine capability model

**Status:** accepted, amended · **Date:** 2026-07-14 · **Amended:** 2026-07-18

## Context

MVP is a single-user research tool on the owner's machine. Building accounts/sessions now would be pure overhead — but two *distinct* authorization problems exist and must not be conflated: (a) who may call the HTTP API, and (b) which **simulated actor** may perform which **simulated action**.

## Decision

- **HTTP (a):** the server binds `127.0.0.1` by default. No auth is applied when `WORLDTANGLE_API_TOKEN` is unset. When set, every `/api/v1/*` route except `GET /api/v1/health` requires an exact `Authorization: Bearer <token>` header and returns RFC 9457 `UNAUTHORIZED` on failure. Built dashboard routes (`/`, `/simulations/:simId`, and static assets) stay public so the shell can load and collect the token. Full sessions/OIDC and roles are deferred; 403 is reserved for that later authorization layer.
- **Browser token handling:** the React shell stores an optional token under `worldtangle.api-token` in `sessionStorage` only, attaches it to REST and fetch-stream SSE requests, and clears/revalidates cached queries when it changes. It is never placed in a URL, cookie, or persistent local storage.
- **Simulation capability model (b):** every engine intent carries an `actor`; validators check self-actions, ownership, household scope, and offices held. This remains domain logic, not HTTP auth, and is the defense against illegal LLM-proposed actions (INV-10).

## Alternatives considered

- **Full user auth now:** zero users besides the owner; slows every endpoint's development.
- **No plan at all ("add auth later somehow"):** the API-only guard and problem+json 401 semantics prevent accidental exposure without forcing user accounts into the local MVP.
- **Conflating API auth with agent permissions:** category error — an authenticated human still must not make agent A spend agent B's money.

## Consequences

- Localhost-only by default; exposing the server is an explicit opt-in (`WORLDTANGLE_BIND=0.0.0.0` + token required — startup refuses a non-loopback bind without one).
- Static UI files are not secrets. API data and controls remain behind the optional guard, including SSE.
- Capability checks are hot-path validation code with dedicated adversarial and authority tests.
- Multi-user (LATER) adds: users, per-simulation ownership, read-only sharing — on top of, not instead of, this model.
