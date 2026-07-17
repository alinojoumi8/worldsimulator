/** Verify the two real-provider artifacts required to close Phase 6. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateWs609LiveBudgetArtifact,
  validateWs610LiveParityArtifact,
} from "../packages/shared/src/index";

function readArtifact(path: string, ticket: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`Phase 6 gate is missing the ${ticket} artifact: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Phase 6 gate could not parse the ${ticket} artifact: ` +
      (error instanceof Error ? error.message : "unknown JSON error"),
    );
  }
}

const ws609Path = resolve(
  process.argv[2] ?? "artifacts/ws609-live-acceptance/latest.json",
);
const ws610Path = resolve(
  process.argv[3] ?? "artifacts/ws610-live-parity/latest.json",
);
const ws609 = validateWs609LiveBudgetArtifact(readArtifact(ws609Path, "WS-609"));
const ws610 = validateWs610LiveParityArtifact(readArtifact(ws610Path, "WS-610"));

process.stdout.write(JSON.stringify({
  gate: "phase6-live-acceptance",
  status: "passed",
  artifacts: {
    ws609: {
      path: ws609Path,
      executedAt: ws609.executedAt,
      simulationId: ws609.simulationId,
      runId: ws609.runId,
      evidenceDigest: ws609.evidenceDigest,
    },
    ws610: {
      path: ws610Path,
      executedAt: ws610.executedAt,
      proposalHash: ws610.replayedProposal.proposalHash,
      projectionDigest: ws610.providerNeutral.projectionDigest,
      evidenceDigest: ws610.evidenceDigest,
    },
  },
}, null, 2) + "\n");
