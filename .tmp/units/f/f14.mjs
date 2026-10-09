// f14: submit.mjs hostile argv — each must exit nonzero WITHOUT writing
// findings.jsonl. Run in a scratch cwd.
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f14";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + "/telemetry", { recursive: true });
const cases = [
  ["no-args", []],
  ["missing-value", ["--guild"]],
  ["flag-as-value", ["--guild", "--claim", "0123456789", "--evidence", "0123456789"]],
  ["short-claim", ["--guild", "g", "--claim", "short", "--evidence", "0123456789abcdef"]],
  ["numbers-array", ["--guild", "g", "--claim", "0123456789", "--evidence", "0123456789abcdef", "--numbers", "[1,2]"]],
  ["numbers-broken", ["--guild", "g", "--claim", "0123456789", "--evidence", "0123456789abcdef", "--numbers", "{nope"]],
  ["roomseq-float", ["--guild", "g", "--claim", "0123456789", "--evidence", "0123456789abcdef", "--room-seq", "1.5"]],
  ["category-bogus", ["--guild", "g", "--claim", "0123456789", "--evidence", "0123456789abcdef", "--category", "bogus"]],
  ["positional", ["oops"]],
  ["giant-claim", ["--guild", "g", "--claim", "x".repeat(5_000_000), "--evidence", "0123456789abcdef"]],
];
let bad = 0;
for (const [name, argv] of cases) {
  let code;
  try { execFileSync("node", [P + "/telemetry/submit.mjs", ...argv], { cwd: dir, stdio: "pipe", timeout: 10000 }); code = 0; }
  catch (e) { code = e.status ?? 99; }
  const wrote = existsSync(dir + "/telemetry/findings.jsonl");
  const ok = code !== 0 && !wrote;
  console.log(`${ok ? "ok" : "BAD"}: ${name} exit=${code} wrote=${wrote}`);
  if (!ok) bad++;
}
if (bad > 0) { console.log(`F14 FAIL: ${bad} hostile argv cases misbehaved`); process.exit(1); }
console.log("F14 PASS");
