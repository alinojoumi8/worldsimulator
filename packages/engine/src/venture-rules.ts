/** Pure deterministic M10 fund-accounting rules. */

import { EngineError } from "@worldtangle/shared";

const canonicalNonnegativeInteger = /^(0|[1-9]\d*)$/;
const canonicalPositiveInteger = /^[1-9]\d*$/;

function cents(value: string, field: string, positive: boolean): bigint {
  const pattern = positive ? canonicalPositiveInteger : canonicalNonnegativeInteger;
  if (!pattern.test(value)) {
    throw new EngineError("VALIDATION_FAILED", `${field} must be a canonical integer-cent string`);
  }
  return BigInt(value);
}

export interface VentureFundAccountingState {
  readonly fundSizeCents: string;
  readonly deployedCents: string;
}

export interface VentureFundDeploymentQuote {
  readonly amountCents: string;
  readonly deployedBeforeCents: string;
  readonly deployedAfterCents: string;
  readonly remainingCents: string;
  readonly fullyDeployed: boolean;
}

/** Apply one deployment exactly or reject it without returning a partial state. */
export function quoteVentureFundDeployment(
  state: VentureFundAccountingState,
  amountCents: string,
): VentureFundDeploymentQuote {
  const fundSize = cents(state.fundSizeCents, "fundSizeCents", true);
  const deployedBefore = cents(state.deployedCents, "deployedCents", false);
  const amount = cents(amountCents, "amountCents", true);
  if (deployedBefore > fundSize) {
    throw new EngineError("CONFLICT", "deployed capital already exceeds fund size");
  }
  const deployedAfter = deployedBefore + amount;
  if (deployedAfter > fundSize) {
    throw new EngineError("INSUFFICIENT_FUNDS", "deployment exceeds undeployed fund capital", {
      fundSizeCents: fundSize.toString(),
      deployedCents: deployedBefore.toString(),
      requestedCents: amount.toString(),
    });
  }
  return Object.freeze({
    amountCents: amount.toString(),
    deployedBeforeCents: deployedBefore.toString(),
    deployedAfterCents: deployedAfter.toString(),
    remainingCents: (fundSize - deployedAfter).toString(),
    fullyDeployed: deployedAfter === fundSize,
  });
}
