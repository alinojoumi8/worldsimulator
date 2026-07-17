import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { quoteVentureFundDeployment } from "./venture-rules";

describe("venture fund accounting", () => {
  it("tracks every accepted deployment exactly and never exceeds fund size", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
      fc.array(fc.bigInt({ min: 1n, max: 100_000_000_000n }), { maxLength: 40 }),
      (fundSize, requests) => {
        let deployed = 0n;
        for (const requested of requests) {
          const remaining = fundSize - deployed;
          if (remaining === 0n) break;
          const accepted = requested > remaining ? remaining : requested;
          const quote = quoteVentureFundDeployment({
            fundSizeCents: fundSize.toString(),
            deployedCents: deployed.toString(),
          }, accepted.toString());
          expect(BigInt(quote.deployedAfterCents)).toBe(deployed + accepted);
          expect(BigInt(quote.remainingCents)).toBe(fundSize - deployed - accepted);
          expect(BigInt(quote.deployedAfterCents)).toBeLessThanOrEqual(fundSize);
          deployed = BigInt(quote.deployedAfterCents);
        }
      },
    ));
  });

  it("rejects over-deployment and malformed cent values", () => {
    expect(() => quoteVentureFundDeployment({
      fundSizeCents: "100",
      deployedCents: "90",
    }, "11")).toThrow(/exceeds undeployed/);
    expect(() => quoteVentureFundDeployment({
      fundSizeCents: "0100",
      deployedCents: "0",
    }, "1")).toThrow(/canonical/);
  });
});
