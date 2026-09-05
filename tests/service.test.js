import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-test-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const [id, kind] of [["human", "human"], ["agent", "agent"]]) store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind, permissions: ["accept_work", "complete_work", "verify"] }));
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename, owner, human, agent };
}
async function http(t) {
  const f = fixture(t);
  const server = createRoomServer({ store: f.store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const request = (path, { token = f.owner, method = "GET", data, headers = {} } = {}) => fetch(`${origin}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { ...f, server, origin, request };
}

test("two separately authenticated members share durable, server-attributed conversation", t => {
  const { store, human, agent, filename } = fixture(t);
  const result = store.command(human, "commons", command(T.MESSAGE_POSTED, { body: "Hello together", toMemberId: "agent" }));
  assert.equal(result.event.actorId, "human");
  assert.equal(store.snapshot(agent, "commons").state.messages.at(-1).body, "Hello together");
  const reopened = new RoomStore(filename);
  try { assert.equal(reopened.snapshot(agent, "commons").sequence, result.sequence); }
  finally { reopened.close(); }
  assert.equal(Object.keys(store.snapshot(human, "commons").state.workItems).length, 0);
});

test("identical retries persist once; changed retries and invalid events roll back", t => {
  const { store, human } = fixture(t);
  const c = command(T.MESSAGE_POSTED, { body: "One durable message" });
  const first = store.command(human, "commons", c);
  const second = store.command(human, "commons", c);
  assert.equal(first.event.id, second.event.id);
  assert.equal(second.duplicate, true);
  const before = store.snapshot(human, "commons");
  assert.throws(() => store.command(human, "commons", { ...c, data: { body: "different" } }), /different content/);
  assert.throws(() => store.command(human, "commons", command(T.MESSAGE_POSTED, { body: " " })), /Invalid body/);
  assert.deepEqual(store.snapshot(human, "commons"), before);
});

test("work concurrency admits one revision winner across two database connections", t => {
  const { store, owner, human, filename } = fixture(t);
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "w1", title: "Review a draft", definitionOfDone: "Source-linked finding", accountableMemberId: "human" }));
  const other = new RoomStore(filename);
  try {
    store.command(human, "commons", command(T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 }));
    assert.throws(() => other.command(human, "commons", command(T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 })), /Invalid transition|Stale/);
    assert.equal(other.snapshot(human, "commons").state.workItems.w1.revision, 1);
  } finally { other.close(); }
});

test("server identity, room boundaries, command schema and causal references are enforced", t => {
  const { store, owner, human } = fixture(t);
  store.initialize(initialRoom("separate", "other-owner"));
  assert.throws(() => store.snapshot(human, "separate"), /does not grant access/);
  assert.throws(() => store.eventsAfter(human, "separate", 0), /does not grant access/);
  assert.throws(() => store.command(human, "commons", { ...command(T.MESSAGE_POSTED, { body: "hello" }), actorId: "owner" }), /Supply only/);
  assert.throws(() => store.command(human, "commons", command(T.MESSAGE_POSTED, { body: 7 })), /Invalid field/);
  assert.throws(() => store.command(human, "commons", { ...command(T.MESSAGE_POSTED, { body: "hello" }), causationId: "missing" }), /Causation event/);
  assert.throws(() => store.command(human, "commons", command(T.MEMBER_ADDED, { memberId: "extra", displayName: "Extra", kind: "human", permissions: [] })), /lacks manage_members/);
  assert.throws(() => store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "extra", displayName: "Extra", kind: "agent", permissions: ["manage_members"] })), /Human administration/);
});

test("revocation denies reads, writes, and duplicate retries; re-enable does not resurrect keys", t => {
  const { store, owner, agent } = fixture(t);
  const c = command(T.MESSAGE_POSTED, { body: "before removal" });
  store.command(agent, "commons", c);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, { memberId: "agent", expectedMemberRevision: 0, permissions: [], active: false }));
  for (const read of [() => store.snapshot(agent, "commons"), () => store.command(agent, "commons", c), () => store.eventsAfter(agent, "commons")]) assert.throws(read, /revoked/);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, { memberId: "agent", expectedMemberRevision: 1, permissions: [], active: true }));
  assert.throws(() => store.authenticate(agent), /revoked/);
});

test("key rotation invalidates child sessions and stores only hashed credentials", t => {
  const { store, human } = fixture(t);
  const { token } = store.createSession(human);
  assert.equal(store.authenticate(token).member.id, "human");
  const rows = store.db.prepare("SELECT hash FROM credentials").all();
  assert.ok(rows.every(r => /^[a-f0-9]{64}$/.test(r.hash)));
  store.issueAccessKey("commons", "human");
  assert.throws(() => store.authenticate(token), /revoked/);
  assert.throws(() => store.authenticate(human), /revoked/);
});

test("cursor reads paginate and caught-up positions are monotonic, not peer-read claims", t => {
  const { store, human, agent } = fixture(t);
  for (let i = 0; i < 3; i++) store.command(human, "commons", command(T.MESSAGE_POSTED, { body: `Message ${i}` }));
  const first = store.eventsAfter(agent, "commons", 0, 2);
  assert.equal(first.events.length, 2); assert.equal(first.hasMore, true);
  const next = store.eventsAfter(agent, "commons", first.next, 2);
  assert.equal(next.events[0].sequence, 3);
  assert.equal(store.markCaughtUp(human, "commons", 5).cursor, 5);
  assert.equal(store.markCaughtUp(human, "commons", 2).cursor, 5);
  assert.equal(store.snapshot(agent, "commons").cursor, 0);
  assert.throws(() => store.markCaughtUp(human, "commons", 9999), /Invalid caught-up/);
  assert.throws(() => store.eventsAfter(agent, "commons", -1), /Invalid event cursor/);
});

test("HTTP session exchange protects cookie writes, rejects agent browser sessions, and logs out", async t => {
  const { request, human, agent, origin } = await http(t);
  assert.equal((await request("/api/session", { token: null, method: "POST", data: { accessKey: human } })).status, 403);
  const login = await request("/api/session", { token: null, method: "POST", headers: { Origin: origin }, data: { accessKey: human } });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const session = await login.json();
  const headers = { Cookie: cookie.split(";")[0], Origin: origin };
  const data = command(T.MESSAGE_POSTED, { body: "From browser session" });
  assert.equal((await request("/api/rooms/commons/commands", { token: null, method: "POST", data, headers })).status, 403);
  headers["X-CSRF-Token"] = session.csrf;
  assert.equal((await request("/api/rooms/commons/commands", { token: null, method: "POST", data, headers })).status, 201);
  assert.equal((await request("/api/session", { token: null, method: "POST", headers: { Origin: origin }, data: { accessKey: agent } })).status, 403);
  assert.equal((await request("/api/session", { token: null, method: "DELETE", headers })).status, 200);
  assert.equal((await request("/api/session", { token: null, headers })).status, 401);
});

test("HTTP endpoints deny anonymous and oversized commands and expose only explicit assets", async t => {
  const { request } = await http(t);
  assert.equal((await request("/api/rooms/commons", { token: null })).status, 401);
  assert.equal((await request("/api/rooms/commons/commands", { method: "POST", data: command(T.MESSAGE_POSTED, { body: "x".repeat(17000) }) })).status, 413);
  for (const path of ["/server.mjs", "/server/store.mjs", "/.data/room.sqlite", "/src/seed.js", "/src/storage.js", "/package.json"]) assert.equal((await request(path, { token: null })).status, 404);
  const page = await request("/", { token: null });
  assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("SSE resumes durable events by Last-Event-ID and terminates when access is revoked", async t => {
  const { store, request, owner, agent } = await http(t);
  const before = store.snapshot(agent, "commons").sequence;
  const c = store.command(owner, "commons", command(T.MESSAGE_POSTED, { body: "Reconnect catch-up" }));
  const response = await request("/api/rooms/commons/stream?after=0", { token: agent, headers: { "Last-Event-ID": String(before) } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /Reconnect catch-up/); assert.match(first, new RegExp(`id: ${c.sequence}`));
  assert.doesNotMatch(first, /room.created/);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, { memberId: "agent", expectedMemberRevision: 0, permissions: [], active: false }));
  let rest = "";
  for (;;) { const part = await reader.read(); if (part.done) break; rest += decoder.decode(part.value); }
  assert.match(rest, /access-ended/); assert.doesNotMatch(rest, /member.access_changed/);
});

test("expiry applies to established sessions and no token is included in public snapshots", t => {
  const { store, human } = fixture(t);
  const session = store.createSession(human);
  assert.equal(JSON.stringify(store.snapshot(session.token, "commons")).includes(session.token), false);
  store.now = () => Date.now() + 9 * 3600000;
  assert.throws(() => store.authenticate(session.token), /expired/);
});

test("committed room state survives an actual process exit and new-process reopen", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-process-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { ...process.env, TEST_ROOM_DB: join(directory, "room.sqlite") };
  const imports = `import { RoomStore } from ${JSON.stringify(new URL("../server/store.mjs", import.meta.url).href)}; import { initialRoom } from ${JSON.stringify(new URL("../server/bootstrap.mjs", import.meta.url).href)};`;
  const first = spawnSync(process.execPath, ["--input-type=module", "-e", imports + `const s = new RoomStore(process.env.TEST_ROOM_DB); s.initialize(initialRoom()); const key = s.issueAccessKey("commons", "owner"); s.command(key, "commons", {id:"durable",type:"message.posted",data:{body:"Survives process exit"}}); process.exit(0);`], { env: environment, encoding: "utf8" });
  assert.equal(first.status, 0);
  const second = spawnSync(process.execPath, ["--input-type=module", "-e", imports + `const s = new RoomStore(process.env.TEST_ROOM_DB); const key = s.issueAccessKey("commons", "owner"); const result = s.snapshot(key,"commons"); process.stdout.write(JSON.stringify({sequence:result.sequence,body:result.state.messages.at(-1).body})); s.close();`], { env: environment, encoding: "utf8" });
  assert.equal(second.status, 0);
  assert.deepEqual(JSON.parse(second.stdout), { sequence: 3, body: "Survives process exit" });
});

test("simultaneous HTTP work requests admit one winner without a partial audit event", async t => {
  const { store, owner, human, request } = await http(t);
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "race", title: "Shared work", definitionOfDone: "One accepted version", accountableMemberId: "human" }));
  const before = store.snapshot(owner, "commons").sequence;
  const requests = await Promise.all([1, 2].map(() => request("/api/rooms/commons/commands", { token: human, method: "POST", data: command(T.WORK_ACCEPTED, { workItemId: "race", expectedRevision: 0 }) })));
  assert.deepEqual(requests.map(r => r.status).sort(), [201, 409]);
  assert.equal(store.snapshot(owner, "commons").sequence, before + 1);
});

test("new work mutations recheck capability changes and preserve the original work record", t => {
  const { store, owner, human } = fixture(t);
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "grant", title: "Permission-bound work", definitionOfDone: "A current grant is needed", accountableMemberId: "human" }));
  store.command(human, "commons", command(T.WORK_ACCEPTED, { workItemId: "grant", expectedRevision: 0 }));
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, { memberId: "human", expectedMemberRevision: 0, permissions: [], active: true }));
  const before = store.snapshot(owner, "commons");
  assert.throws(() => store.command(human, "commons", command(T.WORK_STARTED, { workItemId: "grant", expectedRevision: 1 })), /lacks accept_work/);
  assert.deepEqual(store.snapshot(owner, "commons"), before);
});

test("HTTP rate limits report backoff without creating extra room events", async t => {
  const { request, store, owner } = await http(t);
  const c = command(T.MESSAGE_POSTED, { body: "Idempotent request" });
  for (let i = 0; i < 60; i++) assert.ok([200, 201].includes((await request("/api/rooms/commons/commands", { method: "POST", data: c })).status));
  const result = await request("/api/rooms/commons/commands", { method: "POST", data: c });
  assert.equal(result.status, 429); assert.equal(result.headers.get("retry-after"), "60");
  assert.equal(store.snapshot(owner, "commons").state.messages.length, 1);
});
