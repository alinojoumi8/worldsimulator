import {
  eventStreamFrameSchema,
  type EventStreamFrame,
} from "@worldtangle/shared";

interface RawSseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): RawSseFrame[] {
    this.buffer += chunk;
    const frames: RawSseFrame[] = [];
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (boundary === null) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const parsed = this.parseBlock(block);
      if (parsed !== undefined) frames.push(parsed);
    }
    return frames;
  }

  finish(): RawSseFrame[] {
    if (this.buffer.length === 0) return [];
    const block = this.buffer;
    this.buffer = "";
    const parsed = this.parseBlock(block);
    return parsed === undefined ? [] : [parsed];
  }

  private parseBlock(block: string): RawSseFrame | undefined {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id" && !value.includes("\0")) id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return undefined;
    return {
      data: data.join("\n"),
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
    };
  }
}

export type StreamAttemptResult = "ended" | "unauthorized";

interface ConsumeStreamOptions {
  readonly simulationId: string;
  readonly runId?: string;
  readonly token: string;
  readonly lastEventId?: number;
  readonly signal: AbortSignal;
  readonly onOpen: () => void;
  readonly onFrame: (frame: EventStreamFrame) => void;
  readonly fetchImpl?: typeof fetch;
}

function decodeFrame(raw: RawSseFrame): EventStreamFrame {
  if (raw.id === undefined || !/^(0|[1-9]\d*)$/.test(raw.id)) {
    throw new Error("SSE frame is missing a valid event sequence");
  }
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id)) throw new Error("SSE event sequence exceeds the safe range");
  let data: unknown;
  try {
    data = JSON.parse(raw.data) as unknown;
  } catch {
    throw new Error("SSE frame contains invalid JSON");
  }
  const parsed = eventStreamFrameSchema.safeParse({ id, event: raw.event, data });
  if (!parsed.success) throw new Error(`SSE contract violation: ${parsed.error.message}`);
  return parsed.data;
}

export async function consumeEventStream(
  options: ConsumeStreamOptions,
): Promise<StreamAttemptResult> {
  const params = new URLSearchParams({ topics: "digest,lifecycle" });
  if (options.runId !== undefined) params.set("runId", options.runId);
  const headers = new Headers({ Accept: "text/event-stream" });
  if (options.token.trim().length > 0) {
    headers.set("Authorization", `Bearer ${options.token.trim()}`);
  }
  if (options.lastEventId !== undefined) {
    headers.set("Last-Event-ID", String(options.lastEventId));
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `/api/v1/simulations/${encodeURIComponent(options.simulationId)}/stream?${params}`,
    { headers, signal: options.signal, credentials: "same-origin" },
  );
  if (response.status === 401) return "unauthorized";
  if (!response.ok) throw new Error(`Event stream failed with status ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Event stream returned an unexpected content type");
  }
  if (response.body === null) throw new Error("Event stream response has no body");

  options.onOpen();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        options.onFrame(decodeFrame(raw));
      }
    }
    const tail = decoder.decode();
    for (const raw of [...parser.push(tail), ...parser.finish()]) {
      options.onFrame(decodeFrame(raw));
    }
  } finally {
    reader.releaseLock();
  }
  return "ended";
}
