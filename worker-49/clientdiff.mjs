// Why did node:http GET get 400-empty while raw socket GET gets 405?
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

const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-cd-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom("commons"));
store.issueAccessKey("commons", "owner");
const secret = "clientdiff-secret-0123456789abcdef";
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
const origin = `http://127.0.0.1:${port}`;
const wp = `/api/inbox/webhooks/${cid}`;
const json = JSON.stringify({ updates: [{ update_id: 5555 }] });

// log what the client actually puts on the wire via a capturing proxy is overkill;
// instead dump what node:http sends using a local echo: send through http.request
// and print req.getHeaders() + whether chunked.
for (const method of ["GET", "PUT"]) {
  const { status, headers, text } = await new Promise(resolve => {
    const req = httpRequest(origin + wp, { method, headers: {
      Origin: origin, "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret,
    } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    console.log(method, "client send headers:", JSON.stringify(req.getHeaders()));
    req.write(json);
    req.end();
  });
  console.log(method, "->", status, "resp-headers:", JSON.stringify(headers), "body:", JSON.stringify(text.slice(0, 120)));
}
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close(); rmSync(directory, { recursive: true, force: true });
