import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Rng } from "./rng";

function draw(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.nextUint32());
  return out;
}

describe("Rng", () => {
  it("same seed produces the same sequence", () => {
    expect(draw(Rng.root(42), 10)).toEqual(draw(Rng.root(42), 10));
    expect(draw(Rng.root("hello"), 10)).toEqual(draw(Rng.root("hello"), 10));
  });

  it("different seeds diverge", () => {
    expect(draw(Rng.root(42), 10)).not.toEqual(draw(Rng.root(43), 10));
  });

  it("fork(key) is independent of draws on the parent (ADR-0008)", () => {
    const parentA = Rng.root(42);
    const parentB = Rng.root(42);
    draw(parentB, 7); // consume parentB only
    expect(draw(parentA.fork("labor"), 10)).toEqual(draw(parentB.fork("labor"), 10));
  });

  it("distinct fork keys give distinct streams", () => {
    const root = Rng.root(42);
    expect(draw(root.fork("a"), 10)).not.toEqual(draw(root.fork("b"), 10));
  });

  it("nested forks are stable", () => {
    const a = Rng.root(1).fork("x").fork("y");
    const b = Rng.root(1).fork("x").fork("y");
    expect(draw(a, 5)).toEqual(draw(b, 5));
  });

  it("serialize/restore resumes the exact sequence", () => {
    const rng = Rng.root(7);
    draw(rng, 5);
    const restored = Rng.restore(rng.serialize());
    expect(draw(restored, 10)).toEqual(draw(rng, 10));
  });

  it("next() returns a deterministic float sequence in [0, 1)", () => {
    const a = Rng.root(11);
    const b = Rng.root(11);
    const left = Array.from({ length: 100 }, () => a.next());
    const right = Array.from({ length: 100 }, () => b.next());
    expect(left).toEqual(right);
    expect(left.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("pick() is deterministic and returns only supplied values", () => {
    const choices = ["north", "south", "east", "west"] as const;
    const a = Rng.root(12);
    const b = Rng.root(12);
    const left = Array.from({ length: 50 }, () => a.pick(choices));
    const right = Array.from({ length: 50 }, () => b.pick(choices));
    expect(left).toEqual(right);
    expect(left.every((value) => choices.includes(value))).toBe(true);
  });

  it("int() stays within inclusive bounds (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer(),
        (min, span, seed) => {
          const max = min + span;
          const rng = Rng.root(seed);
          for (let i = 0; i < 25; i++) {
            const v = rng.int(min, max);
            if (v < min || v > max || !Number.isInteger(v)) return false;
          }
          return true;
        },
      ),
    );
  });

  it("int() covers the full range eventually", () => {
    const rng = Rng.root(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(rng.int(0, 3));
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("rejects invalid ranges", () => {
    const rng = Rng.root(1);
    expect(() => rng.int(5, 4)).toThrow(RangeError);
    expect(() => rng.int(0.5, 4)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("shuffle is deterministic and a permutation", () => {
    const a = Rng.root(9).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = Rng.root(9).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
