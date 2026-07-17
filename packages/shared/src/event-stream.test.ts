import { describe, expect, it } from "vitest";
import {
  digestStreamDataSchema,
  eventStreamFrameSchema,
  gapStreamDataSchema,
  lifecycleStreamDataSchema,
} from "./event-stream";

describe("event stream contracts", () => {
  it("accepts the current digest payload without fabricated indicators", () => {
    expect(
      digestStreamDataSchema.parse({
        v: 1,
        tick: 12,
        simDate: "Y0001-M01-D13",
        indicators: {},
        counts: {
          events: 4,
          transactions: 0,
          decisions: 0,
          llmCalls: 0,
          rejectedIntents: 0,
        },
        notable: [],
        spend: { budgetPct: 0 },
      }),
    ).toMatchObject({ tick: 12, indicators: {} });
  });

  it("accepts lifecycle frames and rejects malformed IDs", () => {
    const data = {
      v: 1,
      eventId: "evt_0000000a",
      type: "simulation.paused",
      simulationId: "sim_00000001",
      runId: "run_00000001",
      status: "paused",
      tick: 3,
      simDate: "Y0001-M01-D04",
      wallTime: "2026-07-14T12:00:00.000Z",
      correlationId: "request-1",
    } as const;
    expect(lifecycleStreamDataSchema.safeParse(data).success).toBe(true);
    expect(
      eventStreamFrameSchema.safeParse({ id: 10, event: "lifecycle", data }).success,
    ).toBe(true);
    expect(
      lifecycleStreamDataSchema.safeParse({ ...data, runId: "not-a-run" }).success,
    ).toBe(false);
  });

  it("requires ordered inclusive gap ranges", () => {
    expect(gapStreamDataSchema.parse({ fromSeq: 4, toSeq: 9 })).toEqual({
      fromSeq: 4,
      toSeq: 9,
    });
    expect(gapStreamDataSchema.safeParse({ fromSeq: 9, toSeq: 4 }).success).toBe(false);
  });
});
