// worker-44 sanity: valid requests for both shard routes.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

process.env.TMPDIR = "/home/hatch/workspace/pr-wave2000-guild-02/.tmp";
const store = new RoomStore(":memory:");
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

async function enroll(name) {
  const identity = store.identities.create(name);
  const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId, displayName: name,
    permissions: ["accept_work", "complete_work"]
  });
  const key = store.issueAccessKey("commons", memberId);
  return { memberId, key };
}
const agent = await enroll("Fuzz Agent 44");

async function call(method, path, token, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method, redirect: "manual",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 200) };
}

// seed a signoff loop row directly
const now = Date.now();
store.db.exec("CREATE TABLE IF NOT EXISTS buyer_signoff_loops (loop_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, trial_task_id TEXT NOT NULL, contract_id TEXT, buyer_id TEXT NOT NULL, status TEXT NOT NULL, round INTEGER NOT NULL, max_rounds INTEGER NOT NULL, rounds_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
store.db.prepare("INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("fuzzloop1", "commons", "trial-1", null, agent.memberId, "open", 0, 3, "[]", now, now);
store.db.exec("CREATE TABLE IF NOT EXISTS room_trial_tasks(room_id TEXT NOT NULL,task_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room_id,task_id))");
store.db.prepare("INSERT INTO room_trial_tasks VALUES (?,?,?)")
  .run("commons", "trial-1", JSON.stringify({ id: "trial-1", state: "submitted", buyerId: agent.memberId, candidateId: "cand44" }));

let r = await call("PUT", "/api/rooms/commons/members/me/wants-work", agent.key, { labels: ["docs"] });
console.log("wants-work valid PUT:", r.status, r.body);
r = await call("GET", "/api/rooms/commons/members/me/wants-work", agent.key);
console.log("wants-work valid GET:", r.status, r.body);

const good = { requestId: "req-sane-44", deliverableRef: "ref-1", sha256: "a".repeat(64), summary: "ok" };
r = await call("POST", "/api/rooms/commons/signoff-loops/fuzzloop1/submit", ownerKey, good);
console.log("signoff submit valid:", r.status, r.body);

server.closeStreams(); server.closeAllConnections();
await new Promise(r2 => server.close(r2));
store.close();
