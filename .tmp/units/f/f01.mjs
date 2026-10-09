// f01: validate.mjs hostile corpus — 200 hostile inputs. Each must exit 0/1
// (PASS/FAIL); a crash (uncaught exception, exit != 0/1, or stderr stack) FAILs.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f01";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const valid = () => ({ id: "tb-f01-valid", guild: "g11", claim: "0123456789",
  evidence: "0123456789abcdef", numbers: { n: 1 }, timestamp: new Date().toISOString() });
const corpus = [];
corpus.push(["null", "null"], ["array", "[1,2]"], ["string", '"x"'], ["number", "42"],
  ["empty", "{}"], ["deep", JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } })],
  ["unicode", JSON.stringify({ ...valid(), claim: "héllo→世界🌍🌍🌍🌍🌍" })],
  ["huge-claim", JSON.stringify({ ...valid(), claim: "x".repeat(2_000_000) })],
  ["huge-numbers", JSON.stringify({ ...valid(), numbers: Object.fromEntries(
    Array.from({ length: 5000 }, (_, i) => ["k" + i, i])) })],
  ["proto-pollution", '{"id":"tb-f01-p","guild":"g","claim":"0123456789","evidence":"0123456789","numbers":{},"timestamp":"2026-01-01T00:00:00Z","__proto__":{"x":1}}'],
  ["nan-string", JSON.stringify({ ...valid(), numbers: { n: "NaN" } })],
  ["neg-zero", JSON.stringify({ ...valid(), numbers: { n: -0 } })],
  ["big-num", JSON.stringify({ ...valid(), numbers: { n: 1e308 } })],
  ["id-uppercase", JSON.stringify({ ...valid(), id: "TB-UPPER" })],
  ["id-empty", JSON.stringify({ ...valid(), id: "" })],
  ["claim-9", JSON.stringify({ ...valid(), claim: "123456789" })],
  ["claim-10", JSON.stringify({ ...valid(), claim: "1234567890" })],
  ["ts-bad", JSON.stringify({ ...valid(), timestamp: "not-a-date" })],
  ["ts-noniso", JSON.stringify({ ...valid(), timestamp: "10/09/2026" })],
  ["cat-bad", JSON.stringify({ ...valid(), category: "nonsense" })],
  ["conf-null", JSON.stringify({ ...valid(), confidence: null })],
  ["roomseq-float", JSON.stringify({ ...valid(), roomSeq: 1.5 })],
  ["roomseq-big", JSON.stringify({ ...valid(), roomSeq: 2 ** 53 })],
  ["truncated", '{"id":"tb-f01-t"'],
  ["bom", "\uFEFF" + JSON.stringify(valid())],
  ["ndjson-two", JSON.stringify(valid()) + "\n" + JSON.stringify(valid())],
  ["trailing-garbage", JSON.stringify(valid()) + "zzz"],
);
for (let i = 0; i < 170; i++) {
  const v = valid();
  v.id = `tb-f01-fuzz-${i}`;
  v.claim = "c".repeat(10 + (i % 50));
  v.numbers = { n: i, f: i / 3 };
  if (i % 7 === 0) v.category = ["correctness", "bogus"][i % 2];
  if (i % 11 === 0) delete v.evidence;
  corpus.push([`gen-${i}`, JSON.stringify(v)]);
}
let pass = 0, fail = 0, crash = 0;
for (const [name, body] of corpus) {
  const f = `${dir}/${name}.json`;
  writeFileSync(f, body);
  let code;
  try { execFileSync("node", [P + "/telemetry/validate.mjs", f], { stdio: "pipe" }); code = 0; }
  catch (e) {
    code = e.status ?? 99;
    const err = String(e.stderr ?? "");
    // A real crash = non-0/1 exit or a V8 stack frame. validate.mjs always
    // prints "FAIL <file>: ..." and exits 1 on bad input — that is not a crash.
    if (code !== 0 && code !== 1) { crash++; console.log(`CRASH ${name}: exit=${code}`); continue; }
    if (/^\s+at \S/m.test(err)) { crash++; console.log(`CRASH ${name}: stack trace`); continue; }
  }
  if (code === 0) pass++; else fail++;
}
console.log(`f01: corpus=${corpus.length} pass=${pass} fail=${fail} crash=${crash}`);
if (crash > 0) { console.log("F01 FAIL: crashed inputs"); process.exit(1); }
console.log("F01 PASS");
