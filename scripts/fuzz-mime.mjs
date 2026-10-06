// Continuous fuzzing for the MIME parser (server/mime-message.mjs).
//
// Backlog Q005: pathological MIME inputs exist in the wild, so the parser is
// fuzzed on a schedule. The invariant is simple and total: for ANY byte
// input, parseMimeMessage must either return a result or throw a MimeError.
// Anything else (a hang, a crash, an uncaught TypeError/RangeError/...) is a
// failure. Failing inputs are written to the report directory with the seed
// and case index so they reproduce deterministically.
//
// Bounded by design so it cannot stall the pipeline:
//   --seed N        PRNG seed (default 20261006; same seed => same inputs)
//   --iterations N  random cases after the corpus (default 20000)
//   --budget-ms N   wall-clock budget for the random phase (default 480000)
//   --max-ms N      per-case time limit; a slower case is a "slow" failure
//                   (default 5000). A true infinite loop cannot be caught
//                   in-process; run under `timeout(1)` (the CI job does) so
//                   the OS bounds it.
//   --corpus DIR    seed corpus directory (default tests/fuzz/mime-corpus)
//   --report DIR    failing inputs land here (default ./mime-fuzz-out,
//                   created only on failure)
//   --skip-corpus   random phase only
//   --quiet         summary line only
//
// Exit code: 0 when every case held the invariant, 1 otherwise.
//
// The corpus fixtures double as the regression gate: tests/mime-fuzz.test.js
// runs them (plus a short deterministic random sweep) inside `npm test`, so
// the corpus runs on every PR while this script runs the longer scheduled
// sweep. Both import the same helpers below, so there is one owner for the
// invariant.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMimeMessage, MimeError } from "../server/mime-message.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const DEFAULT_CORPUS_DIR = join(root, "tests", "fuzz", "mime-corpus");
export const DEFAULT_SEED = 20261006;

// Deterministic PRNG (mulberry32): same seed => same input stream, so a CI
// failure reproduces locally with --seed <n>.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One input against the invariant. Returns a small record; never throws.
export function checkOne(input, { maxMs = 5000 } = {}) {
  const started = performance.now();
  try {
    parseMimeMessage(input);
  } catch (e) {
    const ms = performance.now() - started;
    if (e instanceof MimeError) return ms > maxMs ? { outcome: "slow", ms, code: e.code } : { outcome: "error", ms, code: e.code };
    return { outcome: "unclean", ms, error: e };
  }
  const ms = performance.now() - started;
  return ms > maxMs ? { outcome: "slow", ms } : { outcome: "ok", ms };
}

// Seed corpus: [{ file, expect: "ok"|"error", code?, bytes }]. The manifest
// pins the intended outcome so a behavior change fails loudly instead of
// silently re-baselining.
export function loadCorpus(dir = DEFAULT_CORPUS_DIR) {
  const manifest = JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8"));
  return manifest.map(entry => ({ ...entry, bytes: readFileSync(join(dir, entry.file)) }));
}

export function checkCorpusEntry(entry, { maxMs = 5000 } = {}) {
  const r = checkOne(entry.bytes, { maxMs });
  if (r.outcome === "unclean") return { problem: `unclean ${r.error?.constructor?.name ?? "throw"}: ${r.error?.message ?? r.error}`.slice(0, 200), result: r };
  if (r.outcome === "slow") return { problem: `slow: ${r.ms.toFixed(0)}ms > ${maxMs}ms`, result: r };
  if (entry.expect === "ok" && r.outcome !== "ok") {
    return { problem: `expected ok, got ${r.outcome}${r.code ? `:${r.code}` : ""}`, result: r };
  }
  if (entry.expect === "error" && (r.outcome !== "error" || r.code !== entry.code)) {
    return { problem: `expected error:${entry.code}, got ${r.outcome}${r.code ? `:${r.code}` : ""}`, result: r };
  }
  return { problem: null, result: r };
}

// --- Random input generation ---------------------------------------------

const HEADER_NAMES = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "Content-Type",
  "Content-Transfer-Encoding", "Content-Disposition", "MIME-Version", "Reply-To", "X-Custom", "Received"];
// Tokens chosen to tickle the parser's hand-written scanners and regexes.
const NASTY = ["=?utf-8?Q?AAAA?=", "=?", "?=", "?Q?", "?B?", "--", "\r\n", "\n", "\r", "<", ">", "\"", "'",
  ";", ":", "=", "%", "_", "&", "#", "(", ")", "[", "]", "*", "?", "\x00", "\x01", "\x7f", "\u00e9",
  " boundary=", "charset=", "multipart/mixed", "text/plain", "A".repeat(80), "-".repeat(80), " ".repeat(40)];
const CT_VALUES = ["text/plain", "text/html", "multipart/mixed", "multipart/alternative",
  "application/octet-stream", "message/rfc822", "TEXT/PLAIN", "multipart/mixed; boundary=",
  "text/plain; charset=utf-8", "text/plain; charset=x-unknown", "multipart/related; boundary=\"b1\""];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const rint = (rng, n) => Math.floor(rng() * n);

function nastyChunk(rng, maxLen) {
  const len = 1 + rint(rng, maxLen);
  let s = "";
  while (s.length < len) s += pick(rng, NASTY);
  return s.slice(0, len);
}

// A generational random message; depth is capped above the parser's limit so
// some inputs exercise the depth guard.
export function genMessage(rng, depth = 0) {
  const headers = [];
  const nHeaders = 1 + rint(rng, 8);
  for (let i = 0; i < nHeaders; i++) {
    const name = pick(rng, HEADER_NAMES);
    const value = rng() < 0.3 ? nastyChunk(rng, 120) : pick(rng, CT_VALUES);
    headers.push(`${name}: ${value}`);
    if (rng() < 0.15) headers.push(` ${nastyChunk(rng, 60)}`); // folded continuation
  }
  let body;
  const kind = rint(rng, 4);
  if (kind === 0 || depth > 5) {
    body = nastyChunk(rng, 2000);
  } else {
    const boundary = `b${rint(rng, 1e6)}${rng() < 0.2 ? nastyChunk(rng, 8) : ""}`;
    const nParts = 1 + rint(rng, 4);
    const parts = [];
    for (let i = 0; i < nParts; i++) parts.push(`--${boundary}\n${genMessage(rng, depth + 1)}`);
    body = `${nastyChunk(rng, 40)}\n${parts.join("\n")}\n--${boundary}${rng() < 0.7 ? "--" : ""}\n${nastyChunk(rng, 40)}`;
  }
  return `${headers.join(rng() < 0.5 ? "\r\n" : "\n")}\n\n${body}`;
}

// Mutational: pick a base input and apply 1-3 byte-level mutations.
export function mutate(rng, base) {
  let buf = Buffer.from(base);
  const nMut = 1 + rint(rng, 3);
  for (let m = 0; m < nMut; m++) {
    const op = rint(rng, 5);
    if (op === 0 && buf.length > 0) { // random byte overwrite
      buf[rint(rng, buf.length)] = rint(rng, 256);
    } else if (op === 1) { // splice in a nasty token
      const at = rint(rng, buf.length + 1);
      const tok = Buffer.from(pick(rng, NASTY), "utf8");
      buf = Buffer.concat([buf.subarray(0, at), tok, buf.subarray(at)]);
    } else if (op === 2 && buf.length > 1) { // truncate
      buf = buf.subarray(0, rint(rng, buf.length));
    } else if (op === 3 && buf.length > 0) { // duplicate a span
      const at = rint(rng, buf.length), len = 1 + rint(rng, Math.min(200, buf.length - at));
      const span = buf.subarray(at, at + len);
      buf = Buffer.concat([buf.subarray(0, at), span, span, buf.subarray(at + len)]);
    } else if (buf.length > 1) { // swap two bytes
      const a = rint(rng, buf.length), b = rint(rng, buf.length);
      const t = buf[a]; buf[a] = buf[b]; buf[b] = t;
    }
  }
  return buf;
}

// Pure byte soup with a nasty-biased alphabet, 0..3000 bytes.
export function randomSoup(rng) {
  const alphabet = NASTY.join("").replace(/[\u0080-\uffff]/g, "");
  const len = rint(rng, 3001);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = alphabet.charCodeAt(rint(rng, alphabet.length)) & 0xff;
  return out;
}

// --- Driver ---------------------------------------------------------------

export function runFuzz({
  seed = DEFAULT_SEED,
  iterations = 20000,
  budgetMs = 480000,
  maxMs = 5000,
  corpusDir = DEFAULT_CORPUS_DIR,
  reportDir = resolve("mime-fuzz-out"),
  skipCorpus = false,
  quiet = false,
} = {}) {
  const rng = mulberry32(seed);
  const failures = [];
  const stats = { corpus: 0, generated: 0, mutated: 0, soup: 0, ok: 0, error: 0, slow: 0, unclean: 0, maxMsSeen: 0 };
  const log = quiet ? () => {} : (...a) => console.log(...a);
  let reported = false;
  const saveFailure = (label, input, detail) => {
    if (!reported) { mkdirSync(reportDir, { recursive: true }); reported = true; }
    const n = failures.length;
    writeFileSync(join(reportDir, `fail-${n}.eml`), Buffer.from(input));
    writeFileSync(join(reportDir, `fail-${n}.txt`),
      `label: ${label}\nseed: ${seed}\ndetail: ${detail}\nrepro: node scripts/fuzz-mime.mjs --seed ${seed} (same seed replays the same input stream; the exact bytes are in fail-${n}.eml)\n`);
  };
  const note = (label, input, r, extra = "") => {
    stats[r.outcome] = (stats[r.outcome] ?? 0) + 1;
    stats.maxMsSeen = Math.max(stats.maxMsSeen, r.ms);
    if (r.outcome === "ok" || r.outcome === "error") return;
    const detail = r.outcome === "slow"
      ? `slow: ${r.ms.toFixed(1)}ms > ${maxMs}ms${extra}`
      : `unclean ${r.error?.constructor?.name ?? "throw"}: ${(r.error?.message ?? r.error ?? "").toString().slice(0, 300)}${extra}`;
    failures.push({ label, detail });
    saveFailure(label, input, detail);
  };

  if (!skipCorpus) {
    for (const entry of loadCorpus(corpusDir)) {
      stats.corpus++;
      const { problem, result } = checkCorpusEntry(entry, { maxMs });
      if (problem) {
        failures.push({ label: `corpus:${entry.file}`, detail: problem });
        saveFailure(`corpus:${entry.file}`, entry.bytes, problem);
      } else note(`corpus:${entry.file}`, entry.bytes, result);
    }
    log(`corpus: ${stats.corpus} fixtures checked`);
  }

  const corpusSeeds = skipCorpus ? [] : loadCorpus(corpusDir).map(e => e.bytes);
  const started = performance.now();
  let i = 0;
  for (; i < iterations; i++) {
    if (performance.now() - started > budgetMs) break;
    const roll = rng();
    let input, label;
    if (roll < 0.4) { input = Buffer.from(genMessage(rng), "utf8"); label = `gen#${i}`; stats.generated++; }
    else if (roll < 0.7) {
      const base = corpusSeeds.length > 0 && rng() < 0.5 ? corpusSeeds[rint(rng, corpusSeeds.length)] : Buffer.from(genMessage(rng), "utf8");
      input = mutate(rng, base); label = `mut#${i}`; stats.mutated++;
    } else { input = randomSoup(rng); label = `soup#${i}`; stats.soup++; }
    note(label, input, checkOne(input, { maxMs }));
    if (failures.length > 0 && failures.length % 25 === 0) log(`... ${failures.length} failures so far (${i + 1} cases)`);
  }
  const elapsed = performance.now() - started;
  log(`random: ${i} cases in ${elapsed.toFixed(0)}ms (seed ${seed}) — ok:${stats.ok} mime-error:${stats.error} slow:${stats.slow} unclean:${stats.unclean} slowest:${stats.maxMsSeen.toFixed(1)}ms`);
  if (failures.length > 0) {
    log(`FAILURES: ${failures.length} (inputs in ${reportDir})`);
    for (const f of failures.slice(0, 10)) log(`  - ${f.label}: ${f.detail}`);
  } else log("all cases held the invariant: clean result or MimeError, nothing else");
  return { failures, stats: { ...stats, randomCases: i, elapsedMs: elapsed } };
}

const BOOLEAN_FLAGS = new Set(["skipCorpus", "quiet"]);
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) { console.error(`unknown arg: ${argv[i]}`); process.exit(2); }
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOLEAN_FLAGS.has(key)) { out[key] = m[2] === undefined ? true : m[2] !== "false"; continue; }
    if (m[2] !== undefined) { out[key] = m[2]; continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) { console.error(`missing value for --${m[1]}`); process.exit(2); }
    out[key] = argv[++i];
  }
  for (const k of ["seed", "iterations", "budgetMs", "maxMs"]) if (out[k] !== undefined) out[k] = Number(out[k]);
  return out;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const { failures } = runFuzz({
    seed: args.seed ?? DEFAULT_SEED,
    iterations: args.iterations ?? 20000,
    budgetMs: args.budgetMs ?? 480000,
    maxMs: args.maxMs ?? 5000,
    corpusDir: args.corpus ?? DEFAULT_CORPUS_DIR,
    reportDir: args.report ?? resolve("mime-fuzz-out"),
    skipCorpus: args.skipCorpus ?? false,
    quiet: args.quiet ?? false,
  });
  process.exit(failures.length > 0 ? 1 : 0);
}
