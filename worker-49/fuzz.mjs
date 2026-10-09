// WORKER 49 — API fuzzing harness (in-process).
// Shard 49/50: index%50==48 of sorted route table =
//   48: POST /api/inbox/webhooks/{connectionId} (inbox.webhook)
//   98: POST /api/rooms/{roomId}/squads/{squadId}/disband (squad-disband)
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const results = [];
const log = (name, actual, expected, note = "") => {
  const pass = expected === "observe" ? null : actual === expected;
  results.push({ name, actual, expected, pass, note });
  console.log(`${pass === null ? "OBS " : pass ? "PASS" : "FAIL"} ${name} -> ${actual}${expected === "observe" ? "" : ` (want ${expected})`}${note ? " | " + note : ""}`);
};

const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-fuzz-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
cmd(ownerKey, T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] });
cmd(ownerKey, T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
const guestKey = store.issueAccessKey("commons", "guest");
const helperKey = store.issueAccessKey("commons", "helper");

// webhook connection wiring (mirrors tests/channel-drain.test.js)
const secret = "fixture-webhook-secret-0123456789";
const account = store.accountForMember("commons", "owner");
const akey = store.issueAccountAccessKey(account.id);
const slot = store.createAccountSessionSlot();
const asess = store.loginAccountSession(slot.token, akey, 0);
const tg = telegramContractFixture();
tg.connection.accountId = account.id;
const apply = r => store.connections.apply(slot.token, r, asess.sessionBinding);
apply({ action: "connection.configure", requestId: randomUUID(), connectionId: tg.connection.id, expectedRevision: 0, profile: structuredClone(tg.connection) });
apply({ action: "connection.webhook", requestId: "hook", connectionId: tg.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });
const connectionId = tg.connection.id;

const webhooks = new ChannelWebhookInbox(store);
const server = createRoomServer({ store, channelWebhooks: webhooks });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

function raw({ method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = { Origin: origin, Connection: "close", ...headers };
    if (data !== null && !("Content-Length" in h) && !("content-length" in h) && !("Transfer-Encoding" in h)) h["Content-Length"] = Buffer.byteLength(data);
    const req = httpRequest(origin + path, { method, headers: h }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("HANG: no response within 5s")); });
    if (data !== null) req.write(data);
    req.end();
  });
}
const jsonHeaders = (extra = {}) => ({ "Content-Type": "application/json", ...extra });
const secretH = (s = secret) => ({ "x-telegram-bot-api-secret-token": s });
const bearer = k => k ? { Authorization: `Bearer ${k}` } : {};
const upd = id => ({ update_id: id, message: { message_id: id, date: 1788948000 + id, chat: tg.chat, from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text: "hi " + id } });

async function safe(name, expected, fn, note = "") {
  try { const r = await fn(); log(name, r.status, expected, note + (r.text ? " body=" + r.text.slice(0, 160) : "")); return r; }
  catch (e) { log(name, "ERROR:" + e.message, expected, "transport failure"); return null; }
}

// ---------------- webhook route ----------------
const wp = `/api/inbox/webhooks/${connectionId}`;
await safe("WH valid POST", 202, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: [upd(9001)] } }));
await safe("WH no secret", 401, () => raw({ method: "POST", path: wp, headers: jsonHeaders(), body: { updates: [upd(9002)] } }));
await safe("WH wrong secret (well-formed)", 401, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH("a".repeat(16) + "bcdef0123456789")), body: { updates: [upd(9003)] } }));
await safe("WH weak short secret", 401, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH("short")), body: { updates: [upd(9004)] } }));
await safe("WH wrong content-type", 415, () => raw({ method: "POST", path: wp, headers: { ...secretH(), "Content-Type": "text/plain" }, body: "hello" }));
await safe("WH invalid JSON", 400, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: "{not json" }));
await safe("WH empty body", 400, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: "" }));
await safe("WH array body", 400, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: "[]" }));
await safe("WH {} body", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: {} }));
await safe("WH empty updates", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: [] } }));
await safe("WH negative update_id", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: [upd(-1)] } }));
await safe("WH float update_id", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: [{ update_id: 1.5 }] } }));
await safe("WH 101 updates", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: Array.from({ length: 101 }, (_, i) => upd(9100 + i)) } }));
await safe("WH oversize body", 413, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: "x".repeat(70000) }));
await safe("WH extra top-level key", 422, () => raw({ method: "POST", path: wp, headers: jsonHeaders(secretH()), body: { updates: [upd(9201)], extra: 1 } }));
await safe("WH unknown connectionId", 401, () => raw({ method: "POST", path: "/api/inbox/webhooks/conn_nope", headers: jsonHeaders(secretH()), body: { updates: [upd(9202)] } }));
await safe("WH traversal connectionId", 404, () => raw({ method: "POST", path: "/api/inbox/webhooks/%2e%2e%2f%2e%2e", headers: jsonHeaders(secretH()), body: { updates: [upd(9203)] } }), "WHATWG URL normalizes encoded dot-segments -> /api/ -> 404; no escape");
await safe("WH overlong connectionId", "observe", () => raw({ method: "POST", path: "/api/inbox/webhooks/" + "c".repeat(400), headers: jsonHeaders(secretH()), body: { updates: [upd(9204)] } }), "pattern limit is 384 chars");
await safe("WH no connectionId", "observe", () => raw({ method: "POST", path: "/api/inbox/webhooks", headers: jsonHeaders(secretH()), body: { updates: [upd(9205)] } }));
await safe("WH subpath extra", "observe", () => raw({ method: "POST", path: wp + "/extra", headers: jsonHeaders(secretH()), body: { updates: [upd(9206)] } }));
// method confusion: row says POST only; mounts hand every method to the handler
for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
  await safe(`WH ${m} with valid secret+body`, 405, () => raw({ method: m, path: wp, headers: jsonHeaders(secretH()), body: { updates: [upd(9300)] } }), "row is POST-only; handler has no method check");
}
await safe("WH GET no secret", 405, () => raw({ method: "GET", path: wp, headers: jsonHeaders(), body: { updates: [upd(9301)] } }), "method check precedes secret check");

// ---------------- disband route ----------------
const m1 = cmd(ownerKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "thread root" }).event.data.messageId;
async function createSquad(token, name, memberIds = ["guest"]) {
  const r = await raw({ method: "POST", path: "/api/rooms/commons/squads", headers: { ...jsonHeaders(), ...bearer(token) }, body: { name, goal: "fuzz", channelMessageId: m1, memberIds } });
  return { status: r.status, squad: JSON.parse(r.text).squad };
}
const sq = (await createSquad(ownerKey, "fuzzcrew")).squad;
const dp = id => `/api/rooms/commons/squads/${id}/disband`;
await safe("DIS no credential", 401, () => raw({ method: "POST", path: dp(sq.id), headers: jsonHeaders() }));
await safe("DIS guest non-owner", 403, () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(guestKey) } }));
await safe("DIS helper non-owner", 403, () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(helperKey) } }));
await safe("DIS unknown squad", 404, () => raw({ method: "POST", path: dp("sq_missing"), headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS unknown room", "observe", () => raw({ method: "POST", path: `/api/rooms/noroom/squads/${sq.id}/disband`, headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS bad auth mode", 422, () => raw({ method: "POST", path: dp(sq.id) + "?auth=bogus", headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS owner happy", 200, () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS double disband", 200, () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(ownerKey) } }), "idempotent -> changed:false");
const r405 = await safe("DIS GET wrong method", 405, () => raw({ method: "GET", path: dp(sq.id), headers: bearer(ownerKey) }));
if (r405) log("DIS GET Allow header", r405.headers.allow || "(none)", "POST", "dispatcher should advertise Allow");
for (const m of ["PUT", "DELETE", "PATCH"]) {
  await safe(`DIS ${m} wrong method`, 405, () => raw({ method: m, path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
}
await safe("DIS invalid JSON body", "observe", () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(ownerKey) }, body: "{oops" }), "handler never reads body");
await safe("DIS 1MB body", "observe", () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(ownerKey) }, body: "x".repeat(1024 * 1024) }), "handler never reads body");
await safe("DIS encoded ..", 404, () => raw({ method: "POST", path: "/api/rooms/commons/squads/%2e%2e/disband", headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS NUL byte", 404, () => raw({ method: "POST", path: "/api/rooms/commons/squads/sq_%00x/disband", headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS 1000-char squadId", 404, () => raw({ method: "POST", path: dp("sq_" + "x".repeat(1000)), headers: { ...jsonHeaders(), ...bearer(ownerKey) } }));
await safe("DIS trailing slash", "observe", () => raw({ method: "POST", path: dp(sq.id) + "/", headers: { ...jsonHeaders(), ...bearer(ownerKey) } }), "trie filters empty segments");
await safe("DIS disbanded by non-owner after disband", 403, () => raw({ method: "POST", path: dp(sq.id), headers: { ...jsonHeaders(), ...bearer(guestKey) } }), "owner check precedes disbanded check");

writeFileSync("worker-49/fuzz-results.json", JSON.stringify(results, null, 2));
const fails = results.filter(r => r.pass === false);
console.log(`\n${results.length} cases, ${fails.length} FAIL, ${results.filter(r => r.pass === null).length} OBS`);
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close(); rmSync(directory, { recursive: true, force: true });
process.exit(fails.length ? 2 : 0);
