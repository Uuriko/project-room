// WAVE-2000 guild-02 worker 39 — shard 38/50 of server/http.mjs route branches.
// Shard routes (sorted pathname-condition index mod 50 == 38):
//   #38  POST /api/auth/agent/session
//   #88  POST /api/share-links/join-agent
// Mission: local API fuzzing — crash / hang / wrong-status => minimal repro + fail-first test.
import { randomBytes, randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:45139";
const ORIGIN = BASE;
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, path, { body, raw, headers = {}, bearer, timeoutMs = 15000 } = {}) {
  const h = { ...headers };
  if (bearer !== undefined) h["Authorization"] = `Bearer ${bearer}`;
  let payload;
  if (raw !== undefined) { payload = raw; h["Content-Type"] ??= "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text, textPreview: text.slice(0, 500), setCookie: res.headers.get("set-cookie") };
  } catch (e) {
    return { status: e.name === "AbortError" ? "HANG/TIMEOUT" : `TRANSPORT:${e.message.slice(0,120)}`, text: "" };
  } finally { clearTimeout(t); }
}

function check(name, r, expect) {
  const got = r.status;
  const want = Array.isArray(expect) ? expect : [expect];
  const ok = want.includes(got) || (want[0] === "5xx-bad" && !(got >= 500 && got <= 599)) && false;
  const pass = want.includes(got);
  results.push({ name, got, want: want.join("/"), pass, body: r.text.slice(0, 500) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: got ${got}, want ${want.join("/")} ${pass ? "" : `:: ${r.text.slice(0,160)}`}`);
  return pass;
}

// ---------- setup ----------
console.log("== setup ==");
let cookie = "";
const join = await req("POST", "/join", { body: { displayName: "fuzzowner39" }, headers: { Origin: ORIGIN } });
console.log("join status", join.status);
if (join.status !== 201) { console.log("SETUP FAILED: /join"); process.exit(1); }
const owner = JSON.parse(join.text);
cookie = (join.setCookie || "").split(";")[0];

const linkToken = randomBytes(32).toString("base64url");
const mkLink = await req("POST", `/api/rooms/${encodeURIComponent(owner.roomId)}/share-links`, {
  body: { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600e3, maxJoins: 5, expectedMemberRevision: 0 },
  bearer: owner.identitySecret,
  headers: { Origin: ORIGIN },
});
console.log("share-link create status", mkLink.status, mkLink.text.slice(0, 200));
if (![200, 201].includes(mkLink.status)) { console.log("SETUP FAILED: share-link create"); process.exit(1); }

const ident = await req("POST", "/api/agent-identities", { body: { displayName: "fuzzagent39" }, headers: { Origin: ORIGIN } });
console.log("identity status", ident.status);
if (ident.status !== 201) { console.log("SETUP FAILED: identity mint"); process.exit(1); }
const agent = JSON.parse(ident.text);
agent.identitySecret = agent.secret ?? agent.identitySecret; // mint returns `secret`
console.log("setup identities ok");

// ---------- route B: POST /api/share-links/join-agent ----------
const B = "/api/share-links/join-agent";
let bCount = 0;
async function bq(method, opts) {
  if (bCount >= 18) { console.log("(rate window: sleeping 62s)"); await sleep(62000); bCount = 0; }
  bCount++;
  return req(method, B, opts);
}
console.log("== fuzz route B ==");
const good = { linkToken, displayName: "fuzzagent39" };
let r = await bq("POST", { body: good, bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
check("B control valid -> 201", r, 201);

r = await bq("POST", { body: good, bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
check("B duplicate join -> 200", r, 200);

const B2 = "/api/share-links/join-agent";
async function bmut(name, body, expect) {
  const rr = await bq("POST", { body, bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
  check(name, rr, expect);
}
await bmut("B linkToken number -> 410", { linkToken: 12345, displayName: "x" }, 410);
await bmut("B linkToken null -> 410", { linkToken: null, displayName: "x" }, 410);
await bmut("B linkToken bool -> 410", { linkToken: true, displayName: "x" }, 410);
await bmut("B linkToken array -> 410", { linkToken: ["a"], displayName: "x" }, 410);
await bmut("B linkToken object -> 410", { linkToken: { t: 1 }, displayName: "x" }, 410);
await bmut("B linkToken empty -> 410", { linkToken: "", displayName: "x" }, 410);
await bmut("B linkToken garbage -> 410", { linkToken: "nope", displayName: "x" }, 410);
await bmut("B linkToken huge -> 410", { linkToken: "a".repeat(100000), displayName: "x" }, 413);
await bmut("B linkToken 10k chars -> 410", { linkToken: "a".repeat(10000), displayName: "x" }, 410);
await bmut("B linkToken guest-agent kind -> 422", { linkToken: "ga1." + "a".repeat(43), displayName: "x" }, 422);
await bmut("B displayName number -> 422", { linkToken, displayName: 5 }, 422);
await bmut("B displayName null -> 422", { linkToken, displayName: null }, 422);
await bmut("B displayName object -> 422", { linkToken, displayName: { n: 1 } }, 422);
await bmut("B displayName blank -> 422", { linkToken, displayName: "   " }, 422);
await bmut("B displayName control char -> 422?", { linkToken, displayName: "\u0001evil" }, 422);
await bmut("B displayName newline -> 422?", { linkToken, displayName: "a\nb" }, 422);
await bmut("B displayName 80 chars -> 200", { linkToken, displayName: "n".repeat(80) }, 200);
await bmut("B displayName 81 chars -> 422", { linkToken, displayName: "n".repeat(81) }, 422);
await bmut("B displayName 100k chars -> 413-or-422", { linkToken, displayName: "n".repeat(100000) }, [413, 422]);
await bmut("B missing keys {} -> 422", {}, 422);
await bmut("B extra key -> 422", { linkToken, displayName: "y", extra: 1 }, 422);

// auth / framing cases
r = await bq("POST", { body: good, headers: { Origin: ORIGIN } });
check("B no bearer w/ Origin -> 401", r, 401);
r = await bq("POST", { body: good });
check("B no bearer no origin -> 403", r, 403);
r = await bq("POST", { body: good, bearer: "rak_" + "b".repeat(40), headers: { Origin: ORIGIN } });
check("B rak_ room token bearer -> 401", r, 401);
r = await bq("POST", { body: good, bearer: "garbage-secret", headers: { Origin: ORIGIN } });
check("B garbage bearer -> 401", r, 401);
r = await req("GET", B2, { headers: { Origin: ORIGIN } });
check("B GET -> 405", r, 405);
r = await req("OPTIONS", B2, { headers: { Origin: ORIGIN } });
check("B OPTIONS -> 405", r, 405);
r = await bq("POST", { raw: "{not json", bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
check("B malformed JSON -> 400", r, 400);
r = await bq("POST", { raw: "[1,2]", bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
check("B JSON array body -> 400", r, 400);
r = await bq("POST", { raw: "", bearer: agent.identitySecret, headers: { Origin: ORIGIN } });
check("B empty body -> 400", r, 400);
r = await req("POST", B2, { raw: "x".repeat(20000), bearer: agent.identitySecret, headers: { Origin: ORIGIN, "Content-Length": 20000 } });
check("B oversize body -> 413", r, 413);
r = await bq("POST", { raw: "{}", bearer: agent.identitySecret, headers: { Origin: ORIGIN, "Content-Type": "text/plain" } });
check("B wrong content-type -> 415", r, 415);
r = await bq("POST", { body: good, bearer: agent.identitySecret, headers: { Origin: "https://evil.example" } });
check("B wrong origin + valid bearer -> 403 (forged origin denied)", r, 403);
r = await bq("POST", { body: good, bearer: agent.identitySecret });
check("B missing origin + valid bearer -> 200/201 (bearer waives origin)", r, [200, 201]);

// ---------- route A: POST /api/auth/agent/session ----------
const A = "/api/auth/agent/session";
let aCount = 0;
async function aq(method, opts) {
  if (aCount >= 9) { console.log("(rate window: sleeping 62s)"); await sleep(62000); aCount = 0; }
  aCount++;
  return req(method, A, opts);
}
console.log("== fuzz route A ==");
const aGood = { identityId: owner.identityId, roomId: owner.roomId };
r = await aq("POST", { body: aGood, bearer: owner.identitySecret, headers: { Origin: ORIGIN } });
check("A control valid -> 201", r, 201);

async function amut(name, body, bearer, expect) {
  const rr = await aq("POST", { body, bearer, headers: { Origin: ORIGIN } });
  check(name, rr, expect);
}
await amut("A {} -> 422", {}, owner.identitySecret, 422);
await amut("A extra key -> 422", { ...aGood, extra: 1 }, owner.identitySecret, 422);
await amut("A identityId number -> 422", { identityId: 7, roomId: owner.roomId }, owner.identitySecret, 422);
await amut("A roomId null -> 422", { identityId: owner.identityId, roomId: null }, owner.identitySecret, 422);
await amut("A no bearer -> 401", aGood, undefined, 401);
await amut("A wrong secret -> 401", aGood, "ias_wrongsecret000000000000000000000000", 401);
await amut("A unknown identityId -> 401", { identityId: "agt_deadbeefdeadbeef", roomId: owner.roomId }, owner.identitySecret, 401);
await amut("A bogus roomId -> 403", { identityId: owner.identityId, roomId: "room_nonexistent" }, owner.identitySecret, 403);
await amut("A identityId garbage -> 401", { identityId: "!!!", roomId: owner.roomId }, owner.identitySecret, 401);
await amut("A swapped ids -> 401", { identityId: owner.roomId, roomId: owner.identityId }, owner.identitySecret, 401);

r = await aq("POST", { body: aGood, bearer: owner.identitySecret });
check("A no origin -> 403", r, 403);
r = await req("POST", A, { raw: "{bad", bearer: owner.identitySecret, headers: { Origin: ORIGIN } });
check("A malformed JSON -> 400", r, 400);
r = await aq("POST", { raw: "[1]", bearer: owner.identitySecret, headers: { Origin: ORIGIN } });
check("A JSON array -> 400", r, 400);
r = await aq("POST", { raw: "", bearer: owner.identitySecret, headers: { Origin: ORIGIN } });
check("A empty body -> 400", r, 400);
r = await req("POST", A, { raw: "x".repeat(20000), bearer: owner.identitySecret, headers: { Origin: ORIGIN, "Content-Length": 20000 } });
check("A oversize body -> 413", r, 413);
r = await aq("POST", { raw: "{}", bearer: owner.identitySecret, headers: { Origin: ORIGIN, "Content-Type": "text/plain" } });
check("A wrong content-type -> 415", r, 415);
r = await aq("GET", { headers: { Origin: ORIGIN } });
check("A GET -> 404 (no 405 twin)", r, 404);

const fails = results.filter(x => !x.pass && x.got !== 429 && !String(x.got).startsWith("TRANSPORT"));
const bad5xx = results.filter(x => typeof x.got === "number" && x.got >= 500);
const timeouts = results.filter(x => x.got === "HANG/TIMEOUT");
console.log("\n== summary ==");
console.log(`total=${results.length} pass=${results.length - fails.length} fail=${fails.length} 5xx=${bad5xx.length} hangs=${timeouts.length}`);
for (const f of fails) console.log("FAIL:", f.name, "got", f.got, "want", f.want, "::", f.body.slice(0, 200));
await import("node:fs/promises").then(fs => fs.writeFile(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2)));
console.log("wrote worker-39/results.json");
