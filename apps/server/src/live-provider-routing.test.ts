import { describe, expect, it } from "vitest";
import {
  KIMI_K2_6_MODEL,
  KIMI_K2_7_CODE_MODEL,
  MINIMAX_M3_MODEL,
} from "@worldtangle/engine";
import { resolveLiveProviderRoute } from "./simulation-service";

describe("live provider manifest routing", () => {
  it("resolves the pinned MiniMax/Kimi pair and configured Kimi variant", () => {
    expect(resolveLiveProviderRoute({
      tier2_provider: "minimax",
      tier2_routine: MINIMAX_M3_MODEL,
      tier3_provider: "kimi",
      tier3: KIMI_K2_7_CODE_MODEL,
    })).toEqual({
      family: "minimax_kimi",
      tier2Model: MINIMAX_M3_MODEL,
      tier3Model: KIMI_K2_7_CODE_MODEL,
    });
    expect(resolveLiveProviderRoute({
      tier2_provider: "minimax",
      tier3_provider: "kimi",
    })).toEqual({
      family: "minimax_kimi",
      tier2Model: MINIMAX_M3_MODEL,
      tier3Model: KIMI_K2_6_MODEL,
    });
  });

  it("keeps explicit and provider-less historical Claude manifests on Anthropic", () => {
    const expected = {
      family: "anthropic",
      tier2Model: "claude-haiku-legacy",
      tier3Model: "claude-sonnet-legacy",
    };
    expect(resolveLiveProviderRoute({
      tier2_provider: "anthropic",
      tier2_routine: "claude-haiku-legacy",
      tier3: "claude-sonnet-legacy",
    })).toEqual(expected);
    expect(resolveLiveProviderRoute({
      tier2_routine: "claude-haiku-legacy",
      tier3: "claude-sonnet-legacy",
    })).toEqual(expected);
  });

  it("rejects missing, crossed, or unsupported provider/model pairs", () => {
    expect(() => resolveLiveProviderRoute({})).toThrow(/missing\/missing/);
    expect(() => resolveLiveProviderRoute({
      tier2_provider: "minimax",
      tier2_routine: "claude-haiku-legacy",
      tier3_provider: "kimi",
      tier3: KIMI_K2_6_MODEL,
    })).toThrow(/unsupported pinned MiniMax model/);
    expect(() => resolveLiveProviderRoute({
      tier2_provider: "anthropic",
      tier3_provider: "kimi",
    })).toThrow(/unsupported legacy provider route/);
    expect(() => resolveLiveProviderRoute({
      tier2_provider: "minimax",
      tier2_routine: MINIMAX_M3_MODEL,
      tier3_provider: "kimi",
      tier3: "kimi-moving-alias",
    })).toThrow(/unsupported pinned Kimi model/);
  });
});
