# Local operation and live model runs

## Install and start

Prerequisites are Node 22 or newer (Node 24 is the CI reference) and pnpm 11.6.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Development serves the dashboard at `http://127.0.0.1:5173` and the API at `http://127.0.0.1:4000`. For the production-shaped local path:

```bash
pnpm build
pnpm start
```

The built dashboard and API then share `http://127.0.0.1:4000`.

Both server entry points automatically load an existing repository-root `.env` through Node's `--env-file-if-exists` option. Copy names from `.env.example`; never commit `.env` or provider keys. Test and gate commands do not load the file automatically.

## Live and mock creation

The dashboard's create form defaults to:

- live mode, with Tier 2 routed to `MiniMax-M3`;
- seed 42 and a 360-tick end boundary;
- a 500-cent run-cost ceiling; and
- 128,000 per-agent daily tokens.

Select **Mock · deterministic** when an offline, repeatable run is desired. Mock mode performs no provider requests. CLI examples in the root README deliberately use mock mode for the same reason.

Live mode requires `MINIMAX_API_KEY` or `MINIMAX_TOKEN_PLAN_KEY`. Tier-3 conversations route to Kimi only when one is opened; `KIMI_API_KEY` selects the Kimi Code route and `MOONSHOT_API_KEY` selects the Moonshot Open Platform route. The exact routing and price-pin variables are documented in `.env.example` and [WS-601 provider evidence](WS_601_MINIMAX_KIMI_PROVIDERS.md).

A run manifest pins `off`, `mock`, or `live` at creation. Adding a key or restarting the server does not convert an existing mock run into a live run; create a new live simulation. If a live provider is unavailable or returns invalid output, the bounded decision path records the failure and uses the deterministic fallback instead of allowing provider output to mutate state directly.

## Verify the runtime

1. Open the simulation's **Run details** card and confirm `LLM mode` is `live` for the newly created run.
2. Open **Observability** and inspect the immutable call ledger. A real attempt records provider, model, attempts, input/cached-input/output tokens, latency, exact cost, and success or fallback evidence.
3. Check `GET /api/v1/simulations/{simId}/status`. Its `activity` object reports the durable committed-event total, latest sequence, and latest committed-tick digest even after a run becomes terminal.
4. The dashboard tails SSE from `activity.latestEventSeq`; terminal runs stop reconnecting and display **Durable snapshot** instead.

The server emits an immediate `:connected` SSE comment so proxies expose the established response before the first event or heartbeat. Comments are transport signals only and do not consume event sequences.

## Optional API token

Set `WORLDTANGLE_API_TOKEN` to protect `/api/v1/*` except health. Enter the same value through the dashboard's **API token** control. The browser stores it only in `sessionStorage`; it is never added to URLs or persistent browser storage.

## Verification commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The explicitly authorized live acceptance commands also load `.env`, but require their separate confirmation variables. See [WS-609](WS_609_LIVE_BUDGET_ACCEPTANCE.md) and [WS-610](WS_610_LLM_PARITY.md); ordinary development does not imply consent for those acceptance runs.
