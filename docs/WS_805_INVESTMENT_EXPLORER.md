# WS-805 — Investment Explorer

Status: backend read slice implemented; browser UI and Phase 8 acceptance gate remain open as of 2026-07-18.

## Delivered read contract

Strict shared schemas and Fastify routes now expose authoritative WS-801 through WS-804 records:

- proposal list/detail, including resolved company, founder, firm, fund and partner names, bounded initial/final terms, conversation summary, rejection or validation evidence, and causal timeline;
- investment list/detail, including exact round identities, pre/post cap tables, linked distributions, contract/transaction/stake references, and the completion why-chain;
- company cap tables with discriminated agent and venture-fund holders; and
- distribution list/detail with exact beneficial-owner allocations and recipient accounts.

List reads use run-bound opaque cursors and stable `(tick,id)` ascending order. Every response is parsed against the shared contract and includes the standard simulated API metadata. The projection is read-only: it adds no migration, event, state-hash field, or replay mutation.

The company-detail projection now reads generalized ownership stakes, so a post-investment company response can represent a `venture_fund` holder without violating its Phase 4 contract.

## Implemented endpoints

```text
GET /api/v1/simulations/{simId}/investment-proposals
GET /api/v1/simulations/{simId}/investment-proposals/{proposalId}
GET /api/v1/simulations/{simId}/investments
GET /api/v1/simulations/{simId}/investments/{investmentId}
GET /api/v1/simulations/{simId}/companies/{companyId}/cap-table
GET /api/v1/simulations/{simId}/investment-distributions
GET /api/v1/simulations/{simId}/investment-distributions/{distributionId}
```

The exact query and response shapes live in [API contracts](API_CONTRACTS.md).

## Remaining before WS-805 closes

- Add proposal, investment, cap-table, distribution, and transcript views to the React World Explorer.
- Link the views through the existing company/institution navigation and keep the two-click causal explanation boundary.
- Add shared-contract client parsing plus component and production-shaped browser coverage.
- Run the Phase 8 gate with at least one explorable negotiated close in the default 360-tick world.

Until those items are complete, WS-805 and Phase 8 remain in progress and work should not advance to WS-901.

## Verification

The backend/documentation slice passed on 2026-07-18:

```text
pnpm typecheck   passed
pnpm lint        passed
pnpm test        passed: 133 files, 712 tests
pnpm build       passed: production bundle, 600.76 kB chunk advisory
pnpm test:e2e    passed: 1 Chromium path in explicit mock mode
```

The browser gate selects mock mode explicitly so deterministic CI never inherits the library's live MiniMax M3 default or requires provider credentials.
