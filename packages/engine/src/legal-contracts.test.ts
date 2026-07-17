import { describe, expect, it } from "vitest";
import { EngineError, IdFactory, legalContractSchema, type LegalContractType } from "@worldtangle/shared";
import {
  LEGAL_CONTRACT_TRANSITIONS,
  allPartiesSigned,
  createContractFromTemplate,
  dueLegalObligations,
  fireLegalObligation,
  overdueObligationIds,
  signLegalContract,
  transitionLegalContract,
} from "./legal-contracts";

function serviceContract() {
  return createContractFromTemplate({
    id: "ctr_00000001",
    runId: "run_00000001",
    type: "service",
    parties: [
      { kind: "company", id: "co_00000001", role: "provider" },
      { kind: "company", id: "co_00000002", role: "client" },
    ],
    terms: {
      template: "service",
      providerId: "co_00000001",
      clientId: "co_00000002",
      scope: "Provide deterministic bookkeeping",
      feeCents: "25000",
      dueTick: 5,
    },
    draftedBy: { kind: "system", id: "engine" },
    createdTick: 1,
    effectiveTick: 3,
    ids: new IdFactory(),
  });
}

describe("legal contract state machine", () => {
  it("publishes the exact allowed transition table", () => {
    expect(LEGAL_CONTRACT_TRANSITIONS).toEqual({
      draft: ["signed"],
      signed: ["active"],
      active: ["completed", "terminated", "breached"],
      completed: [],
      terminated: [],
      breached: [],
    });
  });

  it("requires every party signature before activation", () => {
    const draft = serviceContract();
    const oneSignature = signLegalContract(draft, { kind: "company", id: "co_00000001" }, 2);
    expect(oneSignature.status).toBe("draft");
    expect(allPartiesSigned(oneSignature)).toBe(false);
    expect(() => transitionLegalContract(oneSignature, "signed", 2)).toThrow(EngineError);

    const signed = signLegalContract(oneSignature, { kind: "company", id: "co_00000002" }, 2);
    expect(signed.status).toBe("signed");
    expect(() => transitionLegalContract(signed, "active", 2)).toThrow(EngineError);
    expect(transitionLegalContract(signed, "active", 3).status).toBe("active");
  });

  it("fires due obligations once and rejects invalid transitions", () => {
    let contract = serviceContract();
    contract = signLegalContract(contract, { kind: "company", id: "co_00000001" }, 2);
    contract = signLegalContract(contract, { kind: "company", id: "co_00000002" }, 2);
    contract = transitionLegalContract(contract, "active", 3);
    expect(dueLegalObligations(contract, 4)).toEqual([]);
    const due = dueLegalObligations(contract, 5);
    expect(due).toHaveLength(1);
    contract = fireLegalObligation(contract, due[0]!.id, 5);
    expect(contract.obligations[0]?.status).toBe("fired");
    expect(dueLegalObligations(contract, 6)).toEqual([]);
    expect(overdueObligationIds(contract, 6)).toEqual([due[0]!.id]);
    expect(() => transitionLegalContract(contract, "signed", 6)).toThrow(EngineError);
  });
});

describe("legal contract templates", () => {
  const templates: readonly { type: LegalContractType; terms: Record<string, unknown> }[] = [
    {
      type: "incorporation",
      terms: {
        template: "incorporation",
        companyName: "Thread Works",
        jurisdiction: "Riverbend",
        founderAgentId: "agt_00000001",
        foundingCapitalCents: "1000000",
        totalShares: "1000",
      },
    },
    {
      type: "employment",
      terms: {
        template: "employment",
        jobId: "job_00000001",
        employerId: "co_00000001",
        employeeAgentId: "agt_00000001",
        annualWageCents: "5000000",
        startTick: 3,
        noticeDays: 14,
      },
    },
    {
      type: "service",
      terms: {
        template: "service",
        providerId: "co_00000001",
        clientId: "co_00000002",
        scope: "Service scope",
        feeCents: "10000",
        dueTick: 10,
      },
    },
    {
      type: "lease",
      terms: {
        template: "lease",
        lessorId: "co_00000001",
        lesseeId: "co_00000002",
        propertyRef: "unit-7",
        rentCents: "90000",
        startTick: 5,
        endTick: 365,
      },
    },
  ];

  it.each(templates)("validates the $type template", ({ type, terms }) => {
    const contract = createContractFromTemplate({
      id: "ctr_00000001",
      runId: "run_00000001",
      type,
      parties: [
        { kind: "company", id: "co_00000001", role: "first" },
        { kind: "company", id: "co_00000002", role: "second" },
      ],
      terms: terms as never,
      draftedBy: { kind: "system", id: "engine" },
      feeCents: type === "incorporation" ? "50000" : "0",
      createdTick: 1,
      effectiveTick: 2,
      ids: new IdFactory(),
    });
    expect(legalContractSchema.parse(contract).type).toBe(type);
  });
});
