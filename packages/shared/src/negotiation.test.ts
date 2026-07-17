import { describe, expect, it } from "vitest";
import { conversationBindingSchema } from "./negotiation";

const base = {
  id: "cnb_00000001",
  runId: "run_00000001",
  conversationId: "cnv_00000001",
  topic: "purchase" as const,
  structuredTerms: {
    kind: "purchase" as const,
    referenceId: "off_00000001",
    quantity: 2,
    unitPriceCents: "400",
  },
  domainReferenceId: "off_00000001",
  bindingTick: 10,
  evidenceEventIds: ["evt_00000001", "evt_00000002"],
  sourceEventId: "evt_00000002",
};

describe("conversation binding schema", () => {
  it("accepts an exact successful domain result", () => {
    expect(conversationBindingSchema.parse({
      ...base,
      status: "bound",
      resultKind: "goods_order",
      resultId: "gord_00000001",
      rejectionReason: null,
    })).toMatchObject({ status: "bound", resultKind: "goods_order" });
  });

  it("accepts a rejected agreement without claiming a domain result", () => {
    expect(conversationBindingSchema.parse({
      ...base,
      status: "rejected",
      resultKind: null,
      resultId: null,
      rejectionReason: "price_changed",
    })).toMatchObject({ status: "rejected", rejectionReason: "price_changed" });
  });

  it("rejects topic/result mismatches and duplicate evidence", () => {
    expect(() => conversationBindingSchema.parse({
      ...base,
      status: "bound",
      resultKind: "employment",
      resultId: "emp_00000001",
      rejectionReason: null,
    })).toThrow(/result kind/i);
    expect(() => conversationBindingSchema.parse({
      ...base,
      status: "rejected",
      resultKind: null,
      resultId: null,
      rejectionReason: "price_changed",
      evidenceEventIds: ["evt_00000001", "evt_00000001"],
    })).toThrow(/unique/i);
  });
});
