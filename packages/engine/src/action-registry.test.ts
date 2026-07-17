import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { EngineError, agentIdSchema } from "@worldtangle/shared";
import type { IntentEnvelope } from "@worldtangle/shared";
import { ActionRegistry } from "./action-registry";

interface TestState {
  readonly ownerId: string;
  mutations: string[];
}

const transferSchema = z.object({
  targetAgentId: agentIdSchema,
  amountCents: z.string().regex(/^[1-9]\d*$/),
}).strict();

function intent(params: unknown, type = "test.transfer"): IntentEnvelope {
  return {
    intentId: "int_00000001",
    type,
    actor: { kind: "agent", id: "agt_00000001" },
    tick: 7,
    params,
    decisionId: "dec_00000001",
    correlationId: "corr_1",
  };
}

function registry(state: TestState): ActionRegistry<TestState> {
  const actions = new ActionRegistry<TestState>({
    capabilityCheck: ({ actor, params }) => {
      const target = (params as { targetAgentId: string }).targetAgentId;
      return actor.id === target
        ? true
        : {
            code: "PERMISSION_DENIED",
            message: "actor can transfer only for self",
          };
    },
  });
  actions.registerActionType(
    "test.transfer",
    transferSchema,
    (params) => BigInt(params.amountCents) <= 10_000n
      ? true
      : {
          code: "LIMIT_EXCEEDED",
          message: "test transfer exceeds its ceiling",
        },
    (params) => {
      state.mutations.push(params.amountCents);
      return { acceptedCents: params.amountCents };
    },
  );
  return actions;
}

describe("ActionRegistry", () => {
  it("registers, prepares, and executes a typed action exactly once", () => {
    const state: TestState = { ownerId: "agt_00000001", mutations: [] };
    const actions = registry(state);
    const context = { runId: "run_00000001", tick: 7, state };
    const preparation = actions.prepare(intent({
      targetAgentId: "agt_00000001",
      amountCents: "9000",
    }), context);

    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;
    expect(state.mutations).toEqual([]);
    expect(actions.executePrepared(preparation.prepared, context)).toMatchObject({
      status: "applied",
      result: { acceptedCents: "9000" },
    });
    expect(state.mutations).toEqual(["9000"]);
    expect(actions.listActionTypes()).toEqual(["test.transfer"]);
  });

  it("rejects unknown, malformed, unauthorized, and domain-invalid intents by taxonomy", () => {
    const state: TestState = { ownerId: "agt_00000001", mutations: [] };
    const actions = registry(state);
    const context = { runId: "run_00000001", tick: 7, state };
    const cases = [
      [intent({}, "test.unknown"), "NOT_FOUND"],
      [intent({ targetAgentId: "agt_00000001", amountCents: -1 }), "SCHEMA_INVALID"],
      [{ ...intent({ targetAgentId: "agt_00000001", amountCents: "1" }), toolCall: "bypass" }, "SCHEMA_INVALID"],
      [intent({ targetAgentId: "agt_00000002", amountCents: "100" }), "PERMISSION_DENIED"],
      [intent({ targetAgentId: "agt_00000001", amountCents: "10001" }), "LIMIT_EXCEEDED"],
    ] as const;

    for (const [candidate, code] of cases) {
      const result = actions.dispatch(candidate, context);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.rejection.code).toBe(code);
    }
    expect(state.mutations).toEqual([]);
  });

  it("never reaches the executor for adversarial JSON params", () => {
    fc.assert(fc.property(fc.jsonValue(), (params) => {
      const state: TestState = { ownerId: "agt_00000001", mutations: [] };
      const actions = registry(state);
      const result = actions.dispatch(intent(params), {
        runId: "run_00000001",
        tick: 7,
        state,
      });
      const independentlyValid = transferSchema.safeParse(params);
      const authorizedAndBounded =
        independentlyValid.success &&
        independentlyValid.data.targetAgentId === "agt_00000001" &&
        BigInt(independentlyValid.data.amountCents) <= 10_000n;

      expect(result.status === "applied").toBe(authorizedAndBounded);
      expect(state.mutations.length).toBe(authorizedAndBounded ? 1 : 0);
    }), { numRuns: 250 });
  });

  it("reports executor exceptions as failed actions and protects registration integrity", () => {
    const state: TestState = { ownerId: "agt_00000001", mutations: [] };
    const actions = new ActionRegistry<TestState>();
    actions.registerActionType(
      "test.failure",
      z.object({}).strict(),
      () => true,
      () => {
        throw new EngineError("CONFLICT", "injected executor conflict");
      },
    );
    expect(actions.dispatch(intent({}, "test.failure"), {
      runId: "run_00000001",
      tick: 7,
      state,
    })).toMatchObject({
      status: "failed",
      error: { code: "CONFLICT", message: "injected executor conflict" },
    });
    expect(() => actions.registerActionType(
      "test.failure",
      z.object({}).strict(),
      () => true,
      () => undefined,
    )).toThrow(/already registered/);
    expect(() => actions.registerActionType(
      "NOT VALID",
      z.object({}).strict(),
      () => true,
      () => undefined,
    )).toThrow(/invalid action type/);
  });

  it("binds prepared actions to their registry and tick context", () => {
    const state: TestState = { ownerId: "agt_00000001", mutations: [] };
    const actions = registry(state);
    const context = { runId: "run_00000001", tick: 7, state };
    const preparation = actions.prepare(intent({
      targetAgentId: "agt_00000001",
      amountCents: "1",
    }), context);
    if (!preparation.ok) throw new Error("expected preparation to succeed");

    expect(() => actions.executePrepared(preparation.prepared, {
      ...context,
      tick: 8,
    })).toThrow(/different registry or execution context/);
    expect(state.mutations).toEqual([]);
  });
});
