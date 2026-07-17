/**
 * Seeded, forkable RNG streams (ADR-0008) built on sfc32.
 *
 * Streams are derived by NAME (`fork("labor.tiebreak")`), not by consuming the
 * parent's sequence — so adding draws in one subsystem can never shift the
 * numbers another subsystem sees. Stream state is serializable for snapshots.
 */

import { fnv1a32 } from "./codec";

export interface RngState {
  seedTag: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

const TWO_32 = 4294967296;

export class Rng {
  readonly seedTag: string;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(seedTag: string, a: number, b: number, c: number, d: number) {
    this.seedTag = seedTag;
    this.a = a >>> 0;
    this.b = b >>> 0;
    this.c = c >>> 0;
    this.d = d >>> 0;
  }

  /** Root stream for a run. */
  static root(seed: number | string): Rng {
    return Rng.fromTag(`seed:${seed}`);
  }

  private static fromTag(tag: string): Rng {
    const rng = new Rng(
      tag,
      fnv1a32(`${tag}#a`),
      fnv1a32(`${tag}#b`),
      fnv1a32(`${tag}#c`),
      fnv1a32(`${tag}#d`),
    );
    for (let i = 0; i < 12; i++) rng.nextUint32(); // warm-up
    return rng;
  }

  /** Named derived stream — independent of any draws made on this stream. */
  fork(key: string): Rng {
    return Rng.fromTag(`${this.seedTag}/${key}`);
  }

  nextUint32(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) | 0;
    this.d = (this.d + 1) | 0;
    const result = (t + this.d) | 0;
    this.c = (this.c + result) | 0;
    return result >>> 0;
  }

  /** Uniform float in [0, 1). Display/weighting only — never money math. */
  next(): number {
    return this.nextUint32() / TWO_32;
  }

  /** Uniform integer in [min, max], both inclusive. Rejection-sampled (no modulo bias). */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`invalid int range [${min}, ${max}]`);
    }
    const span = max - min + 1;
    if (span > TWO_32) throw new RangeError(`range too wide: ${span}`);
    const limit = Math.floor(TWO_32 / span) * span;
    let x = this.nextUint32();
    while (x >= limit) x = this.nextUint32();
    return min + (x % span);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick: empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  serialize(): RngState {
    return { seedTag: this.seedTag, a: this.a, b: this.b, c: this.c, d: this.d };
  }

  static restore(state: RngState): Rng {
    return new Rng(state.seedTag, state.a, state.b, state.c, state.d);
  }
}
