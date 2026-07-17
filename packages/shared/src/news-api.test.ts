import { describe, expect, it } from "vitest";
import {
  newsListQuerySchema,
  newsListResponseSchema,
  newsStoryDetailResponseSchema,
} from "./news";

const meta = { simulated: true, apiVersion: 1 } as const;
const fact = {
  eventId: "evt_00000001",
  eventFactHash: "a".repeat(64),
  eventType: "company.activated",
  tick: 30,
  simDate: "Y0001-M02-D01",
  actor: { kind: "institution", id: "co_00000001" },
  correlationId: "formation-co_00000001",
  payload: { companyId: "co_00000001" },
} as const;

describe("news read API contracts", () => {
  it("defaults and bounds the published-feed query", () => {
    expect(newsListQuerySchema.parse({ runId: "run_00000001" })).toEqual({
      runId: "run_00000001",
      limit: 25,
    });
    expect(newsListQuerySchema.safeParse({ fromTick: 5, toTick: 4 }).success).toBe(false);
    expect(newsListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("requires canonical sentiment-topic ordering and tick ordering", () => {
    const response = {
      items: [{
        id: "nws_00000001",
        tick: 31,
        sourceTick: 30,
        headline: "Riverbend company opens",
        topic: "economy",
        stance: 1,
        reach: 40,
        author: { id: "agt_00000001", name: "Ada Reed" },
        org: { id: "norg_00000001", name: "Riverbend Ledger" },
        citedEventIds: [fact.eventId],
        sourceEventId: "evt_00000002",
      }],
      nextCursor: null,
      sentiment: [
        { topic: "economy", points: [[1, 10], [31, 30]] },
        { topic: "employment", points: [] },
        { topic: "institutions", points: [[31, -20]] },
      ],
      meta,
    } as const;
    expect(newsListResponseSchema.parse(response).items[0]?.headline)
      .toBe("Riverbend company opens");
    expect(newsListResponseSchema.safeParse({
      ...response,
      sentiment: [response.sentiment[1], response.sentiment[0], response.sentiment[2]],
    }).success).toBe(false);
    expect(newsListResponseSchema.safeParse({
      ...response,
      sentiment: [
        { topic: "economy", points: [[31, 30], [1, 10]] },
        response.sentiment[1],
        response.sentiment[2],
      ],
    }).success).toBe(false);
  });

  it("rejects detached citations and unreconciled sentiment impacts", () => {
    const response = {
      story: {
        id: "nws_00000001",
        tick: 31,
        sourceTick: 30,
        headline: "Riverbend company opens",
        body: "A new company entered the Riverbend economy.",
        topic: "economy",
        stance: 1,
        reach: 40,
        entities: ["co_00000001"],
        author: { id: "agt_00000001", name: "Ada Reed" },
        org: { id: "norg_00000001", name: "Riverbend Ledger" },
        citedEventIds: [fact.eventId],
        decisionId: "dec_00000001",
        sourceEventId: "evt_00000002",
      },
      citedEvents: [fact],
      sentimentImpact: [{
        topic: "economy",
        delta: 110,
        stanceDelta: 100,
        outcomeDelta: 10,
        sourceEventId: "evt_00000003",
      }],
      meta,
    } as const;
    expect(newsStoryDetailResponseSchema.parse(response).citedEvents).toHaveLength(1);
    expect(newsStoryDetailResponseSchema.safeParse({
      ...response,
      story: { ...response.story, citedEventIds: ["evt_00000009"] },
    }).success).toBe(false);
    expect(newsStoryDetailResponseSchema.safeParse({
      ...response,
      sentimentImpact: [{ ...response.sentimentImpact[0], delta: 111 }],
    }).success).toBe(false);
  });
});
