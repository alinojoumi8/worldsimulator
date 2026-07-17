/** WS-802 investment proposal lifecycle, ordered after conversation outcomes. */

import type { PhaseHandler } from "@worldtangle/engine";
import {
  SqliteInvestmentProposalStore,
  type WorldDatabase,
} from "./persistence";

export function createInvestmentProposalPhaseHandler(
  db: WorldDatabase,
  runId: string,
): PhaseHandler {
  const store = new SqliteInvestmentProposalStore(db, runId);
  return {
    module: "M10-investment-proposals",
    order: 77,
    run: (ctx) => {
      store.processTick(ctx);
    },
  };
}
