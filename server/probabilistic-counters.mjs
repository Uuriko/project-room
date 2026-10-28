// probabilistic-counters.mjs — Bloom filter + HyperLogLog counters
// (DISCOVERY-50 lane B2, charter B2-bloom-hll-counters).
//
// CONTRACT (charter §3, binding): these structures serve APPROXIMATE
// reads only — funnel/dashboard unique counts (HLL) and dedupe
// MEMBERSHIP HINTS (Bloom). A Bloom "seen" answer is never itself the
// dedupe verdict: the exact lookup is retained as the fallback on a
// Bloom positive (mightContainWithFallback). HLL/Bloom output must
// NEVER feed money counts, billing, sponsor reporting presented as
// exact, or any gate formula. tests/probabilistic-counters.test.mjs
// case 4 is the standing negative guard on that rule.
//
// Sizing (named constants, no env flags): Bloom 10 bits/item unless a
// call site's sizing note says otherwise (250,000 B at the lane's
// 200,000-key operating point); HLL p=14 (16,384 registers = 16 KiB).
// Counter state is disposable: a lost counter degrades to a recount
// from source, never to a wrong verdict.

import { createHash } from "node:crypto";

export const BLOOM_BITS_PER_ITEM = 10;
export const HLL_P = 14;

function h32(value, seed) {
  return createHash("sha256").update(`${seed}:${value}`).digest().readUInt32BE(0);
}
function h64(value) {
  return createHash("sha256").update(String(value)).digest().readBigUInt64BE(0);
}

export class BloomFilter {
  constructor({ expectedItems = 1000, bitsPerItem = BLOOM_BITS_PER_ITEM, hashFunctions = 7 } = {}) {
    this.m = Math.max(8, Math.ceil(expectedItems * bitsPerItem));
    this.k = hashFunctions;
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }
  add(value) {
    for (let i = 0; i < this.k; i++) {
      const p = h32(value, i) % this.m;
      this.bits[p >> 3] |= 1 << (p & 7);
    }
  }
  // "might contain" is a HINT: true means "check the exact source",
  // false means "definitely not inserted into THIS filter" — and a
  // lost/rebuilt filter must be treated as absent state (recount),
  // never as a verdict about the world.
  mightContain(value) {
    for (let i = 0; i < this.k; i++) {
      const p = h32(value, i) % this.m;
      if (!(this.bits[p >> 3] & (1 << (p & 7)))) return false;
    }
    return true;
  }
  // The only verdict-shaped API: Bloom positive falls through to the
  // exact lookup; Bloom negative on a fresh/lost filter also falls
  // through when the caller marks its state untrusted — here the exact
  // lookup decides in both directions, the filter only saves work.
  mightContainWithFallback(value, exactLookup) {
    if (!this.mightContain(value)) return exactLookup(value) === true ? true : false;
    return exactLookup(value) === true;
  }
}

export class HyperLogLog {
  constructor({ p = HLL_P } = {}) {
    this.p = p;
    this.m = 1 << p;
    this.registers = new Uint8Array(this.m);
  }
  add(value) {
    const x = h64(value);
    const idx = Number(x >> BigInt(64 - this.p));
    const w = x << BigInt(this.p);
    let rho = 1;
    for (let b = 63 - this.p; b >= 0; b--) {
      if ((w >> BigInt(b)) & 1n) break;
      rho++;
    }
    if (rho > this.registers[idx]) this.registers[idx] = rho;
  }
  // Approximate unique count. Labelled approximate at every surface
  // that serves it; never an exact count.
  estimate() {
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) { sum += 2 ** -r; if (r === 0) zeros++; }
    const alpha = 0.7213 / (1 + 1.079 / this.m);
    let est = (alpha * this.m * this.m) / sum;
    if (est <= 2.5 * this.m && zeros > 0) est = this.m * Math.log(this.m / zeros);
    return est;
  }
}
