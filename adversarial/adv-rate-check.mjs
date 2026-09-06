// Pass 29: rate-limit + stream-cap boundaries. Real HTTP server, loopback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
const directory = mkdtempSync(join(tmpdir(), "adv-rate-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const cmd = (type, data) => ({ id: crypto.randomUUID(), type, data });
// one member per rate case so windows stay clean
for (const id of ["w1", "r1", "s1"]) {
  store.command(store.issueAccessKey("commons", "owner"), "commons", cmd(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "human", permissions: ["steer"] }));
}
const keys = Object.fromEntries(["w1", "r1", "s1"].map(id => [id, store.issueAccessKey("commons", id)]));
const server = createRoomServer({ store, streamInterval: 15 });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const bearer = key => ({ Authorization: `Bearer ${key}` });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// R1: login rate - 10 attempts per IP per minute, 11th is 429 with Retry-After, failures count too.
{
  let last;
  for (let i = 1; i <= 10; i++) {
    last = await fetch(`${origin}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ accessKey: "not-a-real-key" }) });
  }
  check("10 bad logins reach auth (401, not 429)", last.status === 401, `status=${last.status}`);
  const eleventh = await fetch(`${origin}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ accessKey: "not-a-real-key" }) });
  const body = await eleventh.json();
  check("11th login in window rejected 429 rate_limited", eleventh.status === 429 && body.error?.code === "rate_limited", `status=${eleventh.status} code=${body.error?.code}`);
  check("429 carries Retry-After: 60", eleventh.headers.get("retry-after") === "60", `retry-after=${eleventh.headers.get("retry-after")}`);
}
// R2: write rate - 60 writes per credential per minute, 61st is 429.
{
  let last;
  for (let i = 1; i <= 60; i++) {
    last = await fetch(`${origin}/api/rooms/commons/cursor`, { method: "POST", headers: { ...bearer(keys.w1), "Content-Type": "application/json" }, body: JSON.stringify({ sequence: 0 }) });
  }
  check("60 writes accepted", last.status === 200, `status=${last.status}`);
  const over = await fetch(`${origin}/api/rooms/commons/cursor`, { method: "POST", headers: { ...bearer(keys.w1), "Content-Type": "application/json" }, body: JSON.stringify({ sequence: 0 }) });
  check("61st write in window rejected 429 rate_limited", over.status === 429 && (await over.json()).error?.code === "rate_limited", `status=${over.status}`);
}
// R3: read rate - 600 reads per credential per minute, 601st is 429.
{
  let last;
  for (let i = 1; i <= 600; i++) last = await fetch(`${origin}/api/rooms/commons`, { headers: bearer(keys.r1) });
  check("600 reads accepted", last.status === 200, `status=${last.status}`);
  const over = await fetch(`${origin}/api/rooms/commons`, { headers: bearer(keys.r1) });
  check("601st read in window rejected 429 rate_limited", over.status === 429, `status=${over.status}`);
}
// R4: per-credential stream cap - 3 live streams, 4th is 429 stream_limit; closing frees the slot.
{
  const streams = [];
  for (let i = 0; i < 3; i++) streams.push(await fetch(`${origin}/api/rooms/commons/stream?after=0`, { headers: bearer(keys.s1) }));
  check("3 streams open for one credential", streams.every(r => r.status === 200), streams.map(r => r.status).join(","));
  const fourth = await fetch(`${origin}/api/rooms/commons/stream?after=0`, { headers: bearer(keys.s1) });
  check("4th stream on same credential rejected 429 stream_limit", fourth.status === 429 && (await fourth.json()).error?.code === "stream_limit", `status=${fourth.status}`);
  await streams[0].body.cancel();
  await sleep(100);
  const retry = await fetch(`${origin}/api/rooms/commons/stream?after=0`, { headers: bearer(keys.s1) });
  check("closing a stream frees the slot", retry.status === 200, `status=${retry.status}`);
  await retry.body.cancel(); for (const s of streams.slice(1)) await s.body.cancel();
}
// R5: global stream cap - 100 streams service-wide, 101st is 429 regardless of credential.
{
  // 34 distinct sessions x 3 streams = 102 attempts; sessions made at store level (HTTP login is rate-limited by design)
  const sessions = Array.from({ length: 34 }, () => store.createSession(keys.s1).token);
  const open = [];
  const failures = [];
  for (const token of sessions) {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${origin}/api/rooms/commons/stream?after=0`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 200) open.push(res); else failures.push({ status: res.status, body: await res.json() });
    }
  }
  check("100 streams open service-wide", open.length === 100, `open=${open.length}`);
  check("101st+ stream rejected 429 stream_limit", failures.length === 2 && failures.every(f => f.status === 429 && f.body.error?.code === "stream_limit"), JSON.stringify(failures.map(f => f.status)));
  for (const s of open) await s.body.cancel();
}
// R6: the 60s window actually resets (real wait, last case).
{
  console.log("     (waiting 61s for the login window to reset)");
  await sleep(61000);
  const res = await fetch(`${origin}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ accessKey: "not-a-real-key" }) });
  check("after window reset, login reaches auth again (401 not 429)", res.status === 401, `status=${res.status}`);
}
server.closeStreams(); server.closeAllConnections(); server.close();
store.close(); rmSync(directory, { recursive: true, force: true });
console.log(`\n${pass} pass / ${failCount} fail`);
// NOT TESTED (documented): the 2000-distinct-rate-key global cap needs 2000 distinct credentials; closure-internal, out of practical reach.
process.exit(failCount ? 1 : 0);
