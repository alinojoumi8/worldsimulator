# WS-802 - Investment proposal and bounded negotiation pipeline

Status: implemented on 2026-07-16.

## Delivered contract

- An active founder becomes eligible to pitch 30 ticks after company activation. Companies are considered in activation-tick and company-ID order, and at most one new pitch opens per tick.
- The pitch uses the company's founding capital as the maximum ask and a deterministic 4x pre-money valuation. It selects an authorized employed Foundry Capital partner and an open fund with enough undeployed capital.
- `investment.proposed` is a schema-versioned fact caused by the real `company.activated` event. It records the company, founder, firm, fund, partner, ask, valuation, exact initial equity basis points, proposal lifetime, and evidence.
- Proposal states are `proposed -> negotiating -> agreed | rejected | expired`. WS-802 deliberately stops at `agreed`; WS-803 owns the atomic cash, contract, share-issuance, and `investment.completed` close.

## Bounded Tier-3 negotiation

Investment is a first-class conversation topic alongside purchase and job. The engine offers only exact structured options containing:

```text
amountCents
preMoneyValuationCents
equityBasisPoints = round(amount * 10000 / (preMoney + amount))
```

Amount and valuation are bounded to 80-100% of the immutable pitch terms. The shared schema independently recomputes equity and permits at most one basis point of rounding tolerance. The conversation retains the existing hard limits: six turns, 4,096 aggregate output tokens, next-tick delivery, one opening per agent per tick, seven-tick same-pair/topic cooldown, strict alternation, exact engine-menu equality, and deterministic failure closure.

The existing provider-neutral Tier-3 route is used. The old backlog wording `opus routing` does not introduce a hard-coded provider or a new external integration.

Terminal conversation outcomes are revalidated against the proposal reference and bounds. A valid agreement emits `investment.proposal.agreed` and persists exact final terms. Decline, no agreement, escalation, or invalid terms emit `investment.rejected` with a typed reason. A conversation still active at the proposal's 14-tick deadline is closed with the explicit `expired` reason and rejected as `proposal_expired`.

Purchase/job negotiation binding ignores investment conversations; only the M10 proposal pipeline may consume them.

## Persistence and replay

- Migration 32 extends the conversation topic and close-reason constraints and adds authoritative `investment_proposals` rows with immutable pitch identity, guarded state transitions, causal event references, partner/company validation, and one active proposal per company.
- The migration rebuilds the conversation parent table with foreign keys temporarily disabled only around the atomic migration transaction, runs `foreign_key_check` before commit, and restores enforcement. A populated version-31 upgrade test proves existing conversations and relationship-history children survive.
- Logical state-hash v24 includes every proposal field and transition revision in canonical order.
- Outer-transaction failure rolls back proposal rows, conversation rows, events, and the logical hash together.
- Reopen and snapshot restore produce the same next expiry events, proposal state, memories, relationship effects, checkpoint, and final logical hash.

## Verification

Focused coverage includes exact equity math, malformed equity rejection, investment conversation schemas, deterministic option menus, forged-term rejection, proposal integration, causal events, agreement, typed expiry, atomic rollback, populated migration upgrade, reopen, and snapshot restore equivalence.

The final Windows ticket gate passed:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All 131 Vitest files and 691 tests were green. The full 360-tick scenario, strict replay, state/journal determinism, Phase 3/4 gates, and production dashboard build remained green. The build completed with the existing chunk-size advisory only.
