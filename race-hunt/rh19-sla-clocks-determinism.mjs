// RH-19: sla-clocks — pure assessment functions. Concurrency N/A by
// construction; verify determinism (same inputs -> byte-identical outputs)
// across 5k randomized thread states, since any nondeterminism here would be
// a hidden race in the SLA surface.
import { createHash } from "node:crypto";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { assessThreadSla, assessSlaBatch } = await import(REPO + "/server/sla-clocks.mjs");

let seed = 1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const channels = ["email", "telegram", "room"];
const mkThread = i => ({
  threadId: `t${i}`,
  channel: channels[Math.floor(rnd() * channels.length)],
  messages: Array.from({ length: Math.floor(rnd() * 8) }, (_, j) => ({
    id: `m${j}`,
    occurredAt: new Date(1_700_000_000_000 + Math.floor(rnd() * 3600_000)).toISOString(),
    direction: rnd() < 0.5 ? "outbound" : "inbound",
  })),
});
let bad = 0;
for (let i = 0; i < 5000; i++) {
  const thread = mkThread(i);
  const now = 1_700_003_600_000;
  const a = JSON.stringify(assessThreadSla({ ...thread, now }));
  const b = JSON.stringify(assessThreadSla({ ...thread, now }));
  if (a !== b) { bad++; if (bad < 3) console.log(`FAIL: nondeterministic assessment at ${i}`); }
}
const batch = Array.from({ length: 50 }, (_, i) => mkThread(10000 + i));
const h1 = createHash("sha256").update(JSON.stringify(assessSlaBatch(batch, { now: 1_700_003_600_000 }))).digest("hex");
const h2 = createHash("sha256").update(JSON.stringify(assessSlaBatch(batch, { now: 1_700_003_600_000 }))).digest("hex");
if (h1 !== h2) { bad++; console.log("FAIL: batch assessment nondeterministic"); }
console.log(bad === 0
  ? "RH-19 RESULT: PASS — sla-clocks deterministic over 5k states (no hidden time race)"
  : `RH-19 RESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 2);
