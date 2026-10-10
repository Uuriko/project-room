// Real tokenizer integration (200-hard-tasks #22).
// Pure-JS byte-pair-encoding tokenizer with vendored rank data — no npm
// dependencies (this repo ships offline with zero deps). Three model families:
//   cl100k — GPT-4 / GPT-3.5-turbo (OpenAI tiktoken cl100k_base ranks)
//   o200k  — GPT-4o family (OpenAI tiktoken o200k_base ranks)
//   gpt2   — GPT-2 / GPT-3 family (r50k-style encoder.json ranks)
// Rank data: server/tokenizer-data/*.tiktoken (base64 bytes + rank per line),
// gpt2-encoder.json (GPT-2 escaped token -> rank). encode() is the
// encode_ordinary path: no special tokens are treated specially.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "tokenizer-data");

export const SUPPORTED_FAMILIES = Object.freeze(["cl100k", "o200k", "gpt2"]);

// Encoding regexes from OpenAI tiktoken (unicode mode).
const PATTERNS = {
  cl100k: String.raw`(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`,
  o200k: String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`,
  gpt2: String.raw`'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`,
};

// GPT-2 bytes<->unicode mapping (encoder.py bytes_to_unicode).
function gpt2BytesToUnicode() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b); // '!'..'~'
  for (let b = 161; b <= 172; b++) bs.push(b); // '¡'..'¬'
  for (let b = 174; b <= 255; b++) bs.push(b); // '®'..'ÿ'
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map = new Map();
  bs.forEach((b, i) => map.set(b, String.fromCodePoint(cs[i])));
  return map;
}
const GPT2_B2U = gpt2BytesToUnicode();
const GPT2_U2B = new Map([...GPT2_B2U.entries()].map(([b, c]) => [c, b]));

function gpt2DecodeToken(tokenStr) {
  const bytes = [];
  for (const ch of tokenStr) {
    const b = GPT2_U2B.get(ch);
    if (b === undefined) throw new Error(`gpt2 tokenizer: unmapped char ${JSON.stringify(ch)}`);
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

// Ranks keyed by latin1 string of the raw bytes (fast Map lookup).
function loadTiktokenRanks(filename) {
  const ranks = new Map();
  const lines = readFileSync(join(DATA_DIR, filename), "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const space = line.indexOf(" ");
    const tokenBytes = Buffer.from(line.slice(0, space), "base64");
    const rank = parseInt(line.slice(space + 1), 10);
    ranks.set(tokenBytes.toString("latin1"), rank);
  }
  return ranks;
}

function loadGpt2Ranks() {
  const encoder = JSON.parse(readFileSync(join(DATA_DIR, "gpt2-encoder.json"), "utf8"));
  const ranks = new Map();
  for (const [tokenStr, rank] of Object.entries(encoder)) {
    ranks.set(gpt2DecodeToken(tokenStr).toString("latin1"), rank);
  }
  return ranks;
}

const cache = new Map();

function getEncoding(family) {
  if (!SUPPORTED_FAMILIES.includes(family)) {
    throw new Error(`unknown tokenizer family: ${family} (supported: ${SUPPORTED_FAMILIES.join(", ")})`);
  }
  if (!cache.has(family)) {
    const ranks =
      family === "cl100k" ? loadTiktokenRanks("cl100k_base.tiktoken")
      : family === "o200k" ? loadTiktokenRanks("o200k_base.tiktoken")
      : loadGpt2Ranks();
    cache.set(family, { ranks, regex: new RegExp(PATTERNS[family], "gu") });
  }
  return cache.get(family);
}

// Standard BPE merge over the UTF-8 bytes of one regex piece.
function bytePairMerge(pieceBytes, ranks) {
  // parts: list of [start, end) offsets into pieceBytes
  const parts = [];
  for (let i = 0; i < pieceBytes.length; i++) parts.push([i, i + 1]);
  const rankOf = (a, b) => {
    const key = pieceBytes.subarray(a[0], b[1]).toString("latin1");
    const r = ranks.get(key);
    return r === undefined ? Infinity : r;
  };
  while (parts.length > 1) {
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const r = rankOf(parts[i], parts[i + 1]);
      if (r < bestRank) {
        bestRank = r;
        best = i;
      }
    }
    if (best === -1) break;
    parts[best] = [parts[best][0], parts[best + 1][1]];
    parts.splice(best + 1, 1);
  }
  return parts.map(([s, e]) => ranks.get(pieceBytes.subarray(s, e).toString("latin1")));
}

export function encode(text, family = "cl100k") {
  const { ranks, regex } = getEncoding(family);
  // Bounded piece cache: metering re-encodes similar prompts constantly.
  let pieceCache = encode._pieceCache;
  if (!pieceCache) {
    pieceCache = encode._pieceCache = new Map();
  }
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const pieceStr = m[0];
    if (pieceStr.length === 0) {
      regex.lastIndex++;
      continue;
    }
    const cacheKey = family + ":" + pieceStr;
    let tokenIds = pieceCache.get(cacheKey);
    if (tokenIds === undefined) {
      const piece = Buffer.from(pieceStr, "utf8");
      tokenIds = [];
      for (const rank of bytePairMerge(piece, ranks)) {
        if (rank === undefined) {
          throw new Error(`tokenizer(${family}): no rank for a merged piece — rank data incomplete`);
        }
        tokenIds.push(rank);
      }
      if (pieceCache.size > 50000) pieceCache.clear();
      pieceCache.set(cacheKey, tokenIds);
    }
    for (const id of tokenIds) out.push(id);
  }
  return out;
}

export function countTokens(text, family = "cl100k") {
  return encode(text, family).length;
}

// Tokens/sec benchmark helper: encodes `text` `rounds` times.
export function benchmark(text, family = "cl100k", rounds = 5) {
  encode(text, family); // warmup (loads ranks)
  const start = process.hrtime.bigint();
  let tokens = 0;
  for (let i = 0; i < rounds; i++) tokens += encode(text, family).length;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { family, tokens, rounds, ms, tokensPerSec: Math.round(tokens / (ms / 1000)) };
}
