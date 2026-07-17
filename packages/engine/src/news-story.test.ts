import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  newsOrganizationSchema,
  newsStorySelectionProposalSchema,
  type EventEnvelope,
} from "@worldtangle/shared";
import {
  buildNewsStoryOptions,
  buildNewsStoryMenu,
  buildNewsworthinessDigest,
  newsStoryReach,
  newsTopicForEvent,
  resolveNewsStorySelection,
  templateNewsStorySelection,
} from "./index";

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "evt_00000001",
    type: "energy.tariff.changed",
    schemaVersion: 1,
    simulationId: "sim_00000001",
    runId: "run_00000001",
    seq: 0,
    tick: 7,
    simDate: "Y0001-M01-D07",
    wallTime: "2030-01-01T00:00:00.000Z",
    actor: { kind: "institution", id: "inst_power" },
    correlationId: "cor_energy",
    payload: {
      companyId: "cmp_00000001",
      householdIds: ["hh_00000001", "hh_00000002"],
      oldPriceCents: "1000",
      newPriceCents: "1450",
    },
    ...overrides,
  };
}

function fixture() {
  const source = event();
  const digest = buildNewsworthinessDigest({
    simulationId: source.simulationId,
    runId: source.runId,
    tick: source.tick,
    events: [source],
  });
  const organization = newsOrganizationSchema.parse({
    id: "norg_riverbend_ledger",
    runId: source.runId,
    name: "The Riverbend Ledger",
    editorAgentId: "agt_00000001",
    journalistAgentIds: ["agt_00000002", "agt_00000003"],
    dailyStoryCap: 3,
    stanceBias: 0,
    createdTick: 1,
    sourceEventId: "evt_00000099",
  });
  const input = {
    organization,
    candidate: digest.candidates[0]!,
    event: source,
  };
  const menu = buildNewsStoryMenu(input);
  const options = buildNewsStoryOptions(input);
  return { source, digest, organization, menu, options };
}

describe("WS-702 deterministic story drafts", () => {
  it("copies citation facts exactly and validates an exact menu choice", () => {
    const { source, digest, menu, options } = fixture();
    const proposal = templateNewsStorySelection(options);
    const resolved = resolveNewsStorySelection(proposal, options);
    const selectedDraft = menu.find((entry) => entry.option.actionId === proposal.actionId)!.draft;

    expect(resolved.ok).toBe(true);
    expect(selectedDraft.citedEventIds).toEqual([source.eventId]);
    expect(selectedDraft.facts[0]).toMatchObject({
      eventId: source.eventId,
      eventFactHash: digest.candidates[0]!.eventFactHash,
      eventType: source.type,
      tick: source.tick,
      simDate: source.simDate,
      actor: source.actor,
      correlationId: source.correlationId,
      payload: source.payload,
    });
  });

  it("spikes forged facts even when the action ID is offered", () => {
    const { options } = fixture();
    const proposal = templateNewsStorySelection(options);
    const forged = {
      ...proposal,
      params: {
        ...proposal.params,
        draftHash: "0".repeat(64),
      },
    };
    expect(newsStorySelectionProposalSchema.safeParse(forged).success).toBe(true);
    expect(resolveNewsStorySelection(forged, options)).toMatchObject({
      ok: false,
      reason: "menu_mismatch",
    });
  });

  it("rejects malformed and extra-field proposals without throwing", () => {
    const { options } = fixture();
    const malformed: unknown[] = [
      null,
      [],
      {},
      { actionId: options[0]!.actionId },
      { actionId: options[0]!.actionId, params: options[0]!.params, rationale: "ok", extra: true },
      { actionId: "news.story.publish.unknown", params: options[0]!.params, rationale: "ok" },
      { actionId: options[0]!.actionId, params: {}, rationale: "ok" },
    ];
    for (const candidate of malformed) {
      expect(resolveNewsStorySelection(candidate, options).ok).toBe(false);
    }
  });

  it("provides a stable LLM-off template and bounded topic/reach rules", () => {
    const { options } = fixture();
    const first = templateNewsStorySelection(options);
    const second = templateNewsStorySelection(options);
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(first.actionId).toBe("news.story.publish.neutral");
    expect(newsTopicForEvent("employment.contract.started")).toBe("employment");
    expect(newsTopicForEvent("loan.defaulted")).toBe("institutions");
    expect(newsTopicForEvent("company.formed")).toBe("economy");
    expect(newsStoryReach(10_000)).toBe(51_000);
  });

  it("keeps story menu hashes stable across replay-only source metadata", () => {
    const buildMenu = (source: EventEnvelope) => {
      const digest = buildNewsworthinessDigest({
        simulationId: source.simulationId,
        runId: source.runId,
        tick: source.tick,
        events: [source],
      });
      const organization = newsOrganizationSchema.parse({
        id: "norg_riverbend_ledger",
        runId: source.runId,
        name: "The Riverbend Ledger",
        editorAgentId: "agt_00000001",
        journalistAgentIds: ["agt_00000002"],
        dailyStoryCap: 3,
        stanceBias: 0,
        createdTick: 1,
        sourceEventId: "evt_00000099",
      });
      return buildNewsStoryMenu({
        organization,
        candidate: digest.candidates[0]!,
        event: source,
      });
    };
    const original = event({
      payload: {
        priceCents: "1450",
        evidence: {
          runId: "run_00000001",
          latencyMs: 87,
          costMicrocents: "2500",
        },
      },
    });
    const replay = event({
      simulationId: "sim_00000002",
      runId: "run_00000002",
      correlationId: "replay-correlation",
      wallTime: "replay-wall-time",
      payload: {
        priceCents: "1450",
        evidence: {
          runId: "run_00000002",
          latencyMs: 0,
          costMicrocents: "2500",
        },
      },
    });
    const changedCost = event({
      payload: {
        priceCents: "1450",
        evidence: {
          runId: "run_00000001",
          latencyMs: 87,
          costMicrocents: "2501",
        },
      },
    });

    expect(buildMenu(replay).map((entry) => entry.option.params)).toEqual(
      buildMenu(original).map((entry) => entry.option.params),
    );
    expect(buildMenu(changedCost).map((entry) => entry.option.params)).not.toEqual(
      buildMenu(original).map((entry) => entry.option.params),
    );
  });
});
