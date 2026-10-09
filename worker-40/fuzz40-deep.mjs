// WORKER 40 deep-path fuzz: POST /api/agent-invites/redeem with REAL invite rows.
// Inserts scrypt-hashed invite rows directly into the fixture DB, then exercises
// the redeem paths that need a live code: 201, 409/410, name validation, and a
// concurrent-redeem race for the same code.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { scryptSync } from "node:crypto";
import fs from "node:fs";

const outPath = new URL("./results-deep.json", import.meta.url).pathname;
const codeHash = (code) => scryptSync(code, "project-room-agent-invite-v2", 32, { N: 16384, r: 8, p: 1 }).toString("hex");
const J = (o) => JSON.stringify(o);
const CODE = (s) => "RM-" + s; // normalized-form codes (already uppercase, no I/L/O)

let server, fixture, base, store, roomId, ownerId;
async function boot() {
  fixture = await createAcceptanceFixture();
  store = fixture.store;
  server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function shutdown() {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { store.close(); } catch {}
}
async function healthOk() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(base + "/api/health", { signal: c.signal }); clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}
const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");
async function postRedeem(body, headers = {}) {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(base + "/api/agent-invites/redeem", {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : J(body), signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 500), ms: Date.now() - started, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } catch (e) {
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started, json: null };
  }
}

const findings = [];
function check(name, r, expect) {
  let verdict = null;
  if (looksLikeStack(r.head)) verdict = "stack-leak";
  else if (r.status === 500) verdict = "unexpected-500";
  else if (r.status === "TIMEOUT") verdict = "hang";
  else if (expect != null && r.status !== expect) verdict = "wrong-status";
  if (verdict) { findings.push({ case: name, status: r.status, expect, verdict, ms: r.ms, head: r.head.slice(0, 200) }); console.log(`  FINDING ${name}: got ${r.status} (expect ${expect}) [${verdict}]`); }
  else console.log(`  ok ${name}: ${r.status} (${r.ms}ms)`);
  return r;
}

await boot();
console.log(`booted ${base}`);

// --- introspect fixture: room + owner ---
roomId = store.db.prepare("SELECT id FROM rooms LIMIT 1").get()?.id;
const authority = store.roomAuthority(roomId);
ownerId = authority.ownerId ?? Object.keys(store.room(roomId).state.members)[0];
console.log(`room=${roomId} owner=${ownerId}`);
const now = store.now();
const PERMS = J(["steer", "accept_work"]);
function insertInvite(code, { expiresAt = now + 3600000, revokedAt = null, redeemedAt = null, redeemedIdentityId = null, displayName = null } = {}) {
  store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at,redeemed_at,redeemed_identity_id,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(codeHash(code), roomId, ownerId, PERMS, displayName, now, expiresAt, redeemedAt, redeemedIdentityId, revokedAt);
  return code;
}
const C_VALID = insertInvite(CODE("A".repeat(16)));
const C_EXPIRED = insertInvite(CODE("B".repeat(16)), { expiresAt: now - 1000 });
const C_REVOKED = insertInvite(CODE("C".repeat(16)), { revokedAt: now });
const C_USED = insertInvite(CODE("D".repeat(16)), { redeemedAt: now - 5000, redeemedIdentityId: "someone" });
const C_RACE = insertInvite(CODE("E".repeat(16)));
const C_NAME = insertInvite(CODE("F".repeat(16)));
const C_CASE = insertInvite(CODE("0".repeat(16))); // lowercase fold target

// --- deep battery ---
let r = await postRedeem({ code: C_VALID, displayName: "FuzzAgent1" });
check("D01 valid redeem -> 201", r, 201);
const joinedSecret = r.json?.identitySecret || r.json?.secret || r.json?.connection?.identitySecret || null;
console.log(`  joined identitySecret captured: ${joinedSecret ? "yes" : "NO"}`);

check("D02 re-redeem same code -> 409", await postRedeem({ code: C_VALID, displayName: "FuzzAgent2" }), 409);
check("D03 expired code -> 410", await postRedeem({ code: C_EXPIRED, displayName: "x" }), 410);
check("D04 revoked code -> 410", await postRedeem({ code: C_REVOKED, displayName: "x" }), 410);
check("D05 already-used code -> 409", await postRedeem({ code: C_USED, displayName: "x" }), 409);
check("D06 81-char name w/ valid code -> 422", await postRedeem({ code: C_NAME, displayName: "y".repeat(81) }), 422);
check("D07 80-char name boundary -> 201", await postRedeem({ code: C_NAME, displayName: "z".repeat(80) }), 201);
check("D08 empty displayName -> 201 default", await postRedeem({ code: insertInvite(CODE("1".repeat(16))), displayName: "" }), 201);
check("D09 whitespace displayName -> 201 default", await postRedeem({ code: insertInvite(CODE("2".repeat(16))), displayName: "   " }), 201);
check("D10 bogus bearer identity -> 401", await postRedeem({ code: insertInvite(CODE("3".repeat(16))), displayName: "x" }, { Authorization: "Bearer bogus-secret-xyz" }), 401);
check("D11 lowercase code folds -> 201", await postRedeem({ code: C_CASE.toLowerCase(), displayName: "Foldy" }), 201);
check("D12 padded code trims -> 201", await postRedeem({ code: "  " + insertInvite(CODE("4".repeat(16))) + "  ", displayName: "Paddy" }), 201);

// --- concurrency race: 5 parallel redeems, one code ---
const raceResults = await Promise.all([0, 1, 2, 3, 4].map(i =>
  postRedeem({ code: C_RACE, displayName: "Racer" + i })));
const tally = {};
for (const rr of raceResults) tally[rr.status] = (tally[rr.status] || 0) + 1;
console.log(`  D13 race tally: ${JSON.stringify(tally)}`);
if (tally[201] === 1 && (tally[409] || 0) === 4) console.log("  ok D13 race: exactly one 201, four 409s");
else { findings.push({ case: "D13 concurrent redeem race", verdict: "race-anomaly", tally, details: raceResults.map(x => x.status) }); console.log("  FINDING D13 race anomaly"); }

// --- rejoin with same identity (duplicate path) ---
if (joinedSecret) {
  const rj = await postRedeem({ code: C_VALID, displayName: "FuzzAgent1" }, { Authorization: `Bearer ${joinedSecret}` });
  check("D14 same-identity rejoin -> 201 duplicate", rj, 201);
  console.log(`  duplicate flag: ${JSON.stringify(rj.json)?.slice(0, 200)}`);
} else console.log("  SKIP D14: no identity secret captured");

if (!(await healthOk())) findings.push({ case: "*", verdict: "crash", note: "server dead after deep battery" });
await shutdown();

fs.writeFileSync(outPath, JSON.stringify({ findings, findingCount: findings.length }, null, 1));
console.log(`done: ${findings.length} findings -> ${outPath}`);
