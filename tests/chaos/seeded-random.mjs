// Deterministic seeded PRNG for the chaos/property harness.
//
// mulberry32: small, fast, and statistically adequate for choosing random
// operations and parameters. It is NOT cryptographic — never use it for
// secrets, tokens, or anything security-sensitive. The point is
// reproducibility: the same seed always drives the same operation sequence,
// so a failing seed replays exactly (see docs/CHAOS.md).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }

  // Uniform float in [0, 1).
  float() {
    return this._next();
  }

  // Uniform integer in [min, max] (inclusive).
  int(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min)
      throw new Error(`Rng.int: invalid range [${min}, ${max}]`);
    return min + Math.floor(this._next() * (max - min + 1));
  }

  pick(array) {
    if (!Array.isArray(array) || array.length === 0)
      throw new Error("Rng.pick: need a non-empty array");
    return array[Math.floor(this._next() * array.length)];
  }

  bool(p = 0.5) {
    return this._next() < p;
  }

  // weighted([[weight, value], ...]) — weights need not sum to 1.
  weighted(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0)
      throw new Error("Rng.weighted: need a non-empty weight list");
    let total = 0;
    for (const [weight] of pairs) {
      if (!(weight > 0)) throw new Error("Rng.weighted: weights must be positive");
      total += weight;
    }
    let r = this._next() * total;
    for (const [weight, value] of pairs) {
      r -= weight;
      if (r < 0) return value;
    }
    return pairs[pairs.length - 1][1];
  }

  // Fisher-Yates; returns a new array, input untouched.
  shuffle(array) {
    const out = [...array];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
