# Guided causal user test

WorldTangle is ready for a controlled design-partner test around one short,
deterministic task. It is not an open-ended public or multi-tenant release.

## Test brief

> Inject one fuel-price shock, follow the committed evidence into CPI, and copy
> the receipt.

The default **Guided causal test** uses mock decisions, seed 42, and a 31-tick
end condition. It needs no provider credentials and incurs no model cost.
Seed, end tick, token budget, and cost guardrail remain available under
**Advanced reproducibility and budget**. The guided decision mode is locked to
mock; switch to the custom form to opt into Live MiniMax. Live mode is outside
this usability study.

Ask each tester to:

1. Start the guided causal test from the simulation library.
2. Schedule the locked 30% fuel-price intervention before starting the run.
3. Reload the page and confirm the handoff still identifies the intervention
   and one safe next action.
4. Start, pause, and resume the run by following the handoff strip.
5. Confirm that the intervention, committed state effect, and post-shock CPI
   observation become booked.
6. Open the causal record and distinguish stored evidence from pending,
   no-effect, or broken-link states.
7. Copy the reproducibility receipt and paste it into the feedback report.

The intended session is about 90 seconds on a normal local setup, although
hardware and server load can change wall-clock duration.

## What to observe

Do not coach the tester past the brief unless they are blocked. Record:

- whether they understand that every result is simulated;
- the first control or label they hesitate over;
- whether the single safe next action matches what they expect;
- whether origin → booked state → downstream observation is understandable;
- whether they can explain the difference between observed evidence and an
  interpretation;
- whether reload recovery feels trustworthy; and
- whether the copied receipt is sufficient to describe the run without a
  screenshot.

For a bug report, collect the receipt, the last visible safe action, what the
tester expected, and what occurred. The receipt contains the simulation/run,
mode, seed, intervention and catalog version, tick range, causal event range,
latest committed event, and replay instruction.

## Evidence and safety boundaries

- **Booked** means a matching authoritative record was found.
- **Pending** means the origin exists but the expected stored record is not yet
  available.
- **No effect** means the causal chain reached a terminal point without that
  observed record.
- **Broken link** means the requested origin or required explicit reference is
  missing.

A shared correlation ID is not, by itself, proof of causality. Evidence paths
deep-link to exact entities and ticks and retain raw IDs beside plain-language
labels.

All pages identify the output as a simulated scenario, not financial, legal,
political, or real-world advice or prediction.

## Broader exploration

After the guided test, researchers may use the World Explorer, News and Replay,
Observability, and the completed Phase 8 Investment Explorer. The investment
views expose proposal terms, negotiation summary, booked cash/contract/stake
evidence, before/after cap tables, current ownership, distributions, and the
same explicit evidence states.

Phase 9 securities-market work has not started. Do not describe exchange,
trading, IPO, or order-book experiences as available.
