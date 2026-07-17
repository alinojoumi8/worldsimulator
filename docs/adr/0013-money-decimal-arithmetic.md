# ADR-0013 — Money as bigint minor units; fixed-point rates; no floats

**Status:** accepted · **Date:** 2026-07-14

## Context

Every financial invariant (INV-1..6) demands exact arithmetic: balanced postings, conserved money, amortization schedules that sum precisely. IEEE-754 floats cannot represent 0.01; "round at display time" strategies leak cents that compound over 360-tick runs into conservation violations.

## Decision

- **Amounts:** integer **minor units (cents)** as native `bigint`. SQLite stores INTEGER (i64) with `defaultSafeIntegers` round-tripping; JSON serializes amounts as **strings** via the canonical codec.
- **Rates & ratios:** fixed-point **basis points** (int; 1bp = 0.01%) for interest/tax rates; where finer resolution is needed (pass-through factors), scaled integers with declared scale.
- **Operations** (in `packages/shared/money.ts`, the only permitted math for money):
  - `add/sub` (bigint native);
  - `mulDiv(amount, num, den, mode)` — the single place rational math meets rounding; modes: `HALF_EVEN` (banker's, default for interest/tax), `FLOOR`/`CEIL` for explicitly-directed cases;
  - `allocate(amount, weights)` — largest-remainder method: parts always sum **exactly** to the input (payroll splits, pro-rata distributions);
  - amortization: per-installment interest = `mulDiv(outstanding, rateBp, 12·10000, HALF_EVEN)`; the **final installment absorbs residual cents** so Σ principal = principal exactly.
- **Bans:** no `number` arithmetic on money anywhere (lint: money types are branded; implicit conversion is a type error); no float intermediate steps; no percentage floats in configs (bp integers only).
- Property tests (fast-check) guard: allocation sum-exactness, mulDiv bounds, schedule totals, conservation across arbitrary op sequences.

## Alternatives considered

- **decimal.js / big.js:** correct but ambient rounding config and mixed-type footguns; slower; another dependency where bigint is native and faster.
- **Floats with epsilon comparisons:** epsilon-tuned accounting is a contradiction; drift compounds silently.
- **Storing dollars as DECIMAL strings in SQLite:** loses cheap integer aggregation and invites accidental float parsing.

## Consequences

- `JSON.stringify` throws on bigint → the canonical codec (ADR-0008) is mandatory everywhere, which we want anyway for hashing.
- Division is always explicit about rounding — verbose, and exactly the point (auditable rounding decisions).
- Multi-currency (LATER) = amounts carry a currency tag; the math layer is already unit-agnostic.
