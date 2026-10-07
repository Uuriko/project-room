// Merge-slot queue tests (orch-merge-queue, phase 1: room-coordinated queue).
//
// Authoring-gate answers (repo .agents/skills/test-audit/SKILL.md):
// 1. Observable contract: at most one merge-slot holder per room; FIFO positions
//    are machine-readable; stale holders are swept and the next entry promoted;
//    heartbeat keeps a live worker's slot, a dead worker's slot becomes
//    re-acquirable. These are the safety + liveness invariants of the queue.
// 2. Credible regressions: an async check-then-act split in enqueue lets two
//    lanes both hold the slot (double-land); sweep that forgets to promote
//    wedges the queue after a worker crash; position off-by-one misreports
//    "queue busy, position N"; heartbeat accepted after expiry lets a dead
//    worker's stale merge proceed.
// 3. No existing coverage: server/merge-queue.mjs is new; work-claims leases
//    cover claim expiry, not slot serialization.
// 4. No test-only production seams: the module's public API (enqueue /
//    heartbeat / adopt / release / sweep / status) is exactly what the HTTP
//    handler and the worker script call. `now` injection is the same seam
//    work-claims.mjs uses for deterministic lease tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMergeSlotQueue,
  MergeQueueError,
  DEFAULT_SLOT_LEASE_MS,
} from "../server/merge-queue.mjs";

const laneA = "ai_lane_a";
const laneB = "ai_lane_b";
const worker = "ai_worker";

function makeQueue(startMs = 1_000_000) {
  let nowMs = startMs;
  const queue = createMergeSlotQueue({ now: () => nowMs });
  return { queue, advance: ms => { nowMs += ms; }, now: () => nowMs };
}

const entryA = { pr: 1560, headSha: "a".repeat(40), claimId: "qa-fix-1", lane: laneA };
const entryB = { pr: 1562, headSha: "b".repeat(40), claimId: "qa-fix-2", lane: laneB };

test("two lanes racing for a free slot: exactly one holds, the other is queued at position 1", () => {
  const { queue } = makeQueue();
  const first = queue.enqueue(entryA);
  const second = queue.enqueue(entryB);
  assert.equal(first.status, "holding");
  assert.equal(first.position, 0);
  assert.equal(second.status, "queued");
  assert.equal(second.position, 1);
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-1");
  assert.equal(st.depth, 1);
  assert.equal(st.queue[0].position, 1);
});

test("enqueue is idempotent for the same claimId: no duplicate queue entries", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  const again = queue.enqueue(entryB);
  const retry = queue.enqueue({ ...entryA, headSha: "a".repeat(40) });
  assert.equal(again.position, 1);
  assert.equal(retry.status, "holding");
  assert.equal(retry.position, 0);
  assert.equal(queue.status().depth, 1);
});

test("try mode: granted when free, refused with merge_queue_busy + position when locked", () => {
  const { queue } = makeQueue();
  const free = queue.enqueue({ ...entryA, mode: "try" });
  assert.equal(free.status, "holding");
  assert.throws(() => queue.enqueue({ ...entryB, mode: "try" }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_busy");
    assert.equal(err.position, 1);
    return true;
  });
  // Queue mode still works alongside try mode.
  const queued = queue.enqueue({ ...entryB, mode: "queue" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.position, 1);
});

test("heartbeat renews the lease; heartbeat after expiry is rejected as unknown", () => {
  const { queue, advance } = makeQueue();
  const granted = queue.enqueue(entryA);
  advance(DEFAULT_SLOT_LEASE_MS - 1_000);
  const renewed = queue.heartbeat({ claimId: "qa-fix-1", caller: laneA });
  assert.ok(renewed.leaseExpiresAt > granted.leaseExpiresAt);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  assert.throws(() => queue.heartbeat({ claimId: "qa-fix-1", caller: laneA }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_unknown_entry");
    return true;
  });
});

test("sweep releases an expired holder and promotes the next entry with a fresh lease", () => {
  const { queue, advance, now } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  const swept = queue.sweep();
  assert.deepEqual(swept.swept, ["qa-fix-1"]);
  assert.equal(swept.promoted, "qa-fix-2");
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-2");
  assert.ok(st.active.leaseExpiresAt > now());
  assert.equal(st.depth, 0);
});

test("status never shows a stale holder: expiry is evaluated on read", () => {
  const { queue, advance } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-2");
  assert.equal(st.depth, 0);
});

test("release by a non-holder is refused; the lane can dequeue its own queued entry", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  assert.throws(() => queue.release({ claimId: "qa-fix-1", caller: laneB }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_forbidden");
    return true;
  });
  // Lane B removes its own queued entry; the holder is untouched.
  const removed = queue.release({ claimId: "qa-fix-2", caller: laneB });
  assert.equal(removed.released, true);
  assert.equal(removed.promoted, null);
  assert.equal(queue.status().active.claimId, "qa-fix-1");
  assert.equal(queue.status().depth, 0);
});

test("release by the holder promotes the next entry; unknown claimId is 404-class", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  const out = queue.release({ claimId: "qa-fix-1", caller: laneA });
  assert.equal(out.released, true);
  assert.equal(out.promoted, "qa-fix-2");
  assert.throws(() => queue.release({ claimId: "nope", caller: laneA }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_unknown_entry");
    return true;
  });
});

test("adopt lets the automation heartbeat and release; a stranger cannot", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  const adopted = queue.adopt({ claimId: "qa-fix-1", caller: worker });
  assert.equal(adopted.adoptedBy, worker);
  // Worker heartbeat keeps the lane's slot alive.
  const hb = queue.heartbeat({ claimId: "qa-fix-1", caller: worker });
  assert.ok(hb.leaseExpiresAt);
  // Stranger (not lane, not adopter) is refused.
  assert.throws(() => queue.heartbeat({ claimId: "qa-fix-1", caller: laneB }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_forbidden");
    return true;
  });
  // Worker releases after the merge; nothing left behind.
  const out = queue.release({ claimId: "qa-fix-1", caller: worker });
  assert.equal(out.released, true);
  assert.equal(queue.status().active, null);
});

test("invalid enqueue input is rejected with merge_queue_invalid_input", () => {
  const { queue } = makeQueue();
  for (const bad of [
    { ...entryA, pr: 0 },
    { ...entryA, pr: -5 },
    { ...entryA, headSha: "zzz" },
    { ...entryA, headSha: "a".repeat(39) },
    { ...entryA, claimId: "not a valid id!" },
    { ...entryA, lane: "" },
    { ...entryA, mode: "eventually" },
  ]) {
    assert.throws(() => queue.enqueue(bad), err => {
      assert.ok(err instanceof MergeQueueError, `expected MergeQueueError for ${JSON.stringify(bad)}`);
      assert.equal(err.code, "merge_queue_invalid_input");
      return true;
    });
  }
});

test("HTTP handler: try-mode refusal surfaces 409 with machine-readable position", async () => {
  const { handleMergeQueue, createMergeQueueRegistry } = await import("../server/merge-queue.mjs");
  const registry = createMergeQueueRegistry();
  const roomId = "muse-room";
  const calls = [];
  const helpers = {
    json: (status, body) => calls.push({ status, body }),
    reject: (status, code, message, extra) => {
      const err = new Error(message);
      err.httpStatus = status; err.code = code; err.extra = extra;
      throw err;
    },
    body: async () => ({ pr: 1562, headSha: "b".repeat(40), claimId: "qa-fix-2", lane: laneB, mode: "try" }),
  };
  // Occupy the slot first.
  await handleMergeQueue({
    req: { method: "POST" }, res: {}, url: new URL("http://x/api/rooms/muse-room/merge-queue/enqueue"),
    roomId, auth: { member: { id: laneA } }, mergeQueueRoute: "enqueue", registry,
    helpers: { ...helpers, body: async () => ({ pr: 1560, headSha: "a".repeat(40), claimId: "qa-fix-1" }) },
  });
  // Now the try-mode attempt must be refused 409 with position.
  let refused = null;
  try {
    await handleMergeQueue({
      req: { method: "POST" }, res: {}, url: new URL("http://x/api/rooms/muse-room/merge-queue/enqueue"),
      roomId, auth: { member: { id: laneB } }, mergeQueueRoute: "enqueue", registry, helpers,
    });
  } catch (err) { refused = err; }
  assert.ok(refused, "expected the try-mode enqueue to be refused");
  assert.equal(refused.httpStatus, 409);
  assert.equal(refused.code, "merge_queue_busy");
  assert.equal(refused.extra.position, 1);
});

// #1615 review 4371 (John's Tab, Fo concurring): the queue needs an approval
// gate. These are the cases the tick must refuse or pass.
import { approvalGate, patchUnchanged, queueCheckVerdict } from "../server/merge-queue.mjs";
import { execFileSync as runSync } from "node:child_process";
import { mkdtempSync as mkTemp, rmSync as rmTemp, writeFileSync as writeTemp, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir as tmpDir } from "node:os";
const HEAD = "6c7c792b0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const rev = (memberId, verdict, at, extra = {}) => ({ memberId, verdict, at, summary: "", basis: { version: 1, owner: "lane", headSha: null }, ...extra });
const claimWith = reviews => ({ id: "orch-x", owner: "lane", reviews });

test("approval gate: an unreviewed PR is refused, which is the #1615 gap", () => {
  assert.equal(approvalGate({ claim: claimWith([]), headSha: HEAD }).ok, false);
  assert.equal(approvalGate({ claim: null, headSha: HEAD }).ok, false);
  assert.match(approvalGate({ claim: claimWith([]), headSha: HEAD }).reason, /no independent approve bound to head 6c7c792/);
});

test("approval gate: an approve counts only from a non-owner, bound to the enqueued head", () => {
  const ok = approvalGate({ claim: claimWith([rev("fo", "approve", "2026-10-06T08:00:00Z", { summary: "APPROVE @6c7c792b, 12/12" })]), headSha: HEAD });
  assert.deepEqual(ok, { ok: true, approvedBy: ["fo"] });
  assert.equal(approvalGate({ claim: claimWith([rev("fo", "approve", "2026-10-06T08:00:00Z", { basis: { headSha: HEAD } })]), headSha: HEAD }).ok, true, "basis.headSha binds too");
  assert.equal(approvalGate({ claim: claimWith([rev("lane", "approve", "2026-10-06T08:00:00Z", { summary: "self 6c7c792b" })]), headSha: HEAD }).ok, false, "owner self-approval");
  assert.equal(approvalGate({ claim: claimWith([rev("fo", "approve", "2026-10-06T08:00:00Z", { summary: "looks good" })]), headSha: HEAD }).ok, false, "no head named");
  assert.equal(approvalGate({ claim: claimWith([rev("fo", "approve", "2026-10-06T08:00:00Z", { summary: "APPROVE @1ac2d27c" })]), headSha: HEAD }).ok, false, "a different head");
});

test("approval gate: the latest review per reviewer wins; any current changes_requested blocks", () => {
  const approve = rev("fo", "approve", "2026-10-06T08:00:00Z", { summary: "@6c7c792b ok" });
  assert.equal(approvalGate({ claim: claimWith([approve, rev("inst", "changes_requested", "2026-10-06T08:05:00Z")]), headSha: HEAD }).ok, false);
  assert.equal(approvalGate({ claim: claimWith([approve, rev("fo", "changes_requested", "2026-10-06T08:05:00Z")]), headSha: HEAD }).ok, false, "a later CHANGES supersedes the reviewer's approve");
  assert.equal(approvalGate({ claim: claimWith([rev("fo", "changes_requested", "2026-10-06T07:00:00Z"), approve]), headSha: HEAD }).ok, true, "a later approve clears the reviewer's earlier CHANGES");
});

test("operator release authority is exact-head, advisory, and cannot be self-issued through the claim", () => {
  const claim = claimWith([rev("fo", "changes_requested", "2026-10-07T12:00:00Z")]);
  assert.deepEqual(approvalGate({ claim, headSha: HEAD, authorizedHeadSha: HEAD }),
    { ok: true, approvedBy: [], authorization: "operator_exact_head" });
  assert.equal(approvalGate({ claim: claimWith([]), headSha: HEAD, authorizedHeadSha: HEAD }).ok, true);
  assert.equal(approvalGate({ claim: { ...claimWith([]), authorizedHeadSha: HEAD }, headSha: HEAD }).ok, false, "lane-controlled claim fields confer no authority");
  assert.equal(approvalGate({ claim, headSha: HEAD, authorizedHeadSha: HEAD.slice(0, 7) }).ok, false);
  assert.equal(approvalGate({ claim, headSha: HEAD, authorizedHeadSha: "a".repeat(40) }).ok, false);
  assert.equal(approvalGate({ claim, headSha: HEAD.slice(0, 7), authorizedHeadSha: HEAD.slice(0, 7) }).ok, false);
  assert.equal(approvalGate({ claim: null, headSha: HEAD, authorizedHeadSha: HEAD }).ok, false);
  assert.equal(approvalGate({ claim: { ...claim, state: "blocked" }, headSha: HEAD, authorizedHeadSha: HEAD }).ok, false, "explicit Board hold still binds");
});

test("queue checks wait for pending or missing checks instead of ejecting the slot", () => {
  const requiredChecks = ["test", "lint"];
  const runs = [{ id: 1, name: "test", status: "in_progress", conclusion: null }];
  assert.deepEqual(queueCheckVerdict({ runs, requiredChecks }), { state: "pending", pending: ["test", "lint"] });
  for (const status of ["queued", "pending", "waiting", "requested"]) {
    assert.equal(queueCheckVerdict({ runs: [{ name: "test", status }], requiredChecks }).state, "pending");
  }
});

test("queue checks use the latest run per name and retain legacy status support", () => {
  const requiredChecks = ["test", "lint"];
  const runs = [
    { id: 1, name: "test", status: "completed", conclusion: "failure" },
    { id: 2, name: "test", status: "completed", conclusion: "success" },
  ];
  assert.deepEqual(queueCheckVerdict({ runs, legacy: [{ name: "lint", state: "success" }], requiredChecks }), { state: "success" });
  assert.equal(queueCheckVerdict({ runs: [...runs, { id: 3, name: "test", status: "queued" }], legacy: [{ name: "test", state: "success" }, { name: "lint", state: "success" }], requiredChecks }).state, "pending", "old success cannot cover a new queued attempt");
});

test("queue checks refuse terminal failures, skipped required checks, and unknown completed results", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "skipped", null]) {
    assert.equal(queueCheckVerdict({ runs: [{ name: "test", status: "completed", conclusion }], requiredChecks: ["test"] }).state, "failure");
  }
  assert.equal(queueCheckVerdict({ legacy: [{ name: "test", state: "error" }], requiredChecks: ["test"] }).state, "failure");
});

test("live worker waits for CI, binds Project Room and the tested head, and refuses a head race", t => {
  const dir = mkTemp(joinPath(tmpDir(), "mq-worker-"));
  t.after(() => rmTemp(dir, { recursive: true, force: true }));
  const fixture = joinPath(dir, "worker-fixture.mjs");
  const worker = new URL("../scripts/merge-queue-worker.mjs", import.meta.url).pathname;
  writeTemp(fixture, `
import fs from 'node:fs'; import os from 'node:os'; import cp from 'node:child_process';
import https from 'node:https'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
const root=process.env.QUEUE_TEST_ROOT, head=process.env.QUEUE_TEST_HEAD, next='b'.repeat(40), repo='Uuriko/project-room';
let polls=0; const record=(kind,value)=>fs.appendFileSync(root+'/'+process.env.QUEUE_TEST_CASE+'.jsonl',JSON.stringify({kind,value})+'\\n');
os.homedir=()=>root;
cp.execFileSync=(cmd,args,opts={})=>{
 record(cmd,args);
 if(cmd==='gh'){
  if(args[0]==='--version')return 'gh 2';
  if(args[0]==='pr'){
   if(args[args.indexOf('--repo')+1]!==repo)throw Error('wrong repository');
   if(args[1]==='view')return JSON.stringify(args.includes('reviews')?['CHANGES_REQUESTED']:{state:'OPEN',baseRefName:'main',headRefOid:head,headRefName:'lane/test',mergeable:'MERGEABLE',number:9000});
   if(args[1]==='merge'){
    if(polls<2)throw Error('merge attempted before CI passed');
    if(args[args.indexOf('--match-head-commit')+1]!==next)throw Error('merge missing tested-head CAS');
    if(process.env.QUEUE_TEST_CASE==='race')throw Object.assign(Error('head moved'),{stderr:'head moved'});
    return '';
   }
  }
  if(args[0]==='api'&&args[1]=== 'repos/'+repo+'/commits/'+next+'/check-runs?per_page=100'){
   polls++;return JSON.stringify(['test','contract','lint','browser','cloudflare'].map((name,id)=>({id,name,status:polls===1?'queued':'completed',conclusion:polls===1?null:'success'})));
  }
  if(args[0]==='api'&&args[1]==='repos/'+repo+'/commits/'+next+'/status')return '[]';
 }
 if(cmd==='git'){
  if(args[0]==='clone'){fs.mkdirSync(args.at(-1)+'/.git',{recursive:true});return '';}
  if(['fetch','checkout','rebase','push'].includes(args[0]))return '';
  if(args[0]==='merge-base')return 'a'.repeat(40);
  if(args[0]==='rev-parse')return args[1]==='HEAD'?next:'c'.repeat(40);
  if(args[0]==='diff')return 'diff --git a/a b/a\\n+same patch\\n';
  if(args[0]==='patch-id'&&String(opts.input).includes('same patch'))return 'd'.repeat(40)+' '+next;
 }
 throw Error('unsupported command '+cmd+' '+args.join(' '));
};
https.request=(url,opts,callback)=>{
 const p=new URL(url).pathname; record('room',p); let result;
 if(p.endsWith('/merge-queue/status'))result={active:{pr:9000,headSha:head,claimId:'bound-claim',adoptedBy:null}};
 else if(p.endsWith('/work-claims/bound-claim'))result={id:'bound-claim',owner:'lane',state:'in_progress',reviews:[]};
 else if(['/merge-queue/adopt','/merge-queue/heartbeat','/merge-queue/release','/commands'].some(s=>p.endsWith(s)))result={ok:true};
 else throw Error('unsupported room route '+p);
 const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',JSON.stringify(result));response.emit('end');});
 request.destroy=()=>{throw Error('unexpected request timeout');}; return request;
};
syncBuiltinESMExports(); const originalTimer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===60000?1:ms,...args);
`);
  for (const scenario of ["ok", "race"]) {
    let exit = 0;
    try {
      runSync(process.execPath, [worker, "tick", "--live", "--authorized-head", HEAD], {
        encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${fixture}`,
          ROOM_IDENTITY_SECRET: "synthetic-room-secret", QUEUE_TEST_ROOT: dir,
          QUEUE_TEST_HEAD: HEAD, QUEUE_TEST_CASE: scenario },
      });
    } catch (error) { exit = error.status; }
    const calls = readFileSync(joinPath(dir, `${scenario}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(exit, scenario === "ok" ? 0 : 1);
    assert.equal(calls.filter(c => c.kind === "gh" && c.value[1]?.endsWith("check-runs?per_page=100")).length, 2, "pending CI must wait");
    const release = calls.some(c => c.kind === "room" && c.value.endsWith("/merge-queue/release"));
    assert.equal(release, scenario === "ok", "a head race must not be called a successful merge or release");
    assert.equal(calls.filter(c => c.kind === "gh" && c.value[1] === "merge").length, 1);
  }
});

test("patch-id after the worker's rebase: same patch passes, a dropped or changed hunk refuses", t => {
  const dir = mkTemp(joinPath(tmpDir(), "mq-pid-"));
  t.after(() => rmTemp(dir, { recursive: true, force: true }));
  const g = (args, input) => runSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", input }).trim();
  g(["init", "-q", "-b", "main"]);
  writeTemp(joinPath(dir, "a.txt"), "1\n2\n3\n"); writeTemp(joinPath(dir, "b.txt"), "x\n"); g(["add", "."]); g(["commit", "-qm", "base"]);
  const oldBase = g(["rev-parse", "HEAD"]);
  g(["checkout", "-qb", "pr"]); writeTemp(joinPath(dir, "a.txt"), "1\nTWO\n3\n"); writeTemp(joinPath(dir, "c.txt"), "new\n"); g(["add", "."]); g(["commit", "-qm", "pr"]);
  const oldHead = g(["rev-parse", "HEAD"]);
  g(["checkout", "-q", "main"]); writeTemp(joinPath(dir, "b.txt"), "y\n"); g(["commit", "-qam", "main moves"]);
  g(["checkout", "-qb", "clean", oldHead]); g(["rebase", "-q", "main"]);
  assert.equal(patchUnchanged(g, { oldBase, oldHead, newBase: "main", newHead: g(["rev-parse", "HEAD"]) }).ok, true, "a clean rebase keeps the patch");
  g(["checkout", "-q", "main"]); writeTemp(joinPath(dir, "c.txt"), "new\n"); g(["add", "."]); g(["commit", "-qm", "main already has c.txt"]);
  g(["checkout", "-qb", "dropped", oldHead]); g(["rebase", "-q", "main"]);
  const dropped = patchUnchanged(g, { oldBase, oldHead, newBase: "main", newHead: g(["rev-parse", "HEAD"]) });
  assert.equal(dropped.ok, false, "main already carrying part of the patch changes what would merge");
  assert.notEqual(dropped.before, dropped.after);
  assert.equal(patchUnchanged(g, { oldBase, oldHead: oldBase, newBase: "main", newHead: "main" }).ok, false, "an empty patch never passes");
});
