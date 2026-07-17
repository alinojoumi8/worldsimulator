import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRootResponseSchema } from "@worldtangle/shared";
import { buildApp } from "./app";

describe("GET /api/v1", () => {
  it("identifies every API response surface as simulated (AC-10)", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    expect(response.statusCode).toBe(200);
    expect(apiRootResponseSchema.parse(response.json())).toMatchObject({
      name: "WorldTangle",
      simulated: true,
      apiVersion: 1,
      links: {
        health: "/api/v1/health",
        version: "/api/v1/version",
        simulations: "/api/v1/simulations",
      },
    });
    await app.close();
  });
});

describe("GET /api/v1/health", () => {
  it("returns ok with the simulated-scenario flag (SAF-1)", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["engine"]).toBe("idle");
    expect(body["simulated"]).toBe(true);
    expect(typeof body["version"]).toBe("string");
    await app.close();
  });
});

describe("GET /api/v1/version", () => {
  it("reports pinned contract versions (ADR-0010)", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body["apiVersion"]).toBe(1);
    expect(body["eventSchemaVersion"]).toBe(1);
    expect(body["simulated"]).toBe(true);
    await app.close();
  });
});

describe("error contract (RFC 9457)", () => {
  it("unknown routes return problem+json with a typed code", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const body = response.json() as Record<string, unknown>;
    expect(body["code"]).toBe("NOT_FOUND");
    expect(body["status"]).toBe(404);
    expect(typeof body["type"]).toBe("string");
    expect(typeof body["correlationId"]).toBe("string");
    await app.close();
  });
});

describe("optional bearer token (ADR-0011)", () => {
  it("keeps health open, guards everything else", async () => {
    const app = buildApp({ apiToken: "secret-token" });

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(unauthorized.statusCode).toBe(401);
    expect((unauthorized.json() as Record<string, unknown>)["code"]).toBe("UNAUTHORIZED");

    const wrong = await app.inject({
      method: "GET",
      url: "/api/v1/version",
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/v1/version",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authorized.statusCode).toBe(200);

    await app.close();
  });

  it("keeps the built dashboard public while guarding /api/v1", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "worldtangle-web-"));
    mkdirSync(join(webRoot, "assets"));
    mkdirSync(join(webRoot, "brand"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>WorldTangle</title>");
    writeFileSync(join(webRoot, "assets", "app.js"), "globalThis.worldtangle = true;");
    writeFileSync(join(webRoot, "brand", "mark.svg"), "<svg></svg>");
    writeFileSync(join(webRoot, "manifest.webmanifest"), "{}");
    writeFileSync(join(webRoot, "robots.txt"), "User-agent: *\nDisallow:");
    const app = buildApp({ apiToken: "secret-token", webRoot });

    try {
      for (const url of ["/", "/simulations/sim_00000001"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("WorldTangle");
      }
      expect((await app.inject({ method: "GET", url: "/assets/app.js" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/brand/mark.svg" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/manifest.webmanifest" })).statusCode)
        .toBe(200);

      const guarded = await app.inject({ method: "GET", url: "/api/v1/simulations" });
      expect(guarded.statusCode).toBe(401);
      expect((guarded.json() as Record<string, unknown>)["code"]).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
