import { describe, expect, it } from "vitest";
import { parseHermesDependencyInspectionOutput } from "./hermes-version";

describe("Hermes runtime version inspection", () => {
  it("reads the final JSON line when Python startup emits diagnostics", () => {
    expect(parseHermesDependencyInspectionOutput([
      "sitecustomize diagnostic",
      JSON.stringify({
        aiohttp: "3.14.1",
        mcp: "1.26.0",
        starlette: "1.3.1",
      }),
    ].join("\n"))).toEqual({
      mcpSdkVersion: "1.26.0",
      starletteVersion: "1.3.1",
      aiohttpVersion: "3.14.1",
    });
  });

  it("attributes malformed stdout to Hermes dependency inspection", () => {
    expect(() => parseHermesDependencyInspectionOutput(
      "sitecustomize emitted no JSON",
    )).toThrow(
      /Hermes runtime dependency inspection did not return JSON.*starts cleanly/,
    );
  });

  it("names a missing required Hermes optional dependency", () => {
    expect(() => parseHermesDependencyInspectionOutput(JSON.stringify({
      aiohttp: "3.14.1",
      mcp: null,
      starlette: "1.3.1",
    }))).toThrow(
      /missing required optional dependency mcp.*install the pinned Hermes MCP\/API-server extras/,
    );
  });
});
