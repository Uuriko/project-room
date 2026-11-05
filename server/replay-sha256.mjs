// Portable SHA-256 state for bounded replay witness hashing. This is a hash
// primitive, not authority: callers must compare the final digest with the
// independent proof captured at H, and protect checkpoint rows separately.
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
export const REPLAY_HASH_INPUT_LIMIT = 256 * 1024;
export const REPLAY_HASH_STATE_LIMIT = 1024;
// SHA-256 carries a 64-bit bit length. Safe integer byte counters fit within
// 56 bits after multiplication by eight; each feed remains independently bounded.
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function initialReplayHash() {
  return {version: 1, bytes: 0, words: [...INITIAL], pending: []};
}

function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).sort().join(',') !== 'bytes,pending,version,words'
    || state.version !== 1 || !Number.isSafeInteger(state.bytes)
    || state.bytes < 0 || state.bytes > MAX_BYTES
    || !Array.isArray(state.words) || state.words.length !== 8 || !Array.from(state.words).every(uint32)
    || !Array.isArray(state.pending) || state.pending.length > 63
    || state.pending.length !== state.bytes % 64
    || !Array.from(state.pending).every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw Error('invalid replay hash state');
  }
}

function block(words, bytes, offset, schedule) {
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4;
    schedule[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16)
      | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const a = schedule[i - 15], b = schedule[i - 2];
    const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
    const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
    schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
  }
  let [a,b,c,d,e,f,g,h] = words;
  for (let i = 0; i < 64; i++) {
    const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + schedule[i]) >>> 0;
    const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
  }
  for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) words[i] = (words[i] + value) >>> 0;
}

export function advanceReplayHash(state, input) {
  validate(state);
  if (!(input instanceof Uint8Array) || input.byteLength > REPLAY_HASH_INPUT_LIMIT
    || !Number.isSafeInteger(state.bytes + input.byteLength) || state.bytes + input.byteLength > MAX_BYTES) throw Error('replay hash input limit');
  const words = [...state.words], schedule = new Uint32Array(64);
  let offset = 0;
  if (state.pending.length) {
    const count = Math.min(64 - state.pending.length, input.length);
    const prefix = new Uint8Array(state.pending.length + count);
    prefix.set(state.pending); prefix.set(input.subarray(0, count), state.pending.length);
    offset = count;
    if (prefix.length < 64) return {version: 1, bytes: state.bytes + count, words, pending: [...prefix]};
    block(words, prefix, 0, schedule);
  }
  while (offset + 64 <= input.length) { block(words, input, offset, schedule); offset += 64; }
  return {version: 1, bytes: state.bytes + input.length, words, pending: [...input.subarray(offset)]};
}

export function finishReplayHash(state) {
  validate(state);
  const words = [...state.words], tail = new Uint8Array(state.pending.length < 56 ? 64 : 128);
  tail.set(state.pending); tail[state.pending.length] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(state.bytes / 0x20000000));
  view.setUint32(tail.length - 4, state.bytes * 8);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < tail.length; offset += 64) block(words, tail, offset, schedule);
  return words.map(word => word.toString(16).padStart(8, '0')).join('');
}

export function encodeReplayHash(state) {
  validate(state);
  const encoded = JSON.stringify(state);
  if (encoded.length > REPLAY_HASH_STATE_LIMIT) throw Error('replay hash control limit');
  return encoded;
}

export function decodeReplayHash(encoded) {
  // SQL byte/typeof admission must happen before reading persisted controls.
  // All accepted state is ASCII, so this pre-parse code-unit bound is also a
  // byte bound for valid controls; non-ASCII data cannot pass validation.
  if (typeof encoded !== 'string' || encoded.length > REPLAY_HASH_STATE_LIMIT
    || new TextEncoder().encode(encoded).byteLength > REPLAY_HASH_STATE_LIMIT) {
    throw Error('replay hash control limit');
  }
  const state = JSON.parse(encoded);
  validate(state);
  return state;
}
