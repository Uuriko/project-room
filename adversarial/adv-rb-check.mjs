// Pass 26: adversarial validation matrix against the return-brief endpoint (+ events endpoint
// regression probes). Real HTTP against the real service, disposable fixtures. Every case
// asserts an exact expected outcome; any 500 or unexpected acceptance is a finding.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const directory = mkdtempSync(join(tmpdir(), "adv-rb-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const owner = store.issueAccessKey("commons", "owner");
const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work"] });
const maya = store.issueAccessKey("commons", "maya");
for (let i = 1; i <= 59; i++) send(owner, T.MESSAGE_POSTED, { messageId: `m-${i}`, body: `message ${i}` });
const server = createRoomServer({ store, streamInterval: 60 });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const get = async (key, path) => {
  const res = await fetch(origin + path, { headers: { authorization: `Bearer ${key}` } });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
const N = store.room("commons").sequence;
const rb = (key, q) => get(key, `/api/rooms/commons/return-brief${q}`);

// A. first page baseline + limit validation
const first = await rb(owner, "");
check("first page 200", first.status === 200, JSON.stringify(first.body).slice(0, 120));
check("first page freezes H=N", first.body?.history?.evaluatedThrough === N);
check("first page cursor is stored 0, client cursor param ignored", first.body?.history?.cursor === 0);
check("first page bounded at 50", first.body?.history?.items?.length === 50);
for (const [q, want] of [["?limit=0", 422], ["?limit=-1", 422], ["?limit=101", 422], ["?limit=abc", 422], ["?limit=1e999", 422], ["?limit=50.5", 422]]) {
  const r = await rb(owner, q);
  check(`limit ${q} -> ${want}`, r.status === want && r.body?.error?.code === "invalid_cursor", `got ${r.status}`);
}
// B. horizon validation
for (const [q, want, code] of [["?horizon=-1&after=0&cursor=0", 422, "invalid_cursor"], ["?horizon=1.5&after=0&cursor=0", 422, "invalid_cursor"], [`?horizon=${N + 1}&after=0&cursor=0`, 409, "cursor_ahead"], ["?horizon=9007199254740992&after=0&cursor=0", 422, "invalid_cursor"]]) {
  const r = await rb(owner, q);
  check(`horizon ${q.split("&")[0]} -> ${want}/${code}`, r.status === want && r.body?.error?.code === code, `got ${r.status} ${r.body?.error?.code}`);
}
// C. continuation tuple validation
for (const [q, want, code] of [[`?horizon=${N}&after=${N + 5}&cursor=0`, 422, "invalid_cursor"], [`?horizon=${N}&after=-5&cursor=0`, 422, "invalid_cursor"], [`?horizon=${N}&after=3&cursor=4`, 422, "invalid_cursor"], [`?horizon=${N}&after=3&cursor=3`, 409, "cursor_changed"]]) {
  const r = await rb(owner, q);
  check(`tuple ${q} -> ${want}/${code}`, r.status === want && r.body?.error?.code === code, `got ${r.status} ${r.body?.error?.code}`);
}
// D. full pagination walk with limit=7: exact contiguous union, mid-walk arrival excluded
let cont = null, seen = [], frozH = null, pages = 0;
do {
  const q = cont ? `?horizon=${cont.horizon}&after=${cont.after}&cursor=${cont.cursor}&limit=7` : "?limit=7";
  const r = await rb(owner, q);
  if (r.status !== 200) { check(`walk page ${pages} 200`, false, `got ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); break; }
  pages++;
  if (frozH === null) frozH = r.body.history.evaluatedThrough;
  if (pages === 1) send(owner, T.MESSAGE_POSTED, { messageId: "late", body: "arrived mid-walk" }); // N+1 event
  seen.push(...r.body.history.items.map(i => i.sequence));
  cont = r.body.history.continuation;
  if (pages > 30) { check("walk terminates", false, "ran past 30 pages"); break; }
} while (cont);
check("walk saw every pre-walk sequence exactly once", seen.length === N && seen.every((s, i) => s === i + 1), `len=${seen.length} N=${N}`);
check("mid-walk arrival excluded from frozen history", !seen.includes(N + 1));
// E. cursor acknowledge: exactly H; H+1 stays new
const ack = await get(owner, ""); // snapshot warm
const ackRes = await fetch(origin + "/api/rooms/commons/cursor", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ sequence: frozH }) });
check("cursor POST 200", ackRes.status === 200);
const after1 = await rb(owner, "");
check("after ack, history opens at H (H+1 is the only new item)", after1.body?.history?.items?.length === 1 && after1.body.history.items[0].sequence === frozH + 1);
// F. cursor_changed race: page 1, ack in another "tab", old continuation rejects 409
for (let i = 1; i <= 5; i++) send(owner, T.MESSAGE_POSTED, { messageId: `race-${i}`, body: `race ${i}` });
const p1 = await rb(owner, "?limit=2");
const c1 = p1.body.history.continuation;
await fetch(origin + "/api/rooms/commons/cursor", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ sequence: p1.body.history.evaluatedThrough }) });
const staleCont = await rb(owner, `?horizon=${c1.horizon}&after=${c1.after}&cursor=${c1.cursor}`);
check("post-ack continuation -> 409 cursor_changed", staleCont.status === 409 && staleCont.body?.error?.code === "cursor_changed", `got ${staleCont.status}`);
// G. member isolation: maya's cursor independent of owner's moved cursor
const mayaFirst = await rb(maya, "");
check("maya first page opens at her own cursor 0", mayaFirst.status === 200 && mayaFirst.body?.history?.cursor === 0 && mayaFirst.body?.history?.items?.length > 1);
// H. events endpoint regression probes
for (const [q, want] of [["?limit=-1", 422], ["?limit=101", 422], ["?limit=0", 422], ["?after=-1", 422], [`?after=${store.room("commons").sequence + 1}`, 409], ["?limit=abc", 422]]) {
  const r = await get(owner, `/api/rooms/commons/events${q}`);
  check(`events ${q} -> ${want}`, r.status === want, `got ${r.status}`);
}
// I. no 500s anywhere above is implicit; spot-check error shape
check("error bodies carry error.code", (await rb(owner, "?limit=0")).body?.error?.code === "invalid_cursor");

server.closeStreams(); server.closeAllConnections(); server.close();
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
