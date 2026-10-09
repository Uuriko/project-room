// Shared fuzz harness: seeded PRNG, hostile value generators, leak scanner.
import { writeFileSync } from "node:fs";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_STRINGS = ["", " ", "\u0000", "a".repeat(100000), "x".repeat(4097), "\u{1F600}".repeat(5000),
  "<script>alert(1)</script>", "../../etc/passwd", "null", "undefined", "NaN", "Infinity",
  "\r\nBcc: evil@example.com", "mid with spaces", "a".repeat(129), "0".repeat(2049),
  "\u202e", "\uFEFF", "a\0b", "x".repeat(17 * 1024), "%00", "\uD800", "ß".repeat(3000)];

export function hostileValue(rand, depth = 0) {
  const r = rand();
  if (depth > 3) return HOSTILE_STRINGS[(rand() * HOSTILE_STRINGS.length) | 0];
  if (r < 0.18) return HOSTILE_STRINGS[(rand() * HOSTILE_STRINGS.length) | 0];
  if (r < 0.26) return (rand() * 2 - 1) * 1e18;
  if (r < 0.30) return rand() < 0.5 ? Number.MAX_SAFE_INTEGER + 5 : -(Number.MAX_SAFE_INTEGER + 5);
  if (r < 0.36) return NaN;
  if (r < 0.40) return Infinity;
  if (r < 0.46) return null;
  if (r < 0.52) return undefined;
  if (r < 0.58) return rand() < 0.5;
  if (r < 0.66) { const a = []; const n = (rand() * 6) | 0; for (let i = 0; i < n; i++) a.push(hostileValue(rand, depth + 1)); return a; }
  if (r < 0.80) { const o = {}; const n = (rand() * 6) | 0; for (let i = 0; i < n; i++) { let k; try { k = String(hostileValue(rand, depth + 1)); } catch { k = "k"; } o[k.slice(0, 64)] = hostileValue(rand, depth + 1); } try { o.__proto__ = hostileValue(rand, depth + 1); } catch {} return o; }
  if (r < 0.86) return BigInt((rand() * 1e15) | 0);
  if (r < 0.90) return Symbol("fuzz");
  return () => {};
}

// Credential/token leak scan over an error's string form.
const LEAK_PATTERNS = [/bot\d{5,12}:[A-Za-z0-9_-]{30,}/, /Bearer\s+\S{8,}/i, /refresh[_-]?token/i,
  /AIza[0-9A-Za-z_-]{10,}/, /xox[bap]-[A-Za-z0-9-]{8,}/, /"password"\s*:\s*"[^"]+"/i, /sk-[A-Za-z0-9]{8,}/];

export function leakScan(value) {
  const s = String(value?.stack ?? value?.message ?? value);
  return LEAK_PATTERNS.filter(re => re.test(s)).map(re => re.source);
}

function safePreview(v) {
  try {
    return (JSON.stringify(v, (k, x) => typeof x === "bigint" ? "bigint" : typeof x === "function" ? "fn" : typeof x === "symbol" ? "sym" : x) ?? String(typeof v)).slice(0, 300);
  } catch { return String(typeof v); }
}

// Run `fn(input)` for N inputs with per-input async timeout. Allowed error
// names pass silently; anything else (incl. hang or leak) is a failure.
export async function fuzz({ name, count, seed = 42, gen, fn, allowed = [], inputTimeoutMs = 2000, leakCheck = true, serviceErrorOk = false }) {
  const rand = mulberry32(seed);
  let ok = 0, allowedErr = 0, failed = 0;
  const failures = [];
  const allowedNames = new Set(allowed);
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const input = gen(rand, i);
    let timer, done = false;
    try {
      const res = await Promise.race([
        Promise.resolve().then(() => fn(input, i)).then(() => { done = true; return "ok"; }),
        new Promise((_, rej) => { timer = setTimeout(() => { if (!done) rej(new Error("FUZZ_TIMEOUT")); }, inputTimeoutMs); }),
      ]);
      clearTimeout(timer);
      if (res === "ok") ok++;
    } catch (error) {
      clearTimeout(timer);
      const tag = error?.name ?? typeof error;
      if (error?.message === "FUZZ_TIMEOUT") { failed++; failures.push({ i, kind: "TIMEOUT", input: safePreview(input) }); continue; }
      const isServiceError = tag === "Error" && typeof error?.code === "string" && typeof error?.status === "number";
      if (allowedNames.has(tag) || (serviceErrorOk && isServiceError)) { allowedErr++; continue; }
      failed++;
      const leaks = leakCheck ? leakScan(error) : [];
      failures.push({ i, kind: tag, message: String(error?.message ?? error).slice(0, 200), leaks, input: safePreview(input) });
      if (failures.length >= 10) break;
    }
  }
  const report = { name, count, ok, allowedErr, failed, failures, ms: Date.now() - t0 };
  writeFileSync(`/tmp/fuzz-${name}.json`, JSON.stringify(report, null, 1));
  console.log(`${name}: ok=${ok} allowed=${allowedErr} FAILED=${failed} (${report.ms}ms)`);
  for (const f of failures.slice(0, 5)) console.log("  FAIL " + JSON.stringify(f).slice(0, 300));
  process.exitCode = failed ? 1 : 0;
  return report;
}
