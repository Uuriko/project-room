// RH-13: merge-slot queue is IN-PROCESS state — verify (a) no await between
// check-and-act in the slot methods (structural: sync code can't interleave),
// (b) adopt() stickiness under rapid sequential adoption (first worker wins),
// (c) 20k randomized op interleavings preserve state invariants.
import { readFileSync } from "node:fs";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createMergeSlotQueue } = await import(REPO + "/server/merge-queue.mjs");

let bad = 0;
// (a) structural: the queue's critical sections must not await
const src = readFileSync(REPO + "/server/merge-queue.mjs", "utf8");
const queueSrc = src.slice(src.indexOf("export function createMergeSlotQueue"), src.indexOf("export function createMergeQueueRegistry"));
const awaits = (queueSrc.match(/\bawait\b/g) || []).length;
console.log(`awaits inside createMergeSlotQueue: ${awaits}`);
if (awaits !== 0) { bad++; console.log("FAIL: await inside slot critical section — interleaving possible"); }

// (b) adopt stickiness
{
  const q = createMergeSlotQueue({ now: () => 1000 });
  q.enqueue({ pr: 1, headSha: "a".repeat(40), claimId: "c1", lane: "lane-a" });
  q.adopt({ claimId: "c1", caller: "worker-1" });
  let secondErr = null;
  try { q.adopt({ claimId: "c1", caller: "worker-2" }); } catch (e) { secondErr = e; }
  if (!/already adopted/.test(secondErr?.message ?? "")) { bad++; console.log("FAIL: second adopter not refused"); }
  else console.log("ok - adopt stickiness: first worker wins");
}
// (c) randomized interleaving stress: invariants = at most one active holder,
// no duplicate claimIds across active+queue, lease always in the future
{
  let now = 1_000_000;
  const q = createMergeSlotQueue({ now: () => now });
  const lanes = ["lane-a", "lane-b", "lane-c"];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  for (let i = 0; i < 20000; i++) {
    now += Math.floor(rnd() * 5000);
    const op = rnd(), claimId = `c${Math.floor(rnd() * 6)}`, lane = pick(lanes);
    try {
      if (op < 0.35) q.enqueue({ pr: i, headSha: "b".repeat(40), claimId, lane });
      else if (op < 0.5) q.heartbeat({ claimId, caller: lane, asOwner: true });
      else if (op < 0.6) q.adopt({ claimId, caller: "w" + Math.floor(rnd() * 3) });
      else if (op < 0.75) q.release({ claimId, caller: lane, asOwner: true });
      else q.sweep();
    } catch { /* refusals are legal outcomes */ }
    const s = q.status();
    const ids = [s.active?.claimId, ...s.queue.map(e => e.claimId)].filter(Boolean);
    if (new Set(ids).size !== ids.length) { bad++; console.log(`FAIL: duplicate claimId at iter ${i}`); break; }
    if (s.active && s.active.leaseExpiresAt <= now) { bad++; console.log(`FAIL: lapsed active slot at iter ${i}`); break; }
  }
  console.log("ok - 20k randomized ops: invariants hold");
}
console.log(bad === 0 ? "RH-13 RESULT: PASS — slot queue is interleave-safe (sync, single-threaded)"
  : `RH-13 RESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 2);
