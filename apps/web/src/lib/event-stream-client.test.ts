import { describe, expect, it, vi } from "vitest";
import { consumeEventStream, SseParser } from "./event-stream-client";

const digest = {
  v: 1,
  tick: 7,
  simDate: "Y0001-M01-D08",
  indicators: {},
  counts: {
    events: 3,
    transactions: 0,
    decisions: 0,
    llmCalls: 0,
    rejectedIntents: 0,
  },
  notable: [],
  spend: { budgetPct: 0 },
};

describe("SseParser", () => {
  it("handles split chunks, comments, and multiline data", () => {
    const parser = new SseParser();
    expect(parser.push(":hb\n\nid: 4\nevent: gap\nda")).toEqual([]);
    expect(parser.push("ta: {\"fromSeq\":2,\ndata: \"toSeq\":4}\n\n")).toEqual([
      { id: "4", event: "gap", data: "{\"fromSeq\":2,\n\"toSeq\":4}" },
    ]);
  });
});

describe("consumeEventStream", () => {
  it("sends auth/resume headers and validates delivered frames", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("last-event-id")).toBe("6");
      return new Response(`id: 7\nevent: digest\ndata: ${JSON.stringify(digest)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const frames: unknown[] = [];
    const result = await consumeEventStream({
      simulationId: "sim_00000001",
      runId: "run_00000001",
      token: "secret",
      lastEventId: 6,
      signal: new AbortController().signal,
      onOpen: vi.fn(),
      onFrame: (frame) => frames.push(frame),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toBe("ended");
    expect(frames).toEqual([{ id: 7, event: "digest", data: digest }]);
  });

  it("suspends cleanly on unauthorized responses", async () => {
    const result = await consumeEventStream({
      simulationId: "sim_00000001",
      token: "wrong",
      signal: new AbortController().signal,
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      fetchImpl: vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    expect(result).toBe("unauthorized");
  });
});
