import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashValue } from "@worldtangle/shared";

interface EvidenceArtifact {
  readonly status: string;
  readonly aggregateUsage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly cost: {
    readonly apiEquivalentEstimateUsd: number;
    readonly pricingBasis: {
      readonly inputUsdPerMillionTokens: number;
      readonly cachedInputUsdPerMillionTokens: number;
      readonly outputUsdPerMillionTokens: number;
    };
  };
  readonly attempts: readonly {
    readonly proposalHash?: string;
  }[];
  readonly liveValidation: {
    readonly validationFailures: readonly unknown[];
    readonly fallbackUsed: boolean;
  };
  readonly negativeControl: {
    readonly validationFailures: readonly unknown[];
    readonly fallback: { readonly source: string };
  };
  readonly conclusion: Readonly<Record<string, boolean | string>>;
}

describe("live-provider contract evidence", () => {
  it("is internally consistent with the captured candidate, usage, and pricing", () => {
    const artifact = JSON.parse(readFileSync(new URL(
      "../../../artifacts/live-provider-contract/2026-07-15-codex-cli.json",
      import.meta.url,
    ), "utf8")) as EvidenceArtifact;
    const input = JSON.parse(readFileSync(new URL(
      "../../../artifacts/live-provider-contract/2026-07-15-probe-input.json",
      import.meta.url,
    ), "utf8")) as { candidate: unknown };
    const retained = artifact.attempts.find((attempt) => attempt.proposalHash !== undefined);
    const usage = artifact.aggregateUsage;
    const pricing = artifact.cost.pricingBasis;
    const expectedCost = (
      usage.inputTokens * pricing.inputUsdPerMillionTokens +
      usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens
    ) / 1_000_000;

    expect(artifact.status).toBe("passed_with_harness_warning");
    expect(retained?.proposalHash).toBe(hashValue(input.candidate));
    expect(artifact.cost.apiEquivalentEstimateUsd).toBeCloseTo(expectedCost, 9);
    expect(artifact.liveValidation.validationFailures).toEqual([]);
    expect(artifact.liveValidation.fallbackUsed).toBe(false);
    expect(artifact.negativeControl.validationFailures.length).toBeGreaterThan(0);
    expect(artifact.negativeControl.fallback.source).toBe("tier1_fallback");
    expect(artifact.conclusion.liveContractPassed).toBe(true);
  });

  it("replays the actual Riverbend context evidence and rejected control", () => {
    const artifact = JSON.parse(readFileSync(new URL(
      "../../../artifacts/live-provider-contract/2026-07-15-riverbend-codex-cli.json",
      import.meta.url,
    ), "utf8")) as EvidenceArtifact;
    const candidate = JSON.parse(readFileSync(new URL(
      "../../../artifacts/live-provider-contract/2026-07-15-riverbend-candidate.json",
      import.meta.url,
    ), "utf8")) as unknown;
    const retained = artifact.attempts.find((attempt) => attempt.proposalHash !== undefined);
    const usage = artifact.aggregateUsage;
    const pricing = artifact.cost.pricingBasis;
    const expectedCost = (
      usage.inputTokens * pricing.inputUsdPerMillionTokens +
      usage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens
    ) / 1_000_000;

    expect(artifact.status).toBe("passed_with_harness_warning");
    expect(retained?.proposalHash).toBe(hashValue(candidate));
    expect(artifact.cost.apiEquivalentEstimateUsd).toBeCloseTo(expectedCost, 9);
    expect(artifact.liveValidation.validationFailures).toEqual([]);
    expect(artifact.liveValidation.fallbackUsed).toBe(false);
    expect(artifact.negativeControl.validationFailures.length).toBeGreaterThan(0);
    expect(artifact.negativeControl.fallback.source).toBe("tier1_fallback");
    expect(artifact.conclusion.actualRiverbendContextUsed).toBe(true);
    expect(artifact.conclusion.untrustedMemoryBoundaryPassed).toBe(true);
  });
});
