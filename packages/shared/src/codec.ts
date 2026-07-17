/**
 * Canonical serialization, hashing, and deterministic IDs (ADR-0008).
 *
 * This codec is the ONLY serializer used for hashing, cache keys, and state
 * digests: sorted object keys, tagged bigint encoding, no NaN/Infinity, no
 * platform-dependent formatting. Changing its output format invalidates every
 * stored hash — treat it as frozen once runs exist.
 */

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

/** FNV-1a 32-bit over UTF-16 code units — fast, portable, deterministic. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic JSON: object keys sorted (code-unit order), bigint encoded as
 * {"$b":"<decimal>"}, undefined object values skipped. Throws on NaN/Infinity,
 * functions, symbols, circular references, and non-plain objects.
 */
export function canonicalStringify(value: unknown): string {
  return stringifyInner(value, new Set<object>());
}

function stringifyInner(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CodecError(`non-finite number: ${value}`);
      return JSON.stringify(value);
    case "bigint":
      return `{"$b":"${value.toString()}"}`;
    case "undefined":
      throw new CodecError("undefined is not serializable");
    case "function":
    case "symbol":
      throw new CodecError(`${typeof value} is not serializable`);
    case "object": {
      if (value === null) return "null";
      if (seen.has(value)) throw new CodecError("circular reference");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (const item of value) {
            if (item === undefined) throw new CodecError("undefined array element");
            parts.push(stringifyInner(item, seen));
          }
          return `[${parts.join(",")}]`;
        }
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new CodecError("only plain objects are serializable (no Map/Set/Date/class instances)");
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(); // code-unit sort: deterministic, no ICU
        const parts: string[] = [];
        for (const key of keys) {
          const item = record[key];
          if (item === undefined) continue;
          parts.push(`${JSON.stringify(key)}:${stringifyInner(item, seen)}`);
        }
        return `{${parts.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
  }
}

/** Inverse of canonicalStringify: revives {"$b":"…"} back into bigint. */
export function canonicalParse(text: string): unknown {
  return revive(JSON.parse(text) as unknown);
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$b" && typeof record["$b"] === "string") {
      return BigInt(record["$b"]);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = revive(record[key]);
    return out;
  }
  return value;
}

/** SHA-256 of the canonical serialization — the standard state/cache digest. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

// ---------------------------------------------------------------------------
// SHA-256 — pure JS, no node:crypto, so @worldtangle/shared stays portable
// (browser + Node) and deterministic everywhere. Verified against NIST/FIPS
// test vectors in codec.test.ts.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x15 = w[i - 15]!;
      const x2 = w[i - 2]!;
      const s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3);
      const s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Deterministic IDs (ADR-0008): typed prefix + per-run monotonic counter.
// No UUIDs/ULIDs inside the engine — wall clocks and entropy break replay.
// ---------------------------------------------------------------------------

const ID_PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

export class IdFactory {
  private readonly counters = new Map<string, number>();

  /** Next id for a prefix, e.g. next("agt") → "agt_00000001". */
  next(prefix: string): string {
    if (!ID_PREFIX_PATTERN.test(prefix)) throw new CodecError(`invalid id prefix: ${prefix}`);
    const value = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, value);
    return `${prefix}_${value.toString(36).padStart(8, "0")}`;
  }

  serialize(): Record<string, number> {
    const entries = [...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries) as Record<string, number>;
  }

  static restore(state: Record<string, number>): IdFactory {
    const factory = new IdFactory();
    for (const [prefix, value] of Object.entries(state)) {
      if (!ID_PREFIX_PATTERN.test(prefix) || !Number.isInteger(value) || value < 0) {
        throw new CodecError(`invalid id factory state entry: ${prefix}=${value}`);
      }
      factory.counters.set(prefix, value);
    }
    return factory;
  }
}
