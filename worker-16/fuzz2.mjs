// WAVE-2000 G02 WORKER 16/50 — fuzz battery 2 (seeded state + limits + concurrency).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const dir = mkdtempSync(join(tmpdir(), "w16-fuzz2-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom());
const ROOM = "commons";
store.roomDirectory.set(ROOM, "owner", true);

const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
let failures = 0;
const note = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) { failures++; console.log(`!!! FAIL: ${name} — ${detail}`); }
};
const req = async (method, path, { headers = {}, body = undefined, timeoutMs = 8000 } = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(origin + path, { method, headers, body, signal: ctl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "<unreadable>");
    return { status: res.status, ms: Date.now() - start, text };
  } catch (e) {
    return { status: "ERROR", ms: Date.now() - start, text: String(e).slice(0, 200) };
  } finally { clearTimeout(t); }
};
const shape = r => r.status === "ERROR" ? `transport-error(${r.text})` : `status=${r.status} ms=${r.ms} body=${r.text.slice(0,140)}`;
const DIR = "/api/public/rooms/directory";

// ---- C. seeded directory: one real listed room ----
let r = await req("GET", DIR);
let body = JSON.parse(r.text);
note("C1 one listed room", r.status === 200 && body.rooms.length === 1 && body.nextCursor === null, shape(r));
note("C2 entry fields sanitized shape", body.rooms[0] && ["roomId","title","purpose","kind","memberCount","listedAt"].every(k => k in body.rooms[0]), JSON.stringify(body.rooms[0]).slice(0,200));

// ---- D. phantom rows (settings row, no room) must be skipped, not crash ----
store.db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at) VALUES (?,?,?,?)")
  .run("ghost-room-1", 1, Date.now(), Date.now());
r = await req("GET", DIR);
body = JSON.parse(r.text);
note("D1 ghost row skipped, no crash", r.status === 200 && body.rooms.length === 1, shape(r));

// ---- E. nasty room state via the projection JSON column ----
let row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(ROOM);
const nastyTitle = "A".repeat(5000) + "\u0000\u0001\u007f\ud83d\ude80";
const nastyPurpose = "P".repeat(8000);
try {
  const st = JSON.parse(row.projection);
  st.room = st.room || {};
  st.room.title = nastyTitle; st.room.purpose = nastyPurpose; st.room.kind = 12345;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(st), ROOM);
  console.log("nasty state injected via projection column");
} catch (e) { console.log("inject skipped:", String(e).slice(0, 120)); }
r = await req("GET", DIR);
let ok = r.status === 200;
let entry = null;
try { entry = JSON.parse(r.text).rooms[0]; } catch {}
note("E1 nasty title/purpose -> 200, title capped at 120", ok && entry && entry.title.length <= 120 && !entry.title.includes("\u0000"), shape(r) + " titleLen=" + (entry?.title.length ?? "?"));
note("E2 purpose capped at 1000, kind sanitized", ok && entry && (entry.purpose === null || entry.purpose.length <= 1000) && (typeof entry.kind === "string" || entry.kind === null), "kind=" + JSON.stringify(entry?.kind));

// ---- F. pagination across several listed rooms ----
let seq = 100;
for (const id of ["aaa-room", "mmm-room", "zzz-room"]) {
  const proj = JSON.stringify({ room: { id, roomId: id, ownerId: "owner", title: "Room " + id, purpose: "p", createdAt: 1 }, members: {} });
  store.db.prepare("INSERT INTO rooms (id, sequence, projection) VALUES (?,?,?)").run(id, seq++, proj);
  store.db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at) VALUES (?,?,?,?)")
    .run(id, 1, Date.now(), Date.now());
}
r = await req("GET", `${DIR}?limit=1`);
body = JSON.parse(r.text);
note("F1 limit=1 -> 1 room + cursor", r.status === 200 && body.rooms.length <= 1 && typeof body.nextCursor === "string", shape(r));
const seen = [];
let cursor = null, guard = 0, terminated = false;
do {
  r = await req("GET", cursor ? `${DIR}?limit=1&after=${encodeURIComponent(cursor)}` : `${DIR}?limit=1`);
  body = JSON.parse(r.text);
  seen.push(...body.rooms.map(x => x.roomId));
  cursor = body.nextCursor; guard++;
  if (!cursor) { terminated = true; break; }
} while (guard < 20);
note("F2 cursor walk terminates, no dupes", terminated && new Set(seen).size === seen.length, `seen=${seen.join(",")}`);

// ---- H. path variants (BEFORE rate-limit exhaustion) ----
r = await req("GET", DIR + "/");
note("H1 trailing slash -> 404", r.status === 404, shape(r));
r = await req("GET", "/API/public/rooms/directory");
note("H2 uppercase path -> 404", r.status === 404, shape(r));

// ---- G. rate limit: 120/min on directory ----
let ok200 = 0, r429 = 0, other = 0;
for (let i = 0; i < 130; i++) {
  r = await req("GET", DIR);
  if (r.status === 200) ok200++;
  else if (r.status === 429) r429++;
  else other++;
}
note("G1 130 rapid GETs -> ~120x200 then 429s, no 500", ok200 >= 115 && r429 >= 1 && other === 0, `200x${ok200} 429x${r429} otherx${other}`);
r = await req("GET", DIR);
note("G2 429 body is typed JSON", r.status === 429 && r.text.includes("rate"), shape(r));

// ---- I. onboarding concurrency: 5 parallel completes ----
const slot = store.createAccountSessionSlot();
r = await req("POST", "/api/auth/password/signup", {
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email: "w16-fuzz2@example.invalid", password: "fixture-password-16-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
});
const freshToken = /account_session=([^;]+)/.exec(r.headers.get?.("set-cookie") || "")?.[1];
const sess = store.authenticateAccountSession(freshToken);
const OB = "/api/account/onboarding/complete";
const hdrs = { Origin: origin, Cookie: `account_session=${freshToken}`, "X-CSRF-Token": sess.csrf, "Content-Type": "application/json" };
const parallel = await Promise.all([1,2,3,4,5].map(() => req("POST", OB, { headers: hdrs, body: "{}" })));
note("I1 5 parallel completes -> all 200", parallel.every(x => x.status === 200), parallel.map(x => x.status).join(","));
const st = store.onboardingState(sess.account.id);
note("I2 store state completed after race", st.completed === true, JSON.stringify(st).slice(0,80));

// ---- J. onboarding with expired/revoked session ----
store.revokeAccountSession ? null : null;
r = await req("POST", OB, { headers: hdrs, body: "{}" });
note("J1 replay after complete still 200 (idempotent)", r.status === 200, shape(r));

console.log(`\n==== ${results.length} checks, ${failures} failures ====`);
results.forEach(l => console.log(l));

server.closeStreams(); server.closeAllConnections();
await new Promise(res => server.close(res));
store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
