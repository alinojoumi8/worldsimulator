import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSimulationResponseSchema,
  eventListResponseSchema,
  newsListResponseSchema,
  newsStoryDetailResponseSchema,
} from "@worldtangle/shared";
import { buildApp } from "./app";

const applications: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (applications.length > 0) await applications.pop()!.close();
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("WS-707 news and causality API", () => {
  it("serves published stories, exact evidence, sentiment, and stable feed traversal", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worldtangle-news-api-"));
    directories.push(dataDir);
    const app = buildApp({
      dataDir,
      webRoot: false,
      wallClock: () => "2026-07-16T12:00:00.000Z",
      tickIntervalMs: 60_000,
      snapshotIntervalTicks: 1,
    });
    applications.push(app);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/simulations",
      payload: {
        name: "ws-707-news-explorer",
        scenario: {
          worldSpec: "riverbend-100@1",
          seed: 707,
          llmMode: "off",
          budgets: { runCostCentsMax: "1000", perAgentDailyTokens: 2_000 },
          policyOverrides: {},
          endTick: 30,
        },
      },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = createSimulationResponseSchema.parse(createResponse.json());
    const simulationId = created.simulation.id;
    const runId = created.run.id;

    for (const command of ["start", "pause"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/simulations/${simulationId}/${command}`,
        payload: { runId },
      });
      expect(response.statusCode, response.body).toBe(202);
    }
    const advanceResponse = await app.inject({
      method: "POST",
      url: `/api/v1/simulations/${simulationId}/advance`,
      payload: { runId, ticks: 1 },
    });
    expect(advanceResponse.statusCode, advanceResponse.body).toBe(200);

    const feedResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/news?runId=${runId}&limit=100`,
    });
    expect(feedResponse.statusCode, feedResponse.body).toBe(200);
    const feed = newsListResponseSchema.parse(feedResponse.json());
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items.length).toBeLessThanOrEqual(3);
    expect(feed.sentiment.map((series) => series.topic)).toEqual([
      "economy",
      "employment",
      "institutions",
    ]);
    expect(feed.sentiment.flatMap((series) => series.points).every(([tick]) => tick === 1))
      .toBe(true);
    expect(feed.items.every((story) => (
      story.tick === 1 &&
      story.sourceTick === 0 &&
      story.author.name.length > 0 &&
      story.org.name.length > 0
    ))).toBe(true);

    const first = feed.items[0]!;
    const topicResponse = await app.inject({
      method: "GET",
      url:
        `/api/v1/simulations/${simulationId}/news?runId=${runId}` +
        `&topic=${first.topic}&fromTick=1&toTick=1`,
    });
    const topicFeed = newsListResponseSchema.parse(topicResponse.json());
    expect(topicFeed.items.length).toBeGreaterThan(0);
    expect(topicFeed.items.every((story) => story.topic === first.topic)).toBe(true);

    const firstPage = newsListResponseSchema.parse((await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/news?runId=${runId}&limit=1`,
    })).json());
    expect(firstPage.items).toHaveLength(1);
    if (feed.items.length > 1) {
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = newsListResponseSchema.parse((await app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/news?runId=${runId}&limit=1` +
          `&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      })).json());
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
    } else {
      expect(firstPage.nextCursor).toBeNull();
    }

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/news/${first.id}?runId=${runId}`,
    });
    expect(detailResponse.statusCode, detailResponse.body).toBe(200);
    const detail = newsStoryDetailResponseSchema.parse(detailResponse.json());
    expect(detail.story.id).toBe(first.id);
    expect(detail.citedEvents.map((fact) => fact.eventId)).toEqual(first.citedEventIds);
    expect(detail.sentimentImpact.every((impact) => (
      impact.delta === Math.max(
        -2_000,
        Math.min(2_000, impact.stanceDelta + impact.outcomeDelta),
      )
    ))).toBe(true);

    for (const fact of detail.citedEvents) {
      const eventResponse = await app.inject({
        method: "GET",
        url:
          `/api/v1/simulations/${simulationId}/events?runId=${runId}` +
          `&type=${encodeURIComponent(fact.eventType)}` +
          `&correlationId=${encodeURIComponent(fact.correlationId)}` +
          `&fromTick=${fact.tick}&toTick=${fact.tick}&limit=100`,
      });
      expect(eventResponse.statusCode, eventResponse.body).toBe(200);
      const events = eventListResponseSchema.parse(eventResponse.json());
      expect(events.items.some((event) => event.eventId === fact.eventId)).toBe(true);
    }

    const invalidRange = await app.inject({
      method: "GET",
      url: `/api/v1/simulations/${simulationId}/news?fromTick=2&toTick=1`,
    });
    expect(invalidRange.statusCode).toBe(400);
  });
});
