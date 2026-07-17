import type { PhaseHandler } from "@worldtangle/engine";
import type { WorldDatabase } from "./persistence/database";
import { SqliteNegotiationStore } from "./persistence/negotiation-store";

export function createNegotiationBindingPhaseHandler(
  db: WorldDatabase,
  runId: string,
): PhaseHandler {
  const store = new SqliteNegotiationStore(db, runId);
  return {
    module: "M05-negotiation-binding",
    order: 80,
    run: (ctx) => {
      store.bindPending(ctx);
    },
  };
}
