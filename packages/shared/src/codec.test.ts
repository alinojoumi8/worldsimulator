import { describe, expect, it } from "vitest";
import {
  canonicalParse,
  canonicalStringify,
  CodecError,
  fnv1a32,
  hashValue,
  IdFactory,
  sha256Hex,
} from "./codec";

describe("canonicalStringify", () => {
  it("is invariant to object key order", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
    expect(canonicalStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested objects too", () => {
    const a = { outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
    const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("encodes bigint with a tag and round-trips via canonicalParse", () => {
    const value = { amount: 12345678901234567890n, nested: [1n, -2n] };
    const text = canonicalStringify(value);
    expect(text).toContain('{"$b":"12345678901234567890"}');
    expect(canonicalParse(text)).toEqual(value);
  });

  it("skips undefined object values (deterministically)", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-deterministic or ambiguous values", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(CodecError);
    expect(() => canonicalStringify(Infinity)).toThrow(CodecError);
    expect(() => canonicalStringify(undefined)).toThrow(CodecError);
    expect(() => canonicalStringify([undefined])).toThrow(CodecError);
    expect(() => canonicalStringify(new Map())).toThrow(CodecError);
    expect(() => canonicalStringify(new Date(0))).toThrow(CodecError);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(CodecError);
  });
});

describe("sha256Hex", () => {
  it("matches FIPS 180 test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles multi-block and non-ASCII input", () => {
    expect(sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    // 200 chars → multiple 64-byte blocks; snowman exercises UTF-8 encoding
    expect(sha256Hex("a".repeat(200) + "☃")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashValue", () => {
  it("hashes canonical form (key order does not matter)", () => {
    expect(hashValue({ a: 1n, b: "x" })).toBe(hashValue({ b: "x", a: 1n }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});

describe("fnv1a32", () => {
  it("matches known FNV-1a values", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
});

describe("IdFactory", () => {
  it("issues monotonic per-prefix ids", () => {
    const ids = new IdFactory();
    expect(ids.next("agt")).toBe("agt_00000001");
    expect(ids.next("agt")).toBe("agt_00000002");
    expect(ids.next("txn")).toBe("txn_00000001");
  });

  it("serializes and restores counters", () => {
    const ids = new IdFactory();
    ids.next("agt");
    ids.next("agt");
    const restored = IdFactory.restore(ids.serialize());
    expect(restored.next("agt")).toBe("agt_00000003");
  });

  it("rejects invalid prefixes and corrupt state", () => {
    const ids = new IdFactory();
    expect(() => ids.next("Agt")).toThrow(CodecError);
    expect(() => ids.next("")).toThrow(CodecError);
    expect(() => IdFactory.restore({ agt: -1 })).toThrow(CodecError);
  });
});
