// Raw-socket probe: which request shape triggers the empty-400 on the webhook route?
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";

const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-raw-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom("commons"));
store.issueAccessKey("commons", "owner");
const secret = "rawprobe-secret-0123456789abcdef";
const account = store.accountForMember("commons", "owner");
const akey = store.issueAccountAccessKey(account.id);
const slot = store.createAccountSessionSlot();
const asess = store.loginAccountSession(slot.token, akey, 0);
const tg = telegramContractFixture(); tg.connection.accountId = account.id;
const apply = r => store.connections.apply(slot.token, r, asess.sessionBinding);
apply({ action: "connection.configure", requestId: randomUUID(), connectionId: tg.connection.id, expectedRevision: 0, profile: structuredClone(tg.connection) });
apply({ action: "connection.webhook", requestId: "hook", connectionId: tg.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });
const cid = tg.connection.id;

const server = createRoomServer({ store, channelWebhooks: new ChannelWebhookInbox(store) });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function sendRaw(head, bodyChunks) {
  return new Promise(resolve => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(head);
      for (const c of bodyChunks) sock.write(c);
    });
    let data = "";
    const timer = setTimeout(() => { sock.destroy(); resolve("TIMEOUT-5s :: " + JSON.stringify(data.slice(0, 400))); }, 5000);
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); resolve(JSON.stringify(data.slice(0, 600))); });
    sock.on("error", e => { clearTimeout(timer); resolve("SOCKERR " + e.message); });
  });
}
const wp = `/api/inbox/webhooks/${cid}`;
const jsonBody = JSON.stringify({ updates: [{ update_id: 4242 }] });

function buildRequest(method, chunked) {
  const lines = [
    `${method} ${wp} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Origin: http://127.0.0.1:${port}`,
    `Content-Type: application/json`,
    `x-telegram-bot-api-secret-token: ${secret}`,
  ];
  let chunks;
  if (chunked) { lines.push("Transfer-Encoding: chunked"); chunks = [jsonBody.length.toString(16) + "\r\n", jsonBody + "\r\n", "0\r\n\r\n"]; }
  else { lines.push(`Content-Length: ${Buffer.byteLength(jsonBody)}`); chunks = [jsonBody]; }
  return { head: lines.join("\r\n") + "\r\n\r\n", chunks };
}

for (const [label, method, chunked] of [
  ["GET content-length", "GET", false],
  ["GET chunked", "GET", true],
  ["DELETE chunked", "DELETE", true],
  ["DELETE content-length", "DELETE", false],
  ["OPTIONS chunked", "OPTIONS", true],
  ["OPTIONS content-length", "OPTIONS", false],
  ["PUT chunked", "PUT", true],
  ["HEAD chunked", "HEAD", true],
]) {
  const { head, chunks } = buildRequest(method, chunked);
  console.log("== " + label + " ==");
  console.log(await sendRaw(head, chunks));
}
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close(); rmSync(directory, { recursive: true, force: true });
