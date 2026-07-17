/** Test-only WS-508 adapter from authoritative SQLite rows to the pure M26 audit. */

import { canonicalParse, EngineError } from "@worldtangle/shared";
import type {
  M1AttributionEvent,
  M1AttributionIndicatorPoint,
  M1AttributionInput,
  M1AttributionLeg,
  M1AttributionTransaction,
} from "@worldtangle/engine";
import { toSafeNumber, type WorldDatabase } from "../persistence/database";

interface RunRow {
  readonly current_tick: bigint;
}

interface TransactionRow {
  readonly id: string;
  readonly tick: bigint;
  readonly kind: string;
}

interface LegRow {
  readonly transaction_id: string;
  readonly account_id: string;
  readonly owner_kind: string;
  readonly account_type: string;
  readonly direction: "debit" | "credit";
  readonly amount_cents: string;
}

interface EventRow {
  readonly event_id: string;
  readonly tick: bigint;
  readonly payload_canonical: string;
}

interface IndicatorRow {
  readonly tick: bigint;
  readonly indicator_key: "m1_cents" | "treasury_balance_cents";
  readonly value_integer: string;
}

function eventPayload(row: EventRow): Readonly<Record<string, unknown>> {
  const payload = canonicalParse(row.payload_canonical);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new EngineError("CONFLICT", `transaction event ${row.event_id} payload is not an object`);
  }
  return payload as Readonly<Record<string, unknown>>;
}

export function readRunM1AttributionInput(
  db: WorldDatabase,
  runId: string,
): M1AttributionInput {
  const run = db.prepare<[string], RunRow>(`
    SELECT current_tick FROM simulation_runs WHERE id = ?
  `).get(runId);
  if (run === undefined) throw new EngineError("NOT_FOUND", `run ${runId} does not exist`);

  const legsByTransaction = new Map<string, M1AttributionLeg[]>();
  const legRows = db.prepare<[string], LegRow>(`
    SELECT
      leg.transaction_id,
      leg.account_id,
      account.owner_kind,
      account.account_type,
      leg.direction,
      leg.amount_cents
    FROM ledger_transaction_legs leg
    JOIN ledger_transactions txn
      ON txn.run_id = leg.run_id AND txn.id = leg.transaction_id
    JOIN bank_accounts account
      ON account.run_id = leg.run_id AND account.id = leg.account_id
    WHERE leg.run_id = ?
    ORDER BY txn.tick, txn.id, leg.leg_index
  `).all(runId);
  for (const row of legRows) {
    const legs = legsByTransaction.get(row.transaction_id) ?? [];
    legs.push({
      accountId: row.account_id,
      ownerKind: row.owner_kind,
      accountType: row.account_type,
      direction: row.direction,
      amountCents: row.amount_cents,
    });
    legsByTransaction.set(row.transaction_id, legs);
  }

  const transactions: readonly M1AttributionTransaction[] = db.prepare<
    [string],
    TransactionRow
  >(`
    SELECT id, tick, kind
    FROM ledger_transactions
    WHERE run_id = ?
    ORDER BY tick, id
  `).all(runId).map((row) => ({
    id: row.id,
    tick: toSafeNumber(row.tick, `transaction ${row.id} tick`),
    kind: row.kind,
    legs: legsByTransaction.get(row.id) ?? [],
  }));

  const transactionEvents: readonly M1AttributionEvent[] = db.prepare<
    [string],
    EventRow
  >(`
    SELECT event_id, tick, payload_canonical
    FROM events
    WHERE run_id = ? AND type = 'transaction.posted'
    ORDER BY tick, seq
  `).all(runId).map((row) => {
    const payload = eventPayload(row);
    const transactionId = payload["transactionId"];
    const kind = payload["kind"];
    if (typeof transactionId !== "string" || typeof kind !== "string") {
      throw new EngineError(
        "CONFLICT",
        `transaction event ${row.event_id} lacks transactionId or kind`,
      );
    }
    return {
      eventId: row.event_id,
      tick: toSafeNumber(row.tick, `transaction event ${row.event_id} tick`),
      transactionId,
      kind,
    };
  });

  const indicatorValues = new Map<number, Partial<Record<IndicatorRow["indicator_key"], string>>>();
  const indicatorRows = db.prepare<[string], IndicatorRow>(`
    SELECT tick, indicator_key, value_integer
    FROM indicator_points
    WHERE run_id = ?
      AND indicator_key IN ('m1_cents', 'treasury_balance_cents')
    ORDER BY tick, indicator_key
  `).all(runId);
  for (const row of indicatorRows) {
    const tick = toSafeNumber(row.tick, "indicator tick");
    const values = indicatorValues.get(tick) ?? {};
    values[row.indicator_key] = row.value_integer;
    indicatorValues.set(tick, values);
  }
  const indicators: M1AttributionIndicatorPoint[] = [];
  for (const [tick, values] of [...indicatorValues].sort((left, right) => left[0] - right[0])) {
    if (values.m1_cents === undefined || values.treasury_balance_cents === undefined) continue;
    indicators.push({
      tick,
      m1Cents: values.m1_cents,
      treasuryBalanceCents: values.treasury_balance_cents,
    });
  }

  return {
    runId,
    throughTick: toSafeNumber(run.current_tick, "run current tick"),
    transactions,
    transactionEvents,
    indicators,
  };
}
