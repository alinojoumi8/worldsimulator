import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { quotePricedRound, quoteVentureFundDeployment } from "./venture-rules";

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

describe("priced-round cap-table math", () => {
  it("produces the exact 80/20 dilution golden", () => {
    expect(quotePricedRound({
      totalSharesBefore: "1000",
      amountCents: "100000",
      preMoneyValuationCents: "400000",
      equityBasisPoints: 2_000,
    })).toEqual({
      totalSharesBefore: "1000",
      sharesIssued: "250",
      totalSharesAfter: "1250",
      amountCents: "100000",
      preMoneyValuationCents: "400000",
      postMoneyValuationCents: "500000",
      pricePerShareCents: "400",
      equityBasisPoints: 2_000,
    });
  });

  it("preserves exact price and share identities for arbitrary valid rounds", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      (sharesBefore, pricePerShare, sharesIssued) => {
        const preMoney = sharesBefore * pricePerShare;
        const amount = sharesIssued * pricePerShare;
        const totalAfter = sharesBefore + sharesIssued;
        const equityBasisPoints = Number(
          (sharesIssued * 10_000n + totalAfter / 2n) / totalAfter,
        );
        if (equityBasisPoints < 1 || equityBasisPoints > 9_999) return;
        const quote = quotePricedRound({
          totalSharesBefore: sharesBefore.toString(),
          amountCents: amount.toString(),
          preMoneyValuationCents: preMoney.toString(),
          equityBasisPoints,
        });
        expect(BigInt(quote.pricePerShareCents) * BigInt(quote.totalSharesBefore))
          .toBe(BigInt(quote.preMoneyValuationCents));
        expect(BigInt(quote.pricePerShareCents) * BigInt(quote.sharesIssued))
          .toBe(BigInt(quote.amountCents));
        expect(BigInt(quote.totalSharesBefore) + BigInt(quote.sharesIssued))
          .toBe(BigInt(quote.totalSharesAfter));
      },
    ));
  });

  it("rejects fractional-cent prices, fractional shares, and inconsistent equity", () => {
    expect(() => quotePricedRound({
      totalSharesBefore: "3",
      amountCents: "100",
      preMoneyValuationCents: "100",
      equityBasisPoints: 5_000,
    })).toThrow(/integer cents per share/);
    expect(() => quotePricedRound({
      totalSharesBefore: "100",
      amountCents: "101",
      preMoneyValuationCents: "10000",
      equityBasisPoints: 100,
    })).toThrow(/integer shares/);
    expect(() => quotePricedRound({
      totalSharesBefore: "100",
      amountCents: "10000",
      preMoneyValuationCents: "10000",
      equityBasisPoints: 4_000,
    })).toThrow(/inconsistent/);
  });
});
