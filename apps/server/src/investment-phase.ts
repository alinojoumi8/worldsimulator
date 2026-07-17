/** WS-802/803 proposal negotiation and atomic investment closing. */

import type { PhaseHandler } from "@worldtangle/engine";
import {
  SqliteInvestmentProposalStore,
  SqliteInvestmentStore,
  type WorldDatabase,
} from "./persistence";

export function createInvestmentProposalPhaseHandler(
  db: WorldDatabase,
  runId: string,
): PhaseHandler {
  const proposals = new SqliteInvestmentProposalStore(db, runId);
  const investments = new SqliteInvestmentStore(db, runId);
  return {
    module: "M10-investments",
    order: 77,
    run: (ctx) => {
      proposals.processTick(ctx);
      investments.processTick(ctx);
    },
  };
}
