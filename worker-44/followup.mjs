// worker-44 follow-up: candidate happy-path/replay/transition, dup-key retest, 429 soak.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const HEX64 = "a".repeat(64);
const store = new RoomStore(":memory:");
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

async function enroll(name) {
  const identity = store.identities.create(name);
  const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, memberId, displayName: name, permissions: ["accept_work", "complete_work"] });
  return { memberId, key: store.issueAccessKey("commons", memberId) };
}
const candidate = await enroll("Cand44");
const agent = await enroll("Fuzz Worker 44 Ag");
const now = Date.now();
store.db.prepare("INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("loopC", "commons", "trialC", null, "fuzzworker44ag", "open", 0, 3, "[]", now, now);
store.db.prepare("INSERT INTO room_trial_tasks VALUES (?,?,?)")
  .run("commons", "trialC", JSON.stringify({ id: "trialC", state: "submitted", buyerId: "fuzzworker44ag", candidateId: "cand44" }));

async function call(method, path, token, body, rawCT) {
  const r = await fetch(`${origin}${path}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${token}`, ...(rawCT ?? { "content-type": "application/json" }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 160) };
}
const S = `/api/rooms/commons/signoff-loops/loopC/submit`;
const mk = (requestId, over = {}) => ({ requestId, deliverableRef: "ref-1", sha256: HEX64, summary: "ok", candidateId: "cand44", ...over });

let r = await call("PUT", "/api/rooms/commons/members/me/wants-work", agent.key, '{"labels":["a"],"labels":["b"]}');
console.log("dup-key retest:", r.status, r.body);
r = await call("POST", S, candidate.key, mk("rep-1"));
console.log("submit-1:", r.status, r.body.slice(0, 60));
r = await call("POST", S, candidate.key, mk("rep-1"));
console.log("replay-same:", r.status, "(expect 200 idempotent)");
r = await call("POST", S, candidate.key, mk("rep-1", { summary: "changed" }));
console.log("replay-diff:", r.status, "(expect 409 request_id_reused)");
r = await call("POST", S, candidate.key, mk("rep-2"));
console.log("submit-again:", r.status, "(expect 422 invalid_signoff_status — loop now submitted)");
// buyer review -> changes_requested -> candidate resubmits round 2
r = await call("POST", `/api/rooms/commons/signoff-loops/loopC/review`, agent.key, { requestId: "rev-1", decision: "request_changes", note: "fix it" });
console.log("review-changes:", r.status, "(buyer is fuzzworker44ag)");
r = await call("POST", S, candidate.key, mk("rep-3"));
console.log("resubmit-round2:", r.status, "(expect 200)");
// 429 soak: single agent, 75 rapid writes on wants-work
const sts = {};
for (let i = 0; i < 75; i++) {
  const x = await call("PUT", "/api/rooms/commons/members/me/wants-work", agent.key, { labels: ["soak"] });
  sts[x.status] = (sts[x.status] || 0) + 1;
  if (x.status === 500) console.log("SOAK 500!", x.body);
}
console.log("soak statuses:", JSON.stringify(sts));

server.closeStreams(); server.closeAllConnections();
await new Promise(r2 => server.close(r2));
store.close();
