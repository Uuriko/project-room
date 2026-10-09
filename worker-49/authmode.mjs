// Verify ?auth= validation with/without Bearer on the disband route.
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-am-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
const cmd = (t, type, data) => store.command(t, "commons", { id: randomUUID(), type, data });
const m1 = cmd(ownerKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "root" }).event.data.messageId;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

function call(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Origin: origin, ...headers };
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const req = httpRequest(origin + path, { method, headers: h }, res => {
      const c = [];
      res.on("data", x => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const mkSquad = async name => {
  const r = await call("POST", "/api/rooms/commons/squads",
    { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    { name, channelMessageId: m1 });
  return JSON.parse(r.text).squad.id;
};
const sq1 = await mkSquad("amone"), sq2 = await mkSquad("amtwo");
const B = { Authorization: `Bearer ${ownerKey}` };
// 1. ?auth=bogus WITHOUT bearer -> the 422 check should fire
let r = await call("POST", `/api/rooms/commons/squads/${sq1}/disband?auth=bogus`);
console.log("no-bearer ?auth=bogus ->", r.status, r.text.slice(0, 200));
// 2. ?auth=bogus WITH bearer -> ?
r = await call("POST", `/api/rooms/commons/squads/${sq2}/disband?auth=bogus`, B);
console.log("bearer ?auth=bogus ->", r.status, r.text.slice(0, 200));
// 3. ?auth=account WITH bearer (room token) -> ?
const sq3 = await mkSquad("amthree");
r = await call("POST", `/api/rooms/commons/squads/${sq3}/disband?auth=account`, B);
console.log("bearer ?auth=account ->", r.status, r.text.slice(0, 200));
server.closeStreams(); server.closeAllConnections();
await new Promise(x => server.close(x));
store.close(); rmSync(directory, { recursive: true, force: true });
