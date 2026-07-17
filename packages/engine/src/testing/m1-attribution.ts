/** Pure WS-508/M26 audit for persisted M1 and authorized supply channels. */

export const M1_SUPPLY_CHANNELS = ["mint", "lending", "repayment", "row"] as const;
export type M1SupplyChannel = (typeof M1_SUPPLY_CHANNELS)[number];

export interface M1AttributionLeg {
  readonly accountId: string;
  readonly ownerKind: string;
  readonly accountType: string;
  readonly direction: "debit" | "credit";
  readonly amountCents: string;
}

export interface M1AttributionTransaction {
  readonly id: string;
  readonly tick: number;
  readonly kind: string;
  readonly legs: readonly M1AttributionLeg[];
}

export interface M1AttributionEvent {
  readonly eventId: string;
  readonly tick: number;
  readonly transactionId: string;
  readonly kind: string;
}

export interface M1AttributionIndicatorPoint {
  readonly tick: number;
  readonly m1Cents: string;
  readonly treasuryBalanceCents: string;
}

export interface M1AttributionInput {
  readonly runId: string;
  readonly throughTick: number;
  readonly transactions: readonly M1AttributionTransaction[];
  readonly transactionEvents: readonly M1AttributionEvent[];
  readonly indicators: readonly M1AttributionIndicatorPoint[];
}

export type M1AttributionIssueCode =
  | "invalid_tick"
  | "invalid_amount"
  | "duplicate_transaction"
  | "missing_transaction_event"
  | "duplicate_transaction_event"
  | "orphan_transaction_event"
  | "event_tick_mismatch"
  | "event_kind_mismatch"
  | "unauthorized_supply_change"
  | "missing_indicator"
  | "duplicate_indicator"
  | "m1_indicator_mismatch"
  | "treasury_indicator_mismatch"
  | "unattributed_m1_delta";

export interface M1AttributionIssue {
  readonly code: M1AttributionIssueCode;
  readonly message: string;
  readonly tick: number | null;
  readonly transactionId: string | null;
  readonly eventId: string | null;
}

export interface M1TickAttribution {
  readonly tick: number;
  readonly recordedM1Cents: string;
  readonly ledgerM1Cents: string;
  readonly recordedTreasuryBalanceCents: string;
  readonly ledgerTreasuryBalanceCents: string;
  readonly observedM1DeltaCents: string;
  readonly ledgerM1DeltaCents: string;
  readonly treasuryDeltaCents: string;
  readonly treasuryReclassificationDeltaCents: string;
  readonly channelDeltasCents: Readonly<Record<M1SupplyChannel, string>>;
  readonly authorizedSupplyDeltaCents: string;
  readonly reconstructedM1DeltaCents: string;
  readonly unattributedM1DeltaCents: string;
  readonly transactionIds: readonly string[];
  readonly transactionEventIds: readonly string[];
}

export interface M1AttributionReport {
  readonly runId: string;
  readonly throughTick: number;
  readonly complete: boolean;
  readonly attributionRateBp: number;
  readonly ticksAudited: number;
  readonly transactionsAudited: number;
  readonly transactionEventsAudited: number;
  readonly materialSupplyTransactions: number;
  readonly eventedMaterialSupplyTransactions: number;
  readonly finalM1Cents: string;
  readonly finalTreasuryBalanceCents: string;
  readonly observedM1DeltaCents: string;
  readonly authorizedSupplyDeltaCents: string;
  readonly treasuryReclassificationDeltaCents: string;
  readonly reconstructedM1DeltaCents: string;
  readonly unattributedM1DeltaCents: string;
  readonly grossObservedM1ChangeCents: string;
  readonly grossUnattributedM1ChangeCents: string;
  readonly channelTotalsCents: Readonly<Record<M1SupplyChannel, string>>;
  readonly ticks: readonly M1TickAttribution[];
  readonly issues: readonly M1AttributionIssue[];
}

const CHANNEL_BY_TRANSACTION_KIND: Readonly<Record<string, M1SupplyChannel>> = {
  mint: "mint",
  loan_disbursement: "lending",
  loan_payment: "repayment",
  row_settlement: "row",
};

interface ComputedTransaction {
  readonly id: string;
  readonly tick: number;
  readonly channel: M1SupplyChannel | null;
  readonly m1Delta: bigint;
  readonly treasuryDelta: bigint;
  readonly domesticDelta: bigint;
  readonly eventIds: readonly string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyChannels(): Record<M1SupplyChannel, bigint> {
  return { mint: 0n, lending: 0n, repayment: 0n, row: 0n };
}

function stringifyChannels(
  channels: Readonly<Record<M1SupplyChannel, bigint>>,
): Readonly<Record<M1SupplyChannel, string>> {
  return {
    mint: channels.mint.toString(),
    lending: channels.lending.toString(),
    repayment: channels.repayment.toString(),
    row: channels.row.toString(),
  };
}

function sumChannels(channels: Readonly<Record<M1SupplyChannel, bigint>>): bigint {
  return channels.mint + channels.lending + channels.repayment + channels.row;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function issue(
  code: M1AttributionIssueCode,
  message: string,
  options: {
    readonly tick?: number;
    readonly transactionId?: string;
    readonly eventId?: string;
  } = {},
): M1AttributionIssue {
  return {
    code,
    message,
    tick: options.tick ?? null,
    transactionId: options.transactionId ?? null,
    eventId: options.eventId ?? null,
  };
}

function parseInteger(
  value: string,
  label: string,
  issues: M1AttributionIssue[],
  options: {
    readonly tick?: number;
    readonly transactionId?: string;
    readonly positive?: boolean;
  } = {},
): bigint {
  const pattern = options.positive === true ? /^[1-9]\d*$/ : /^-?\d+$/;
  if (!pattern.test(value)) {
    issues.push(issue("invalid_amount", `${label} is not a valid integer-cent amount`, options));
    return 0n;
  }
  return BigInt(value);
}

/**
 * Reconstruct M1 from immutable ledger legs and prove, at every tick, that:
 *
 * M1 delta = authorized domestic-supply delta - treasury deposit delta.
 *
 * Treasury is excluded from M1 v1, so the second term makes fiscal transfers an
 * explicit reclassification rather than mislabeling them as money creation.
 */
export function auditM1Attribution(input: M1AttributionInput): M1AttributionReport {
  const issues: M1AttributionIssue[] = [];
  const throughTick = Number.isSafeInteger(input.throughTick) && input.throughTick >= 0
    ? input.throughTick
    : 0;
  if (throughTick !== input.throughTick) {
    issues.push(issue("invalid_tick", "throughTick must be a nonnegative safe integer"));
  }

  const orderedEvents = [...input.transactionEvents].sort((left, right) => (
    left.tick - right.tick || compareCodeUnits(left.eventId, right.eventId)
  ));
  const eventsByTransaction = new Map<string, M1AttributionEvent[]>();
  for (const event of orderedEvents) {
    const matching = eventsByTransaction.get(event.transactionId) ?? [];
    matching.push(event);
    eventsByTransaction.set(event.transactionId, matching);
  }

  const orderedTransactions = [...input.transactions].sort((left, right) => (
    left.tick - right.tick || compareCodeUnits(left.id, right.id)
  ));
  const transactionIds = new Set<string>();
  const computedByTick = new Map<number, ComputedTransaction[]>();
  let materialSupplyTransactions = 0;
  let eventedMaterialSupplyTransactions = 0;

  for (const transaction of orderedTransactions) {
    if (transactionIds.has(transaction.id)) {
      issues.push(issue(
        "duplicate_transaction",
        `transaction ${transaction.id} appears more than once`,
        { tick: transaction.tick, transactionId: transaction.id },
      ));
      continue;
    }
    transactionIds.add(transaction.id);
    if (!Number.isSafeInteger(transaction.tick) || transaction.tick < 0 || transaction.tick > throughTick) {
      issues.push(issue(
        "invalid_tick",
        `transaction ${transaction.id} is outside tick 0..${throughTick}`,
        { tick: transaction.tick, transactionId: transaction.id },
      ));
      continue;
    }

    const matchingEvents = eventsByTransaction.get(transaction.id) ?? [];
    if (matchingEvents.length === 0) {
      issues.push(issue(
        "missing_transaction_event",
        `transaction ${transaction.id} has no transaction.posted event`,
        { tick: transaction.tick, transactionId: transaction.id },
      ));
    } else {
      if (matchingEvents.length > 1) {
        issues.push(issue(
          "duplicate_transaction_event",
          `transaction ${transaction.id} has ${matchingEvents.length} transaction.posted events`,
          {
            tick: transaction.tick,
            transactionId: transaction.id,
            eventId: matchingEvents[0]!.eventId,
          },
        ));
      }
      const evidence = matchingEvents[0]!;
      if (evidence.tick !== transaction.tick) {
        issues.push(issue(
          "event_tick_mismatch",
          `transaction ${transaction.id} tick ${transaction.tick} has event tick ${evidence.tick}`,
          {
            tick: transaction.tick,
            transactionId: transaction.id,
            eventId: evidence.eventId,
          },
        ));
      }
      if (evidence.kind !== transaction.kind) {
        issues.push(issue(
          "event_kind_mismatch",
          `transaction ${transaction.id} kind ${transaction.kind} has event kind ${evidence.kind}`,
          {
            tick: transaction.tick,
            transactionId: transaction.id,
            eventId: evidence.eventId,
          },
        ));
      }
    }

    let m1Delta = 0n;
    let treasuryDelta = 0n;
    for (const [legIndex, leg] of transaction.legs.entries()) {
      const amount = parseInteger(
        leg.amountCents,
        `transaction ${transaction.id} leg ${legIndex}`,
        issues,
        { tick: transaction.tick, transactionId: transaction.id, positive: true },
      );
      const delta = leg.direction === "debit" ? amount : -amount;
      if (leg.accountType !== "checking") continue;
      if (leg.ownerKind === "agent" || leg.ownerKind === "company") m1Delta += delta;
      else if (leg.ownerKind === "government") treasuryDelta += delta;
    }
    const domesticDelta = m1Delta + treasuryDelta;
    const channel = CHANNEL_BY_TRANSACTION_KIND[transaction.kind] ?? null;
    if (domesticDelta !== 0n) {
      materialSupplyTransactions += 1;
      if (matchingEvents.length > 0) eventedMaterialSupplyTransactions += 1;
      if (channel === null) {
        issues.push(issue(
          "unauthorized_supply_change",
          `transaction ${transaction.id} changed domestic deposits by ${domesticDelta} through ${transaction.kind}`,
          { tick: transaction.tick, transactionId: transaction.id },
        ));
      }
    }
    const rows = computedByTick.get(transaction.tick) ?? [];
    rows.push({
      id: transaction.id,
      tick: transaction.tick,
      channel,
      m1Delta,
      treasuryDelta,
      domesticDelta,
      eventIds: matchingEvents.map((event) => event.eventId),
    });
    computedByTick.set(transaction.tick, rows);
  }

  for (const event of orderedEvents) {
    if (transactionIds.has(event.transactionId)) continue;
    issues.push(issue(
      "orphan_transaction_event",
      `transaction.posted event ${event.eventId} references missing transaction ${event.transactionId}`,
      { tick: event.tick, transactionId: event.transactionId, eventId: event.eventId },
    ));
  }

  const indicatorByTick = new Map<number, M1AttributionIndicatorPoint>();
  for (const indicator of [...input.indicators].sort((left, right) => left.tick - right.tick)) {
    if (indicatorByTick.has(indicator.tick)) {
      issues.push(issue(
        "duplicate_indicator",
        `tick ${indicator.tick} has more than one M1/treasury indicator pair`,
        { tick: indicator.tick },
      ));
      continue;
    }
    indicatorByTick.set(indicator.tick, indicator);
  }

  const channelTotals = emptyChannels();
  const ticks: M1TickAttribution[] = [];
  let ledgerM1 = 0n;
  let ledgerTreasury = 0n;
  let previousRecordedM1 = 0n;
  let observedM1Total = 0n;
  let reconstructedM1Total = 0n;
  let grossObservedM1Change = 0n;
  let grossUnattributedM1Change = 0n;

  for (let tick = 0; tick <= throughTick; tick += 1) {
    const transactions = computedByTick.get(tick) ?? [];
    const tickChannels = emptyChannels();
    let ledgerM1Delta = 0n;
    let treasuryDelta = 0n;
    for (const transaction of transactions) {
      ledgerM1Delta += transaction.m1Delta;
      treasuryDelta += transaction.treasuryDelta;
      if (transaction.channel !== null) {
        tickChannels[transaction.channel] += transaction.domesticDelta;
        channelTotals[transaction.channel] += transaction.domesticDelta;
      }
    }
    ledgerM1 += ledgerM1Delta;
    ledgerTreasury += treasuryDelta;

    const indicator = indicatorByTick.get(tick);
    if (indicator === undefined) {
      issues.push(issue("missing_indicator", `tick ${tick} has no persisted M1/treasury pair`, { tick }));
    }
    const recordedM1 = indicator === undefined
      ? ledgerM1
      : parseInteger(indicator.m1Cents, `tick ${tick} M1`, issues, { tick });
    const recordedTreasury = indicator === undefined
      ? ledgerTreasury
      : parseInteger(
          indicator.treasuryBalanceCents,
          `tick ${tick} treasury balance`,
          issues,
          { tick },
        );
    if (recordedM1 !== ledgerM1) {
      issues.push(issue(
        "m1_indicator_mismatch",
        `tick ${tick} persisted M1 ${recordedM1} does not equal ledger M1 ${ledgerM1}`,
        { tick },
      ));
    }
    if (recordedTreasury !== ledgerTreasury) {
      issues.push(issue(
        "treasury_indicator_mismatch",
        `tick ${tick} persisted treasury ${recordedTreasury} does not equal ledger treasury ${ledgerTreasury}`,
        { tick },
      ));
    }

    const observedM1Delta = recordedM1 - previousRecordedM1;
    const authorizedSupplyDelta = sumChannels(tickChannels);
    const treasuryReclassificationDelta = -treasuryDelta;
    const reconstructedM1Delta = authorizedSupplyDelta + treasuryReclassificationDelta;
    const unattributedM1Delta = observedM1Delta - reconstructedM1Delta;
    if (unattributedM1Delta !== 0n) {
      issues.push(issue(
        "unattributed_m1_delta",
        `tick ${tick} leaves ${unattributedM1Delta} cents of its M1 delta unattributed`,
        { tick },
      ));
    }

    observedM1Total += observedM1Delta;
    reconstructedM1Total += reconstructedM1Delta;
    grossObservedM1Change += absolute(observedM1Delta);
    grossUnattributedM1Change += absolute(unattributedM1Delta);
    previousRecordedM1 = recordedM1;
    ticks.push({
      tick,
      recordedM1Cents: recordedM1.toString(),
      ledgerM1Cents: ledgerM1.toString(),
      recordedTreasuryBalanceCents: recordedTreasury.toString(),
      ledgerTreasuryBalanceCents: ledgerTreasury.toString(),
      observedM1DeltaCents: observedM1Delta.toString(),
      ledgerM1DeltaCents: ledgerM1Delta.toString(),
      treasuryDeltaCents: treasuryDelta.toString(),
      treasuryReclassificationDeltaCents: treasuryReclassificationDelta.toString(),
      channelDeltasCents: stringifyChannels(tickChannels),
      authorizedSupplyDeltaCents: authorizedSupplyDelta.toString(),
      reconstructedM1DeltaCents: reconstructedM1Delta.toString(),
      unattributedM1DeltaCents: unattributedM1Delta.toString(),
      transactionIds: transactions.map((transaction) => transaction.id),
      transactionEventIds: transactions.flatMap((transaction) => transaction.eventIds),
    });
  }

  const authorizedSupplyDelta = sumChannels(channelTotals);
  const treasuryReclassificationDelta = -ledgerTreasury;
  const unattributedM1Delta = observedM1Total - reconstructedM1Total;
  const creditedGrossChange = grossObservedM1Change > grossUnattributedM1Change
    ? grossObservedM1Change - grossUnattributedM1Change
    : 0n;
  const attributionRateBp = grossObservedM1Change === 0n
    ? 10_000
    : Number((creditedGrossChange * 10_000n) / grossObservedM1Change);

  return {
    runId: input.runId,
    throughTick,
    complete: issues.length === 0,
    attributionRateBp,
    ticksAudited: ticks.length,
    transactionsAudited: transactionIds.size,
    transactionEventsAudited: orderedEvents.length,
    materialSupplyTransactions,
    eventedMaterialSupplyTransactions,
    finalM1Cents: previousRecordedM1.toString(),
    finalTreasuryBalanceCents: ledgerTreasury.toString(),
    observedM1DeltaCents: observedM1Total.toString(),
    authorizedSupplyDeltaCents: authorizedSupplyDelta.toString(),
    treasuryReclassificationDeltaCents: treasuryReclassificationDelta.toString(),
    reconstructedM1DeltaCents: reconstructedM1Total.toString(),
    unattributedM1DeltaCents: unattributedM1Delta.toString(),
    grossObservedM1ChangeCents: grossObservedM1Change.toString(),
    grossUnattributedM1ChangeCents: grossUnattributedM1Change.toString(),
    channelTotalsCents: stringifyChannels(channelTotals),
    ticks,
    issues,
  };
}
