import pino, {
  type DestinationStream,
  type Logger,
} from "pino";
import { ENGINE_VERSION } from "@worldtangle/shared";

export const LOG_REDACTION_CENSOR = "[REDACTED]";
export const PHASE_TIMING_EVENT = "simulation.phase.timing";
export const PHASE_TIMING_METRIC = "simulation_phase_duration_ms";

const DEFAULT_SERVICE = "worldtangle-server";
const DEFAULT_LEVEL = "info";
const LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

// Keep this list explicit: broad wildcard redaction can hide useful domain data,
// while these cover Fastify request shapes and the configuration names used by
// providers. The first-level wildcards cover common wrapper objects as well.
const SECRET_PATHS = [
  "authorization",
  "Authorization",
  "apiKey",
  "api_key",
  "apiToken",
  "accessToken",
  "refreshToken",
  "headers.authorization",
  "headers.Authorization",
  "headers['x-api-key']",
  "headers['X-API-Key']",
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers['x-api-key']",
  "req.headers['X-API-Key']",
  "request.headers.authorization",
  "request.headers.Authorization",
  "request.headers['x-api-key']",
  "request.headers['X-API-Key']",
  "*.authorization",
  "*.Authorization",
  "*.apiKey",
  "*.api_key",
  "*.apiToken",
  "*.accessToken",
  "*.refreshToken",
] as const;

export interface CreateLoggerOptions {
  /** Explicit Pino level. Unknown values safely fall back to `info`. */
  level?: string;
  /** Environment seam used to read WORLDTANGLE_LOG_LEVEL/LOG_LEVEL in tests. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Destination seam for tests or embedding. Defaults to stdout. */
  destination?: DestinationStream;
  service?: string;
  version?: string;
}

export interface RunLogContext {
  simulationId: string;
  runId: string;
  tick?: number;
  correlationId?: string;
}

export interface PhaseTiming extends RunLogContext {
  tick: number;
  phase: string;
  durationMs: number;
}

function resolveLevel(options: CreateLoggerOptions): string {
  const env = options.env ?? process.env;
  const candidate =
    options.level ?? env.WORLDTANGLE_LOG_LEVEL ?? env.LOG_LEVEL ?? DEFAULT_LEVEL;
  const normalized = candidate.trim().toLowerCase();
  return LOG_LEVELS.has(normalized) ? normalized : DEFAULT_LEVEL;
}

/**
 * Creates the process logger. Its base bindings are deliberately small and
 * stable so every line can be filtered without relying on a message string.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: pino.LoggerOptions = {
    level: resolveLevel(options),
    base: {
      service: options.service ?? DEFAULT_SERVICE,
      version: options.version ?? ENGINE_VERSION,
      simulated: true,
    },
    redact: {
      paths: [...SECRET_PATHS],
      censor: LOG_REDACTION_CENSOR,
    },
  };

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}

/** Returns a child logger carrying the identifiers required for run logs. */
export function childRunLogger(
  logger: Logger,
  context: RunLogContext,
): Logger {
  return logger.child({
    simulationId: context.simulationId,
    runId: context.runId,
    ...(context.tick === undefined ? {} : { tick: context.tick }),
    ...(context.correlationId === undefined
      ? {}
      : { correlationId: context.correlationId }),
  });
}

/** Emits one machine-readable duration sample for a completed tick phase. */
export function logPhaseTiming(
  logger: Logger,
  timing: PhaseTiming,
): void {
  const runLogger = childRunLogger(logger, timing);
  runLogger.info(
    {
      event: PHASE_TIMING_EVENT,
      metric: PHASE_TIMING_METRIC,
      phase: timing.phase,
      durationMs: timing.durationMs,
      unit: "ms",
    },
    "simulation phase completed",
  );
}
