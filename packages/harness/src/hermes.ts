import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
  AgentTurnEnvelope,
  ExperimentManifest,
} from "@worldtangle/shared";
import { CITIZEN_TURN_PROMPT } from "./driver-policy";
import { providerEnvironmentNames } from "./provider-environment";

export interface HermesTurnStats {
  readonly runId: string;
  readonly agentId: string;
  readonly targetTick: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly budgetViolations: readonly string[];
  readonly failure?: string;
}

export interface HermesEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly sessionKey: string;
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

function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let sanitized = text.replaceAll(/wtpat_[A-Za-z0-9._-]+/g, "[REDACTED]");
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
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

export class HermesProfileFleet {
  private readonly processes: ChildProcess[] = [];
  private readonly profileRoots: string[] = [];

  constructor(
    private readonly trialRoot: string,
    private readonly executable = process.env["HERMES_EXECUTABLE"] ?? "hermes",
  ) {}

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
      const endpoint: HermesEndpoint = Object.freeze({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
        model: manifest.provider.model,
        profileId,
        sessionId: `worldtangle:${manifest.studyId}:${credential.agentId}`,
        sessionKey: `worldtangle-agent:${credential.agentId}`,
      });
      const child = spawn(this.executable, ["gateway"], {
        cwd: profileRoot,
        env: buildHermesProfileEnvironment(manifest, profileRoot),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
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
    for (const child of this.processes.splice(0)) {
      if (child.exitCode !== null) continue;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const root of this.profileRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

function usage(status: HermesRunStatus): { inputTokens: number; outputTokens: number } {
  const value = status.usage;
  if (typeof value !== "object" || value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    inputTokens: typeof record["input_tokens"] === "number"
      ? record["input_tokens"]
      : 0,
    outputTokens: typeof record["output_tokens"] === "number"
      ? record["output_tokens"]
      : 0,
  };
}

export class HermesApiTurnDriver {
  private readonly perAgentTickTokens = new Map<string, number>();
  private spentMicrocents = 0n;

  constructor(
    private readonly endpoints: ReadonlyMap<string, HermesEndpoint>,
    private readonly manifest: ExperimentManifest,
    private readonly prompt = CITIZEN_TURN_PROMPT,
  ) {}

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

  private dailyKey(turn: AgentTurnEnvelope): string {
    return `${turn.agentId}:${turn.targetTick}`;
  }

  private preflightBudget(turn: AgentTurnEnvelope): string | null {
    const worstCaseTokens =
      this.manifest.generationBudget.maxInputTokens +
      this.manifest.generationBudget.maxOutputTokens;
    const consumed = this.perAgentTickTokens.get(this.dailyKey(turn)) ?? 0;
    if (
      consumed + worstCaseTokens >
      this.manifest.scenario.budgets.perAgentDailyTokens
    ) {
      return (
        `per-agent daily token budget cannot cover the pinned turn maximum ` +
        `(${consumed + worstCaseTokens} > ` +
        `${this.manifest.scenario.budgets.perAgentDailyTokens})`
      );
    }
    const worstCaseCost = this.cost(
      this.manifest.generationBudget.maxInputTokens,
      this.manifest.generationBudget.maxOutputTokens,
    );
    const runLimit =
      BigInt(this.manifest.scenario.budgets.runCostCentsMax) * 1_000_000n;
    if (this.spentMicrocents + worstCaseCost > runLimit) {
      return (
        `run cost budget cannot cover the pinned turn maximum ` +
        `(${this.spentMicrocents + worstCaseCost} > ${runLimit} microcents)`
      );
    }
    return null;
  }

  private account(
    turn: AgentTurnEnvelope,
    inputTokens: number,
    outputTokens: number,
  ): readonly string[] {
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
    const key = this.dailyKey(turn);
    const daily = (this.perAgentTickTokens.get(key) ?? 0) + total;
    this.perAgentTickTokens.set(key, daily);
    if (daily > this.manifest.scenario.budgets.perAgentDailyTokens) {
      violations.push(
        `daily tokens ${daily} exceed per-agent limit ` +
          `${this.manifest.scenario.budgets.perAgentDailyTokens}`,
      );
    }
    this.spentMicrocents += this.cost(inputTokens, outputTokens);
    const runLimit =
      BigInt(this.manifest.scenario.budgets.runCostCentsMax) * 1_000_000n;
    if (this.spentMicrocents > runLimit) {
      violations.push(
        `run cost ${this.spentMicrocents} exceeds limit ${runLimit} microcents`,
      );
    }
    return Object.freeze(violations);
  }

  async runTurn(turn: AgentTurnEnvelope): Promise<HermesTurnStats> {
    const budgetBlock = this.preflightBudget(turn);
    if (budgetBlock !== null) {
      throw new HermesBudgetExceededError(turn, budgetBlock);
    }
    const endpoint = this.endpoints.get(turn.agentId);
    if (endpoint === undefined) {
      throw new Error(`no isolated Hermes profile exists for ${turn.agentId}`);
    }
    if (!isLoopbackUrl(endpoint.baseUrl)) {
      throw new Error("Hermes Agent Lab endpoints must be loopback");
    }
    const headers = {
      authorization: `Bearer ${endpoint.apiKey}`,
      "content-type": "application/json",
      "idempotency-key": turn.turnId,
      "x-hermes-session-id": endpoint.sessionId,
      "x-hermes-session-key": endpoint.sessionKey,
    };
    const started = performance.now();
    const response = await fetch(`${endpoint.baseUrl}/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: this.prompt,
        instructions: this.prompt,
        session_id: endpoint.sessionId,
        model: endpoint.model,
      }),
    });
    if (response.status !== 202) {
      throw new Error(
        `Hermes profile ${endpoint.profileId} rejected the turn with HTTP ${response.status}`,
      );
    }
    const accepted = await response.json() as HermesRunStatus;
    if (typeof accepted.run_id !== "string") {
      throw new Error(`Hermes profile ${endpoint.profileId} returned no run_id`);
    }
    const deadline = Date.parse(turn.deadline);
    for (;;) {
      const statusResponse = await fetch(
        `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(accepted.run_id)}`,
        { headers },
      );
      if (!statusResponse.ok) {
        throw new Error(
          `Hermes run ${accepted.run_id} status failed with HTTP ${statusResponse.status}`,
        );
      }
      const status = await statusResponse.json() as HermesRunStatus;
      if (
        status.status === "completed" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        const tokens = usage(status);
        return Object.freeze({
          runId: accepted.run_id,
          agentId: turn.agentId,
          targetTick: turn.targetTick,
          status: status.status,
          ...tokens,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          budgetViolations: this.account(
            turn,
            tokens.inputTokens,
            tokens.outputTokens,
          ),
        });
      }
      if (Date.now() > deadline) {
        await fetch(
          `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(accepted.run_id)}/stop`,
          { method: "POST", headers },
        );
        return Object.freeze({
          runId: accepted.run_id,
          agentId: turn.agentId,
          targetTick: turn.targetTick,
          status: "cancelled",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          budgetViolations: [],
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
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
