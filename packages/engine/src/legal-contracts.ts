/** Deterministic WS-401 legal-contract templates and lifecycle rules. */

import {
  EngineError,
  legalContractSchema,
  type ActorRef,
  type IdFactory,
  type LegalContract,
  type LegalContractStatus,
  type LegalContractTerms,
  type LegalContractType,
  type LegalObligation,
  type LegalParty,
} from "@worldtangle/shared";

export const LEGAL_CONTRACT_TRANSITIONS: Readonly<Record<LegalContractStatus, readonly LegalContractStatus[]>> = {
  draft: ["signed"],
  signed: ["active"],
  active: ["completed", "terminated", "breached"],
  completed: [],
  terminated: [],
  breached: [],
};

export interface ContractTemplateInput {
  readonly id: string;
  readonly runId: string;
  readonly type: LegalContractType;
  readonly parties: readonly Omit<LegalParty, "signedTick">[];
  readonly terms: LegalContractTerms;
  readonly draftedBy: ActorRef;
  readonly feeCents?: string;
  readonly createdTick: number;
  readonly effectiveTick: number;
  readonly ids: IdFactory;
}

function templateObligations(input: ContractTemplateInput): LegalObligation[] {
  const obligation = (
    dueTick: number,
    recurrenceTicks: number | null,
    kind: LegalObligation["kind"],
    params: Readonly<Record<string, unknown>>,
  ): LegalObligation => ({
    id: input.ids.next("obl"),
    dueTick,
    recurrenceTicks,
    kind,
    params: { ...params },
    status: "pending",
    firedTick: null,
    completedTick: null,
  });

  switch (input.terms.template) {
    case "incorporation":
      return BigInt(input.feeCents ?? "0") === 0n
        ? []
        : [obligation(input.effectiveTick, null, "payment", {
            purpose: "incorporation_fee",
            amountCents: input.feeCents ?? "0",
          })];
    case "employment":
      return [];
    case "service":
      return [obligation(input.terms.dueTick, null, "payment", {
        purpose: "service_fee",
        amountCents: input.terms.feeCents,
      })];
    case "lease":
      return [obligation(input.terms.startTick, 30, "payment", {
        purpose: "lease_rent",
        amountCents: input.terms.rentCents,
        endTick: input.terms.endTick,
      })];
    case "investment":
      return [];
  }
}

export function createContractFromTemplate(input: ContractTemplateInput): LegalContract {
  if (input.terms.template !== input.type) {
    throw new EngineError("VALIDATION_FAILED", "contract template and terms do not match");
  }
  if (input.effectiveTick < input.createdTick) {
    throw new EngineError("VALIDATION_FAILED", "contract cannot be effective before it is drafted");
  }
  return legalContractSchema.parse({
    id: input.id,
    runId: input.runId,
    type: input.type,
    parties: input.parties.map((party) => ({ ...party, signedTick: null })),
    terms: input.terms,
    obligations: templateObligations(input),
    draftedBy: input.draftedBy,
    feeCents: input.feeCents ?? "0",
    status: "draft",
    createdTick: input.createdTick,
    effectiveTick: input.effectiveTick,
    terminalTick: null,
    breaches: [],
  });
}

export function allPartiesSigned(contract: LegalContract): boolean {
  return contract.parties.every((party) => party.signedTick !== null);
}

export function signLegalContract(
  contract: LegalContract,
  party: Pick<LegalParty, "kind" | "id">,
  tick: number,
): LegalContract {
  if (contract.status !== "draft") {
    throw new EngineError("CONFLICT", `contract ${contract.id} is not open for signatures`);
  }
  let found = false;
  const parties = contract.parties.map((candidate) => {
    if (candidate.kind !== party.kind || candidate.id !== party.id) return candidate;
    found = true;
    if (candidate.signedTick !== null) return candidate;
    return { ...candidate, signedTick: tick };
  });
  if (!found) throw new EngineError("PERMISSION_DENIED", "signer is not a party to this contract");
  const signed = parties.every((candidate) => candidate.signedTick !== null);
  return legalContractSchema.parse({ ...contract, parties, status: signed ? "signed" : "draft" });
}

export function transitionLegalContract(
  contract: LegalContract,
  next: LegalContractStatus,
  tick: number,
): LegalContract {
  if (!LEGAL_CONTRACT_TRANSITIONS[contract.status].includes(next)) {
    throw new EngineError(
      "CONFLICT",
      `invalid legal contract transition ${contract.status} -> ${next}`,
    );
  }
  if (next === "signed" && !allPartiesSigned(contract)) {
    throw new EngineError("CONFLICT", "all contract parties must sign before signed status");
  }
  if (next === "active") {
    if (!allPartiesSigned(contract)) {
      throw new EngineError("CONFLICT", "all contract parties must sign before activation");
    }
    if (tick < contract.effectiveTick) {
      throw new EngineError("CONFLICT", "contract effective tick has not been reached");
    }
  }
  return legalContractSchema.parse({
    ...contract,
    status: next,
    terminalTick: ["completed", "terminated", "breached"].includes(next) ? tick : null,
  });
}

export function dueLegalObligations(
  contract: LegalContract,
  tick: number,
): readonly LegalObligation[] {
  if (contract.status !== "active") return [];
  return contract.obligations
    .filter((obligation) => obligation.status === "pending" && obligation.dueTick <= tick)
    .sort((left, right) => left.dueTick - right.dueTick || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function fireLegalObligation(
  contract: LegalContract,
  obligationId: string,
  tick: number,
): LegalContract {
  let found = false;
  const obligations = contract.obligations.map((obligation) => {
    if (obligation.id !== obligationId) return obligation;
    found = true;
    if (obligation.status !== "pending" || obligation.dueTick > tick) {
      throw new EngineError("CONFLICT", `obligation ${obligationId} is not due`);
    }
    if (obligation.recurrenceTicks !== null) {
      const nextDueTick = obligation.dueTick + obligation.recurrenceTicks;
      const endTick = obligation.params["endTick"];
      if (typeof endTick === "number" && nextDueTick > endTick) {
        return {
          ...obligation,
          status: "completed" as const,
          firedTick: tick,
          completedTick: tick,
        };
      }
      return {
        ...obligation,
        dueTick: nextDueTick,
        firedTick: tick,
      };
    }
    return { ...obligation, status: "fired" as const, firedTick: tick };
  });
  if (!found) throw new EngineError("NOT_FOUND", `obligation ${obligationId} does not exist`);
  return legalContractSchema.parse({ ...contract, obligations });
}

export function completeLegalObligation(
  contract: LegalContract,
  obligationId: string,
  tick: number,
): LegalContract {
  let found = false;
  const obligations = contract.obligations.map((obligation) => {
    if (obligation.id !== obligationId) return obligation;
    found = true;
    if (obligation.status !== "fired") {
      throw new EngineError("CONFLICT", `obligation ${obligationId} has not fired`);
    }
    return { ...obligation, status: "completed" as const, completedTick: tick };
  });
  if (!found) throw new EngineError("NOT_FOUND", `obligation ${obligationId} does not exist`);
  return legalContractSchema.parse({ ...contract, obligations });
}

export function overdueObligationIds(contract: LegalContract, tick: number): readonly string[] {
  if (contract.status !== "active") return [];
  return contract.obligations
    .filter((obligation) => (
      obligation.status === "fired" &&
      obligation.firedTick !== null &&
      obligation.firedTick < tick &&
      obligation.completedTick === null
    ))
    .map((obligation) => obligation.id)
    .sort();
}
