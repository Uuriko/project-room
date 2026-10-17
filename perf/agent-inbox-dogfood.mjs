// Agent-inbox v1 dogfood measurement. Disposable local harness, never prod.
// Usage: node perf/agent-inbox-dogfood.mjs
//
// One realistic agent turn, measured both ways against the same seeded room:
//   REREAD  — what an agent without the inbox pays to find "what needs me,
//             what is mine, what is broken": the room snapshot
//             (GET /api/rooms/:id?messages=recent) plus the full Board
//             (GET /api/rooms/:id/work-claims).
//   INBOX   — GET /api/needs-me, first poll and steady-state poll (the
//             previous response's cursor passed back as `since`).
// The room is shaped like the audit's muse-room sample, scaled down:
// 300 narration-heavy messages (~700 chars), 14 members, 88 Board claims
// in mixed states. Reports wire bytes and round-trip ms (median of 7,
// after 2 warmups) on loopback; token counts are bytes/4 estimates.
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createWork, claimWork, updateWork, recordReview, recordCi } from "../server/work-claims.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const WRITER = ["steer", "accept_work", "complete_work", "verify"];
const store = new RoomStore(":memory:");
const rooms = new AgentRooms(store);
const owner = store.identities.create("Owen");
const ada = store.identities.create("Ada");
const peers = ["Bob", "Cyd", "Dee", "Eli", "Fay", "Gil", "Hal", "Ivy", "Jay", "Kim", "Lou", "Mel"].map(name => store.identities.create(name));
rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "dogfood", kind: "personal" });
for (const [identity, name] of [[ada, "Ada"], ...peers.map((p, i) => [p, ["Bob", "Cyd", "Dee", "Eli", "Fay", "Gil", "Hal", "Ivy", "Jay", "Kim", "Lou", "Mel"][i]])]) {
  store.identities.link(owner.secret, "board", { identityId: identity.identityId, displayName: name, permissions: WRITER });
  setTier(store.db, "board", identity.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
}
const memberOf = identity => store.db.prepare("SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?")
  .get(identity.identityId, "board").m;
const adaId = memberOf(ada);
const bobId = memberOf(peers[0]);

const NARRATION = "Verified drop sha256 9f2c…e41a against base 0b2d3ac09: gate green (verify:affected 753 tests, lint clean), patch applies clean, digest chain matches the receipt posted above. Landing slot held for the coordinator; verdict: approve, no findings. Readback of the deployed revision matches the claim's recorded head; the two remaining checks are the browser shards, still running when this was posted, expected green. ";
for (let i = 0; i < 300; i++) {
  const poster = peers[i % peers.length];
  const mention = i % 60 === 0 ? "@Ada " : "";
  store.command(poster.secret, "board", {
    id: `msg-${i}`, type: "message.posted",
    data: { messageId: `msg-${i}`, body: `${mention}${NARRATION} (note ${i})` }
  });
}

// Claims are seeded near the real clock: the Board read sweeps expired
// leases back to unclaimed, and leases stamped days in the past would be
// released mid-measurement (the first version of this harness did exactly
// that and measured a board the sweep had already emptied).
const t0 = Date.now() - 30 * 60000;
const put = (id, minutes = 0, extra = {}) => {
  const item = { ...createWork({ id, title: `Task ${id}`, ...extra }, { now: t0 + minutes * 60000, agentId: owner.identityId }) };
  store.workClaims.set("board", item);
  return item;
};
for (let i = 0; i < 40; i++) put(`open-${i}`, i);
for (let i = 0; i < 30; i++) {
  const holder = memberOf(peers[i % peers.length]);
  let item = claimWork(put(`peer-${i}`, i), holder, { now: t0 + i * 60000 });
  if (i % 2 === 0) item = updateWork(item, holder, { state: "in_progress", now: t0 + i * 60000 });
  store.workClaims.set("board", item);
}
for (let i = 0; i < 12; i++) {
  let item = claimWork(put(`review-${i}`, i, { tags: [`rev-${adaId}`] }), bobId, { now: t0 + i * 60000 });
  item = updateWork(item, bobId, { state: "in_progress", now: t0 + i * 60000 });
  item = recordCi(item, { state: "success", headSha: "a".repeat(40) }, t0 + i * 60000).item;
  store.workClaims.set("board", item);
}
let mine = claimWork(put("mine-progress", 1), adaId, { now: t0 });
mine = updateWork(mine, adaId, { state: "in_progress", now: t0 });
store.workClaims.set("board", mine);
let red = claimWork(put("mine-red", 2), adaId, { now: t0 });
red = updateWork(red, adaId, { state: "in_progress", now: t0 });
red = recordCi(red, { state: "failure", headSha: "b".repeat(40), url: "https://ci.example/run/1" }, t0).item;
store.workClaims.set("board", red);
let revise = claimWork(put("mine-revise", 3), adaId, { now: t0 });
revise = updateWork(revise, adaId, { state: "in_progress", now: t0 });
revise = recordReview(revise, bobId, { verdict: "changes_requested", summary: "Please add the missing test", now: t0 });
store.workClaims.set("board", revise);
store.workClaims.set("board", claimWork(put("mine-claimed", 4), adaId, { now: t0 }));
let blocked = claimWork(put("mine-blocked", 5), adaId, { now: t0 });
blocked = updateWork(blocked, adaId, { state: "in_progress", now: t0 });
blocked = updateWork(blocked, adaId, { state: "blocked", now: t0 });
store.workClaims.set("board", blocked);
const shipped = claimWork(put("mine-shipped", 6), adaId, { now: t0 });
store.workClaims.set("board", { ...updateWork(shipped, adaId, { state: "in_progress", now: t0 }), state: "delivered" });

const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { authorization: `Bearer ${ada.secret}` };

async function timed(path) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`);
  return { bytes: Buffer.byteLength(text), ms, text };
}
async function median(path, runs = 7) {
  await timed(path); await timed(path);
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await timed(path));
  samples.sort((a, b) => a.ms - b.ms);
  return samples[Math.floor(runs / 2)];
}

const snapshot = await median("/api/rooms/board?messages=recent");
const board = await median("/api/rooms/board/work-claims");
const inboxFirst = await median("/api/needs-me");
const cursor = JSON.parse(inboxFirst.text).cursor;
const inboxPoll = await median(`/api/needs-me?since=${encodeURIComponent(JSON.stringify(cursor))}`);

const rereadBytes = snapshot.bytes + board.bytes;
const rereadMs = snapshot.ms + board.ms;
const report = (label, bytes, ms) =>
  console.log(`${label.padEnd(28)} ${String(bytes).padStart(8)} bytes  ~${String(Math.round(bytes / 4)).padStart(6)} tokens  ${ms.toFixed(1)} ms`);
console.log("Seeded room: 300 messages, 14 members, 88 claims (Ada owns 6 open, 1 CI failure, 1 changes-requested; 12 deliveries name Ada as reviewer; 5 mentions)");
report("REREAD snapshot", snapshot.bytes, snapshot.ms);
report("REREAD board", board.bytes, board.ms);
report("REREAD total", rereadBytes, rereadMs);
report("INBOX first poll", inboxFirst.bytes, inboxFirst.ms);
report("INBOX steady-state poll", inboxPoll.bytes, inboxPoll.ms);
console.log(`\nSteady-state saving vs reread: ${(rereadBytes / inboxPoll.bytes).toFixed(1)}x fewer bytes, ${(rereadMs / inboxPoll.ms).toFixed(1)}x faster`);
console.log(`First-poll saving vs reread: ${(rereadBytes / inboxFirst.bytes).toFixed(1)}x fewer bytes`);
if (process.env.DOGFOOD_DEBUG) {
  const poll = JSON.parse(inboxPoll.text);
  console.log("\nSteady-state sections:", Object.keys(poll).join(", "));
  console.log("myClaims:", JSON.stringify(poll.myClaims));
  console.log("actionsNeeded:", JSON.stringify(poll.actionsNeeded));
  console.log("reviewAsks count:", poll.reviewAsks?.[0]?.count, "| openWork count:", poll.openWork?.[0]?.count);
}
server.close();
store.close();
