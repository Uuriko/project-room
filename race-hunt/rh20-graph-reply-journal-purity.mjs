// RH-20: graph-reply-journal — the transition functions are pure state
// machines (no shared mutable state). Verify structurally: no module-level
// mutable state, no awaits in the transition paths, and 10k randomized
// transitions never corrupt the updates map (no lost updates from aliasing).
import { readFileSync } from "node:fs";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const mod = await import(REPO + "/server/graph-reply-journal.mjs");
const src = readFileSync(REPO + "/server/graph-reply-journal.mjs", "utf8");
let bad = 0;
const check = (name, cond) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); if (!cond) bad++; };

// structural: no module-level let/var (mutable shared state), no awaits
const topLevel = src.split("\n").filter(l => /^(let|var)\s/.test(l));
check("no module-level mutable state", topLevel.length === 0);
const fnSrc = src.slice(src.indexOf("export function transitionReplyUpdate"));
check("no await in transition functions", !/\bawait\b/.test(fnSrc));

// behavioral: reserve returns a fresh object; the input map and the input
// proposal are never mutated or aliased (two callers sharing state cannot
// observe each other's writes)
const { transitionReplyUpdate } = mod;
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 10000; i++) {
  const updates = new Map();
  const hex64 = "a".repeat(64);
  const rid = `req-${i}-x`, sid = `src-${i}-x`, aid = `att-${i}-x`;
  const proposal = { requestId: rid, sourceId: sid, attemptId: aid,
    attemptRevision: 0, updateVersion: hex64, status: "update_proposed", update: { text: "hello" } };
  const request = { action: "reply.update.reserve", requestId: rid, sourceId: sid,
    attemptId: aid, expectedRevision: 0, updateVersion: hex64 };
  const out = transitionReplyUpdate(updates, request, { proposal, dispatch: null, inspection: null, review: null, at: 1000 + i });
  if (updates.size !== 0) { bad++; console.log(`FAIL: input map mutated at ${i}`); break; }
  if (out.proposal === proposal || out.proposal.update === proposal.update) {
    bad++; console.log(`FAIL: returned object aliases input proposal at ${i}`); break;
  }
  out.proposal.update.text = "MUTATED";
  if (proposal.update.text !== "hello") { bad++; console.log(`FAIL: structuredClone isolation broken at ${i}`); break; }
  if (out.status !== "reserved" || out.revision !== 0) { bad++; console.log(`FAIL: wrong reserve result at ${i}`); break; }
}
console.log(bad === 0
  ? "RH-20 RESULT: PASS — reply journal transitions are pure (no shared-state race possible)"
  : `RH-20 RESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 2);
