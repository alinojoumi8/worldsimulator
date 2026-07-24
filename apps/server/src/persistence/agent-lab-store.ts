import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  AGENT_LAB_MCP_TOOL_NAMES,
  AGENT_LAB_PROTOCOL_VERSION,
  AGENT_LAB_SCOPES,
  agentActionReceiptSchema,
  agentActionSubmissionSchema,
  agentTurnEnvelopeSchema,
  canonicalParse,
  canonicalStringify,
  EngineError,
  hashValue,
  runManifestAgentLabSchema,
  sha256Hex,
  taintRecordSchema,
  type AgentActionReceipt,
  type AgentActionSubmission,
  type AgentLabMode,
  type AgentLabScope,
  type AgentTurnEnvelope,
  type RunManifestAgentLab,
  type TaintRecord,
} from "@worldtangle/shared";
import type { WorldDatabase } from "./database";

const CREDENTIAL_ID_PATTERN = /^cred_[0-9a-f]{24}$/;
const TOKEN_PREFIX = "wtpat_";
const FORBIDDEN_BOUNDARY_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "chainofthought",
  "credential",
  "hiddenreasoning",
  "password",
  "private",
  "privatecanary",
  "providerkey",
  "secret",
  "token",
]);

interface TrialRow {
  protocol_version: string;
  study_id: string;
  trial_id: string;
  experiment_manifest_digest: string;
  mode: string;
  config_canonical: string;
  externally_influenced: bigint;
  tainted: bigint;
  taint_canonical: string;
  created_wall: string;
}

interface CredentialRow {
  credential_id: string;
  token_hash: string;
  agent_id: string;
  mode: string;
  scopes_canonical: string;
  status: string;
  created_wall: string;
  revoked_wall: string | null;
  last_used_wall: string | null;
}

interface TurnRow {
  turn_id: string;
  agent_id: string;
  controller: string;
  opportunity_key: string;
  completed_tick: bigint;
  target_tick: bigint;
  projection_hash: string;
  menu_hash: string;
  envelope_canonical: string;
  status: string;
  deadline_wall: string;
  terminal_receipt_id: string | null;
  created_wall: string;
  updated_wall: string;
}

interface SubmissionRow {
  submission_id: string;
  turn_id: string;
  credential_id: string;
  idempotency_key: string;
  submission_canonical: string;
  accepted: bigint;
  receipt_id: string;
  created_wall: string;
}

interface ReceiptRow {
  receipt_canonical: string;
}

interface SimulationRow {
  simulation_id: string;
}

export interface AgentLabIdentity {
  readonly protocolVersion: typeof AGENT_LAB_PROTOCOL_VERSION;
  readonly simulationId: string;
  readonly runId: string;
  readonly studyId: string;
  readonly trialId: string;
  readonly credentialId: string;
  readonly agentId: string;
  readonly mode: "shadow" | "external";
  readonly scopes: readonly AgentLabScope[];
}

export interface IssuedAgentLabCredential {
  readonly token: string;
  readonly tokenType: "Bearer";
  readonly credentialId: string;
  readonly simulationId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly mode: "shadow" | "external";
  readonly scopes: readonly AgentLabScope[];
  readonly shownOnce: true;
}

export interface AgentLabTokenClaims {
  readonly simulationId: string;
  readonly runId: string;
  readonly credentialId: string;
}

export interface AgentLabArtifactRows {
  readonly turns: readonly AgentTurnEnvelope[];
  readonly submissions: readonly AgentActionSubmission[];
  readonly receipts: readonly AgentActionReceipt[];
  readonly toolCalls: readonly AgentLabToolCall[];
  readonly externallyInfluenced: boolean;
  readonly taint: TaintRecord;
}

export interface AgentLabToolCall {
  readonly sequence: number;
  readonly agentId: string;
  readonly toolName: typeof AGENT_LAB_MCP_TOOL_NAMES[number];
  readonly turnId: string | null;
  readonly status: "ok" | "error";
  readonly calledWall: string;
}

function safeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new EngineError("INTERNAL", `${field} is outside the safe integer range`);
  }
  return result;
}

function normalizeBoundaryKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function assertBoundarySafe(value: unknown, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new EngineError("SCHEMA_INVALID", `cyclic Agent Lab payload at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertBoundarySafe(item, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_BOUNDARY_KEYS.has(normalizeBoundaryKey(key))) {
        throw new EngineError(
          "PERMISSION_DENIED",
          `private or credential field is forbidden at ${path}.${key}`,
        );
      }
      assertBoundarySafe(item, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function parseCanonical<T>(text: string, parse: (value: unknown) => T, label: string): T {
  try {
    return parse(canonicalParse(text));
  } catch (error) {
    throw new EngineError(
      "CONFLICT",
      `${label} contains invalid canonical data`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function stableId(prefix: "turn" | "sub" | "rcpt" | "cred", value: unknown): string {
  return `${prefix}_${hashValue(value).slice(0, 24)}`;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function modeForCredential(mode: AgentLabMode): "shadow" | "external" {
  if (mode !== "shadow" && mode !== "external") {
    throw new EngineError("VALIDATION_FAILED", "native trials do not issue external credentials");
  }
  return mode;
}

function sortedScopes(scopes: readonly AgentLabScope[]): readonly AgentLabScope[] {
  const allowed = new Set<string>(AGENT_LAB_SCOPES);
  const unique = [...new Set(scopes)];
  if (unique.length === 0 || unique.some((scope) => !allowed.has(scope))) {
    throw new EngineError("VALIDATION_FAILED", "Agent Lab credential scopes are invalid");
  }
  return Object.freeze(unique.sort());
}

function validator(
  validatorName: string,
  ok: boolean,
  code: string,
  message: string,
) {
  return Object.freeze({ validator: validatorName, ok, code, message });
}

function receiptFromRow(row: ReceiptRow | undefined): AgentActionReceipt {
  if (row === undefined) throw new EngineError("NOT_FOUND", "Agent Lab receipt does not exist");
  return parseCanonical(
    row.receipt_canonical,
    (value) => agentActionReceiptSchema.parse(value),
    "Agent Lab receipt",
  );
}

export function parseAgentLabTokenClaims(token: string): AgentLabTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0]!.startsWith(TOKEN_PREFIX) || parts[1]!.length < 32) {
    throw new EngineError("PERMISSION_DENIED", "Agent Lab credential is malformed");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(parts[0]!.slice(TOKEN_PREFIX.length), "base64url").toString("utf8");
  } catch {
    throw new EngineError("PERMISSION_DENIED", "Agent Lab credential claims are malformed");
  }
  const [simulationId, runId, credentialId, extra] = decoded.split(".");
  if (
    simulationId === undefined ||
    runId === undefined ||
    credentialId === undefined ||
    extra !== undefined ||
    !/^sim_[0-9a-z]{8,}$/.test(simulationId) ||
    !/^run_[0-9a-z]{8,}$/.test(runId) ||
    !CREDENTIAL_ID_PATTERN.test(credentialId)
  ) {
    throw new EngineError("PERMISSION_DENIED", "Agent Lab credential claims are invalid");
  }
  return Object.freeze({ simulationId, runId, credentialId });
}

export class SqliteAgentLabStore {
  constructor(
    private readonly db: WorldDatabase,
    readonly runId: string,
  ) {}

  initializeTrial(configInput: RunManifestAgentLab, createdWall: string): void {
    const config = runManifestAgentLabSchema.parse(configInput);
    const existing = this.trialRow();
    if (existing !== undefined) {
      if (existing.config_canonical !== canonicalStringify(config)) {
        throw new EngineError("CONFLICT", "Agent Lab trial configuration is immutable");
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO agent_lab_trials(
        run_id, protocol_version, study_id, trial_id, experiment_manifest_digest,
        mode, config_canonical, created_wall
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      config.protocolVersion,
      config.studyId,
      config.trialId,
      config.experimentManifestDigest,
      config.mode,
      canonicalStringify(config),
      createdWall,
    );
  }

  config(): RunManifestAgentLab {
    const row = this.trialRow();
    if (row === undefined) throw new EngineError("NOT_FOUND", "run is not an Agent Lab trial");
    return parseCanonical(
      row.config_canonical,
      (value) => runManifestAgentLabSchema.parse(value),
      "Agent Lab trial",
    );
  }

  issueCredential(input: {
    readonly agentId: string;
    readonly scopes?: readonly AgentLabScope[];
    readonly createdWall: string;
  }): IssuedAgentLabCredential {
    const config = this.config();
    const mode = modeForCredential(config.mode);
    const assigned = config.resolvedAssignments.find(
      (assignment) => assignment.agentId === input.agentId,
    );
    if (assigned?.controller !== mode) {
      throw new EngineError(
        "PERMISSION_DENIED",
        `agent ${input.agentId} is not assigned to the ${mode} controller`,
      );
    }
    const existing = this.db.prepare<[string, string], CredentialRow>(`
      SELECT * FROM agent_lab_credentials
      WHERE run_id = ? AND agent_id = ? AND status = 'active'
    `).get(this.runId, input.agentId);
    if (existing !== undefined) {
      throw new EngineError(
        "CONFLICT",
        `agent ${input.agentId} already has an active credential`,
      );
    }
    const simulation = this.db.prepare<[string], SimulationRow>(`
      SELECT simulation_id FROM simulation_runs WHERE id = ?
    `).get(this.runId);
    if (simulation === undefined) throw new EngineError("NOT_FOUND", "run does not exist");

    const credentialId = stableId("cred", {
      runId: this.runId,
      agentId: input.agentId,
      nonce: randomBytes(32).toString("hex"),
    });
    const claims = Buffer.from(
      `${simulation.simulation_id}.${this.runId}.${credentialId}`,
      "utf8",
    ).toString("base64url");
    const token = `${TOKEN_PREFIX}${claims}.${randomBytes(32).toString("base64url")}`;
    const scopes = sortedScopes(input.scopes ?? AGENT_LAB_SCOPES);
    this.db.prepare(`
      INSERT INTO agent_lab_credentials(
        run_id, credential_id, token_hash, agent_id, mode, scopes_canonical,
        status, created_wall
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      this.runId,
      credentialId,
      sha256Hex(token),
      input.agentId,
      mode,
      canonicalStringify(scopes),
      input.createdWall,
    );
    return Object.freeze({
      token,
      tokenType: "Bearer",
      credentialId,
      simulationId: simulation.simulation_id,
      runId: this.runId,
      agentId: input.agentId,
      mode,
      scopes,
      shownOnce: true,
    });
  }

  authenticate(
    token: string,
    usedWall: string,
    requiredScope?: AgentLabScope,
  ): AgentLabIdentity {
    const claims = parseAgentLabTokenClaims(token);
    if (claims.runId !== this.runId) {
      throw new EngineError("PERMISSION_DENIED", "Agent Lab credential belongs to another run");
    }
    const row = this.db.prepare<[string, string], CredentialRow>(`
      SELECT * FROM agent_lab_credentials
      WHERE run_id = ? AND credential_id = ?
    `).get(this.runId, claims.credentialId);
    const tokenHash = sha256Hex(token);
    if (
      row === undefined ||
      row.status !== "active" ||
      !hashesEqual(row.token_hash, tokenHash)
    ) {
      throw new EngineError("PERMISSION_DENIED", "Agent Lab credential is invalid or revoked");
    }
    const scopes = parseCanonical(
      row.scopes_canonical,
      (value) => zodScopes(value),
      "Agent Lab scopes",
    );
    if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
      throw new EngineError("PERMISSION_DENIED", `scope ${requiredScope} is required`);
    }
    const trial = this.trialRow();
    if (trial === undefined) throw new EngineError("NOT_FOUND", "Agent Lab trial does not exist");
    this.db.prepare(`
      UPDATE agent_lab_credentials SET last_used_wall = ?
      WHERE run_id = ? AND credential_id = ? AND status = 'active'
    `).run(usedWall, this.runId, claims.credentialId);
    return Object.freeze({
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      simulationId: claims.simulationId,
      runId: this.runId,
      studyId: trial.study_id,
      trialId: trial.trial_id,
      credentialId: row.credential_id,
      agentId: row.agent_id,
      mode: modeForCredential(row.mode as AgentLabMode),
      scopes,
    });
  }

  revokeCredential(credentialId: string, revokedWall: string): void {
    const result = this.db.prepare(`
      UPDATE agent_lab_credentials
      SET status = 'revoked', revoked_wall = ?
      WHERE run_id = ? AND credential_id = ? AND status = 'active'
    `).run(revokedWall, this.runId, credentialId);
    if (result.changes !== 1) {
      throw new EngineError("NOT_FOUND", "active Agent Lab credential does not exist");
    }
    const row = this.db.prepare<[string, string], CredentialRow>(`
      SELECT * FROM agent_lab_credentials WHERE run_id = ? AND credential_id = ?
    `).get(this.runId, credentialId);
    if (row !== undefined) this.expireOpenTurnsForAgent(row.agent_id, revokedWall);
  }

  openTurn(envelopeInput: AgentTurnEnvelope, createdWall: string): AgentTurnEnvelope {
    const envelope = agentTurnEnvelopeSchema.parse(envelopeInput);
    if (envelope.runId !== this.runId) {
      throw new EngineError("CONFLICT", "Agent Lab turn belongs to another run");
    }
    const config = this.config();
    if (
      envelope.studyId !== config.studyId ||
      envelope.trialId !== config.trialId ||
      envelope.driverPolicyDigest !== config.driverPolicyDigest ||
      envelope.promptDigest !== config.promptDigest ||
      envelope.toolSchemaDigest !== config.toolSchemaDigest
    ) {
      throw new EngineError("CONFLICT", "Agent Lab turn does not match its pinned trial");
    }
    const assignment = config.resolvedAssignments.find(
      (candidate) => candidate.agentId === envelope.agentId,
    );
    if (assignment?.controller !== envelope.controller) {
      throw new EngineError("PERMISSION_DENIED", "Agent Lab controller assignment does not match");
    }
    assertBoundarySafe(envelope.observation);
    const canonical = canonicalStringify(envelope);
    const existing = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns WHERE run_id = ? AND opportunity_key = ?
    `).get(this.runId, envelope.opportunityKey);
    if (existing !== undefined) {
      if (existing.envelope_canonical !== canonical) {
        throw new EngineError("CONFLICT", "Agent Lab opportunity cannot map to another turn");
      }
      return parseCanonical(
        existing.envelope_canonical,
        (value) => agentTurnEnvelopeSchema.parse(value),
        "Agent Lab turn",
      );
    }
    this.db.prepare(`
      INSERT INTO agent_lab_turns(
        run_id, turn_id, trial_id, agent_id, controller, opportunity_key,
        completed_tick, target_tick, projection_hash, menu_hash,
        envelope_canonical, status, deadline_wall, created_wall, updated_wall
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(
      this.runId,
      envelope.turnId,
      envelope.trialId,
      envelope.agentId,
      envelope.controller,
      envelope.opportunityKey,
      envelope.completedTick,
      envelope.targetTick,
      envelope.projectionHash,
      envelope.menuHash,
      canonical,
      envelope.deadline,
      createdWall,
      createdWall,
    );
    const activeCredential = this.db.prepare<
      [string, string],
      { credential_id: string }
    >(`
      SELECT credential_id
      FROM agent_lab_credentials
      WHERE run_id = ? AND agent_id = ? AND status = 'active'
      LIMIT 1
    `).get(this.runId, envelope.agentId);
    if (activeCredential === undefined) {
      this.expireTurn(envelope.turnId, createdWall);
    }
    return envelope;
  }

  turnForIdentity(identity: AgentLabIdentity, nowWall: string): AgentTurnEnvelope | null {
    this.expireDueTurns(nowWall);
    const row = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns
      WHERE run_id = ? AND agent_id = ? AND status IN ('open', 'submitted')
      ORDER BY target_tick, turn_id LIMIT 1
    `).get(this.runId, identity.agentId);
    if (row === undefined) return null;
    return parseCanonical(
      row.envelope_canonical,
      (value) => agentTurnEnvelopeSchema.parse(value),
      "Agent Lab turn",
    );
  }

  submit(
    identity: AgentLabIdentity,
    submissionInput: AgentActionSubmission,
    createdWall: string,
  ): AgentActionReceipt {
    const submission = agentActionSubmissionSchema.parse(submissionInput);
    assertBoundarySafe(submission.action.params);
    const prior = this.db.prepare<[string, string, string], SubmissionRow>(`
      SELECT * FROM agent_lab_submissions
      WHERE run_id = ? AND turn_id = ? AND idempotency_key = ?
    `).get(this.runId, submission.turnId, submission.idempotencyKey);
    if (prior !== undefined) return this.receipt(identity, prior.submission_id);

    const turn = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns WHERE run_id = ? AND turn_id = ?
    `).get(this.runId, submission.turnId);
    if (turn === undefined || turn.agent_id !== identity.agentId) {
      throw new EngineError("NOT_FOUND", "Agent Lab turn is not owned by this credential");
    }
    const envelope = parseCanonical(
      turn.envelope_canonical,
      (value) => agentTurnEnvelopeSchema.parse(value),
      "Agent Lab turn",
    );
    const results = [];
    let status: AgentActionReceipt["status"];
    let accepted = false;
    const now = Date.parse(createdWall);
    const deadline = Date.parse(turn.deadline_wall);
    if (turn.status !== "open") {
      status = "stale";
      results.push(validator("turn_status", false, "STALE", "the decision window is closed"));
    } else if (!Number.isFinite(now) || !Number.isFinite(deadline) || now > deadline) {
      status = "stale";
      results.push(validator("deadline", false, "STALE", "the decision deadline has passed"));
    } else if (submission.targetTick !== safeNumber(turn.target_tick, "target tick")) {
      status = "stale";
      results.push(validator("target_tick", false, "STALE", "target tick is no longer open"));
    } else if (submission.observedProjectionHash !== turn.projection_hash) {
      status = "stale";
      results.push(validator(
        "projection_hash",
        false,
        "STALE",
        "observed projection hash is stale",
      ));
    } else if (submission.observedMenuHash !== turn.menu_hash) {
      status = "stale";
      results.push(validator("menu_hash", false, "STALE", "observed menu hash is stale"));
    } else if (submission.driverPolicyDigest !== envelope.driverPolicyDigest) {
      status = "rejected";
      results.push(validator(
        "driver_policy",
        false,
        "POLICY_MISMATCH",
        "driver policy digest does not match the trial",
      ));
    } else if (
      !envelope.offeredOptions.some((option) => option.actionId === submission.action.actionId)
    ) {
      status = "rejected";
      results.push(validator(
        "offered_action",
        false,
        "PERMISSION_DENIED",
        "action is outside the engine-offered menu",
      ));
    } else if (
      canonicalStringify(submission.action.params) !== canonicalStringify(
        envelope.offeredOptions.find(
          (option) => option.actionId === submission.action.actionId,
        )!.params,
      )
    ) {
      status = "rejected";
      results.push(validator(
        "offered_params",
        false,
        "PERMISSION_DENIED",
        "action parameters differ from the engine-offered option",
      ));
    } else {
      accepted = true;
      status = turn.controller === "shadow" ? "shadowed" : "queued";
      results.push(
        validator("turn_status", true, "OK", "turn is open"),
        validator("target_tick", true, "OK", "target tick matches"),
        validator("projection_hash", true, "OK", "projection hash matches"),
        validator("menu_hash", true, "OK", "menu hash matches"),
        validator("driver_policy", true, "OK", "driver policy matches"),
        validator("offered_action", true, "OK", "action is in the offered menu"),
        validator("offered_params", true, "OK", "action parameters match the offered option"),
      );
    }

    const submissionId = stableId("sub", {
      runId: this.runId,
      turnId: submission.turnId,
      idempotencyKey: submission.idempotencyKey,
    });
    const receiptId = stableId("rcpt", { submissionId });
    const completed = status === "queued" ? undefined : createdWall;
    const receipt = agentActionReceiptSchema.parse({
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      receiptId,
      submissionId,
      turnId: submission.turnId,
      runId: this.runId,
      agentId: identity.agentId,
      targetTick: envelope.targetTick,
      status,
      validatorResults: results,
      resultEventIds: [],
      createdWall,
      ...(completed === undefined ? {} : { completedWall: completed }),
    });

    this.db.transaction(() => {
      try {
        this.db.prepare(`
          INSERT INTO agent_lab_submissions(
            run_id, submission_id, turn_id, credential_id, idempotency_key,
            submission_canonical, accepted, receipt_id, created_wall
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.runId,
          submissionId,
          submission.turnId,
          identity.credentialId,
          submission.idempotencyKey,
          canonicalStringify(submission),
          accepted ? 1 : 0,
          receiptId,
          createdWall,
        );
      } catch (error) {
        const acceptedPrior = this.db.prepare<[string, string], SubmissionRow>(`
          SELECT * FROM agent_lab_submissions
          WHERE run_id = ? AND turn_id = ? AND accepted = 1
        `).get(this.runId, submission.turnId);
        if (acceptedPrior !== undefined) {
          throw new EngineError("CONFLICT", "one submission is already accepted for this turn");
        }
        throw error;
      }
      this.insertReceipt(receipt);
      if (accepted) {
        const terminal = status === "shadowed";
        this.db.prepare(`
          UPDATE agent_lab_turns
          SET status = ?, terminal_receipt_id = ?, updated_wall = ?
          WHERE run_id = ? AND turn_id = ? AND status = 'open'
        `).run(
          terminal ? "terminal" : "submitted",
          terminal ? receiptId : null,
          createdWall,
          this.runId,
          submission.turnId,
        );
        if (status === "queued") {
          this.db.prepare(`
            UPDATE agent_lab_trials SET externally_influenced = 1 WHERE run_id = ?
          `).run(this.runId);
        }
      } else if (status === "stale" && now > deadline) {
        this.expireTurn(submission.turnId, createdWall);
      }
    }).immediate();
    return receipt;
  }

  receipt(identity: AgentLabIdentity, submissionId: string): AgentActionReceipt {
    const row = this.db.prepare<[string, string, string], ReceiptRow>(`
      SELECT receipt.receipt_canonical
      FROM agent_lab_receipts receipt
      JOIN agent_lab_submissions submission
        ON submission.run_id = receipt.run_id
        AND submission.submission_id = receipt.submission_id
      WHERE receipt.run_id = ? AND receipt.submission_id = ?
        AND receipt.agent_id = ?
    `).get(this.runId, submissionId, identity.agentId);
    return receiptFromRow(row);
  }

  acceptedSubmission(turnId: string): AgentActionSubmission | null {
    const row = this.db.prepare<[string, string], SubmissionRow>(`
      SELECT * FROM agent_lab_submissions
      WHERE run_id = ? AND turn_id = ? AND accepted = 1
    `).get(this.runId, turnId);
    if (row === undefined) return null;
    return parseCanonical(
      row.submission_canonical,
      (value) => agentActionSubmissionSchema.parse(value),
      "Agent Lab submission",
    );
  }

  async waitForAcceptedSubmission(
    turnId: string,
    wallClock: () => string,
    pollIntervalMs = 20,
  ): Promise<AgentActionSubmission | null> {
    for (;;) {
      const accepted = this.acceptedSubmission(turnId);
      if (accepted !== null) return accepted;
      const row = this.db.prepare<[string, string], TurnRow>(`
        SELECT * FROM agent_lab_turns WHERE run_id = ? AND turn_id = ?
      `).get(this.runId, turnId);
      if (row === undefined || row.status === "terminal") return null;
      const nowWall = wallClock();
      if (Date.parse(nowWall) > Date.parse(row.deadline_wall)) {
        this.expireTurn(turnId, nowWall);
        return null;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        timer.unref?.();
      });
    }
  }

  finalizeTurn(input: {
    readonly opportunityKey: string;
    readonly status: "applied" | "rejected" | "fallback";
    readonly validatorResults: AgentActionReceipt["validatorResults"];
    readonly resultEventIds: readonly string[];
    readonly completedWall: string;
  }): AgentActionReceipt | null {
    const turn = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns WHERE run_id = ? AND opportunity_key = ?
    `).get(this.runId, input.opportunityKey);
    if (turn === undefined || turn.controller !== "external") return null;
    if (turn.status === "open") {
      return this.expireTurn(turn.turn_id, input.completedWall);
    }
    const submission = this.db.prepare<[string, string], SubmissionRow>(`
      SELECT * FROM agent_lab_submissions
      WHERE run_id = ? AND turn_id = ? AND accepted = 1
    `).get(this.runId, turn.turn_id);
    if (submission === undefined) {
      return this.expireTurn(turn.turn_id, input.completedWall);
    }
    const previous = receiptFromRow(
      this.db.prepare<[string, string], ReceiptRow>(`
        SELECT receipt_canonical FROM agent_lab_receipts
        WHERE run_id = ? AND receipt_id = ?
      `).get(this.runId, submission.receipt_id),
    );
    if (previous.status !== "queued") return previous;
    const receipt = agentActionReceiptSchema.parse({
      ...previous,
      status: input.status,
      validatorResults: [...previous.validatorResults, ...input.validatorResults],
      resultEventIds: [...input.resultEventIds],
      completedWall: input.completedWall,
    });
    this.updateReceipt(receipt);
    this.db.prepare(`
      UPDATE agent_lab_turns
      SET status = 'terminal', terminal_receipt_id = ?, updated_wall = ?
      WHERE run_id = ? AND turn_id = ?
    `).run(receipt.receiptId, input.completedWall, this.runId, turn.turn_id);
    return receipt;
  }

  finalizePostTick(targetTick: number, stateHash: string): void {
    const rows = this.db.prepare<[string, number], ReceiptRow>(`
      SELECT receipt_canonical FROM agent_lab_receipts
      WHERE run_id = ? AND target_tick = ? AND status = 'applied'
    `).all(this.runId, targetTick);
    for (const row of rows) {
      const receipt = receiptFromRow(row);
      if (receipt.postTickStateHash !== undefined) {
        if (receipt.postTickStateHash !== stateHash) {
          throw new EngineError("CONFLICT", "Agent Lab post-tick state hash is immutable");
        }
        continue;
      }
      this.updateReceipt(agentActionReceiptSchema.parse({
        ...receipt,
        postTickStateHash: stateHash,
      }));
    }
  }

  expireDueTurns(nowWall: string): void {
    const rows = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns
      WHERE run_id = ? AND status IN ('open', 'submitted') AND deadline_wall < ?
      ORDER BY target_tick, turn_id
    `).all(this.runId, nowWall);
    for (const row of rows) this.expireTurn(row.turn_id, nowWall);
  }

  markTainted(
    code: "manual_input" | "manifest_drift" | "unmanifested_intervention" | "artifact_corrupt",
    detail: string,
    recordedWall: string,
  ): TaintRecord {
    const trial = this.trialRow();
    if (trial === undefined) throw new EngineError("NOT_FOUND", "Agent Lab trial does not exist");
    const current = taintRecordSchema.parse(canonicalParse(trial.taint_canonical));
    const next = taintRecordSchema.parse({
      tainted: true,
      reasons: [...current.reasons, { code, detail, recordedWall }],
    });
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_lab_taint_records(run_id, sequence, code, detail, recorded_wall)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.runId, current.reasons.length, code, detail, recordedWall);
      this.db.prepare(`
        UPDATE agent_lab_trials SET tainted = 1, taint_canonical = ? WHERE run_id = ?
      `).run(canonicalStringify(next), this.runId);
    }).immediate();
    return next;
  }

  reserveToolCall(input: {
    readonly identity: AgentLabIdentity;
    readonly toolName: typeof AGENT_LAB_MCP_TOOL_NAMES[number];
    readonly turnId?: string;
    readonly submissionId?: string;
    readonly calledWall: string;
  }): number {
    if (input.identity.runId !== this.runId) {
      throw new EngineError("PERMISSION_DENIED", "tool-call identity belongs to another run");
    }
    if (!AGENT_LAB_MCP_TOOL_NAMES.includes(input.toolName)) {
      throw new EngineError("VALIDATION_FAILED", "Agent Lab tool name is not recognized");
    }
    if (
      input.turnId !== undefined &&
      !/^turn_[0-9a-f]{24}$/.test(input.turnId)
    ) {
      throw new EngineError("VALIDATION_FAILED", "Agent Lab tool-call turn ID is invalid");
    }
    return this.db.transaction(() => {
      let effectiveTurnId = input.turnId;
      if (effectiveTurnId === undefined && input.submissionId !== undefined) {
        effectiveTurnId = this.db.prepare<
          [string, string],
          { turn_id: string }
        >(`
          SELECT turn_id
          FROM agent_lab_submissions
          WHERE run_id = ? AND submission_id = ?
        `).get(this.runId, input.submissionId)?.turn_id;
      }
      if (effectiveTurnId === undefined) {
        effectiveTurnId = this.db.prepare<
          [string, string],
          { turn_id: string }
        >(`
          SELECT turn_id
          FROM agent_lab_turns
          WHERE run_id = ? AND agent_id = ?
          ORDER BY target_tick DESC, turn_id DESC
          LIMIT 1
        `).get(this.runId, input.identity.agentId)?.turn_id;
      }
      if (effectiveTurnId === undefined) {
        throw new EngineError("CONFLICT", "Agent Lab tool call has no trial turn");
      }
      const ownedTurn = this.db.prepare<
        [string, string, string],
        { turn_id: string }
      >(`
        SELECT turn_id
        FROM agent_lab_turns
        WHERE run_id = ? AND turn_id = ? AND agent_id = ?
      `).get(this.runId, effectiveTurnId, input.identity.agentId);
      if (ownedTurn === undefined) {
        throw new EngineError("PERMISSION_DENIED", "Agent Lab tool-call turn is not owned");
      }
      const maxToolCalls = this.config().budget.maxToolCalls;
      const used = this.db.prepare<
        [string, string, string],
        { count: bigint }
      >(`
        SELECT COUNT(*) AS count
        FROM agent_lab_tool_calls
        WHERE run_id = ? AND agent_id = ? AND turn_id = ?
      `).get(this.runId, input.identity.agentId, effectiveTurnId)?.count ?? 0n;
      if (used >= BigInt(maxToolCalls)) {
        throw new EngineError(
          "BUDGET_EXHAUSTED",
          `Agent Lab turn exceeded its ${maxToolCalls}-call MCP budget`,
        );
      }
      const row = this.db.prepare<[string], { next_sequence: bigint }>(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM agent_lab_tool_calls
        WHERE run_id = ?
      `).get(this.runId);
      const sequence = safeNumber(row?.next_sequence ?? 0n, "Agent Lab tool-call sequence");
      this.db.prepare(`
        INSERT INTO agent_lab_tool_calls(
          run_id, sequence, agent_id, tool_name, turn_id, status, called_wall
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        sequence,
        input.identity.agentId,
        input.toolName,
        effectiveTurnId,
        "error",
        input.calledWall,
      );
      return sequence;
    }).immediate();
  }

  finishToolCall(
    identity: AgentLabIdentity,
    sequence: number,
    status: "ok" | "error",
  ): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new EngineError("VALIDATION_FAILED", "Agent Lab tool-call sequence is invalid");
    }
    const result = this.db.prepare(`
      UPDATE agent_lab_tool_calls
      SET status = ?
      WHERE run_id = ? AND sequence = ? AND agent_id = ?
    `).run(status, this.runId, sequence, identity.agentId);
    if (result.changes !== 1) {
      throw new EngineError("PERMISSION_DENIED", "Agent Lab tool call is not owned");
    }
  }

  artifactRows(): AgentLabArtifactRows {
    const trial = this.trialRow();
    if (trial === undefined) throw new EngineError("NOT_FOUND", "Agent Lab trial does not exist");
    const turns = this.db.prepare<[string], Pick<TurnRow, "envelope_canonical">>(`
      SELECT envelope_canonical FROM agent_lab_turns
      WHERE run_id = ? ORDER BY target_tick, turn_id
    `).all(this.runId).map((row) => parseCanonical(
      row.envelope_canonical,
      (value) => agentTurnEnvelopeSchema.parse(value),
      "Agent Lab turn",
    ));
    const submissions = this.db.prepare<[string], Pick<SubmissionRow, "submission_canonical">>(`
      SELECT submission_canonical FROM agent_lab_submissions
      WHERE run_id = ? ORDER BY created_wall, submission_id
    `).all(this.runId).map((row) => parseCanonical(
      row.submission_canonical,
      (value) => agentActionSubmissionSchema.parse(value),
      "Agent Lab submission",
    ));
    const receipts = this.db.prepare<[string], ReceiptRow>(`
      SELECT receipt_canonical FROM agent_lab_receipts
      WHERE run_id = ? ORDER BY created_wall, receipt_id
    `).all(this.runId).map(receiptFromRow);
    const toolCalls = this.db.prepare<[string], {
      sequence: bigint;
      agent_id: string;
      tool_name: typeof AGENT_LAB_MCP_TOOL_NAMES[number];
      turn_id: string | null;
      status: "ok" | "error";
      called_wall: string;
    }>(`
      SELECT sequence, agent_id, tool_name, turn_id, status, called_wall
      FROM agent_lab_tool_calls
      WHERE run_id = ?
      ORDER BY sequence
    `).all(this.runId).map((row) => Object.freeze({
      sequence: safeNumber(row.sequence, "Agent Lab tool-call sequence"),
      agentId: row.agent_id,
      toolName: row.tool_name,
      turnId: row.turn_id,
      status: row.status,
      calledWall: row.called_wall,
    }));
    return Object.freeze({
      turns: Object.freeze(turns),
      submissions: Object.freeze(submissions),
      receipts: Object.freeze(receipts),
      toolCalls: Object.freeze(toolCalls),
      externallyInfluenced: trial.externally_influenced === 1n,
      taint: taintRecordSchema.parse(canonicalParse(trial.taint_canonical)),
    });
  }

  private trialRow(): TrialRow | undefined {
    return this.db.prepare<[string], TrialRow>(`
      SELECT * FROM agent_lab_trials WHERE run_id = ?
    `).get(this.runId);
  }

  private insertReceipt(receipt: AgentActionReceipt): void {
    this.db.prepare(`
      INSERT INTO agent_lab_receipts(
        run_id, receipt_id, submission_id, turn_id, agent_id, target_tick,
        status, receipt_canonical, created_wall, completed_wall
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      receipt.receiptId,
      receipt.submissionId ?? null,
      receipt.turnId,
      receipt.agentId,
      receipt.targetTick,
      receipt.status,
      canonicalStringify(receipt),
      receipt.createdWall,
      receipt.completedWall ?? null,
    );
  }

  private updateReceipt(receipt: AgentActionReceipt): void {
    const result = this.db.prepare(`
      UPDATE agent_lab_receipts
      SET status = ?, receipt_canonical = ?, completed_wall = ?
      WHERE run_id = ? AND receipt_id = ?
    `).run(
      receipt.status,
      canonicalStringify(receipt),
      receipt.completedWall ?? null,
      this.runId,
      receipt.receiptId,
    );
    if (result.changes !== 1) throw new EngineError("NOT_FOUND", "Agent Lab receipt disappeared");
  }

  private expireTurn(turnId: string, completedWall: string): AgentActionReceipt {
    const turn = this.db.prepare<[string, string], TurnRow>(`
      SELECT * FROM agent_lab_turns WHERE run_id = ? AND turn_id = ?
    `).get(this.runId, turnId);
    if (turn === undefined) throw new EngineError("NOT_FOUND", "Agent Lab turn does not exist");
    if (turn.terminal_receipt_id !== null) {
      return receiptFromRow(this.db.prepare<[string, string], ReceiptRow>(`
        SELECT receipt_canonical FROM agent_lab_receipts
        WHERE run_id = ? AND receipt_id = ?
      `).get(this.runId, turn.terminal_receipt_id));
    }
    const accepted = this.db.prepare<[string, string], SubmissionRow>(`
      SELECT * FROM agent_lab_submissions
      WHERE run_id = ? AND turn_id = ? AND accepted = 1
    `).get(this.runId, turnId);
    if (accepted !== undefined) {
      const queued = receiptFromRow(this.db.prepare<[string, string], ReceiptRow>(`
        SELECT receipt_canonical FROM agent_lab_receipts
        WHERE run_id = ? AND receipt_id = ?
      `).get(this.runId, accepted.receipt_id));
      const fallback = agentActionReceiptSchema.parse({
        ...queued,
        status: "fallback",
        validatorResults: [
          ...queued.validatorResults,
          validator(
            "credential_or_deadline",
            false,
            "FALLBACK",
            "accepted submission could not be applied before the turn closed",
          ),
        ],
        completedWall,
      });
      this.updateReceipt(fallback);
      this.db.prepare(`
        UPDATE agent_lab_turns
        SET status = 'terminal', terminal_receipt_id = ?, updated_wall = ?
        WHERE run_id = ? AND turn_id = ?
      `).run(fallback.receiptId, completedWall, this.runId, turnId);
      return fallback;
    }
    const receiptId = stableId("rcpt", { turnId, status: "fallback" });
    const receipt = agentActionReceiptSchema.parse({
      protocolVersion: AGENT_LAB_PROTOCOL_VERSION,
      receiptId,
      turnId,
      runId: this.runId,
      agentId: turn.agent_id,
      targetTick: safeNumber(turn.target_tick, "target tick"),
      status: "fallback",
      validatorResults: [
        validator("deadline", false, "FALLBACK", "no accepted submission reached the deadline"),
      ],
      resultEventIds: [],
      createdWall: turn.created_wall,
      completedWall,
    });
    this.insertReceipt(receipt);
    this.db.prepare(`
      UPDATE agent_lab_turns
      SET status = 'terminal', terminal_receipt_id = ?, updated_wall = ?
      WHERE run_id = ? AND turn_id = ?
    `).run(receiptId, completedWall, this.runId, turnId);
    return receipt;
  }

  private expireOpenTurnsForAgent(agentId: string, completedWall: string): void {
    const turns = this.db.prepare<[string, string], Pick<TurnRow, "turn_id">>(`
      SELECT turn_id FROM agent_lab_turns
      WHERE run_id = ? AND agent_id = ? AND status IN ('open', 'submitted')
      ORDER BY target_tick, turn_id
    `).all(this.runId, agentId);
    for (const turn of turns) this.expireTurn(turn.turn_id, completedWall);
  }
}

function zodScopes(value: unknown): readonly AgentLabScope[] {
  if (!Array.isArray(value)) throw new TypeError("scopes must be an array");
  const allowed = new Set<string>(AGENT_LAB_SCOPES);
  const scopes = value.map((scope) => {
    if (typeof scope !== "string" || !allowed.has(scope)) {
      throw new TypeError("scope is not recognized");
    }
    return scope as AgentLabScope;
  });
  return sortedScopes(scopes);
}
