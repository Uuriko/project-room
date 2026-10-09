// Focused repro probes for worker-49 anomalies.
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-probe-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
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

const server = createRoomServer({ store, channelWebhooks: new ChannelWebhookInbox(store) });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

function raw({ method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const req = httpRequest(origin + path, { method, headers: { Origin: origin, ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, allow: res.headers.allow, text: Buffer.concat(chunks).toString().slice(0, 300) }));
      res.on("error", reject);
    });
    req.on("error", e => resolve({ status: "TRANSPORT-ERR: " + e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: "HANG-5s" }); });
    if (data !== null) req.write(data);
    req.end();
  });
}
const upd = id => ({ update_id: id, message: { message_id: id, date: 1788948000 + id, chat: tg.chat, from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text: "hi " + id } });
const wp = `/api/inbox/webhooks/${connectionId}`;
const H = s => ({ "Content-Type": "application/json", "x-telegram-bot-api-secret-token": s ?? secret });

console.log("--- method matrix with valid secret + valid body ---");
for (const m of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
  const r = await raw({ method: m, path: wp, headers: H(), body: { updates: [upd(7001)] } });
  console.log(m, "->", r.status, "| allow:", r.allow, "|", r.text);
}
console.log("--- extra top-level key, 3 attempts ---");
for (let i = 0; i < 3; i++) {
  const r = await raw({ method: "POST", path: wp, headers: H(), body: { updates: [upd(7100 + i)], extra: 1 } });
  console.log("attempt", i, "->", r.status, "|", r.text);
}
console.log("--- server alive check ---");
console.log(await raw({ method: "GET", path: "/api/health" }));
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close(); rmSync(directory, { recursive: true, force: true });
