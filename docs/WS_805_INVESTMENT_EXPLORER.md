# WS-805 — Investment Explorer

Status: complete as of 2026-07-24. Phase 8 is accepted.

## Delivered experience

The World Explorer now has a complete read-only investment section backed by
authoritative WS-801 through WS-804 records:

- proposal list/detail, including resolved company, founder, firm, fund and partner names, bounded initial/final terms, conversation summary, rejection or validation evidence, and causal timeline;
- investment list/detail, including exact round identities, pre/post cap tables, linked distributions, contract/transaction/stake references, and the completion why-chain;
- company cap tables with discriminated agent and venture-fund holders; and
- distribution list/detail with exact beneficial-owner allocations and recipient accounts.

React routes expose the proposal pipeline, exact term changes, booked
investment, before/after dilution, current ownership, and distribution
allocations. Company pages link directly to their cap table; investment records
link back to their proposal and forward to current ownership. Every screen keeps
the simulated-evidence boundary visible.

List reads use run-bound opaque cursors and stable `(tick,id)` ascending order.
The typed web client parses every response against the shared contract. The
projection remains read-only: it adds no migration, event, state-hash field, or
replay mutation.

The company-detail projection now reads generalized ownership stakes, so a post-investment company response can represent a `venture_fund` holder without violating its Phase 4 contract.

## Causal evidence path

The shared `EvidencePath` contract and read-only resolver expose three explicit
lanes: origin, booked state, and downstream observation. Each lane reports one
of `booked`, `pending`, `no_effect`, or `broken_link`; it never treats a shared
correlation ID as proof by itself.

The resolver joins persisted event/causation references with exact ledger
transactions, cap-table records, proposals, investments, distributions,
domain-state effects, and cited news. Every returned item keeps its entity,
event, correlation, and tick references so the React path can deep-link to the
stored record.

## Implemented API and React routes

```text
GET /api/v1/simulations/{simId}/investment-proposals
GET /api/v1/simulations/{simId}/investment-proposals/{proposalId}
GET /api/v1/simulations/{simId}/investments
GET /api/v1/simulations/{simId}/investments/{investmentId}
GET /api/v1/simulations/{simId}/companies/{companyId}/cap-table
GET /api/v1/simulations/{simId}/investment-distributions
GET /api/v1/simulations/{simId}/investment-distributions/{distributionId}
GET /api/v1/simulations/{simId}/evidence-paths/{correlationId}

/simulations/{simId}/world/investments
/simulations/{simId}/investment-proposals/{proposalId}
/simulations/{simId}/investments/{investmentId}
/simulations/{simId}/companies/{companyId}/cap-table
/simulations/{simId}/investment-distributions/{distributionId}
```

The exact query and response shapes live in [API contracts](API_CONTRACTS.md).

## Phase 8 acceptance

The production-shaped Chromium gate creates the default seed-42, 360-tick mock
world, exercises lifecycle controls, advances through the public API contract,
and then traverses the rendered UI from a completed proposal to its booked
investment, exact before/after cap tables, three-lane causal evidence, and
current ownership. The accepted world contains three proposals and two
completed investments. No provider credentials or live cost are involved.

Focused contract, resolver, component, and route tests cover the four evidence
states, malformed/missing links, run-bound parsing, exact cap-table rendering,
and proposal-to-investment navigation. Current repository-wide command results
are recorded in [Project Status](PROJECT_STATUS.md).
