import { describe, expect, it } from "vitest";
import {
  auditM1Attribution,
  type M1AttributionInput,
  type M1AttributionLeg,
  type M1AttributionTransaction,
} from "./m1-attribution";

function leg(
  accountId: string,
  ownerKind: string,
  direction: "debit" | "credit",
  amountCents: string,
  accountType = "checking",
): M1AttributionLeg {
  return { accountId, ownerKind, accountType, direction, amountCents };
}

function transaction(
  id: string,
  tick: number,
  kind: string,
  legs: readonly M1AttributionLeg[],
): M1AttributionTransaction {
  return { id, tick, kind, legs };
}

function event(transactionRow: M1AttributionTransaction) {
  return {
    eventId: `evt_${transactionRow.id}`,
    tick: transactionRow.tick,
    transactionId: transactionRow.id,
    kind: transactionRow.kind,
  };
}

describe("WS-508 M1 attribution", () => {
  it("reconstructs every M1 delta from supply channels and treasury reclassification", () => {
    const transactions = [
      transaction("mint_private", 0, "mint", [
        leg("private", "agent", "debit", "100"),
        leg("mint-source", "bank_internal", "credit", "100", "equity"),
      ]),
      transaction("mint_treasury", 0, "mint", [
        leg("treasury", "government", "debit", "20"),
        leg("mint-source", "bank_internal", "credit", "20", "equity"),
      ]),
      transaction("tax", 1, "tax", [
        leg("private", "agent", "credit", "10"),
        leg("treasury", "government", "debit", "10"),
      ]),
      transaction("row-import", 2, "row_settlement", [
        leg("private", "agent", "credit", "5"),
        leg("row", "system_row", "debit", "5"),
      ]),
      transaction("loan", 3, "loan_disbursement", [
        leg("private", "agent", "debit", "30"),
        leg("loan-source", "bank_internal", "credit", "30", "internal_liability"),
      ]),
      transaction("repayment", 4, "loan_payment", [
        leg("private", "agent", "credit", "8"),
        leg("loan-source", "bank_internal", "debit", "8", "internal_liability"),
      ]),
    ] as const;
    const report = auditM1Attribution({
      runId: "run_exact",
      throughTick: 4,
      transactions,
      transactionEvents: transactions.map(event),
      indicators: [
        { tick: 0, m1Cents: "100", treasuryBalanceCents: "20" },
        { tick: 1, m1Cents: "90", treasuryBalanceCents: "30" },
        { tick: 2, m1Cents: "85", treasuryBalanceCents: "30" },
        { tick: 3, m1Cents: "115", treasuryBalanceCents: "30" },
        { tick: 4, m1Cents: "107", treasuryBalanceCents: "30" },
      ],
    });

    expect(report).toMatchObject({
      complete: true,
      attributionRateBp: 10_000,
      ticksAudited: 5,
      transactionsAudited: 6,
      transactionEventsAudited: 6,
      materialSupplyTransactions: 5,
      eventedMaterialSupplyTransactions: 5,
      finalM1Cents: "107",
      finalTreasuryBalanceCents: "30",
      observedM1DeltaCents: "107",
      authorizedSupplyDeltaCents: "137",
      treasuryReclassificationDeltaCents: "-30",
      reconstructedM1DeltaCents: "107",
      unattributedM1DeltaCents: "0",
      grossObservedM1ChangeCents: "153",
      grossUnattributedM1ChangeCents: "0",
      channelTotalsCents: {
        mint: "120",
        lending: "30",
        repayment: "-8",
        row: "-5",
      },
      issues: [],
    });
    expect(report.ticks[1]).toMatchObject({
      observedM1DeltaCents: "-10",
      treasuryDeltaCents: "10",
      treasuryReclassificationDeltaCents: "-10",
      authorizedSupplyDeltaCents: "0",
      reconstructedM1DeltaCents: "-10",
    });
  });

  it("finds a deposit change that bypasses every authorized channel", () => {
    const rogue = transaction("rogue", 0, "transfer", [
      leg("private", "agent", "debit", "10"),
      leg("internal", "bank_internal", "credit", "10", "equity"),
    ]);
    const report = auditM1Attribution({
      runId: "run_rogue",
      throughTick: 0,
      transactions: [rogue],
      transactionEvents: [event(rogue)],
      indicators: [{ tick: 0, m1Cents: "10", treasuryBalanceCents: "0" }],
    });

    expect(report.complete).toBe(false);
    expect(report.attributionRateBp).toBe(0);
    expect(report.unattributedM1DeltaCents).toBe("10");
    expect(report.issues.map((entry) => entry.code)).toEqual([
      "unauthorized_supply_change",
      "unattributed_m1_delta",
    ]);
  });

  it("requires exact persisted indicators and one evidence event per transaction", () => {
    const minted = transaction("minted", 0, "mint", [
      leg("private", "agent", "debit", "10"),
      leg("internal", "bank_internal", "credit", "10", "equity"),
    ]);
    const input: M1AttributionInput = {
      runId: "run_bad_evidence",
      throughTick: 0,
      transactions: [minted],
      transactionEvents: [],
      indicators: [{ tick: 0, m1Cents: "11", treasuryBalanceCents: "0" }],
    };
    const report = auditM1Attribution(input);

    expect(report.complete).toBe(false);
    expect(report.materialSupplyTransactions).toBe(1);
    expect(report.eventedMaterialSupplyTransactions).toBe(0);
    expect(report.issues.map((entry) => entry.code)).toEqual([
      "missing_transaction_event",
      "m1_indicator_mismatch",
      "unattributed_m1_delta",
    ]);
  });
});
