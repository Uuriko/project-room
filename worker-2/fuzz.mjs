// WAVE-2000 guild-02 worker-2 fuzz harness — shard 2/50.
// Boots a local server (createRoomServer) with a throwaway sqlite store and
// fuzzes the 3 shard handlers:
//   1. writeSecurityTxt dispatch (http.mjs:953): /.well-known/security.txt etc.
//   2. /api/auth/github/link/start (http.mjs:2317)
//   3. /api/updates (http.mjs:3170)
// Never touches production. Every request has a 6s timeout (hang detection);
// connection failures after boot are reported as CRASH.
// Rate budgets: /api/updates 60/min/addr, github-link-start 10/min/addr,
// security.txt unrated. Case counts are kept under budget.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const TIMEOUT_MS = 6000;

const dir = mkdtempSync(join(tmpdir(), "w2fuzz-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const identity = store.identities.create("Fuzz Agent");
const FORGED_SECRET = "pri_" + "A".repeat(64); // format-valid, not issued

const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function probe(name, method, path, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status, bodyLen, bodyHead, err = null;
  try {
    const res = await fetch(`${origin}${path}`, { method, headers, signal: ctl.signal });
    status = res.status;
    const text = await res.text();
    bodyLen = text.length;
    bodyHead = text.slice(0, 120);
  } catch (e) {
    err = e?.name === "AbortError" ? "TIMEOUT" : `FETCH-ERROR: ${e?.message}`;
  } finally { clearTimeout(timer); }
  return { name, method, path: path.length > 160 ? path.slice(0, 160) + `…(${path.length})` : path, status, bodyLen, bodyHead, err };
}

const results = [];
const sec = async (name, method, path, headers) => results.push(await probe(`sec:${name}`, method, path, headers));
const gh = async (name, method, path, headers) => results.push(await probe(`gh:${name}`, method, path, headers));
const upd = async (name, method, path, headers) => results.push(await probe(`upd:${name}`, method, path, headers));

const AUTH = { Authorization: `Bearer ${identity.secret}` };
const FORGED_AUTH = { Authorization: `Bearer ${FORGED_SECRET}` };
const BIG = "x".repeat(7000);

// ---- 1. security.txt ----
await sec("get-wk", "GET", "/.well-known/security.txt");
await sec("get-apex", "GET", "/security.txt");
await sec("get-room-prefix", "GET", "/room/.well-known/security.txt");
await sec("head", "HEAD", "/.well-known/security.txt");
await sec("post", "POST", "/.well-known/security.txt");
await sec("put", "PUT", "/.well-known/security.txt");
await sec("delete", "DELETE", "/.well-known/security.txt");
await sec("options", "OPTIONS", "/.well-known/security.txt");
await sec("trace", "TRACE", "/.well-known/security.txt");
await sec("trailing-slash", "GET", "/.well-known/security.txt/");
await sec("double-slash", "GET", "//.well-known//security.txt");
await sec("query", "GET", "/.well-known/security.txt?" + "a=1&".repeat(50) + "b=2");
await sec("encoded-dot", "GET", "/%2Ewell-known/security.txt");
await sec("case", "GET", "/.WELL-KNOWN/SECURITY.TXT");
await sec("huge-path", "GET", "/.well-known/" + BIG);
await sec("room-only", "GET", "/room/security.txt");
await sec("wellknown-only", "GET", "/.well-known/");
await sec("nullbyte", "GET", "/.well-known/security.txt%00.json");

// ---- 2. /api/auth/github/link/start (budget: 9 of 10) ----
await gh("get-anon", "GET", "/api/auth/github/link/start");
await gh("post-anon", "POST", "/api/auth/github/link/start");
await gh("put-anon", "PUT", "/api/auth/github/link/start");
await gh("head-anon", "HEAD", "/api/auth/github/link/start");
await gh("get-bad-cookie", "GET", "/api/auth/github/link/start", { Cookie: "x=1; y=2" });
await gh("get-giant-cookie", "GET", "/api/auth/github/link/start", { Cookie: "a=" + BIG });
await gh("get-query-noise", "GET", "/api/auth/github/link/start?sessionToken=" + "A".repeat(200) + "&next=//evil");
await gh("get-trailing-slash", "GET", "/api/auth/github/link/start/");
await gh("options", "OPTIONS", "/api/auth/github/link/start");

// ---- 3. /api/updates (budget: ~45 of 60) ----
await upd("get-anon", "GET", "/api/updates");
await upd("get-forged-secret", "GET", "/api/updates", FORGED_AUTH);
await upd("get-bad-authz", "GET", "/api/updates", { Authorization: "Bearer short" });
await upd("get-empty-bearer", "GET", "/api/updates", { Authorization: "Bearer " });
await upd("get-valid", "GET", "/api/updates", AUTH);
await upd("head-valid", "HEAD", "/api/updates", AUTH);
await upd("post", "POST", "/api/updates", AUTH);
await upd("put", "PUT", "/api/updates", AUTH);
await upd("options", "OPTIONS", "/api/updates", AUTH);
await upd("limit-alpha", "GET", "/api/updates?limit=abc", AUTH);
await upd("limit-empty", "GET", "/api/updates?limit=", AUTH);
await upd("limit-zero", "GET", "/api/updates?limit=0", AUTH);
await upd("limit-neg", "GET", "/api/updates?limit=-5", AUTH);
await upd("limit-float", "GET", "/api/updates?limit=1.5", AUTH);
await upd("limit-101", "GET", "/api/updates?limit=101", AUTH);
await upd("limit-huge", "GET", "/api/updates?limit=99999999999999999999", AUTH);
await upd("limit-hex", "GET", "/api/updates?limit=0x10", AUTH);
await upd("limit-inf", "GET", "/api/updates?limit=Infinity", AUTH);
await upd("limit-dup", "GET", "/api/updates?limit=1&limit=2", AUTH);
await upd("limit-plus", "GET", "/api/updates?limit=+5", AUTH);
await upd("limit-space", "GET", "/api/updates?limit=%205", AUTH);
await upd("state-bad", "GET", "/api/updates?state=archived", AUTH);
await upd("state-empty", "GET", "/api/updates?state=", AUTH);
await upd("state-case", "GET", "/api/updates?state=Actionable", AUTH);
await upd("kinds-bad", "GET", "/api/updates?kinds=nope", AUTH);
await upd("kinds-commas", "GET", "/api/updates?kinds=,,,", AUTH);
await upd("kinds-mixed", "GET", "/api/updates?kinds=request,nope", AUTH);
await upd("kinds-long", "GET", "/api/updates?kinds=" + "request,".repeat(300), AUTH);
await upd("kinds-dup", "GET", "/api/updates?kinds=request&kinds=mention", AUTH);
await upd("cursor-garbage", "GET", "/api/updates?cursor=!!!not-base64!!!", AUTH);
await upd("cursor-json-nonobj", "GET", "/api/updates?cursor=" + Buffer.from("[1,2]").toString("base64url"), AUTH);
await upd("cursor-v2", "GET", "/api/updates?cursor=" + Buffer.from(JSON.stringify({ v: 2, viewer: "identity:x", createdAt: "t", id: "i" })).toString("base64url"), AUTH);
await upd("cursor-other-viewer", "GET", "/api/updates?cursor=" + Buffer.from(JSON.stringify({ v: 1, viewer: "identity:other", updatedAt: "t", id: "i" })).toString("base64url"), AUTH);
await upd("cursor-huge", "GET", "/api/updates?cursor=" + Buffer.from("x".repeat(6000)).toString("base64url"), AUTH);
await upd("unknown-param", "GET", "/api/updates?frobnicate=1", AUTH);
await upd("auth-param", "GET", "/api/updates?auth=bogus", AUTH);
await upd("binding-param", "GET", "/api/updates?binding=" + BIG, AUTH);
await upd("giant-query", "GET", "/api/updates?" + "z=1&".repeat(1500), AUTH);
await upd("combo-all", "GET", "/api/updates?state=all&kinds=request%2Cmention&limit=1&cursor=", AUTH);
await upd("head-anon", "HEAD", "/api/updates");
await upd("trailing-slash", "GET", "/api/updates/", AUTH);
await upd("x-auth-header", "GET", "/api/updates", { "X-Project-Room-Auth": "bogus", ...AUTH });

// ---- report ----
let anomalies = 0;
for (const r of results) {
  const flag = r.err ? "!!" : "";
  if (r.err) anomalies++;
  console.log(`${flag}${r.status ?? r.err}\t${r.method}\t${r.name}\tlen=${r.bodyLen ?? "-"}${r.bodyHead ? "\t" + JSON.stringify(r.bodyHead) : ""}`);
}
console.log(`\n${results.length} probes, ${anomalies} transport anomalies`);

server.closeStreams();
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close();
rmSync(dir, { recursive: true, force: true });
