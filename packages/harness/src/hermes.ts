import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
  AgentTurnEnvelope,
  ExperimentManifest,
} from "@worldtangle/shared";
import { z } from "zod";
import { CITIZEN_TURN_PROMPT } from "./driver-policy";
import { providerEnvironmentNames } from "./provider-environment";

export const hermesTurnStatsSchema = z.strictObject({
  runId: z.string().min(1).max(240),
  turnId: z.string().regex(/^turn_[0-9a-f]{24}$/).optional(),
  opportunityKey: z.string().min(1).max(240).optional(),
  agentId: z.string().regex(/^agt_[0-9a-z]{8,}$/),
  targetTick: z.number().int().positive(),
  status: z.enum(["completed", "failed", "cancelled"]),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  budgetViolations: z.array(z.string()),
  failure: z.string().max(1_000).optional(),
});
type ParsedHermesTurnStats = z.infer<typeof hermesTurnStatsSchema>;
export type HermesTurnStats = Readonly<
  Omit<ParsedHermesTurnStats, "budgetViolations"> & {
    readonly budgetViolations: readonly string[];
  }
>;

export interface HermesEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly terminateProfile: () => Promise<void>;
}

export interface HermesProfileCredential {
  readonly agentId: string;
  readonly token: string;
}

interface HermesRunStatus {
  readonly run_id?: unknown;
  readonly status?: unknown;
  readonly usage?: unknown;
  readonly error?: unknown;
}

type HermesTerminalStatus = HermesRunStatus & {
  readonly status: "completed" | "failed" | "cancelled";
};

interface HermesBudgetReservation {
  readonly tickKey: string;
  readonly tokens: number;
  readonly costMicrocents: bigint;
}

interface HermesAccountedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly violations: readonly string[];
}

interface HermesToolsetsResponse {
  readonly data?: unknown;
}

function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

async function unusedLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

export function profileConfig(
  manifest: ExperimentManifest,
  gatewayUrl: string,
): string {
  return [
    "model:",
    `  default: ${yamlQuoted(manifest.provider.model)}`,
    `  max_tokens: ${manifest.generationBudget.maxOutputTokens}`,
    "fallback_providers: []",
    "toolsets: []",
    "platform_toolsets:",
    "  api_server: []",
    "agent:",
    `  max_turns: ${manifest.generationBudget.maxAgentLoopIterations}`,
    "  api_max_retries: 0",
    "  disabled_toolsets:",
    "    - terminal",
    "    - file",
    "    - web",
    "    - browser",
    "    - memory",
    "    - delegation",
    "    - computer",
    "    - skills",
    "terminal:",
    "  home_mode: profile",
    "skills:",
    "  external_dirs: []",
    "  inline_shell: false",
    "mcp_servers:",
    "  worldtangle:",
    "    enabled: true",
    `    url: ${yamlQuoted(`${gatewayUrl}/mcp`)}`,
    "    headers:",
    "      Authorization: \"Bearer ${WT_AGENT_LAB_PAT}\"",
    "    supports_parallel_tool_calls: false",
    "    tools:",
    "      include:",
    "        - wt_identity_get",
    "        - wt_turn_wait",
    "        - wt_action_submit",
    "        - wt_receipt_get",
    "      prompts: false",
    "      resources: false",
    "    sampling:",
    "      enabled: false",
    "",
  ].join("\n");
}

async function assertIsolatedToolSurface(endpoint: HermesEndpoint): Promise<void> {
  const response = await fetch(`${endpoint.baseUrl}/v1/toolsets`, {
    headers: { authorization: `Bearer ${endpoint.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Hermes profile ${endpoint.profileId} cannot prove its tool surface ` +
        `(HTTP ${response.status})`,
    );
  }
  const body = await response.json() as HermesToolsetsResponse;
  if (!Array.isArray(body.data)) {
    throw new Error(`Hermes profile ${endpoint.profileId} returned an invalid toolset inventory`);
  }
  const enabled = body.data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return ["<invalid>"];
    const record = entry as Record<string, unknown>;
    return record["enabled"] === true
      ? [typeof record["name"] === "string" ? record["name"] : "<unnamed>"]
      : [];
  });
  if (enabled.length > 0) {
    throw new Error(
      `Hermes profile ${endpoint.profileId} exposed forbidden native toolsets: ` +
        enabled.sort().join(", "),
    );
  }
}

async function waitForHealth(
  endpoint: HermesEndpoint,
  process: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Hermes profile ${endpoint.profileId} exited before becoming healthy`);
    }
    try {
      const response = await fetch(`${endpoint.baseUrl}/health`);
      if (response.ok) {
        await assertIsolatedToolSurface(endpoint);
        return;
      }
    } catch {
      // Startup race; continue within the bounded readiness window.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Hermes profile ${endpoint.profileId} did not become healthy`);
}

function inheritedRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = [
    "APPDATA",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let sanitized = text.replaceAll(/wtpat_[A-Za-z0-9._-]+/g, "[REDACTED]");
  const orderedSecrets = [...new Set(secrets.filter(
    (secret): secret is string => secret !== undefined && secret.length >= 8,
  ))].sort((left, right) => (
    right.length - left.length ||
    (left < right ? -1 : left > right ? 1 : 0)
  ));
  for (const secret of orderedSecrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized;
}

export function buildHermesProfileEnvironment(
  manifest: ExperimentManifest,
  profileRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const provider = Object.fromEntries(
    providerEnvironmentNames(manifest).map((name) => {
      const value = environment[name];
      if (value === undefined || value.length === 0) {
        throw new Error(`manifest-pinned provider environment is unavailable: ${name}`);
      }
      return [name, value];
    }),
  );
  return {
    ...inheritedRuntimeEnvironment(environment),
    ...provider,
    HERMES_HOME: profileRoot,
    HERMES_IGNORE_RULES: "1",
    HERMES_MAX_ITERATIONS: String(
      manifest.generationBudget.maxAgentLoopIterations,
    ),
    HERMES_MAX_TOKENS: String(manifest.generationBudget.maxOutputTokens),
    HERMES_INFERENCE_MODEL: manifest.provider.model,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

export async function terminateHermesProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const waitForExit = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  child.kill("SIGTERM");
  if (await waitForExit()) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  if (await waitForExit()) return;
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Hermes process did not exit after SIGKILL");
  }
}

export class HermesProfileFleet {
  private readonly processes: ChildProcess[] = [];
  private readonly profileRoots: string[] = [];

  constructor(
    private readonly trialRoot: string,
    private readonly executable = process.env["HERMES_EXECUTABLE"] ?? "hermes",
  ) {}

  private async terminateTrackedProcess(child: ChildProcess): Promise<void> {
    await terminateHermesProcess(child);
    const processIndex = this.processes.indexOf(child);
    if (processIndex >= 0) this.processes.splice(processIndex, 1);
  }

  async start(
    manifest: ExperimentManifest,
    gatewayUrl: string,
    credentials: readonly HermesProfileCredential[],
  ): Promise<ReadonlyMap<string, HermesEndpoint>> {
    if (!isLoopbackUrl(gatewayUrl)) {
      throw new Error("Hermes profiles may receive Agent Lab credentials only over loopback");
    }
    const endpoints = new Map<string, HermesEndpoint>();
    for (const credential of credentials) {
      const port = await unusedLoopbackPort();
      const profileId = `${manifest.studyId}-${credential.agentId}`;
      const profileRoot = join(this.trialRoot, "hermes-profiles", credential.agentId);
      const apiKey = randomBytes(32).toString("base64url");
      mkdirSync(profileRoot, { recursive: true });
      writeFileSync(
        join(profileRoot, "config.yaml"),
        profileConfig(manifest, gatewayUrl),
        { encoding: "utf8", mode: 0o600 },
      );
      writeFileSync(
        join(profileRoot, ".env"),
        [
          `API_SERVER_ENABLED=true`,
          `API_SERVER_HOST=127.0.0.1`,
          `API_SERVER_PORT=${port}`,
          `API_SERVER_KEY=${apiKey}`,
          `WT_AGENT_LAB_PAT=${credential.token}`,
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      const child = spawn(this.executable, ["gateway"], {
        cwd: profileRoot,
        env: buildHermesProfileEnvironment(manifest, profileRoot),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      const endpoint: HermesEndpoint = Object.freeze({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
        model: manifest.provider.model,
        profileId,
        sessionId: `worldtangle:${manifest.studyId}:${credential.agentId}`,
        sessionKey: `worldtangle-agent:${credential.agentId}`,
        terminateProfile: () => this.terminateTrackedProcess(child),
      });
      let startupError = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        startupError = `${startupError}${chunk.toString("utf8")}`.slice(-4_000);
      });
      this.processes.push(child);
      this.profileRoots.push(profileRoot);
      try {
        await waitForHealth(endpoint, child);
      } catch (error) {
        const sanitizedError = redactSecrets(startupError, [
          credential.token,
          apiKey,
          ...providerEnvironmentNames(manifest).map((name) => process.env[name]),
        ]);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}` +
            (sanitizedError.length === 0 ? "" : `; stderr: ${sanitizedError}`),
        );
      }
      endpoints.set(credential.agentId, endpoint);
    }
    return endpoints;
  }

  async stop(): Promise<void> {
    const terminationErrors = (
      await Promise.all(
        this.processes.splice(0).map(async (child): Promise<unknown | null> => {
          try {
            await terminateHermesProcess(child);
            return null;
          } catch (error) {
            return error;
          }
        }),
      )
    ).filter((error) => error !== null);
    if (terminationErrors.length > 0) {
      throw new AggregateError(
        terminationErrors,
        "one or more Hermes processes could not be terminated",
      );
    }
    for (const root of this.profileRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

interface HermesUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function usage(status: HermesRunStatus): HermesUsage | null {
  const value = status.usage;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = record["input_tokens"];
  const outputTokens = record["output_tokens"];
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) return null;
  return { inputTokens, outputTokens };
}

const HERMES_POLL_INTERVAL_MS = 100;
const HERMES_MAX_CONSECUTIVE_POLL_FAILURES = 2;
const HERMES_STOP_REQUEST_BUDGET_MS = 1_000;
const HERMES_RESPONSE_BODY_LIMIT_BYTES = 1_048_576;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

class HermesRequestDeadlineError extends Error {
  constructor(context: string) {
    const deadlineName = context === "stop"
      ? "cleanup deadline"
      : "decision deadline";
    super(`Hermes ${context} request exceeded the ${deadlineName}`);
    this.name = "HermesRequestDeadlineError";
  }
}

class HermesPollProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesPollProtocolError";
  }
}

class HermesTransientPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesTransientPollError";
  }
}

interface HermesDeadlineResponse {
  readonly response: Response;
  readonly bodyText: string | null;
}

async function readBoundedResponseText(
  response: Response,
  context: string,
): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > HERMES_RESPONSE_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new HermesPollProtocolError(
          `Hermes ${context} response body exceeds ` +
            `${HERMES_RESPONSE_BODY_LIMIT_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBeforeDeadline(
  input: string,
  init: RequestInit,
  deadline: number,
  context: string,
): Promise<HermesDeadlineResponse> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new HermesRequestDeadlineError(context);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(remainingMs, MAX_TIMER_DELAY_MS),
  );
  timeout.unref();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    let bodyText: string | null = null;
    if (response.ok || response.status === 202) {
      bodyText = await readBoundedResponseText(response, context);
    } else {
      // Provider error bodies are untrusted, can be unbounded, and may echo
      // credentials. Status codes are the complete persisted diagnostic.
      await response.body?.cancel();
    }
    return { response, bodyText };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HermesRequestDeadlineError(context);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class HermesApiTurnDriver {
  private readonly endpoints: Map<string, HermesEndpoint>;
  private readonly perAgentTickTokens = new Map<string, number>();
  private readonly reservedPerAgentTickTokens = new Map<string, number>();
  private readonly budgetReservations = new Map<string, HermesBudgetReservation>();
  private readonly accountedTurns = new Map<string, HermesAccountedUsage>();
  private spentMicrocents = 0n;
  private reservedMicrocents = 0n;

  constructor(
    endpoints: ReadonlyMap<string, HermesEndpoint>,
    private readonly manifest: ExperimentManifest,
    private readonly prompt = CITIZEN_TURN_PROMPT,
  ) {
    this.endpoints = new Map(endpoints);
  }

  private price(setting: "inputMicrocentsPerToken" | "outputMicrocentsPerToken"): bigint {
    const value = this.manifest.provider.settings[setting];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(`manifest ${setting} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }

  private cost(inputTokens: number, outputTokens: number): bigint {
    return BigInt(inputTokens) * this.price("inputMicrocentsPerToken") +
      BigInt(outputTokens) * this.price("outputMicrocentsPerToken");
  }

  private turnSecrets(
    endpoint: HermesEndpoint,
  ): readonly (string | undefined)[] {
    return [
      endpoint.apiKey,
      endpoint.sessionKey,
      ...providerEnvironmentNames(this.manifest).map((name) => process.env[name]),
    ];
  }

  private tickKey(turn: AgentTurnEnvelope): string {
    return `${turn.agentId}:${turn.targetTick}`;
  }

  private worstCaseUsage(): HermesUsage {
    return {
      inputTokens: this.manifest.generationBudget.maxInputTokens,
      outputTokens: this.manifest.generationBudget.maxOutputTokens,
    };
  }

  private reserveBudget(turn: AgentTurnEnvelope): string | null {
    if (this.budgetReservations.has(turn.turnId)) {
      throw new Error(`Hermes turn ${turn.turnId} already has a budget reservation`);
    }
    const worstCaseTokens =
      this.manifest.generationBudget.maxInputTokens +
      this.manifest.generationBudget.maxOutputTokens;
    const tickKey = this.tickKey(turn);
    const consumed = this.perAgentTickTokens.get(tickKey) ?? 0;
    const reserved = this.reservedPerAgentTickTokens.get(tickKey) ?? 0;
    if (
      consumed + reserved + worstCaseTokens >
      this.manifest.scenario.budgets.perAgentDailyTokens
    ) {
      return (
        `per-agent daily token budget cannot cover the pinned turn maximum ` +
        `(${consumed + reserved + worstCaseTokens} > ` +
        `${this.manifest.scenario.budgets.perAgentDailyTokens})`
      );
    }
    const worstCaseCost = this.cost(
      this.manifest.generationBudget.maxInputTokens,
      this.manifest.generationBudget.maxOutputTokens,
    );
    const runLimit =
      BigInt(this.manifest.scenario.budgets.runCostCentsMax) * 1_000_000n;
    if (this.spentMicrocents + this.reservedMicrocents + worstCaseCost > runLimit) {
      return (
        `run cost budget cannot cover the pinned turn maximum ` +
        `(${this.spentMicrocents + this.reservedMicrocents + worstCaseCost} > ` +
        `${runLimit} microcents)`
      );
    }
    this.budgetReservations.set(turn.turnId, {
      tickKey,
      tokens: worstCaseTokens,
      costMicrocents: worstCaseCost,
    });
    this.reservedPerAgentTickTokens.set(tickKey, reserved + worstCaseTokens);
    this.reservedMicrocents += worstCaseCost;
    return null;
  }

  private releaseBudgetReservation(turnId: string): void {
    const reservation = this.budgetReservations.get(turnId);
    if (reservation === undefined) return;
    this.budgetReservations.delete(turnId);
    const remainingTokens =
      (this.reservedPerAgentTickTokens.get(reservation.tickKey) ?? 0) -
      reservation.tokens;
    if (remainingTokens > 0) {
      this.reservedPerAgentTickTokens.set(reservation.tickKey, remainingTokens);
    } else {
      this.reservedPerAgentTickTokens.delete(reservation.tickKey);
    }
    this.reservedMicrocents -= reservation.costMicrocents;
  }

  private account(
    turn: AgentTurnEnvelope,
    inputTokens: number,
    outputTokens: number,
  ): readonly string[] {
    const accounted = this.accountedTurns.get(turn.turnId);
    if (accounted !== undefined) {
      this.releaseBudgetReservation(turn.turnId);
      throw new Error(
        `Hermes turn ${turn.turnId} was accounted more than once`,
      );
    }
    this.releaseBudgetReservation(turn.turnId);
    const violations: string[] = [];
    if (inputTokens > this.manifest.generationBudget.maxInputTokens) {
      violations.push(
        `input tokens ${inputTokens} exceed per-turn limit ` +
          `${this.manifest.generationBudget.maxInputTokens}`,
      );
    }
    if (outputTokens > this.manifest.generationBudget.maxOutputTokens) {
      violations.push(
        `output tokens ${outputTokens} exceed per-turn limit ` +
          `${this.manifest.generationBudget.maxOutputTokens}`,
      );
    }
    const total = inputTokens + outputTokens;
    const key = this.tickKey(turn);
    const daily = (this.perAgentTickTokens.get(key) ?? 0) + total;
    if (daily > this.manifest.scenario.budgets.perAgentDailyTokens) {
      violations.push(
        `daily tokens ${daily} exceed per-agent limit ` +
        `${this.manifest.scenario.budgets.perAgentDailyTokens}`,
      );
    }
    const spentMicrocents = this.spentMicrocents + this.cost(inputTokens, outputTokens);
    const runLimit =
      BigInt(this.manifest.scenario.budgets.runCostCentsMax) * 1_000_000n;
    if (spentMicrocents > runLimit) {
      violations.push(
        `run cost ${spentMicrocents} exceeds limit ${runLimit} microcents`,
      );
    }
    const frozenViolations = Object.freeze(violations);
    this.perAgentTickTokens.set(key, daily);
    this.spentMicrocents = spentMicrocents;
    this.accountedTurns.set(turn.turnId, {
      inputTokens,
      outputTokens,
      violations: frozenViolations,
    });
    return frozenViolations;
  }

  async runTurn(turn: AgentTurnEnvelope): Promise<HermesTurnStats> {
    const endpoint = this.endpoints.get(turn.agentId);
    if (endpoint === undefined) {
      throw new Error(`no isolated Hermes profile exists for ${turn.agentId}`);
    }
    if (!isLoopbackUrl(endpoint.baseUrl)) {
      throw new Error("Hermes Agent Lab endpoints must be loopback");
    }
    if (this.accountedTurns.has(turn.turnId)) {
      throw new Error(
        `Hermes turn ${turn.turnId} is already accounted; refusing to re-drive it`,
      );
    }
    const budgetBlock = this.reserveBudget(turn);
    if (budgetBlock !== null) {
      throw new HermesBudgetExceededError(turn, budgetBlock);
    }
    const started = performance.now();
    let hermesRunId = `failed:${turn.turnId}`;
    try {
      const headers = {
        authorization: `Bearer ${endpoint.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": turn.turnId,
        "x-hermes-session-id": endpoint.sessionId,
        "x-hermes-session-key": endpoint.sessionKey,
      };
      const deadline = Date.parse(turn.deadline);
      if (!Number.isFinite(deadline)) {
        throw new Error(`Hermes turn ${turn.turnId} has an invalid decision deadline`);
      }
      const startedResponse = await readBeforeDeadline(
        `${endpoint.baseUrl}/v1/runs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: this.prompt,
            instructions: this.prompt,
            session_id: endpoint.sessionId,
            model: endpoint.model,
          }),
        },
        deadline,
        "start",
      );
      const response = startedResponse.response;
      if (response.status !== 202) {
        throw new Error(
          `Hermes profile ${endpoint.profileId} rejected the turn with HTTP ${response.status}`,
        );
      }
      let accepted: HermesRunStatus | null;
      try {
        accepted = JSON.parse(
          startedResponse.bodyText ?? "null",
        ) as HermesRunStatus | null;
      } catch {
        accepted = null;
      }
      if (accepted === null || typeof accepted.run_id !== "string") {
        try {
          await endpoint.terminateProfile();
        } catch (error) {
          this.endpoints.delete(turn.agentId);
          throw new Error(
            `Hermes profile ${endpoint.profileId} returned no run_id; ` +
              "isolated profile termination failed: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        this.endpoints.delete(turn.agentId);
        throw new Error(
          `Hermes profile ${endpoint.profileId} returned no run_id; ` +
            "isolated profile terminated",
        );
      }
      const acceptedRunId = accepted.run_id;
      hermesRunId = acceptedRunId;
      const stopRun = async (): Promise<HermesTurnStats> => {
        let stoppedUsage: HermesUsage | null = null;
        const cleanupDeadline = Date.now() + HERMES_STOP_REQUEST_BUDGET_MS;
        try {
          const stopped = await readBeforeDeadline(
            `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(acceptedRunId)}/stop`,
            { method: "POST", headers },
            cleanupDeadline,
            "stop",
          );
          if (stopped.response.ok && stopped.bodyText !== null) {
            try {
              stoppedUsage = usage(
                JSON.parse(stopped.bodyText) as HermesRunStatus,
              );
            } catch {
              // Missing or non-JSON stop evidence is charged conservatively below.
            }
          }
        } catch (error) {
          if (!(error instanceof HermesRequestDeadlineError)) throw error;
        }
        const tokens = stoppedUsage ?? this.worstCaseUsage();
        return Object.freeze({
          runId: hermesRunId,
          turnId: turn.turnId,
          opportunityKey: turn.opportunityKey,
          agentId: turn.agentId,
          targetTick: turn.targetTick,
          status: "cancelled",
          ...tokens,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          budgetViolations: this.account(
            turn,
            tokens.inputTokens,
            tokens.outputTokens,
          ),
          failure: stoppedUsage === null
            ? "Hermes deadline cleanup had no valid usage; charged pinned worst case"
            : "Hermes turn reached its decision deadline",
        });
      };
      const abandonRun = async (): Promise<void> => {
        try {
          await readBeforeDeadline(
            `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(acceptedRunId)}/stop`,
            { method: "POST", headers },
            Date.now() + HERMES_STOP_REQUEST_BUDGET_MS,
            "stop",
          );
        } catch {
          // Best effort: the failed turn is already charged the pinned worst case.
        }
      };
      const remainingDecisionMs = Math.max(0, deadline - Date.now());
      const cleanupReserveMs = Math.min(
        HERMES_STOP_REQUEST_BUDGET_MS,
        Math.floor(remainingDecisionMs / 2),
      );
      const pollingDeadline = deadline - cleanupReserveMs;
      let consecutivePollFailures = 0;
      for (;;) {
        if (Date.now() >= pollingDeadline) return await stopRun();
        let terminalStatus: HermesTerminalStatus | undefined;
        try {
          const statusResult = await readBeforeDeadline(
            `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(acceptedRunId)}`,
            { headers },
            pollingDeadline,
            "status",
          );
          const statusResponse = statusResult.response;
          if (!statusResponse.ok) {
            const message =
              `Hermes run ${acceptedRunId} status failed with HTTP ${statusResponse.status}`;
            if (
              statusResponse.status === 408 ||
              statusResponse.status === 425 ||
              statusResponse.status === 429 ||
              statusResponse.status >= 500
            ) {
              throw new HermesTransientPollError(message);
            }
            throw new HermesPollProtocolError(message);
          }
          let status: HermesRunStatus | null;
          try {
            status = JSON.parse(
              statusResult.bodyText ?? "null",
            ) as HermesRunStatus | null;
          } catch {
            throw new HermesPollProtocolError(
              `Hermes run ${acceptedRunId} returned an unreadable status body`,
            );
          }
          if (status === null || typeof status !== "object") {
            throw new HermesPollProtocolError(
              `Hermes run ${acceptedRunId} returned an unreadable status body`,
            );
          }
          consecutivePollFailures = 0;
          if (
            status.status === "completed" ||
            status.status === "failed" ||
            status.status === "cancelled"
          ) {
            terminalStatus = status as HermesTerminalStatus;
          }
        } catch (error) {
          if (error instanceof HermesRequestDeadlineError) return await stopRun();
          if (
            !(error instanceof HermesPollProtocolError) &&
            ++consecutivePollFailures <= HERMES_MAX_CONSECUTIVE_POLL_FAILURES &&
            Date.now() < pollingDeadline
          ) {
            const remainingPollingMs = pollingDeadline - Date.now();
            await new Promise<void>((resolve) => setTimeout(
              resolve,
              Math.min(HERMES_POLL_INTERVAL_MS, remainingPollingMs),
            ));
            continue;
          }
          await abandonRun();
          throw error;
        }
        if (terminalStatus !== undefined) {
          const observedUsage = usage(terminalStatus);
          const tokens = observedUsage ?? this.worstCaseUsage();
          const terminalFailure = terminalStatus.status === "completed"
            ? undefined
            : typeof terminalStatus.error === "string" &&
                terminalStatus.error.length > 0
              ? redactSecrets(
                  terminalStatus.error,
                  this.turnSecrets(endpoint),
                ).slice(0, 1_000)
              : `Hermes run terminated with status ${terminalStatus.status}`;
          const missingUsageFailure =
            "Hermes terminal status omitted valid usage; charged pinned worst case";
          const budgetViolations = this.account(
            turn,
            tokens.inputTokens,
            tokens.outputTokens,
          );
          return Object.freeze({
            runId: hermesRunId,
            turnId: turn.turnId,
            opportunityKey: turn.opportunityKey,
            agentId: turn.agentId,
            targetTick: turn.targetTick,
            status: observedUsage === null ? "failed" : terminalStatus.status,
            ...tokens,
            latencyMs: Math.max(0, Math.round(performance.now() - started)),
            budgetViolations,
            ...(observedUsage === null
              ? {
                  failure: (
                    missingUsageFailure +
                    (
                      terminalFailure === undefined
                        ? ""
                        : `: ${terminalFailure}`
                    )
                  ).slice(0, 1_000),
                }
              : terminalFailure === undefined
                ? {}
                : { failure: terminalFailure }),
          });
        }
        const remainingPollingMs = pollingDeadline - Date.now();
        if (remainingPollingMs <= 0) return await stopRun();
        await new Promise<void>((resolve) => setTimeout(
          resolve,
          Math.min(HERMES_POLL_INTERVAL_MS, remainingPollingMs),
        ));
      }
    } catch (error) {
      const tokens = this.worstCaseUsage();
      const detail = redactSecrets(
        error instanceof Error ? error.message : String(error),
        this.turnSecrets(endpoint),
      ).slice(0, 1_000);
      let failureDetail = detail;
      let budgetViolations: readonly string[];
      try {
        budgetViolations = this.account(
          turn,
          tokens.inputTokens,
          tokens.outputTokens,
        );
      } catch (accountingError) {
        const accountingDetail = redactSecrets(
          accountingError instanceof Error
            ? accountingError.message
            : String(accountingError),
          this.turnSecrets(endpoint),
        );
        budgetViolations =
          this.accountedTurns.get(turn.turnId)?.violations ?? Object.freeze([]);
        failureDetail = (
          `${detail}; accounting failed: ${accountingDetail}`
        ).slice(0, 1_000);
      }
      throw new HermesTurnExecutionError(Object.freeze({
        runId: hermesRunId,
        turnId: turn.turnId,
        opportunityKey: turn.opportunityKey,
        agentId: turn.agentId,
        targetTick: turn.targetTick,
        status: "failed",
        ...tokens,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        budgetViolations,
        failure: failureDetail,
      }), failureDetail);
    } finally {
      this.releaseBudgetReservation(turn.turnId);
    }
  }
}

export class HermesTurnExecutionError extends Error {
  constructor(
    private readonly stats: HermesTurnStats,
    detail: string,
  ) {
    super(`Hermes turn ${stats.runId} failed: ${detail}`);
    this.name = "HermesTurnExecutionError";
  }

  asStats(): HermesTurnStats {
    return this.stats;
  }
}

export class HermesBudgetExceededError extends Error {
  constructor(
    readonly turn: AgentTurnEnvelope,
    readonly reason: string,
  ) {
    super(`Hermes budget blocked ${turn.turnId}: ${reason}`);
    this.name = "HermesBudgetExceededError";
  }

  asStats(): HermesTurnStats {
    return Object.freeze({
      runId: `budget:${this.turn.turnId}`,
      turnId: this.turn.turnId,
      opportunityKey: this.turn.opportunityKey,
      agentId: this.turn.agentId,
      targetTick: this.turn.targetTick,
      status: "cancelled",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      budgetViolations: [this.reason],
    });
  }
}
